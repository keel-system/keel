import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyMarkers,
  buildIndex,
  canonicalJson,
  detectEol,
  indexContract,
  renderIndexJson,
  renderTable,
  MARKER_START,
  MARKER_END
} from '../src/lib/design-index.js';
import { packageVersion, supportedDsl } from '../src/lib/assets.js';

// Versión vigente del DSL: derivada, no escrita. Solo se soporta una, y un literal
// aquí volvería a romper estos tests en el siguiente cambio de versión.
const DSL = supportedDsl()[0];

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const DOMAIN = 'entities:\n  Product:\n    fields:\n      id: { type: uuid, id: true }\n';
const USE_CASES = 'operations:\n  createProduct:\n    kind: command\n  listProducts:\n    kind: query\n';

/**
 * Monta un workspace de mentira. `designs` es un mapa slug → { version, domain,
 * description, layers, sidecar, docs }. `sidecar` se serializa como YAML a mano
 * para no depender del orden de claves de la librería.
 */
function workspace(designs, { readme = defaultReadme(), publish = null } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-index-'));
  write(path.join(cwd, 'schema', 'service.schema.json'), '{}'); // isKeelWorkspace
  write(path.join(cwd, 'README.md'), readme);
  if (publish !== null) write(path.join(cwd, 'publish.yaml'), publish);

  for (const [slug, spec] of Object.entries(designs)) {
    const {
      name = slug,
      version = '1.0.0',
      domain = 'commerce',
      description = `Diseño de referencia de ${slug} para las pruebas.`,
      layers = ['domain', 'use-cases'],
      sidecar = null,
      docs = {},
      manifest = null
    } = spec;
    const dir = path.join(cwd, 'specs', slug);

    write(
      path.join(dir, 'service.keel.yaml'),
      manifest ??
        [
          `keel: "${DSL}"`,
          'service:',
          `  name: ${name}`,
          `  version: ${version}`,
          `  description: ${description}`,
          `  domain: ${domain}`,
          'layers:',
          ...layers.map((layer) => `  ${layer}: ${layer}.keel.yaml`)
        ].join('\n')
    );

    const content = { domain: DOMAIN, 'use-cases': USE_CASES };
    for (const layer of layers) write(path.join(dir, `${layer}.keel.yaml`), content[layer] ?? '{}\n');

    if (sidecar) write(path.join(dir, 'design.yaml'), sidecar);
    for (const [file, body] of Object.entries(docs)) write(path.join(cwd, 'docs', name, file), body);
  }

  return cwd;
}

function defaultReadme() {
  return `# Diseños\n\nIntroducción escrita por un humano.\n\n${MARKER_START}\nplaceholder\n${MARKER_END}\n\n## Cómo trabajar aquí\n\nTexto final.\n`;
}

const sidecar = (fields) =>
  Object.entries(fields)
    .map(([key, value]) => (Array.isArray(value) ? `${key}: [${value.join(', ')}]` : `${key}: ${value}`))
    .join('\n') + '\n';

const bySlug = (index) => Object.fromEntries(index.designs.map((design) => [design.slug, design]));

test('un workspace sin diseños produce el texto de tabla vacía', () => {
  const cwd = workspace({});
  const index = buildIndex(cwd);

  assert.deepEqual(index.designs, []);
  assert.deepEqual(index.families, []);
  assert.match(renderTable(index), /Aún no hay servicios diseñados/);
});

test('sin sidecar, la familia es el propio slug y el resumen sale de la description', () => {
  const cwd = workspace({ catalog: { description: 'Gestiona el catálogo comercial de productos.' } });
  const index = buildIndex(cwd);
  const design = bySlug(index).catalog;

  assert.equal(design.family, 'catalog');
  assert.equal(design.variant, null);
  assert.equal(design.metadata, null);
  assert.deepEqual(index.families, [{ name: 'catalog', designs: ['catalog'] }]);
  assert.match(renderTable(index), /Gestiona el catálogo comercial de productos\./);
});

