import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXPECTED_DIR, LEGACY_DIR } from './helpers/golden.js';
import { tmpDir } from './helpers/tmp.js';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const legacy = path.join(LEGACY_DIR, 'java8-maven');

test('sin --out imprime el documento, el mismo que el esperado', () => {
  const r = run('fingerprint', legacy);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, fs.readFileSync(path.join(EXPECTED_DIR, 'java8-maven', 'runtime.yaml'), 'utf8'));
});

test('--out escribe fuera del legacy y --check lo da por bueno; si cambia, sale en rojo', () => {
  const out = path.join(tmpDir('recover-cli-'), 'legacy', 'inventory', 'environment.yaml');
  assert.equal(run('env-deps', legacy, '--out', out).status, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(path.join(EXPECTED_DIR, 'java8-maven', 'environment.yaml'), 'utf8'));
  assert.equal(run('env-deps', legacy, '--check', out).status, 0);
  fs.appendFileSync(out, '# retocado a mano\n');
  assert.equal(run('env-deps', legacy, '--check', out).status, 1);
});

test('--out dentro del legacy se rechaza: su repo se lee y no se toca', () => {
  const copy = path.join(tmpDir('recover-ro-'), 'legacy');
  fs.cpSync(legacy, copy, { recursive: true });
  const r = run('fingerprint', copy, '--out', path.join(copy, 'runtime.yaml'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dentro del legacy/);
  assert.equal(fs.existsSync(path.join(copy, 'runtime.yaml')), false);
});

test('un repo que ningún adaptador reconoce sale con código 2 y su motivo', () => {
  const dir = tmpDir('recover-none-');
  fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n');
  const r = run('fingerprint', dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ningún adaptador/);
  assert.match(r.stdout, /unsupported:/);
});

test('una ruta que no existe es un error, no un documento vacío', () => {
  const r = run('env-deps', path.join(tmpDir('recover-missing-'), 'no-existe'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no existe/);
});
