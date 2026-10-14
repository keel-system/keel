#!/usr/bin/env node
// Ejercita la SEGURIDAD que emite keel-dotnet contra un Keycloak real (incremento 8c).
//
// Por qué no está en `npm test`: necesita el SDK 10, red (NuGet restaura el proyecto), podman o docker, y tarda
// minutos. La suite del paquete compara lo emitido y `cs-check` ejecuta la prueba emitida de la API con tokens firmados
// en memoria; esto es lo único que dice que la cadena entera funciona con el proveedor de verdad: que
// `init-keycloak.sh` siembra el realm (y es idempotente), que el servidor resuelve las claves por el discovery del
// `issuer-uri`, que las authorities salen de los claims de Keycloak y de los `roleGrants`, que la identidad del
// llamante llega al handler desde el token y nunca desde el cuerpo, y que el arnés (`Support/Credentials.cs`) pide los
// tokens que los flujos van a usar, incluidas las personas de `TokenAs` y los usuarios de `TokenWithScope`.
//
//   node packages/keel-dotnet/scripts/security-check.js [--keep]
//   npm run security-check --workspace packages/keel-dotnet
//
// El gemelo del security-check de keel-nest, con las mismas sondas. El diseño es `profile-directory` (identidad por el
// claim `sub`, permiso otorgado por un rol). Sus handlers son TODOs: aquí se sustituyen por uno que responde
// CARD_NOT_FOUND nombrando al llamante que recibió, que es lo que hace observable la identidad sin escribir la lógica
// del servicio. Al final se falsa: con la regla de la ruta rebajada a «autenticado», la sonda del 403 sale en rojo.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from 'keel-core';
import { resolveStack, writeStackConfig } from 'keel-core/gen/stack';
import { makeWorkspace, mountDesign, runCommand } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { planService } from '../src/scaffold/index.js';
import { solution } from '../src/scaffold/render.js';
import { resolveRuntime } from '../../keel-nest/scripts/lib/database-container.js';

const DESIGN = 'profile-directory';
const keep = process.argv.includes('--keep');
const isWindows = process.platform === 'win32';
const results = [];

function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function bashExecutable() {
  if (process.env.BASH_EXECUTABLE) return process.env.BASH_EXECUTABLE;
  if (isWindows) {
    for (const candidate of [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
    ]) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
  }
  return 'bash';
}

const runtime = resolveRuntime();
if (!runtime) {
  console.error('security-check necesita podman o docker en marcha.');
  process.exit(2);
}
const env = { ...process.env, CONTAINER_RUNTIME: runtime, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };

