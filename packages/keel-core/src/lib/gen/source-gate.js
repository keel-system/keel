// El motor NEUTRAL de los gates de PROHIBICIÓN sobre el código fuente (`infra/check-logging.sh`,
// `infra/check-telemetry.sh`): recorre los archivos del proyecto generado, quita los comentarios y aplica reglas que
// son DATOS. Lo usa keel-dotnet (PLAN-KEEL-DOTNET.md, incremento 14e); keel-nest tiene el suyo como programa embebido
// porque su proyecto ya trae el runtime con el que se ejecuta, y keel-spring, el suyo con grep.
//
// Va en bash y awk POSIX, sin nada más: el gate corre en la máquina de quien genera, que no tiene por qué tener otro
// runtime que el del proyecto. Nace VERDE sobre el árbol recién generado y un rojo es siempre código del agente (al revés
// que check-idempotency.sh, que exige un uso que build no escribe).
//
// Una regla: `{ id, pattern, why, paths?, exclude?, keys? }`.
//   · `pattern`: expresión regular EXTENDIDA sobre una línea ya sin comentarios. Sin barras invertidas —clases entre
//     corchetes ([.], [(], [[:space:]])—: viaja dentro de una cadena de awk, donde una barra mal escapada no falla, cambia
//     la expresión. `sourceGate` lanza si una lleva.
//   · `paths` / `exclude`: expresiones sobre la ruta del archivo (relativa a la raíz del proyecto).
//   · `keys`: la regla no prohíbe la forma entera sino las CLAVES de etiqueta que nombra; cada clave que no esté en la
//     lista admitida es un hallazgo. `brackets`: lo que va entre corchetes (`[clave] = valor`); `strings`: todos los
//     literales de cadena; `first-string`: el primero. `skip`: cuántos literales del principio no son claves (el nombre
//     y la ayuda de una métrica).
//
// La plataforma: `{ root, extension, excludeDirs, lineComment, blockComment }` (los comentarios de bloque, `[abre, cierra]`).

const NO_BACKSLASH = /\\/;

function awkString(text) {
  return `"${String(text).replaceAll('"', '\\"')}"`;
}

/**
 * El fragmento de bash que ejecuta las reglas y escribe el informe. Sale con 1 si hay hallazgos.
 *
 * @param {{ title: string, label: string, rules: object[], allowedKeys?: string[], footer: string, platform: object }} gate
 */
