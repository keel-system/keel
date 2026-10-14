// Las pruebas que el proyecto trae recién generado: las del arranque, bajo el perfil `test`. No son las
// del agente (el flujo de generación no escribe pruebas unitarias): son la red de lo que build emite, y
// tienen que pasar sin una línea de nadie más. Las mismas que trae el proyecto de keel-nest.
//
//   · la configuración: el gradiente de variables, la lista de lo que falta y los defaults anidados,
//     contra una carpeta config/ temporal;
//   · las sondas, pidiendo las rutas al servidor en memoria (WebApplicationFactory);
//   · el drenaje, activado sin señal: en Windows un SIGTERM mata el proceso sin ejecutar nada, así que
//     probarlo por la señal no mediría nada allí.

import { solution, csFile } from './render.js';
import { configNamespace } from './config.js';
import { healthNamespace } from './health.js';
import { usesJwt, TEST_JWKS_VARIABLE } from './security.js';
import { usesTestCredential } from './test-credential.js';

export function testsNamespace(model) {
  return solution(model).unitTests.name;
}

export function generate(model) {
  const dir = solution(model).unitTests.dir;
  return [
    { path: `${dir}/InMemoryServer.cs`, content: testServerCs(model) },
    { path: `${dir}/ConfigurationTests.cs`, content: configurationTestsCs(model) },
    { path: `${dir}/HealthTests.cs`, content: healthTestsCs(model) }
  ];
}

function testServerCs(model) {
  // Con seguridad por token, el perfil test solo acepta los tokens de la clave que publica la prueba (TestCredential).
  const jwks =
    usesTestCredential(model) && usesJwt(model)
      ? `
        // El perfil test solo acepta los tokens de la clave de la prueba (TestCredential): su JWKS.
        Environment.SetEnvironmentVariable(${JSON.stringify(TEST_JWKS_VARIABLE)}, TestCredential.Jwks);`
      : '';
  return csFile({
    namespace: testsNamespace(model),
    usings: ['Microsoft.AspNetCore.Mvc.Testing'],
    body: `
/// <summary>
/// El servidor en memoria, bajo el perfil <c>test</c>: el que las pruebas arrancan sin infraestructura.
/// </summary>
public sealed class InMemoryServer : WebApplicationFactory<Program>
{
    public InMemoryServer()
    {
        // El arranque lee el perfil de PROFILE antes de crear la aplicación.
        Environment.SetEnvironmentVariable("PROFILE", "test");${jwks}
    }
}
`
  });
}

function configurationTestsCs(model) {
  const body = `
public sealed class ConfigurationTests : IDisposable
{
    // Lo que el cargador exige siempre (el puerto del servidor), para las pruebas que miran otra cosa.
    private const string BaseYaml = "server:\\n  port: 8080\\n";

    private readonly DirectoryInfo root = Directory.CreateTempSubdirectory("keel-config-");

    public void Dispose() => root.Delete(recursive: true);

    private void Write(string relativePath, string yaml)
    {
        var file = Path.Combine(root.FullName, "config", relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, yaml);
    }

    private ServiceConfiguration Load(params (string Name, string Value)[] variables)
    {
        var environment = variables.ToDictionary(variable => variable.Name, variable => variable.Value);
        return ServiceConfiguration.Load(name => environment.GetValueOrDefault(name), root.FullName);
    }

    [Fact]
    public void ElDefaultValeSiLaVariableNoEstaYLaVariableGanaSiEsta()
    {
        Write("application.yaml", "server:\\n  port: \${SERVER_PORT:8080}\\n");
        Assert.Equal(8080, Load().Server.Port);
        Assert.Equal(9090, Load(("SERVER_PORT", "9090")).Server.Port);
    }

    [Fact]
    public void UnaVariableObligatoriaSinValorNoDejaArrancarYSeListanTodas()
    {
        Write("application.yaml", BaseYaml + "db:\\n  url: \${DB_URL}\\n  user: \${DB_USER}\\n");
        var error = Assert.Throws<InvalidOperationException>(() => Load());
        Assert.Contains("faltan 2 variable(s)", error.Message, StringComparison.Ordinal);
        Assert.Contains("DB_URL (db.url)", error.Message, StringComparison.Ordinal);
        Assert.Contains("DB_USER (db.user)", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void UnaVariableVaciaCuentaComoAusente()
    {
        Write("application.yaml", BaseYaml + "a: \${A:por-defecto}\\n");
        Assert.Equal("por-defecto", Load(("A", "")).Get("a"));
    }

    [Fact]
    public void ElDefaultPuedeLlevarOtroPlaceholder()
    {
        Write("application.yaml", BaseYaml + "id: \${SERVICE_INSTANCE_ID:\${HOSTNAME:unknown}}\\n");
        Assert.Equal("unknown", Load().Get("id"));
        Assert.Equal("host-1", Load(("HOSTNAME", "host-1")).Get("id"));
    }

    [Fact]
    public void LosFragmentosDelPerfilPisanLoComun()
    {
        Write("application.yaml", "server:\\n  port: 8080\\n  address: 0.0.0.0\\n");
        Write("parameters/develop/server.yaml", "server:\\n  port: 9000\\n");
        var configuration = Load(("PROFILE", "develop"));
        Assert.Equal(9000, configuration.Server.Port);
        Assert.Equal("0.0.0.0", configuration.Server.Address);
        Assert.Equal(new[] { "develop" }, configuration.Profiles);
    }

    [Theory]
    [InlineData("30s", 30_000)]
    [InlineData("500ms", 500)]
    [InlineData("2m", 120_000)]
    [InlineData("1h", 3_600_000)]
    [InlineData("250", 250)]
    public void LasDuracionesSeLeenConSuUnidad(string text, long milliseconds) =>
        Assert.Equal(TimeSpan.FromMilliseconds(milliseconds), ServiceConfiguration.ToDuration(text));
}
`;
  return csFile({ namespace: testsNamespace(model), usings: ['Xunit', configNamespace(model)], body });
}

function healthTestsCs(model) {
  return csFile({
    namespace: testsNamespace(model),
    usings: ['System.Net', 'Microsoft.Extensions.DependencyInjection', 'Xunit', healthNamespace(model)],
    body: `
public sealed class HealthTests
{
    private static async Task<(HttpStatusCode Status, string Body)> GetAsync(InMemoryServer server, string path)
    {
        using var client = server.CreateClient();
        using var response = await client.GetAsync(path, TestContext.Current.CancellationToken);
        return (response.StatusCode, await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task ArrancaYLasDosSondasRespondenUp()
    {
        await using var server = new InMemoryServer();
        Assert.Equal((HttpStatusCode.OK, """{"status":"UP"}"""), await GetAsync(server, "/livez"));
        Assert.Equal((HttpStatusCode.OK, """{"status":"UP"}"""), await GetAsync(server, "/readyz"));
    }

    [Fact]
    public async Task MientrasDrenaReadyzRespondeOutOfServiceYLivezSigueUp()
    {
        await using var server = new InMemoryServer();
        server.Services.GetRequiredService<GracefulShutdown>().StartDraining();
        Assert.Equal((HttpStatusCode.ServiceUnavailable, """{"status":"OUT_OF_SERVICE"}"""), await GetAsync(server, "/readyz"));
        Assert.Equal((HttpStatusCode.OK, """{"status":"UP"}"""), await GetAsync(server, "/livez"));
    }
}
`
  });
}
