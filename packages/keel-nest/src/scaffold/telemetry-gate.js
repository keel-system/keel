// El gate de CARDINALIDAD de las métricas (incremento 14e de PLAN-KEEL-NEST.md): `infra/check-telemetry.sh`, el
// gemelo del de keel-spring traducido a TypeScript.
//
// Una etiqueta de métrica con muchos valores distintos multiplica las series —con el id del pedido dentro, tantas
// series como pedidos— y no falla nada: ni excepción, ni log, ni escenario rojo. Se ve en la factura del backend. Por
// eso las CLAVES de etiqueta son una lista cerrada: las del vocabulario neutral (menos la correlación, que es un
// atributo legítimo del SPAN y la peor etiqueta posible) y las de las series que la telemetría generada publica con
// los nombres de keel-spring (`http_server_requests`, `http_client_requests`, `cache_gets`).
//
// Gate de PROHIBICIÓN: nace verde sobre el árbol recién generado. Se juzga la clave cuando se ve —un literal, la
// forma corta o `[ATTRIBUTES.x]`—; una clave que llegue por una variable no la ve, igual que el de keel-spring no ve
// una constante. La salida de un hallazgo no es quitar el dato: es llevarlo al span (`spanAttributes`).

import { ATTRIBUTES, promTag, usesTelemetry } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { sourceGate } from './logging-check.js';

/** Las claves de etiqueta de las series que publica la telemetría generada fuera del vocabulario `keel.*`. */
export const PLATFORM_TAG_KEYS = ['method', 'uri', 'status', 'outcome', 'exception', 'client_name', 'cache', 'result'];

/** Las claves que SÍ pueden ser etiqueta de métrica, en todas las formas en que el código las escribe. */
export function allowedTagKeys() {
  const vocabulary = Object.entries(ATTRIBUTES).filter(([name]) => name !== 'correlationId');
  return [
    ...vocabulary.map(([, value]) => value),
    ...vocabulary.map(([, value]) => promTag(value)),
    ...vocabulary.map(([name]) => `ATTRIBUTES.${name}`),
    ...PLATFORM_TAG_KEYS,
    // La forma objeto de observe/inc con exemplars: { labels, value, exemplarLabels }.
    'labels',
    'value',
    'exemplarLabels'
  ];
}

/** Las formas en que el código pone etiquetas a una métrica. */
export const TAG_RULES = [
  {
    id: 'labelNames',
    check: 'labelKeys',
    listOfStrings: true,
    pattern: String.raw`labelNames\s*:\s*\[([^\]]*)\]`,
    why: 'una métrica con una etiqueta fuera del vocabulario'
  },
  {
    id: 'labels',
    check: 'labelKeys',
    pattern: String.raw`\blabels\s*:\s*\{([^}]*)\}`,
    why: 'una observación con una etiqueta fuera del vocabulario'
  },
  {
    id: 'inc',
    check: 'labelKeys',
    // `set` solo con el valor detrás de las etiquetas (`gauge.set({…}, n)`): con un único objeto es el `.set({…})` del
    // QueryBuilder de TypeORM, que asigna columnas y no es una métrica.
    pattern: String.raw`\.(?:inc|dec|labels|startTimer)\s*\(\s*\{([^}]*)\}|\.set\s*\(\s*\{([^}]*)\}\s*,`,
    why: 'un contador o un gauge con una etiqueta fuera del vocabulario'
  }
];

export function generate(model) {
  if (!usesTelemetry(model)) return [];
  return [{ path: 'infra/check-telemetry.sh', content: script(model) }];
}

function script(model) {
  const why = ` (las claves admitidas: ${Object.values(ATTRIBUTES).filter((value) => value !== ATTRIBUTES.correlationId).join(', ')} y las de las series HTTP y de caché). Si el valor identifica algo —un id, una clave, un correo—, va al span (spanAttributes), no a la métrica`;
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
  rules: TAG_RULES.map((rule) => ({ ...rule, why: rule.why + why })),
  allowedKeys: allowedTagKeys(),
  footer: 'Ver docs/keel/conventions/observability.md § Reglas para quien escribe código.'
})}
`;
}
