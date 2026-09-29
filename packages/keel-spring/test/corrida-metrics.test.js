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
import { footprint, byDirectory, parseCorrida, series, verdict } from '../src/lib/corrida-metrics.js';
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

const corrida = ({ listo, huella, huecos, gaps = [], extra = {} }) =>
  [
    '# Corrida',
    '',
    '| | |',
    '|---|---|',
    '| Diseño | `x` v1.0.0 |',
    ...(listo ? [`| Diseño listo al generar | ${listo} |`] : []),
    ...(huella ? [`| Huella del agente | ${huella} |`] : []),
    ...(huecos ? [`| Huecos del diseño | ${huecos} |`] : []),
    ...Object.entries(extra).map(([label, value]) => `| ${label} | ${value} |`),
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

// ─── El plan de validación de R8: etiquetas nuevas y el veredicto de H1 ─────────────
//
// Los criterios se fijaron antes de correr (recomendaciones-diseno.md § R8). Estos casos atan el
// veredicto a ellos: si alguien los afloja en el código, cae aquí y no en la lectura de la serie.

const medida = (name, { huecos = '0', agujeros = '0', careo = '9→3→0', listo = 'sí', gaps = [], papel } = {}) =>
  parseCorrida(
    name,
    corrida({
      listo,
      huecos,
      gaps,
      extra: {
        'Agujeros de la puerta': agujeros,
        'Huecos del generador': '2',
        'Coste del diseño': `careo ${careo}; barrido 12; revisión 3`,
        ...(papel ? { Papel: papel } : {})
      }
    })
  );

test('las etiquetas nuevas se leen, y en una corrida vieja salen null', () => {
  const nueva = medida('2026-10-01-x-r8', { careo: '13→6→0', papel: 'Control' });
  assert.equal(nueva.gateHoles, 0);
  assert.equal(nueva.generatorGaps, 2);
  assert.deepEqual(nueva.careoPasses, [13, 6, 0]);
  assert.equal(nueva.role, 'control');

  const vieja = parseCorrida('2026-09-01-y', corrida({ listo: 'sí' }));
  assert.equal(vieja.gateHoles, null);
  assert.equal(vieja.careoPasses, null);
  assert.equal(vieja.role, null);
});

test('H1: robusta con tres corridas de medición limpias; el control y las antiguas no cuentan', () => {
  const corridas = [
    parseCorrida('2026-09-20-antigua', corrida({ listo: 'anterior a la puerta', huecos: '10' })),
    medida('2026-10-01-mailer-r8', { huecos: '5', papel: 'control' }),
    medida('2026-10-02-a-r8'),
    medida('2026-10-03-b-r8', { huecos: '1', gaps: ['uno'] }),
    medida('2026-10-04-c-r8')
  ];
  assert.deepEqual(verdict(corridas), { status: 'robusta', measured: 3, reasons: [] });
  // Con dos, todavía no hay veredicto.
  assert.equal(verdict(corridas.slice(0, 4)).status, 'en-curso');
});

test('H1: no robusta por un agujero de la puerta, por un repetido o por --accept-unready', () => {
  const base = [medida('2026-10-02-a-r8'), medida('2026-10-03-b-r8'), medida('2026-10-04-c-r8')];
  const conAgujero = [...base.slice(0, 2), medida('2026-10-04-c-r8', { huecos: '1', agujeros: '1' })];
  assert.equal(verdict(conAgujero).status, 'no-robusta');
  assert.match(verdict(conAgujero).reasons.join('\n'), /agujero/);

  const repetido = [medida('2026-10-02-a-r8', { huecos: '1', gaps: ['k'] }), medida('2026-10-03-b-r8', { huecos: '1', gaps: ['k'] }), base[2]];
  assert.match(verdict(repetido).reasons.join('\n'), /repetido 'k'/);

  const rodeada = [...base.slice(0, 2), medida('2026-10-04-c-r8', { listo: 'no, con --accept-unready (gaps)' })];
  assert.equal(verdict(rodeada).status, 'no-robusta');
});

test('H1: no robusta si hay huecos en dos corridas o el careo no converge; en curso si falta medir', () => {
  const dosConHuecos = [medida('2026-10-02-a-r8', { huecos: '1', gaps: ['a'] }), medida('2026-10-03-b-r8', { huecos: '1', gaps: ['b'] }), medida('2026-10-04-c-r8')];
  assert.equal(verdict(dosConHuecos).status, 'no-robusta');

  const sinConverger = [medida('2026-10-02-a-r8', { careo: '5→8→2' }), medida('2026-10-03-b-r8'), medida('2026-10-04-c-r8')];
  assert.match(verdict(sinConverger).reasons.join('\n'), /no convergió/);

  const sinClasificar = [
    parseCorrida('2026-10-02-a-r8', corrida({ listo: 'sí', huecos: '0' })),
    medida('2026-10-03-b-r8'),
    medida('2026-10-04-c-r8')
  ];
  const pendiente = verdict(sinClasificar);
  assert.equal(pendiente.status, 'en-curso');
  assert.match(pendiente.reasons.join('\n'), /sin clasificar/);
});
