#!/usr/bin/env node
// Ejercita el ARNÉS DE INTEGRACIÓN que emite keel-dotnet contra su infraestructura real.
//
// Por qué no está en `npm test`: necesita el SDK 10, red (NuGet restaura el proyecto), podman o docker, y tarda
// minutos. La suite del paquete compara el texto emitido y ejecuta el awk de la matriz contra un XML fabricado; esto
// es lo único que dice que la cadena entera funciona: que `infra/up.sh` levanta lo que el diseño pide, que
// `validate-infra.sh` lo ve listo, que el arnés arranca el servidor como proceso contra esa base, que `reset-db.sh`
// vacía los datos y RESPETA el historial de migraciones, que xUnit escribe el XML que `score-scenarios.sh` sabe
// leer, y que cada desenlace sale con su código y su evidencia.
//
//   node packages/keel-dotnet/scripts/harness-check.js [--keep] [--sabotage=statement-count]
//   npm run harness-check --workspace packages/keel-dotnet
//
// --sabotage=statement-count quita el interceptor que cuenta las sentencias (statement-count.js) CONSERVANDO la ruta
// que las sirve: la sonda del coste (FL-PROBE-001-E) tiene que salir en rojo, y solo ella. Medido el 2026-10-19: 3 pasos
// rojos, la sonda y las dos pasadas siguientes del score (el 2 y el 0), que esperan la matriz en verde y la arrastran.
//
// Las pruebas de flujo son SONDAS escritas aquí (los handlers del proyecto recién generado son TODOs): una que pasa,
// una que falla a propósito, una cuyo flujo no llega a arrancar, una que comprueba el orden de los escenarios y una
// que rompe la caja negra. Cada una afirma un desenlace distinto del script. Es el gemelo del harness-check de
// keel-nest.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWorkspace, mountDesign, runCommand, DOTNET_READY_DESIGN } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { resolveRuntime } from '../../keel-nest/scripts/lib/database-container.js';
import { MIGRATIONS_TABLE } from '../src/scaffold/persistence-runtime.js';

const keep = process.argv.includes('--keep');
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
if (sabotage && sabotage !== 'statement-count') {
  console.error(`Sabotaje desconocido: ${sabotage}. El único es statement-count.`);
  process.exit(2);
}
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
  console.error('harness-check necesita podman o docker en marcha.');
  process.exit(2);
}
const env = { ...process.env, CONTAINER_RUNTIME: runtime, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };

