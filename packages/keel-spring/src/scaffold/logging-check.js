// La higiene de los logs que escribe el AGENTE. Los de las fronteras los fija build
// (conventions/logging.md § Lo que ya loguea build); los de negocio los añade el agente, y ahí
// hay dos formas de equivocarse que no rompen nada y son caras:
//
//   · Concatenar dentro del log (`log.info("pedido " + id)`): la cadena se construye aunque el
//     nivel esté apagado y los valores dejan de ser argumentos, así que en JSON no salen como
//     campos y no se pueden buscar.
//   · Pasar el objeto de entrada ENTERO (`log.info("{}", command)`): su toString() arrastra todo
//     lo que trae quien llama —emails, documentos, tokens— al backend de logs, donde se queda.
//     Y cambia sin que nadie revise el log: basta con que el diseño añada un campo.
//
// Es un gate de PROHIBICIÓN, así que sale verde sobre el árbol recién generado —build no
// escribe ninguna de las dos formas— y se pone rojo cuando el agente introduce una. Esa
// asimetría con check-idempotency.sh (que nace rojo) es deliberada: allí se exige un uso que
// build no puede escribir; aquí se veta una forma. Por eso se falsa a propósito en el test.
//
// Heurístico y dicho en voz alta: el objeto entero se reconoce por el NOMBRE de la variable
// (command, query, dto, request, payload, body, message), no por su tipo — grep no ve tipos.
// Loguear un CAMPO (`command.orderId()`) no casa, que es justo la forma correcta.

import { CONTEXT_EXECUTORS_CLASS } from './concurrency.js';

export function generate(model) {
  if (!model.services?.some((service) => service.operations.length > 0)) return [];
  return [{ path: 'infra/check-logging.sh', content: SCRIPT(model) }];
}

// Una llamada de log: `log.info(`, `LOG.warn(`, `logger.debug(`. Las patrones van con clases
// entre corchetes y sin `\s`: viajan por grep -E y el escape mal puesto no falla, aborta.
const LOG_CALL = '(log|LOG|logger|LOGGER)[.](trace|debug|info|warn|error)[[:space:]]*[(]';
const CONCAT = `${LOG_CALL}[^;]*("[[:space:]]*[+]|[+][[:space:]]*")`;
const WHOLE_OBJECT = `${LOG_CALL}[^;]*,[[:space:]]*(command|query|dto|request|payload|body|message)[[:space:]]*[,)]`;

