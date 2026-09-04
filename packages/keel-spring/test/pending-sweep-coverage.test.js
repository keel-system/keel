// El barrido cuyo reclamo build NO puede generar, con un sujeto de verdad.
//
// Esa rama existe desde hace tiempo —`unclaimedSweeps` en `claim.js`, la mitad «pendiente» de
// `sweepClaimChecks`— y hasta ahora se probaba SIEMPRE inyectando una operación a mano sobre un
// modelo cargado. Lo que el gate dice sobre un proyecto generado de verdad no lo había mirado
// nadie, y cuando se miró apareció esto: el check del barrido pendiente salía VERDE sobre el
// árbol recién generado, satisfecho por el `@Modifying` que build había generado para el OTRO
// barrido del mismo diseño. Es decir, el único gate del mecanismo con menos red del generador
// aprobaba un proyecto en el que ese mecanismo no existía.
//
// Este archivo fija las dos mitades: que la fixture siga teniendo la forma que lo destapa, y que
// el gate siga cazándolo. La segunda EJECUTA el script con bash: un `includes(...)` sobre la
// matriz no distingue un check correcto de uno que nunca se dispara.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE = 'payout-runs';
const RECLAMABLE = 'sendPayouts';
const PENDIENTE = 'closePayoutRuns';

function load() {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, FIXTURE));
  assert.deepEqual(errors, [], `la fixture ${FIXTURE} no carga`);
  return { manifest, layers };
}

function sweepsOf() {
  const { manifest, layers } = load();
  const model = buildModel({ manifest, layers, stack: { database: 'postgresql' } });
  const byName = new Map(
    model.services
      .flatMap((service) => service.operations)
      .filter((operation) => operation.sweep)
      .map((operation) => [operation.name, operation])
  );
  return { model, byName };
}

// ── La forma del diseño, que es lo que hace útil a la fixture ────────────────

test('la fixture declara DOS barridos: uno que build reclama y otro que no', () => {
  const { byName } = sweepsOf();

  const reclamable = byName.get(RECLAMABLE);
  assert.ok(reclamable, `desapareció el barrido reclamable ${RECLAMABLE}`);
  assert.ok((reclamable.claim ?? []).length > 0, 'el barrido reclamable dejó de tener reclamo generado');

  const pendiente = byName.get(PENDIENTE);
  assert.ok(pendiente, `desapareció el barrido pendiente ${PENDIENTE}`);
  assert.equal(pendiente.sweep, true, 'dejó de estar marcado como barrido');
  assert.deepEqual(pendiente.claim ?? [], [], 'build le generó reclamo: la fixture perdió lo que vino a cubrir');
});

test('y es pendiente por DOS estados en vuelo, no por un reloj que falta', () => {
  // La distinción importa para que el sujeto no se evapore: un rescate sin reloj es un diseño
  // con un defecto ARREGLABLE, y el primero que pase por aquí añadirá el campo «para
  // arreglarlo». Dos estados en vuelo es un diseño legítimo que build genuinamente no puede
  // servir —son dos relojes, y «lleva demasiado» deja de estar definido para el lote—, así que
  // nadie lo va a tocar.
  const { model, byName } = sweepsOf();
  const transiciones = byName.get(PENDIENTE).transitions ?? [];
  assert.equal(transiciones.length, 1);
  assert.deepEqual(transiciones[0].from, ['sending', 'retrying']);

  // Y los dos relojes existen en la entidad: sin ellos el motivo del aviso sería otro.
  const payout = model.entities.find((entity) => entity.name === 'Payout');
  for (const reloj of ['sendingSince', 'retryingSince']) {
    assert.ok(payout.fields.some((field) => field.name === reloj), `la entidad perdió ${reloj}`);
  }

  const aviso = model.warnings.find((warning) => warning.includes(PENDIENTE) && warning.includes('EN VUELO'));
  assert.ok(aviso, 'build dejó de avisar de que no puede generar ese reclamo');
  assert.match(aviso, /dos estados en vuelo/);
});

