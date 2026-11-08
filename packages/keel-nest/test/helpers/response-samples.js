// Una respuesta de ejemplo de una operación, como TEXTO del cable (los números con su texto exacto), construida desde
// los DTO del modelo. La usan cache.test.js (la ida y vuelta de todas las respuestas) y conditional-writes.test.js (CW-11).

export function sampleResponse(fixtureModel, operation) {
  const dto = (name) => dtoIndex(fixtureModel).get(name);
  const item = objectText(fixtureModel, dto(operation.responseDto.name).fields, dto);
  if (operation.paginated) return `{"items":[${item}],"page":0,"size":20,"totalElements":1,"totalPages":1}`;
  if (operation.returnsList) return `[${item}]`;
  return item;
}

function dtoIndex(fixtureModel) {
  const index = new Map();
  for (const service of fixtureModel.services) for (const operation of service.operations) if (operation.responseDto) index.set(operation.responseDto.name, operation.responseDto);
  for (const list of [fixtureModel.childDtos, fixtureModel.refDtos, fixtureModel.refVariants, fixtureModel.needDtos]) for (const entry of list ?? []) index.set(entry.name, entry);
  return index;
}

function objectText(fixtureModel, fields, dto) {
  return `{${fields.map((field) => `${JSON.stringify(field.name)}:${valueText(fixtureModel, field, dto)}`).join(',')}}`;
}

function valueText(fixtureModel, field, dto) {
  if (field.list) return `[${valueText(fixtureModel, { ...field, list: false }, dto)}]`;
  const name = String(field.elementTsType ?? field.tsType).replace(/\[\]$/, '');
  if (field.kind === 'enum') return JSON.stringify(fixtureModel.enums.find((candidate) => candidate.name === name).values[0].literal);
  if (field.kind === 'composite') return objectText(fixtureModel, fixtureModel.valueObjects.find((vo) => vo.name === name).fields, dto);
  if (['childDto', 'refDto', 'needDto'].includes(field.kind)) return objectText(fixtureModel, dto(name).fields, dto);
  switch (field.base) {
    case 'int':
      return String(bounded(field, 7));
    case 'long':
      return field.numeric?.max != null ? String(bounded(field, 7)) : '9007199254740993';
    case 'decimal': {
      const scale = field.numeric?.scale ?? 2;
      const whole = bounded(field, 12);
      return scale > 0 ? `${whole}.${'5'.padEnd(scale, '0')}` : String(whole);
    }
    case 'boolean':
      return 'true';
    case 'date':
      return '"2026-10-09"';
    case 'timestamp':
      return '"2026-10-09T10:11:12.345Z"';
    case 'json':
      return '{"a":1.10,"b":[true,null]}';
    case 'uuid':
      return '"0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f"';
    default:
      return JSON.stringify(sampleText(field));
  }
}

/** Un entero dentro de las cotas del campo (por debajo del máximo, para que quepa la parte decimal). */
function bounded(field, preferred) {
  const min = field.numeric?.min ?? null;
  const max = field.numeric?.max ?? null;
  if (min != null && preferred < min) return Math.ceil(min);
  if (max != null && preferred >= max) return Math.floor(max) - 1;
  return preferred;
}

const TEXT_CANDIDATES = ['EUR', 'abc', 'es-ES', 'ABC-1234', 'A-1', 'user@example.com', 'sillas-de-roble', '+34600000000', 'ES9121000418450200051332', '123456'];

function sampleText(field) {
  const text = field.text ?? {};
  const pattern = text.pattern ? new RegExp(text.pattern) : null;
  const fits = (candidate) =>
    (!pattern || pattern.test(candidate)) && (text.minLength == null || candidate.length >= text.minLength) && (text.maxLength == null || candidate.length <= text.maxLength);
  const found = TEXT_CANDIDATES.find(fits);
  if (found) return found;
  if (!pattern) return 'x'.repeat(Math.max(text.minLength ?? 1, 1));
  throw new Error(`sin texto de ejemplo para el patrón ${text.pattern}: añádelo a TEXT_CANDIDATES`);
}