const SCRIPT = (model) => `#!/usr/bin/env bash
# check-logging.sh — higiene de los logs de ${model.service.name}.
#
# Los logs de las fronteras los genera build; los de negocio los escribe el agente siguiendo
# docs/keel/conventions/logging.md. Este gate veta cuatro formas que no rompen nada y salen
# caras: concatenar dentro del log, pasar el objeto de entrada entero (su toString() lleva los
# datos de quien llama al backend de logs), un ERROR desde domain/ o application/ (ahí un fallo
# se lanza y lo registra la frontera) y un executor que no propaga el contexto.
#
# Heurístico: el objeto entero se reconoce por el nombre de la variable (command, dto,
# request, payload, body, message...). Loguear un campo —command.orderId()— es lo correcto y
# no casa.
#
# Uso (desde la raíz del proyecto; no necesita infraestructura ni compilar):
#   bash infra/check-logging.sh
#
# Código de salida:
#   0  sin hallazgos
#   1  hay hallazgos → vuelven al agente de código
set -u

SRC="src/main/java"
if [ ! -d "$SRC" ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró $SRC)." >&2
  exit 1
fi

findings=0
detail=""

# Mira solo código vivo: sin comentarios de línea ni de bloque, que pueden citar la forma
# prohibida para explicarla.
scan() {  # regla, patrón, porqué
  local rule="$1" pattern="$2" why="$3"
  local file hits
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    hits="$(sed -e 's://.*::' -e '/^[[:space:]]*\\*/d' -e '/^[[:space:]]*\\/\\*/d' "$file" | grep -nE -- "$pattern" || true)"
    if [ -n "$hits" ]; then
      findings=$((findings + 1))
      detail="$detail  [$rule] \${file#./}: $why\\n$(printf '%s\\n' "$hits" | sed 's/^/      /')\\n"
    fi
  done <<EOF
$(grep -rlE -- '${LOG_CALL}' "$SRC" 2>/dev/null)
EOF
}

scan 'concat' '${CONCAT}' 'concatena dentro del log: usa parámetros {} (o addKeyValue) para que los valores salgan como campos y no se construya la cadena con el nivel apagado'
scan 'wholeObject' '${WHOLE_OBJECT}' 'loguea un objeto de entrada entero: su toString() lleva al backend de logs los datos de quien llama; loguea solo ids o campos concretos'

# Un ERROR desde el dominio o los casos de uso. Ahí un fallo se LANZA como excepción: la frontera
# (UseCaseMediator y el adaptador de entrada) lo registra una vez, con su nivel y su pila. Un
# log.error además duplica la línea y, peor, suele acompañar a un fallo que se traga —se loguea y
# se sigue—, que es justo lo que el diseño no puede ver. Solo en esas dos capas: en
# infrastructure un ERROR es legítimo (un relay que abandona un evento, un adaptador).
while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in */domain/*|*/application/*) ;; *) continue ;; esac
  hits="$(sed -e 's://.*::' -e '/^[[:space:]]*\\*/d' -e '/^[[:space:]]*\\/\\*/d' "$file" | grep -nE -- '(log|LOG|logger|LOGGER)[.](error[[:space:]]*[(]|atError[[:space:]]*[(])' || true)"
  if [ -n "$hits" ]; then
    findings=$((findings + 1))
    detail="$detail  [errorLevel] \${file#./}: ERROR desde dominio o casos de uso: lanza la excepción y deja que la frontera la registre (una vez, con su pila); si es una degradación elegida, WARN\\n$(printf '%s\\n' "$hits" | sed 's/^/      /')\\n"
  fi
done <<EOF
$(grep -rlE -- '[.](error|atError)[[:space:]]*[(]' "$SRC" 2>/dev/null)
EOF

# Un executor que no propaga el contexto: las tareas que lanza escriben logs sin correlationId
# y, con telemetría, abren spans huérfanos. El único sitio donde puede aparecer es el propio
# helper, que lo envuelve.
while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in */${CONTEXT_EXECUTORS_CLASS}.java) continue ;; esac
  hits="$(sed -e 's://.*::' -e '/^[[:space:]]*\\*/d' -e '/^[[:space:]]*\\/\\*/d' "$file" | grep -nE -- 'Executors[.]newVirtualThreadPerTaskExecutor[[:space:]]*[(]' || true)"
  if [ -n "$hits" ]; then
    findings=$((findings + 1))
    detail="$detail  [context] \${file#./}: crea un executor que no propaga el contexto (MDC y traza): usa ${CONTEXT_EXECUTORS_CLASS}.newVirtualThreadPerTaskExecutor()\\n$(printf '%s\\n' "$hits" | sed 's/^/      /')\\n"
  fi
done <<EOF
$(grep -rlE -- 'newVirtualThreadPerTaskExecutor' "$SRC" 2>/dev/null)
EOF

echo ""
echo "HIGIENE DE LOGS Y CONTEXTO"
if [ "$findings" -eq 0 ]; then echo "  logging              OK"; else echo "  logging              KO"; fi

if [ "$findings" -gt 0 ]; then
  echo ""
  echo "HALLAZGOS ($findings)"
  printf '%b' "$detail"
  echo ""
  echo "Ver docs/keel/conventions/logging.md: qué loguea ya build, qué puede añadir el agente y"
  echo "qué no se loguea nunca."
  exit 1
fi

exit 0
`;
