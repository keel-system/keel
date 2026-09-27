// La métrica de corrida (R8): la huella del agente y la serie entre corridas.
//
// La huella se mide sobre un proyecto GENERADO de verdad, no sobre un manifiesto fabricado: lo que
// importa es que el digest con el que build registra un archivo sea el mismo con el que la métrica
// lo relee. Con dos funciones de digest distintas, todo saldría «reescrito» y la serie mediría ruido.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { footprint, byDirectory, parseCorrida, series } from '../src/lib/corrida-metrics.js';
import { tmpDir } from './helpers/tmp.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function generated() {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'payout-runs'));
  const workspace = tmpDir('keel-corrida-metrics-');
  const result = scaffoldService({ manifest, layers, workspace, force: true, stack: { database: 'postgresql', broker: null } });
  return path.join(workspace, result.outDir);
}

test('recién generado, la huella es cero: todo lo registrado sigue intacto', () => {
  const project = generated();
  const result = footprint(project);
  assert.ok(result.registered > 50, `pocos archivos registrados: ${result.registered}`);
  assert.equal(result.intact, result.registered - result.adopted);
  assert.deepEqual(result.rewritten, []);
  assert.deepEqual(result.deleted, []);
});

test('lo que el agente reescribe y lo que borra se cuenta aparte, y lo añadido no cuenta', () => {
  const project = generated();
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'keel-generated.json'), 'utf8'));
  const [touched, removed] = Object.keys(manifest.files).filter((file) => file.endsWith('.java'));
  fs.appendFileSync(path.join(project, touched), '\n// el agente completó un TODO\n');
  fs.rmSync(path.join(project, removed));
  fs.writeFileSync(path.join(project, 'src', 'NuevoDelAgente.java'), 'class NuevoDelAgente {}\n');

  const result = footprint(project);
  assert.deepEqual(result.rewritten, [touched]);
  assert.deepEqual(result.deleted, [removed]);
  assert.equal(result.intact, result.registered - result.adopted - 2);
  assert.deepEqual(byDirectory(result.rewritten), [[path.posix.dirname(touched), [path.posix.basename(touched)]]]);
});

const corrida = ({ listo, huella, huecos, gaps = [] }) =>
  [
    '# Corrida',
    '',
    '| | |',
    '|---|---|',
    '| Diseño | `x` v1.0.0 |',
    ...(listo ? [`| Diseño listo al generar | ${listo} |`] : []),
    ...(huella ? [`| Huella del agente | ${huella} |`] : []),
    ...(huecos ? [`| Huecos del diseño | ${huecos} |`] : []),
    '',
    ...(gaps.length ? ['## designGaps', '', ...gaps.map((key) => `- \`${key}\` — algo que el diseño no dijo`), ''] : []),
    '## Otra sección',
    '',
    '- `no-es-un-gap` — una viñeta fuera de la sección no cuenta'
  ].join('\n');

test('una corrida se lee por sus etiquetas fijas, y lo que no midió sale null, no cero', () => {
  const lista = parseCorrida('a', corrida({ listo: 'sí', huella: '100 archivos registrados por `build`, 0 adoptados, **7 reescritos**, 1 borrados', huecos: '2 en design-gaps.yaml' }));
  assert.equal(lista.ready, true);
  assert.equal(lista.acceptedUnready, false);
  assert.equal(lista.rewritten, 7);
  assert.equal(lista.deleted, 1);
  assert.equal(lista.registered, 100);
  assert.equal(lista.designGaps, 2);

  const antigua = parseCorrida('b', corrida({ listo: 'anterior a la puerta (paso 10)' }));
  assert.equal(antigua.ready, null);
  assert.equal(antigua.rewritten, null, 'una corrida que no midió la huella no tiene huella cero');

  const rodeada = parseCorrida('c', corrida({ listo: 'no, con --accept-unready (flow-review, review)' }));
  assert.equal(rodeada.ready, false);
  assert.equal(rodeada.acceptedUnready, true);
});

test('la serie cuenta el uso de --accept-unready y encuentra los designGap repetidos', () => {
  const dir = tmpDir('keel-corrida-series-');
  fs.writeFileSync(path.join(dir, '2026-01-01-a.md'), corrida({ listo: 'sí', gaps: ['orden-callback', 'solo-en-a'] }));
  fs.writeFileSync(path.join(dir, '2026-01-02-b.md'), corrida({ listo: 'no, con --accept-unready (gaps)', gaps: ['orden-callback'] }));
  fs.writeFileSync(path.join(dir, 'README.md'), '| Diseño listo al generar | no, con --accept-unready |');

  const result = series(dir);
  assert.deepEqual(result.corridas.map((entry) => entry.name), ['2026-01-01-a', '2026-01-02-b'], 'el README no es una corrida');
  assert.equal(result.acceptedUnready, 1);
  assert.deepEqual(result.repeated, [['orden-callback', ['2026-01-01-a', '2026-01-02-b']]]);
});
