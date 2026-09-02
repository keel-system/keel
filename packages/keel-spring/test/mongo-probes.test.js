// Que el arnés hable mongosh POR `mongo-probes.js` y no por su cuenta.
//
// Este archivo no juzga si los scripts son correctos —eso solo lo puede decir `mongo-check`
// contra un Mongo de verdad, y esa es la razón de que exista—. Lo que ata es la otra mitad:
// que lo que el generador emite y lo que el runner ejercita sean **el mismo texto**. Con dos
// definiciones, el runner comprobaría que Mongo responde, que no es lo mismo que comprobar
// que el generador acierta.
//
// Y hay un motivo por el que esta vigilancia es más necesaria aquí que en los otros ejes: con
// un script de mongosh **javac no es red**. `javaString()` escapa siempre, así que un
// predicado que no case sale como Java perfectamente válido y `compile-check` pasa en verde.
// Comprobado rompiéndolo a propósito.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import {
  OUTBOX,
  CLOCK,
  fill,
  setStateScript,
  missingClockCountScript,
  outboxPendingScript,
  abandonOutboxScript,
  clearAbandonedScript
} from '../src/lib/mongo-probes.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** El `AbstractFlowIT.java` de una fixture documental. */
function harnessOf(fixture) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-mongo-probes-');
  const result = scaffoldService({ manifest, layers, workspace, force: true });
  const root = path.join(workspace, result.outDir);
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  const file = walk(root).find((f) => f.endsWith('AbstractFlowIT.java'));
  assert.ok(file, `${fixture} no generó AbstractFlowIT`);
  return fs.readFileSync(file, 'utf8');
}

/**
 * Cómo se ve un script del módulo DENTRO del literal Java: las comillas escapadas una vez, que
 * es exactamente lo que hace `javaString()`. Escribirlo aquí y no reusar `javaString` es
 * deliberado — si el escapado cambiara, esto tiene que romperse.
 */
const enJava = (script) => script.replaceAll('"', String.raw`\"`);

test('el rescate mueve el estado con el script del módulo, y con sus DOS relojes', () => {
  const harness = harnessOf('job-dispatch-mongo');
  const jobs = { collection: 'jobs', stateField: 'status', state: 'RUNNING', clockField: 'running_since' };

  for (const clock of [CLOCK.stale, CLOCK.now]) {
    const { prefix, suffix } = setStateScript({ ...jobs, clock });
    assert.ok(harness.includes(enJava(prefix)), `el arnés no emite el prefijo del módulo con ${clock}`);
    assert.ok(harness.includes(enJava(suffix)), `el arnés no emite el sufijo del módulo con ${clock}`);
  }

  // Los dos relojes tienen que ser distintos, o `putInFlight` y `stallInFlight` serían el
  // mismo helper y la cota temporal del rescate dejaría de probarse.
  assert.notEqual(CLOCK.stale, CLOCK.now);
});

test('y cuenta las que quedaron sin reloj con el predicado del módulo', () => {
  const harness = harnessOf('job-dispatch-mongo');
  const script = missingClockCountScript({
    collection: 'jobs',
    stateField: 'status',
    state: 'RUNNING',
    clockField: 'running_since'
  });
  assert.ok(harness.includes(enJava(script)), harness);
});

test('el outbox cuenta lo pendiente y abandona por los scripts del módulo', () => {
  const harness = harnessOf('asset-vault');

  const pending = outboxPendingScript();
  assert.ok(harness.includes(enJava(pending.prefix)), 'el conteo del pendiente no sale del módulo');
  assert.ok(harness.includes(enJava(pending.suffix)), 'el conteo del pendiente no sale del módulo');

  // El presupuesto agotado va MUY por encima de cualquier `max-attempts` a propósito: el
  // arnés no lee el parámetro para no quedar atado al perfil con el que corre.
  const attempts = Number(harness.match(/attempts: (\d+) \} \}/)?.[1]);
  assert.ok(attempts > 1000, `presupuesto de abandono sospechosamente bajo: ${attempts}`);

  const abandon = abandonOutboxScript(attempts);
  assert.ok(harness.includes(enJava(abandon.prefix)), 'abandonar no sale del módulo');
  assert.ok(harness.includes(enJava(abandon.suffix)), 'abandonar no sale del módulo');
  assert.ok(harness.includes(enJava(clearAbandonedScript(attempts))), 'limpiar no sale del módulo');
});

test('ningún script de mongosh del ARNÉS se escribe a mano', () => {
  // La regla, mecanizada donde aplica: un literal `db.getCollection(` dentro del arnés es un
  // script que `mongo-check` no ejercita, y por tanto uno que nadie juzga —ni las cadenas, ni
  // java-syntax, ni javac—.
  //
  // Dos cosas quedan fuera a propósito, y las dos por el mismo criterio (¿lo ejecuta el
  // arnés?):
  //
  //   · el javadoc de `db` y `mongoEval`, que ENSEÑA la forma y no la ejecuta — y su ejemplo
  //     tiene que llevar comillas, porque distinguirlas es justo su motivo de existir;
  //   · `export-indexes.sh` (document-indexes.js), que no es del arnés sino del agente de
  //     calidad, y tiene su propia verificación EN VIVO dentro del pipeline: lo ejecuta contra
  //     la base real y reporta `indexesTested`, que nunca sale PENDING.
  const harnessFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'scaffold', 'integration-tests.js');
  const content = fs.readFileSync(harnessFile, 'utf8');

  const offenders = [];
  for (const [index, line] of content.split(String.fromCharCode(10)).entries()) {
    if (!line.includes('db.getCollection(')) continue;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    // El ejemplo del javadoc: se reconoce porque nombra el marcador de posición, no una
    // colección del diseño.
    if (line.includes('la_coleccion')) continue;
    offenders.push(`integration-tests.js:${index + 1}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [], 'hay scripts de mongosh del arnés fuera de mongo-probes.js');
});

test('fill compone las dos mitades como lo hace el Java en ejecución', () => {
  assert.equal(fill({ prefix: 'a(', suffix: ')b' }, 'X'), 'a(X)b');
  // Y el nombre de la colección del outbox es el mismo que escribe el generador.
  assert.equal(OUTBOX.collection, 'outbox_event');
});
