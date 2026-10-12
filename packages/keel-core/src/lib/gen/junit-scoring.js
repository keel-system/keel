// Puntuar la matriz de escenarios desde el XML JUnit: lo que no depende de con qué se ejecutó la
// suite. Gradle (keel-spring) y Vitest (keel-nest) escriben el MISMO formato —<testsuites> →
// <testsuite> → <testcase classname name> con <failure>/<error>/<skipped> dentro—, y cada generador
// configura su runner para que `name` sea el título del caso (`FL-x: …`) y `classname` no lleve
// puntos más que el del paquete. Con eso, los dos `score-scenarios.sh` leen la matriz con los mismos
// dos programas awk, y un escenario no puede puntuar distinto según el generador que lo ejecutó.
//
// También el sello del snapshot `specs/`: la suite no se ejecuta contra un diseño editado desde el
// proyecto generado, con los dos generadores.
//
// Los programas se emiten tal cual dentro de un `awk '…'` de bash: no llevan comillas simples.

import { SPECS_SEAL_FILE } from './specs-seal.js';

/**
 * El bloque de bash que comprueba el sello de `specs/` y sale con 2 si no casa. `generator` es el
 * que escribió el snapshot (y el que hay que volver a ejecutar desde el workspace).
 */
export function specsSealCheck(generator) {
  return `# El snapshot del diseño tiene que ser el que build escribió. \`${SPECS_SEAL_FILE}\` es su sello: una
# línea «<sha256>  <ruta>» por archivo de specs/, calculada SIN retornos de carro para que un
# checkout con autocrlf no la rompa. Si no casa, alguien editó el diseño desde aquí, y un
# escenario corregido por quien tiene la suite delante deja de medir lo que el diseño dijo:
# eso es un culpable 'design' que se PROPONE (design-gaps.yaml), no se aplica. En la corrida
# \`catalog\` (2026-09-21) se aplicó, la suite cerró en verde y el hueco no volvió al método.
if [ -f "${SPECS_SEAL_FILE}" ]; then
  if command -v sha256sum >/dev/null 2>&1; then sha_cmd="sha256sum"; else sha_cmd="shasum -a 256"; fi
  seal_broken=""
  while read -r expected file; do
    [ -n "$file" ] || continue
    if [ ! -f "$file" ]; then seal_broken="$seal_broken $file(falta)"; continue; fi
    actual="$(tr -d '\\r' < "$file" | $sha_cmd | cut -d' ' -f1)"
    [ "$actual" = "$expected" ] || seal_broken="$seal_broken $file"
  done < "${SPECS_SEAL_FILE}"
  if [ -n "$seal_broken" ]; then
    echo "DISEÑO: el snapshot specs/ no es el que escribió ${generator} build:$seal_broken"
    echo "  La suite NO se ejecuta contra un diseño editado desde el proyecto generado."
    echo "  Si un escenario contradice al diseño, es un hueco del DISEÑO: va a design-gaps.yaml y al"
    echo "  informe, y lo corrige el diseñador en el workspace re-ejecutando ${generator} build."
    echo "  Para deshacer la edición: git checkout -- specs/"
    exit 2
  fi
fi`;
}

/**
 * Programa awk que lee los XML JUnit y escribe una línea `RESULTADO	FL-id	clase` por escenario
 * (`OK`, `FALLO`, `OMITIDO`). Indentado para ir dentro de `matrix="$(awk '…' …)"`.
 */
export const JUNIT_MATRIX_AWK = `  BEGIN { RS = "<testcase " }
  NR == 1 { next }
  {
    rec = $0
    close_tag = index(rec, "</testcase>")
    self_tag = index(rec, "/>")
    if (close_tag > 0 && (self_tag == 0 || close_tag < self_tag)) seg = substr(rec, 1, close_tag)
    else if (self_tag > 0) seg = substr(rec, 1, self_tag)
    else seg = rec

    name = ""; cls = ""
    # El atributo EXACTO: un /name=/ a secas casa dentro de classname="…", y el orden de los
    # dos lo decide el runner (Gradle escribe name primero; Vitest, classname).
    if (match(" " seg, /[ \\t\\n]name="[^"]*"/)) name = substr(" " seg, RSTART + 7, RLENGTH - 8)
    if (match(seg, /classname="[^"]*"/)) cls = substr(seg, RSTART + 11, RLENGTH - 12)
    if (name == "") next

    # Sin classname no es un test: es el nodo contenedor que algunos runners
    # emiten para la clase. Su @DisplayName suele empezar por el id del flujo, y
    # colarlo duplica la fila y falsea el recuento (9 escenarios donde hay 6).
    if (cls == "") next

    id = name
    if (index(id, ":") > 0) id = substr(id, 1, index(id, ":") - 1)
    gsub(/^[ \\t]+|[ \\t]+$/, "", id)
    # El id es un token, nunca una frase: un @DisplayName de clase como
    # "FL-RES-001 · alta de reserva" no es un escenario.
    if (id !~ /^FL-[A-Za-z0-9-]+$/) next

    sub(/^.*\\./, "", cls)
    if (seg ~ /<(failure|error)[ >]/) print "FALLO\\t" id "\\t" cls
    else if (seg ~ /<skipped[ \\/>]/) print "OMITIDO\\t" id "\\t" cls
    else print "OK\\t" id "\\t" cls
  }`;

