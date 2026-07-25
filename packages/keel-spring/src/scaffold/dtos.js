// DTOs de respuesta de la capa de aplicación (XxxResponseDto, records), el
// record <Hija>Dto de cada entidad hija proyectada en una respuesta, y el
// PagedResponse genérico para outputs paginados. Sin XxxRequest: el body HTTP
// es el propio Command (estilo prototipo).

import { javaFile, javaPath, subPackage } from './render.js';
import { domainTypeImport } from './entities.js';

const DTO_PKG = 'application.dtos';

export function generate(model) {
  const files = [];
  let anyPaginated = false;

  for (const service of model.services) {
    for (const operation of service.operations) {
      if (operation.paginated) anyPaginated = true;
      if (operation.responseDto) files.push(renderRecord(model, operation.responseDto));
    }
  }

  for (const childDto of model.childDtos ?? []) files.push(renderRecord(model, childDto));

  if (model.hasFileUploads) files.push(renderFileUpload(model));
  if (anyPaginated) files.push(renderPagedResponse(model));
  return files;
}

// Archivo subido tal y como llega al mensaje: el controller lo construye desde
// el MultipartFile y el handler lo entrega al puerto FileStorage, que persiste
// el binario y devuelve la clave que guarda el dominio.
function renderFileUpload(model) {
  const body = `/**
 * Contenido de una subida binaria (multipart) en tránsito hacia el caso de uso.
 */
public record FileUpload(byte[] content, String filename, String contentType, long size) {
}`;

  return {
    path: javaPath(model, DTO_PKG, 'FileUpload'),
    content: javaFile(subPackage(model, DTO_PKG), [], body)
  };
}

function renderRecord(model, dto) {
  const imports = new Set();
  const components = dto.fields.map((field) => {
    for (const name of field.imports) imports.add(name);
    const typeImport = domainTypeImport(model, field);
    if (typeImport) imports.add(typeImport);
    return `    ${field.javaType} ${field.name}`;
  });

  const body = `public record ${dto.name}(
${components.join(',\n')}
) {
}`;

  return {
    path: javaPath(model, DTO_PKG, dto.name),
    content: javaFile(subPackage(model, DTO_PKG), [...imports], body)
  };
}

function renderPagedResponse(model) {
  const imports = ['java.util.List'];
  let fromHelper = '';
  if (model.layersPresent.persistence) {
    imports.push('org.springframework.data.domain.Page');
    fromHelper = `

    public static <T> PagedResponse<T> from(Page<T> page) {
        return new PagedResponse<>(page.getContent(), page.getNumber(), page.getSize(), page.getTotalElements());
    }`;
  }

  const body = `/**
 * Respuesta paginada del contrato: content + metadatos de página.
 */
public record PagedResponse<T>(List<T> content, int page, int size, long totalElements) {${fromHelper}
}`;

  return {
    path: javaPath(model, DTO_PKG, 'PagedResponse'),
    content: javaFile(subPackage(model, DTO_PKG), imports, body)
  };
}