function bash(projectDir, script, args = []) {
  const result = spawnSync(bashExecutable(), [script, ...args], { cwd: projectDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function dotnet(cwd, args) {
  const result = spawnSync('dotnet', args, { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, ok: result.status === 0, stdout: result.stdout ?? '', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const workspace = makeWorkspace('keel-dotnet-security-');
const specDir = mountDesign(workspace, DESIGN);
const projectDir = path.join(workspace, 'services', `${DESIGN}-dotnet`);
fs.mkdirSync(projectDir, { recursive: true });
writeStackConfig(projectDir, resolveStack({ database: 'postgresql', auth: 'keycloak' }, loadService(specDir).layers));
const generated = await runCommand(workspace, build, `specs/${DESIGN}`, { defaults: true, acceptUnready: true });
const sln = solution(planService({ ...loadService(specDir), workspace, stack: { database: 'postgresql', auth: 'keycloak' } }).model);
if (!step('build genera el proyecto', generated.exitCode === undefined && fs.existsSync(path.join(projectDir, sln.file)), generated.exitCode ? generated.output : '')) {
  process.exit(1);
}

// Los handlers: responden CARD_NOT_FOUND nombrando al llamante que recibieron en el mensaje.
for (const [file, todo, message] of [
  ['GetMyCardQueryHandler.cs', 'getMyCard', 'sin ficha para {query.CallerSubject}'],
  ['SaveMyCardCommandHandler.cs', 'saveMyCard', 'guardaría para {command.CallerSubject}']
]) {
  const handler = path.join(projectDir, sln.application.dir, 'UseCases', file);
  const source = fs.readFileSync(handler, 'utf8');
  const probed = source.replace(`throw new NotImplementedException("TODO: ${todo}");`, `throw new ${sln.root}.Domain.Errors.CardNotFoundError($"${message}");`);
  step(`el handler sonda de ${todo} se puede escribir`, probed !== source);
  fs.writeFileSync(handler, probed);
}

const flowsDir = path.join(projectDir, sln.integrationTests.dir);
fs.writeFileSync(
  path.join(flowsDir, 'SecurityProbeFlow.cs'),
  `namespace ${sln.integrationTests.name};

using System.Text.Json;
using ${sln.integrationTests.name}.Support;
using Xunit;

public sealed class SecurityProbeFlow : FlowTest
{
    private static JsonElement Claims(string token)
    {
        var payload = token.Split('.')[1].Replace('-', '+').Replace('_', '/');
        payload = payload.PadRight(payload.Length + ((4 - (payload.Length % 4)) % 4), '=');
        using var document = JsonDocument.Parse(Convert.FromBase64String(payload));
        return document.RootElement.Clone();
    }

    private static string Sub(string token) => Claims(token).GetProperty("sub").GetString()!;

    [Scenario("FL-SEC-001-A: sin credencial, la operación es 401 UNAUTHENTICATED")]
    public async Task SinCredencial()
    {
        var response = await Get($"{RouteBase}/me/card");
        Assert.True(response.Status == 401, response.ToString());
        Assert.Equal("UNAUTHENTICATED", response.Json().GetProperty("code").GetString());
    }

    [Scenario("FL-SEC-001-B: un token que no valida es 401 también en una ruta abierta")]
    public async Task TokenQueNoValida()
    {
        var response = await Get("/livez", new() { ["Authorization"] = "Bearer no.es-un.token" });
        Assert.True(response.Status == 401, response.ToString());
    }

    [Scenario("FL-SEC-001-C: autenticado sin el permiso de la regla es 403 ACCESS_DENIED")]
    public async Task SinPermiso()
    {
        var response = await Get($"{RouteBase}/me/card", Bearer(await TokenFor("no-role")));
        Assert.True(response.Status == 403, response.ToString());
        Assert.Equal("ACCESS_DENIED", response.Json().GetProperty("code").GetString());
    }

    [Scenario("FL-SEC-001-D: con el rol que otorga el permiso, llega al handler con el sub del token")]
    public async Task ConElRol()
    {
        var token = await TokenFor("card-holder");
        var response = await Get($"{RouteBase}/me/card", Bearer(token));
        Assert.True(response.Status == 404, response.ToString());
        Assert.Equal("CARD_NOT_FOUND", response.Json().GetProperty("code").GetString());
        Assert.Equal($"sin ficha para {Sub(token)}", response.Json().GetProperty("message").GetString());
    }

    [Scenario("FL-SEC-001-E: la persona de TokenAs llega con el sub que eligió el escenario")]
    public async Task Persona()
    {
        var token = await TokenAs("sub-ana-001", new Dictionary<string, string?> { ["email"] = "ana@example.test" }, "card-holder");
        var response = await Get($"{RouteBase}/me/card", Bearer(token));
        Assert.True(response.Status == 404, response.ToString());
        Assert.Equal("sin ficha para sub-ana-001", response.Json().GetProperty("message").GetString());
    }

    [Scenario("FL-SEC-001-F: TokenAs cambia los claims de la misma persona entre peticiones")]
    public async Task PersonaSinClaim()
    {
        var withEmail = await TokenAs("sub-ana-001", new Dictionary<string, string?> { ["email"] = "ana@example.test" }, "card-holder");
        var without = await TokenAs("sub-ana-001", new Dictionary<string, string?> { ["email"] = null }, "card-holder");
        Assert.Equal("ana@example.test", Claims(withEmail).GetProperty("email").GetString());
        Assert.False(Claims(without).TryGetProperty("email", out _));
        Assert.Equal("sub-ana-001", Sub(without));
    }

    [Scenario("FL-SEC-001-G: la identidad no se acepta del cuerpo")]
    public async Task IdentidadDelCuerpo()
    {
        var token = await TokenFor("card-holder");
        var response = await Put($"{RouteBase}/me/card", new { callerSubject = "intruso", displayName = "X" }, Bearer(token));
        Assert.True(response.Status == 404, response.ToString());
        Assert.Equal($"guardaría para {Sub(token)}", response.Json().GetProperty("message").GetString());
    }

    [Scenario("FL-SEC-001-H: un camino que no existe es 401 sin credencial y 404 con ella")]
    public async Task CaminoInexistente()
    {
        Assert.Equal(401, (await Get($"{RouteBase}/no-existe")).Status);
        Assert.Equal(404, (await Get($"{RouteBase}/no-existe", Bearer(await TokenFor("card-holder")))).Status);
    }

    [Scenario("FL-SEC-001-I: un token de otro emisor (otro host del mismo Keycloak) es 401")]
    public async Task OtroEmisor()
    {
        using var http = new HttpClient();
        using var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "password",
            ["client_id"] = "${DESIGN}-dotnet-test",
            ["username"] = "card-holder",
            ["password"] = "password"
        });
        using var issued = await http.PostAsync(new Uri("http://127.0.0.1:8180/realms/${DESIGN}/protocol/openid-connect/token"), form);
        using var document = JsonDocument.Parse(await issued.Content.ReadAsStringAsync());
        var foreign = document.RootElement.GetProperty("access_token").GetString()!;
        var response = await Get($"{RouteBase}/me/card", Bearer(foreign));
        Assert.True(response.Status == 401, response.ToString());
    }
}
`
);
const compiled = dotnet(projectDir, ['build', sln.file, '-c', 'Debug']);
if (!step('el proyecto con los handlers y la sonda compila sin warnings', compiled.ok, compiled.ok ? '' : compiled.output.slice(-2500))) process.exit(1);

const up = bash(projectDir, 'infra/up.sh');
if (!step('bash infra/up.sh (PostgreSQL y Keycloak)', up.status === 0, up.status === 0 ? '' : up.output.slice(-1200))) process.exit(1);
try {
  const seed = bash(projectDir, 'infra/init-keycloak.sh');
  step('bash infra/init-keycloak.sh siembra el realm', seed.status === 0 && new RegExp(`Realm '${DESIGN}' listo`).test(seed.output), seed.status === 0 ? '' : seed.output.slice(-1500));
  const again = bash(projectDir, 'infra/init-keycloak.sh');
  step('y es idempotente: la segunda pasada también sale con 0', again.status === 0, again.status === 0 ? '' : again.output.slice(-800));
  const validate = bash(projectDir, 'infra/validate-infra.sh');
  step('bash infra/validate-infra.sh', validate.status === 0, validate.status === 0 ? '' : validate.output.slice(-1200));

  // El documento de escenarios declara SOLO la sonda: un id que el documento no declara es AJENO, no puntúa, y su
  // FALLO no deja el script en 1 (sale con 2, arnés roto), así que el falsado no se podría leer. Sustituye al del
  // diseño, y su línea sale del sello: specs.sha256 vigila lo que lista, y el documento sonda no lo escribió build.
  fs.writeFileSync(path.join(projectDir, 'specs', 'validation-scenarios.md'), '#### FL-SEC-001 — sonda de la seguridad\n');
  const seal = path.join(projectDir, 'specs.sha256');
  if (fs.existsSync(seal)) {
    fs.writeFileSync(seal, fs.readFileSync(seal, 'utf8').split('\n').filter((line) => !line.endsWith('specs/validation-scenarios.md')).join('\n'));
  }
  const scored = bash(projectDir, 'infra/score-scenarios.sh');
  const lines = scored.output;
  for (const id of 'ABCDEFGHI') {
    const ok = new RegExp(`OK\\s+FL-SEC-001-${id}`).test(lines);
    step(`score: FL-SEC-001-${id}`, ok, ok ? '' : (lines.match(new RegExp(`.*FL-SEC-001-${id}.*`))?.[0] ?? 'sin fila'));
  }
  // Con el humo (SMOKE-5: el proveedor emite las credenciales) en verde y la sonda entera en OK, el script sale con 0.
  const measured = scored.status === 0 && /Humo del arnés: OK/.test(lines);
  step('score: el humo del arnés (con SMOKE-5, las credenciales) en verde y el script con 0', measured, measured ? '' : lines.slice(-2500));

  // Falsado: con la regla de GET /me/card rebajada a «autenticado», el usuario sin el permiso pasa.
  const rulesFile = path.join(projectDir, sln.infrastructure.dir, 'Security', 'AccessRules.cs');
  const rules = fs.readFileSync(rulesFile, 'utf8');
  const weakened = rules.replace(/(new AccessRule\("GET", "[^"]*\/me\/card", )Requirement\.AnyOf\("card:self"\)/, '$1Requirement.Authenticated');
  if (step('falsado: la regla de GET /me/card se puede rebajar en las reglas emitidas', weakened !== rules)) {
    fs.writeFileSync(rulesFile, weakened);
    const sabotaged = bash(projectDir, 'infra/score-scenarios.sh');
    const caught = sabotaged.status === 1 && /FALLO\s+FL-SEC-001-C/.test(sabotaged.output) && !/FALLO\s+FL-SEC-001-[ABDEFGHI]/.test(sabotaged.output);
    step('falsado: con la regla rebajada, FL-SEC-001-C sale FALLO (y solo él) y el script con 1', caught, caught ? '' : `código ${sabotaged.status}\n${sabotaged.output.slice(-2000)}`);
    fs.writeFileSync(rulesFile, rules);
  }
} finally {
  const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
  step('bash infra/down.sh --volumes', down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
}

// ── Segundo sujeto: el claim del ALCANCE con otro valor (`TokenWithScope`) ─────────────────────────────
//
// `profile-directory` no declara alcance por recurso; `asset-vault` sí (claim `vaults` sobre `Owner.code`). keel-dotnet
// todavía no genera ese diseño entero (su frontera rechaza mensajería y storage), pero su infra/ y su arnés de identidad
// SÍ los emite: se escriben del plan, se levanta su infraestructura y el `Credentials.cs` emitido se compila en un
// programa de consola con el cwd en el proyecto, así que lee su `infra/test-credentials.env` y habla con el Keycloak que
// siembra su `init-keycloak.sh`. Lo que se mide es lo que ningún test sin red puede: que el usuario que da de alta lleve
// el claim al TOKEN firmado.
{
  const SCOPED = 'asset-vault';
  const scopedWorkspace = makeWorkspace('keel-dotnet-security-scoped-');
  const scopedSpec = mountDesign(scopedWorkspace, SCOPED);
  const scopedDir = path.join(scopedWorkspace, 'services', `${SCOPED}-dotnet`);
  const stack = { database: 'mongodb', broker: 'rabbitmq', auth: 'keycloak', cache: 'redis', storage: 'minio' };
  const { model, files } = planService({ ...loadService(scopedSpec), workspace: scopedWorkspace, stack });
  for (const file of files) {
    const target = path.join(scopedDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  writeStackConfig(scopedDir, resolveStack(stack, loadService(scopedSpec).layers));
  const scopedSln = solution(model);
  const credentials = path.join(scopedDir, scopedSln.integrationTests.dir, 'Support', 'Credentials.cs');
  step(`${SCOPED}: el plan emite infra/ y el arnés de identidad`, fs.existsSync(credentials) && fs.existsSync(path.join(scopedDir, 'infra', 'init-keycloak.sh')));

  // El programa de consola: el Credentials.cs emitido, un Harness mínimo con la raíz del proyecto y las preguntas.
  const probeDir = path.join(scopedWorkspace, 'scoped-probe');
  fs.mkdirSync(probeDir, { recursive: true });
  const supportNamespace = `${scopedSln.integrationTests.name}.Support`;
  fs.writeFileSync(
    path.join(probeDir, 'ScopedProbe.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
`
  );
  fs.copyFileSync(credentials, path.join(probeDir, 'Credentials.cs'));
  fs.writeFileSync(
    path.join(probeDir, 'Harness.cs'),
    `namespace ${supportNamespace};\n\ninternal static class Harness\n{\n    public static string Root => ${JSON.stringify(scopedDir)};\n}\n`
  );
  fs.writeFileSync(
    path.join(probeDir, 'Program.cs'),
    `using System.Text.Json;
using ${supportNamespace};

var other = Claims(await Credentials.TokenWithScope("vault-reader", ["OTRO"]));
var many = Claims(await Credentials.TokenWithScope("vault-reader", ["B", "A"]));
var none = Claims(await Credentials.TokenWithScope("vault-reader", []));
var again = Claims(await Credentials.TokenWithScope("vault-reader", ["OTRO"]));
var seeded = Claims(await Credentials.TokenFor("vault-reader", 1));
Console.WriteLine(JsonSerializer.Serialize(new { other, many, none, again, seeded, resource = Credentials.ScopedResource() }));

static JsonElement Claims(string token)
{
    var payload = token.Split('.')[1].Replace('-', '+').Replace('_', '/');
    payload = payload.PadRight(payload.Length + ((4 - (payload.Length % 4)) % 4), '=');
    using var document = JsonDocument.Parse(Convert.FromBase64String(payload));
    return document.RootElement.Clone();
}
`
  );
  const probeBuild = dotnet(probeDir, ['build', '-c', 'Debug']);
  if (step(`${SCOPED}: el Credentials.cs emitido compila en el programa sonda`, probeBuild.ok, probeBuild.ok ? '' : probeBuild.output.slice(-2000))) {
    const scopedUp = bash(scopedDir, 'infra/up.sh');
    if (step(`${SCOPED}: bash infra/up.sh`, scopedUp.status === 0, scopedUp.status === 0 ? '' : scopedUp.output.slice(-1200))) {
      try {
        const seeded = bash(scopedDir, 'infra/init-keycloak.sh');
        if (step(`${SCOPED}: bash infra/init-keycloak.sh siembra el realm con el claim del alcance`, seeded.status === 0, seeded.status === 0 ? '' : seeded.output.slice(-1500))) {
          const run = dotnet(probeDir, ['run', '--no-build']);
          let out = null;
          try {
            out = JSON.parse(run.stdout.trim().split('\n').pop());
          } catch {
            out = null;
          }
          step(`${SCOPED}: el arnés ejecuta TokenWithScope contra Keycloak`, run.ok && out != null, run.ok ? '' : run.output.slice(-1500));
          if (out) {
            const roles = (token) => token.realm_access?.roles ?? [];
            step('TokenWithScope(rol, "OTRO"): el token lleva vaults = ["OTRO"] y el rol', JSON.stringify(out.other.vaults) === '["OTRO"]' && roles(out.other).includes('vault-reader'), JSON.stringify(out.other.vaults));
            step('TokenWithScope(rol, "B", "A"): los dos valores', JSON.stringify([...(out.many.vaults ?? [])].sort()) === '["A","B"]', JSON.stringify(out.many.vaults));
            step('TokenWithScope(rol): el usuario del rol SIN el claim', out.none.vaults === undefined && roles(out.none).includes('vault-reader'), JSON.stringify(out.none.vaults));
            step(
              'el mismo rol y valores dan el mismo usuario que en keel-spring y keel-nest (nombre determinista)',
              out.again.preferred_username === out.other.preferred_username && out.other.preferred_username === 'scoped-vault-reader-252ee2',
              out.other.preferred_username
            );
            step('TokenFor(rol) sigue trayendo ScopedResource()', JSON.stringify(out.seeded.vaults) === JSON.stringify([out.resource]), JSON.stringify(out.seeded.vaults));
          }
          // Falsado: sin el atributo en el alta, el token sale sin claim y el arnés tiene que morir nombrando al usuario.
          const emitted = fs.readFileSync(path.join(probeDir, 'Credentials.cs'), 'utf8');
          const sabotaged = emitted.replace(/\s*if \(values\.Count > 0\) user\["attributes"\] = [^\n]*\n/, '\n');
          const program = fs.readFileSync(path.join(probeDir, 'Program.cs'), 'utf8');
          if (step('falsado: el alta del usuario del alcance se puede quitar en lo emitido', sabotaged !== emitted)) {
            fs.writeFileSync(path.join(probeDir, 'Credentials.cs'), sabotaged);
            fs.writeFileSync(path.join(probeDir, 'Program.cs'), program.replaceAll('"OTRO"', '"SABOTAJE"'));
            const broken = dotnet(probeDir, ['run']);
            step('falsado: sin el atributo, TokenWithScope muere nombrando al usuario', !broken.ok && /tiene vaults=\[\] y el escenario pidió \[SABOTAJE\]/.test(broken.output), `código ${broken.status}`);
          }
        }
      } finally {
        const down = bash(scopedDir, 'infra/down.sh', ['--volumes']);
        step(`${SCOPED}: bash infra/down.sh --volumes`, down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
      }
    }
  }
}

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-dotnet-security-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\nsecurity-check: ${results.length}/${results.length} en verde.` : `\nsecurity-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
