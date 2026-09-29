# Corrida 2026-09-28 — `room-booking` v1.0.0, el diseño nuevo

Corrida 3 de R8. Es la única sobre un diseño hecho **desde cero** con el método (brief A: reservas de
salas con franjas, lista de espera y oferta con plazo), así que mide el método y no el retoque de una
fixture.

| | |
|---|---|
| Diseño | `room-booking` v1.0.0 (DSL 2.17, relacional) |
| Stack | postgresql · rabbitmq · keycloak |
| Generador | `keel-spring@0.1.5` |
| Diseño listo al generar | sí |
| Matriz final | **44/44 OK**, sin ciclos de arreglo |
| Huella del agente | 318 archivos registrados por `build`, 0 adoptados, **27 reescritos**, 0 borrados |
| Clasificación de la huella | 18 TODO · 0 consulta · 9 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (2 en `design-gaps.yaml`, los dos falsos positivos) |
| Huecos del generador | 6 |
| Agujeros de la puerta | 0 |
| Coste del diseño | careo 5; barrido 25→10; revisión 4→2 |
| Convertidos en id | ninguno |

## Lectura

**El diseño nuevo convergió antes y generó sin dejar decisiones.** Su careo cerró en una pasada; en
los retrofits hicieron falta dos y tres. De la huella, 18 archivos son TODO legítimo, porque todas las
reglas estaban escritas. Los otros 9 son del generador, casi todos por **el barrido `expireOffers`**,
que build generó mal de raíz:

- `sweep-claim-without-predicate` — `classifyClaims` trata como cola cualquier estado inicial
  (`Booking.offered`, `WaitlistEntry.waiting`) y genera reclamos sin predicado: habrían caducado
  ofertas vigentes y cerrado esperas vivas. FL-WTL-005-C lo habría falsado. build ignoró incluso el
  índice `[status, offerExpiresAt]`, cuyo comentario dice «el barrido expireOffers: estado + plazo».
- `sweep-claim-per-transition` — build genera un reclamo por cada transición del barrido, incluida
  waiting→offered, que es efecto de la promoción y no algo que se seleccione.
- `sweep-single-tx-dispatch` — el reclamo confirma el estado terminal en REQUIRES_NEW y después
  `dispatch()` procesa el lote en una sola transacción. Un 409 deja filas a medias, y contradice la
  regla «una transacción por oferta».
- `rescue-wait-with-deadline` — el aviso de «estado en vuelo» sobre `WaitlistEntry.offered` es un
  falso positivo, como sostuvo el diseñador: es una espera humana acotada por
  `Booking.offerExpiresAt`, no trabajo a medias. Es el hallazgo del método 3.
- `sweep-emissions-unassigned` — ni `WaitlistEntryLapsed` ni `WaitlistOfferMade` tenían TODO de
  emisión en `expireOffers`, y `WaitlistEntry` se generó sin buffer de eventos.
- `keycloak-one-user-per-role` — los escenarios de titularidad necesitan dos empleados distintos, y
  el script de Keycloak siembra uno por rol. El agente creó el segundo en `BookingFlowSupport`.

La raíz de los tres primeros tiene lado de DSL: **no hay dónde declarar el predicado de selección de
un barrido** (el campo temporal y el plazo). build rellena el vacío infiriendo «cola = estado
inicial». No es un designGap, porque la prosa lo decía y el agente no tuvo que elegir. Pero una
segunda corrida con un barrido sobre una espera con plazo lo volvería recurrente.

## Arbitraje

Acepto la clasificación. Las dos entradas de `design-gaps.yaml` son falsos positivos del agente
generador:

- **`bookingId` nulo u omitido en `WaitlistEntryLapsed`.** Lo fijan `conventions.nulls: include`, el
  Then de FL-WTL-005-B (`bookingId` = `null`) y la clase 12 de `gaps.yaml`. Observación: la aserción
  del IT no distingue nulo de omitido.
- **La espera al tick de `expireOffers`.** Lo fijan el cron `* * * * *` y la convención de escenarios
  («espera a su siguiente tick», ~90 s según `integration-tests.md`).

## Revalidación con la puerta de 11 criterios (2026-09-29)

Al entrar el criterio `incoherences`, este diseño salió en rojo por 6 avisos `CHK-USECASES-MULTI-AGGREGATE`, y la corrida se marcó superada. Ese aviso se separó después por frontera. Con `per-operation` es la decisión `CHK-USECASES-MULTI-AGGREGATE-TX`, por operación, y room-booking la acepta en `decisions.yaml` citando §3.7, que ya la registraba. Con eso cruza 11/11 **sin cambiar el diseño**. La salida de `build` es idéntica byte a byte a la de esta corrida (318 archivos, 0 distintos), así que la corrida sigue midiendo un diseño que la puerta actual deja pasar, y se rehabilita. Regenerar habría medido la variación del agente ante la misma entrada, no el diseño.

## designGaps

Ninguno.
