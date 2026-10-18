// Lo mínimo de OTLP/HTTP en protobuf para el colector falso de telemetry-check: el exportador de OpenTelemetry .NET
// manda `ExportTraceServiceRequest` en binario (el de keel-nest manda JSON). Solo se leen los campos que miran los casos:
//
//   ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
//   ResourceSpans             { repeated ScopeSpans scope_spans = 2; }
//   ScopeSpans                { repeated Span spans = 2; }
//   Span                      { bytes trace_id = 1; bytes span_id = 2; bytes parent_span_id = 4; string name = 5; SpanKind kind = 6; }
//
// (opentelemetry-proto, trace/v1/trace.proto). El resto de campos se salta por su tipo de cable.

/** Los campos de un mensaje: `[{ number, wire, value }]`, con `value` un Buffer (longitud) o un número (varint). */
export function fields(buffer) {
  const out = [];
  let offset = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = buffer[offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  while (offset < buffer.length) {
    const key = Number(varint());
    const number = key >> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ number, wire, value: Number(varint()) });
    else if (wire === 2) {
      const length = Number(varint());
      out.push({ number, wire, value: buffer.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else throw new Error(`protobuf: tipo de cable ${wire} no soportado`);
  }
  return out;
}

const children = (buffer, number) => fields(buffer).filter((field) => field.number === number && field.wire === 2).map((field) => field.value);

/** Los spans de un `ExportTraceServiceRequest`, con los ids en hexadecimal y el `kind` numérico de OTLP (2 = SERVER). */
export function decodeTraces(buffer) {
  const spans = [];
  for (const resourceSpans of children(buffer, 1)) {
    for (const scopeSpans of children(resourceSpans, 2)) {
      for (const span of children(scopeSpans, 2)) {
        const byNumber = Object.fromEntries(fields(span).map((field) => [field.number, field.value]));
        spans.push({
          traceId: byNumber[1]?.toString('hex') ?? '',
          spanId: byNumber[2]?.toString('hex') ?? '',
          parentSpanId: byNumber[4]?.toString('hex') ?? '',
          name: byNumber[5]?.toString('utf8') ?? '',
          kind: byNumber[6] ?? 0
        });
      }
    }
  }
  return spans;
}
