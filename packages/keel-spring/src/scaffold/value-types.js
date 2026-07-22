// Value objects compuestos de domain.types: records PUROS en domain/valueobject
// (sin JPA; la persistencia los aplana a columnas en la entidad Jpa).

import { javaFile, javaPath, subPackage, javadoc } from './render.js';

export function generate(model) {
  return model.valueObjects.map((vo) => {
    const imports = vo.fields.flatMap((f) => [
      ...f.imports,
      ...(f.kind === 'enum' ? [`${subPackage(model, 'domain.enums')}.${f.javaType}`] : [])
    ]);
    const components = vo.fields.map((f) => `${f.javaType} ${f.name}`).join(', ');
    const body = `${javadoc(vo.description)}public record ${vo.name}(${components}) {
}`;

    return {
      path: javaPath(model, 'domain.valueobject', vo.name),
      content: javaFile(subPackage(model, 'domain.valueobject'), imports, body)
    };
  });
}
