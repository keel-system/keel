// El lector de OTLP en protobuf del colector falso de telemetry-check (scripts/lib/otlp-traces.js), contra un
// ExportTraceServiceRequest codificado a mano con las reglas del cable de protobuf: si el lector se equivocara, TEL-8
// diría «ningún span» por un bug del arnés y no del servidor.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTraces, fields } from '../scripts/lib/otlp-traces.js';

const varint = (value) => {
  const bytes = [];
  let rest = BigInt(value);
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0n);
  return Buffer.from(bytes);
};
const tag = (number, wire) => varint((number << 3) | wire);
const bytesField = (number, payload) => Buffer.concat([tag(number, 2), varint(payload.length), payload]);
const varintField = (number, value) => Buffer.concat([tag(number, 0), varint(value)]);
const fixed64 = (number) => Buffer.concat([tag(number, 1), Buffer.alloc(8)]);

test('lee trace_id, span_id, parent_span_id, name y kind, saltando lo que no mira', () => {
  const span = Buffer.concat([
    bytesField(1, Buffer.from('0af7651916cd43dd8448eb211c80319c', 'hex')),
    bytesField(2, Buffer.from('b7ad6b7169203331', 'hex')),
    bytesField(3, Buffer.from('estado')),
    bytesField(4, Buffer.from('00f067aa0ba902b7', 'hex')),
    bytesField(5, Buffer.from('GET /jobs/{id}')),
    varintField(6, 2),
    fixed64(7),
    varintField(300, 123456789)
  ]);
  const scopeSpans = Buffer.concat([bytesField(1, Buffer.from('scope')), bytesField(2, span), bytesField(2, span)]);
  const request = bytesField(1, Buffer.concat([bytesField(1, Buffer.from('resource')), bytesField(2, scopeSpans)]));
  const spans = decodeTraces(request);
  assert.equal(spans.length, 2);
  assert.deepEqual(spans[0], {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    parentSpanId: '00f067aa0ba902b7',
    name: 'GET /jobs/{id}',
    kind: 2
  });
});

test('un span sin padre lo dice con la cadena vacía, y un tipo de cable desconocido no pasa en silencio', () => {
  const span = Buffer.concat([bytesField(1, Buffer.alloc(16, 1)), bytesField(2, Buffer.alloc(8, 2))]);
  const request = bytesField(1, bytesField(2, bytesField(2, span)));
  assert.equal(decodeTraces(request)[0].parentSpanId, '');
  assert.throws(() => fields(Buffer.from([(1 << 3) | 3])), /tipo de cable 3/);
});
