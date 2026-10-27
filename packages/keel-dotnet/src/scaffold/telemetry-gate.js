// El gate de CARDINALIDAD de las métricas (incremento 14e de PLAN-KEEL-DOTNET.md): `infra/check-telemetry.sh`, el
// gemelo del de keel-spring y keel-nest con patrones de C#.
//
// Una etiqueta de métrica con muchos valores distintos multiplica las series —con el id del pedido dentro, tantas series
// como pedidos— y no falla nada: ni excepción, ni log, ni escenario rojo. Se ve en la factura del backend. Por eso las
// CLAVES de etiqueta son una lista cerrada: las del vocabulario neutral (menos la correlación, que es un atributo
// legítimo del SPAN y la peor etiqueta posible) y las de las series que la telemetría generada publica con los nombres
// de keel-spring (`http_server_requests`, `http_client_requests`, `cache_gets`).
//
// Gate de PROHIBICIÓN: nace verde sobre el árbol recién generado. Se juzga la clave cuando se ve en la línea —un
// literal o `TelemetryAttributes.X`—: una clave que llegue por una variable, o un inicializador repartido en varias
// líneas, no lo ve, igual que el de keel-spring no ve una constante. La salida de un hallazgo no es quitar el dato: es
// llevarlo al span (`SpanAttributes`).

import { ATTRIBUTES, promTag, usesTelemetry } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { sourceGate } from '@keel-system/keel-core/gen/source-gate';
import { CS_SOURCE } from './logging-check.js';

/** Las claves de etiqueta de las series que publica la telemetría generada fuera del vocabulario `keel.*`. */
export const PLATFORM_TAG_KEYS = ['method', 'uri', 'status', 'outcome', 'exception', 'client_name', 'cache', 'result'];

/** Las claves que SÍ pueden ser etiqueta de métrica, en todas las formas en que el código las escribe. */
export function allowedTagKeys() {
  const vocabulary = Object.entries(ATTRIBUTES).filter(([name]) => name !== 'correlationId');
  return [
    ...vocabulary.map(([, value]) => value),
    ...vocabulary.map(([, value]) => promTag(value)),
    ...vocabulary.map(([name]) => `TelemetryAttributes.${name[0].toUpperCase()}${name.slice(1)}`),
    ...PLATFORM_TAG_KEYS
  ];
}

/** Las formas en que el código pone etiquetas a una métrica, cada una con su forma prohibida y su forma correcta. */
export const TAG_RULES = [
  {
    id: 'labels',
    keys: 'brackets',
    pattern: 'Labels[[:space:]]*=[[:space:]]*new[[:space:]]+Dictionary[^{]*[{][^}]*[}]',
    why: 'una observación con una etiqueta fuera del vocabulario',
    sample: 'var options = new ObserveOptions { Labels = new Dictionary<string, string> { ["order_id"] = id } };',
    allowed: 'var options = new ObserveOptions { Labels = new Dictionary<string, string> { [TelemetryAttributes.Operation] = operation } };'
  },
  {
    id: 'labelNames',
    keys: 'strings',
    pattern: 'LabelNames[[:space:]]*=[[:space:]]*([[]|new[^{]*[{])[^]}]*',
    why: 'una métrica con una etiqueta fuera del vocabulario',
    sample: 'var config = new CounterConfiguration { LabelNames = ["customer_email"] };',
    allowed: 'var config = new CounterConfiguration { LabelNames = ["keel_operation", "keel_outcome"] };'
  },
  {
    id: 'createMetric',
    keys: 'strings',
    // El nombre y la ayuda son los dos primeros literales; lo que sigue son los nombres de las etiquetas.
    skip: 2,
    pattern: 'Create(Counter|Gauge|Histogram|Summary)[[:space:]]*[(][[:space:]]*"[^"]*"[[:space:]]*,[[:space:]]*"[^"]*"[[:space:]]*,[^)]*',
    why: 'una métrica con una etiqueta fuera del vocabulario',
    sample: 'var orders = metrics.CreateCounter("orders_total", "Pedidos", "order_id");',
    allowed: 'var orders = metrics.CreateCounter("orders_total", "Pedidos", "keel_operation");'
  },
  {
    id: 'tags',
    keys: 'first-string',
    pattern: 'KeyValuePair<string,[[:space:]]*object[?]?>[[:space:]]*[(][[:space:]]*"[^"]*"',
    // El recurso de cada señal (service.*, deployment.environment) no es una etiqueta de métrica.
    exclude: ['/Telemetry/KeelTelemetry[.]cs$'],
    why: 'una medida de System.Diagnostics.Metrics con una etiqueta fuera del vocabulario',
    sample: 'counter.Add(1, new KeyValuePair<string, object?>("user_id", userId));',
    allowed: 'counter.Add(1, new KeyValuePair<string, object?>("keel.operation", operation));'
  }
];

export function generate(model) {
  if (!usesTelemetry(model)) return [];
  return [{ path: 'infra/check-telemetry.sh', content: script(model), executable: true }];
}

function script(model) {
  const why = ` (las claves admitidas: ${Object.values(ATTRIBUTES).filter((value) => value !== ATTRIBUTES.correlationId).join(', ')} y las de las series HTTP y de caché). Si el valor identifica algo —un id, una clave, un correo—, va al span (SpanAttributes), no a la métrica`;
  return `#!/usr/bin/env bash
# check-telemetry.sh — cardinalidad de las métricas de ${model.service.name}.
#
# Una etiqueta de métrica con muchos valores distintos multiplica las series: con el id del pedido dentro, tantas
# series como pedidos. No falla nada; se ve en la factura del backend. Por eso las claves de etiqueta son una lista
# CERRADA, la del vocabulario que estampa build. Lo que lleva un identificador va al SPAN.
#
# Uso (desde la raíz del proyecto; no necesita infraestructura ni compilar):
#   bash infra/check-telemetry.sh
#
# Código de salida:
#   0  sin hallazgos
#   1  hay hallazgos → vuelven al agente de código
set -u

if [ ! -d src ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró src/)." >&2
  exit 1
fi

${sourceGate({
  title: 'CARDINALIDAD DE LAS MÉTRICAS',
  label: 'cardinality',
  rules: TAG_RULES.map(({ id, keys, skip, pattern, exclude, why: reason }) => ({ id, keys, skip, pattern, exclude, why: reason + why })),
  allowedKeys: allowedTagKeys(),
  footer: 'Ver docs/keel/conventions/observability.md § Reglas para quien escribe código.',
  platform: CS_SOURCE
})}
`;
}
