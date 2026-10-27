// El almacenamiento de binarios de keel-dotnet (incremento 13g), sobre el texto emitido:
//
//   · storage.yaml es el de keel-nest en los cuatro perfiles (keel-core/gen/storage-config.js), y StorageSettings solo lee
//     claves que ese YAML declara;
//   · la tabla de firmas de ContentSignature es la neutral de keel-core, tipo a tipo y byte a byte;
//   · el puerto declara los métodos de lectura según la visibilidad de los buckets, y el stub del agente los mismos;
//   · el handler de la subida recibe la política y el puerto con la nota en los nombres de C#; el mapper resuelve la URL
//     de un bucket público; el registro está en Program.cs y en la prueba del contenedor;
//   · la entrada multipart corta al doble del mayor maxSizeMb con el code del diseño, y el arnés sube y para el almacén.
// Lo que EJECUTA el C# (la lectura multipart contra el servidor en memoria: la parte que falta, el 415, el 413, el cuerpo
// cortado, la parte vacía y la subida completa) lo mide la prueba emitida ApiTests en `npm run cs-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { CONTENT_SIGNATURES } from '@keel-system/keel-core/gen/content-signatures';
import { multipartFileLimitBytes } from '@keel-system/keel-core/gen/storage-config';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const WITH_STORAGE = ['asset-vault', 'catalog-extended'];
const PROFILES = ['local', 'develop', 'production', 'test'];
const stack = (storage = 'minio') => ({ database: 'postgresql', broker: 'rabbitmq', cache: 'redis', storage });

const plan = (name, planner = planService, storage = 'minio') => planner({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR, stack: stack(storage) });
const plans = new Map(WITH_STORAGE.map((name) => [name, plan(name)]));
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

function flatKeys(tree, prefix = '') {
  return Object.entries(tree ?? {}).flatMap(([key, value]) => (value && typeof value === 'object' && !Array.isArray(value) ? flatKeys(value, `${prefix}${key}:`) : [`${prefix}${key}`]));
}

