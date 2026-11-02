// El panel y las alertas del servicio generado (solo con `telemetry: otel`, incremento 14d).
//
// Son los NEUTRALES de `keel-core/gen/observability-assets.js`, los mismos que generan los otros tres para el mismo diseño: la
// regla de equivalencia es que el mismo panel tenga datos con los cuatro servidores. Lo único de esta plataforma es la fila de
// RUNTIME (Go: el heap contra su límite, el tiempo en pausas de GC, las goroutines y el pool de database/sql), con las series
// de `GO_RUNTIME` (telemetry.js).
//
// Lo que no hay, dicho en voz alta, como en keel-nest y keel-dotnet: el pool del modelo DOCUMENTAL (el driver de MongoDB no lo
// publica sin suscribirse a sus eventos) y el retraso del consumidor (ningún cliente de broker de Go lo publica). Sin serie,
// ni fila ni alerta: una consulta sobre una serie que nadie publica deja el panel vacío y la alerta muda.

import { observabilityAssets, consultedSeries as neutralConsultedSeries } from '@keel-system/keel-core/gen/observability-assets';
import { usesRelational } from '@keel-system/keel-core/gen/features';
import { relationalEngine } from '../lib/relational-engine.js';
import { GO_RUNTIME, usesTelemetry } from './telemetry.js';
import { usesGoOutbox } from './messaging.js';

/** El nombre del driver en el panel. */
const POOL_LABEL = { postgresql: 'pgx', mysql: 'go-sql-driver/mysql' };

/** La plataforma de keel-go para el panel y las alertas neutrales. */
export const GO_OBSERVABILITY = {
  generator: 'keel-go',
  catalogPath: '@keel-system/keel-core/gen/infra-catalog.js',
  outbox: (model) => usesGoOutbox(model),
  runtime: {
    heap: {
      used: `sum(${GO_RUNTIME.heapUsed})`,
      max: `sum(${GO_RUNTIME.heapLimit})`,
      summary:
        'El heap lleva diez minutos por encima del 90 % de la memoria que el proceso puede usar (GOMEMLIMIT o el límite del ' +
        'contenedor). Lo que viene después es GC continuo y, al final, el proceso muriendo por falta de memoria — que sí se ve, ' +
        'pero cuando ya no hay nada que hacer.'
    },
    // Segundos de pausa por segundo de reloj: cuánto del tiempo se le va al GC.
    gcSeconds: GO_RUNTIME.gcSeconds,
    extraPanels: [
      {
        // El síntoma propio de Go: una goroutine que no termina no falla, se acumula.
        title: 'Goroutines en marcha',
        targets: [{ expr: `max(${GO_RUNTIME.goroutines})`, legend: 'goroutines' }]
      }
    ],
    pool: (model) => (usesRelational(model) ? { label: POOL_LABEL[relationalEngine(model)], ...GO_RUNTIME.pool } : null),
    consumerLag: () => null
  }
};

export function generate(model) {
  return usesTelemetry(model) ? observabilityAssets(model, GO_OBSERVABILITY) : [];
}

/** Las series que consultan el panel y las alertas de ESTE diseño: la prueba emitida exige que el scrape las publique todas. */
export function consultedSeries(model) {
  return neutralConsultedSeries(model, GO_OBSERVABILITY);
}