/**
 * El cruce de la matriz con el documento de escenarios (`$SCENARIOS`), en bash. Parte de `$matrix`
 * (las líneas de `JUNIT_MATRIX_AWK`) y deja:
 *
 *   - `uncovered`: los ids que el documento declara y ninguna prueba ejercita — cobertura que falta;
 *   - `foreign`: los ids `FL-*` de la suite que el documento NO declara, ni por sí mismos ni como
 *     prolongación de uno suyo, y `foreign_rows`, sus filas;
 *   - `foreign_failures`: los de esos que están en rojo, con el formato de `non_scenario_failures`;
 *   - `$matrix` SIN las filas ajenas, que es lo que se puntúa.
 *
 * Una fila pertenece a un escenario si su id ES el suyo o lo prolonga con un guion: el documento
 * numera el flujo (FL-PRD-001) y la prueba puede numerar cada caso dentro de él (FL-PRD-001-A). Lo
 * ajeno no puntúa: las corridas `catalog` de los dos generadores (2026-10-11) dieron 66 en OK sobre
 * un documento de 56 escenarios, y un id que no está en el documento no mide nada del diseño —una
 * errata deja además el suyo como no ejercitado, que es donde se ve—. Sin documento no se filtra.
 */
export const SCENARIO_DOCUMENT_SCORING = `uncovered=""
foreign=""
foreign_rows=""
foreign_failures=""
if [ -f "$SCENARIOS" ]; then
  declared="$(grep -oE '^#{1,6}[[:space:]]*FL-[A-Za-z0-9-]+' "$SCENARIOS" \\
              | grep -oE 'FL-[A-Za-z0-9-]+' | sort -u)"
  covered="$(printf '%s\\n' "$matrix" | cut -f2 | sort -u)"
  for id in $declared; do
    printf '%s\\n' "$covered" | grep -qE "^\${id}(-|$)" || uncovered="$uncovered $id"
  done
  for id in $covered; do
    owned=0
    for declared_id in $declared; do
      case "$id" in "$declared_id"|"$declared_id"-*) owned=1; break ;; esac
    done
    [ "$owned" -eq 1 ] || foreign="$foreign $id"
  done
  if [ -n "$foreign" ]; then
    foreign_rows="$(printf '%s\\n' "$matrix" | awk -F '\\t' -v ids="$foreign" \\
      'BEGIN { n = split(ids, list, " "); for (i = 1; i <= n; i++) skip[list[i]] = 1 } ($2 in skip)')"
    matrix="$(printf '%s\\n' "$matrix" | awk -F '\\t' -v ids="$foreign" \\
      'BEGIN { n = split(ids, list, " "); for (i = 1; i <= n; i++) skip[list[i]] = 1 } NF > 0 && !($2 in skip)')"
    foreign_failures="$(printf '%s\\n' "$foreign_rows" | awk -F '\\t' \\
      '$1 == "FALLO" { printf "    %s  (%s)\\n      el documento de escenarios no declara %s\\n", $2, $3, $2 }')"
  fi
fi`;

/**
 * Las filas ajenas al documento, para imprimir debajo de la matriz. Va después de
 * `SCENARIO_DOCUMENT_SCORING`.
 */
export const FOREIGN_ROWS_PRINT = `if [ -n "$foreign" ]; then
  printf '%s\\n' "$foreign_rows" | while IFS="$(printf '\\t')" read -r result id cls; do
    [ -n "\${id:-}" ] || continue
    printf '  %-8s %-20s %-28s %s\\n' "AJENO" "$id" "$cls" "($result: el documento no lo declara; no puntúa)"
  done
fi`;

/**
 * Programa awk que lista las pruebas en rojo que NO son escenarios, con su mensaje colapsado a una
 * línea. Indentado para ir dentro de la función `non_scenario_failures` del script.
 */
export const JUNIT_NON_SCENARIO_AWK = `    BEGIN { RS = "<testcase " }
    NR == 1 { next }
    {
      rec = $0
      close_tag = index(rec, "</testcase>")
      self_tag = index(rec, "/>")
      if (close_tag > 0 && (self_tag == 0 || close_tag < self_tag)) seg = substr(rec, 1, close_tag)
      else if (self_tag > 0) seg = substr(rec, 1, self_tag)
      else seg = rec
      name = ""; cls = ""
      if (match(" " seg, /[ \\t\\n]name="[^"]*"/)) name = substr(" " seg, RSTART + 7, RLENGTH - 8)
      if (match(seg, /classname="[^"]*"/)) cls = substr(seg, RSTART + 11, RLENGTH - 12)
      if (name == "" || cls == "") next
      if (seg !~ /<(failure|error)[ >]/) next
      id = name
      if (index(id, ":") > 0) id = substr(id, 1, index(id, ":") - 1)
      gsub(/^[ \\t]+|[ \\t]+$/, "", id)
      if (id ~ /^FL-[A-Za-z0-9-]+$/) next
      sub(/.*\\./, "", cls)
      # El MENSAJE, que es lo único que convierte esta línea en accionable. Estaba aquí desde
      # siempre —el XML de JUnit lo guarda entero— y se descartaba: por stdout salía solo la clase de la
      # excepción y la línea donde saltó, y a diagnosticarlo se le iba un ciclo completo. Se colapsa a
      # una línea y se acota: quien lee esto es la sesión más larga del pipeline.
      msg = ""
      if (match(seg, /<(failure|error)[^>]*message="[^"]*"/)) {
        frag = substr(seg, RSTART, RLENGTH)
        if (match(frag, /message="[^"]*"/)) msg = substr(frag, RSTART + 9, RLENGTH - 10)
      }
      gsub(/&#10;/, " ", msg); gsub(/&#13;/, " ", msg)
      gsub(/&quot;/, "\\"", msg)
      gsub(/&lt;/, "<", msg); gsub(/&gt;/, ">", msg)
      gsub(/&amp;/, "\\\\&", msg)
      gsub(/  +/, " ", msg)
      if (length(msg) > 400) msg = substr(msg, 1, 400) " [...]"
      printf "    %s  (%s)\\n", name, cls
      if (msg != "") printf "      %s\\n", msg
    }`;
