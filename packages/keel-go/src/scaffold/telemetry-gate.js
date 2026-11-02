// El gate de CARDINALIDAD de las métricas (incremento 14e): `infra/check-telemetry.sh`, el gemelo del de los otros tres con
// patrones de Go.
//
// Una etiqueta de métrica con muchos valores distintos multiplica las series —con el id del pedido dentro, tantas series como
// pedidos— y no falla nada: ni un error, ni un log, ni un escenario rojo. Se ve en la factura del backend. Por eso las CLAVES de
// etiqueta son una lista cerrada: las del vocabulario neutral (menos la correlación, que es un atributo legítimo del SPAN y la
// peor etiqueta posible) y las de las series que la telemetría generada publica con los nombres de keel-spring.
//
// Gate de PROHIBICIÓN: nace verde sobre el árbol recién generado. Se juzga la clave cuando se ve en la línea —un literal o
// `telemetry.AttrX`—: una clave que llegue por una variable, o un literal repartido en varias líneas, no lo ve, igual que el de
// keel-spring no ve una constante. La salida de un hallazgo no es quitar el dato: es llevarlo al span (`Attributes`).
//
// Y una regla propia: con telemetría, `messaging.Inbound` a secas compila, pasa todos los escenarios y corta la traza en cada
// consumo; la puerta del listener es `messaging.Consume`.

import { ATTRIBUTES, promTag, usesTelemetry } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { sourceGate } from '@keel-system/keel-core/gen/source-gate';
import { GO_SOURCE, NOT_TESTS } from './logging-check.js';

/** Las claves de etiqueta de las series que publica la telemetría generada fuera del vocabulario `keel.*`. */
export const PLATFORM_TAG_KEYS = ['method', 'uri', 'status', 'outcome', 'exception', 'client_name', 'cache', 'result'];

/** Lo que escribe build: las claves de las series propias y las del exemplar, que no es una etiqueta de la serie. */
const OWN_FILES = '/internal/platform/telemetry/';

/** Las claves que SÍ pueden ser etiqueta de métrica, en todas las formas en que el código las escribe. */
export function allowedTagKeys() {
  const vocabulary = Object.entries(ATTRIBUTES).filter(([name]) => name !== 'correlationId');
  return [...vocabulary.map(([, value]) => value), ...vocabulary.map(([, value]) => promTag(value)), ...PLATFORM_TAG_KEYS];
}

/** Las formas en que el código pone etiquetas a una métrica, cada una con su forma prohibida y su forma correcta. */
export const TAG_RULES = [
  {
    id: 'labels',
    keys: 'strings',
    pattern: 'Labels:[[:space:]]*map[[]string[]]string[{][^}]*[}]',
    exclude: [NOT_TESTS, OWN_FILES],
    why: 'una observación con una etiqueta fuera del vocabulario',
    sample: 'options := telemetry.Options{Labels: map[string]string{"order_id": id}}',
    allowed: 'options := telemetry.Options{Labels: map[string]string{"keel.operation": operation}}'
  },
  {
    id: 'promLabels',
    keys: 'strings',
    pattern: 'prometheus[.]Labels[{][^}]*[}]',
    exclude: [NOT_TESTS, OWN_FILES],
    why: 'una métrica con una etiqueta fuera del vocabulario',
    sample: 'orders.With(prometheus.Labels{"customer_email": email}).Inc()',
    allowed: 'orders.With(prometheus.Labels{"keel_operation": operation}).Inc()'
  },
  {
    id: 'labelNames',
    keys: 'strings',
    pattern: 'New(Counter|Gauge|Histogram|Summary)Vec[(].*[[][]]string[{][^}]*[}]',
    exclude: [NOT_TESTS, OWN_FILES],
    // El nombre y la ayuda de la métrica van antes, en sus opciones: se saltan por el trozo que casa la lista.
    why: 'una métrica con una etiqueta fuera del vocabulario',
    sample: 'orders := prometheus.NewCounterVec(opts, []string{"order_id"})',
    allowed: 'orders := prometheus.NewCounterVec(opts, []string{"keel_operation"})'
  }
];

/** La regla del listener: con telemetría, el mensaje se trata dentro de messaging.Consume. */
export const CONSUME_RULE = {
  id: 'inbound',
  pattern: 'messaging[.]Inbound[(]',
  exclude: [NOT_TESTS, '/internal/infrastructure/messaging/'],
  why: 'abre solo la correlación del mensaje: compila, pasa todos los escenarios y corta la traza en cada consumo. Trata el mensaje dentro de messaging.Consume(ctx, deps.Telemetry, envelope.Metadata, func(ctx context.Context) error { ... })',
  sample: 'ctx = messaging.Inbound(ctx, envelope.Metadata)',
  allowed: 'err = messaging.Consume(ctx, deps.Telemetry, envelope.Metadata, handle)'
};

export function generate(model) {
  if (!usesTelemetry(model)) return [];
  return [{ path: 'infra/check-telemetry.sh', content: script(model), executable: true }];
}

function script(model) {
  const why = ` (las claves admitidas: ${Object.values(ATTRIBUTES).filter((value) => value !== ATTRIBUTES.correlationId).join(', ')} y las de las series HTTP y de caché). Si el valor identifica algo —un id, una clave, un correo—, va al span (Attributes), no a la métrica`;
  const { sample: _sample, allowed: _allowed, ...consume } = CONSUME_RULE;
  return `#!/usr/bin/env bash
# check-telemetry.sh — cardinalidad de las métricas de ${model.service.name}, y la traza de cada consumo.
#
# Una etiqueta de métrica con muchos valores distintos multiplica las series: con el id del pedido dentro, tantas
# series como pedidos. No falla nada; se ve en la factura del backend. Por eso las claves de etiqueta son una lista
# CERRADA, la del vocabulario que estampa build. Lo que lleva un identificador va al SPAN. Y un listener que abre solo
# la correlación corta la traza sin que nada falle: el mensaje se trata dentro de messaging.Consume.
#
# Uso (desde la raíz del proyecto; no necesita infraestructura ni compilar):
#   bash infra/check-telemetry.sh
#
# Código de salida:
#   0  sin hallazgos
#   1  hay hallazgos → vuelven al agente de código
set -u

if [ ! -f go.mod ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró go.mod)." >&2
  exit 1
fi

${sourceGate({
  title: 'CARDINALIDAD DE LAS MÉTRICAS',
  label: 'cardinality',
  rules: [...TAG_RULES.map(({ id, keys, skip, pattern, exclude, why: reason }) => ({ id, keys, skip, pattern, exclude, why: reason + why })), consume],
  allowedKeys: allowedTagKeys(),
  footer: 'Ver docs/keel/conventions/observability.md § Reglas para quien escribe código.',
  platform: GO_SOURCE
})}
`;
}
