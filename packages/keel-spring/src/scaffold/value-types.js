// Los dos puntos donde se hace cumplir el formato que declara un value type.
//
// COMPUESTO: record PURO en domain/valueobject (sin JPA; la persistencia lo aplana a
// columnas en la entidad Jpa), con el `pattern` en su constructor compacto.
// ESCALAR: no tiene clase —se aplana a String—, así que se le da una: `<Tipo>Format`,
// con la regex del diseño escrita una sola vez y un `validate` que llama quien
// normaliza. Sin ella la instrucción que build deja en el command ("hazlo cumplir en
// la entidad de dominio") no tiene destinatario, y una instrucción que no se puede
// seguir no se sigue: en la primera corrida real el formato acabó comprobado solo en
// las dos operaciones que tenían un escenario que lo exigía.

import { javaFile, javaPath, subPackage, javadoc } from './render.js';
import { escapeJava } from '../lib/type-mapper.js';

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

/**
 * Clase de formato de un value type ESCALAR.
 *
 * Tolerante a null/blank a propósito: si el valor es obligatorio lo dice la regla de
 * negocio (`required` ya viaja como @NotBlank en el DTO de entrada), y un guard que
 * además exigiera presencia rechazaría el vaciado legítimo de un campo opcional.
 */
function formatClass(model, type) {
  const body = `${javadoc(
    `Formato declarado por el value type ${type.name}${type.description ? `: ${type.description}` : '.'}`
  ).trimEnd()}
public final class ${type.className} {

    // La regex del diseño, en un único sitio: quien la vuelva a compilar a mano crea
    // una segunda definición que nadie sincroniza.
    private static final Pattern FORMAT = Pattern.compile("${escapeJava(type.pattern)}");

    private ${type.className}() {
    }

    /**
     * Hace cumplir el formato sobre un valor YA NORMALIZADO. Se llama donde se
     * normaliza (el factory o el método de negocio de la entidad, o el handler que
     * normaliza antes de entregarlo), nunca sobre lo que llega del cable: el patrón
     * describe el valor normalizado y comprobarlo antes rechaza peticiones válidas.
     *
     * No aplica a null/blank: la presencia la decide la regla de negocio.
     */
    public static void validate(String value) {
        if (!matches(value)) {
            throw new ValueFormatException("El valor no cumple el formato declarado por ${type.name}");
        }
    }

    /** El mismo juicio sin lanzar, para quien tenga que decidir en vez de rechazar. */
    public static boolean matches(String value) {
        return value == null || value.isBlank() || FORMAT.matcher(value).matches();
    }
}`;
  return {
    path: javaPath(model, 'domain.valueobject', type.className),
    content: javaFile(
      subPackage(model, 'domain.valueobject'),
      ['java.util.regex.Pattern', `${subPackage(model, 'domain.errors')}.ValueFormatException`],
      body
    )
  };
}

export function generate(model) {
  const formats = (model.formatTypes ?? []).map((type) => formatClass(model, type));
  return formats.concat(model.valueObjects.map((vo) => {
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
  }));
}