export function sourceGate({ title, label, rules, allowedKeys = [], footer, platform }) {
  for (const rule of rules) {
    for (const value of [rule.pattern, ...(rule.paths ?? []), ...(rule.exclude ?? [])]) {
      if (NO_BACKSLASH.test(value)) throw new Error(`source-gate: la regla ${rule.id} lleva una barra invertida (${value}); usa clases entre corchetes`);
    }
    // El programa de awk va entre comillas simples de bash: una comilla simple lo cerraría.
    for (const value of [rule.id, rule.pattern, rule.why, ...(rule.paths ?? []), ...(rule.exclude ?? [])]) {
      if (value.includes("'")) throw new Error(`source-gate: la regla ${rule.id} lleva una comilla simple (${value})`);
    }
  }
  for (const key of allowedKeys) if (/['\\]/.test(key)) throw new Error(`source-gate: clave admitida no representable: ${key}`);
  const { root, extension, excludeDirs = [], lineComment, blockComment } = platform;
  const prune = excludeDirs.map((dir) => `-path '*/${dir}' -prune -o `).join('');
  const ruleLines = rules
    .map((rule, index) =>
      [
        `  id[${index}] = ${awkString(rule.id)}; pat[${index}] = ${awkString(rule.pattern)}; why[${index}] = ${awkString(rule.why)}`,
        `  paths[${index}] = ${awkString((rule.paths ?? []).join('|'))}; skip[${index}] = ${awkString((rule.exclude ?? []).join('|'))}; keys[${index}] = ${awkString(rule.keys ?? '')}; ignore[${index}] = ${Number(rule.skip ?? 0)}`
      ].join('\n')
    )
    .join('\n');
  const allowed = allowedKeys.map((key) => `  allowed[${awkString(key)}] = 1`).join('\n');
  return `KEEL_GATE_OUT="$(mktemp)"
KEEL_GATE_FILES="$(mktemp)"
trap 'rm -f "$KEEL_GATE_OUT" "$KEEL_GATE_FILES"' EXIT
find ${root} ${prune}-type f -name '*.${extension}' -print | LC_ALL=C sort > "$KEEL_GATE_FILES"
# Un solo awk para todos los archivos (uno por archivo es lento: cientos de procesos). Un awk que no corre deja la
# marca KEEL_GATE_BROKEN, y el gate sale sin veredicto en vez de verde.
if [ -s "$KEEL_GATE_FILES" ]; then
  tr '\\n' '\\000' < "$KEEL_GATE_FILES" | xargs -0 awk '
BEGIN {
  rules = ${rules.length}
${ruleLines}
${allowed}
  inblock = 0
}
# El código sin comentarios: un comentario de bloque se vacía (las líneas siguen en su sitio) y el de línea se corta,
# salvo detrás de «:» o de una comilla (una URL dentro de una cadena).
function strip(line,    out, opening, closing, rest, following) {
  out = ""
  while (length(line) > 0) {
    if (inblock) {
      closing = index(line, ${awkString(blockComment?.[1] ?? '')})
      if (closing == 0 || ${awkString(blockComment?.[1] ?? '')} == "") return out
      line = substr(line, closing + ${(blockComment?.[1] ?? '').length})
      inblock = 0
      continue
    }
    opening = ${blockComment ? `index(line, ${awkString(blockComment[0])})` : '0'}
    if (opening == 0) { out = out line; break }
    out = out substr(line, 1, opening - 1)
    line = substr(line, opening + ${(blockComment?.[0] ?? '').length})
    inblock = 1
  }
  opening = index(out, ${awkString(lineComment)})
  while (opening > 0) {
    if (opening == 1 || substr(out, opening - 1, 1) !~ /[:"'"'"']/) return substr(out, 1, opening - 1)
    rest = substr(out, opening + ${lineComment.length})
    following = index(rest, ${awkString(lineComment)})
    if (following == 0) return out
    opening = opening + ${lineComment.length} + following - 1
  }
  return out
}
# Las claves de etiqueta que nombra el trozo que casó, según la forma de la regla.
function unknownKeys(text, mode, ignore,    found, key, start, piece, seen) {
  found = ""
  seen = 0
  while (length(text) > 0) {
    if (mode == "brackets") start = match(text, /[[][^]]*[]]/)
    else start = match(text, /"[^"]*"/)
    if (start == 0) break
    piece = substr(text, RSTART + 1, RLENGTH - 2)
    text = substr(text, RSTART + RLENGTH)
    # Los primeros literales que no son claves (el nombre y la ayuda de una métrica).
    if (++seen <= ignore) continue
    key = piece
    gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", key)
    if (key != "" && !(key in allowed)) found = found (found == "" ? "" : ", ") key
    if (mode == "first-string") break
  }
  return found
}
FNR == 1 { inblock = 0 }
{
  file = FILENAME
  code = strip($0)
  for (r = 0; r < rules; r++) {
    if (paths[r] != "" && file !~ paths[r]) continue
    if (skip[r] != "" && file ~ skip[r]) continue
    if (code !~ pat[r]) continue
    line = code
    gsub(/^[[:space:]]+/, "", line)
    gsub(/\\t/, " ", line)
    if (keys[r] == "") {
      print id[r] "\\t" file "\\t" FNR "\\t" line
      continue
    }
    match(code, pat[r])
    bad = unknownKeys(substr(code, RSTART, RLENGTH), keys[r], ignore[r])
    if (bad != "") print id[r] "\\t" file "\\t" FNR "\\t" line "   <- " bad
  }
}
' >> "$KEEL_GATE_OUT" || echo "KEEL_GATE_BROKEN" >> "$KEEL_GATE_OUT"
fi

# Un awk que no corre no puede dar verde: el gate sale sin veredicto.
if grep -q '^KEEL_GATE_BROKEN' "$KEEL_GATE_OUT"; then
  echo "El gate no pudo examinar el código (awk falló): sin veredicto." >&2
  exit 2
fi

echo ""
echo ${JSON.stringify(title)}
if [ ! -s "$KEEL_GATE_OUT" ]; then
  printf '  %-20s OK\\n' ${JSON.stringify(label)}
  exit 0
fi
printf '  %-20s KO\\n' ${JSON.stringify(label)}
echo ""
echo "HALLAZGOS ($(cut -f1,2 "$KEEL_GATE_OUT" | LC_ALL=C sort -u | wc -l | tr -d ' '))"
awk -F '\\t' '
BEGIN {
${rules.map((rule) => `  why[${awkString(rule.id)}] = ${awkString(rule.why)}`).join('\n')}
}
{
  if ($1 "\\t" $2 != last) { print "  [" $1 "] " $2 ": " why[$1]; last = $1 "\\t" $2 }
  print "      " $3 ": " $4
}' "$KEEL_GATE_OUT"
echo ""
echo ${JSON.stringify(footer)}
exit 1`;
}
