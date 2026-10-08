// El documento que ESCRIBE keel-spring es el que declara keel-core (`keel-core/gen/document.js`), para
// que el servidor de keel-nest del mismo diseño lea y escriba el mismo documento: los nombres de cada
// campo en el orden del diseño, el `_id`, lo que va anidado, la colección de cada raíz y qué campos se
// guardan como Decimal128.
//
// Los espejos `XxxDocument` siguen escritos a mano en document-entities.js y document-embeddables.js;
// esto es lo que impide que se separen de los datos que keel-nest emitirá.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { documentShape, documentValueObjects, valueObjectShape, storeDocumentKey, storeDocumentFields } from 'keel-core/gen/document';
import { OUTBOX_EVENT, PROCESSED_EVENT } from 'keel-core/gen/messaging-stores';
import { IDEMPOTENCY_RECORD } from 'keel-core/gen/request-idempotency';
import { RECONCILIATION_CLAIM } from 'keel-core/gen/reconciliation-stores';
import { buildModel } from '../src/lib/model.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

// Las cuatro fixtures documentales: claves naturales y barridos (job-dispatch-mongo), hijas anidadas y
// mensajería (inspection-reports), el MVP (notification-mailer-mongo) y la reconciliación con
// almacenamiento (asset-vault).
const SUBJECTS = ['job-dispatch-mongo', 'inspection-reports', 'notification-mailer-mongo', 'asset-vault'];

function load(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return { files: planService({ manifest, layers, workspace: FIXTURES_DIR }).files, model: buildModel({ manifest, layers }) };
}

function documentClass(files, className) {
  const file = files.find((f) => f.path.endsWith(`/documents/${className}.java`));
  assert.ok(file, `keel-spring emite ${className}`);
  return file.content;
}

/** Los campos que el mapeador escribe, en orden: `@Id` → `_id`, `@Field(name = …)` → su nombre. */
function storedFields(source) {
  const fields = [];
  for (const match of source.matchAll(/(@Id\b)|@Field\(name = "([^"]+)"([^)]*)\)/g)) {
    if (match[1]) fields.push({ name: '_id', decimal128: false });
    else fields.push({ name: match[2], decimal128: /FieldType\.DECIMAL128/.test(match[3]) });
  }
  return fields;
}

const expected = (shape) => shape.map((entry) => ({ name: entry.name, decimal128: entry.storage === 'decimal128' }));

for (const name of SUBJECTS) {
  test(`${name}: cada documento guarda los campos de documentShape, en su orden y con su tipo`, () => {
    const { files, model } = load(name);
    const auditable = files.find((f) => f.path.endsWith('/documents/AuditableDocument.java'));
    let compared = 0;
    for (const entity of model.entities.filter((e) => e.persisted)) {
      const source = documentClass(files, `${entity.name}Document`);
      const stored = storedFields(source);
      // La auditoría por política la escribe la base común, y va detrás de los campos propios.
      if (/extends AuditableDocument/.test(source)) stored.push(...storedFields(auditable.content));
      assert.deepEqual(stored, expected(documentShape(model, entity)), `${entity.name}Document`);
      if (entity.isAggregateRoot) assert.match(source, new RegExp(`@Document\\(collection = "${entity.collectionName}"\\)`));
      else assert.doesNotMatch(source, /@Document\(/, `${entity.name} va anidada: no es una colección`);
      compared += 1;
    }
    for (const vo of documentValueObjects(model)) {
      assert.deepEqual(storedFields(documentClass(files, `${vo.name}Document`)), expected(valueObjectShape(vo)), `${vo.name}Document`);
      compared += 1;
    }
    assert.ok(compared > 0);
  });
}

test('la paridad ve lo que tiene que ver (se autocomprueba)', () => {
  const { files, model } = load('job-dispatch-mongo');
  const [root] = model.entities.filter((e) => e.persisted && e.isAggregateRoot);
  const source = documentClass(files, `${root.name}Document`);
  const renamed = source.replace(/@Field\(name = "([^"]+)"/, '@Field(name = "$1_x"');
  assert.notDeepEqual(storedFields(renamed), expected(documentShape(model, root)));
});

// Los almacenes del generador como documentos: el `_id` (valor, subdocumento en su orden, o la clave
// aplanada de la reconciliación) y los campos de keel-core/gen/document.js. El MongoIndexConfig ya sale
// de los mismos datos; esto ata los espejos `*Document` escritos a mano.
const STORES = [
  { fixture: 'notification-mailer-mongo', table: OUTBOX_EVENT, className: 'OutboxEventDocument' },
  { fixture: 'notification-mailer-mongo', table: PROCESSED_EVENT, className: 'ProcessedEventDocument' },
  { fixture: 'notification-mailer-mongo', table: IDEMPOTENCY_RECORD, className: 'IdempotencyRecordDocument' },
  { fixture: 'asset-vault', table: RECONCILIATION_CLAIM, className: 'ReconciliationClaimDocument' }
];

for (const { fixture, table, className } of STORES) {
  test(`${fixture}: ${className} guarda el ${table.table} de keel-core/gen/document.js`, () => {
    const { files } = load(fixture);
    const file = files.find((f) => f.path.endsWith(`/${className}.java`));
    assert.ok(file, `keel-spring emite ${className}`);
    assert.ok(file.content.includes(`@Document(collection = "${table.table}")`), `${className} es la colección ${table.table}`);
    const key = storeDocumentKey(table);
    // El orden del archivo: el @Id, los campos del documento y, si la clave es un subdocumento, sus campos
    // (la clase anidada va al final).
    const expectedNames = ['_id', ...storeDocumentFields(table).map((f) => f.name), ...(key.kind === 'subdocument' ? key.columns : [])];
    assert.deepEqual(storedFields(file.content).map((f) => f.name), expectedNames);
  });
}
