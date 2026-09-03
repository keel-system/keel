// Qué capacidad del DSL no ejercita ninguna fixture.
//
// Tres capacidades llegaron igual: alguien las implementó bien, con su documentación, y
// nada las pedía ni las ejercitaba. `mail.delivery.attachments` eran siete sitios del
// generador con cero tests y cero fixtures; `authentication.scoping`, veintitrés sitios con
// tests de cadenas y ninguna fixture. Ese Java no pasa por `java-syntax.test.js` ni por
// `compile-check` —los dos iteran el directorio de fixtures—, así que nadie lo ha compilado
// nunca. Es la distinción de siempre: un `includes(...)` verde no distingue «no hay errores»
// de «no mira».
//
// La auditoría que lo destapó era un grep que alguien recordó hacer. Aquí es un test: cruza
// las propiedades OPCIONALES de los schemas del DSL —donde vive una capacidad que un diseño
// puede declarar o no— contra lo que las fixtures declaran de verdad. Lo que no aparece en
// ninguna necesita una fila en EXCEPCIONES con su motivo escrito; si no, este test es rojo.
//
// No prohíbe los huecos: los inventaría. Lo que impide es que aparezca uno NUEVO en silencio,
// que es exactamente cómo llegaron los tres.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYERS, schemaPathFor, loadService } from 'keel-core';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// ─────────────────────────────────────────────────────────────────────────────
// Motivos admisibles. Una fila sin motivo de esta tabla no es una excepción: es un hueco sin
// anotar, y la diferencia entre las dos cosas es todo lo que este test aporta.
const MOTIVOS = {
  // El generador NO la lee, o solo la vuelca en un javadoc. Declararla no cambia ninguna
  // rama del Java emitido, así que no hay nada que compilar.
  informativo: 'informativo',
  // Tiene default y el generador lo aplica: declararla cambia un número, no un camino.
  conDefault: 'conDefault',
  // La rama hermana del mismo bloque sí la declara alguna fixture, y el emisor es el mismo
  // código: lo que queda sin compilar es una línea, no un mecanismo.
  ramaHermana: 'ramaHermana',
  // Un test la cubre parcheando el modelo en memoria. No es javac, pero tampoco es cero.
  soloCadenas: 'soloCadenas',
  // Ni fixture ni test. Es el estado en el que llegaron los tres, y el que este archivo
  // existe para hacer visible.
  hueco: 'hueco'
};

/**
 * Las capacidades que hoy no declara ninguna fixture, con su motivo.
 *
 * Cerrar un hueco significa BORRAR su fila: el test comprueba también que no queden filas
 * muertas, para que la tabla no se convierta en la lista de lo que hubo alguna vez.
 */
const EXCEPCIONES = new Map([
  [
    'security.authentication.callerIdentity.from.name',
    {
      motivo: MOTIVOS.soloCadenas,
      porque:
        'la rama `from.source: claim` del identificador de llamante. notification-mailer declara la otra ' +
        '(`serviceClient`), y caller-identity.test.js cubre esta parcheando el modelo.'
    }
  ],
  [
    'security.cors.maxAgeSeconds',
    {
      motivo: MOTIVOS.conDefault,
      porque: 'model.js aplica 3600 si falta; declararlo cambia el número emitido, no el camino que lo emite.'
    }
  ],
  [
    'messaging.subscriptions.*.contract.schemaRef',
    {
      motivo: MOTIVOS.informativo,
      porque: 'solo añade el nombre del schema a una línea de javadoc del listener (messaging.js).'
    }
  ],
  [
    'dependencies.dependencies.*.contract.source',
    {
      motivo: MOTIVOS.informativo,
      porque: 'el propio schema lo declara informativo: ni la validación ni los generadores lo resuelven.'
    }
  ],
  [
    'dependencies.dependencies.*.needs.*.replica.onMiss.error',
    {
      motivo: MOTIVOS.soloCadenas,
      porque:
        'la rama `onMiss.action: fail` de una réplica, que ata el error del catálogo al Reader. ' +
        'dependencies.test.js la cubre con el modelo parcheado.'
    }
  ],
  [
    'dependencies.dependencies.*.needs.*.replica.onMiss.degradedTo',
    {
      motivo: MOTIVOS.soloCadenas,
      porque: 'la prosa de la rama `degrade` de esa misma réplica, cubierta igual por dependencies.test.js.'
    }
  ],
  [
    'dependencies.dependencies.*.activations.*.onFailure.degradedTo',
    {
      motivo: MOTIVOS.soloCadenas,
      porque:
        'la tercera rama del fallback del circuit breaker (`degrade` → TODO con la prosa citada). Las otras dos ' +
        '(`ignore`, `fail`) sí las declara alguna fixture; dependencies.test.js cubre esta con el modelo parcheado.'
    }
  ],
  [
    'mail.sender.address',
    {
      motivo: MOTIVOS.ramaHermana,
      porque:
        'remitente `source: fixed`. notification-mailer declara `data` para el remitente y `fixed` para el ' +
        'reply-to, así que las dos ramas de addressSource se compilan; lo que falta es la combinación.'
    }
  ],
  [
    'mail.replyTo.fallback',
    {
      motivo: MOTIVOS.ramaHermana,
      porque: 'la simétrica de la anterior: reply-to con `source: data`, cuya rama ya compila por el remitente.'
    }
  ]
]);

