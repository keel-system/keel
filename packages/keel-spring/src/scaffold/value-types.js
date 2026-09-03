// Los dos puntos donde se hace cumplir el formato que declara un value type.
//
// COMPUESTO: record PURO en domain/valueobject (sin JPA; la persistencia lo aplana a
// columnas en la entidad Jpa), con TODO lo que su tipo declara hecho cumplir en el
// constructor compacto: el `pattern`, las cotas `min`/`max` y —la que no rechaza sino que
// NORMALIZA— la escala de un decimal.
// ESCALAR: no tiene clase —se aplana a String—, así que se le da una: `<Tipo>Format`,
// con la regex del diseño escrita una sola vez y un `validate` que llama quien
// normaliza. Sin ella la instrucción que build deja en el command ("hazlo cumplir en
// la entidad de dominio") no tiene destinatario, y una instrucción que no se puede
// seguir no se sigue: en la primera corrida real el formato acabó comprobado solo en
// las dos operaciones que tenían un escenario que lo exigía.

import { javaFile, javaPath, subPackage, javadoc } from './render.js';
import { escapeJava } from '../lib/type-mapper.js';

/**
 * Lo que el tipo declara, hecho cumplir en el constructor compacto: formato, cotas y escala.
 *
 * La escala es la que más cuesta echar de menos, porque no rompe nada visible. Un `record`
 * compara con `BigDecimal.equals`, que es sensible a la escala: `12.5` y `12.50` no son
 * iguales. El mismo importe leído de la base (escala de la columna) y construido desde el
 * cuerpo de una petición son objetos distintos — en `equals`, en `hashCode` y en cualquier
 * clave natural que los use—, y el fallo aparece lejos de aquí y de forma intermitente. La
 * constitución ya lo exige (conventions/domain-modeling.md § precisión numérica); esto es lo
 * que lo cumple.
 *
 * Antes solo se emitía con un `@Pattern` presente, así que un value object de solo importes
 * —el caso más común de todos— se quedaba sin constructor y sin ninguna guarda.
 *
 * Los DTO de entrada dejan fuera el @Pattern heredado de un value type a propósito: el
 * formato describe el valor YA normalizado y Bean Validation corre antes de que el handler
 * normalice nada (type-mapper.js § inheritTypeFormat). El precio de esa decisión es que,
 * si nadie lo comprueba después, el formato no se comprueba en ningún sitio. Este es el
 * "después": el único punto por el que pasa cualquier valor de este tipo, venga del cable,
 * de la base de datos o de otro punto del dominio.
 */
function valueGuards(vo) {
  const guarded = vo.fields
    .map((field) => ({
      field,
      pattern: (field.validation ?? [])
        .find((annotation) => annotation.startsWith('@Pattern('))
        ?.match(/regexp\s*=\s*"(.*)"\s*\)$/)?.[1] ?? null,
      numeric: field.numeric ?? null
    }))
    .filter(({ field, pattern, numeric }) => pattern || numeric || field.required);
  if (guarded.length === 0) return { body: '', imports: [] };

  const imports = [];
  const constants = guarded
    .filter(({ pattern }) => pattern)
    .map(({ field, pattern }) => `    private static final Pattern ${formatConstant(field)} = Pattern.compile("${pattern}");`);
  if (constants.length > 0) imports.push('java.util.regex.Pattern');

  const checks = [];
  for (const { field, pattern, numeric } of guarded) {
    // La PRESENCIA, y va primero. `required` dentro de un tipo compuesto no habla de un
    // campo de una entidad —eso lo dice la entidad—: dice que un Money sin importe no es un
    // Money. El constructor compacto es el único punto por el que pasa cualquier valor de
    // este tipo, venga del cable, de la base de datos o de otro punto del dominio, así que
    // es donde el invariante se sostiene. Sin esto se acepta `new Money(null, "EUR")` y el
    // NPE aparece más tarde y en otro sitio.
    //
    // Ojo con lo que NO hace: los campos opcionales del value object siguen tolerando null,
    // y por eso los checks de abajo conservan su `!= null`. Y exigir presencia aquí obliga a
    // que quien rehidrata un value object AUSENTE devuelva null en vez de construirlo con
    // nulls — ver la guarda de repositories.js, que es la otra mitad de este cambio.
    if (field.required) {
      checks.push(`        if (${field.name} == null) {
            throw new IllegalArgumentException("${vo.name}.${field.name} es obligatorio");
        }`);
    }
    // Con la presencia ya exigida, el `!= null` de los checks siguientes es ruido: se omite.
    // Sin ella hace falta, porque un campo opcional del value object puede venir vacío.
    const siExiste = field.required ? '' : `${field.name} != null && `;
    if (pattern) {
      checks.push(`        if (${siExiste}!${formatConstant(field)}.matcher(${field.name}).matches()) {
            throw new IllegalArgumentException("${vo.name}.${field.name} no cumple el formato declarado por su tipo");
        }`);
    }
    if (!numeric) continue;
    for (const [bound, operator, texto] of [
      ['min', '<', 'menor que el mínimo'],
      ['max', '>', 'mayor que el máximo']
    ]) {
      if (numeric[bound] == null) continue;
      // Un BigDecimal se compara con compareTo, nunca con equals ni con los operadores:
      // equals distingue 12.5 de 12.50 y los operadores no existen para objetos.
      const condicion = numeric.decimal
        ? `${field.name}.compareTo(new BigDecimal("${numeric[bound]}")) ${operator} 0`
        : `${field.name} ${operator} ${numeric[bound]}`;
      checks.push(`        if (${siExiste}${condicion}) {
            throw new IllegalArgumentException("${vo.name}.${field.name} es ${texto} declarado por su tipo (${numeric[bound]})");
        }`);
      if (numeric.decimal) imports.push('java.math.BigDecimal');
    }
    if (numeric.scale == null) continue;
    // La normalización, que es lo único de aquí que MODIFICA en vez de rechazar. Sin ella
    // el record compara con BigDecimal.equals, que es sensible a la escala: el mismo importe
    // leído de la BD (escala de la columna) y construido desde el cuerpo de una petición
    // (la que trajera el JSON) son objetos distintos, en equals, en hashCode y en cualquier
    // clave que los use. Falla en silencio y de forma intermitente.
    checks.push(
      field.required
        ? `        ${field.name} = ${field.name}.setScale(${numeric.scale}, RoundingMode.HALF_UP);`
        : `        if (${field.name} != null) {
            ${field.name} = ${field.name}.setScale(${numeric.scale}, RoundingMode.HALF_UP);
        }`
    );
    imports.push('java.math.RoundingMode');
  }

  // Un único constructor compacto, no uno por campo: un record solo admite uno, y
  // emitir dos es Java que no compila.
  const bloqueConstantes = constants.length > 0 ? `
${constants.join('\n')}
` : '';
  const body = `${bloqueConstantes}
    public ${vo.name} {
${checks.join('\n')}
    }
`;
  return { body, imports: [...new Set(imports)] };
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
    const guards = valueGuards(vo);
    imports.push(...guards.imports);
    const body = `${javadoc(vo.description)}public record ${vo.name}(${components}) {
${guards.body}}`;

    return {
      path: javaPath(model, 'domain.valueobject', vo.name),
      content: javaFile(subPackage(model, 'domain.valueobject'), imports, body)
    };
  }));
}
