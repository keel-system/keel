// DTOs de respuesta de la capa de aplicación (XxxResponseDto), el <Hija>Dto de cada entidad hija proyectada
// en una respuesta, los de referencia embebida y de datos de otro servicio, y la PagedResponse genérica. Sin
// XxxRequest: el cuerpo HTTP es el propio mensaje (como en keel-spring y keel-nest).
//
// Son records inmutables con propiedades `required`. Cada propiedad lleva [JsonPropertyName] con el nombre del
// diseño: es el contrato del cable, y la política de nombres de System.Text.Json convierte mal los acrónimos
// (`ABTest` → `abTest`). El orden de las propiedades es el del diseño, que es el orden en que se escriben. Con
// `conventions.nulls: omit` llevan [OmitNulls] (Application/Support), el @JsonInclude(NON_NULL) por clase de
// keel-spring: por clase y nunca global, porque el cuerpo de error tiene forma fija.

import { WIRE_SHAPES } from 'keel-core/gen/wire';
import { csFile, csMember, csString, declType, fieldUsings, located, namespaceOf, xmlDoc } from './render.js';

export function generate(model) {
  const files = [];
  const seen = new Set();
  const emit = (dto) => {
    if (seen.has(dto.name)) return;
    seen.add(dto.name);
    files.push(renderDto(model, dto));
  };
  let paginated = false;
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      if (operation.paginated) paginated = true;
      if (operation.responseDto) emit(operation.responseDto);
    }
  }
  for (const list of [model.childDtos, model.refDtos, model.refVariants, model.needDtos]) {
    for (const dto of list ?? []) emit(dto);
  }
  if (model.hasFileUploads) files.push(file(model, 'FileUpload', fileUploadBody()));
  if (paginated) files.push(file(model, 'PagedResponse', pagedResponseBody(), ['System.Text.Json.Serialization']));
  return files;
}

function file(model, name, body, usings = []) {
  const { namespace, path } = located(model, 'dtos', name);
  return { path, content: csFile({ namespace, usings, body }) };
}

/** Una propiedad de datos: el nombre del cable, el tipo declarado y `required`. */
export function dataProperty(field, indent = '    ') {
  return `${xmlDoc(field.description, indent)}${indent}[JsonPropertyName(${csString(field.wireName ?? field.name)})]\n${indent}public required ${declType(field)} ${csMember(field.name)} { get; init; }`;
}

function renderDto(model, dto) {
  const usings = ['System.Text.Json.Serialization', ...dto.fields.flatMap((field) => fieldUsings(model, field))];
  const omit = Boolean(model.service?.omitNulls);
  if (omit) usings.push(namespaceOf(model, 'appSupport'));
  const doc = dto.source ? `${dto.entity} embebido con el recorte que el diseño pide en esta proyección: solo los campos que la operación deja ver.` : null;
  // Una variante recortada se construye desde el <E>RefDto completo: el mapper la pide así y el resolver sigue
  // siendo uno por raíz. El null de una relación opcional lo decide quien llama.
  const from = dto.source
    ? `

    public static ${dto.name} From(${dto.source} source)
    {
        ArgumentNullException.ThrowIfNull(source);
        return new()
        {
${dto.fields.map((field) => `            ${csMember(field.name)} = source.${csMember(field.name)},`).join('\n')}
        };
    }`
    : '';
  const body = `${xmlDoc(doc)}${omit ? '// conventions.nulls: omit — un campo sin valor no viaja (service.keel.yaml).\n[OmitNulls]\n' : ''}public sealed record ${dto.name}
{
${dto.fields.map((field) => dataProperty(field)).join('\n\n')}${from}
}`;
  return file(model, dto.name, body, usings);
}

function fileUploadBody() {
  return `/// <summary>Contenido de una subida binaria (multipart) en tránsito hacia el caso de uso.</summary>
public sealed record FileUpload(ReadOnlyMemory<byte> Content, string Filename, string ContentType, long Size);`;
}

// El tipo C# de cada clave de la página, en el orden del cable.
const PAGE_TYPES = { items: 'IReadOnlyList<T>', page: 'int', size: 'int', totalElements: 'long', totalPages: 'int' };

function pagedResponseBody() {
  const order = WIRE_SHAPES.pagedResponse;
  const missing = order.filter((name) => !PAGE_TYPES[name]);
  if (missing.length > 0) throw new Error(`PagedResponse: el contrato del cable nombra ${missing.join(', ')} y keel-dotnet no lo emite`);
  const properties = order.map((name) => `    [JsonPropertyName(${csString(name)})]\n    public required ${PAGE_TYPES[name]} ${csMember(name)} { get; init; }`);
  return `/// <summary>
/// Respuesta paginada del contrato: los elementos y los metadatos de la página. La forma y el orden de las
/// claves son los del cable (docs/dsl/api.md § Paginación): los escenarios se escriben contra estos nombres.
/// </summary>
public sealed record PagedResponse<T>
{
${properties.join('\n\n')}
}`;
}
