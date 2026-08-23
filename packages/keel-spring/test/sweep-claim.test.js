// El gate del reclamo de un barrido, y DÓNDE puede exigirlo.
//
// `@Scheduled` corre en todas las réplicas, así que un barrido que se lleva su lote con un finder
// se lo lleva N veces. Eso es lo que la familia `sweepClaim` caza, y cuando build pudo generar el
// reclamo la exigencia es local y exacta: que el handler llame al método del puerto.
//
// Cuando NO pudo —el barrido solo rescata filas en vuelo, y su cota temporal vive en la prosa de
// `rules`— exigirlo en ese archivo pide una forma que el propio generador no supo escribir, y
// declara además dónde tiene que vivir el reclamo. En una corrida real el diseño decía «el ciclo
// invoca sendQueuedMessage con su identificador»: el reclamo atómico estaba en el handler de la
// otra operación, que es donde le toca, y el gate cantó KO sobre el código correcto. Un check que
// exige la implementación incorrecta es peor que no tenerlo — su camino de menor resistencia es
// romper el código para callarlo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SWEEP = 'rescueStuckReservations';

/**
 * `stock-reservation` con un barrido que solo rescata filas EN VUELO (`awaitingStock` se alcanza
 * desde `pending`), que es el caso en el que build avisa y no genera reclamo.
 */
function generate() {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, 'stock-reservation'));
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patched['use-cases'].operations[SWEEP] = {
    description: 'Rescata las reservas que llevan demasiado tiempo esperando al almacén.',
    kind: 'command',
    internal: true,
    input: 'void',
    output: 'void',
    schedule: { cron: '* * * * *' },
    transitions: [{ entity: 'Reservation', from: ['awaitingStock'], to: 'released' }],
    rules: ['Se rescatan las reservas cuyo reserveStockAwaitingSince lleva más de 30 minutos.']
  };

  const workspace = tmpDir('keel-sweep-claim-');
  const result = scaffoldService({ manifest, layers: patched, workspace, force: true });
  const root = path.join(workspace, result.outDir);
  return fs.readFileSync(path.join(root, 'infra', 'check-idempotency.sh'), 'utf8');
}

test('sin reclamo generado, el gate lo busca en TODO el árbol y no en el handler del barrido', () => {
  const gate = generate();
  const row = gate.split('\n').find((line) => line.includes('sweepClaim') && line.includes(SWEEP));

  assert.ok(row, `no se emitió ningún check de sweepClaim para ${SWEEP}`);
  // `claim` es la comprobación de dos patrones en el MISMO archivo, buscado por contenido en todo
  // el árbol; `unit` es la que se ancla a un nombre de clase.
  assert.ok(row.startsWith('claim '), 'ancla el reclamo al handler del barrido');
  // Nombrar el handler en el PORQUÉ es ayuda; anclarlo sería decidir por el diseño dónde vive el
  // reclamo. La fila `claim` no lleva campo de clase: por eso esto es lo uno y no lo otro.
  // Lo que ata el hallazgo a ESTE barrido y no a cualquier escritura condicional del proyecto.
  assert.ok(row.includes('Reservation'), 'no ata el reclamo al agregado que se barre');
});

test('y el porqué dice que puede vivir en la operación a la que el diseño delega', () => {
  // El mensaje es lo único que el agente lee cuando esto sale KO: si dice «en este archivo»,
  // arreglarlo correctamente parece incumplirlo.
  const gate = generate();
  assert.match(gate, /le delega el trabajo por elemento/);
});

test('con reclamo generado la exigencia sigue siendo local y exacta', () => {
  // La simétrica: donde build SÍ generó el reclamo —el barrido saca filas de una cola— pedir que
  // se llame a ese método y prohibir el finder es afirmable y es el fallo original de la familia.
  const { manifest, layers } = loadService(path.join(fixturesDir, 'stock-reservation'));
  const workspace = tmpDir('keel-sweep-claim-ok-');
  const result = scaffoldService({ manifest, layers, workspace, force: true });
  const gate = fs.readFileSync(path.join(workspace, result.outDir, 'infra', 'check-idempotency.sh'), 'utf8');

  const rows = gate.split('\n').filter((line) => line.includes('sweepClaim'));
  const local = rows.filter((line) => line.startsWith('unit '));
  for (const row of local) {
    assert.match(row, /claimFor/, 'no exige el método que build puso en el puerto');
    assert.match(row, /find\(All\)\?By/, 'dejó de prohibir la lectura simple del estado de partida');
  }
});

test('el script sigue siendo bash válido', () => {
  // La matriz se emite por plantilla: una fila mal escapada no la ve ningún includes().
  const gate = generate();
  const file = path.join(tmpDir('keel-sweep-claim-sh-'), 'check-idempotency.sh');
  fs.writeFileSync(file, gate);
  execFileSync('bash', ['-n', file]);
});
