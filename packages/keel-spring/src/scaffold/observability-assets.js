// El panel y las alertas del servicio generado (solo con `telemetry: otel`).
//
// Desde el incremento 14d de PLAN-KEEL-NEST.md el panel y las alertas son NEUTRALES
// (`@keel-system/keel-core/gen/observability-assets.js`): keel-nest genera los mismos para el mismo diseño, porque la regla de
// equivalencia es que el MISMO panel tenga datos con los dos servidores. Aquí queda lo único que es de esta
// plataforma: la fila de runtime de la JVM (heap y pausas de GC, el pool de Hikari o del driver de Mongo) y el
// retraso del consumidor que publica el cliente de Kafka.

import { observabilityAssets, dashboardUid } from '@keel-system/keel-core/gen/observability-assets';
import { RUNTIME_JVM, consumerLagFor, promMetric, runtimePool } from '../lib/telemetry-probes.js';
import { usesOutbox } from './outbox.js';

export { dashboardUid };

/** La plataforma de keel-spring para el panel y las alertas neutrales. */
export const SPRING_OBSERVABILITY = {
  generator: 'keel-spring',
  catalogPath: 'src/lib/stack-catalog.js',
  outbox: (model) => usesOutbox(model),
  runtime: {
    heap: {
      used: `sum(${RUNTIME_JVM.memoryUsed}{area="heap"})`,
      max: `sum(${RUNTIME_JVM.memoryMax}{area="heap"})`,
      summary:
        'El heap lleva diez minutos por encima del 90 %. Lo que viene después es GC continuo y, al final, ' +
        'un OutOfMemoryError — que sí se ve, pero cuando ya no hay nada que hacer.'
    },
    // Segundos de pausa por segundo de reloj: cuánto del tiempo se le va a la JVM en recolectar.
    gcSeconds: promMetric(RUNTIME_JVM.gcPause.replace(/_seconds$/, '')).sum,
    extraPanels: [],
    pool: (model) => runtimePool(model.persistenceKind),
    consumerLag: (model) => consumerLagFor(model.stack?.broker)
  }
};

export function generate(model) {
  return observabilityAssets(model, SPRING_OBSERVABILITY);
}
