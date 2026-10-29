// Los DTO de respuesta de la aplicación (`XxxResponseDto`), el `<Hija>Dto` de cada entidad hija proyectada en una
// respuesta, los de referencia embebida y de datos de otro servicio, y la página genérica `PagedResponse[T]`. Sin
// `XxxRequest`: el cuerpo HTTP es el propio mensaje, como en los otros tres generadores.
//
// Cada uno es un struct con los campos exportados y el NOMBRE DEL CABLE en su tag (`json:"customerId"`): el nombre
// Go sigue la regla de las siglas (`CustomerID`) y el del cable es el del diseño. El orden de los campos es el del
// diseño, que es el orden en que encoding/json/v2 los escribe. Con `conventions.nulls: omit` lo que puede no tener
// valor lleva `omitzero` —el @JsonInclude(NON_NULL) por clase de keel-spring—, y una lista nunca: viaja como `[]`.
// Un value object viaja con su forma (su MarshalJSONTo), así que el DTO lo lleva tal cual.

import { WIRE_SHAPES } from '@keel-system/keel-core/gen/wire';
import { goExported } from '../lib/go-projection.js';
import { alignRows, keyedLiteral } from '../lib/go-source.js';
import { appType, applicationPath, docComment, fieldImports, goTypeName, isOptional, layout, packageFile } from './render.js';

export function generate(model) {
  const files = [];
  const seen = new Set();
  const emit = (dto, doc) => {
    const name = goTypeName(dto.name);
    if (seen.has(name)) return;
    seen.add(name);
    files.push(renderDto(model, dto, doc));
  };
  let paginated = false;
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      if (operation.paginated) paginated = true;
      if (operation.responseDto) emit(operation.responseDto, `la respuesta de ${operation.name}, con los campos en el orden del cable`);
    }
  }
  for (const dto of model.childDtos ?? []) emit(dto, `${dto.entity} proyectada en las respuestas que la incluyen`);
  for (const dto of model.refDtos ?? []) emit(dto, `${dto.entity} embebida en una respuesta en lugar de su id (embed)`);
  for (const dto of model.refVariants ?? []) {
    emit(dto, `${dto.entity} embebida con el recorte que el diseño pide en esta proyección: solo los campos que la operación deja ver`);
  }
  for (const dto of model.needDtos ?? []) emit(dto, 'los datos de otro servicio que esta respuesta expone');
  if (paginated) files.push(pagedResponseFile(model));
  if (model.hasFileUploads) files.push(fileUploadFile(model));
  return files;
}

/** El tag del cable de un campo: su nombre del diseño, y `omitzero` donde la convención lo pide. */
export function wireTag(model, field, { omit = Boolean(model.service?.omitNulls) } = {}) {
  const name = field.wireName ?? field.name;
  // Una lista nunca se omite: sin valor viaja como [] (list-never-null, keel-core/gen/wire.js).
  const omitted = omit && !field.list && isOptional(field);
  return `\`json:"${name}${omitted ? ',omitzero' : ''}"\``;
}

/** Las filas de un struct de datos: comentario del campo (corta la alineación, como en gofmt), nombre, tipo y tag. */
export function dataRows(model, fields, { type = appType, tag = (field) => wireTag(model, field) } = {}) {
  const rows = [];
  for (const field of fields) {
    if (field.description) {
      for (const text of docComment(goExported(field.name), field.description, null, '\t').trimEnd().split('\n')) rows.push({ text });
    }
    rows.push({ indent: '\t', cells: [goExported(field.name), type(field), tag(field)] });
  }
  return alignRows(rows);
}

/** Los imports que pueden necesitar los campos de un DTO o un mensaje. */
export function dataImports(fields) {
  return ['internal/domain', 'internal/platform/wire', ...fields.flatMap((field) => fieldImports(field))];
}

function renderDto(model, dto, doc) {
  const name = goTypeName(dto.name);
  const parts = [`${docComment(name, doc)}type ${name} struct {\n${dataRows(model, dto.fields).join('\n')}\n}`];
  // Una variante recortada se construye desde el <E>RefDto completo: el resolver sigue siendo uno por raíz y el
  // recorte se hace aquí. El nil de una relación opcional lo decide quien llama.
  if (dto.source) {
    const source = goTypeName(dto.source);
    const pairs = dto.fields.map((field) => [goExported(field.name), `source.${goExported(field.name)}`]);
    parts.push(`// To${name} recorta un ${source} a los campos de ${name}.
func To${name}(source ${source}) ${name} {
	return ${name}{
${keyedLiteral(pairs, '\t\t').join('\n')}
	}
}`);
  }
  const { application } = layout(model);
  return { path: applicationPath(model, name), content: packageFile(model, application, { imports: dataImports(dto.fields), body: `\n${parts.join('\n\n')}\n` }) };
}

// El tipo Go de cada clave de la página, en el orden del cable.
const PAGE_TYPES = { items: '[]T', page: 'int32', size: 'int32', totalElements: 'int64', totalPages: 'int32' };

function pagedResponseFile(model) {
  const order = WIRE_SHAPES.pagedResponse;
  const missing = order.filter((name) => !PAGE_TYPES[name]);
  if (missing.length > 0) throw new Error(`PagedResponse: el contrato del cable nombra ${missing.join(', ')} y keel-go no lo emite`);
  const rows = alignRows(order.map((name) => ({ indent: '\t', cells: [goExported(name), PAGE_TYPES[name], `\`json:"${name}"\``] })));
  const body = `
// PagedResponse es la respuesta paginada del contrato: los elementos y los metadatos de la página. La forma y el
// orden de las claves son los del cable (docs/dsl/api.md § Paginación): los escenarios se escriben contra estos
// nombres. Items sin elementos viaja como [], nunca como null.
type PagedResponse[T any] struct {
${rows.join('\n')}
}
`;
  const { application } = layout(model);
  return { path: applicationPath(model, 'PagedResponse'), content: packageFile(model, application, { body }) };
}

function fileUploadFile(model) {
  const body = `
// FileUpload es el contenido de una subida binaria (multipart) en tránsito hacia el caso de uso. No viaja como
// JSON: lo construye el lector de la parte del formulario.
type FileUpload struct {
	Content     []byte
	Filename    string
	ContentType string
	Size        int64
}
`;
  const { application } = layout(model);
  return { path: applicationPath(model, 'FileUpload'), content: packageFile(model, application, { body }) };
}
