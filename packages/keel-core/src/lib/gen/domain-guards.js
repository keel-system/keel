// Los campos cuyo FORMATO tiene que hacer cumplir alguien después de normalizar (keel-core/gen).
//
// La validación de entrada deja caer a propósito el formato heredado de un value type ESCALAR: el
// formato describe el valor YA normalizado y la validación del borde corre antes de que nadie
// normalice. build genera la clase `<Tipo>Format` con la regex del diseño, pero la LLAMADA es del
// agente, y cada generador emite un gate (`infra/check-domain-guards.sh`) que comprueba que existe.
// Las filas de ese gate son una decisión del diseño, la misma para cualquier lenguaje: si cada
// generador las derivara por su cuenta, un servidor vigilaría campos que el otro no.
//
// Una fila por (entidad, campo) y no por tipo, porque es el campo el que se escapa: `EmailAddress`
// estaba comprobado en `Application` y sin comprobar en `SuppressedAddress`, y una fila por tipo
// habría salido verde con el primero.

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

// El SCRIPT del gate, `infra/check-domain-guards.sh`: el mismo para keel-nest y keel-dotnet, con lo que
// cambia de un lenguaje a otro como parámetro (dónde está la clase, qué archivos se leen, qué línea es un
// import y cómo se llama el método). keel-spring conserva el suyo: busca la clase por NOMBRE con `find` en
// vez de por la ruta que emite, y unificarlo movería su línea base sin cambiar lo que mide.
//
//   classFile(className)  ruta, desde la raíz del proyecto, del archivo que declara la clase <Tipo>Format
//   sourceGlob            los archivos de código que se leen ('*.ts', '*.cs')
//   importPrefix          el principio de una línea de import, que no cuenta como uso ('import ', 'using ')
//   methods               los dos métodos de la clase, el que lanza primero (['validate', 'matches'])

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

export function domainGuardsScript(model, { classFile, sourceGlob, importPrefix, methods }) {
  const rows = guardedFields(model);
  const lines = rows.map((row) => {
    const className = `${row.type}Format`;
    return `guard ${shellQuote(`${row.entity}.${row.field}`)} ${shellQuote(className)} ${shellQuote(classFile(className))} ${shellQuote(`el tipo ${row.type} declara un formato y este campo no lo hace cumplir en ninguna parte`)}`;
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
    code="$(sed -e 's://.*::' -e '/^[[:space:]]*\\*/d' -e '/^[[:space:]]*\\/\\*/d' -e '/^[[:space:]]*${importPrefix}/d' "$file")"
    if printf '%s' "$code" | grep -qE -- "$class[[:space:]]*\\.[[:space:]]*(${methods.join('|')})[[:space:]]*\\("; then
      caller="$file"
      break
    fi
  done <<EOF
$(grep -rlF --include='${sourceGlob}' -- "$class." "$SRC" 2>/dev/null)
EOF
  [ -n "$caller" ] || note "$subject: nadie llama a $class.${methods[0]}(...) — $why"
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
  echo "El lector de la petición valida el formato heredado de un value type, pero lo que no entra por"
  echo "la API (un evento, una operación interna) no pasa por él. La clase <Tipo>Format lleva la regex"
  echo "del diseño; llámala en el factory de la entidad o en el método de negocio que asigna el campo."
  echo "Sin esa llamada el servicio acepta por esas puertas valores que el diseño declara imposibles,"
  echo "y ningún escenario que no lo mire lo delata."
  exit 1
fi

exit 0
`;
}
