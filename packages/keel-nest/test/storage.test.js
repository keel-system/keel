// El almacenamiento de binarios (incremento 13g), EJECUTADO: la política de cada bucket con la firma del
// contenido, su configuración contra la de keel-spring, y la entrada multipart corriendo sobre Fastify real con
// @fastify/multipart. Lo que se mide es lo que hace el servidor de keel-spring del mismo diseño:
//
//   · un ejecutable con la etiqueta de una imagen NO es admisible (BucketPolicy.allowsContent), con la MISMA tabla
//     de firmas;
//   · storage.yaml dice lo mismo, clave a clave y perfil a perfil, que el de keel-spring;
//   · la subida: los campos como parámetros, el binario por su parte (vacío = null), el 413 con el code del
//     diseño, el 400 FILE_UNREADABLE de un cuerpo roto y el 400 de la parte que falta.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { loadService } from 'keel-core';
import { CONTENT_SIGNATURES, contentMatches } from 'keel-core/gen/content-signatures';
import { physicalBucketName } from 'keel-core/gen/buckets';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { MULTIPART_READING_TS, multipartFileLimitBytes } from '../src/scaffold/storage.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
`;

const SUBJECTS = ['asset-vault', 'catalog-extended'];
const STACK = { storage: 'minio', cache: 'redis' };
const plans = Object.fromEntries(SUBJECTS.map((name) => [name, planFixture(name, { stack: STACK })]));
const filesOf = (name) => Object.fromEntries(plans[name].files.map((file) => [file.path, file.content]));
const vault = filesOf('asset-vault');
const tree = transpileTree(plans['asset-vault'].files, { stubs: { '@nestjs/common': NEST_STUB } });
const { BucketPolicy } = await tree.load('src/domain/storage/bucket-policy.ts');
const { ContentSignature } = await tree.load('src/domain/storage/content-signature.ts');

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = new TextEncoder().encode('%PDF-1.7\n…');
const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);

function springFiles(name, stack = STACK) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return Object.fromEntries(planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files.map((file) => [file.path, file.content]));
}

// ─── La firma y la política ───────────────────────────────────────────────────

test('la tabla de firmas es la de keel-spring: los mismos tipos, y la emitida decide lo mismo que la referencia', () => {
  const java = Object.entries(springFiles('catalog-extended')).find(([file]) => file.endsWith('/ContentSignature.java'))[1];
  const springTypes = [...java.matchAll(/^\s*"([a-z]+\/[a-z.+-]+)", List\.of\(/gm)].map((match) => match[1]).sort();
  assert.deepEqual(springTypes, Object.keys(CONTENT_SIGNATURES).sort());
  const samples = [PNG, PDF, EXE, new Uint8Array(), new TextEncoder().encode('GIF89a…'), new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')];
  for (const type of [...Object.keys(CONTENT_SIGNATURES), 'text/plain', 'IMAGE/PNG', null]) {
    for (const content of samples) assert.equal(ContentSignature.matches(content, type), contentMatches(content, type), `${type} × ${content.length} bytes`);
  }
});

test('un ejecutable con la etiqueta de una imagen no es admisible; la imagen de verdad sí', () => {
  const policy = new BucketPolicy('productImages', 'catalog-product-images', true, 5, ['image/png', 'image/jpeg'], null);
  assert.equal(policy.allowsContentType('image/png'), true, 'el tipo declarado, solo, lo dejaría pasar');
  assert.equal(policy.allowsContent(EXE, 'image/png'), false);
  assert.equal(policy.allowsContent(PNG, 'image/png'), true);
  assert.equal(policy.allowsContent(PNG, 'application/pdf'), false, 'un tipo no admitido');
  assert.equal(policy.allowsSize(5 * 1024 * 1024), true);
  assert.equal(policy.allowsSize(5 * 1024 * 1024 + 1), false);
  assert.throws(() => policy.signedUrlTtlSeconds(), /no declara signedUrlTtlSeconds/);
  // Sin tipos declarados no hay restricción; un MIME sin firma conocida se acepta (la promesa acotada).
  const open = new BucketPolicy('any', 'any', false, null, [], 600);
  assert.equal(open.allowsContent(EXE, 'text/csv'), true);
  assert.equal(open.allowsSize(Number.MAX_SAFE_INTEGER), true);
  assert.equal(open.signedUrlTtlSeconds(), 600);
});

// ─── La configuración: la de keel-spring ──────────────────────────────────────

test('storage.yaml dice lo mismo que el de keel-spring, clave a clave y en los cuatro perfiles', () => {
  for (const name of SUBJECTS) {
    for (const storage of ['minio', 's3']) {
      const stack = { ...STACK, storage };
      const spring = springFiles(name, stack);
      const nest = Object.fromEntries(planFixture(name, { stack }).files.map((file) => [file.path, file.content]));
      for (const profile of ['local', 'develop', 'production', 'test']) {
        const springYaml = parseYaml(Object.entries(spring).find(([file]) => file.endsWith(`/parameters/${profile}/storage.yaml`))[1]);
        const nestYaml = parseYaml(nest[`config/parameters/${profile}/storage.yaml`]);
        assert.deepEqual(nestYaml, springYaml, `${name} ${storage} ${profile}`);
      }
    }
  }
});

test('las políticas salen de la configuración con el bucket FÍSICO que crea minio-init', async () => {
  const { storageSettings } = await tree.load('src/infrastructure/storage/storage-settings.ts');
  const { ConfiguredStoragePolicies } = await tree.load('src/infrastructure/storage/configured-storage-policies.ts');
  const { StoragePolicies } = await tree.load('src/domain/storage/storage-policies.ts');
  const yaml = parseYaml(vault['config/parameters/local/storage.yaml']);
  const configuration = { get: (key) => key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), yaml) };
  const settings = storageSettings(configuration);
  assert.equal(settings.ensureBucketsOnStartup, true);
  assert.equal(settings.pathStyleAccess, true);
  const policy = new ConfiguredStoragePolicies(settings).forBucket(StoragePolicies.ASSET_BINARIES);
  const bucket = plans['asset-vault'].model.storage.buckets[0];
  assert.equal(policy.bucket, physicalBucketName(plans['asset-vault'].model, bucket));
  assert.equal(policy.publicRead, false);
  assert.equal(policy.maxSizeMb, 25);
  assert.deepEqual(policy.allowedContentTypes, ['application/pdf', 'image/png', 'image/jpeg']);
  assert.equal(policy.signedUrlTtlSeconds(), 600);
  assert.throws(() => new ConfiguredStoragePolicies(settings).forBucket('noDeclarado'), /storage\.buckets\.noDeclarado no está configurado/);
});

test('el puerto declara la lectura según la visibilidad del diseño, como keel-spring', () => {
  const vaultPort = vault['src/domain/storage/file-storage.ts'];
  assert.match(vaultPort, /abstract download\(/);
  assert.match(vaultPort, /abstract signedUrl\(/);
  assert.doesNotMatch(vaultPort, /publicUrl/);
  const catalog = filesOf('catalog-extended');
  const catalogPort = catalog['src/domain/storage/file-storage.ts'];
  assert.match(catalogPort, /abstract publicUrl\(/);
  assert.doesNotMatch(catalogPort, /download|signedUrl/);
  // Y el mapper resuelve la URL del bucket público con la constante del bucket, como el de keel-spring.
  assert.match(catalog['src/application/mappers/product-application-mapper.ts'], /this\.fileStorage\.publicUrl\(StoragePolicies\.PRODUCT_IMAGES, /);
  assert.match(catalog['package.json'], /"@aws-sdk\/client-s3"/);
  assert.doesNotMatch(catalog['package.json'], /s3-request-presigner/, 'sin bucket privado no hay nada que firmar');
  assert.match(vault['package.json'], /"@aws-sdk\/s3-request-presigner"/);
  assert.match(vault['src/app.module.ts'], /StorageModule\.register\(configuration\)/);
});

// ─── La entrada multipart, sobre Fastify real ─────────────────────────────────

const { readMultipart, requirePart } = await tree.load(MULTIPART_READING_TS);
const LIMIT = multipartFileLimitBytes(plans['asset-vault'].model);

async function server() {
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: LIMIT }, throwFileSizeLimit: true });
  app.post('/up', async (request) => {
    const form = await readMultipart(request);
    const binary = requirePart(form.files, 'binary');
    return { fields: form.fields, binary: binary == null ? null : { filename: binary.filename, contentType: binary.contentType, size: binary.size, head: [...binary.content.slice(0, 4)] } };
  });
  app.setErrorHandler((error, _request, reply) => {
    void reply.status(200).send({ rejected: error.name, code: error.code ?? null, httpStatus: error.httpStatus ?? null, message: error.message });
  });
  await app.ready();
  return app;
}

function body(parts) {
  const boundary = 'keel-test-boundary';
  const chunks = [];
  for (const part of parts) {
    const disposition = part.filename ? `form-data; name="${part.name}"; filename="${part.filename}"` : `form-data; name="${part.name}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${part.type ? `Content-Type: ${part.type}\r\n` : ''}\r\n`));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

