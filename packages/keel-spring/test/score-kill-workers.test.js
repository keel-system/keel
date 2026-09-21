// Un worker de Gradle que sobrevive a la corrida envenena la SIGUIENTE.
//
// Los "Gradle Test Executor" son JVMs aparte del daemon: no caen con `./gradlew --stop` y
// `jps` no los lista. Cuando la corrida se interrumpe —un timeout de la herramienta que la
// lanzó— siguen vivos sosteniendo el lock de
// build/test-results/integrationTest/binary/output.bin, y la invocación siguiente muere al
// limpiar los resultados. El síntoma no aparece donde está la causa, que es lo que lo hizo
// costar seis corridas abortadas; y el remedio que el propio script imprimía —`jps -l | grep
// -i gradle`— no encuentra nada, porque jps no los ve.
//
// Lo único que los identifica es `-Dorg.gradle.internal.worker.tmpdir=<build de ESTE
// proyecto>` en su línea de comando, y de ahí sale también el alcance del arreglo: se
// terminan los de este directorio y solo esos.
//
// Se prueba EJECUTANDO las funciones del script generado con bash, con un `ps` de mentira y
// un `kill` que anota a quién mataron. Comparar cadenas no distingue un filtro correcto de
// uno que no casa con nada: los dos contienen el literal `worker.tmpdir`.

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
  const workspace = tmpDir('keel-kill-workers-');
  scaffoldService({ manifest, layers, workspace, force: true });
  return fs.readFileSync(
    path.join(workspace, 'services', 'stock-reservation-spring', 'infra', 'score-scenarios.sh'),
    'utf8'
  );
}

/** Extrae un bloque del script generado por sus delimitadores de texto. Nada se copia. */
function slice(script, from, to) {
  const start = script.indexOf(from);
  assert.notEqual(start, -1, `el script ya no contiene: ${from}`);
  const end = script.indexOf(to, start);
  assert.notEqual(end, -1, `el script ya no contiene: ${to}`);
  return script.slice(start, end);
}

// `C:/Users/...` no vale dentro de un PATH: los dos puntos SON el separador, así que el stub
// no se encontraría y se ejercitaría el `ps` de verdad — verde por no haber mirado nada.
const posix = (p) => p.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

/**
 * Ejecuta `kill_workers` del script generado contra una tabla de procesos fabricada.
 *
 * `enable -n kill` es imprescindible: `kill` es un builtin de bash y un stub en el PATH no lo
 * sombrea. Sin eso el test mataría procesos de verdad (o, más probable, nada) y saldría verde
 * sin haber observado ninguna decisión.
 */
