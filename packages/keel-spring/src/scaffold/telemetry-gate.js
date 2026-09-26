// El gate de CARDINALIDAD de las métricas: lo único mecánico que impide que una etiqueta con
// muchos valores distintos llegue al backend.
//
// Por qué hace falta. La convención lo prohíbe desde el principio —los identificadores van al
// SPAN, nunca a una etiqueta de métrica— y hasta aquí nada lo comprobaba. El modo de fallo no se
// parece a ninguno de los otros de este repo: no hay excepción, no hay log, el panel sigue
// pintando y los escenarios siguen en verde. Lo que pasa es que cada valor distinto crea una
// SERIE nueva, así que una etiqueta con el id del pedido multiplica las series por el número de
// pedidos. El coste aparece en la factura del backend o en un Prometheus que deja de responder, y
// para entonces ya está dentro y hay que borrarlo del histórico.
//
// Es un gate de PROHIBICIÓN, así que nace VERDE sobre el árbol recién generado —build solo estampa
// las claves de su propio vocabulario— y se pone rojo cuando alguien añade una que no está.
// Misma asimetría deliberada que `check-logging.sh`, y al revés que `check-idempotency.sh`, que
// nace rojo porque exige un uso que build no puede escribir.
//
// Heurístico, y dicho en voz alta: se juzga la CLAVE cuando es un literal. Una clave que venga de
// una constante no la ve grep, igual que el gate de logs no ve tipos. Lo que se gana es que el
// camino de menor resistencia —escribir `.lowCardinalityKeyValue("orderId", id)`— deje de ser
// invisible.
//
// Y la mitad que NO se prohíbe importa tanto como la que sí: `highCardinalityKeyValue` es
// justamente donde va un identificador. No es una excepción al gate, es su contrapartida — el
// mensaje del hallazgo manda ahí.

import { ATTRIBUTES, usesTelemetry } from '../lib/telemetry-probes.js';

export function generate(model) {
  if (!usesTelemetry(model)) return [];
  return [{ path: 'infra/check-telemetry.sh', content: SCRIPT(model) }];
}

/**
 * Las claves que SÍ pueden ser etiqueta de métrica: el vocabulario, menos la correlación.
 *
 * <p>La correlación se queda fuera a propósito y es el caso que más enseña: es un atributo
 * legítimo —lo estampa build en cada span— y como etiqueta de métrica sería exactamente el
 * desastre que este gate existe para evitar, un valor distinto por petición. La misma clave es
 * correcta en un sitio e inaceptable en el otro.
 */
export function allowedTagKeys() {
  return Object.entries(ATTRIBUTES)
    .filter(([name]) => name !== 'correlationId')
    .map(([, value]) => value);
}

// Los patrones viajan por `grep -E`, así que los puntos van en clase de caracteres y no
// escapados: un escape mal puesto no falla, deja la expresión desbalanceada y ABORTA el check,
// cuyo efecto es un hallazgo falso indistinguible de uno real.
const literal = (value) => value.replace(/\./g, '[.]');

const TAG_CALL =
  '([.](lowCardinalityKeyValue|tag|tags)[[:space:]]*[(]|(Tag|Tags)[.]of[[:space:]]*[(])[[:space:]]*"';

// La otra forma de poner etiquetas, la de los atajos del registro:
// `registry.counter("nombre", "clave", valor)`. Ahí la clave es el SEGUNDO literal —el primero es
// el nombre de la métrica—, así que el patrón de arriba no la veía y un id metido por esta vía
// pasaba el gate. Como arriba, se comprueba la primera clave de la llamada.
const VARARGS_CALL =
  '[.](counter|timer|summary|gauge)[[:space:]]*[(][[:space:]]*"[^"]*"[[:space:]]*,[[:space:]]*"';
export { TAG_CALL, VARARGS_CALL };

const SCRIPT = (model) => {
  const allowed = allowedTagKeys();
  const allowedPattern = `(${allowed.map(literal).join('|')})`;
  return `#!/usr/bin/env bash
# check-telemetry.sh — cardinalidad de las métricas de ${model.service.name}.
#
# Una etiqueta de métrica con muchos valores distintos multiplica las series: con el id del pedido
# dentro, tantas series como pedidos. No falla nada —ni excepción, ni log, ni escenario rojo—; se
# ve en la factura del backend, o cuando el sistema de métricas deja de responder.
#
# Por eso las claves de etiqueta son una lista CERRADA, la del vocabulario que estampa build. Lo
# que lleva un identificador va al SPAN, con addHighCardinalityKeyValue, que este gate no toca.
#
# Uso (desde la raíz del proyecto; no necesita infraestructura ni compilar):
#   bash infra/check-telemetry.sh
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

# Sin comentarios: los javadoc que build deja explican estas mismas formas, y sin quitarlos el
# gate saldría rojo por su propia prosa.
while IFS= read -r file; do
  [ -n "$file" ] || continue
  hits="$(sed -e 's://.*::' -e '/^[[:space:]]*\\*/d' -e '/^[[:space:]]*\\/\\*/d' "$file" \
    | grep -nE -- '${TAG_CALL}' \
    | grep -vE -- '"${allowedPattern}"' || true)"
  if [ -n "$hits" ]; then
    findings=$((findings + 1))
    detail="$detail  [cardinality] \${file#./}: etiqueta de métrica con una clave fuera del vocabulario (${allowed.join(', ')}). Si el valor identifica algo —un id, una clave, un correo—, va al span con addHighCardinalityKeyValue, no a la métrica\n$(printf '%s\n' "$hits" | sed 's/^/      /')\n"
  fi
done <<EOF
$(grep -rlE -- '${TAG_CALL}' "$SRC" 2>/dev/null)
EOF

while IFS= read -r file; do
  [ -n "$file" ] || continue
  hits="$(sed -e 's://.*::' -e '/^[[:space:]]*\\*/d' -e '/^[[:space:]]*\\/\\*/d' "$file" \\
    | grep -nE -- '${VARARGS_CALL}' \\
    | grep -vE -- '${VARARGS_CALL.slice(0, -1)}"${allowedPattern}"' || true)"
  if [ -n "$hits" ]; then
    findings=$((findings + 1))
    detail="$detail  [cardinality] \${file#./}: etiqueta de métrica (en la forma counter/timer/summary/gauge con pares clave-valor) con una clave fuera del vocabulario (${allowed.join(', ')}). Si el valor identifica algo, va al span con addHighCardinalityKeyValue, no a la métrica\\n$(printf '%s\\n' "$hits" | sed 's/^/      /')\\n"
  fi
done <<EOF
$(grep -rlE -- '${VARARGS_CALL}' "$SRC" 2>/dev/null)
EOF

echo ""
echo "CARDINALIDAD DE LAS MÉTRICAS"
if [ "$findings" -eq 0 ]; then echo "  cardinality          OK"; else echo "  cardinality          KO"; fi

if [ "$findings" -gt 0 ]; then
  echo ""
  echo "HALLAZGOS ($findings)"
  printf '%b' "$detail"
  echo ""
  echo "Ver docs/keel/conventions/observability.md § Reglas para quien escribe código."
  exit 1
fi

exit 0
`;
};
