// Un `initializationError` no puede enterrar los escenarios que SÍ hay que arbitrar.
//
// `score-scenarios.sh` reparte el trabajo por su código de salida: `1` va a
// `keel-spring-validate` (hay fallos que arbitrar) y `2` vuelve al agente de pruebas (arnés
// roto, no consume ciclo). La rama de no-escenarios salía con `2` SIEMPRE, sin mirar si además
// había `FL-*` en FALLO — y en la corrida de notifications del 23/08/2026 eso enterró 15
// escenarios en rojo detrás de 4 clases muertas en `@BeforeAll`: la corrida no llegó nunca al
// nodo que arbitra y se relanzó al agente de pruebas, que no puede leer `src/main/java`.
//
// Se prueba EJECUTANDO el bloque de decisión con bash, no comparando cadenas: un `includes`
// no distingue `exit 2` de `exit 2` bajo la condición correcta. Misma regla que
// `keycloak-script-runs.test.js` y `score-non-scenario-message.test.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function scoreScript() {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, 'stock-reservation'));
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-score-exit-');
  scaffoldService({ manifest, layers, workspace, force: true });
  return fs.readFileSync(
    path.join(workspace, 'services', 'stock-reservation-spring', 'infra', 'score-scenarios.sh'),
    'utf8'
  );
}

/**
 * Ejecuta el bloque final de decisión DEL SCRIPT GENERADO con los recuentos ya calculados.
 * Se extrae en vez de correr el script entero porque el script arranca Gradle; lo que se mide
 * aquí es la regla de salida, y es texto suyo, sin copiar.
 */
function decide({ ok, ko, sk, nc, broken }) {
  const script = scoreScript();
  const start = script.indexOf('echo "RESULTADO: KO — $ok OK ·');
  assert.notEqual(start, -1, 'el script generado ya no tiene el desenlace KO reconocible');
  const block = script.slice(start);
  assert.ok(block.trimEnd().endsWith('exit 1'), `el bloque no acaba en exit 1:\n${block}`);

  const dir = tmpDir('keel-score-exit-run-');
  const runner = path.join(dir, 'run.sh');
  fs.writeFileSync(
    runner,
    ['set -u', `ok=${ok}`, `ko=${ko}`, `sk=${sk}`, `nc=${nc}`,
      'EVIDENCE=build/keel-failures', 'LOG=build/keel-scenarios/run.log',
      `broken=${JSON.stringify(broken)}`, block].join('\n')
  );

  const result = spawnSync('bash', [runner], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout };
}

const BROKEN = '    initializationError  (MessageListingFlowIT)\n      Se esperaban 1 correo(s) y llegaron 0 en 75 s';

test('clases muertas y NINGÚN escenario en FALLO → 2: no hay nada que arbitrar', () => {
  const { code, out } = decide({ ok: 4, ko: 0, sk: 0, nc: 6, broken: BROKEN });
  assert.equal(code, 2, `debía salir 2 (arnés roto):\n${out}`);
  assert.match(out, /ARNÉS/);
});

test('clases muertas PERO con escenarios en FALLO → 1: eso se arbitra', () => {
  // La regresión concreta. Con 15 FL-* en rojo, salir con 2 devuelve la corrida a quien no
  // puede arreglarla y el pipeline no converge.
  const { code, out } = decide({ ok: 20, ko: 15, sk: 0, nc: 6, broken: BROKEN });
  assert.equal(code, 1, `debía salir 1 (hay fallos que arbitrar):\n${out}`);
  assert.match(out, /ARNÉS/, 'la causa del initializationError sigue teniendo que salir por stdout');
  // Y el orquestador tiene que leer que arreglar el @BeforeAll no pone verdes los FL-*.
  assert.match(out, /NO los pone en verde/i, `falta la advertencia de atribución:\n${out}`);
});

test('sin clases muertas y con escenarios en FALLO → 1', () => {
  const { code } = decide({ ok: 20, ko: 15, sk: 0, nc: 0, broken: '' });
  assert.equal(code, 1);
});

test('AUTOCOMPROBACIÓN: la condición está escrita sobre $ko, no sobre $broken a secas', () => {
  // Sin esto solo se demuestra que el script de hoy pasa, no que mañana no se pueda volver al
  // `exit 2` incondicional.
  const script = scoreScript();
  assert.match(
    script,
    /if \[ "\$ko" -eq 0 \]; then\n\s+echo[\s\S]{0,400}?exit 2/,
    'el exit 2 de la rama de no-escenarios ya no está condicionado a que no haya FL-* en FALLO'
  );
});
