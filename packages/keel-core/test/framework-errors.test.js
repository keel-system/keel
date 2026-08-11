// El catálogo de códigos del framework vive en dos formatos —el módulo que consumen los
// generadores y la tabla en prosa que lee el diseñador— y ese es exactamente el reparto que
// se rompe solo. Estos tests atan los dos, igual que `supported-dsl.test.js` deriva la versión
// del DSL del schema en vez de duplicarla en una constante.
//
// La consecuencia de que diverjan no es cosmética: el documento es lo que el diseñador usa
// para decidir si sustituye un código, y el módulo es lo que el generador emite. Un documento
// que promete otro código manda a programar contra un error que no llega.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMEWORK_ERRORS, fixedFrameworkErrors, overrideFor } from '../src/lib/framework-errors.js';
import { schemaPathFor } from '../src/lib/assets.js';

const docPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'core',
  'docs',
  'framework-errors.md'
);
const doc = fs.readFileSync(docPath, 'utf8');

test('todos los códigos fijos del módulo aparecen en la tabla del documento', () => {
  for (const entry of fixedFrameworkErrors()) {
    assert.ok(
      doc.includes(`\`${entry.code}\``),
      `el documento no menciona ${entry.code}: el generador emitiría un código que el diseñador no puede leer`
    );
    // Y con su status: un código bien citado con el status equivocado es peor que no citarlo,
    // porque el escenario que lo afirme fallará por una razón que no está a la vista.
    const row = doc.split('\n').find((line) => line.includes(`\`${entry.code}\``) && line.startsWith('|'));
    assert.ok(row, `${entry.code} no está en la tabla, solo en la prosa`);
    assert.ok(row.includes(`| ${entry.http} |`), `${entry.code}: la tabla no dice HTTP ${entry.http} — ${row}`);
  }
});

test('la tabla no promete códigos que el módulo no tenga', () => {
  // Al revés que el anterior, y hace falta: un código que se retira del módulo y se queda en el
  // documento es una promesa que nadie cumple.
  const known = new Set(fixedFrameworkErrors().map((entry) => entry.code));
  const rows = doc.split('\n').filter((line) => line.startsWith('| `') && / \| \d{3} \| /.test(line));
  for (const row of rows) {
    const code = row.match(/\| `([A-Z][A-Z0-9_]*)` \|/)?.[1];
    if (!code) continue; // la fila del código derivado, que no es un literal
    assert.ok(known.has(code), `la tabla anuncia ${code} y el módulo no lo tiene`);
  }
});

test('cada código cumple el patrón de errorCode del DSL', () => {
  // Los códigos del framework y los del diseño viajan por el mismo campo del contrato, así que
  // tienen que ser indistinguibles en forma: si uno no cumpliera el patrón, un diseño no podría
  // sustituirlo con uno propio.
  const common = JSON.parse(fs.readFileSync(schemaPathFor('common'), 'utf8'));
  const pattern = new RegExp(common.$defs.errorCode.pattern);
  for (const entry of fixedFrameworkErrors()) {
    assert.match(entry.code, pattern, `${entry.code} no es un errorCode válido del DSL`);
  }
});

test('toda entrada sustituible tiene familia, y su propio código pertenece a ella', () => {
  for (const [name, entry] of Object.entries(FRAMEWORK_ERRORS)) {
    if (!entry.overridable) {
      assert.ok(!entry.family, `${name}: declara familia pero no es sustituible`);
      continue;
    }
    if (entry.derived) {
      assert.equal(typeof entry.familyFor, 'function', `${name}: derivado y sin familyFor`);
      continue;
    }
    assert.ok(entry.family instanceof RegExp, `${name}: sustituible sin familia`);
    // El canónico dentro de su propia familia. Sin esto, un diseño que declarase exactamente el
    // código canónico no sería reconocido como override y el generador lo ignoraría — que es
    // justo lo que hacían dos fixtures con CONCURRENT_MODIFICATION antes de este trabajo.
    assert.match(entry.code, entry.family, `${name}: el canónico no pertenece a su familia`);
  }
});

test('cada entrada dice qué mecanismo la enciende y cuándo se emite', () => {
  // Son los dos datos que necesita el aviso de `keel validate`: sin `mechanism` no puede
  // señalar qué campo del diseño lo encendió, y sin `when` el aviso no explica nada.
  for (const [name, entry] of Object.entries(FRAMEWORK_ERRORS)) {
    assert.ok(entry.mechanism?.length > 0, `${name}: sin mechanism`);
    assert.ok(entry.when?.length > 20, `${name}: sin when`);
  }
});

test('overrideFor exige un candidato de la familia, con el status del mecanismo', () => {
  const concurrency = FRAMEWORK_ERRORS.concurrency;

  // El caso normal: un código del dominio en la familia.
  const declared = [{ code: 'ASSET_VERSION_CONFLICT', http: 409 }];
  assert.equal(overrideFor(declared, concurrency)?.code, 'ASSET_VERSION_CONFLICT');

  // Cero candidatos → manda el canónico. Es lo que hace que el contrato exista siempre.
  assert.equal(overrideFor([{ code: 'ASSET_NOT_FOUND', http: 404 }], concurrency), null);

  // Dos → el diseño dijo algo ambiguo, y elegir uno sería adivinar.
  assert.equal(
    overrideFor([{ code: 'A_VERSION_CONFLICT', http: 409 }, { code: 'B_CONCURRENT_UPDATE', http: 409 }], concurrency),
    null
  );

  // El status importa: el mismo nombre con otro status no es este contrato.
  assert.equal(overrideFor([{ code: 'ASSET_VERSION_CONFLICT', http: 422 }], concurrency), null);

  // Y un `code` cuyo status cambia según la operación tampoco: no hay uno del que hablar.
  assert.equal(
    overrideFor([{ code: 'ASSET_VERSION_CONFLICT', http: 409, dynamicStatus: true }], concurrency),
    null
  );

  // Lo no sustituible no se sustituye ni declarándolo.
  assert.equal(overrideFor([{ code: 'VALIDATION_ERROR', http: 400 }], FRAMEWORK_ERRORS.validation), null);
});

test('la familia de la unicidad se deriva de los campos de la clave', () => {
  const family = FRAMEWORK_ERRORS.uniqueness.familyFor('OWNER_SLUG');
  const declared = [{ code: 'ASSET_OWNER_SLUG_ALREADY_EXISTS', http: 409 }];
  assert.equal(overrideFor(declared, FRAMEWORK_ERRORS.uniqueness, family)?.code, 'ASSET_OWNER_SLUG_ALREADY_EXISTS');
  // Otra clave natural del mismo servicio no la satisface: es lo que permite que un diseño con
  // varias claves declare un error distinto para cada una.
  assert.equal(overrideFor([{ code: 'ASSET_CHECKSUM_ALREADY_EXISTS', http: 409 }], FRAMEWORK_ERRORS.uniqueness, family), null);
});
