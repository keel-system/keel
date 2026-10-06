// El gate del formato de los value types ESCALARES: `infra/check-domain-guards.sh`, el mismo que
// emite keel-spring y con las MISMAS filas (guardedFields de keel-core/gen).
//
// La validación de entrada deja caer a propósito el formato heredado de un value type: describe el
// valor YA normalizado. build genera `<Tipo>Format` con la regex del diseño, pero la LLAMADA es del
// agente, y ese tramo falla en silencio: el servicio compila, arranca y acepta valores que el diseño
// declara imposibles. Alcance deliberado, como en keel-spring: se comprueba que la clase exista y
// que ALGUIEN la llame desde código vivo, no DÓNDE — un check que exige una ubicación concreta tiene
// como camino de menor resistencia romper el código para callarlo.

import { guardedFields } from 'keel-core/gen/domain-guards';
import { DIRS, classPath } from './render.js';

export function usesDomainGuardsCheck(model) {
  return guardedFields(model).length > 0;
}

export function generate(model) {
  const rows = guardedFields(model);
  if (rows.length === 0) return [];
  return [{ path: 'infra/check-domain-guards.sh', content: script(model, rows) }];
}

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

function script(model, rows) {
  const lines = rows.map((row) => {
    const className = `${row.type}Format`;
    return `guard ${shellQuote(`${row.entity}.${row.field}`)} ${shellQuote(className)} ${shellQuote(classPath(DIRS.valueObjects, className))} ${shellQuote(`el tipo ${row.type} declara un formato y este campo no lo hace cumplir en ninguna parte`)}`;
  });
  return `#!/usr/bin/env bash
# check-domain-guards.sh — comprueba que el formato de los value types escalares de
# ${model.service.name} se hace cumplir en alguna parte.
#
# build genera la clase <Tipo>Format con la regex del diseño; la LLAMADA es del agente, en el factory
# de la entidad o en el método de negocio que asigna el campo, siempre DESPUÉS de normalizar. Sin esa
# llamada el servicio acepta valores que el diseño declara imposibles, compila, arranca y pasa todos
# los escenarios que no lo miren.
#
# Es una comprobación ESTRUCTURAL: caza la ausencia, no juzga si el sitio elegido es el mejor.
#
# Uso (desde la raíz del proyecto; no necesita infraestructura ni compilar):
#   bash infra/check-domain-guards.sh
#
# Código de salida:
#   0  todos los campos con formato tienen quien lo haga cumplir
#   1  hay hallazgos → vuelven al agente de código
set -u

SRC="src"

if [ ! -d "$SRC" ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró $SRC)." >&2
  exit 1
fi

findings=0
detail=""

note() {  # texto
  detail="$detail  $1\\n"
  findings=$((findings + 1))
}

# Un campo con formato declarado: su clase existe y alguien la llama.
guard() {  # sujeto, clase, archivo de la clase, porqué
  local subject="$1" class="$2" declaration="$3" why="$4"
  # Autochequeo: si la clase no está, lo que falta es la generación, no el uso, y reportarlo como
  # uso ausente mandaría al agente a escribir una llamada a algo que no existe.
  if [ ! -f "$declaration" ]; then
    note "$subject: no existe $declaration — lo genera build desde el diseño; regenera el proyecto"
    return
  fi
  # La propia declaración fuera: la clase se nombra a sí misma y contaría como su uso. Y los
  # comentarios fuera: build deja en el factory un TODO que NOMBRA la llamada que falta, así que
  # mirando la prosa el gate saldría verde por su propio aviso.
  local caller=""
  local file code
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    [ "$file" != "$declaration" ] || continue
    code="$(sed -e 's://.*::' -e '/^[[:space:]]*\\*/d' -e '/^[[:space:]]*\\/\\*/d' -e '/^[[:space:]]*import /d' "$file")"
    if printf '%s' "$code" | grep -qE -- "$class[[:space:]]*\\.[[:space:]]*(validate|matches)[[:space:]]*\\("; then
      caller="$file"
      break
    fi
  done <<EOF
$(grep -rlF --include='*.ts' -- "$class." "$SRC" 2>/dev/null)
EOF
  [ -n "$caller" ] || note "$subject: nadie llama a $class.validate(...) — $why"
}

${lines.join('\n')}

echo ""
echo "FORMATO DE LOS VALUE TYPES"
if [ "$findings" -eq 0 ]; then echo "  valueTypeFormat      OK"; else echo "  valueTypeFormat      KO"; fi

if [ "$findings" -gt 0 ]; then
  echo ""
  echo "HALLAZGOS ($findings)"
  printf '%b' "$detail"
  echo ""
  echo "La validación de entrada deja caer el formato heredado de un value type a propósito: describe"
  echo "el valor YA normalizado y se valida antes de que el handler normalice. La clase <Tipo>Format"
  echo "lleva la regex del diseño; llámala DESPUÉS de normalizar, en el factory de la entidad o en el"
  echo "método de negocio que asigna el campo. Sin esa llamada el servicio acepta valores que el"
  echo "diseño declara imposibles, y ningún escenario que no lo mire lo delata."
  exit 1
fi

exit 0
`;
}
