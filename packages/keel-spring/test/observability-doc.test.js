// La guía de observabilidad vive en DOS sitios y tiene UNA fuente: el payload
// (assets/generators/spring/observabilidad.md), que build instala en el proyecto generado, y la
// copia de la raíz del repo, que es la que se lee desde GitHub.
//
// Este test existe por lo que le pasa a toda copia: envejece. La de la raíz no la genera nadie al
// vuelo, así que sin esto el día que alguien corrija la fuente —o al revés— las dos versiones
// dirían cosas distintas sobre el mismo colector, y la equivocada sería justo la que se lee
// primero. Comparar byte a byte es lo único que no admite interpretación.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { TELEMETRY_GUIDES } from '../src/scaffold/generator-docs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '..');
const repoRoot = path.join(packageRoot, '..', '..');
const GUIDE = 'observabilidad.md';
const ROOT_COPY = 'OBSERVABILIDAD.md';

test('la guía de observabilidad: la copia de la raíz del repo es la fuente, byte a byte', () => {
  const source = path.join(packageRoot, 'assets', 'generators', 'spring', GUIDE);
  const copy = path.join(repoRoot, ROOT_COPY);
  assert.ok(fs.existsSync(source), `falta la fuente ${GUIDE}`);
  assert.ok(fs.existsSync(copy), `falta ${ROOT_COPY} en la raíz del repo`);
  assert.equal(
    fs.readFileSync(copy, 'utf8'),
    fs.readFileSync(source, 'utf8'),
    `${ROOT_COPY} y assets/generators/spring/${GUIDE} han divergido: copia la fuente sobre la raíz`
  );
  assert.deepEqual(TELEMETRY_GUIDES, [GUIDE]);
});

test('la guía de observabilidad: se instala en el proyecto generado solo con telemetría', () => {
  const { manifest, layers } = loadService(path.join(here, 'fixtures', 'stock-reservation'));
  const generate = (telemetry) => {
    const workspace = tmpDir('keel-obsdoc-');
    const { outDir } = scaffoldService({ manifest, layers, workspace, force: true, stack: { broker: 'kafka', telemetry } });
    return path.join(workspace, outDir, 'docs', 'keel', GUIDE);
  };
  assert.ok(fs.existsSync(generate('otel')), `con telemetría falta docs/keel/${GUIDE}`);
  assert.ok(!fs.existsSync(generate('none')), `sin telemetría no debe instalarse docs/keel/${GUIDE}`);
});

test('la guía de observabilidad: no cita rutas de un harness ni promete lo contrario que la config', () => {
  const guide = fs.readFileSync(path.join(packageRoot, 'assets', 'generators', 'spring', GUIDE), 'utf8');
  // docContent() ya lo rechazaría al instalarla, pero aquí el fallo dice POR QUÉ: la guía la leen
  // los dos harnesses y una ruta `.claude/…` le miente a quien use el otro.
  assert.ok(!/\.claude\/|\.opencode\//.test(guide), 'la guía no puede citar rutas de un harness');
  assert.ok(!/\{\{keel:/.test(guide), 'queda un token sin resolver');
  // Lo que la guía promete sobre los interruptores tiene que ser lo que el generador emite.
  assert.ok(guide.includes('LOG_EXPORT_OTLP'), 'la guía tiene que explicar el interruptor de los logs');
  assert.ok(guide.includes('TELEMETRY_EXPORT_ENABLED'));
  assert.ok(guide.includes('TRACING_SAMPLING_PROBABILITY'));
});
