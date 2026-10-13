// ¿Puede el diseño tener escenarios de CLÚSTER —una segunda réplica del servidor contra la misma base—? Solo
// si declara alguna garantía «aunque haya varias réplicas»: el relay del outbox, un barrido por reloj o el
// registro de idempotencia de petición. Sin ninguna, el arnés no emite la réplica.
//
// Estaba escrito en los dos generadores con predicados distintos (incremento 1d de PLAN-KEEL-DOTNET.md): en
// keel-nest el «barrido por reloj» incluía las PURGAS de las tablas del generador, y la de `processed_event`
// existe con cualquier suscripción y persistencia. Un diseño con solo eso —suscripciones con persistencia, sin
// outbox, sin `schedule` y sin idempotencia de petición— tenía escenarios de clúster en keel-nest y no en
// keel-spring. Ninguna fixture tiene esa forma (las dos líneas base salieron idénticas al unificarlo), así que
// la diferencia no se había visto. Una purga es limpieza, no una garantía del diseño: manda la de keel-spring.

import { usesOutbox } from './messaging-stores.js';
import { hasScheduledOperations } from './scheduling.js';
import { registryOperations } from './request-idempotency.js';

export function usesClusterScenarios(model) {
  return usesOutbox(model) || hasScheduledOperations(model) || registryOperations(model).length > 0;
}
