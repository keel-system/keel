// El MOTOR del gate de idempotencia y compensación (`infra/check-idempotency.sh`), neutral.
//
// Cada generador decide su MATRIZ —qué se comprueba, en qué archivo y con qué patrones de SU lenguaje—
// desde el diseño; lo que ejecuta esa matriz contra el árbol final es este script, el mismo para los dos.
// Tres clases de comprobación:
//   · unit  — un archivo (por nombre, o por contenido con un confirmador), lo que tiene que aparecer y lo
//             que no;
//   · impl  — que exista una implementación de un puerto distinta del respaldo que generó build;
//   · claim — dos patrones que se dan juntos en algún lugar del árbol (opcionalmente en el mismo bloque), y
//             que no sean el bloque que generó build.
// Lo único que cambia entre lenguajes va en `platform`: la carpeta de fuentes, la extensión de los
// archivos y qué archivos son los de los mensajes (que nombran a todos los listeners y no son ninguno).
//
// Una fila de la matriz es { group, subject, why } más, según su clase:
//   unit:  { class, require[], forbid[], locate?, confirm? }   (expresiones regulares extendidas, grep -E)
//   impl:  { implementors, exclude }
//   claim: { claim, bound, exclude, scope?, deny? }

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

export function renderIdempotencyGate({ serviceName, platform }, checks) {
  const rows = checks.map((check) => {
    if (check.implementors) {
      return `impl ${shellQuote(check.group)} ${shellQuote(check.subject)} ${shellQuote(check.implementors)} ${shellQuote(check.exclude)} ${shellQuote(check.why)}`;
    }
    if (check.claim) {
      return `claim ${shellQuote(check.group)} ${shellQuote(check.subject)} ${shellQuote(check.claim)} ${shellQuote(check.bound)} ${shellQuote(check.exclude)} ${shellQuote(check.why)} ${shellQuote(check.scope ?? '')} ${shellQuote(check.deny ?? '')}`;
    }
    const require = (check.require ?? []).join('\u0001');
    const forbid = (check.forbid ?? []).join('\u0001');
    return `unit ${shellQuote(check.group)} ${shellQuote(check.subject)} ${shellQuote(check.class)} ${shellQuote(require)} ${shellQuote(forbid)} ${shellQuote(check.locate ?? '')} ${shellQuote(check.why)} ${shellQuote(check.confirm ?? '')}`;
  });

  const groups = [...new Set(checks.map((check) => check.group))];

  return `#!/usr/bin/env bash
# check-idempotency.sh — comprueba que el código escrito por el agente USE los
# mecanismos de repetición y compensación que build generó para ${serviceName}.
#
# Build genera los mecanismos; quien los usa es el agente. Ese es el único tramo de la
# cadena que no está garantizado por construcción, y falla en silencio: un listener sin
# guard o un handler que ignora el IdempotencyStore funcionan perfectamente hasta la
# primera repetición. La matriz de abajo la precomputó build desde el diseño.
#
# Son comprobaciones ESTRUCTURALES (presencia, ausencia y orden), no análisis semántico:
# cazan el hueco y el cruce, no si el algoritmo es correcto. Eso último lo juzga el
# agente de calidad, que ejecuta este script en vez de leer el árbol a mano.
#
# Uso (desde la raíz del proyecto; no necesita infraestructura ni compilar):
#   bash infra/check-idempotency.sh
#
# Salida: un veredicto por familia (${groups.join(', ')}) y el detalle de lo que falta.
# Código de salida:
#   0  todas las familias en OK
#   1  hay hallazgos → van a 'remaining' del reporte y vuelven al agente de código
set -u

SRC="${platform.srcDir}"

if [ ! -d "$SRC" ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró $SRC)." >&2
  exit 1
fi

findings=0
detail=""
${groups.map((group) => `${group}_ko=0`).join('\n')}

note() {  # familia, texto
  detail="$detail  [$1] $2\\n"
  findings=$((findings + 1))
  case "$1" in
${groups.map((group) => `    ${group}) ${group}_ko=1 ;;`).join('\n')}
  esac
}

# El archivo se busca por nombre, no por ruta: algunos los escribe el agente y dónde
# los ponga es suyo (la frontera hexagonal la vigila conventions/project-layout.md).
locate() {
  find "$SRC" -name "$1.${platform.extension}" -type f 2>/dev/null | head -n 1
}

# Una unidad de comprobación: un archivo, lo que tiene que aparecer y lo que no.
unit() {  # familia, sujeto, clase, requeridos (\\001), prohibidos (\\001), localizador, porqué, confirmador
  local group="$1" subject="$2" class="$3" required="$4" forbidden="$5" locator="$6" why="$7" confirm="\${8:-}"
  local file
  file="$(locate "$class")"
  # Cuando el nombre canónico no existe pero el diseño admite otra forma —un listener
  # único para varias suscripciones de la misma cola, o dos schedulers que el agente
  # fusionó en uno—, el archivo se busca por CONTENIDO: el que maneja esos mensajes y
  # además pasa el CONFIRMADOR, que es lo que distingue al host legítimo del handler o
  # del mediador, que también nombran la operación. Sin esto, la implementación correcta
  # se reporta como ausente y el camino de menor resistencia para apagar el hallazgo es
  # partirla en la incorrecta — que aquí serían DOS beans disparando el mismo barrido.
  if [ -z "$file" ] && [ -n "$locator" ] && [ -n "$confirm" ]; then
    local candidate
    while IFS= read -r candidate; do
      [ -n "$candidate" ] || continue
      if grep -qE -- "$confirm" "$candidate" 2>/dev/null; then
        file="$candidate"
        break
      fi
    done <<EOF
$(grep -rlE -- "$locator" "$SRC" 2>/dev/null | grep -vE '${platform.messageFiles}')
EOF
  fi
  if [ -z "$file" ]; then
    note "$group" "$subject: no existe $class.${platform.extension} — $why"
    return
  fi
  # Los comentarios no cuentan: un TODO tachado dentro de un bloque de documentación que
  # explica lo que HAY que hacer no es lo mismo que un TODO vivo en el cuerpo. Se
  # miran las líneas de código, no la prosa que build dejó de guía.
  local code
  code="$(sed -e 's://.*::' -e '/^[[:space:]]*\\*/d' -e '/^[[:space:]]*\\/\\*/d' "$file")"
  local pattern
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    printf '%s' "$code" | grep -qE -- "$pattern" \\
      || note "$group" "$subject ($class): falta '$pattern' — $why"
  done <<EOF
$(printf '%s' "$required" | tr '\\001' '\\n')
EOF
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    printf '%s' "$code" | grep -qE -- "$pattern" \\
      && note "$group" "$subject ($class): NO debe aparecer '$pattern' — $why"
  done <<EOF
$(printf '%s' "$forbidden" | tr '\\001' '\\n')
EOF
}

# Que exista una implementación de un puerto distinta del fallback que generó build.
impl() {  # familia, sujeto, interfaz, clase excluida, porqué
  local group="$1" subject="$2" iface="$3" excluded="$4" why="$5"
  local found
  found="$(grep -rlE "implements[^{]*\\\\b$iface\\\\b|$iface[[:space:]]*\\\\(" "$SRC" 2>/dev/null \\
           | grep -v "/$excluded.${platform.extension}" | head -n 1)"
  [ -n "$found" ] || note "$group" "$subject: solo está el fallback $excluded — $why"
}

# Dos patrones que tienen que darse juntos, buscados en todo el árbol y no en una ruta
# fija: dónde ponga el agente cada pieza es asunto suyo mientras respete la frontera
# hexagonal. La pareja es lo que da sentido a cada uno por separado — un reclamo aquí y un
# paginado en otro listado cualquiera no es un lote acotado, y una clave de configuración
# leída en cualquier sitio no es el umbral de un barrido.
#
# Y sobre el CÓDIGO, no sobre la prosa: la nota que build deja en el stub del barrido
# nombra el patrón para explicarlo, así que mirando el archivo entero este check saldría
# verde por el propio comentario que dice lo que falta hacer.
#
# CUÁNTO se acerca el segundo patrón lo decide el 7º argumento, y no es un detalle:
#
#   (vacío) el archivo entero. Es lo correcto cuando las dos piezas viven en sitios
#           distintos de la clase por construcción — el umbral es un CAMPO de configuración, y
#           un campo no está dentro de ningún método.
#   method  solo el cuerpo del método donde cayó el primer patrón. Hace falta para la
#           cota del barrido: su reclamo vive en el adaptador del repositorio, que es por
#           definición donde están TODAS las consultas del agregado — incluido el listado
#           paginado de algún endpoint. Con el archivo entero, esa paginación ajena daba el
#           check por bueno pasara lo que pasara en el barrido, así que la comprobación no
#           podía fallar nunca.
#
# El recorte tiene dos formas porque el reclamo tiene dos, y la primera no sirve para la
# segunda:
#
#   1. Cuerpo entre llaves — el adaptador que implementa la consulta a mano. Se aísla
#      contando llaves.
#   2. Miembro de una interfaz — el repositorio declarativo, donde el reclamo es una
#      anotación con su consulta más la firma, y NO hay cuerpo: contar llaves no encuentra nada.
#      Se aísla por párrafo (líneas contiguas entre blancos), que es como quedan
#      separados los miembros.
#
# Las dos son heurísticas, y las dos recorren TODOS sus bloques buscando uno que traiga las
# dos cosas — no el primero que traiga la primera—. Quedarse con el primero hacía que un
# \`import\` de la paginación (que es un bloque, y casa con el patrón de la cota) decidiera por el
# archivo entero y tapara la consulta de más abajo, que sí la traía.
#
# Y el bloque que nombra lo que build ya generó (el 3er argumento, \`deny\`) se SALTA y se sigue
# buscando: el reclamo del agente cabe en el mismo adaptador que el de build, y quedarse con el
# primer bloque que casa —el de build— daba el archivo entero por mirado sin haber visto el otro.
methodBody() {  # patrón que localiza el reclamo, patrón que lo acompaña, bloques de build a saltar
  awk -v pat="$1" -v bound="$2" -v deny="\${3:-}" '
    { line = $0
      t = line; o = gsub(/\\{/, "", t)
      t = line; c = gsub(/\\}/, "", t)
      if (depth >= 1 && (buf != "" || o > 0)) buf = buf line "\\n"
      depth += o - c
      if (buf != "" && depth <= 1) {
        if (buf ~ pat && buf ~ bound && (deny == "" || buf !~ deny)) { printf "%s", buf; exit }
        buf = ""
      }
    }'
}

memberBlock() {  # patrón que localiza el reclamo, patrón que lo acompaña, bloques de build a saltar
  awk -v pat="$1" -v bound="$2" -v deny="\${3:-}" '
    function wanted() { return buf ~ pat && buf ~ bound && (deny == "" || buf !~ deny) }
    /^[[:space:]]*$/ { if (wanted()) { printf "%s", buf; exit } buf = ""; next }
    { buf = buf $0 "\\n" }
    END { if (wanted()) printf "%s", buf }'
}

claim() {  # familia, sujeto, patrón principal, patrón que lo acompaña, rutas excluidas, porqué, alcance
  local group="$1" subject="$2" pattern="$3" bound="$4" excluded="$5" why="$6" scope="\${7:-}"
 deny="\${8:-}"
  local file found="" code window
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    # Los imports fuera: el \`import\` de una herramienta es su declaración, no
    # su uso, y aceptarlo daba por acotado un barrido que no acotaba nada.
    code="$(sed -e 's://.*::' -e '/^[[:space:]]*\\*/d' -e '/^[[:space:]]*\\/\\*/d' -e '/^[[:space:]]*import /d' "$file")"
    printf '%s' "$code" | grep -qE -- "$pattern" || continue
    if [ "$scope" = "method" ]; then
      # Sin degradar al archivo entero cuando ningún bloque trae las dos: ese era el
      # camino por el que la cota de un listado paginado vecino valía por la del barrido.
      window="$(printf '%s' "$code" | methodBody "$pattern" "$bound" "$deny")"
      # El recorte por párrafo es para los miembros SIN cuerpo (una interfaz). Si el archivo tiene
      # bloques con llaves que casan —aunque todos sean de build—, no se usa: partiría por una línea
      # en blanco el cuerpo de un método de build y su trozo ya no nombraría lo que el deny busca.
      if [ -z "$window" ] && [ -z "$(printf '%s' "$code" | methodBody "$pattern" "$bound")" ]; then
        window="$(printf '%s' "$code" | memberBlock "$pattern" "$bound" "$deny")"
      fi
      [ -n "$window" ] || continue
      # El bloque encontrado es de BUILD, no del agente: sigue buscando. Excluir el
      # ARCHIVO no valdría —el reclamo que el agente tiene que escribir cabe
      # perfectamente en el mismo adaptador donde build dejó el suyo, y prohibírselo
      # sería pedirle la implementación incorrecta—, así que se descarta el BLOQUE.
      if [ -n "$deny" ] && printf '%s' "$window" | grep -qE -- "$deny"; then
        continue
      fi
    else
      window="$code"
    fi
    if printf '%s' "$window" | grep -qE -- "$bound"; then
      found="$file"
      break
    fi
  done <<EOF
$(grep -rlE -- "$pattern" "$SRC" 2>/dev/null | grep -vE "$excluded")
EOF
  [ -n "$found" ] || note "$group" "$subject: $why"
}

${rows.join('\n')}

echo ""
echo "IDEMPOTENCIA Y COMPENSACIÓN"
${groups
  .map(
    (group) =>
      `if [ "$${group}_ko" -eq 0 ]; then echo "  ${group.padEnd(20)} OK"; else echo "  ${group.padEnd(20)} KO"; fi`
  )
  .join('\n')}

if [ "$findings" -gt 0 ]; then
  echo ""
  echo "HALLAZGOS ($findings)"
  printf '%b' "$detail"
  exit 1
fi

exit 0
`;
}
