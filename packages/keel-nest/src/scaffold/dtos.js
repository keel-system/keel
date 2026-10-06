// DTOs de respuesta de la capa application (XxxResponseDto), el <Hija>Dto de cada entidad hija
// proyectada en una respuesta, los de referencia embebida y de datos de otro servicio, y el
// PagedResponse genérico. Sin XxxRequest: el cuerpo HTTP es el propio mensaje (como en keel-spring).
//
// Son clases de datos inmutables: el orden de sus campos es el del diseño, que es el orden en el
// que JSON.stringify los escribe — o sea, el del cable. Con `conventions.nulls: omit` llevan
// @OmitNulls() (application/support/wire.ts), el equivalente del @JsonInclude(NON_NULL) por clase
// de keel-spring: por clase y nunca global, porque el cuerpo de error tiene forma fija.

import { WIRE_SHAPES } from 'keel-core/gen/wire';
import { DIRS, classPath, declType, fieldImports, tsModule, tsdoc } from './render.js';

export const PAGED_RESPONSE_TS = classPath(DIRS.dtos, 'PagedResponse');
export const FILE_UPLOAD_TS = classPath(DIRS.dtos, 'FileUpload');
const WIRE_TS = 'src/application/support/wire.ts';

export function generate(model) {
  const files = [];
  const seen = new Set();
  const emit = (dto) => {
    if (seen.has(dto.name)) return;
    seen.add(dto.name);
    files.push(renderDto(model, dto));
  };
  let anyPaginated = false;
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      if (operation.paginated) anyPaginated = true;
      if (operation.responseDto) emit(operation.responseDto);
    }
  }
  for (const list of [model.childDtos, model.refDtos, model.refVariants, model.needDtos]) {
    for (const dto of list ?? []) emit(dto);
  }
  if (model.hasFileUploads) files.push({ path: FILE_UPLOAD_TS, content: tsModule(FILE_UPLOAD_TS, [], fileUploadBody()) });
  if (anyPaginated) files.push({ path: PAGED_RESPONSE_TS, content: tsModule(PAGED_RESPONSE_TS, [], pagedResponseBody()) });
  return files;
}

/** Declaración de campos y constructor por objeto de un tipo de datos inmutable. */
export function dataClassMembers(fields, { indent = '  ' } = {}) {
  const declarations = fields.map((field) => `${tsdoc(field.description, indent)}${indent}readonly ${field.name}: ${declType(field)};`);
  const props = fields.map((field) => `${indent}  readonly ${field.name}: ${declType(field)};`);
  const assigns = fields.map((field) => `${indent}  this.${field.name} = props.${field.name};`);
  return { declarations, props, assigns };
}

function renderDto(model, dto) {
  const file = classPath(DIRS.dtos, dto.name);
  const imports = dto.fields.flatMap((field) => fieldImports(model, field));
  const omit = Boolean(model.service?.omitNulls);
  if (omit) imports.push({ symbol: 'OmitNulls', from: WIRE_TS });
  const { declarations, props, assigns } = dataClassMembers(dto.fields);
  const doc = dto.source
    ? `${dto.entity} embebido con el recorte que el diseño pide en esta proyección: solo los campos que la operación deja ver.`
    : null;
  // Una variante recortada se construye desde el <E>RefDto completo: el mapper la pide así y el
  // resolver sigue siendo uno por raíz. Nulo entra, nulo sale (una relación opcional).
  const from = dto.source
    ? `

  static from(ref: ${dto.source}): ${dto.name};
  static from(ref: ${dto.source} | null): ${dto.name} | null;
  static from(ref: ${dto.source} | null): ${dto.name} | null {
    return ref == null ? null : new ${dto.name}({ ${dto.fields.map((field) => `${field.name}: ref.${field.name}`).join(', ')} });
  }`
    : '';
  if (dto.source) imports.push({ symbol: dto.source, from: classPath(DIRS.dtos, dto.source) });
  const body = `${tsdoc(doc)}${omit ? '// conventions.nulls: omit — un campo sin valor no viaja (service.keel.yaml).\n@OmitNulls()\n' : ''}export class ${dto.name} {
${declarations.join('\n')}

  constructor(props: {
${props.join('\n')}
  }) {
${assigns.join('\n')}
  }${from}
}`;
  return { path: file, content: tsModule(file, imports, body) };
}

function fileUploadBody() {
  return `/** Contenido de una subida binaria (multipart) en tránsito hacia el caso de uso. */
export class FileUpload {
  constructor(
    readonly content: Uint8Array,
    readonly filename: string,
    readonly contentType: string,
    readonly size: number
  ) {}
}`;
}

function pagedResponseBody() {
  const types = { items: 'readonly T[]', page: 'number', size: 'number', totalElements: 'number', totalPages: 'number' };
  const order = WIRE_SHAPES.pagedResponse;
  const missing = order.filter((name) => !types[name]);
  if (missing.length > 0) throw new Error(`PagedResponse: el contrato del cable nombra ${missing.join(', ')} y keel-nest no lo emite`);
  return `/**
 * Respuesta paginada del contrato: los elementos y los metadatos de la página. La forma y el orden
 * de las claves son los del cable (docs/dsl/api.md § Paginación): los escenarios se escriben contra
 * estos nombres exactos.
 */
export class PagedResponse<T> {
  constructor(
${order.map((name) => `    readonly ${name}: ${types[name]}`).join(',\n')}
  ) {}
}`;
}