function bash(projectDir, script, args = []) {
  const result = spawnSync(bashExecutable(), [script, ...args], { cwd: projectDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function dotnet(projectDir, args) {
  const result = spawnSync('dotnet', args, { cwd: projectDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const workspace = makeWorkspace('keel-dotnet-harness-');
mountDesign(workspace, DOTNET_READY_DESIGN.name, DOTNET_READY_DESIGN);
const generated = await runCommand(workspace, build, `specs/${DOTNET_READY_DESIGN.name}`, { defaults: true, acceptUnready: true });
const projectDir = path.join(workspace, 'services', `${DOTNET_READY_DESIGN.name}-dotnet`);
if (!step('build genera el proyecto', generated.exitCode === undefined && fs.existsSync(projectDir), generated.exitCode ? generated.output : '')) {
  process.exit(1);
}
// La cuenta de sentencias necesita una petición que llegue a la base, y build deja los handlers en TODO: el listado se
// escribe aquí como lo escribiría el agente (es su archivo).
fs.writeFileSync(
  path.join(projectDir, 'src', 'ProductCatalog.Application', 'UseCases', 'ListProductsQueryHandler.cs'),
  `namespace ProductCatalog.Application.UseCases;

using ProductCatalog.Application.Abstractions;
using ProductCatalog.Application.Dtos;
using ProductCatalog.Application.Mappers;
using ProductCatalog.Application.Queries;
using ProductCatalog.Domain.Repository;

public sealed class ListProductsQueryHandler(ProductApplicationMapper productApplicationMapper, IProductRepository productRepository) : IQueryHandler<ListProductsQuery, PagedResponse<ListProductsResponseDto>>
{
    public async Task<PagedResponse<ListProductsResponseDto>> Handle(ListProductsQuery query, CancellationToken cancellationToken)
    {
        var page = await productRepository.List(query.Pageable, cancellationToken);
        return new PagedResponse<ListProductsResponseDto>
        {
            Items = [.. page.Items.Select(productApplicationMapper.ToListProductsResponseDto)],
            Page = page.Number,
            Size = page.Size,
            TotalElements = page.TotalElements,
            TotalPages = page.TotalPages,
        };
    }
}
`
);
if (sabotage === 'statement-count') {
  const registration = path.join(projectDir, 'src', 'ProductCatalog.Infrastructure', 'Persistence', 'PersistenceRegistration.cs');
  const text = fs.readFileSync(registration, 'utf8');
  const wired = 'options.AddInterceptors(new StatementCountInterceptor());';
  if (!text.includes(wired)) {
    console.error('El sabotaje statement-count no se aplica a lo emitido hoy (¿cambió el registro del interceptor?).');
    process.exit(2);
  }
  fs.writeFileSync(registration, text.replace(wired, '_ = options;'));
  console.log('(sabotaje: statement-count)');
}
const compiled = dotnet(projectDir, ['build', 'ProductCatalog.slnx', '-c', 'Debug']);
if (!step('la solución compila (con el proyecto de flujos)', compiled.ok, compiled.ok ? '' : compiled.output.slice(-1500))) process.exit(1);

// ── dotnet test en la raíz NO ejecuta las pruebas de flujo: necesitan infra/ ──
const unit = dotnet(projectDir, ['test', '--no-build']);
step('dotnet test en la raíz pasa sin infraestructura y no ejecuta las pruebas de flujo', unit.ok && !/IntegrationTests/.test(unit.output), unit.ok ? '' : unit.output.slice(-1200));

const flowsDir = path.join(projectDir, 'tests', 'ProductCatalog.IntegrationTests');
const probe = (name, content) => fs.writeFileSync(path.join(flowsDir, `${name}.cs`), content);
const unprobe = (name) => fs.rmSync(path.join(flowsDir, `${name}.cs`), { force: true });
const probeHeader = 'namespace ProductCatalog.IntegrationTests;\n\nusing ProductCatalog.IntegrationTests.Support;\nusing Xunit;\n';

// ── La caja negra: un flujo que nombra un tipo del servicio no compila ──
probe('ProbeImportFlow', `${probeHeader}using ProductCatalog.Domain.Aggregate;\n\npublic sealed class ProbeImportFlow : FlowTest\n{\n    [Scenario("FL-PROBE-009-A: nombra el agregado")]\n    public void NombraElAgregado() => Assert.Equal("Product", nameof(Product));\n}\n`);
const blind = bash(projectDir, 'infra/check-flows.sh');
step('un flujo que nombra un tipo del servicio no compila (caja negra por el compilador)', blind.status === 1 && /ProbeImportFlow/.test(blind.output), `código ${blind.status}`);
unprobe('ProbeImportFlow');

// ── El gate del agente de pruebas: compila SOLO las pruebas de flujo ──
probe('ProbeTypesFlow', `${probeHeader}\npublic sealed class ProbeTypesFlow : FlowTest\n{\n    [Scenario("FL-PROBE-008-A: mal tipada")]\n    public void MalTipada()\n    {\n        int n = "texto";\n        Assert.Equal(1, n);\n    }\n}\n`);
const typesRed = bash(projectDir, 'infra/check-flows.sh');
step('check-flows.sh sale en rojo con una prueba de flujo que no compila', typesRed.status === 1 && /ProbeTypesFlow/.test(typesRed.output), `código ${typesRed.status}`);
unprobe('ProbeTypesFlow');
// Una referencia que deja ver los tipos del servicio es la otra forma de romper la caja negra.
const csproj = path.join(flowsDir, 'ProductCatalog.IntegrationTests.csproj');
const csprojSource = fs.readFileSync(csproj, 'utf8');
fs.writeFileSync(csproj, csprojSource.replace(' ReferenceOutputAssembly="false"', ''));
const visible = bash(projectDir, 'infra/check-flows.sh');
fs.writeFileSync(csproj, csprojSource);
step('check-flows.sh sale en rojo si el proyecto de flujos pasa a ver los tipos del servicio', visible.status === 1 && /Caja negra rota/.test(visible.output), `código ${visible.status}`);
// Un error en src/ (el agente de código a medio trabajo) no es de las pruebas: no las pone en rojo.
const programCs = path.join(projectDir, 'src', 'ProductCatalog.Api', 'Program.cs');
const programSource = fs.readFileSync(programCs, 'utf8');
fs.writeFileSync(programCs, `${programSource}\nclass Roto { int n = "src a medio escribir"; }\n`);
const flowsSrc = bash(projectDir, 'infra/check-flows.sh');
fs.writeFileSync(programCs, programSource);
step('check-flows.sh no se pone rojo por un error en src/', flowsSrc.status === 0, `código ${flowsSrc.status}: ${flowsSrc.output.slice(-400)}`);
const flowsGreen = bash(projectDir, 'infra/check-flows.sh');
step('check-flows.sh en verde sobre el proyecto recién generado', flowsGreen.status === 0, flowsGreen.output.slice(-400));

// ── La infraestructura, con sus propios scripts ──
const up = bash(projectDir, 'infra/up.sh');
if (!step('bash infra/up.sh', up.status === 0, up.status === 0 ? '' : up.output.slice(-1200))) process.exit(1);
try {
  const validate = bash(projectDir, 'infra/validate-infra.sh');
  step('bash infra/validate-infra.sh', validate.status === 0, validate.status === 0 ? '' : validate.output.slice(-1200));

  // Una que pasa, y que además mide el reset contra la base real: vacía los datos y respeta el historial de
  // migraciones (el placeholder {history} del catálogo, sustituido por la plataforma).
  probe(
    'ProbeOkFlow',
    `${probeHeader}
public sealed class ProbeOkFlow : FlowTest
{
    [Scenario("FL-PROBE-001-A: una ruta inexistente responde 404 con ErrorResponse")]
    public async Task RutaInexistente()
    {
        var response = await Get($"{RouteBase}/keel-probe");
        Assert.True(response.Status == 404, response.ToString());
        // Las piezas de aserción del arnés: el JSON estricto con la forma de lo generado.
        AssertJson("""{"timestamp":"<instant>","status":404,"error":"Not Found","code":null,"message":"Recurso no encontrado","details":null,"correlationId":"<uuid>"}""", response);
    }

    [Scenario("FL-PROBE-001-B: el reset vacía los datos y respeta el historial de migraciones")]
    public void ElResetRespetaElHistorial()
    {
        Db("CREATE TABLE IF NOT EXISTS keel_probe (id int)");
        Db("INSERT INTO keel_probe VALUES (1)");
        Db("CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id int)");
        Db("INSERT INTO ${MIGRATIONS_TABLE} VALUES (1)");
        ResetState();
        Assert.Equal("0", Db("SELECT count(*) FROM keel_probe").Trim());
        Assert.Equal("1", Db("SELECT count(*) FROM ${MIGRATIONS_TABLE}").Trim());
        Db("DROP TABLE ${MIGRATIONS_TABLE}");
        Db("DROP TABLE keel_probe");
    }

    // La segunda réplica de los escenarios de clúster: un proceso aparte del mismo Api, contra la misma infra.
    [Scenario("FL-PROBE-001-C: la segunda réplica arranca, responde, se para y el servidor del flujo sigue")]
    public async Task LaReplicaArrancaYSePara()
    {
        try
        {
            var url = await StartReplica();
            Assert.NotEqual(BaseUrl, url);
            Assert.Equal(url, await StartReplica());
            var response = await OnReplica("GET", $"{RouteBase}/keel-probe");
            Assert.True(response.Status == 404, response.ToString());
            Assert.Equal(404, response.Json().GetProperty("status").GetInt32());
        }
        finally
        {
            StopReplica();
        }
        await Assert.ThrowsAsync<InvalidOperationException>(() => OnReplica("GET", $"{RouteBase}/keel-probe"));
        Assert.True((await Get("/livez")).Status == 200);
    }

    // AssertJson compara las cadenas por su VALOR: el escape no es contrato (corrida stock-reservation de keel-dotnet).
    [Scenario("FL-PROBE-001-D: AssertJson compara las cadenas por su valor y no por su escape")]
    public void LasCadenasPorSuValor()
    {
        var literal = new FlowResponse(200, new Dictionary<string, string>(), """{"motivo":"sin respuesta del almacén","importe":2.50}""");
        // El esperado con la é ESCAPADA, como la escribe el codificador por defecto de System.Text.Json.
        AssertJson("""{"motivo":"sin respuesta del almac\\u00e9n","importe":2.50}""", literal);
        Assert.ThrowsAny<Exception>(() => AssertJson("""{"motivo":"sin respuesta del almacen","importe":2.50}""", literal));
        Assert.ThrowsAny<Exception>(() => AssertJson("""{"motivo":"sin respuesta del almacén","importe":2.5}""", literal));
    }

    // El coste de una petición (statement-count.js): la cuenta la lleva el SERVIDOR, que es otro proceso, y el arnés la
    // lee por HTTP. Se mide la segunda ejecución, y la página grande no cuesta más que la pequeña.
    [Scenario("FL-PROBE-001-E: el servidor cuenta las sentencias de una petición y leer la cuenta no cuenta")]
    public async Task ElCosteSeCuenta()
    {
        var route = $"{RouteBase}/products";
        var warm = await Get(route + "?size=2");
        Assert.True(warm.Status == 200, warm.ToString());
        var before = await QueryCount();
        var reads = await QueryExecutions();
        Assert.Equal(before, await QueryCount());
        Assert.True((await Get(route + "?size=2")).Status == 200);
        var small = await QueryCount() - before;
        Assert.True(small > 0, "un listado que lee la base no sumó ninguna sentencia");
        Assert.True(await QueryExecutions() - reads > 0, "las lecturas del listado no cuentan como lecturas");
        before = await QueryCount();
        Assert.True((await Get(route + "?size=100")).Status == 200);
        Assert.True(await QueryCount() - before <= small, "la página grande cuesta más que la pequeña");
    }

    // Un id que el documento no declara: sale AJENO y no puntúa (keel-core/gen/junit-scoring).
    [Scenario("FL-PROBE-099-A: un caso fuera del documento")]
    public void FueraDelDocumento() => Assert.True(true);
}
`
  );
  // Una que falla a propósito: su evidencia tiene que llevar la petición y la respuesta.
  probe(
    'ProbeFailFlow',
    `${probeHeader}
public sealed class ProbeFailFlow : FlowTest
{
    [Scenario("FL-PROBE-002-A: espera un 200 que no llega")]
    public async Task EsperaUn200()
    {
        var response = await Get($"{RouteBase}/keel-probe-rojo");
        Assert.Equal(200, response.Status);
    }
}
`
  );
  // Un flujo que no llega a arrancar: su Given común falla. La base da sus casos por OMITIDOS y deja
  // <Flujo>-init.json.
  probe(
    'ProbeInitFlow',
    `${probeHeader}
public sealed class ProbeInitFlow : FlowTest
{
    protected override Task GivenAsync()
    {
        Db("SELECT * FROM keel_tabla_que_no_existe");
        return Task.CompletedTask;
    }

    [Scenario("FL-PROBE-003-A: no llega a ejecutarse")]
    public void NoLlega() => Assert.True(true);
}
`
  );
  // Los escenarios de un flujo corren en el orden ESCRITO, no en el alfabético ni en el del hash de xUnit.
  probe(
    'ProbeOrderFlow',
    `${probeHeader}
public sealed class ProbeOrderFlow : FlowTest
{
    private static readonly List<string> Ran = [];

    [Scenario("FL-PROBE-005-C: va primero")]
    public void Primero() => Ran.Add("C");

    [Scenario("FL-PROBE-005-A: va segundo")]
    public void Segundo() => Ran.Add("A");

    [Scenario("FL-PROBE-005-B: va tercero y lo comprueba")]
    public void Tercero()
    {
        Ran.Add("B");
        Assert.Equal(["C", "A", "B"], Ran);
    }
}
`
  );

  // Un documento de escenarios con un flujo que ninguna prueba ejercita: tiene que salir NO_EJERC. Sustituye al del
  // diseño, así que su línea sale del sello: specs.sha256 vigila lo que lista, y el documento sonda no lo escribió build.
  fs.writeFileSync(
    path.join(projectDir, 'specs', 'validation-scenarios.md'),
    ['FL-PROBE-001', 'FL-PROBE-002', 'FL-PROBE-003', 'FL-PROBE-004', 'FL-PROBE-005'].map((id) => `#### ${id} — sonda\n`).join('\n')
  );
  const seal = path.join(projectDir, 'specs.sha256');
  if (fs.existsSync(seal)) {
    const kept = fs.readFileSync(seal, 'utf8').split('\n').filter((line) => !line.endsWith('specs/validation-scenarios.md'));
    fs.writeFileSync(seal, kept.join('\n'));
  }

  const evidence = path.join(projectDir, 'build', 'keel-failures');
  const run1 = bash(projectDir, 'infra/score-scenarios.sh');
  const lines = run1.output;
  const has = (pattern) => pattern.test(lines);
  step('score: un escenario en verde sale OK', has(/OK\s+FL-PROBE-001-A/) && has(/OK\s+FL-PROBE-001-B/) && has(/OK\s+FL-PROBE-001-C/) && has(/OK\s+FL-PROBE-001-D/), has(/OK\s+FL-PROBE-001-D/) ? '' : lines.slice(-2500));
  step('score: el coste de una petición se cuenta en el servidor (FL-PROBE-001-E)', has(/OK\s+FL-PROBE-001-E/), has(/FL-PROBE-001-E/) ? '' : 'sin fila FL-PROBE-001-E');
  step('score: los escenarios de un flujo corren en el orden escrito', has(/OK\s+FL-PROBE-005-B/), has(/FL-PROBE-005-B/) ? '' : 'sin fila FL-PROBE-005-B');
  step('score: el que falla sale FALLO con la ruta de su evidencia', has(/FALLO\s+FL-PROBE-002-A\s+ProbeFailFlow\s+build\/keel-failures\/FL-PROBE-002-A\.json/));
  step('score: el flujo que no arranca deja sus casos OMITIDOS', has(/OMITIDO\s+FL-PROBE-003-A/), has(/OMITIDO/) ? '' : 'sin fila OMITIDO');
  step('score: y lo nombra como arnés roto, con su causa', has(/ARNÉS/) && has(/ProbeInitFlow\s+\(arranque del flujo\)/) && has(/keel_tabla_que_no_existe/));
  step('score: un id FL-* que el documento no declara sale AJENO y no puntúa', has(/AJENO\s+FL-PROBE-099-A/) && !has(/^\s+OK\s+FL-PROBE-099-A/m) && new RegExp(`RESULTADO: KO — ${sabotage ? 7 : 8} OK`).test(lines));
  step('score: un flujo del documento sin prueba sale NO_EJERC', has(/NO_EJERC\s+FL-PROBE-004/) && !has(/NO_EJERC\s+FL-PROBE-00[1235]/));
  step('score: con algo que arbitrar sale con 1', run1.status === 1, `código ${run1.status}`);
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(path.join(evidence, 'FL-PROBE-002-A.json'), 'utf8'));
  } catch {
    report = null;
  }
  step(
    'la evidencia del fallo lleva escenario, aserción, petición y respuesta',
    report?.scenario === 'FL-PROBE-002-A' &&
      report.testClass === 'ProbeFailFlow' &&
      /200/.test(report.assertion ?? '') &&
      report.request?.method === 'GET' &&
      report.request?.path?.endsWith('/keel-probe-rojo') &&
      report.response?.status === 404,
    report ? JSON.stringify(report).slice(0, 300) : 'no existe'
  );
  let init = null;
  try {
    init = JSON.parse(fs.readFileSync(path.join(evidence, 'ProbeInitFlow-init.json'), 'utf8'));
  } catch {
    init = null;
  }
  step('el flujo que no arranca deja ProbeInitFlow-init.json con el sondeo que falló', init?.phase === 'init' && /keel_tabla_que_no_existe/.test(init?.probe?.output ?? ''), init ? JSON.stringify(init).slice(0, 300) : 'no existe');
  // El servidor es un proceso aparte: al terminar la suite no puede quedar vivo (en Windows retendría el ejecutable).
  const rebuilt = dotnet(projectDir, ['build', 'src/ProductCatalog.Api', '-c', 'Debug', '--no-incremental']);
  step('el servidor no sobrevive a la suite (el Api se vuelve a compilar)', rebuilt.ok, rebuilt.ok ? '' : rebuilt.output.slice(-800));
  step('el log del servidor queda en build/keel-scenarios/server.log', fs.existsSync(path.join(projectDir, 'build', 'keel-scenarios', 'server.log')));

  // Sin escenarios en FALLO, un flujo que no arranca es el arnés, no algo que arbitrar: sale con 2.
  unprobe('ProbeFailFlow');
  const run2 = bash(projectDir, 'infra/score-scenarios.sh');
  step('score: un flujo que no arranca y ningún FALLO sale con 2', run2.status === 2, `código ${run2.status}`);

  // Todo en verde: sin el documento de escenarios (ni su sello), la matriz limpia sale con 0.
  unprobe('ProbeInitFlow');
  fs.rmSync(path.join(projectDir, 'specs.sha256'), { force: true });
  fs.rmSync(path.join(projectDir, 'specs', 'validation-scenarios.md'), { force: true });
  const run3 = bash(projectDir, 'infra/score-scenarios.sh');
  step('score: todo en verde sale con 0', run3.status === 0 && /RESULTADO: OK/.test(run3.output), `código ${run3.status}: ${run3.output.slice(-600)}`);

  // El baseline de migraciones, como lo produce el pase de calidad: el DDL del modelo para revisarlo, la migración con
  // dotnet ef, y la verificación en vivo sobre bases aparte (la de los flujos no se toca).
  const exported = bash(projectDir, 'infra/export-schema.sh');
  const modelSql = path.join(projectDir, 'build', 'schema', 'model.sql');
  step(
    'export-schema.sh escribe el DDL del modelo sin tocar ninguna base',
    exported.status === 0 && fs.existsSync(modelSql) && /CREATE TABLE products/i.test(fs.readFileSync(modelSql, 'utf8')),
    exported.status === 0 ? '' : exported.output.slice(-1200)
  );
  const empty = bash(projectDir, 'infra/verify-baseline.sh');
  step('verify-baseline.sh sin migraciones sale con 1 y dice cómo crearlas', empty.status === 1 && /dotnet ef migrations add Baseline/.test(empty.output), `código ${empty.status}`);
  const added = dotnet(projectDir, ['ef', 'migrations', 'add', 'Baseline', '--project', 'src/ProductCatalog.Infrastructure', '--output-dir', 'Persistence/Migrations']);
  const verified = added.ok ? bash(projectDir, 'infra/verify-baseline.sh') : { status: null, output: added.output };
  step('con el baseline creado por dotnet ef, verify-baseline.sh sale baseline: OK', verified.status === 0 && /baseline: OK/.test(verified.output), verified.output.slice(-1200));
  // Falsado: una migración editada a mano (sin un índice) no pasa, aunque el snapshot del modelo no haya cambiado.
  const migrationsDir = path.join(projectDir, 'src', 'ProductCatalog.Infrastructure', 'Persistence', 'Migrations');
  const migration = fs.existsSync(migrationsDir) ? fs.readdirSync(migrationsDir).find((name) => /_Baseline\.cs$/.test(name)) : null;
  if (migration) {
    const file = path.join(migrationsDir, migration);
    const original = fs.readFileSync(file, 'utf8');
    // dotnet ef escribe la migración con CRLF en Windows: el salto se casa con \r? opcional.
    const sabotaged = original.replace(/\r?\n\s*migrationBuilder\.CreateIndex\([\s\S]*?\);\r?\n/, '\n');
    fs.writeFileSync(file, sabotaged);
    const edited = bash(projectDir, 'infra/verify-baseline.sh');
    step('verify-baseline.sh sale en rojo con una migración a la que le falta un índice', sabotaged !== original && edited.status === 1 && /baseline: KO/.test(edited.output) && /index/.test(edited.output), `código ${edited.status}`);
    fs.writeFileSync(file, original);
  }
  // Y un cambio del mapeo sin migración tampoco.
  const row = path.join(projectDir, 'src', 'ProductCatalog.Infrastructure', 'Persistence', 'Rows', 'ProductRow.cs');
  const rowSource = fs.readFileSync(row, 'utf8');
  fs.writeFileSync(row, rowSource.replace(/HasMaxLength\((\d+)\)/, (_m, n) => `HasMaxLength(${Number(n) + 1})`));
  const pending = bash(projectDir, 'infra/verify-baseline.sh');
  fs.writeFileSync(row, rowSource);
  step('verify-baseline.sh sale en rojo con un cambio del mapeo sin migración', pending.status === 1 && /cambios que ninguna migración recoge/.test(pending.output), `código ${pending.status}`);

  // Una solución que no compila no se puntúa: sale con 2 diciéndolo.
  fs.writeFileSync(programCs, `${programSource}\nclass Roto { int n = "src a medio escribir"; }\n`);
  const run4 = bash(projectDir, 'infra/score-scenarios.sh');
  fs.writeFileSync(programCs, programSource);
  step('score: con la solución sin compilar sale con 2 y lo dice', run4.status === 2 && /BUILD: KO/.test(run4.output), `código ${run4.status}`);

  // Un snapshot editado desde el proyecto no se puntúa.
  fs.writeFileSync(path.join(projectDir, 'specs.sha256'), `${'0'.repeat(64)}  specs/service.keel.yaml\n`);
  const run5 = bash(projectDir, 'infra/score-scenarios.sh');
  step('score: un specs/ que no casa con su sello sale con 2 sin ejecutar nada', run5.status === 2 && /DISEÑO/.test(run5.output), `código ${run5.status}`);
} finally {
  const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
  step('bash infra/down.sh --volumes', down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
}

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-dotnet-harness-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\nharness-check: ${results.length}/${results.length} en verde.` : `\nharness-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
