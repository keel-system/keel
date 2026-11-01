// El almacenamiento de binarios de keel-go (tramo 13f), sobre el texto emitido:
//
//   · storage.yaml es el de keel-nest y keel-dotnet en los cuatro perfiles, con MinIO y con S3 (keel-core/gen/storage-config.js),
//     y SettingsFrom solo lee claves que ese YAML declara;
//   · la tabla de firmas de MatchesSignature es la neutral de keel-core, tipo a tipo y byte a byte;
//   · el puerto declara los métodos de lectura según la visibilidad de los buckets, y el adaptador del agente los mismos,
//     sin la cabecera de código generado y con un error por método;
//   · el handler de la subida recibe la política y el puerto con la nota en los nombres de Go; el de una respuesta con URL
//     pública, el puerto; el mapeo la compone; el arranque cablea el adaptador;
//   · la entrada multipart corta al doble del mayor maxSizeMb con el code del diseño, y el arnés sube y para el almacén;
//   · el SDK de S3 entra en go.mod solo con un almacén en el stack, y la skill keel-go-s3 con él;
//   · los sabotajes de go-check se siguen aplicando y nombran pruebas emitidas.
// Lo que EJECUTA el Go (la lectura multipart contra el enrutador real y la tabla de firmas) lo miden las pruebas emitidas
// api_test.go y bucket_policy_test.go en `npm run go-check`, falsadas con los sabotajes de test/helpers/storage-sabotages.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { CONTENT_SIGNATURES } from '@keel-system/keel-core/gen/content-signatures';
import { multipartFileLimitBytes } from '@keel-system/keel-core/gen/storage-config';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { GENERATED_HEADER } from '../src/lib/go-source.js';
import { MODULES } from '../src/lib/go-stack.js';
import { STORAGE_SABOTAGES, STORAGE_SUBJECT, applySabotage } from './helpers/storage-sabotages.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const WITH_STORAGE = ['asset-vault', 'catalog-extended'];
const PROFILES = ['local', 'develop', 'production', 'test'];

const plan = (name, planner = planService, storage = 'minio') => planner({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR, stack: { storage } });
const plans = new Map(WITH_STORAGE.map((name) => [name, plan(name)]));
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const uploads = (model) => model.services.flatMap((service) => service.operations).filter((operation) => operation.multipart);

