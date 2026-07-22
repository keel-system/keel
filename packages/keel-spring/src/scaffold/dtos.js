// DTOs de respuesta de la capa de aplicación (XxxResponseDto, records) +
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

  if (anyPaginated) files.push(renderPagedResponse(model));
  return files;
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
