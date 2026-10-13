// Configuración multi-ambiente del servicio generado.
//
// La MISMA que keel-spring y keel-nest, que es lo que hace que los servidores del mismo diseño se
// desplieguen igual: el perfil activo sale de `PROFILE` (default `local`, admite varios separados por
// coma), el puerto de `SERVER_PORT` (8080), la dirección de `SERVER_ADDRESS` (0.0.0.0), el margen del
// apagado ordenado de `SHUTDOWN_TIMEOUT` (30s), y cada valor sigue el gradiente de keel-core
// (gen/profile-values.js): literal (local) → `${VAR:default}` (develop) → `${VAR}` sin default
// (production). Un `${VAR}` sin valor no deja arrancar.
//
// Forma en disco, la misma que keel-nest: `config/application.yaml` (lo común) +
// `config/parameters/<perfil>/*.yaml` (los fragmentos de cada perfil, que llegan con las capas que los
// necesitan). .NET no entiende `${VAR:default}` por su cuenta, así que el cargador es del proyecto
// (`ServiceConfiguration`) y entrega el resultado a la configuración de ASP.NET Core ya resuelto.

import { solution, csFile } from './render.js';

export function configNamespace(model) {
  return `${solution(model).infrastructure.name}.Config`;
}

export function generate(model) {
  const sln = solution(model);
  return [
    { path: 'config/application.yaml', content: baseYaml(model) },
    { path: `${sln.infrastructure.dir}/Config/ServiceConfiguration.cs`, content: serviceConfigurationCs(model) }
  ];
}

function baseYaml(model) {
  return `# Configuración común a todos los perfiles. Los valores de cada perfil van en
# config/parameters/<perfil>/*.yaml. Placeholders: \${VAR} obligatoria, \${VAR:default} opcional.
application:
  name: ${model.service.name}
server:
  # Puerto por variable de entorno; 8080 es el que asumen los escenarios de validación.
  port: \${SERVER_PORT:8080}
  # Todas las interfaces, como los servidores de keel-spring y keel-nest (también SERVER_ADDRESS):
  # dentro de un contenedor, escuchar solo en localhost dejaría el servicio inalcanzable.
  address: \${SERVER_ADDRESS:0.0.0.0}
  # Apagado ordenado: al recibir SIGTERM /readyz pasa a OUT_OF_SERVICE, el servidor deja de aceptar
  # conexiones y espera como máximo este margen a que terminen las peticiones en vuelo.
  shutdown-timeout: \${SHUTDOWN_TIMEOUT:30s}
`;
}

