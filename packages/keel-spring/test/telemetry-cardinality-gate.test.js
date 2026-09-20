// El gate de cardinalidad (`infra/check-telemetry.sh`), EJECUTADO.
//
// Un `includes(...)` sobre el script no distingue un gate que caza de uno que no mira: el gate de
// Keycloak ya enseñó que un script puede prometer en su comentario algo que su bash no hace, y la
// suite de cadenas seguía verde sobre líneas inalcanzables. Así que aquí se corre con bash.
//
// Lo que este gate vigila no rompe nada visible: una etiqueta de métrica con el id del pedido
// dentro multiplica las series por el número de pedidos, y eso no lanza, no se loguea y no pone
// rojo ningún escenario — se ve en la factura del backend. Por eso las dos mitades:
//
//   · nace VERDE sobre el árbol recién generado (es una prohibición, no una exigencia), y
//   · se pone ROJO en cuanto alguien añade la forma prohibida, que es lo único que prueba que mira.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { ATTRIBUTES } from '../src/lib/telemetry-probes.js';
import { allowedTagKeys } from '../src/scaffold/telemetry-gate.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const GATE = 'infra/check-telemetry.sh';

function generate(fixture, stack) {
  const { manifest, layers } = loadService(path.join(fixturesDir, fixture));
  const workspace = tmpDir('keel-cardinality-');
  const result = scaffoldService({ manifest, layers, workspace, force: true, stack });
  return path.join(workspace, result.outDir);
}

const run = (root) => spawnSync('bash', [GATE], { cwd: root, encoding: 'utf8' });

/** Escribe una clase con el cuerpo dado, para que el gate tenga algo que mirar. */
function writeJava(root, name, body) {
  const dir = path.join(root, 'src', 'main', 'java', 'sonda');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.java`), `package sonda;\n\nclass ${name} {\n${body}\n}\n`, 'utf8');
}

test('sin telemetría no hay gate: no habría métricas de las que hablar', () => {
  assert.ok(!fs.existsSync(path.join(generate('asset-vault', {}), GATE)));
  assert.ok(fs.existsSync(path.join(generate('asset-vault', { telemetry: 'otel' }), GATE)));
});

test('check-telemetry.sh: verde recién generado, en las dos ramas del modelo', () => {
  for (const fixture of ['asset-vault', 'notification-mailer', 'notification-mailer-mongo']) {
    const resultado = run(generate(fixture, { telemetry: 'otel' }));
    assert.equal(
      resultado.status,
      0,
      `${fixture}: el gate nace rojo sobre el árbol generado, así que build estampa una clave que él mismo prohíbe\n${resultado.stdout}${resultado.stderr}`
    );
    // Y no por haber abortado: un sed con un escape mal puesto deja el check sin mirar nada y su
    // efecto es indistinguible de un verde.
    assert.equal(resultado.stderr.trim(), '', `${fixture}: el gate escribió en stderr:\n${resultado.stderr}`);
    assert.match(resultado.stdout, /cardinality {2,}OK/);
  }
});

test('check-telemetry.sh: rojo con una etiqueta de métrica fuera del vocabulario', () => {
  const root = generate('asset-vault', { telemetry: 'otel' });
  writeJava(root, 'Sonda', '    void medir(String orderId) {\n        observation.lowCardinalityKeyValue("orderId", orderId);\n    }');
  const resultado = run(root);
  assert.equal(resultado.status, 1, `el gate no vio la etiqueta prohibida:\n${resultado.stdout}`);
  assert.match(resultado.stdout, /cardinality {2,}KO/);
  // El hallazgo tiene que llegar por stdout con el archivo dentro: el agente no vuelca logs.
  assert.match(resultado.stdout, /Sonda\.java/);
});

test('check-telemetry.sh: la misma clave es correcta en el span y prohibida en la métrica', () => {
  const root = generate('asset-vault', { telemetry: 'otel' });
  // En el SPAN, donde build ya la estampa: legítimo, y es la salida que el hallazgo propone.
  writeJava(root, 'EnElSpan', `    void medir(String id) {\n        context.addHighCardinalityKeyValue(KeyValue.of("${ATTRIBUTES.correlationId}", id));\n    }`);
  assert.equal(run(root).status, 0, 'un atributo de alta cardinalidad en el SPAN no es un hallazgo');

  // La misma clave como etiqueta de MÉTRICA: un valor distinto por petición.
  writeJava(root, 'EnLaMetrica', `    void medir(String id) {\n        observation.lowCardinalityKeyValue("${ATTRIBUTES.correlationId}", id);\n    }`);
  const resultado = run(root);
  assert.equal(resultado.status, 1, 'la correlación como etiqueta de métrica es el caso que más caro sale');
  assert.match(resultado.stdout, /EnLaMetrica\.java/);
});

test('check-telemetry.sh: una clave del vocabulario pasa, mire por donde mire', () => {
  const root = generate('asset-vault', { telemetry: 'otel' });
  const cuerpo = allowedTagKeys()
    .map((clave, indice) => `        observation.lowCardinalityKeyValue("${clave}", valor${indice});`)
    .join('\n');
  writeJava(root, 'Vocabulario', `    void medir(String ${allowedTagKeys().map((_, i) => `valor${i}`).join(', String ')}) {\n${cuerpo}\n    }`);
  assert.equal(run(root).status, 0, 'el vocabulario del propio generador tiene que pasar el gate');
});

test('check-telemetry.sh: un comentario que cita la forma prohibida no es un hallazgo', () => {
  const root = generate('asset-vault', { telemetry: 'otel' });
  writeJava(root, 'Comentada', '    // Nunca: observation.lowCardinalityKeyValue("orderId", orderId);\n    void medir() {}');
  assert.equal(run(root).status, 0, 'el gate se pondría rojo por su propia prosa y por la de build');
});
