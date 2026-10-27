// El panel y las alertas del servicio generado (solo con `telemetry: otel`, incremento 14d de PLAN-KEEL-NEST.md).
//
// Son los NEUTRALES de `@keel-system/keel-core/gen/observability-assets.js`, los mismos que genera keel-spring para el mismo
// diseño: la regla de equivalencia es que el mismo panel tenga datos con los dos servidores. Lo único de esta
// plataforma es la fila de RUNTIME (Node: el heap contra su límite, el tiempo en GC, el retraso del bucle de eventos y
// el pool del driver relacional), con las series de `NODE_RUNTIME` (telemetry.js).
//
// Lo que no hay, dicho en voz alta: el pool del modelo DOCUMENTAL (el driver de Mongo no expone sus contadores sin
// suscribirse a sus eventos) y el retraso del consumidor (ningún cliente de los tres brokers lo publica desde Node).
// Sin serie, ni fila ni alerta: una consulta sobre una serie que nadie publica deja el panel vacío y la alerta muda.

import { observabilityAssets, dashboardUid } from '@keel-system/keel-core/gen/observability-assets';
import { NODE_RUNTIME } from './telemetry.js';
import { usesNestOutbox } from './messaging.js';
import { engineOf, usesRelational } from './persistence-entities.js';

export { dashboardUid };

/** La plataforma de keel-nest para el panel y las alertas neutrales. */
export const NEST_OBSERVABILITY = {
  generator: 'keel-nest',
  catalogPath: '@keel-system/keel-core/gen/infra-catalog.js',
  outbox: (model) => usesNestOutbox(model),
  runtime: {
    heap: {
      used: `sum(${NODE_RUNTIME.heapUsed})`,
      max: `sum(${NODE_RUNTIME.heapLimit})`,
      summary:
        'El heap lleva diez minutos por encima del 90 % de su límite. Lo que viene después es GC continuo y, al final, ' +
        'el proceso muriendo por falta de memoria — que sí se ve, pero cuando ya no hay nada que hacer.'
    },
    // Segundos de GC por segundo de reloj: cuánto del tiempo se le va a V8 en recolectar.
    gcSeconds: NODE_RUNTIME.gcSeconds,
    extraPanels: [
      {
        // El síntoma propio de Node: un trabajo síncrono largo bloquea TODAS las peticiones a la vez.
        title: 'Retraso del bucle de eventos (p99)',
        targets: [{ expr: `max(${NODE_RUNTIME.eventLoopLagP99})`, legend: 'p99' }],
        unit: 's'
      }
    ],
    pool: (model) => (usesRelational(model) ? { label: engineOf(model) === 'mysql' ? 'mysql2' : 'pg', ...NODE_RUNTIME.pool } : null),
    consumerLag: () => null
  }
};

export function generate(model) {
  return observabilityAssets(model, NEST_OBSERVABILITY);
}
