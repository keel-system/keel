// Parámetros de DESPLIEGUE del servicio (`service.keel.yaml § parameters`, DSL 2.15): un valor único para todo el
// servicio que no es dato de negocio ni entrada de ninguna operación —la moneda del catálogo, el plazo tras el que un
// trabajo se da por abandonado— (incremento 10c). Hasta aquí keel-dotnet los ignoraba EN SILENCIO, el hueco que keel-nest
// destapó en su propio 10c.
//
// El mismo reparto que en keel-spring y keel-nest, porque la frontera hexagonal es la misma: la capa Application no lee
// configuración, así que el valor viaja en una clase de DOMINIO que valida sus cotas al construirse —un parámetro mal
// puesto tiene que tumbar el ARRANQUE, no la primera petición que lo use— y quien la puebla desde la configuración es
// Infrastructure. Misma clave (`<artifactId>.<key>`), misma variable de entorno, mismo gradiente por perfil
// (keel-core/gen/service-parameters.js) y las mismas frases de error.

import { parameterProfileValue, parameterProperty } from 'keel-core/gen/service-parameters';
import { csFile, csLocal, csMember, csString, located, namespaceOf, solution, xmlDoc } from './render.js';
import { configNamespace } from './config.js';

const PROFILES = ['local', 'develop', 'production', 'test'];
const SUPPORTED_TYPES = ['string', 'int', 'long', 'decimal', 'bool'];

export const parametersClass = (model) => `${model.service.className}Parameters`;

export function parametersNamespace(model) {
  return namespaceOf(model, 'parameters');
}

export function usesServiceParameters(model) {
  return (model.service.parameters ?? []).length > 0;
}

/** La expresión C# que construye los parámetros con su valor de prueba: la usan las pruebas que montan el contenedor. */
export function parametersTestInstance(model) {
  const args = model.service.parameters.map((parameter) => literal(parameter, parameter.testValue ?? parameter.default));
  return `new ${parametersClass(model)}(${args.join(', ')})`;
}

export function generate(model) {
  if (!usesServiceParameters(model)) return [];
  for (const parameter of model.service.parameters) {
    if (!SUPPORTED_TYPES.includes(parameter.csType)) throw new Error(`service.parameters.${parameter.name}: keel-dotnet no sabe mapear el tipo ${parameter.csType}`);
  }
  const domain = located(model, 'parameters', parametersClass(model));
  const registration = located(model, 'config', 'ServiceParametersRegistration');
  const sln = solution(model);
  return [
    { path: domain.path, content: csFile({ namespace: domain.namespace, usings: domainUsings(model), body: domainBody(model) }) },
    {
      path: registration.path,
      content: csFile({
        namespace: registration.namespace,
        usings: ['System.Globalization', 'Microsoft.Extensions.DependencyInjection', parametersNamespace(model)],
        body: registrationBody(model)
      })
    },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/${model.service.artifactId}.yaml`, content: yaml(model, profile) })),
    { path: `${sln.unitTests.dir}/ServiceParametersTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings: ['Xunit', parametersNamespace(model)], body: testsBody(model) }) }
  ];
}

/** El MISMO texto que el fragmento de keel-nest. */
function yaml(model, profile) {
  const lines = [`${model.service.artifactId}:`];
  for (const parameter of model.service.parameters) {
    lines.push(`  # ${parameter.description}`, `  ${parameter.key}: ${parameterProfileValue(parameter, profile)}`);
  }
  return `${lines.join('\n')}\n`;
}

function domainUsings(model) {
  return model.service.parameters.some((parameter) => parameter.constraints?.pattern) ? ['System.Text.RegularExpressions'] : [];
}