function flatKeys(tree, prefix = '') {
  return Object.entries(tree ?? {}).flatMap(([key, value]) => (value && typeof value === 'object' ? flatKeys(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
}

test('storage.yaml es el de keel-nest y keel-dotnet en los cuatro perfiles, con MinIO y con S3, y SettingsFrom solo lee claves que declara', () => {
  for (const name of WITH_STORAGE) {
    for (const storage of ['minio', 's3']) {
      const files = plan(name, planService, storage).files;
      const nest = plan(name, planNest, storage).files;
      const dotnet = plan(name, planDotnet, storage).files;
      for (const profile of PROFILES) {
        const suffix = `config/parameters/${profile}/storage.yaml`;
        assert.ok(content(files, suffix), `${name}/${storage}/${profile}`);
        assert.equal(content(files, suffix), content(nest, suffix), `${name}/${storage}/${profile}: keel-nest`);
        assert.equal(content(files, suffix), content(dotnet, suffix), `${name}/${storage}/${profile}: keel-dotnet`);
      }
    }
    const { files, model } = plans.get(name);
    const declared = new Set(flatKeys(parseYaml(content(files, 'config/parameters/local/storage.yaml'))));
    const settings = content(files, 'internal/infrastructure/storage/settings.go');
    const read = [...settings.matchAll(/text\("(storage\.[^"]+)"/g)].map((match) => match[1]);
    const perBucket = [...settings.matchAll(/prefix ?\+ ?"([^"]+)"/g)].map((match) => match[1]);
    assert.ok(read.length >= 7, `${name}: ${read.join(', ')}`);
    assert.deepEqual([...new Set(perBucket)].sort(), ['allowed-content-types', 'bucket', 'max-size-mb', 'signed-url-ttl-seconds', 'visibility'], name);
    for (const key of read) assert.ok(declared.has(key), `${name}: SettingsFrom lee ${key}, que storage.yaml no declara`);
    for (const bucket of model.storage.buckets) {
      assert.match(settings, new RegExp(`s\\.Buckets\\["${bucket.name}"\\], err = bucketFrom\\(text, number, "${bucket.name}"\\)`), `${name}: ${bucket.name}`);
      for (const key of [...declared].filter((candidate) => candidate.startsWith(`storage.buckets.${bucket.name}.`))) {
        assert.ok(perBucket.includes(key.split('.').pop()), `${name}: ${key} no se lee`);
      }
    }
  }
});

test('la tabla de MatchesSignature es la neutral de keel-core, tipo a tipo y byte a byte', () => {
  const emitted = content(plans.get('asset-vault').files, 'internal/domain/bucket_policy.go');
  const rows = new Map([...emitted.matchAll(/^\t"([^"]+)": +\{(.*)\},$/gm)].map((match) => [match[1], match[2]]));
  assert.deepEqual([...rows.keys()].sort(), Object.keys(CONTENT_SIGNATURES).sort());
  for (const [mime, alternatives] of Object.entries(CONTENT_SIGNATURES)) {
    const parts = [...rows.get(mime).matchAll(/\{(\d+), \[\]byte\{([^}]*)\}\}/g)].map((match) => ({ offset: Number(match[1]), bytes: match[2].split(', ').map((hex) => Number(hex)) }));
    assert.deepEqual(parts, alternatives.flat(), mime);
  }
});

test('el puerto y el adaptador del agente declaran los métodos de lectura según la visibilidad; el adaptador va sin la cabecera', () => {
  const expectations = { 'asset-vault': { private: true, public: false }, 'catalog-extended': { private: false, public: true } };
  for (const [name, { files, model }] of plans) {
    const port = content(files, 'internal/domain/file_storage.go');
    const adapter = content(files, 'internal/infrastructure/storage/storage.go');
    assert.equal(model.storage.hasPrivateBucket, expectations[name].private, name);
    assert.equal(model.storage.hasPublicBucket, expectations[name].public, name);
    for (const [method, present] of [['Upload', true], ['Delete', true], ['Download', model.storage.hasPrivateBucket], ['SignedURL', model.storage.hasPrivateBucket], ['PublicURL', model.storage.hasPublicBucket]]) {
      assert.equal(new RegExp(`^\\t${method}\\(`, 'm').test(port), present, `${name}: el puerto y ${method}`);
      assert.equal(new RegExp(`^func \\(s \\*Storage\\) ${method}\\(`, 'm').test(adapter), present, `${name}: el adaptador y ${method}`);
    }
    assert.ok(!adapter.includes(GENERATED_HEADER), `${name}: el adaptador es del agente`);
    assert.match(adapter, /TODO \(agente\): Upload — skill keel-go-s3/);
    assert.match(adapter, /var _ domain\.FileStorage = \(\*Storage\)\(nil\)/);
    // Lo demás del paquete lo escribe build, sin un TODO.
    for (const file of ['settings.go', 'policies.go', 'client.go']) {
      const text = content(files, `internal/infrastructure/storage/${file}`);
      assert.ok(text.includes(GENERATED_HEADER) && !text.includes('TODO'), `${name}: ${file}`);
    }
    const policies = content(files, 'internal/domain/bucket_policy.go');
    for (const bucket of model.storage.buckets) {
      const constant = `Bucket${bucket.name[0].toUpperCase()}${bucket.name.slice(1)}`;
      assert.match(policies, new RegExp(`^\\t${constant} += "${bucket.name}"$`, 'm'), `${name}: ${bucket.name}`);
    }
  }
});

test('el handler de la subida recibe la política y el puerto con la nota en nombres de Go; el resto, solo si devuelve una URL pública', () => {
  for (const [name, { files, model }] of plans) {
    assert.ok(uploads(model).length > 0, name);
    for (const operation of uploads(model)) {
      const handler = content(files, `internal/application/${operation.handlerClass.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}.go`).replace(/\n\t\/\/ {3}/g, ' ');
      assert.match(handler, /storagePolicies domain\.StoragePolicies, fileStorage domain\.FileStorage/, `${name}: ${operation.name}`);
      assert.match(handler, /h\.storagePolicies\.ForBucket\(domain\.Bucket[A-Z]\w+\)/, `${name}: ${operation.name}`);
      assert.match(handler, /con AllowsSize\(tamaño\) → \w+ \(413\)/, `${name}: ${operation.name}`);
      assert.match(handler, /Después AllowsContent\(bytes, tipo declarado\)/, `${name}: ${operation.name}`);
    }
  }
  // catalog-extended: lo que devuelve un Product proyecta sus imágenes, con su URL pública; lo demás no recibe el puerto.
  const { files, model } = plans.get('catalog-extended');
  const useCases = content(files, 'internal/application/use_cases.go');
  const mappers = files.filter((file) => file.path.endsWith('_mapper.go')).map((file) => file.content).join('\n');
  let exposing = 0;
  for (const operation of model.services.flatMap((service) => service.operations).filter((op) => op.handlerClass)) {
    const signature = operation.responseDto ? mappers.split('\n').find((line) => line.startsWith(`func To${operation.responseDto.name}(`)) ?? '' : '';
    const exposes = operation.multipart || signature.includes('fileStorage domain.FileStorage');
    if (signature.includes('fileStorage domain.FileStorage')) exposing++;
    const wiring = useCases.split('\n').find((line) => line.includes(`New${operation.handlerClass}(`)) ?? '';
    assert.equal(wiring.includes('deps.FileStorage'), exposes, `${operation.name}: ${wiring.trim()}`);
  }
  assert.ok(exposing >= 2, 'catalog-extended devuelve Product con sus imágenes en varias operaciones');
  // Sin bucket público ni subida, nadie lo recibe: asset-vault solo en la subida.
  const vault = content(plans.get('asset-vault').files, 'internal/application/use_cases.go');
  assert.equal(vault.split('\n').filter((line) => line.includes('deps.FileStorage')).length, uploads(plans.get('asset-vault').model).length);
});

test('el 413 del caso de uso tiene centinela: el del diseño, o ErrFileTooLarge con el code canónico', () => {
  const catalog = content(plans.get('catalog-extended').files, 'internal/domain/errors.go');
  assert.match(catalog, /^var ErrFileTooLarge = &Error\{kind: KindPayloadTooLarge, code: "FILE_TOO_LARGE", status: 413\}$/m);
  const vault = plans.get('asset-vault');
  const declared = vault.model.errors.some((error) => /FILE_TOO_LARGE$/.test(error.code));
  assert.equal(content(vault.files, 'internal/domain/errors.go').split('\nvar ErrFileTooLarge = ').length, 2, declared ? 'el declarado, una vez' : 'el canónico');
});

test('el arranque cablea configuración, política, cliente y adaptador; el SDK de S3 solo con un almacén en el stack', () => {
  for (const [name, { files }] of plans) {
    const main = content(files, 'cmd/server/main.go');
    assert.match(main, /storageSettings, err := storage\.SettingsFrom\(cfg\)/, name);
    assert.match(main, /storageClient, err := storage\.NewClient\(ctx, storageSettings\)/, name);
    assert.match(main, /fileStorage := storage\.NewStorage\(storageClient, storageSettings, storagePolicies\)/, name);
    assert.match(main, /if err := fileStorage\.EnsureBuckets\(ctx\); err != nil \{/, name);
    assert.match(main, /StoragePolicies: +storagePolicies,\n\t\tFileStorage: +fileStorage,/, name);
    assert.match(content(files, 'go.mod'), new RegExp(`github\\.com/aws/aws-sdk-go-v2/service/s3 ${MODULES['github.com/aws/aws-sdk-go-v2/service/s3'].version.replaceAll('.', '\\.')}\\n`), name);
  }
  const { files } = planService({ ...loadService(path.join(FIXTURES_DIR, 'product-catalog')), workspace: FIXTURES_DIR });
  assert.ok(!files.some((file) => /storage|multipart|bucket_policy|file_storage/.test(file.path)), 'sin la capa no se emite nada de ella');
  assert.doesNotMatch(content(files, 'go.mod'), /aws-sdk-go-v2/);
});

test('la entrada multipart corta al doble del mayor maxSizeMb con el code del diseño, y el lector lee el formulario lo primero', () => {
  for (const [name, { files, model }] of plans) {
    const reading = content(files, 'internal/httpapi/multipart.go');
    assert.match(reading, new RegExp(`^const MultipartLimitBytes = ${multipartFileLimitBytes(model)}$`, 'm'), name);
    assert.equal(multipartFileLimitBytes(model), model.storage.maxSizeMb * 2 * 1024 * 1024, name);
    assert.match(reading, /fileTooLargeCode = "[A-Z_]+"/, name);
    assert.match(content(files, 'internal/httpapi/middleware.go'), /r\.Body = http\.MaxBytesReader\(w, r\.Body, bodyLimit\(r\)\)/, name);
    // La subida, antes que el tope del cuerpo: su 413 lo envuelve y lleva el code del diseño.
    const errors = content(files, 'internal/httpapi/errors.go');
    assert.ok(errors.indexOf('case errors.As(err, &upload):') < errors.indexOf('case errors.As(err, &tooLarge):'), name);
    const endpoints = files.filter((file) => file.path.endsWith('_endpoints.go')).map((file) => file.content).join('\n');
    for (const operation of uploads(model)) {
      const reader = endpoints.slice(endpoints.indexOf(`func read${operation.name[0].toUpperCase()}${operation.name.slice(1)}(`));
      const body = reader.slice(0, reader.indexOf('\n}\n'));
      assert.match(body, /^\tform, err := readMultipart\(r\)\n\tif err != nil \{\n\t\treturn msg, err\n\t\}\n\tr = form\.withFields\(r\)$/m, `${name}: ${operation.name}`);
      assert.ok(body.indexOf('readMultipart(r)') < (body.indexOf('r.PathValue(') === -1 ? Infinity : body.indexOf('r.PathValue(')), `${name}: ${operation.name} lee el formulario antes que la ruta`);
      assert.match(body, /form\.requirePart\("\w+"\)/, `${name}: ${operation.name}`);
    }
    // Las subidas se sirven y están en la tabla de rutas, sin cuerpo JSON.
    const routes = content(files, 'internal/httpapi/routes.go');
    for (const operation of uploads(model)) assert.match(routes, new RegExp(`\\{Operation: "${operation.name}", [^\\n]*handle: \\(\\*api\\)\\.${operation.name}\\}`), `${name}: ${operation.name}`);
    // La prueba emitida de la API trae los casos de la subida.
    const api = content(files, 'internal/httpapi/api_test.go');
    for (const test of ['TestUnaSubidaVaciaEchaEnFaltaLoPrimeroQueElMensajePideComoKeelSpring', 'TestUnCuerpoJSONEnUnaSubidaEs415', 'TestUnCuerpoQuePasaDelLimiteDeLaEntradaEs413ConElCodeDelDiseno', 'TestUnCuerpoPorTrozosQuePasaDelLimiteEs413ConElCodeDelDiseno', 'TestUnCuerpoMultipartCortadoEs400FileUnreadable']) {
      assert.match(api, new RegExp(`^func ${test}\\(t \\*testing\\.T\\)`, 'm'), `${name}: ${test}`);
    }
  }
});

test('el arnés sube con Upload y, con MinIO, para y levanta el almacén; con S3 no hay palanca', () => {
  for (const [name, { files }] of plans) {
    const harness = content(files, 'tests/integration/storage_test.go');
    assert.match(harness, /^func \(s \*Scenario\) Upload\(path string, file UploadPart, fields map\[string\]any, headers http\.Header\) \*Response \{$/m, name);
    assert.match(harness, /^func \(s \*Scenario\) StopStorage\(\) \{$/m, name);
    assert.match(harness, /^func \(s \*Scenario\) StartStorage\(\) \{$/m, name);
    assert.match(harness, /^const storageContainer = "[\w-]+-minio"$/m, name);
  }
  const s3 = content(plan('asset-vault', planService, 's3').files, 'tests/integration/storage_test.go');
  assert.doesNotMatch(s3, /StopStorage/);
  assert.match(s3, /func \(s \*Scenario\) Upload\(/);
});

test('la skill keel-go-s3 se instala con un almacén en el stack', () => {
  for (const [name, { files }] of plans) {
    for (const file of ['SKILL.md', 'references/implementation.md', 'references/troubleshooting.md']) {
      assert.ok(files.some((candidate) => candidate.path === `.claude/skills/keel-go-s3/${file}`), `${name}: ${file}`);
    }
  }
});

for (const sabotage of STORAGE_SABOTAGES) {
  test(`el sabotaje del almacenamiento ${sabotage.id} se sigue aplicando a lo emitido y nombra pruebas emitidas`, () => {
    const { files } = plan(STORAGE_SUBJECT);
    const file = files.find((candidate) => candidate.path === sabotage.file);
    assert.ok(file, `no se emite ${sabotage.file}`);
    assert.ok(applySabotage(sabotage, file.content), `${sabotage.file} ya no contiene lo que busca el sabotaje`);
    const emittedTests = files.filter((candidate) => candidate.path.endsWith('_test.go')).map((candidate) => candidate.content).join('\n');
    for (const name of [sabotage.fails, ...(sabotage.alsoFails ?? [])]) assert.match(emittedTests, new RegExp(`^func ${name}\\(t \\*testing\\.T\\)`, 'm'), name);
  });
}
