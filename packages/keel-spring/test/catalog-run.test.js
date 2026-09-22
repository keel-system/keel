// Lo que la corrida `catalog` (2026-09-21) tuvo que escribir a mano y ahora sale de build.
//
// La corrida cerró 27/27, pero el diff de una regeneración limpia contra su árbol final dio 85
// archivos de build reescritos por el agente. Casi todos venían de tres convenciones de
// determinación que el diseño solo podía decir en prosa —omitir nulos, rechazar decimales de
// más, ignorar mayúsculas y acentos— y que el DSL 2.14 hizo declarables. El resto eran huecos
// del generador: el arnés sin forma de omitir la `Idempotency-Key`, los confirms de RabbitMQ
// que el outbox necesita y la unicidad condicionada con un mensaje falso. Y uno de proceso: el
// orquestador editó el diseño, que el sello del snapshot impide ahora sin depender de la prosa.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { SPECS_SEAL_FILE, writeSpecsSeal } from '../src/lib/specs-seal.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function scaffold(fixture, { patch, stack, manifestPatch } = {}) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  const patchedManifest = structuredClone(manifest);
  if (patch) patch(patched);
  if (manifestPatch) manifestPatch(patchedManifest);
  const workspace = tmpDir('keel-catalog-run-');
  const result = scaffoldService({ manifest: patchedManifest, layers: patched, workspace, force: true, stack });
  const root = path.join(workspace, 'services', `${manifest.service.name}-spring`);
  const all = (dir = root) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? all(path.join(dir, e.name)) : [path.join(dir, e.name)]
    );
  const find = (suffix) => {
    const hit = all().find((file) => file.split(path.sep).join('/').endsWith(suffix));
    assert.ok(hit, `no se generó ningún archivo que acabe en ${suffix}`);
    return fs.readFileSync(hit, 'utf8');
  };
  return { result, root, find, all };
}

// ─── conventions.nulls ─────────────────────────────────────────────────────────

test('conventions.nulls: omit pone @JsonInclude(NON_NULL) en respuestas y eventos, y solo ahí', () => {
  const { find } = scaffold('catalog-extended');
  assert.match(find('/application/dtos/GetProductBySlugResponseDto.java'), /@JsonInclude\(JsonInclude\.Include\.NON_NULL\)\npublic record/);
  assert.match(find('IntegrationEvent.java'), /@JsonInclude\(JsonInclude\.Include\.NON_NULL\)\npublic record/);
  // El cuerpo de error tiene forma fija: la convención no lo alcanza.
  assert.doesNotMatch(find('/infrastructure/rest/ErrorResponse.java'), /JsonInclude\.Include\.NON_NULL/);

  // Sin la convención, nada: el default de Jackson (los nulos viajan) es el que no prejuzga.
  const sin = scaffold('catalog-extended', { manifestPatch: (m) => delete m.conventions });
  assert.doesNotMatch(sin.find('/application/dtos/GetProductBySlugResponseDto.java'), /JsonInclude/);
});

// ─── constraints.scalePolicy ───────────────────────────────────────────────────

test('scalePolicy: reject pone @Digits en la entrada, con la parte entera de la columna', () => {
  const { find } = scaffold('metering-digest');
  const command = find('/application/commands/RecordReadingCommand.java');
  // 19 de precisión (la del @Column) menos 3 de escala.
  assert.match(command, /@Digits\(integer = 16, fraction = 3\) BigDecimal consumptionKwh/);
  assert.ok(command.includes('import jakarta.validation.constraints.Digits;'));
});