/** Las cotas que el diseño declara, como guardas de constructor (las frases de keel-spring y keel-nest). */
function guardsFor(parameter) {
  const name = csLocal(parameter.name);
  const value = `${name}.Value`;
  const nullable = parameter.csType !== 'string';
  const lines = [
    `        if (${name} is null)`,
    '        {',
    `            throw new ArgumentException(${csString(`Falta el parámetro de despliegue '${parameter.key}' (variable ${parameter.envVar}).`)}, nameof(${name}));`,
    '        }'
  ];
  const text = nullable ? value : name;
  const fail = (what) => [
    '        {',
    `            throw new ArgumentException(${csString(`El parámetro '${parameter.key}' ${what}.`)}, nameof(${name}));`,
    '        }'
  ];
  const { pattern, minLength, maxLength, min, max } = parameter.constraints ?? {};
  if (pattern) lines.push(`        if (!Regex.IsMatch(${text}, ${csString(`^(?:${pattern})\\z`)}, RegexOptions.CultureInvariant))`, ...fail('no respeta su formato declarado'));
  if (minLength != null || maxLength != null) {
    const cond = [minLength != null ? `${text}.Length < ${minLength}` : null, maxLength != null ? `${text}.Length > ${maxLength}` : null].filter(Boolean).join(' || ');
    lines.push(`        if (${cond})`, ...fail('no respeta su longitud declarada'));
  }
  if (min != null || max != null) {
    const bound = (limit) => (parameter.csType === 'decimal' ? `${limit}m` : String(limit));
    const cond = [min != null ? `${text} < ${bound(min)}` : null, max != null ? `${text} > ${bound(max)}` : null].filter(Boolean).join(' || ');
    lines.push(`        if (${cond})`, ...fail('está fuera del rango declarado'));
  }
  return lines;
}

function domainBody(model) {
  const parameters = model.service.parameters;
  const params = parameters.map((parameter) => `${parameter.csType}? ${csLocal(parameter.name)}`).join(', ');
  const assigns = parameters.map((parameter) => `        ${csMember(parameter.name)} = ${csLocal(parameter.name)}${parameter.csType === 'string' ? '' : '.Value'};`);
  const properties = parameters.map((parameter) => `${xmlDoc(parameter.description, '    ')}    public ${parameter.csType} ${csMember(parameter.name)} { get; }`);
  return `/// <summary>
/// Parámetros de despliegue de ${model.service.name}, ya validados.
/// </summary>
/// <remarks>
/// Value object de dominio: llega por inyección a quien lo necesite, nunca leyendo la configuración desde Application. Lo
/// puebla ServiceParametersRegistration desde <c>${model.service.artifactId}.*</c> de la configuración del perfil. Las cotas
/// se comprueban AQUÍ, al construirlo: un valor mal puesto tumba el arranque.
/// </remarks>
public sealed class ${parametersClass(model)}
{
    public ${parametersClass(model)}(${params})
    {
${parameters.flatMap(guardsFor).join('\n')}
${assigns.join('\n')}
    }

${properties.join('\n\n')}
}`;
}

const READERS = { string: 'Text', int: 'Int', long: 'Long', decimal: 'Decimal', bool: 'Flag' };

const READER_CODE = {
  Text: `    private static string? Text(ServiceConfiguration configuration, string key) => Raw(configuration, key);`,
  Int: `    private static int? Int(ServiceConfiguration configuration, string key) =>
        Raw(configuration, key) is { } value
            ? int.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var parsed) ? parsed : throw NotA(key, value, "un entero")
            : null;`,
  Long: `    private static long? Long(ServiceConfiguration configuration, string key) =>
        Raw(configuration, key) is { } value
            ? long.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var parsed) ? parsed : throw NotA(key, value, "un entero")
            : null;`,
  Decimal: `    private static decimal? Decimal(ServiceConfiguration configuration, string key) =>
        Raw(configuration, key) is { } value
            ? decimal.TryParse(value, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var parsed) ? parsed : throw NotA(key, value, "un decimal")
            : null;`,
  Flag: `    private static bool? Flag(ServiceConfiguration configuration, string key) =>
        Raw(configuration, key) switch
        {
            null => null,
            "true" => true,
            "false" => false,
            var value => throw NotA(key, value, "true o false")
        };`
};

