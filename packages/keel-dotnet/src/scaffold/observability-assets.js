// El panel y las alertas del servicio generado (solo con `telemetry: otel`, incremento 14d de PLAN-KEEL-DOTNET.md).
//
// Son los NEUTRALES de `keel-core/gen/observability-assets.js`, los mismos que generan keel-spring y keel-nest para el
// mismo diseño: la regla de equivalencia es que el mismo panel tenga datos con los tres servidores. Lo único de esta
// plataforma es la fila de RUNTIME (.NET: el heap gestionado contra su límite, el tiempo en pausas de GC, la cola del
// thread pool y el pool del driver), con las series de `DOTNET_RUNTIME` (telemetry.js).
//
// Lo que no hay, dicho en voz alta, como en keel-nest: el pool del modelo DOCUMENTAL (MongoDB.Driver no lo publica sin
// suscribirse a sus eventos) y el retraso del consumidor (librdkafka lo calcula en sus estadísticas, pero ningún
// servidor de .NET lo publica todavía). Sin serie, ni fila ni alerta: una consulta sobre una serie que nadie publica
// deja el panel vacío y la alerta muda.

import { observabilityAssets, dashboardUid } from 'keel-core/gen/observability-assets';
import { DOTNET_RUNTIME, usesTelemetry } from './telemetry.js';
import { usesDotnetOutbox } from './messaging.js';
import { usesRelational } from './persistence.js';
import { poolMeter } from './relational-engine.js';

export { dashboardUid };

/** La plataforma de keel-dotnet para el panel y las alertas neutrales. */
export const DOTNET_OBSERVABILITY = {
  generator: 'keel-dotnet',
  catalogPath: 'keel-core/gen/infra-catalog.js',
  outbox: (model) => usesDotnetOutbox(model),
  runtime: {
    heap: {
      used: `sum(${DOTNET_RUNTIME.heapUsed})`,
      max: `sum(${DOTNET_RUNTIME.heapLimit})`,
      summary:
        'El heap gestionado lleva diez minutos por encima del 90 % de la memoria que el GC puede usar. Lo que viene después ' +
        'es GC continuo y, al final, el proceso muriendo por falta de memoria — que sí se ve, pero cuando ya no hay nada que hacer.'
    },
    // Segundos de pausa por segundo de reloj: cuánto del tiempo se le va al GC.
    gcSeconds: DOTNET_RUNTIME.gcSeconds,
    extraPanels: [
      {
        // El síntoma propio de .NET: código que bloquea hilos (.Result, .Wait()) deja trabajo esperando un hilo libre.
        title: 'Trabajo esperando un hilo (thread pool)',
        targets: [{ expr: `max(${DOTNET_RUNTIME.threadPoolQueue})`, legend: 'en cola' }]
      }
    ],
    pool: (model) => (usesRelational(model) ? { label: poolMeter(model).label, ...DOTNET_RUNTIME.pool } : null),
    consumerLag: () => null
  }
};

export function generate(model) {
  return usesTelemetry(model) ? observabilityAssets(model, DOTNET_OBSERVABILITY) : [];
}