// ─────────────────────────────────────────────────────────────────────────────
// Enumerar las propiedades opcionales de un schema y, a la vez, cuántas fixtures las
// declaran. Se recorren schema y datos JUNTOS porque el camino de datos depende del schema:
// un `additionalProperties` es un mapa cuyas claves son nombres del diseño, no propiedades
// del DSL, y sin el schema delante no hay forma de distinguirlo de un objeto normal.

/** Sigue los `$ref` locales. Un `$ref` a otro archivo (common.schema.json) es una hoja. */
function resolveRef(schema, node, seen) {
  let current = node;
  while (current && current.$ref) {
    if (!current.$ref.startsWith('#/')) return null;
    if (seen.has(current.$ref)) return null;
    seen.add(current.$ref);
    current = current.$ref
      .slice(2)
      .split('/')
      .reduce((acc, key) => acc?.[key], schema);
  }
  return current;
}

/** Subesquemas que describen EL MISMO nodo de datos (allOf/anyOf/oneOf, then/else de un if). */
function branches(node) {
  const out = [node];
  for (const key of ['allOf', 'anyOf', 'oneOf']) for (const branch of node[key] ?? []) out.push(branch);
  for (const key of ['then', 'else']) if (node[key]) out.push(node[key]);
  return out;
}

function walk(schema, node, dataList, prefix, counts, seen) {
  const resolved = resolveRef(schema, node, new Set(seen));
  if (!resolved || typeof resolved !== 'object') return;
  for (const branch of branches(resolved)) {
    const current = branch === resolved ? resolved : resolveRef(schema, branch, new Set(seen));
    if (!current || typeof current !== 'object') continue;
    const required = new Set(current.required ?? []);
    for (const [key, sub] of Object.entries(current.properties ?? {})) {
      const dataPath = prefix ? `${prefix}.${key}` : key;
      const declared = dataList
        .filter((value) => value && typeof value === 'object' && value[key] !== undefined)
        .map((value) => value[key]);
      // La prosa queda fuera a propósito. Una `description` que el emisor lee acaba en un
      // javadoc, y un javadoc que falta no es la clase de defecto que esto persigue: lo que
      // se busca aquí es la rama de código que nadie compila.
      if (!required.has(key) && key !== 'description') {
        counts.set(dataPath, (counts.get(dataPath) ?? 0) + declared.length);
      }
      walk(schema, sub, declared, dataPath, counts, seen);
    }
    if (current.additionalProperties && typeof current.additionalProperties === 'object') {
      const values = dataList.flatMap((value) =>
        value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value) : []
      );
      walk(schema, current.additionalProperties, values, prefix ? `${prefix}.*` : '*', counts, seen);
    }
    if (current.items) {
      const values = dataList.flatMap((value) => (Array.isArray(value) ? value : []));
      walk(schema, current.items, values, `${prefix}[]`, counts, seen);
    }
  }
}

function fixtureLayers() {
  return fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const { layers, errors } = loadService(path.join(fixturesDir, entry.name));
      assert.deepEqual(errors, [], `la fixture ${entry.name} no carga`);
      return layers;
    });
}