test('scalePolicy: round redondea el decimal escalar en el constructor del mensaje, no en la columna', () => {
  const { find } = scaffold('metering-digest', {
    patch: (layers) => {
      layers['use-cases'].operations.recordReading.input.fields.consumptionKwh.constraints.scalePolicy = 'round';
    }
  });
  const command = find('/application/commands/RecordReadingCommand.java');
  assert.doesNotMatch(command, /@Digits/, 'redondear y rechazar son excluyentes');
  assert.match(command, /public RecordReadingCommand \{\n\s+if \(consumptionKwh != null\) \{\n\s+consumptionKwh = consumptionKwh\.setScale\(3, RoundingMode\.HALF_UP\);/);
});

test('scalePolicy: reject en un value object compuesto rechaza en su constructor antes de normalizar', () => {
  const { find } = scaffold('product-catalog', {
    patch: (layers) => {
      layers.domain.types.Money.fields.amount.constraints.scalePolicy = 'reject';
    }
  });
  const money = find('/domain/valueobject/Money.java');
  assert.match(money, /amount\.stripTrailingZeros\(\)\.scale\(\) > 2/);
  // Y la normalización sigue: 19.9 entra y sale como 19.90.
  assert.match(money, /amount = amount\.setScale\(2, RoundingMode\.HALF_UP\);/);
  // Con round (lo que declara la fixture) no hay rechazo.
  assert.doesNotMatch(scaffold('product-catalog').find('/domain/valueobject/Money.java'), /stripTrailingZeros/);
});

// ─── compare / match ───────────────────────────────────────────────────────────

test('compare en un campo único: sombra plegada, constraint sobre ella y el adaptador la estampa', () => {
  const { find } = scaffold('catalog-extended');
  const jpa = find('/infrastructure/persistence/entities/CategoryJpa.java');
  assert.match(jpa, /uk_categories_natural", columnNames = \{ "slug_normalized" \}/);
  assert.match(jpa, /@Column\(name = "slug_normalized", nullable = false\)\n\s+private String slugNormalized;/);
  const adapter = find('/infrastructure/persistence/repositories/CategoryRepositoryImpl.java');
  assert.match(adapter, /jpa\.setSlugNormalized\(TextFold\.foldCase\(domain\.getSlug\(\)\)\);/);
  const fold = find('/infrastructure/persistence/support/TextFold.java');
  assert.match(fold, /Locale\.ROOT/);
  assert.match(fold, /Normalizer\.Form\.NFD/);
  // Sin compare no hay sombra ni TextFold.
  const sin = scaffold('stock-reservation');
  assert.ok(!sin.all().some((file) => file.endsWith('TextFold.java')));
});

test('compare en la rama documental: el índice único va sobre la sombra, igual que en relacional', () => {
  const { find } = scaffold('notification-mailer-mongo', {
    patch: (layers) => {
      layers.domain.entities.Application.fields.key.compare = 'ignore-case';
    }
  });
  const document = find('/ApplicationDocument.java');
  assert.match(document, /@Field\(name = "key_normalized"\)\n\s+private String keyNormalized;/);
  assert.match(
    find('/MongoIndexConfig.java'),
    /\.on\("key_normalized", Sort\.Direction\.ASC\)\s+\.unique\(\)\s+\.named\("uk_applications_natural"\)/
  );
  assert.match(find('/ApplicationRepositoryImpl.java'), /doc\.setKeyNormalized\(TextFold\.foldCase\(domain\.getKey\(\)\)\);/);
});

test('un filtro con match/compare deja su nota en el handler, con o sin sombra', () => {
  const sinSombra = scaffold('catalog-extended').find('/ListProductsQueryHandler.java');
  assert.match(sinSombra, /Filtro name \(match: contains, compare: ignore-case-accents\): contiene ignorando mayúsculas y acentos/);
  const conSombra = scaffold('catalog-extended', {
    patch: (layers) => {
      layers.domain.entities.Product.fields.name.compare = 'ignore-case-accents';
    }
  }).find('/ListProductsQueryHandler.java');
  assert.match(conSombra, /TextFold\.foldCaseAndAccents\(\.\.\.\) y compáralo contra Product\.nameNormalized/);
});

// ─── unicidad condicionada ─────────────────────────────────────────────────────

test('unicidad condicionada: el code se busca por la condición y, sin él, es una carrera con el mensaje del índice', () => {
  // notification-mailer declara TEMPLATE_ALREADY_ACTIVE: la familia de la condición (ACTIVE) lo encuentra.
  const declarado = scaffold('notification-mailer').find('/ApiExceptionHandler.java');
  assert.match(declarado, /"uk_templates_application_key_locale", \(\) -> new TemplateAlreadyActiveError\(/);

  // Sin él: CONCURRENT_MODIFICATION y la description del índice, nunca «Ya existe un X con ese campo».
  const sinCode = scaffold('notification-mailer', {
    patch: (layers) => {
      for (const op of Object.values(layers['use-cases'].operations)) {
        op.errors = (op.errors ?? []).filter((error) => error.code !== 'TEMPLATE_ALREADY_ACTIVE');
      }
    }
  }).find('/ApiExceptionHandler.java');
  const entry = sinCode.slice(sinCode.indexOf('"uk_templates_application_key_locale"'));
  // El diseño declara su propio error de concurrencia: gana sobre el canónico.
  assert.match(entry.slice(0, 300), /new ConcurrentModificationError\(|"CONCURRENT_MODIFICATION", 409/);
  assert.match(entry.slice(0, 300), /Como máximo una versión activa por aplicación, clave e idioma; otra operación lo cambió a la vez, reintenta/);
  assert.doesNotMatch(entry.slice(0, 300), /Ya existe un Template/);
});

test('la familia de la condición exige nombrar las dos mitades: un code con el token y sentido contrario no vale', () => {
  // El caso de la corrida `catalog`: el índice «como máximo una imagen principal» se mapeaba a
  // MAIN_IMAGE_REQUIRED —que significa lo contrario— solo porque llevaba el token MAIN.
  const handler = scaffold('notification-mailer', {
    patch: (layers) => {
      for (const op of Object.values(layers['use-cases'].operations)) {
        op.errors = (op.errors ?? []).map((error) =>
          error.code === 'TEMPLATE_ALREADY_ACTIVE' ? { ...error, code: 'ACTIVE_TEMPLATE_REQUIRED' } : error
        );
      }
    }
  }).find('/ApiExceptionHandler.java');
  const entry = handler.slice(handler.indexOf('"uk_templates_application_key_locale"'), 0);
  const scoped = handler.slice(handler.indexOf('"uk_templates_application_key_locale"'));
  assert.doesNotMatch(scoped.slice(0, 300), /ActiveTemplateRequiredError/);
  assert.match(scoped.slice(0, 300), /new ConcurrentModificationError\(|"CONCURRENT_MODIFICATION", 409/);
  assert.equal(entry, '');
});

// ─── unicidad acotada a la colección ───────────────────────────────────────────

test('unicidad de una hija que incluye la relación al padre: es carrera, no «ya existe»', () => {
  const patch = (layers) => {
    layers.persistence.entities.ProductImage = {
      ...(layers.persistence.entities.ProductImage ?? { persisted: true }),
      indexes: [
        { fields: ['product', 'position'], unique: true, description: 'Dos imágenes del mismo producto no comparten posición.' }
      ]
    };
  };
  const handler = scaffold('catalog-extended', { patch }).find('/ApiExceptionHandler.java');
  const entry = handler.slice(handler.indexOf('"uk_product_images_product_position"'), handler.indexOf('"uk_product_images_product_position"') + 300);
  assert.match(entry, /"CONCURRENT_MODIFICATION", 409/);
  assert.match(entry, /Otra operación cambió product, position de ProductImage a la vez/);
  // Lo que NO puede salir: el code derivado de los campos, que manda a corregir una entrada correcta.
  assert.doesNotMatch(handler, /PRODUCT_IMAGE_PRODUCT_POSITION_ALREADY_EXISTS/);

  // Declarado, manda el diseño.
  const declarado = scaffold('catalog-extended', {
    patch: (layers) => {
      patch(layers);
      const op = Object.values(layers['use-cases'].operations).find((o) => (o.output?.entity ?? '') === 'Product');
      op.errors = [...(op.errors ?? []), { code: 'PRODUCT_POSITION_ALREADY_EXISTS', when: 'x', http: 409 }];
    }
  }).find('/ApiExceptionHandler.java');
  assert.match(declarado, /"uk_product_images_product_position", \(\) -> new ProductPositionAlreadyExistsError\(/);
});

// ─── arnés y broker ────────────────────────────────────────────────────────────

test('el arnés trae la llamada SIN Idempotency-Key cuando una operación usa client-key', () => {
  const harness = scaffold('catalog-extended').find('/AbstractFlowIT.java');
  assert.match(harness, /protected Response exchangeWithoutIdempotencyKey\(HttpMethod method, String path, String jsonBody, String token\) \{\n\s+return exchange\(method, path, jsonBody, token, null\);/);
});

test('RabbitMQ con outbox: build escribe los confirms que el dispatcher necesita, en los tres perfiles', () => {
  const { all } = scaffold('stock-reservation', { stack: { broker: 'rabbitmq' } });
  const perfiles = all().filter((file) => file.split(path.sep).join('/').match(/parameters\/(local|develop|production)\/rabbitmq\.yaml$/));
  assert.equal(perfiles.length, 3);
  for (const file of perfiles) {
    const yaml = fs.readFileSync(file, 'utf8');
    assert.match(yaml, /publisher-confirm-type: correlated\n\s+publisher-returns: true\n\s+template:\n\s+mandatory: true/);
  }
});

// ─── el sello del snapshot ─────────────────────────────────────────────────────

/** Ejecuta el bloque del sello DEL SCRIPT GENERADO sobre un proyecto fabricado. */
function runSeal(mutate) {
  const { root, find } = scaffold('stock-reservation');
  const script = find('/infra/score-scenarios.sh');
  const start = script.indexOf(`if [ -f "${SPECS_SEAL_FILE}" ]; then`);
  assert.notEqual(start, -1, 'el script generado ya no comprueba el sello');
  const end = script.indexOf('\nfi\n', start);
  const block = script.slice(start, end + 4);

  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'specs', 'validation-scenarios.md'), '# x\n\nEl primero es `p25`.\n');
  fs.writeFileSync(path.join(root, 'specs', 'service.keel.yaml'), 'keel: "2.15"\n');
  writeSpecsSeal(root);
  mutate?.(root);
  const runner = path.join(root, 'seal.sh');
  fs.writeFileSync(runner, `${block}\necho SELLO-OK\n`);
  return spawnSync('bash', ['seal.sh'], { cwd: root, encoding: 'utf8' });
}

test('score-scenarios.sh se niega a puntuar contra un snapshot editado, y un CRLF no lo rompe', () => {
  const intacto = runSeal();
  assert.equal(intacto.status, 0, intacto.stderr);
  assert.match(intacto.stdout, /SELLO-OK/);

  const editado = runSeal((root) =>
    fs.writeFileSync(path.join(root, 'specs', 'validation-scenarios.md'), '# x\n\nEl primero es `p6`.\n')
  );
  assert.equal(editado.status, 2);
  assert.match(editado.stdout, /DISEÑO: el snapshot specs\/ no es el que escribió keel-spring build: specs\/validation-scenarios\.md/);
  assert.match(editado.stdout, /hueco del DISEÑO: va a design-gaps.yaml/);

  // Un checkout con autocrlf no es una edición del diseño.
  const crlf = runSeal((root) =>
    fs.writeFileSync(path.join(root, 'specs', 'validation-scenarios.md'), '# x\r\n\r\nEl primero es `p25`.\r\n')
  );
  assert.equal(crlf.status, 0, crlf.stdout);
});

const CIERRE = String.fromCharCode(10) + '    }';

test('el arnés manda la Idempotency-Key también en DELETE', () => {
  const harness = scaffold('catalog-extended').find('/AbstractFlowIT.java');
  const from = harness.indexOf('private static boolean isMutation(');
  const body = harness.slice(from, harness.indexOf(CIERRE, from));
  // El conjunto entero, no solo el que faltaba: es lo que fija el contrato del arnés.
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(body.includes(`HttpMethod.${verb}.equals(method)`), verb);
  }
  // Y los que NO mutan siguen fuera: una lectura con Idempotency-Key no es el contrato.
  for (const verb of ['GET', 'HEAD', 'OPTIONS']) {
    assert.ok(!body.includes(`HttpMethod.${verb}.equals(method)`), verb);
  }
});

// ─── FK entre agregados ────────────────────────────────────────────────────────

test('las FK entre agregados salen del apéndice de export-schema.sh, con nombre estable', () => {
  const { find } = scaffold('catalog-extended');
  const script = find('/infra/export-schema.sh');
  assert.ok(script.includes('ALTER TABLE products ADD CONSTRAINT fk_products_category'), script);
  assert.ok(script.includes('FOREIGN KEY (category_id) REFERENCES categories (id);'), script);
  // La auto-referencia también es entre agregados: una categoría padre es otra instancia.
  assert.ok(script.includes('ALTER TABLE categories ADD CONSTRAINT fk_categories_parent'), script);

  // Sin error declarado NO se mapea: la lista de code que el generador pone por su cuenta
  // es cerrada, y «no puedes borrar el padre» no está en ella.
  assert.ok(!find('/ApiExceptionHandler.java').includes('fk_products_category'));

  // Declarado, la violación traduce a él.
  const declarado = scaffold('catalog-extended', {
    patch: (layers) => {
      layers['use-cases'].operations.deleteCategory = {
        description: 'Borra una categoría.',
        kind: 'command',
        input: { fields: { id: { type: 'uuid', required: true } } },
        output: 'void',
        errors: [
          { code: 'CATEGORY_HAS_PRODUCTS', when: 'La categoría tiene productos asociados.', http: 409 }
        ]
      };
    }
  }).find('/ApiExceptionHandler.java');
  assert.ok(
    declarado.includes('Map.entry("fk_products_category", () -> new CategoryHasProductsError('),
    declarado
  );
});

test('las FK de las asociaciones que sí existen llevan nombre explícito, no el hash de Hibernate', () => {
  const child = scaffold('catalog-extended').find('/ProductImageJpa.java');
  assert.ok(child.includes('foreignKey = @ForeignKey(name = "fk_product_images_product")'), child);
  assert.ok(child.includes('import jakarta.persistence.ForeignKey;'), child);
});
