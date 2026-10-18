// El motor neutral de los gates de prohibición (gen/source-gate.js), EJECUTADO con bash sobre un árbol de prueba con
// una plataforma inventada: otra extensión y otra sintaxis de comentarios que las de cualquier generador, para que nada
// del motor dependa de un lenguaje. Las reglas de cada generador las prueba su paquete.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceGate } from '../src/lib/gen/source-gate.js';
import { tmpDir } from './helpers/tmp.js';

const PLATFORM = { root: 'src', extension: 'kl', excludeDirs: ['out'], lineComment: '--', blockComment: ['{-', '-}'] };
const RULES = [
  { id: 'shout', pattern: 'SHOUT[(]', why: 'no se grita' },
  { id: 'quiet', pattern: 'whisper[(]', why: 'tampoco se susurra en core', paths: ['^src/core/'] },
  { id: 'tags', pattern: 'tags[[:space:]]*=[[:space:]]*[[][^]]*[]]', keys: 'strings', why: 'etiqueta fuera de la lista' },
  { id: 'metric', pattern: 'metric[(][^)]*', keys: 'strings', skip: 1, why: 'etiqueta de una métrica fuera de la lista' }
];

function gate(rules = RULES) {
  return `#!/usr/bin/env bash\nset -u\n${sourceGate({ title: 'PRUEBA', label: 'prueba', rules, allowedKeys: ['ok', 'fine'], footer: 'pie', platform: PLATFORM })}\n`;
}

function tree(files, rules = RULES) {
  const dir = tmpDir('keel-source-gate-');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  fs.writeFileSync(path.join(dir, 'gate.sh'), gate(rules));
  return dir;
}

const run = (dir) => {
  const result = spawnSync('bash', ['gate.sh'], { cwd: dir, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

test('verde sin hallazgos, rojo con cada regla, con su id, el archivo y la línea', () => {
  assert.equal(run(tree({ 'src/a.kl': 'nada que ver\n' })).status, 0);
  const red = run(tree({ 'src/a.kl': 'uno\nSHOUT(x)\n', 'src/core/b.kl': 'whisper(y)\n', 'src/edge/c.kl': 'whisper(z)\n' }));
  assert.equal(red.status, 1, red.output);
  assert.match(red.output, /\[shout\] src\/a\.kl: no se grita\n {6}2: SHOUT\(x\)/);
  assert.match(red.output, /\[quiet\] src\/core\/b\.kl/);
  assert.doesNotMatch(red.output, /src\/edge\/c\.kl/, 'paths limita la regla');
  assert.match(red.output, /HALLAZGOS \(2\)/);
});

test('los comentarios no cuentan, y lo que sigue a un cierre de bloque sí', () => {
  assert.equal(run(tree({ 'src/a.kl': '-- SHOUT(x)\n{- SHOUT(y)\n   SHOUT(z) -}\nurl = "http://x--y"\n' })).status, 0);
  assert.equal(run(tree({ 'src/a.kl': '{- nada -} SHOUT(x)\n' })).status, 1);
});

test('las claves: solo las que no están en la lista, sin contar los literales que la regla salta', () => {
  assert.equal(run(tree({ 'src/a.kl': 'tags = ["ok", "fine"]\nmetric("cualquier_nombre", "ok")\n' })).status, 0);
  const red = run(tree({ 'src/a.kl': 'tags = ["ok", "user_id"]\nmetric("nombre", "email")\n' }));
  assert.equal(red.status, 1, red.output);
  assert.match(red.output, /<- user_id/);
  assert.match(red.output, /<- email/);
  assert.doesNotMatch(red.output, /<- nombre/);
});

test('los directorios excluidos y las otras extensiones no se miran', () => {
  assert.equal(run(tree({ 'src/out/a.kl': 'SHOUT(x)\n', 'src/a.txt': 'SHOUT(x)\n' })).status, 0);
});

test('un awk que no corre no da verde: sale sin veredicto', () => {
  const result = run(tree({ 'src/a.kl': 'x\n' }, [{ id: 'roto', pattern: '(', why: 'y' }]));
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /sin veredicto/);
});

test('una regla con barra invertida o comilla simple no se puede emitir', () => {
  assert.throws(() => gate([{ id: 'a', pattern: 'a\\.b', why: 'y' }]), /barra invertida/);
  assert.throws(() => gate([{ id: 'a', pattern: 'a', why: "no' vale" }]), /comilla simple/);
});
