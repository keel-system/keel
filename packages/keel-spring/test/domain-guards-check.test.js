import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

// El bash generado se EJECUTA, no se compara: un `includes('validate(')` no distingue un
// gate que mira de uno que sale verde por el comentario que build dejó en el stub. Y su
// propiedad central es la misma que la de check-idempotency.sh: salir ROJO sobre un
// proyecto recién generado, donde el agente todavía no ha escrito ninguna llamada.

const fixture = (name) => path.join(process.cwd(), 'test', 'fixtures', name);

function build(name, mutate = null) {
  const service = loadService(fixture(name));
  const layers = mutate ? structuredClone(service.layers) : service.layers;
  if (mutate) mutate(layers);
  const workspace = tmpDir('keel-guards-check-');
  const result = scaffoldService({ manifest: service.manifest, layers, workspace, force: true });
  return path.join(workspace, result.outDir);
}

const script = (project) => path.join(project, 'infra', 'check-domain-guards.sh');

/** Ejecuta el script y devuelve { code, out }; null si no hay bash (el test se salta). */
function run(project) {
  try {
    return { code: 0, out: execFileSync('bash', ['infra/check-domain-guards.sh'], { cwd: project, encoding: 'utf8' }) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { code: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

// Escribe una línea dentro de la clase de dominio indicada, justo tras su apertura.
function insertIntoClass(project, className, line) {
  const file = walk(path.join(project, 'src', 'main', 'java')).find((f) => f.endsWith(`${className}.java`));
  assert.ok(file, `no se encontró ${className}.java`);
  const content = fs.readFileSync(file, 'utf8');
  const marker = `public class ${className} {`;
  assert.ok(content.includes(marker), `no se encontró la apertura de ${className}`);
  fs.writeFileSync(file, content.replace(marker, `${marker}\n${line}`));
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

test('recién generado el gate sale ROJO: build puso la clase, nadie la llama todavía', () => {
  const project = build('product-catalog');
  const result = run(project);
  if (!result) return; // sin bash

  assert.equal(result.code, 1);
  assert.match(result.out, /valueTypeFormat\s+KO/);
  assert.match(result.out, /Product\.sku: nadie llama a SKUFormat\.validate/);
});

test('la llamada en un COMENTARIO no cuenta: build deja un TODO que la nombra', () => {
  const project = build('product-catalog');
  // Exactamente la forma del TODO que build escribe en el stub del factory.
  insertIntoClass(project, 'Product', '    // TODO: SKUFormat.validate(sku);');
  const result = run(project);
  if (!result) return;

  assert.equal(result.code, 1, 'el gate salió verde por su propio aviso');
  assert.match(result.out, /Product\.sku/);
});

test('con la llamada escrita en código vivo, verde', () => {
  const project = build('product-catalog');
  insertIntoClass(project, 'Product', '    void guard(String sku) { SKUFormat.validate(sku); }');
  const result = run(project);
  if (!result) return;

  assert.equal(result.code, 0);
  assert.match(result.out, /valueTypeFormat\s+OK/);
});

test('no se afirma DÓNDE vive la llamada: vale desde cualquier clase del árbol', () => {
  const project = build('product-catalog');
  // Un handler que normaliza y valida ahí mismo es una implementación legítima; un gate
  // que exigiera la entidad tendría como camino de menor resistencia mover el código.
  const handler = walk(path.join(project, 'src', 'main', 'java')).find((f) => f.endsWith('CreateProductCommandHandler.java'));
  assert.ok(handler, 'no se encontró el handler de creación');
  const content = fs.readFileSync(handler, 'utf8');
  fs.writeFileSync(handler, content.replace(/^}/m, '    void guard(String sku) { SKUFormat.validate(sku); }\n}'));

  const result = run(project);
  if (!result) return;
  assert.equal(result.code, 0);
});

test('sin ningún value type escalar con pattern, el script no se genera', () => {
  const project = build('product-catalog', (layers) => {
    delete layers.domain.types.SKU.constraints.pattern;
  });

  // Un gate que siempre sale verde no distingue «correcto» de «no mira».
  assert.equal(fs.existsSync(script(project)), false);
});