test('storage.yaml es el de keel-nest en los cuatro perfiles, con MinIO y con S3, y StorageSettings solo lee claves que declara', () => {
  for (const name of WITH_STORAGE) {
    for (const storage of ['minio', 's3']) {
      const { files } = plan(name, planService, storage);
      const nest = plan(name, planNest, storage).files;
      for (const profile of PROFILES) {
        const suffix = `config/parameters/${profile}/storage.yaml`;
        assert.ok(content(files, suffix), `${name}/${storage}/${profile}`);
        assert.equal(content(files, suffix), content(nest, suffix), `${name}/${storage}/${profile}`);
      }
    }
    const { files, model } = plans.get(name);
    const declared = new Set(flatKeys(parseYaml(content(files, 'config/parameters/local/storage.yaml'))));
    const settings = content(files, '/Storage/StorageSettings.cs');
    const read = [...settings.matchAll(/\(configuration, "([^"]+:[^"]+)"/g)].map((match) => match[1]);
    const perBucket = [...settings.matchAll(/prefix \+ "([^"]+)"/g)].map((match) => match[1]);
    assert.ok(read.length >= 7 && perBucket.length === 5, name);
    for (const key of read) assert.ok(declared.has(key), `${name}: StorageSettings lee ${key}, que storage.yaml no declara`);
    for (const bucket of model.storage.buckets) {
      assert.match(settings, new RegExp(`\\["${bucket.name}"\\] = Bucket\\(configuration, "${bucket.name}"\\)`), `${name}: ${bucket.name}`);
      // Lo que el YAML declara del bucket lo lee el prefijo (las opcionales pueden no estar).
      for (const key of [...declared].filter((k) => k.startsWith(`storage:buckets:${bucket.name}:`))) {
        assert.ok(perBucket.includes(key.split(':').pop()), `${name}: ${key} no se lee`);
      }
    }
  }
});

test('la tabla de ContentSignature es la neutral de keel-core, tipo a tipo y byte a byte', () => {
  const emitted = content(plans.get('asset-vault').files, '.Domain/Storage/ContentSignature.cs');
  const rows = new Map([...emitted.matchAll(/\["([^"]+)"\] = \[(.*)\],$/gm)].map((match) => [match[1], match[2]]));
  assert.deepEqual([...rows.keys()].sort(), Object.keys(CONTENT_SIGNATURES).sort());
  for (const [mime, alternatives] of Object.entries(CONTENT_SIGNATURES)) {
    const parts = [...rows.get(mime).matchAll(/new\((\d+), \[([^\]]*)\]\)/g)].map((match) => ({ offset: Number(match[1]), bytes: match[2].split(', ').map((hex) => Number(hex)) }));
    assert.deepEqual(parts, alternatives.flat(), mime);
  }
});

test('el puerto y el stub del agente declaran los métodos de lectura según la visibilidad de los buckets', () => {
  const expectations = { 'asset-vault': { private: true, public: false }, 'catalog-extended': { private: false, public: true } };
  for (const [name, { files, model }] of plans) {
    const port = content(files, '.Domain/Storage/IFileStorage.cs');
    const stub = content(files, '/Storage/S3FileStorage.cs');
    assert.equal(model.storage.hasPrivateBucket, expectations[name].private, name);
    assert.equal(model.storage.hasPublicBucket, expectations[name].public, name);
    for (const [method, present] of [['Upload', true], ['Delete', true], ['Download', model.storage.hasPrivateBucket], ['SignedUrl', model.storage.hasPrivateBucket], ['PublicUrl', model.storage.hasPublicBucket]]) {
      assert.equal(new RegExp(`\\b${method}\\(string bucket`).test(port), present, `${name}: el puerto y ${method}`);
      assert.equal(new RegExp(`public [\\w<>\\[\\]]+ ${method}\\(string bucket`).test(stub), present, `${name}: el stub y ${method}`);
    }
    assert.match(stub, /S3FileStorage\(StorageSettings settings, StoragePolicies policies\) : IFileStorage/);
    assert.match(stub, /TODO \(agente\): Upload — skills\/keel-dotnet-s3/);
    const policies = content(files, '.Domain/Storage/StoragePolicies.cs');
    for (const bucket of model.storage.buckets) {
      const constant = bucket.name[0].toUpperCase() + bucket.name.slice(1);
      assert.match(policies, new RegExp(`public const string ${constant} = "${bucket.name}";`), `${name}: ${bucket.name}`);
    }
  }
});

test('el handler de la subida recibe la política y el puerto, con la nota en los nombres de C#', () => {
  for (const [name, { files, model }] of plans) {
    const uploads = model.services.flatMap((s) => s.operations).filter((op) => op.multipart);
    assert.ok(uploads.length > 0, name);
    for (const operation of uploads) {
      // Las notas parten sus líneas: se leen de corrido.
      const handler = content(files, `/UseCases/${operation.handlerClass}.cs`).replace(/\n\s*\/\/\s+/g, ' ');
      assert.match(handler, /StoragePolicies storagePolicies, IFileStorage fileStorage\)/, `${name}: ${operation.name}`);
      assert.match(handler, /storagePolicies\.ForBucket\(StoragePolicies\.[A-Z]\w+\)/, `${name}: ${operation.name}`);
      assert.match(handler, /con AllowsSize\(tamaño\) → \w+ \(413\)/, `${name}: ${operation.name}`);
      assert.match(handler, /Después AllowsContent\(bytes, tipo declarado\)/, `${name}: ${operation.name}`);
    }
    // Lo demás no las recibe.
    const others = model.services.flatMap((s) => s.operations).filter((op) => !op.multipart && op.handlerClass);
    for (const operation of others) assert.doesNotMatch(content(files, `/UseCases/${operation.handlerClass}.cs`) ?? '', /IFileStorage/, `${name}: ${operation.name}`);
  }
});

test('el mapper resuelve la URL de un bucket público con el puerto y la constante del bucket; sin bucket público no recibe nada', () => {
  const catalog = plans.get('catalog-extended').files;
  const mapper = content(catalog, '/Mappers/ProductApplicationMapper.cs');
  assert.match(mapper, /public sealed class ProductApplicationMapper\(IFileStorage fileStorage\)/);
  assert.match(mapper, /fileStorage\.PublicUrl\(StoragePolicies\.ProductImages, entity\.StorageKey\)/);
  for (const file of plans.get('asset-vault').files.filter((f) => f.path.includes('/Mappers/'))) assert.doesNotMatch(file.content, /IFileStorage/, file.path);
});

test('el registro está en Program.cs, en la prueba del contenedor (sin almacén) y el SDK de S3 en Infrastructure; sin almacén en el stack, ni configuración ni SDK', () => {
  for (const [name, { files }] of plans) {
    assert.match(content(files, 'Api/Program.cs'), /builder\.Services\.AddStorage\(StorageSettings\.From\(configuration\)\);/, name);
    assert.match(content(files, '/UseCasesTests.cs'), /services\.AddStorage\(StorageSettings\.Unconfigured\);/, name);
    assert.match(content(files, '.Infrastructure.csproj'), /<PackageReference Include="AWSSDK\.S3" \/>/, name);
    assert.match(content(files, 'Directory.Packages.props'), /<PackageVersion Include="AWSSDK\.S3" Version="4\.0\.103\.4" \/>/, name);
  }
  const { files } = planService({ ...loadService(path.join(FIXTURES_DIR, 'product-catalog')), workspace: FIXTURES_DIR, stack: stack() });
  assert.ok(!files.some((file) => /\/Storage\/|storage\.yaml|MultipartReading/.test(file.path)), 'sin la capa no se emite nada de ella');
  assert.doesNotMatch(content(files, 'Directory.Packages.props'), /AWSSDK\.S3/);
});

test('la entrada multipart corta al doble del mayor maxSizeMb con el code del diseño, y el lector lee el formulario lo primero', () => {
  for (const [name, { files, model }] of plans) {
    const reading = content(files, '/Rest/MultipartReading.cs');
    assert.match(reading, new RegExp(`public const long LimitBytes = ${multipartFileLimitBytes(model)};`), name);
    assert.equal(multipartFileLimitBytes(model), model.storage.maxSizeMb * 2 * 1024 * 1024, name);
    assert.match(reading, /private const string FileTooLarge = "(FILE_TOO_LARGE|[A-Z_]+)";/, name);
    assert.match(reading, /"No se pudo leer el archivo enviado", FileUnreadable/, name);
    for (const operation of model.services.flatMap((s) => s.operations).filter((op) => op.multipart)) {
      const endpoints = files.filter((file) => file.path.includes('/Endpoints/')).map((file) => file.content).join('\n');
      const reader = endpoints.slice(endpoints.indexOf(`Read${operation.name[0].toUpperCase()}${operation.name.slice(1)}(HttpRequest httpRequest`));
      const body = reader.slice(0, reader.indexOf('\n    }'));
      assert.ok(body.indexOf('MultipartReading.Read(httpRequest)') < body.indexOf('TextValues.Route') || !body.includes('TextValues.Route'), `${name}: ${operation.name} lee el formulario antes que la ruta`);
      assert.match(body, /MultipartReading\.RequirePart\(form, "\w+"\)/, `${name}: ${operation.name}`);
    }
  }
  const middleware = content(plans.get('asset-vault').files, '/Rest/ApiErrorMiddleware.cs');
  assert.match(middleware, /case MissingPartException missingPart:\s+return ErrorResponse\.Of\(400, "Bad Request", null, missingPart\.Message\);/);
  assert.match(middleware, /case NotMultipartException:\s+return ErrorResponse\.Of\(415, "Unsupported Media Type", null, "La operación espera multipart\/form-data"\);/);
});

test('el arnés sube con Upload y, con MinIO, para y levanta el almacén; con S3 no hay palanca', () => {
  for (const [name, { files }] of plans) {
    const flow = content(files, '/Support/FlowTest.cs');
    const harness = content(files, '/Support/Harness.cs');
    assert.match(flow, /protected static Task<FlowResponse> Upload\(string path, UploadPart file/, name);
    assert.match(flow, /protected static Task StopStorage\(\)/, name);
    assert.match(flow, /protected static Task StartStorage\(\)/, name);
    assert.match(harness, /public sealed record UploadPart\(string Part, string Filename, string ContentType, byte\[\] Content\);/, name);
    assert.match(harness, /public static async Task<FlowResponse> UploadAsync\(/, name);
  }
  const s3 = plan('asset-vault', planService, 's3').files;
  assert.doesNotMatch(content(s3, '/Support/FlowTest.cs'), /StopStorage/);
  assert.match(content(s3, '/Support/FlowTest.cs'), /Upload\(string path, UploadPart file/);
});

test('la skill keel-dotnet-s3 se instala con un almacén en el stack', () => {
  for (const [name, { files }] of plans) {
    assert.ok(files.some((file) => file.path === '.claude/skills/keel-dotnet-s3/SKILL.md'), name);
    assert.ok(files.some((file) => file.path === '.claude/skills/keel-dotnet-s3/references/implementation.md'), name);
  }
});

test('el stub S3 es también el servicio de arranque, y el registro lo cablea: el agente no toca StorageRegistration', () => {
  for (const [name, { files }] of plans) {
    assert.match(content(files, '/Storage/S3FileStorage.cs'), /: IFileStorage, IHostedService/, name);
    assert.match(content(files, '/Storage/S3FileStorage.cs'), /if \(!settings\.EnsureBucketsOnStartup\)/, name);
    const registration = content(files, '/Storage/StorageRegistration.cs');
    assert.match(registration, /services\.AddHostedService\(provider => provider\.GetRequiredService<S3FileStorage>\(\)\);/, name);
    assert.match(registration, /services\.AddSingleton<IFileStorage>\(provider => provider\.GetRequiredService<S3FileStorage>\(\)\);/, name);
  }
});

test('con réplica y subida, el arnés sube también contra la segunda instancia (UploadOnReplica)', () => {
  const { files } = plans.get('asset-vault');
  assert.match(content(files, '/Support/FlowTest.cs'), /protected static Task<FlowResponse> UploadOnReplica\(string path, UploadPart file/);
  assert.match(content(files, '/Support/Harness.cs'), /CancellationToken cancellationToken, string\? baseUrl = null\)/);
});
