// La clasificación que hace propagable un arreglo del generador.
//
// `diffGenerated` (payload-drift.test.js) compara contenido, y eso basta para un payload
// estático. Aquí el sujeto es un proyecto GENERADO, donde «diferente del stub» es lo
// esperado en cuanto el agente completa los TODO: lo que se prueba es que la
// clasificación distingue las TRES razones por las que un archivo puede diferir —lo
// cambió el generador, lo escribió el agente, o las dos cosas— usando el registro de lo
// que el generador escribió la última vez.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import { classifyGenerated, digestOf } from '../src/lib/write.js';

/** Lo que el generador emite HOY. */
const generado = (content) => [{ path: 'src/Relay.java', content }];

/** Un proyecto con ese archivo en disco y el manifiesto que dice quién lo escribió. */
function proyecto({ enDisco, registrado, adopted = [] }) {
  const dir = tmpDir('keel-genclass-');
  if (enDisco !== null) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/Relay.java'), enDisco);
  }
  const manifest =
    registrado === undefined
      ? null
      : { files: { 'src/Relay.java': digestOf({ content: registrado }) }, adopted };
  return { dir, manifest };
}

test('lo que no existe es nuevo', () => {
  const { dir, manifest } = proyecto({ enDisco: null, registrado: undefined });
  assert.deepEqual(classifyGenerated(generado('v2'), dir, manifest).nuevos, ['src/Relay.java']);
});

test('lo que ya coincide está al día, aunque nadie lo haya registrado', () => {
  const { dir, manifest } = proyecto({ enDisco: 'v2', registrado: undefined });
  const buckets = classifyGenerated(generado('v2'), dir, manifest);
  assert.deepEqual(buckets.alDia, ['src/Relay.java']);
  assert.deepEqual(buckets.adoptados, []);
});

// El caso que motiva todo esto: el generador cambió y el archivo sigue siendo el que él
// escribió. Es lo que hoy obliga a portar a mano o a un --force que destruye.
test('lo que el generador escribió y nadie tocó es refrescable', () => {
  const { dir, manifest } = proyecto({ enDisco: 'v1', registrado: 'v1' });
  const buckets = classifyGenerated(generado('v2'), dir, manifest);
  assert.deepEqual(buckets.refrescables, ['src/Relay.java']);
  assert.deepEqual(buckets.conflictos, []);
});

// La otra mitad, y la que impide que esto se convierta en un --force con otro nombre.
test('lo que alguien tocó sin que el generador cambiara es suyo, no hay nada que propagar', () => {
  const { dir, manifest } = proyecto({ enDisco: 'v1 + lo del agente', registrado: 'v1' });
  const buckets = classifyGenerated(generado('v1'), dir, manifest);
  assert.deepEqual(buckets.tuyos, ['src/Relay.java']);
  assert.deepEqual(buckets.refrescables, []);
});

test('tocado Y con el generador cambiado es conflicto: pide una decisión', () => {
  const { dir, manifest } = proyecto({ enDisco: 'v1 + lo del agente', registrado: 'v1' });
  const buckets = classifyGenerated(generado('v2'), dir, manifest);
  assert.deepEqual(buckets.conflictos, ['src/Relay.java']);
  assert.deepEqual(buckets.refrescables, []);
});

// Los proyectos anteriores al mecanismo. Se reportan y no se refrescan: no se sabe
// cuáles tocó el agente, así que refrescar cualquiera sería jugársela con su trabajo.
test('sin registro previo el archivo queda adoptado, nunca refrescable', () => {
  const { dir, manifest } = proyecto({ enDisco: 'v1', registrado: undefined });
  const buckets = classifyGenerated(generado('v2'), dir, manifest);
  assert.deepEqual(buckets.adoptados, ['src/Relay.java']);
  assert.deepEqual(buckets.refrescables, []);
});

test('una ruta adoptada explícitamente tampoco se refresca, aunque su huella case', () => {
  const { dir, manifest } = proyecto({ enDisco: 'v1', registrado: 'v1', adopted: ['src/Relay.java'] });
  const buckets = classifyGenerated(generado('v2'), dir, manifest);
  assert.deepEqual(buckets.adoptados, ['src/Relay.java']);
  assert.deepEqual(buckets.refrescables, []);
});

test('lo que el generador ya no emite se reporta como huérfano', () => {
  const { dir, manifest } = proyecto({ enDisco: 'v1', registrado: 'v1' });
  const buckets = classifyGenerated([{ path: 'src/Otro.java', content: 'x' }], dir, manifest);
  assert.deepEqual(buckets.huerfanos, ['src/Relay.java']);
  // Y sigue en disco: clasificar no borra nada.
  assert.ok(fs.existsSync(path.join(dir, 'src/Relay.java')));
});

// El jar del wrapper de Gradle entra por `sourceFile`, no por `content`: si la huella se
// calculara solo sobre texto, un binario quedaría fuera del mecanismo sin que se note.
test('la huella cubre también los archivos que se copian de disco', () => {
  const origen = tmpDir('keel-genclass-src-');
  const jar = path.join(origen, 'wrapper.jar');
  fs.writeFileSync(jar, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  const dir = tmpDir('keel-genclass-dst-');
  fs.mkdirSync(path.join(dir, 'gradle'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gradle/wrapper.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  const files = [{ path: 'gradle/wrapper.jar', sourceFile: jar }];
  assert.deepEqual(classifyGenerated(files, dir, null).alDia, ['gradle/wrapper.jar']);
});

test('las rutas se comparan en forma POSIX, venga el separador que venga', () => {
  const { dir } = proyecto({ enDisco: 'v1', registrado: undefined });
  const manifest = { files: { 'src/Relay.java': digestOf({ content: 'v1' }) }, adopted: [] };
  const buckets = classifyGenerated([{ path: path.join('src', 'Relay.java'), content: 'v2' }], dir, manifest);
  assert.deepEqual(buckets.refrescables, ['src/Relay.java']);
  assert.deepEqual(buckets.huerfanos, []);
});