/** path → número de fixtures que lo declaran. */
function coverage() {
  const counts = new Map();
  const loaded = fixtureLayers();
  for (const layer of LAYERS) {
    const schema = JSON.parse(fs.readFileSync(schemaPathFor(layer), 'utf8'));
    const data = loaded.map((layers) => layers[layer]).filter(Boolean);
    walk(schema, schema, data, layer, counts, new Set());
  }
  return counts;
}

const uncovered = () =>
  [...coverage()]
    .filter(([, declaradas]) => declaradas === 0)
    .map(([dataPath]) => dataPath)
    .sort();

test('toda capacidad opcional del DSL la declara alguna fixture, o EXCEPCIONES dice por qué no', () => {
  const sinAnotar = uncovered().filter((dataPath) => !EXCEPCIONES.has(dataPath));
  assert.deepEqual(
    sinAnotar,
    [],
    'estas capacidades no las declara ninguna fixture, así que su Java no lo compila nadie.\n' +
      'Declárala en una fixture (entra sola en java-syntax.test.js) o añade su fila a EXCEPCIONES con su motivo:\n  ' +
      sinAnotar.join('\n  ')
  );
});

test('EXCEPCIONES no acumula filas muertas', () => {
  const abiertas = new Set(uncovered());
  const muertas = [...EXCEPCIONES.keys()].filter((dataPath) => !abiertas.has(dataPath));
  assert.deepEqual(
    muertas,
    [],
    `ya hay fixture que declara esto: borra su fila de EXCEPCIONES.\n  ${muertas.join('\n  ')}`
  );
});

test('cada excepción declara un motivo de la tabla y lo explica', () => {
  for (const [dataPath, fila] of EXCEPCIONES) {
    assert.ok(Object.values(MOTIVOS).includes(fila.motivo), `${dataPath}: motivo desconocido '${fila.motivo}'`);
    assert.ok((fila.porque ?? '').length > 40, `${dataPath}: el motivo tiene que decir POR QUÉ, no solo etiquetarlo`);
  }
});

// El comprobador se comprueba a sí mismo. Un auditor que solo sale en verde no distingue «no
// hay huecos» de «no mira»: sin esto, un walker que dejara de descender por
// `additionalProperties` —donde viven casi todas las capacidades, porque el DSL indexa por
// nombre— saldría verde con la auditoría entera sin hacer.
test('el enumerador ve una propiedad opcional anidada bajo un mapa, y solo la da por cubierta si el dato la trae', () => {
  const schema = {
    type: 'object',
    properties: {
      clients: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string' },
            retries: { type: 'integer' },
            calls: { type: 'array', items: { type: 'object', properties: { idempotency: { type: 'object' } } } }
          }
        }
      }
    }
  };

  const vacio = new Map();
  walk(schema, schema, [{ clients: { a: { url: 'x' } } }], 'capa', vacio, new Set());
  assert.equal(vacio.get('capa.clients.*.retries'), 0);
  assert.equal(vacio.get('capa.clients.*.calls[].idempotency'), 0);
  // `url` es required: no es una capacidad que un diseño pueda dejar sin declarar.
  assert.ok(!vacio.has('capa.clients.*.url'));

  const lleno = new Map();
  walk(
    schema,
    schema,
    [{ clients: { a: { url: 'x', retries: 3, calls: [{ idempotency: {} }] } } }],
    'capa',
    lleno,
    new Set()
  );
  assert.equal(lleno.get('capa.clients.*.retries'), 1);
  assert.equal(lleno.get('capa.clients.*.calls[].idempotency'), 1);
});

test('el enumerador sigue los $ref locales y las ramas de un if/then', () => {
  const schema = {
    $defs: { politica: { type: 'object', properties: { onFailure: { type: 'string' } } } },
    type: 'object',
    properties: { need: { $ref: '#/$defs/politica' } },
    if: { properties: { need: {} } },
    then: { properties: { extra: { type: 'string' } } }
  };
  const counts = new Map();
  walk(schema, schema, [{}], 'capa', counts, new Set());
  assert.equal(counts.get('capa.need.onFailure'), 0);
  assert.equal(counts.get('capa.extra'), 0);
});