function registrationBody(model) {
  const parameters = model.service.parameters;
  const args = parameters.map((parameter) => `            ${READERS[parameter.csType]}(configuration, ${csString(parameterProperty(model, parameter).replaceAll('.', ':'))})`);
  const readers = [...new Set(parameters.map((parameter) => READERS[parameter.csType]))].map((reader) => READER_CODE[reader]);
  const numeric = parameters.some((parameter) => parameter.csType !== 'string');
  return `/// <summary>
/// Los parámetros de despliegue del perfil activo, en el contenedor: quien los necesita los inyecta por su clase
/// (${parametersClass(model)}).
/// </summary>
/// <remarks>
/// Sin defaults aquí a propósito: el gradiente por perfil está en config/parameters/&lt;perfil&gt;/${model.service.artifactId}.yaml, y en
/// producción un parámetro obligatorio sin valor no deja arrancar.
/// </remarks>
public static class ServiceParametersRegistration
{
    public static IServiceCollection AddServiceParameters(this IServiceCollection services, ServiceConfiguration configuration)
    {
        services.AddSingleton(From(configuration));
        return services;
    }

    /// <summary>Lee y convierte cada parámetro; el dominio valida sus cotas al construirlo.</summary>
    public static ${parametersClass(model)} From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return new ${parametersClass(model)}(
${args.join(',\n')});
    }

    private static string? Raw(ServiceConfiguration configuration, string key) =>
        configuration.Get(key) is { } value && !string.IsNullOrWhiteSpace(value) ? value.Trim() : null;

${readers.join('\n\n')}${
    numeric
      ? `

    private static InvalidOperationException NotA(string key, string value, string what) =>
        new($"{key.Replace(':', '.')} tiene que ser {what}: '{value}'");`
      : ''
  }
}`;
}

/** Un valor del diseño como literal C# del tipo del parámetro. */
function literal(parameter, value) {
  if (value == null) return 'null';
  if (parameter.csType === 'string') return csString(String(value));
  if (parameter.csType === 'decimal') return `${value}m`;
  if (parameter.csType === 'long') return `${value}L`;
  if (parameter.csType === 'bool') return String(value === true || value === 'true');
  return String(value);
}

/** Un valor que rompe el formato: el primero de la lista que no casa con la expresión del diseño. */
function breaking(pattern) {
  const regex = new RegExp(`^(?:${pattern})$`, 'u');
  return ['!', '', 'zz-zz', '0', ' x '].find((candidate) => !regex.test(candidate)) ?? null;
}

/** Los casos de la prueba emitida: el valor de prueba se acepta; ausente y fuera de cotas, no, con su frase. */
function testsBody(model) {
  const parameters = model.service.parameters;
  const valid = parameters.map((parameter) => literal(parameter, parameter.testValue ?? parameter.default));
  const call = (index, value) => `new ${parametersClass(model)}(${valid.map((arg, i) => (i === index ? value : arg)).join(', ')})`;
  const tests = [
    `    [Fact]
    public void ElValorDePruebaSeAcepta()
    {
        var parameters = ${call(-1)};
${parameters.map((parameter, i) => `        Assert.Equal(${valid[i]}, parameters.${csMember(parameter.name)});`).join('\n')}
    }`
  ];
  const rejections = [];
  parameters.forEach((parameter, index) => {
    rejections.push({ value: 'null', message: `Falta el parámetro de despliegue '${parameter.key}' (variable ${parameter.envVar}).`, index, parameter });
    const { pattern, minLength, maxLength, min, max } = parameter.constraints ?? {};
    if (pattern && parameter.csType === 'string') {
      const value = breaking(pattern);
      if (value != null) rejections.push({ value: csString(value), message: `El parámetro '${parameter.key}' no respeta su formato declarado.`, index, parameter });
    }
    if (minLength != null && minLength > 0) rejections.push({ value: csString('x'.repeat(minLength - 1)), message: `no respeta su longitud declarada`, index, parameter, partial: true });
    if (maxLength != null) rejections.push({ value: csString('x'.repeat(maxLength + 1)), message: `no respeta su longitud declarada`, index, parameter, partial: true });
    if (min != null) rejections.push({ value: literal(parameter, min - 1), message: `El parámetro '${parameter.key}' está fuera del rango declarado.`, index, parameter });
    if (max != null) rejections.push({ value: literal(parameter, max + 1), message: `El parámetro '${parameter.key}' está fuera del rango declarado.`, index, parameter });
  });
  // Una longitud fuera de cota puede romper ANTES el formato: de esa solo se afirma que no arranca.
  tests.push(`    [Fact]
    public void AusenteOFueraDeSusCotasNoArranca()
    {
${rejections
  .map(({ value, message, index, partial }) =>
    partial
      ? `        Assert.Throws<ArgumentException>(() => ${call(index, value)});`
      : `        Assert.StartsWith(${csString(message)}, Assert.Throws<ArgumentException>(() => ${call(index, value)}).Message, StringComparison.Ordinal);`
  )
  .join('\n')}
    }`);
  return `/// <summary>Los parámetros de despliegue validan al construirse, con las frases de keel-spring y keel-nest.</summary>
public sealed class ServiceParametersTests
{
${tests.join('\n\n')}
}`;
}