// ── El gate, ejecutado ───────────────────────────────────────────────────────

function generate() {
  const { manifest, layers } = load();
  const workspace = tmpDir('keel-pending-sweep-');
  const result = scaffoldService({ manifest, layers, workspace, force: true });
  return path.join(workspace, result.outDir);
}

/** Ejecuta el gate y devuelve su salida. Sin bash (raro fuera de Windows), el test se salta. */
function runGate(project) {
  try {
    return execFileSync('bash', ['infra/check-idempotency.sh'], { cwd: project, encoding: 'utf8' });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

const reports = (out, subject) =>
  out.split(/\r?\n/).some((line) => /^\s*\[[a-zA-Z]+\]/.test(line) && line.split(':')[0].includes(subject));

test('el gate reporta el barrido PENDIENTE sobre el árbol recién generado', () => {
  // Este es el test que no existía, y el que salía en verde por el motivo equivocado. El árbol
  // recién generado es el caso extremo: el agente no ha escrito NADA, así que el reclamo del
  // barrido pendiente no existe en ninguna parte y el gate tiene que decirlo.
  const out = runGate(generate());
  if (out === null) return; // sin bash
  assert.ok(reports(out, PENDIENTE), `el gate no reporta ${PENDIENTE}:\n${out}`);
  // Y el reclamable también, por su propia razón (su handler todavía no llama al método). Las
  // dos mitades de la familia sobre el mismo proyecto.
  assert.ok(reports(out, RECLAMABLE), `el gate no reporta ${RECLAMABLE}:\n${out}`);
});

test('el reclamo que build generó para el otro barrido no aprueba al pendiente', () => {
  // La mutación, hecha test: sin `deny`, el bloque de `claimForSendPayouts` —que vive en el
  // repositorio del MISMO agregado, así que casa con el `bound`— satisface por su cuenta el
  // check del barrido que hay que escribir a mano, y el gate deja de reportarlo. Medido: con
  // `deny` el gate da 2 hallazgos, sin él da 1.
  const project = generate();
  const gate = fs.readFileSync(path.join(project, 'infra', 'check-idempotency.sh'), 'utf8');
  const fila = gate
    .split(/\r?\n/)
    .find((line) => line.startsWith('claim ') && line.includes('sweepClaim') && line.includes(PENDIENTE));
  assert.ok(fila, 'el barrido pendiente dejó de emitir su check de tipo claim');

  // El bloque, no el archivo: el reclamo del agente cabe en ese mismo adaptador, y excluirlo
  // entero sería pedirle la implementación incorrecta.
  assert.ok(fila.includes("'method'"), 'el check dejó de mirar el bloque del método');
  assert.ok(fila.includes('claimForSendPayouts'), 'el deny no descarta el reclamo que build generó');
});

test('los patrones del check pendiente no usan escapes que awk no entiende', () => {
  // `scope: method` mete estos patrones en awk (methodBody recorta el bloque con ellos), y allí
  // `\s` o `\(` dejan una regexp desbalanceada que ABORTA el check — un hallazgo falso que se
  // lee igual que uno real. El patrón de esta familia los tenía, y era inofensivo solo porque
  // el check no llevaba `scope`.
  const gate = fs.readFileSync(path.join(generate(), 'infra', 'check-idempotency.sh'), 'utf8');
  const filas = gate.split(/\r?\n/).filter((line) => line.startsWith('claim ') && line.includes('sweepClaim'));
  assert.ok(filas.length > 0, 'no hay checks claim de sweepClaim que revisar');
  for (const fila of filas) {
    for (const patron of (fila.match(/'[^']*'/g) ?? []).slice(2, 4)) {
      assert.ok(!/\\[sdwSDW.(){}]/.test(patron), `patrón que awk no soporta: ${patron}`);
    }
  }
});
