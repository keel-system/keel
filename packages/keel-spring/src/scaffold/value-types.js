// Value objects compuestos de domain.types: records PUROS en domain/valueobject
// (sin JPA; la persistencia los aplana a columnas en la entidad Jpa).

import { javaFile, javaPath, subPackage, javadoc } from './render.js';

/**
 * El formato declarado en el tipo, hecho cumplir en el constructor compacto.
 *
 * Los DTO de entrada dejan fuera el @Pattern heredado de un value type a propósito: el
 * formato describe el valor YA normalizado y Bean Validation corre antes de que el handler
 * normalice nada (type-mapper.js § inheritTypeFormat). El precio de esa decisión es que,
 * si nadie lo comprueba después, el formato no se comprueba en ningún sitio. Este es el
 * "después": el único punto por el que pasa cualquier valor de este tipo, venga del cable,
 * de la base de datos o de otro punto del dominio.
 */
function patternGuards(vo) {
  const guarded = vo.fields
    .map((field) => ({
      field,
      pattern: (field.validation ?? [])
        .find((annotation) => annotation.startsWith('@Pattern('))
        ?.match(/regexp\s*=\s*"(.*)"\s*\)$/)?.[1] ?? null
    }))
    .filter(({ pattern }) => pattern);
  if (guarded.length === 0) return '';

  // Un único constructor compacto, no uno por campo: un record solo admite uno, y
  // emitir dos es Java que no compila.
  const constants = guarded
    .map(({ field, pattern }) => `    private static final Pattern ${formatConstant(field)} = Pattern.compile("${pattern}");`)
    .join('\n');
  const checks = guarded
    .map(
      ({ field }) => `        if (${field.name} != null && !${formatConstant(field)}.matcher(${field.name}).matches()) {
            throw new IllegalArgumentException("${vo.name}.${field.name} no cumple el formato declarado por su tipo");
        }`
    )
    .join('\n');

  return `
${constants}

    public ${vo.name} {
${checks}
    }
`;
}

function formatConstant(field) {
  return `${field.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_FORMAT`;
}

export function generate(model) {
  return model.valueObjects.map((vo) => {
    const imports = vo.fields.flatMap((f) => [
      ...f.imports,
      ...(f.kind === 'enum' ? [`${subPackage(model, 'domain.enums')}.${f.javaType}`] : [])
    ]);
    const components = vo.fields.map((f) => `${f.javaType} ${f.name}`).join(', ');
    const guards = patternGuards(vo);
    if (guards) imports.push('java.util.regex.Pattern');
    const body = `${javadoc(vo.description)}public record ${vo.name}(${components}) {
${guards}}`;

    return {
      path: javaPath(model, 'domain.valueobject', vo.name),
      content: javaFile(subPackage(model, 'domain.valueobject'), imports, body)
    };
  });
}