test('las variantes de una familia se agrupan y se ordenan por madurez', () => {
  const cwd = workspace({
    'notifications-push-only': {
      sidecar: sidecar({ family: 'notifications', variant: 'push-only', summary: 'Solo push, sin persistencia.', maturity: 'draft' })
    },
    'notifications-multichannel': {
      sidecar: sidecar({
        family: 'notifications',
        variant: 'multichannel',
        summary: 'Email, SMS y push con plantillas versionadas.',
        differsIn: 'Añade SMS y push sobre email, con outbox por canal.',
        maturity: 'reference'
      })
    },
    'notifications-email-digest': {
      sidecar: sidecar({ family: 'notifications', variant: 'email-digest', summary: 'Agregación diaria por email.', maturity: 'stable' })
    }
  });
  const index = buildIndex(cwd);

  assert.deepEqual(index.families, [
    {
      name: 'notifications',
      designs: ['notifications-multichannel', 'notifications-email-digest', 'notifications-push-only']
    }
  ]);
  assert.deepEqual(index.warnings, []);

  const table = renderTable(index);
  assert.match(table, /\| 3 variantes \| ver abajo \|/);
  assert.match(table, /### notifications — 3 variantes/);
  assert.match(table, /\[notifications\]\(#notifications--3-variantes\)/);
  // La variante de referencia representa a la familia en la fila principal.
  assert.match(table, /Email, SMS y push con plantillas versionadas\./);
  assert.match(table, /Añade SMS y push sobre email/);
});

test('una familia de un solo diseño ocupa una fila y no genera subtabla', () => {
  const cwd = workspace({
    order: { sidecar: sidecar({ summary: 'Ciclo de vida del pedido con compensación.', maturity: 'stable' }) }
  });
  const table = renderTable(buildIndex(cwd));

  assert.match(table, /\[`order`\]\(specs\/order\/\)/);
  assert.doesNotMatch(table, /### /);
  assert.match(table, /estable/);
});

test('family distinta del slug sin variant se deduce del slug y avisa', () => {
  const cwd = workspace({
    'notifications-email': { sidecar: sidecar({ family: 'notifications', summary: 'Solo correo electrónico.', maturity: 'draft' }) },
    'notifications-sms': { sidecar: sidecar({ family: 'notifications', summary: 'Solo mensajería SMS.', maturity: 'draft' }) }
  });
  const index = buildIndex(cwd);

  assert.equal(bySlug(index)['notifications-email'].variant, 'email');
  assert.equal(index.warnings.length, 2);
  assert.match(index.warnings[0], /no variant — se asume 'email'/);
});

test('un sidecar que no cumple el schema no tumba el índice: avisa y el diseño entra sin metadatos', () => {
  const cwd = workspace({
    catalog: { sidecar: sidecar({ summary: 'Resumen suficientemente largo.', maturity: 'legendario' }) }
  });
  const index = buildIndex(cwd);

  assert.equal(index.designs.length, 1);
  assert.equal(bySlug(index).catalog.metadata, null);
  assert.equal(index.warnings.length, 1);
  assert.match(index.warnings[0], /design\.yaml: no cumple design\.schema\.json/);
});

test('un sidecar con campos desconocidos se rechaza', () => {
  const cwd = workspace({
    catalog: { sidecar: sidecar({ summary: 'Resumen suficientemente largo.', maturity: 'stable', precio: 42 }) }
  });
  const index = buildIndex(cwd);

  assert.equal(index.warnings.length, 1);
  assert.match(index.warnings[0], /precio/);
});

test('un diseño que no carga se omite del índice con un aviso, sin tumbar el resto', () => {
  const cwd = workspace({ catalog: {}, roto: {} });
  fs.writeFileSync(path.join(cwd, 'specs', 'roto', 'service.keel.yaml'), 'keel: "2.3"\nservice: [');
  const index = buildIndex(cwd);

  assert.deepEqual(
    index.designs.map((design) => design.slug),
    ['catalog']
  );
  assert.equal(index.warnings.length, 1);
  assert.match(index.warnings[0], /specs\/roto: no carga/);
});

test('service.name distinto del directorio avisa por colisión de derivados', () => {
  const cwd = workspace({ 'notifications-multichannel': { name: 'notifications' } });
  const index = buildIndex(cwd);

  assert.equal(index.warnings.length, 1);
  assert.match(index.warnings[0], /docs\/notifications\/ y colisionarían/);
});

test('los recuentos y las capas describen el contenido del diseño', () => {
  const cwd = workspace({ catalog: {} });
  const design = bySlug(buildIndex(cwd)).catalog;

  assert.deepEqual(design.layers, ['domain', 'use-cases']);
  assert.equal(design.counts.entities, 1);
  assert.equal(design.counts.operations, 2);
  assert.equal(design.counts.commands, 1);
  assert.equal(design.counts.queries, 1);
  assert.equal(design.service.dsl, DSL);
  assert.equal(design.service.version, '1.0.0');
});

test('files lista el manifiesto, las capas, el sidecar y los derivados que existen', () => {
  const cwd = workspace({
    catalog: {
      sidecar: sidecar({ summary: 'Resumen suficientemente largo.', maturity: 'stable' }),
      docs: { 'DESIGN.md': '> specs/catalog v1.0.0. Ficha.\n' }
    }
  });
  const design = bySlug(buildIndex(cwd)).catalog;

  assert.deepEqual(design.files, [
    'specs/catalog/service.keel.yaml',
    'specs/catalog/domain.keel.yaml',
    'specs/catalog/use-cases.keel.yaml',
    'specs/catalog/design.yaml',
    'docs/catalog/DESIGN.md'
  ]);
  assert.equal(design.docs.design, 'docs/catalog/DESIGN.md');
  assert.equal(design.docs.overview, null);
});

test('files publica todas las colecciones Postman, no solo la que el catálogo de derivados sella', () => {
  const cwd = workspace({
    catalog: {
      layers: ['domain', 'use-cases', 'api'],
      docs: {
        'postman/catalog-collection.json': JSON.stringify({ variable: [{ key: 'keelVersion', value: '1.0.0' }] }),
        'postman/auth-collection.json': '{}',
        'postman/notas.md': 'no es una colección'
      }
    }
  });
  const design = bySlug(buildIndex(cwd)).catalog;
  const postman = design.files.filter((file) => file.includes('/postman/'));

  // auth-collection.json es salida de /keel-docs igual que la del servicio, pero
  // no es un derivado sellado: sin el barrido no llegaría a quien deriva. Primero
  // van los derivados del catálogo y luego el barrido, ordenado: orden estable.
  assert.deepEqual(postman, ['docs/catalog/postman/catalog-collection.json', 'docs/catalog/postman/auth-collection.json']);
  // Sin duplicar la que el catálogo ya listó, y sin colar lo que no es colección.
  assert.equal(design.files.filter((file) => file.endsWith('catalog-collection.json')).length, 1);
  assert.equal(design.files.some((file) => file.endsWith('notas.md')), false);
});

test('sin directorio postman/, files no cambia', () => {
  const cwd = workspace({ catalog: { docs: { 'DESIGN.md': '> specs/catalog v1.0.0. Ficha.\n' } } });
  const design = bySlug(buildIndex(cwd)).catalog;

  assert.equal(design.files.some((file) => file.includes('/postman/')), false);
});

test('la columna de documentación solo enlaza derivados que existen', () => {
  const cwd = workspace({
    catalog: { docs: { 'DESIGN.md': '> specs/catalog v1.0.0. Ficha.\n', 'overview.html': '<!-- keel:version 1.0.0 -->\n' } }
  });
  const table = renderTable(buildIndex(cwd));

  assert.match(table, /\[diseño\]\(docs\/catalog\/DESIGN\.md\)/);
  assert.match(table, /\[panel\]\(docs\/catalog\/overview\.html\)/);
  assert.doesNotMatch(table, /INTEGRATION\.md/);
});

// Los visores de los contratos formales: /keel-docs los genera y hasta ahora no
// llegaban a la portada, que es el único punto de entrada de un registry.
const VIEWERS = {
  'DESIGN.md': '> specs/catalog v1.0.0. Ficha.\n',
  'overview.html': '<!-- keel:version 1.0.0 -->\n',
  'openapi.html': '<!-- keel:version 1.0.0 -->\n',
  'asyncapi.html': '<!-- keel:version 1.0.0 -->\n'
};
const withViewers = { catalog: { layers: ['domain', 'use-cases', 'api', 'messaging'], docs: VIEWERS } };

test('la columna de documentación enlaza también los visores de los contratos formales', () => {
  const index = buildIndex(workspace(withViewers));
  const design = bySlug(index).catalog;

  assert.equal(design.docs.openapiViewer, 'docs/catalog/openapi.html');
  assert.equal(design.docs.asyncapiViewer, 'docs/catalog/asyncapi.html');

  const table = renderTable(index);
  assert.match(table, /\[API\]\(docs\/catalog\/openapi\.html\)/);
  assert.match(table, /\[eventos\]\(docs\/catalog\/asyncapi\.html\)/);
});

test('un diseño sin capa messaging no enlaza el visor de eventos', () => {
  const cwd = workspace({ catalog: { layers: ['domain', 'use-cases', 'api'], docs: VIEWERS } });
  const design = bySlug(buildIndex(cwd)).catalog;

  // El archivo está en disco, pero el derivado no aplica: es un huérfano, no un enlace.
  assert.equal(design.docs.asyncapiViewer, null);
  assert.doesNotMatch(renderTable(buildIndex(cwd)), /\[eventos\]/);
});

test('con publish.yaml, los HTML se enlazan por htmlpreview y los markdown siguen en relativo', () => {
  const cwd = workspace(
    { catalog: { layers: ['domain', 'use-cases', 'api', 'messaging'], docs: VIEWERS } },
    { publish: 'repo: keel-system/keel-registry\nbranch: main\n' }
  );
  const table = renderTable(buildIndex(cwd));
  const base = 'https://htmlpreview.github.io/?https://raw.githubusercontent.com/keel-system/keel-registry/main';

  assert.ok(table.includes(`[panel](${base}/docs/catalog/overview.html)`));
  assert.ok(table.includes(`[API](${base}/docs/catalog/openapi.html)`));
  assert.ok(table.includes(`[eventos](${base}/docs/catalog/asyncapi.html)`));
  // GitHub renderiza los .md por sí solo y en relativo funcionan además en local.
  assert.match(table, /\[diseño\]\(docs\/catalog\/DESIGN\.md\)/);
});

test('publish.yaml sin branch asume main', () => {
  const cwd = workspace(withViewers, { publish: 'repo: acme/designs\n' });

  assert.deepEqual(buildIndex(cwd).publish, { repo: 'acme/designs', branch: 'main' });
  assert.match(renderTable(buildIndex(cwd)), /raw\.githubusercontent\.com\/acme\/designs\/main\//);
});

test('un publish.yaml inválido avisa y cae a enlaces relativos, sin tumbar el índice', () => {
  for (const [body, expected] of [
    ['branch: main\n', /must have required property 'repo'/],
    ['repo: sin-barra\n', /must match pattern/],
    ['repo: acme/designs\ntag: v1\n', /propiedad no reconocida 'tag'/],
    ['repo: [\n', /YAML inválido/]
  ]) {
    const index = buildIndex(workspace(withViewers, { publish: body }));

    assert.equal(index.publish, null);
    assert.equal(index.designs.length, 1, `el índice se construye igual con: ${body}`);
    assert.match(index.warnings.join('\n'), /^publish\.yaml: /m);
    assert.match(index.warnings.join('\n'), expected);
    assert.match(renderTable(index), /\[panel\]\(docs\/catalog\/overview\.html\)/);
  }
});

test('publish es config de renderizado: ni viaja a index.json ni cuenta para --check', () => {
  const publish = 'repo: keel-system/keel-registry\n';
  const conPublish = buildIndex(workspace(withViewers, { publish }));
  const sinPublish = buildIndex(workspace(withViewers));

  assert.equal(JSON.parse(renderIndexJson(conPublish)).publish, undefined);
  // Las claves nuevas de docs sí son contenido del catálogo y sí viajan.
  assert.equal(
    JSON.parse(renderIndexJson(conPublish)).designs[0].docs.openapiViewer,
    'docs/catalog/openapi.html'
  );
  assert.equal(canonicalJson(indexContract(conPublish)), canonicalJson(indexContract(sinPublish)));
});

test('applyMarkers reemplaza solo la región marcada y preserva el resto', () => {
  const cwd = workspace({ catalog: {} });
  const readme = fs.readFileSync(path.join(cwd, 'README.md'), 'utf8');
  const { text } = applyMarkers(readme, renderTable(buildIndex(cwd)));

  assert.match(text, /^# Diseños\n\nIntroducción escrita por un humano\./);
  assert.match(text, /## Cómo trabajar aquí\n\nTexto final\.\n$/);
  assert.doesNotMatch(text, /placeholder/);
  assert.ok(text.includes(MARKER_START) && text.includes(MARKER_END));
});

test('applyMarkers es idempotente: aplicar dos veces no cambia nada', () => {
  const cwd = workspace({ catalog: {}, order: {} });
  const table = renderTable(buildIndex(cwd));
  const once = applyMarkers(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8'), table).text;
  const twice = applyMarkers(once, table).text;

  assert.equal(once, twice);
  // Y una fila por diseño, sin duplicar.
  assert.equal(once.match(/\| \[`catalog`\]/g).length, 1);
});

test('applyMarkers respeta el fin de línea dominante del archivo (CRLF)', () => {
  const crlf = defaultReadme().replace(/\n/g, '\r\n');
  const cwd = workspace({ catalog: {} }, { readme: crlf });
  const table = renderTable(buildIndex(cwd));
  const { text } = applyMarkers(crlf, table);

  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/, 'no debe quedar ningún LF suelto');
  assert.equal(applyMarkers(text, table).text, text, 'debe converger en CRLF');
});

test('sin marcadores, applyMarkers devuelve un error accionable en vez de escribir', () => {
  const { error, text } = applyMarkers('# Sin marcadores\n', 'tabla');

  assert.equal(text, undefined);
  assert.match(error, /no tiene los marcadores/);
  assert.match(error, /keel:servicios:start/);
});

test('los marcadores invertidos se detectan', () => {
  const { error } = applyMarkers(`${MARKER_END}\n${MARKER_START}\n`, 'tabla');

  assert.match(error, /aparece antes de/);
});

test('el índice registra su procedencia: qué keel-core lo generó y qué DSL soportaba', () => {
  const cwd = workspace({ catalog: {} });
  const index = buildIndex(cwd);

  assert.equal(index.generatedBy.keelCore, packageVersion());
  assert.deepEqual(index.generatedBy.dsl, [...supportedDsl()]);
  assert.equal(JSON.parse(renderIndexJson(index)).generatedBy.keelCore, packageVersion());
});

test('indexContract() excluye la procedencia y los avisos, no el contenido', () => {
  const cwd = workspace({ catalog: {}, order: {} });
  const contract = indexContract(buildIndex(cwd));

  assert.equal(contract.generatedBy, undefined);
  assert.equal(contract.warnings, undefined);
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.designs.length, 2);
  assert.ok(contract.families);
});

test('dos índices que solo difieren en la procedencia tienen el mismo contrato', () => {
  // Es lo que impide que cada release de keel-core ponga en rojo el CI de todos
  // los registries hasta que alguien reindexe.
  const cwd = workspace({ catalog: {} });
  const index = buildIndex(cwd);
  const otraVersion = { ...index, generatedBy: { keelCore: '99.0.0', dsl: ['2.0'] } };

  assert.notEqual(canonicalJson(index), canonicalJson(otraVersion));
  assert.equal(canonicalJson(indexContract(index)), canonicalJson(indexContract(otraVersion)));
});

test('un cambio real de contenido sí cambia el contrato', () => {
  const cwd = workspace({ catalog: { version: '1.0.0' } });
  const antes = canonicalJson(indexContract(buildIndex(cwd)));

  const manifest = path.join(cwd, 'specs', 'catalog', 'service.keel.yaml');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace('1.0.0', '2.0.0'));

  assert.notEqual(canonicalJson(indexContract(buildIndex(cwd))), antes);
});

test('canonicalJson ordena claves, así que el orden de escritura no provoca falsos positivos', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
  // El orden de un array sí es significativo (las variantes de una familia van ordenadas).
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson(undefined), 'null');
  assert.equal(canonicalJson({ a: [{ y: 1, x: 2 }] }), canonicalJson({ a: [{ x: 2, y: 1 }] }));
});

test('index.json es estable entre ejecuciones y no incluye los avisos', () => {
  const cwd = workspace({ catalog: {}, order: {} });
  const first = renderIndexJson(buildIndex(cwd));
  const second = renderIndexJson(buildIndex(cwd));

  assert.equal(first, second);
  const parsed = JSON.parse(first);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.warnings, undefined);
  assert.deepEqual(
    parsed.designs.map((design) => design.slug),
    ['catalog', 'order']
  );
  assert.ok(first.endsWith('\n'));
});

test('index.json se puede emitir en CRLF, para converger donde git dejó el archivo así', () => {
  // Con core.autocrlf=true git deja index.json en CRLF en el working copy de
  // Windows. Emitir LF a ciegas dejaría `--check` en rojo permanente.
  const cwd = workspace({ catalog: {} });
  const index = buildIndex(cwd);
  const lf = renderIndexJson(index);
  const crlf = renderIndexJson(index, { eol: '\r\n' });

  assert.equal(detectEol(lf), '\n');
  assert.equal(detectEol(crlf), '\r\n');
  assert.doesNotMatch(crlf.replace(/\r\n/g, ''), /\n/, 'no debe quedar ningún LF suelto');
  assert.deepEqual(JSON.parse(crlf), JSON.parse(lf), 'el contenido no cambia, solo el fin de línea');
  assert.equal(renderIndexJson(index, { eol: detectEol(crlf) }), crlf, 'debe converger');
});

test('detectEol reconoce el fin de línea dominante', () => {
  assert.equal(detectEol('a\r\nb\r\n'), '\r\n');
  assert.equal(detectEol('a\nb\n'), '\n');
  assert.equal(detectEol(''), '\n');
  assert.equal(detectEol(null), '\n');
});

test('un cambio de versión del diseño cambia el índice: es lo que detecta --check', () => {
  const cwd = workspace({ catalog: { version: '1.0.0' } });
  const before = renderIndexJson(buildIndex(cwd));

  const manifest = path.join(cwd, 'specs', 'catalog', 'service.keel.yaml');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace('1.0.0', '2.0.0'));

  assert.notEqual(renderIndexJson(buildIndex(cwd)), before);
});

test('los pipes de una description no rompen la tabla', () => {
  const cwd = workspace({ catalog: { description: 'Gestiona productos | marcas y categorías.' } });
  const row = renderTable(buildIndex(cwd))
    .split('\n')
    .find((line) => line.includes('`catalog`'));

  assert.match(row, /Gestiona productos \\\| marcas y categorías\./);
  assert.equal(row.split(/(?<!\\)\|/).length - 1, 7, 'una fila de 6 columnas tiene 7 separadores');
});
