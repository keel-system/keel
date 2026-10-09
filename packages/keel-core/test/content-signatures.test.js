// La tabla de firmas de binario (keel-core/gen/content-signatures.js) y su referencia ejecutable: lo que los dos
// generadores emiten como ContentSignature.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_SIGNATURES, contentMatches } from '../src/lib/gen/content-signatures.js';

const bytes = (...values) => Uint8Array.from(values);
const ascii = (text) => new TextEncoder().encode(text);

test('cada formato con firma reconoce su contenido y rechaza el de otro', () => {
  const samples = {
    'image/jpeg': bytes(0xff, 0xd8, 0xff, 0xe0),
    'image/png': bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00),
    'image/gif': ascii('GIF89a…'),
    'image/webp': ascii('RIFF\0\0\0\0WEBPVP8 '),
    'image/bmp': ascii('BM…'),
    'image/tiff': bytes(0x4d, 0x4d, 0x00, 0x2a, 0x00),
    'application/pdf': ascii('%PDF-1.7')
  };
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(CONTENT_SIGNATURES).sort());
  for (const [type, content] of Object.entries(samples)) {
    assert.equal(contentMatches(content, type), true, `${type} reconoce el suyo`);
    for (const [other, foreign] of Object.entries(samples)) {
      if (other !== type) assert.equal(contentMatches(foreign, type), false, `${type} rechaza un ${other}`);
    }
  }
});

test('las dos alternativas de un formato valen, y todas las partes de una alternativa cuentan', () => {
  assert.equal(contentMatches(ascii('GIF87a'), 'image/gif'), true);
  assert.equal(contentMatches(bytes(0x49, 0x49, 0x2a, 0x00), 'image/tiff'), true);
  assert.equal(contentMatches(ascii('RIFF\0\0\0\0AVI '), 'image/webp'), false, 'RIFF sin WEBP en el byte 8 no es WebP');
  assert.equal(contentMatches(ascii('RIFF'), 'image/webp'), false, 'demasiado corto para la segunda parte');
});

test('la promesa acotada: sin firma conocida, sin tipo o sin contenido, no se juzga', () => {
  const exe = bytes(0x4d, 0x5a, 0x90, 0x00);
  assert.equal(contentMatches(exe, 'text/csv'), true);
  assert.equal(contentMatches(exe, null), true);
  assert.equal(contentMatches(new Uint8Array(), 'image/png'), true);
  assert.equal(contentMatches(exe, 'IMAGE/PNG'), false, 'el tipo se compara sin mayúsculas');
});
