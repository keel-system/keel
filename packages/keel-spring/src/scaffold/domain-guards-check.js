// El otro tramo que no estaba garantizado por construcción: el formato de los value
// types ESCALARES.
//
// El DTO de entrada deja caer a propósito el `@Pattern` heredado del value type: el
// formato describe el valor YA normalizado y Bean Validation corre antes de que el
// handler normalice nada (type-mapper.js § inheritTypeFormat). Un value type COMPUESTO
// recoge ese formato en su constructor compacto; uno escalar se aplana a String y no
// tenía dónde. Ahora sí lo tiene —`<Tipo>Format`, que genera value-types.js—, pero la
// LLAMADA sigue siendo del agente: build no escribe ni el factory ni los métodos de
// negocio de la entidad.
//
// Ese tramo falla en silencio y de la peor manera: el servicio compila, arranca, y
// acepta valores que el diseño declara imposibles. En la primera corrida real sobre un
// servicio de notificaciones la suite cerró al 100% con `createTemplate` aceptando un
// código de dos letras y `suppressAddress` aceptando "roto" como dirección — el guard
// solo se escribió en las dos operaciones que tenían un escenario que lo exigía. Un
// escenario por campo y por operación no es una red: es la misma lista escrita dos veces.
//
// Alcance deliberado: se comprueba que la clase exista y que ALGUIEN la llame desde
// código vivo. No se afirma DÓNDE. Exigir una ubicación arquitectónica concreta es la
// lección (a) de check-idempotency.sh: un check que pide la implementación incorrecta
// tiene como camino de menor resistencia romper el código para callarlo.

/**
 * ¿Hay algo que comprobar? Sin ningún campo de entidad tipado con un value type escalar
 * con `pattern` no hay tramo que vigilar y el script no se genera: un gate que siempre
 * sale verde no distingue «correcto» de «no mira».
 */
export function usesDomainGuardsCheck(model) {
  return checksOf(model).length > 0;
}

export function generate(model) {
  const checks = checksOf(model);
  if (checks.length === 0) return [];
  return [{ path: 'infra/check-domain-guards.sh', content: script(model, checks) }];
}

// ─── La matriz ───────────────────────────────────────────────────────────────
//
// Una fila por (entidad, campo): el tipo del campo tiene formato declarado, así que
// alguien tiene que hacerlo cumplir tras normalizar. Se recorre por CAMPO y no por
// tipo porque es el campo el que se escapa: `EmailAddress` estaba comprobado en
// `Application` y sin comprobar en `SuppressedAddress`, y una fila por tipo habría
// salido verde con el primero.

export function guardedFields(model) {
  const declared = new Set((model.formatTypes ?? []).map((type) => type.name));
  const rows = [];
  for (const entity of model.entities ?? []) {
    for (const field of entity.fields ?? []) {
      if (!field.inheritedPattern || !field.typeName) continue;
      if (!declared.has(field.typeName)) continue;
      rows.push({ entity: entity.name, field: field.name, type: field.typeName });
    }
  }
  return rows;
}

function checksOf(model) {
  return guardedFields(model).map((row) => ({
    subject: `${row.entity}.${row.field}`,
    className: `${row.type}Format`,
    // Corto a propósito: la explicación larga se imprime UNA vez al pie. Repetida por
    // fila, ocho hallazgos son ocho párrafos idénticos y el dato —qué campo— se pierde.
    why: `el tipo ${row.type} declara un formato y este campo no lo hace cumplir en ninguna parte`
  }));
}

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

function script(model, checks) {
  const rows = checks.map(
    (check) => `guard ${shellQuote(check.subject)} ${shellQuote(check.className)} ${shellQuote(check.why)}`
  );

  return `#!/usr/bin/env bash
# check-domain-guards.sh — comprueba que el formato de los value types escalares de
# ${model.service.name} se hace cumplir en alguna parte.
#
# build genera la clase <Tipo>Format con la regex del diseño; la LLAMADA es del agente,
# en el factory de la entidad o en el método de negocio que asigna el campo, siempre
# DESPUÉS de normalizar. Sin esa llamada el servicio acepta valores que el diseño
# declara imposibles, compila, arranca y pasa todos los escenarios que no lo miren.
#
# Es una comprobación ESTRUCTURAL: caza la ausencia, no juzga si el sitio elegido es el
# mejor. Dónde vive la llamada es del agente mientras respete la frontera hexagonal.
#
# Uso (desde la raíz del proyecto; no necesita infraestructura ni compilar):
#   bash infra/check-domain-guards.sh
#
# Código de salida:
#   0  todos los campos con formato tienen quien lo haga cumplir
#   1  hay hallazgos → vuelven al agente de código
set -u

SRC="src/main/java"

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
guard() {  # sujeto, clase, porqué
  local subject="$1" class="$2" why="$3"
  local declaration
  declaration="$(find "$SRC" -name "$class.java" -type f 2>/dev/null | head -n 1)"
  # Autochequeo: si la clase no está, lo que falta es la generación, no el uso, y
  # reportarlo como uso ausente mandaría al agente a escribir una llamada a algo que
  # no existe.
  if [ -z "$declaration" ]; then
    note "$subject: no existe $class.java — lo genera build desde el diseño; regenera el proyecto"
    return
  fi
  # La propia declaración fuera: la clase se nombra a sí misma y contaría como su uso.
  # Y los comentarios fuera: build deja en el stub del factory un TODO que NOMBRA la
  # llamada que falta, así que mirando la prosa el gate saldría verde por su propio aviso.
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
$(grep -rlF -- "$class." "$SRC" 2>/dev/null)
EOF
  [ -n "$caller" ] || note "$subject: nadie llama a $class.validate(...) — $why"
}

${rows.join('\n')}

echo ""
echo "FORMATO DE LOS VALUE TYPES"
if [ "$findings" -eq 0 ]; then echo "  valueTypeFormat      OK"; else echo "  valueTypeFormat      KO"; fi

if [ "$findings" -gt 0 ]; then
  echo ""
  echo "HALLAZGOS ($findings)"
  printf '%b' "$detail"
  echo ""
  echo "El DTO de entrada deja caer el formato heredado de un value type a propósito: describe"
  echo "el valor YA normalizado y Bean Validation corre antes de que el handler normalice. La"
  echo "clase <Tipo>Format lleva la regex del diseño; llámala DESPUÉS de normalizar, en el"
  echo "factory de la entidad o en el método de negocio que asigna el campo. Sin esa llamada el"
  echo "servicio acepta valores que el diseño declara imposibles, y ningún escenario que no lo"
  echo "mire lo delata. Ver conventions/domain-modeling.md."
  exit 1
fi

exit 0
`;
}
