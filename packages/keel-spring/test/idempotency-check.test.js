import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

// El gate determinista del tramo que no está garantizado por construcción. Su
// propiedad central no es que exista: es que salga ROJO sobre un proyecto recién
// generado. Un script que sale verde sobre un árbol en el que el agente aún no ha
// escrito nada no distingue «correcto» de «no mira» — el mismo razonamiento por el
// que java-syntax.test.js se autocomprueba con Java roto a propósito.

const fixture = (name) => path.join(process.cwd(), 'test', 'fixtures', name);

function build(name) {
  const service = loadService(fixture(name));
  const workspace = tmpDir('keel-idem-check-');
  const result = scaffoldService({
    manifest: service.manifest,
    layers: service.layers,
    workspace,
    force: true
  });
  return path.join(workspace, result.outDir);
}

const script = (project) => path.join(project, 'infra', 'check-idempotency.sh');
const read = (project) => fs.readFileSync(script(project), 'utf8');

/** Ejecuta el script y devuelve { code, out }. Requiere bash (Git Bash en Windows). */
function run(project) {
  try {
    const out = execFileSync('bash', ['infra/check-idempotency.sh'], {
      cwd: project,
      encoding: 'utf8'
    });
    return { code: 0, out };
  } catch (error) {
    if (error.code === 'ENOENT') return null; // sin bash: el test se salta solo
    return { code: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test('un diseño con las cinco familias genera el script con las cinco', () => {
  const project = build('catalog-extended');
  const content = read(project);

  for (const group of ['dedupe', 'commandIdempotency', 'compensation', 'reconciliation', 'outboxDelivery']) {
    assert.ok(content.includes(`${group}_ko=0`), `falta la familia ${group}`);
  }
});

test('el orden del guard sale del diseño, no del agente', () => {
  const content = read(build('catalog-extended'));

  // reactivateWithdrawnProduct declara transitions → procesar y luego registrar,
  // y `tryRecord` pasa a estar PROHIBIDO ahí: es el cruce que pierde mensajes.
  const withdrawal = content.split('\n').find((line) => line.startsWith("unit 'dedupe' 'WithdrawalRejected'"));
  assert.ok(withdrawal, 'no hay fila de dedupe para WithdrawalRejected');
  assert.ok(withdrawal.includes('\\.record\\s*\\('), withdrawal);
  assert.match(content, /declara transitions: alreadyProcessed/);
  // projectSupplierPrice no las declara → reclamar antes, al precio de perder el
  // mensaje si el handler falla. El cruzado es el error caro, y va en `forbid`.
  assert.match(content, /no declara transitions: tryRecord/);
});

test('sin nada de esta familia no se genera script: un gate que siempre pasa no mira', () => {
  const project = build('metering-digest');
  const service = loadService(fixture('metering-digest'));
  const declara =
    Boolean(service.layers.messaging?.subscriptions) ||
    Object.values(service.layers['use-cases']?.operations ?? {}).some((op) => op.idempotency);
  if (declara) return; // la fixture sí declara algo: este caso no aplica
  assert.ok(!fs.existsSync(script(project)));
});

test('recién generado sale ROJO, y cada hallazgo señala trabajo que el agente aún no ha hecho', (t) => {
  const project = build('catalog-extended');
  const result = run(project);
  if (result === null) return t.skip('sin bash en el PATH');

  assert.equal(result.code, 1, result.out);
  // El listener lo escribe el agente con la skill de su broker: aquí no existe.
  assert.match(result.out, /WithdrawalRejectedListener\.java/);
  // El @Scheduled que build deja lanzando cuando el mensaje lleva argumentos.
  assert.match(result.out, /\[reconciliation\]/);
  // Y el fallback del outbox, que marca como publicadas filas que nunca salieron.
  assert.match(result.out, /solo está el fallback OutboxDispatcherFallbackConfig/);
});

test('lo que build sí genera no se reporta: el store está inyectado y no sale como ausente', (t) => {
  const project = build('catalog-extended');
  const result = run(project);
  if (result === null) return t.skip('sin bash en el PATH');

  // `IdempotencyStore` lo inyecta build en el handler, así que ese patrón pasa; lo
  // que falta es `CommandSignature.of(...)`, que es la parte que escribe el agente.
  assert.ok(!/falta 'IdempotencyStore'/.test(result.out), result.out);
  assert.match(result.out, /falta 'CommandSignature/);
});

test('los comentarios no cuentan como código: el TODO que se caza es el vivo', (t) => {
  const project = build('catalog-extended');
  const handler = execFileSync(
    'bash',
    ['-c', "find src/main/java -name 'ReactivateWithdrawnProductCommandHandler.java' | head -n 1"],
    { cwd: project, encoding: 'utf8' }
  ).trim();
  if (!handler) return t.skip('sin bash en el PATH');

  // Se sustituye el cuerpo del stub por una implementación de mentira que conserva
  // el javadoc de build (que menciona TODO en prosa). El script tiene que callarse.
  const original = fs.readFileSync(path.join(project, handler), 'utf8');
  const implementado = original
    .replace(/\/\/ TODO \(agente\):[^\n]*\n/g, '')
    .replace(/throw new UnsupportedOperationException\([^;]*\);/g, 'product.reactivate();');
  fs.writeFileSync(path.join(project, handler), implementado);

  const result = run(project);
  if (result === null) return t.skip('sin bash en el PATH');
  assert.ok(!/\[compensation\]/.test(result.out), result.out);
});