test('una subida: los campos (repetidos, como lista) y el binario por su parte, con su tipo declarado', async () => {
  const app = await server();
  const form = body([
    { name: 'slug', value: 'informe' },
    { name: 'labels', value: 'a' },
    { name: 'labels', value: 'b' },
    { name: 'binary', filename: 'informe.pdf', type: 'application/pdf', value: Buffer.from(PDF) }
  ]);
  const response = (await app.inject({ method: 'POST', url: '/up', ...form })).json();
  assert.deepEqual(response.fields, { slug: 'informe', labels: ['a', 'b'] });
  assert.deepEqual(response.binary, { filename: 'informe.pdf', contentType: 'application/pdf', size: PDF.length, head: [...PDF.slice(0, 4)] });
  await app.close();
});

test('un binario vacío llega null; la parte que falta es el 400 de keel-spring', async () => {
  const app = await server();
  const empty = (await app.inject({ method: 'POST', url: '/up', ...body([{ name: 'binary', filename: 'x.pdf', type: 'application/pdf', value: '' }]) })).json();
  assert.equal(empty.binary, null);
  const missing = (await app.inject({ method: 'POST', url: '/up', ...body([{ name: 'slug', value: 'x' }]) })).json();
  assert.equal(missing.rejected, 'MissingPartError');
  assert.equal(missing.message, "Falta la parte 'binary' en la petición multipart");
  await app.close();
});

