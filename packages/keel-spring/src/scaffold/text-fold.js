// `TextFold`: la función que pliega un texto para que dos valores que el diseño da por
// iguales —`ACME`, `acme`, `Acmé`— lo sean también en el almacén.
//
// Existe desde el DSL 2.14 (`compare: ignore-case | ignore-case-accents`). Antes esa regla
// solo podía decirse en la prosa de `validation-scenarios.md` y la corrida `catalog` la pagó
// entera: el agente escribió a mano la columna `name_normalized` en tres entidades, con su
// constraint y su plegado, para que la unicidad y el filtro ignoraran caja y acentos.
//
// La sombra plegada (persistence-members.js § foldedShadow) la estampan los dos adaptadores
// —el JPA y el documental— con esta clase, y el filtro que escribe el agente pliega su
// parámetro con la MISMA: si el valor guardado y el buscado se plegaran con dos funciones
// distintas, el filtro dejaría de casar en silencio con el primer carácter en el que
// difirieran. Por eso es una clase de build y no una instrucción de la skill.
//
// Vive en `infrastructure.persistence.support` y no en el dominio: el dominio conserva el
// valor tal como llegó (es el que se devuelve), y plegar es una necesidad del almacén.

import { javaFile, javaPath, subPackage } from './render.js';

const PKG = 'infrastructure.persistence.support';

/** El import de `TextFold`, para los dos adaptadores que estampan la sombra plegada. */
export function textFoldImport(model) {
  return `${subPackage(model, PKG)}.TextFold`;
}

/** ¿Algún campo persistido del diseño pliega? */
export function usesTextFold(model) {
  if (!model.layersPresent?.persistence) return false;
  return model.entities.some((entity) => entity.persisted && entity.fields.some((field) => field.fold));
}

export function generate(model) {
  if (!usesTextFold(model)) return [];
  const body = `/**
 * Pliega un texto para compararlo como lo declara el diseño (\`compare\` de domain.keel.yaml).
 *
 * <p>Lo usan el adaptador de persistencia, que estampa la columna sombra
 * {@code <campo>Normalized} al guardar, y el filtro que la consulta: los dos TIENEN que plegar
 * con la misma función, o el filtro deja de casar en silencio.
 *
 * <p>{@link Locale#ROOT} a propósito: con el locale por defecto de la JVM, en turco
 * {@code "I".toLowerCase()} es {@code "ı"} y dos réplicas con distinto locale plegarían
 * distinto el mismo valor.
 */
public final class TextFold {

    private static final Pattern COMBINING_MARKS = Pattern.compile("\\\\p{M}+");

    private TextFold() {
        // Clase de utilidad.
    }

    /** compare: ignore-case — sin mayúsculas. Null queda null. */
    public static String foldCase(String value) {
        return value == null ? null : value.toLowerCase(Locale.ROOT);
    }

    /** compare: ignore-case-accents — sin mayúsculas y sin marcas diacríticas. Null queda null. */
    public static String foldCaseAndAccents(String value) {
        if (value == null) {
            return null;
        }
        String decomposed = Normalizer.normalize(value, Normalizer.Form.NFD);
        return COMBINING_MARKS.matcher(decomposed).replaceAll("").toLowerCase(Locale.ROOT);
    }
}`;
  return [
    {
      path: javaPath(model, PKG, 'TextFold'),
      content: javaFile(subPackage(model, PKG), ['java.text.Normalizer', 'java.util.Locale', 'java.util.regex.Pattern'], body)
    }
  ];
}