function serviceConfigurationCs(model) {
  return csFile({
    namespace: configNamespace(model),
    usings: ['System.Globalization', 'System.Text', 'System.Text.RegularExpressions', 'YamlDotNet.Core', 'YamlDotNet.RepresentationModel'],
    body: String.raw`
/// <summary>
/// La configuración del perfil activo, cargada y validada ANTES de crear la aplicación.
/// </summary>
/// <remarks>
/// La misma convención que los servidores de keel-spring y keel-nest del mismo diseño: perfil por
/// <c>PROFILE</c> (default <c>local</c>, varios separados por coma), <c>config/application.yaml</c> más los
/// fragmentos de <c>config/parameters/&lt;perfil&gt;/</c>, y placeholders <c>$[VAR}</c> (obligatoria) y
/// <c>$[VAR:default}</c>, con defaults que pueden llevar otro placeholder. Una variable obligatoria sin
/// valor no deja arrancar: se listan TODAS las que faltan, no la primera. Una variable vacía cuenta como
/// ausente.
/// </remarks>
public sealed partial class ServiceConfiguration
{
    private readonly IReadOnlyDictionary<string, string?> values;

    private ServiceConfiguration(IReadOnlyList<string> profiles, IReadOnlyDictionary<string, string?> values)
    {
        Profiles = profiles;
        this.values = values;
        ApplicationName = Get("application:name") ?? string.Empty;
        Server = new ServerSettings(
            ToPort(Get("server:port")),
            Get("server:address") ?? "0.0.0.0",
            ToDuration(Get("server:shutdown-timeout") ?? "30s"));
    }

    /// <summary>Los perfiles activos, en el orden en que se aplican sus fragmentos.</summary>
    public IReadOnlyList<string> Profiles { get; }

    public string ApplicationName { get; }

    public ServerSettings Server { get; }

    /// <summary>
    /// Todos los valores ya resueltos, con la clave de la configuración de ASP.NET Core
    /// (<c>server:port</c>): es lo que se le entrega al arrancar.
    /// </summary>
    public IReadOnlyDictionary<string, string?> Values => values;

    /// <summary>Un valor por su clave (<c>server:port</c>), o null si no existe.</summary>
    public string? Get(string key) => values.TryGetValue(key, out var value) ? value : null;

    /// <summary>
    /// Carga la configuración. <paramref name="environment"/> y <paramref name="root"/> existen para
    /// las pruebas; el servidor usa las variables del proceso y la carpeta del ejecutable, adonde la
    /// compilación copia <c>config/</c>.
    /// </summary>
    public static ServiceConfiguration Load(Func<string, string?>? environment = null, string? root = null)
    {
        environment ??= Environment.GetEnvironmentVariable;
        root ??= AppContext.BaseDirectory;
        var profiles = (environment("PROFILE") ?? "local")
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        var configDir = Path.Combine(root, "config");

        var tree = ReadYaml(Path.Combine(configDir, "application.yaml"));
        foreach (var profile in profiles)
        {
            var dir = Path.Combine(configDir, "parameters", profile);
            if (!Directory.Exists(dir))
            {
                continue;
            }
            foreach (var file in Directory.GetFiles(dir, "*.yaml").OrderBy(Path.GetFileName, StringComparer.Ordinal))
            {
                tree = Merge(tree, ReadYaml(file));
            }
        }

        var missing = new List<string>();
        var resolved = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        Flatten(tree, [], environment, resolved, missing);
        if (missing.Count > 0)
        {
            throw new InvalidOperationException(
                $"Configuración incompleta para el perfil {string.Join(',', profiles)}: faltan {missing.Count} variable(s) de entorno — {string.Join("; ", missing)}");
        }
        return new ServiceConfiguration(profiles, resolved);
    }

    /// <summary>Un puerto TCP: un entero entre 0 y 65535.</summary>
    public static int ToPort(string? value) =>
        int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var port) && port is >= 0 and <= 65535
            ? port
            : throw new InvalidOperationException($"server.port inválido: '{value}'");

    /// <summary><c>30s</c>, <c>500ms</c>, <c>2m</c>, <c>1h</c>; un número a secas son milisegundos.</summary>
    public static TimeSpan ToDuration(string value)
    {
        var text = value.Trim();
        var match = DurationPattern().Match(text);
        if (!match.Success)
        {
            throw new InvalidOperationException($"Duración inválida: '{text}' (usa 500ms, 30s, 2m o 1h)");
        }
        var amount = long.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
        return match.Groups[2].Value switch
        {
            "s" => TimeSpan.FromSeconds(amount),
            "m" => TimeSpan.FromMinutes(amount),
            "h" => TimeSpan.FromHours(amount),
            _ => TimeSpan.FromMilliseconds(amount)
        };
    }

    private static Dictionary<string, object?> ReadYaml(string file)
    {
        if (!File.Exists(file))
        {
            return [];
        }
        var stream = new YamlStream();
        using (var reader = new StreamReader(file, Encoding.UTF8))
        {
            stream.Load(reader);
        }
        return stream.Documents.Count > 0 && Convert(stream.Documents[0].RootNode) is Dictionary<string, object?> map ? map : [];
    }

    private static object? Convert(YamlNode node) => node switch
    {
        YamlMappingNode map => map.Children.ToDictionary(entry => ((YamlScalarNode)entry.Key).Value ?? string.Empty, entry => Convert(entry.Value)),
        YamlSequenceNode sequence => sequence.Children.Select(Convert).ToList(),
        YamlScalarNode scalar => IsNull(scalar) ? null : scalar.Value,
        _ => null
    };

    private static bool IsNull(YamlScalarNode scalar) =>
        scalar.Style == ScalarStyle.Plain && scalar.Value is null or "" or "~" or "null" or "Null" or "NULL";

    private static Dictionary<string, object?> Merge(Dictionary<string, object?> current, Dictionary<string, object?> overrides)
    {
        var merged = new Dictionary<string, object?>(current);
        foreach (var (key, value) in overrides)
        {
            merged[key] = merged.TryGetValue(key, out var existing)
                && existing is Dictionary<string, object?> left
                && value is Dictionary<string, object?> right
                    ? Merge(left, right)
                    : value;
        }
        return merged;
    }

    /// <summary>
    /// Aplana el árbol a claves <c>a:b:c</c> resolviendo cada valor. La ruta con puntos (<c>a.b.c</c>) es la
    /// que nombra el mensaje de una variable que falta.
    /// </summary>
    private static void Flatten(object? node, List<string> path, Func<string, string?> environment, Dictionary<string, string?> into, List<string> missing)
    {
        switch (node)
        {
            case Dictionary<string, object?> map:
                foreach (var (key, value) in map)
                {
                    Flatten(value, [.. path, key], environment, into, missing);
                }
                break;
            case List<object?> list:
                for (var index = 0; index < list.Count; index++)
                {
                    Flatten(list[index], [.. path, index.ToString(CultureInfo.InvariantCulture)], environment, into, missing);
                }
                break;
            default:
                into[string.Join(':', path)] = node is string text ? Resolve(text, environment, string.Join('.', path), missing) : null;
                break;
        }
    }

    /// <summary>
    /// Sustituye los placeholders de un valor. El default puede llevar otro placeholder
    /// (<c>$[SERVICE_INSTANCE_ID:$[HOSTNAME:unknown}}</c>); lo que llega de una variable de entorno se usa
    /// tal cual, sin volver a resolverlo.
    /// </summary>
    private static string Resolve(string value, Func<string, string?> environment, string path, List<string> missing)
    {
        var output = new StringBuilder();
        var index = 0;
        while (index < value.Length)
        {
            var start = value.IndexOf("$[", index, StringComparison.Ordinal);
            var end = start < 0 ? -1 : ClosingBrace(value, start + 2);
            if (start < 0 || end < 0)
            {
                output.Append(value, index, value.Length - index);
                break;
            }
            output.Append(value, index, start - index);
            var inner = value[(start + 2)..end];
            var colon = inner.IndexOf(':', StringComparison.Ordinal);
            var name = colon < 0 ? inner : inner[..colon];
            index = end + 1;
            if (!VariableName().IsMatch(name))
            {
                output.Append(value, start, end + 1 - start);
                continue;
            }
            var fromEnvironment = environment(name);
            if (!string.IsNullOrEmpty(fromEnvironment))
            {
                output.Append(fromEnvironment);
            }
            else if (colon >= 0)
            {
                output.Append(Resolve(inner[(colon + 1)..], environment, path, missing));
            }
            else
            {
                missing.Add($"{name} ({path})");
            }
        }
        return output.ToString();
    }

    /// <summary>La llave que cierra el placeholder que empieza en <paramref name="from"/>, saltando los anidados.</summary>
    private static int ClosingBrace(string text, int from)
    {
        var depth = 0;
        for (var index = from; index < text.Length; index++)
        {
            if (string.CompareOrdinal(text, index, "$[", 0, 2) == 0)
            {
                depth++;
                index++;
            }
            else if (text[index] == '}')
            {
                if (depth == 0)
                {
                    return index;
                }
                depth--;
            }
        }
        return -1;
    }

    [GeneratedRegex("^[A-Za-z0-9_]+$")]
    private static partial Regex VariableName();

    [GeneratedRegex(@"^(\d+)(ms|s|m|h)?$")]
    private static partial Regex DurationPattern();
}

/// <summary>Lo que el arranque necesita del servidor HTTP.</summary>
public sealed record ServerSettings(int Port, string Address, TimeSpan ShutdownTimeout);
`.replaceAll('$[', '${')
  });
}