test('el exceso sobre el límite de la entrada es el 413 con el code del diseño; un cuerpo roto, 400 FILE_UNREADABLE', async () => {
  const app = await server();
  assert.equal(LIMIT, 50 * 1024 * 1024, 'el doble del maxSizeMb (25) de asset-vault, como el servlet de keel-spring');
  const big = Buffer.alloc(LIMIT + 1, 0x25);
  const tooLarge = (await app.inject({ method: 'POST', url: '/up', ...body([{ name: 'binary', filename: 'x.pdf', type: 'application/pdf', value: big }]) })).json();
  assert.equal(tooLarge.rejected, 'PayloadTooLargeException');
  assert.equal(tooLarge.code, 'FILE_TOO_LARGE');
  assert.equal(tooLarge.message, 'El archivo supera el tamaño máximo permitido');
  const broken = await app.inject({
    method: 'POST',
    url: '/up',
    headers: { 'content-type': 'multipart/form-data; boundary=keel-test-boundary' },
    payload: '--keel-test-boundary\r\nContent-Disposition: form-data; name="binary"; filename="x.pdf"\r\n\r\n%PDF-cortado'
  });
  const parsed = broken.json();
  assert.equal(parsed.rejected, 'BadRequestException');
  assert.equal(parsed.code, 'FILE_UNREADABLE');
  const json = (await app.inject({ method: 'POST', url: '/up', headers: { 'content-type': 'application/json' }, payload: '{}' })).json();
  assert.equal(json.rejected, 'UnsupportedMediaTypeError');
  await app.close();
});

test('el lector de la subida comprueba la parte en SU posición, antes de validar restricciones', () => {
  const controller = vault['src/infrastructure/rest/controllers/asset-v1-controller.ts'];
  const reader = controller.slice(controller.indexOf('function readUploadAssetCommand'));
  const order = ["requireParameter(query, 'title')", "const binary = requirePart(files, 'binary')", 'new Violations'].map((text) => reader.indexOf(text));
  assert.ok(order.every((index) => index > 0) && order[0] < order[1] && order[1] < order[2], order.join(','));
  assert.match(controller, /const form = await readMultipart\(request\);/);
  assert.match(vault['src/infrastructure/http/http-platform.ts'], /fastify\.register\(multipart, \{ limits: \{ fileSize: 52428800 \}, throwFileSizeLimit: true \}\)/);
});
