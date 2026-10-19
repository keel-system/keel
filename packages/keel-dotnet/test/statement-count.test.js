// El coste de una petición (src/scaffold/statement-count.js): el queryCount() de keel-spring y keel-nest, contado por el
// SERVIDOR porque el arnés de keel-dotnet es caja negra. Aquí, la forma de lo emitido; lo EJECUTA harness-check
// (FL-PROBE-001-E, falsado con --sabotage=statement-count).

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture } from './helpers/workspace.js';

const fileOf = (files, suffix) => files.find((file) => file.path.endsWith(suffix));

test('con API y persistencia relacional: el contador, su ruta, el arranque del arnés y los dos helpers', async () => {
  const { files } = await planFixture('product-catalog');
  const counter = fileOf(files, 'Persistence/StatementCount.cs');
  assert.ok(counter, 'no se emitió StatementCount.cs');
  assert.match(counter.content, /Environment\.GetEnvironmentVariable\(Variable\) == "on"/);
  assert.match(counter.content, /class StatementCountInterceptor : DbCommandInterceptor/);
  // Fuera de una petición no cuenta: el relay, las purgas y los barridos.
  assert.ok(counter.content.includes('if (!InRequest.Value || TransactionControl().IsMatch(command.CommandText))'));

  const registration = fileOf(files, 'Persistence/PersistenceRegistration.cs');
  assert.match(registration.content, /if \(StatementCount\.Enabled\)\s*\{\s*options\.AddInterceptors\(new StatementCountInterceptor\(\)\);/);

  // El middleware va delante de la correlación y de la seguridad, y solo con el arnés.
  const program = fileOf(files, 'Api/Program.cs');
  const gated = program.content.indexOf('if (StatementCount.Enabled)');
  assert.ok(gated > 0 && gated < program.content.indexOf('app.UseMiddleware<CorrelationMiddleware>();'), 'el middleware no va delante de la correlación');
  assert.ok(fileOf(files, 'Rest/StatementCountMiddleware.cs').content.includes('public const string Path = "/__keel/statements";'));

  const server = fileOf(files, 'Support/FlowServer.cs');
  assert.ok(server.content.includes('start.Environment["KEEL_FLOW_STATEMENTS"] = "on";'), 'el arnés no enciende el contador');
  const flow = fileOf(files, 'Support/FlowTest.cs');
  assert.ok(flow.content.includes('protected static Task<long> QueryCount() => Harness.StatementsAsync("statements"'));
  assert.ok(flow.content.includes('protected static Task<long> QueryExecutions() => Harness.StatementsAsync("reads"'));
  assert.ok(fileOf(files, 'Support/Harness.cs').content.includes('public static async Task<long> StatementsAsync('));
  assert.ok(files.some((file) => file.content?.includes?.('SMOKE-7: el servidor cuenta las sentencias de las peticiones')), 'el humo no lee la cuenta');
});

test('sin persistencia relacional no hay contador: ni sobre documentos ni en el arranque del arnés', async () => {
  const { files } = await planFixture('notification-mailer-mongo');
  assert.ok(!files.some((file) => file.path.endsWith('StatementCount.cs') || file.path.endsWith('StatementCountMiddleware.cs')));
  assert.ok(!fileOf(files, 'Api/Program.cs').content.includes('StatementCount'));
  assert.ok(!fileOf(files, 'Support/FlowServer.cs').content.includes('KEEL_FLOW_STATEMENTS'));
  assert.ok(!fileOf(files, 'Support/FlowTest.cs').content.includes('QueryCount'));
});
