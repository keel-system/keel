import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRUCTURAL_DEFAULTS, COVERED_ELSEWHERE, DISCARDED, implicitDefaults } from '../src/lib/structural-defaults.js';
import { checkFor } from '../src/lib/checks.js';
import { checkCrossRefs } from '../src/lib/crossrefs.js';

// Ata la tabla de defaults tácitos a las dos piezas que describe: el catálogo de decisiones
// estructurales (la pregunta) y los schemas (el valor que se aplicaría en silencio). Si una de
// las dos cambia y la tabla no, la regla avisaría de un default que ya no es el que es, o
// dejaría de avisar de una entrada nueva sin que nadie lo decidiera.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = fs.readFileSync(
  path.join(ROOT, 'assets/skills/keel-design/references/structural-decisions.md'),
  'utf8'
);
const schemaOf = (name) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, `assets/core/schema/${name}.schema.json`), 'utf8'));

function atPointer(doc, pointer) {
  return pointer
    .split('/')
    .slice(1)
    .reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
}

// Las filas de la tabla § 3 del catálogo: `| 3.x | Decisión | Dónde | Paso |`.
const catalogSections = [...CATALOG.matchAll(/^\| (3\.\d+b?) \|/gm)].map((match) => match[1]);

// Las entradas del catálogo sin un VALOR que se aplique en silencio: el campo es un mecanismo
// opcional y su ausencia significa «sin el mecanismo», que es visible leyendo el YAML. Si esa
// ausencia es un hueco, lo decide otra regla o la conversación, no un default tácito.
const SIN_DEFAULT = {
  '3.2': 'idempotency es un bloque opcional: ausente es «sin idempotencia», no un valor aplicado',
  '3.3': 'cache es un bloque opcional: ausente es «sin caché»',
  '3.6': 'la resiliencia de una llamada no tiene default en el schema (el timeout ausente lo mira CHK-HTTP-NO-TIMEOUT)',
  '3.8': 'paginated: false es la ausencia del mecanismo («sin paginar»), no una política que el generador elija',
  '3.11': 'compensations es un bloque opcional: su ausencia la miran las reglas de activación'
};

test('toda entrada de STRUCTURAL_DEFAULTS existe en el catálogo de structural-decisions.md', () => {
  for (const entry of [...STRUCTURAL_DEFAULTS, ...COVERED_ELSEWHERE, ...DISCARDED]) {
    assert.ok(catalogSections.includes(entry.section), `§ ${entry.section} (${entry.path}) no está en la tabla del catálogo`);
    assert.match(CATALOG, new RegExp(`^### ${entry.section.replace('.', '\\.')} `, 'm'), `§ ${entry.section} sin su sección`);
  }
});

test('cada default de la tabla es el default que declara el schema', () => {
  for (const entry of STRUCTURAL_DEFAULTS) {
    const node = atPointer(schemaOf(entry.schema), entry.schemaPointer);
    assert.ok(node, `${entry.path}: ${entry.schema}.schema.json no tiene ${entry.schemaPointer}`);
    assert.equal(node.default, entry.default, `${entry.path}: el schema dice ${JSON.stringify(node.default)}`);
  }
});

test('toda entrada del catálogo está clasificada: vigilada aquí, en otra regla, descartada o sin default', () => {
  const classified = new Set([
    ...STRUCTURAL_DEFAULTS.map((entry) => entry.section),
    ...COVERED_ELSEWHERE.map((entry) => entry.section),
    ...DISCARDED.map((entry) => entry.section),
    ...Object.keys(SIN_DEFAULT)
  ]);
  const missing = catalogSections.filter((section) => !classified.has(section));
  assert.deepEqual(missing, [], 'entrada nueva del catálogo sin decidir si su default tácito se vigila');
});

test('las reglas que cubren una entrada en otro sitio existen en el catálogo de checks', () => {
  for (const entry of COVERED_ELSEWHERE) {
    assert.equal(checkFor(entry.by)?.nature, 'undecided', `${entry.section}: ${entry.by}`);
  }
});

test('el check es una decisión no tomada y aceptable', () => {
  const entry = checkFor('CHK-MODEL-IMPLICIT-DEFAULT');
  assert.equal(entry.severity, 'warning');
  assert.equal(entry.nature, 'undecided');
  assert.notEqual(entry.waivable, false);
});

// --- la regla: solo mira la AUSENCIA ---

const layers = () => ({
  domain: { entities: { Order: { fields: { id: { type: 'uuid', id: true } } } } },
  'use-cases': {},
  persistence: { default: { model: 'relational' }, entities: { Order: {} } },
  storage: {
    buckets: {
      invoices: { allowedContentTypes: ['application/pdf'], maxSizeMb: 5, signedUrlTtlSeconds: 300 },
      logos: { visibility: 'public', allowedContentTypes: ['image/png'], maxSizeMb: 1 }
    }
  }
});

const implicit = (result) =>
  result.findings.filter((f) => f.id === 'CHK-MODEL-IMPLICIT-DEFAULT').map((f) => f.scope);

test('un campo ausente salta por unidad, con el scope con el que se acepta', () => {
  assert.deepEqual(implicit(checkCrossRefs({ layers: layers() })), [
    'persistence.consistency.optimisticLocking',
    'persistence.audit.timestamps',
    'persistence.audit.authorship',
    'storage.buckets.invoices.visibility'
  ]);
});

test('escrito con el MISMO valor que el default ya no salta: lo que cuenta es que conste', () => {
  const decided = layers();
  decided.persistence.consistency = { optimisticLocking: 'all' };
  decided.persistence.audit = { timestamps: 'all', authorship: 'none' };
  decided.storage.buckets.invoices.visibility = 'private';
  assert.deepEqual(implicit(checkCrossRefs({ layers: decided })), []);
});

test('reliability solo se pregunta si hay eventos publicados', () => {
  const sinEventos = { messaging: { publishing: { events: {} } } };
  assert.deepEqual(implicitDefaults(sinEventos), []);
  const conEventos = { messaging: { publishing: { events: { OrderPlaced: { payload: {} } } } } };
  assert.deepEqual(
    implicitDefaults(conEventos).map((found) => found.scope),
    ['messaging.publishing.reliability']
  );
});

test('sin la capa no hay nada que preguntar', () => {
  assert.deepEqual(implicitDefaults({ domain: {}, 'use-cases': {} }), []);
});