function matar({ procesos, projectDir, conPs = true }) {
  const script = scoreScript();
  const funciones = slice(script, 'project_path_forms() {', 'trap kill_workers EXIT');

  const dir = tmpDir('keel-kill-workers-run-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const matados = path.join(dir, 'matados.txt');

  // El stub de `ps` se escribe SIEMPRE, también en el caso «no se pudo listar»: sin él ahí se
  // ejercitaría el `ps` real, que devuelve procesos de verdad y el caso saldría verde sin
  // haber observado la rama que dice medir.
  fs.writeFileSync(
    path.join(bin, 'ps'),
    conPs
      ? `#!/usr/bin/env bash\ncat <<'TABLA'\n${procesos}\nTABLA\n`
      : '#!/usr/bin/env bash\nexit 1\n'
  );
  fs.chmodSync(path.join(bin, 'ps'), 0o755);
  fs.writeFileSync(
    path.join(bin, 'kill'),
    `#!/usr/bin/env bash\nfor a in "$@"; do case "$a" in -*) ;; *) echo "$a" >> '${posix(matados)}';; esac; done\n`
  );
  fs.chmodSync(path.join(bin, 'kill'), 0o755);

  const runner = path.join(dir, 'run.sh');
  fs.writeFileSync(
    runner,
    [
      'set -u',
      'enable -n kill',
      // PATH acotado: así `powershell.exe` no existe y se ejercita la rama de `ps`. La rama de
      // powershell no se puede fabricar sin Windows, y es la MISMA función.
      `PATH="${posix(bin)}:/usr/bin:/bin"`,
      `PROJECT_DIR="${posix(projectDir)}"`,
      funciones,
      'kill_workers',
      'echo "---FIN---"'
    ].join('\n')
  );

  const result = spawnSync('bash', [runner], { encoding: 'utf8' });
  assert.equal(result.status, 0, `el runner falló:\n${result.stdout}\n${result.stderr}`);
  const anotados = fs.existsSync(matados)
    ? fs.readFileSync(matados, 'utf8').split('\n').filter(Boolean)
    : [];
  return { matados: [...new Set(anotados)], err: result.stderr, out: result.stdout };
}

const PROYECTO = '/c/corridas/asset-vault-spring';

/** Un worker de ESTE proyecto, uno de otro, y el daemon —que no lleva la propiedad—. */
const TABLA = [
  `  4101 /usr/bin/java -Dorg.gradle.internal.worker.tmpdir=${PROYECTO}/build/tmp/integrationTest/work -cp gradle-worker.jar worker.GradleWorkerMain 'Gradle Test Executor 7'`,
  `  4202 /usr/bin/java -Dorg.gradle.internal.worker.tmpdir=/c/corridas/OTRO-spring/build/tmp/integrationTest/work -cp gradle-worker.jar worker.GradleWorkerMain 'Gradle Test Executor 3'`,
  `  4303 /usr/bin/java -Xmx2g -Dorg.gradle.appname=gradle -classpath gradle-launcher.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.7`,
  `  4404 /usr/bin/node /c/otra/cosa.js`
].join('\n');

test('se termina el worker de ESTE directorio', () => {
  const { matados } = matar({ procesos: TABLA, projectDir: PROYECTO });
  assert.ok(matados.includes('4101'), `no se terminó el worker propio: ${matados.join(', ')}`);
});

test('NO se toca el worker de otro proyecto, ni el daemon', () => {
  // La otra mitad, y la que importa: un `kill` a ciegas por "gradle" se lleva por delante la
  // corrida de al lado, y el daemon es reutilizable — no sostiene el lock que motiva esto.
  const { matados } = matar({ procesos: TABLA, projectDir: PROYECTO });
  assert.ok(!matados.includes('4202'), 'se terminó un worker de OTRO directorio');
  assert.ok(!matados.includes('4303'), 'se terminó el daemon de Gradle');
  assert.ok(!matados.includes('4404'), 'se terminó un proceso que no es de Gradle');
});

test('sin ningún worker propio no se mata nada y no se dice nada', () => {
  const soloAjenos = TABLA.split('\n').filter((l) => !l.includes('4101')).join('\n');
  const { matados, err } = matar({ procesos: soloAjenos, projectDir: PROYECTO });
  assert.deepEqual(matados, []);
  assert.doesNotMatch(err, /se terminan/, 'anuncia una limpieza que no hizo');
});

test('si no se puede LISTAR procesos, se dice en voz alta', () => {
  // No encontrar workers porque no se pudo mirar se lee igual que no haberlos, y esa
  // confusión es exactamente la que cuesta la corrida siguiente.
  const { matados, err } = matar({ procesos: '', projectDir: PROYECTO, conPs: false });
  assert.deepEqual(matados, []);
  assert.match(err, /AVISO: no se pudo listar procesos/);
});

test('AUTOCOMPROBACIÓN: la limpieza está enganchada al EXIT y ofrecida como modo suelto', () => {
  // Sin el trap, las funciones existen y no las llama nadie: el defecto seguiría intacto.
  const script = scoreScript();
  assert.match(script, /\ntrap kill_workers EXIT\n/, 'la limpieza no está enganchada al EXIT');
  assert.match(script, /--kill-workers/, 'no existe el modo suelto que el remedio manda ejecutar');
  assert.doesNotMatch(
    script,
    /jps -l \| grep -i gradle/,
    'el remedio sigue recomendando jps, que NO lista los workers'
  );
});
