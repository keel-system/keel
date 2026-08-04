# Ejemplo trabajado — venta de tickets de aerolínea

Un encargo real recortado y su descomposición completa. Sirve para calibrar el **grano**: cuántos
servicios salen de un TDR de este tamaño, qué se queda fuera y cuánto detalle lleva un brief.

No es una plantilla que copiar. Es una referencia de nivel de detalle.

## 1. El encargo (extracto del TDR)

> Se requiere una plataforma de venta de billetes de avión para web y app móvil. El usuario busca
> vuelos por origen, destino y fecha; ve el precio total con impuestos; elige asiento; paga con
> tarjeta; y recibe su billete electrónico y el itinerario por email. La aerolínea carga los vuelos
> programados por temporada y puede cancelar un vuelo, lo que obliga a avisar a todos los pasajeros
> afectados y a reembolsarles. Las tarifas cambian a diario según ocupación. Un asiento no puede
> venderse dos veces. Si el pago falla, el asiento debe volver a estar disponible. El cobro con
> tarjeta se hace contra la pasarela ya contratada por la compañía y debe cumplir PCI-DSS.
> Se espera un pico de 20.000 búsquedas por minuto en campaña y unas 3.000 ventas al día.

## 2. Los cinco inventarios

**Capacidades:** programar vuelo · cancelar vuelo · buscar vuelos · cotizar precio · consultar
disponibilidad · retener asiento · liberar asiento · crear reserva · confirmar reserva · cancelar
reserva · cobrar · reembolsar · emitir billete · enviar itinerario · avisar cancelación.

**Conceptos con ciclo de vida propio:** `Flight`, `Segment`, `Route`, `Fare`, `SeatMap`, `SeatHold`,
`Booking` (PNR), `Passenger`, `Payment`, `Refund`, `Ticket`, `Notification`.

**Actores:** pasajero (web y app) · operaciones de la aerolínea (carga y cancela vuelos) · la pasarela
de pago (sistema externo) · los propios servicios entre sí.

**Eventos de negocio:** se programó un vuelo · se canceló un vuelo · se retuvo un asiento · se liberó
un asiento · se cobró · falló el cobro · se reembolsó · se confirmó una reserva · se canceló una
reserva · se emitió un billete.

**Restricciones que fuerzan frontera:** PCI-DSS sobre el cobro · "un asiento no puede venderse dos
veces" (invariante fuerte) · 20.000 búsquedas/minuto contra 3.000 ventas/día (cuatro órdenes de
magnitud) · tarifas diarias contra rutas por temporada (cadencias distintas) · la pasarela ya existe.

**Huecos del TDR que hay que preguntar:** ¿cuánto dura una retención de asiento? ¿se puede cambiar de
asiento después de pagar? ¿el reembolso es total o según tarifa? ¿quién es el dueño del histórico del
pasajero — hay fidelización? Ninguno se resuelve solo: se pregunta antes de dibujar fronteras.

## 3. Las fronteras, con el eje que las corta

| Servicio | Es la única fuente de verdad de | Eje que lo corta |
|---|---|---|
| `flight-catalog` | Qué se puede volar y cuándo | 2 (dueño: operaciones) + 3 (temporada vs. diario) |
| `fare-pricing` | Cuánto cuesta volar un tramo hoy | 3 (cambia a diario) + 4 (soporta el pico de búsqueda) |
| `seat-inventory` | Si un asiento está libre, retenido o confirmado | **1** (la invariante "no se vende dos veces" vive aquí y solo aquí) |
| `booking` | El estado de una reserva (PNR) | 1 (el PNR tiene ciclo de vida e invariantes propias) |
| `payments` | El estado de un cobro | **5** (PCI-DSS) |
| `ticketing` | Qué billete se emitió y con qué contenido | 2 (documento legal con reglas propias) |
| `notifications` | Qué aviso se envió a quién y con qué resultado | 2 + ya resuelto en el registry |

Y la mitad que se olvida — lo que **no** es de cada uno:

- `seat-inventory` no sabe **precios** ni quién es el pasajero: solo si el asiento está libre.
- `booking` no sabe **cobrar**: pide un cobro y reacciona al resultado.
- `payments` no sabe **qué** está cobrando: recibe un importe y un identificador opaco.
- `flight-catalog` no sabe de **asientos**: sabe que un vuelo tiene una configuración de cabina.
- `ticketing` no **decide** si la reserva es válida: emite lo que `booking` confirmó.

### Dos decisiones que se ven venir mal

**El ciclo `booking ↔ payments` no existe.** La primera versión del mapa suele dibujar que `payments`
consulta a `booking` el importe. En cuanto se dibuja, hay ciclo. Pero `payments` no necesita conocer
`booking`: recibe importe, moneda y un `reference` opaco en la petición de cobro. Al quitar esa arista
el ciclo desaparece **y** `payments` gana algo más valioso que el orden de construcción: sirve para
cobrar cualquier cosa, no solo reservas. **Un ciclo aparente casi siempre es una arista dibujada al
revés.**

**Autenticación no es un servicio de este mapa.** Ni el gateway, ni la observabilidad. Son
infraestructura que se decide al generar (la capa `security` del DSL declara protocolo, roles y
clientes máquina; el proveedor concreto se elige en `keel-<tech> build`). Un `auth-service` en el mapa
es el antipatrón de frontera por capa técnica con otro nombre. Va a "Fuera de alcance".

**Lo que sí se descartó y por qué:** un `search-service` propio para el pico de búsquedas. Se propuso
por el eje 4, y se descartó porque no posee nada: buscar es una query de `flight-catalog` con la
cotización de `fare-pricing` al lado. Si el pico llega a doler, se resuelve con caché y réplicas de
lectura **dentro** de esos servicios, que es una decisión de generación, no de frontera. Un servicio
que no es fuente de verdad de nada no es un servicio.

## 4. El mapa de contextos

| Consumidor | Proveedor | Canal | Qué necesita | Estrategia | Bloq. |
|---|---|---|---|---|---|
| `fare-pricing` | `flight-catalog` | http | el tramo que se cotiza existe y su configuración | on-demand | sí |
| `seat-inventory` | `flight-catalog` | events | alta y cancelación de vuelos | replicated | sí |
| `booking` | `seat-inventory` | http | retener y confirmar el asiento | on-demand | sí |
| `booking` | `fare-pricing` | http | precio total al cotizar la reserva | on-demand | sí |
| `booking` | `payments` | http | iniciar el cobro de la reserva | on-demand | sí |
| `booking` | `payments` | events | resultado del cobro (`PaymentCaptured`, `PaymentFailed`) | — | sí |
| `payments` | `card-gateway` | http | autorización y captura de la tarjeta | on-demand | — (externo) |
| `ticketing` | `booking` | events | `BookingConfirmed` | — | sí |
| `ticketing` | `flight-catalog` | http | datos del vuelo que se imprimen en el billete | on-demand | sí |
| `notifications` | `booking` | events | `BookingConfirmed`, `BookingCancelled` | — | sí |
| `notifications` | `ticketing` | events | `TicketIssued` | — | sí |
| `notifications` | `flight-catalog` | events | `FlightCancelled` | — | sí |

Las dos aristas que enseñan la regla de corte del canal:

- `booking → seat-inventory` es **http** porque no se puede confirmar una reserva sin saber, en ese
  instante, que el asiento se retuvo. Un evento aquí significaría vender dos veces el mismo asiento.
- `seat-inventory → flight-catalog` es **events** porque el mapa de asientos se construye **cuando** se
  programa el vuelo. Consultarlo en cada búsqueda pondría el pico de tráfico del buscador sobre un
  servicio que cambia una vez por temporada.

Y la que enseña `strategy`: `seat-inventory` mantiene una **copia** de los vuelos (`replicated`) porque
la necesita para existir; `booking` **pregunta** el precio cada vez (`on-demand`) porque cotizar con un
precio de hace una hora es cobrar mal.

## 5. El orden de construcción

Lo calcula `keel system` a partir de las aristas bloqueantes. Con este mapa salen cinco olas:

| Ola | Servicios | Qué desbloquea al cerrar |
|---|---|---|
| 1 | `flight-catalog`, `payments` | los dos no dependen de nada nuestro; `payments` habla solo con la pasarela |
| 2 | `fare-pricing`, `seat-inventory` | ambos esperan el contrato del catálogo |
| 3 | `booking` | espera a los tres proveedores de la ola 2 y a `payments` |
| 4 | `ticketing` | espera el `BookingConfirmed` de `booking` |
| 5 | `notifications` | espera a los tres que le envían eventos |

Lo que hace que el orden no sea una opinión: el paso 2 de `/keel-design` pide el `INTEGRATION.md` del
proveedor, y `/keel-consume` degrada sin él. Diseñar `booking` antes de `seat-inventory` no es
imposible: es diseñarlo contra un contrato inventado.

`notifications` se deriva del registry (`derivedFrom: notifications-multichannel`), así que su ola es
una revisión del delta, no una sesión de diseño completa.

## 6. El `system.yaml` resultante

```yaml
system:
  name: airline-ticketing
  description: Venta y emisión de billetes de avión para web y app móvil.
  tdr: docs/system/tdr.md
services:
  flight-catalog:
    summary: Vuelos programados, rutas, tramos y configuración de cabina.
    responsibility: Única fuente de verdad de qué se puede volar y cuándo.
    notResponsible: [precio del billete, disponibilidad de asiento, datos del pasajero]
    owns: [Flight, Segment, Route, CabinLayout]
    publishes: [FlightScheduled, FlightCancelled]
    status: planned

  fare-pricing:
    summary: Tarifas, clases, impuestos y cotización de un tramo.
    responsibility: Única fuente de verdad de cuánto cuesta volar un tramo hoy.
    notResponsible: [cobro, qué asientos quedan, descuentos de fidelización]
    owns: [Fare, FareRule, TaxRule]
    consumes:
      - from: flight-catalog
        kind: http
        what: [existencia y configuración del tramo que se cotiza]
        strategy: on-demand
        why: Cotizar un tramo que no existe es un error de negocio; el dato se necesita en el instante.

  seat-inventory:
    summary: Disponibilidad y retención temporal de asientos por tramo.
    responsibility: Única fuente de verdad de si un asiento está libre, retenido o confirmado.
    notResponsible: [precio del asiento, datos del pasajero, emisión del billete]
    owns: [SeatMap, SeatHold]
    publishes: [SeatHeld, SeatReleased, SeatConfirmed]
    consumes:
      - from: flight-catalog
        kind: events
        what: [alta de vuelos, cancelación de vuelos]
        events: [FlightScheduled, FlightCancelled]
        strategy: replicated
        why: >
          El mapa de asientos nace al programarse el vuelo y se destruye al cancelarlo. Consultarlo
          en cada búsqueda pondría el pico del buscador sobre un servicio que cambia por temporada.

  booking:
    summary: La reserva (PNR), sus pasajeros y su ciclo de vida.
    responsibility: Única fuente de verdad del estado de una reserva.
    notResponsible: [cobrar, decidir el precio, vender el asiento, emitir el billete]
    owns: [Booking, Passenger, BookingItem]
    publishes: [BookingConfirmed, BookingCancelled]
    consumes:
      - from: fare-pricing
        kind: http
        what: [precio total con impuestos del itinerario]
        strategy: on-demand
        why: Las tarifas cambian a diario; cotizar con un precio viejo es cobrar mal.
      - from: payments
        kind: events
        what: [resultado del cobro]
        events: [PaymentCaptured, PaymentFailed]
        why: >
          La captura puede resolverse después de responder al usuario; el fallo tiene que liberar el
          asiento sin que nadie esté esperando.
    # Lo que sigue NO son datos que booking lea: son trabajos que encarga. Retener un
    # asiento y cobrar cambian estado en el otro servicio, y booking tiene que conocer la
    # firma de entrada de los dos. De ahí que la flecha la dibuje él y que los dos vayan
    # antes que booking en el orden de construcción.
    invokes:
      - to: seat-inventory
        kind: http
        what: [retener el asiento, confirmar el asiento]
        why: >
          No se puede confirmar una reserva sin saber en ese instante que el asiento quedó
          retenido: hace falta el desenlace, no un aviso.
      - to: payments
        kind: http
        what: [iniciar el cobro de la reserva]
        why: La reserva se confirma solo si el cobro se acepta; el resultado tardío llega por evento.

  payments:
    summary: Cobro y reembolso contra la pasarela contratada.
    responsibility: Única fuente de verdad del estado de un cobro o un reembolso.
    notResponsible: [qué se está cobrando, quién es el pasajero, el itinerario]
    owns: [Payment, Refund]
    publishes: [PaymentCaptured, PaymentFailed, RefundIssued]
    invokes:
      - to: card-gateway
        kind: http
        what: [autorizar la tarjeta, capturar el cargo, devolver el importe]
        why: El cargo real lo ejecuta la pasarela ya contratada; aquí se orquesta y se registra.

  card-gateway:
    summary: Pasarela de pago con tarjeta contratada por la compañía.
    responsibility: Autoriza y captura cargos contra la red de tarjetas.
    external: true

  ticketing:
    summary: Emisión del billete electrónico de una reserva confirmada.
    responsibility: Única fuente de verdad de qué billete se emitió y con qué contenido.
    notResponsible: [validar la reserva, cobrar, enviar el itinerario al pasajero]
    owns: [Ticket, Coupon]
    publishes: [TicketIssued]
    consumes:
      - from: booking
        kind: events
        what: [reservas confirmadas que hay que emitir]
        events: [BookingConfirmed]
        why: La emisión es consecuencia de la confirmación, no parte de ella; no debe bloquear la venta.
      - from: flight-catalog
        kind: http
        what: [datos del vuelo que se imprimen en el billete]
        strategy: on-demand
        why: >
          El billete es un documento legal: sus datos se leen de la fuente al emitir, no de una copia.

  notifications:
    summary: Envío del itinerario y de los avisos de cancelación por email y SMS.
    responsibility: Única fuente de verdad de qué aviso se envió a quién y con qué resultado.
    notResponsible: [decidir si una reserva es válida, emitir el billete, reembolsar]
    owns: [Notification, Template]
    derivedFrom: notifications-multichannel
    # Aquí notifications es REACTIVO, no encargado: nadie le pide que avise, él decide
    # avisar ante hechos que ya pasaron, y por eso las aristas las dibuja él. El contraste
    # con `booking → payments` (arriba) es exactamente la distinción de esta skill: si el
    # TDR dijera "booking le pasa a notifications la plantilla y el destinatario", entonces
    # booking conocería su firma y la arista sería un `invokes` de booking.
    consumes:
      - from: booking
        kind: events
        what: [reservas confirmadas y canceladas que hay que comunicar]
        events: [BookingConfirmed, BookingCancelled]
        why: El aviso reacciona a lo que ya pasó; que el email falle no puede tumbar una venta.
      - from: ticketing
        kind: events
        what: [billetes emitidos que se adjuntan al itinerario]
        events: [TicketIssued]
        why: El itinerario se manda cuando el billete existe, no cuando la reserva se confirma.
      - from: flight-catalog
        kind: events
        what: [cancelaciones que hay que comunicar a los afectados]
        events: [FlightCancelled]
        why: >
          El TDR lo exige explícitamente: una cancelación obliga a avisar a todos los pasajeros.
```

## 7. Un brief completo

`docs/system/briefs/seat-inventory.md` — el nivel de detalle al que hay que llegar:

```markdown
---
service: seat-inventory
system: airline-ticketing
wave: 2
publishes: [SeatHeld, SeatReleased, SeatConfirmed]
consumes: [{ from: flight-catalog, kind: events, strategy: replicated, blocking: true }]
consumedBy: []
invokedBy: [booking]
---
# Brief — seat-inventory

> Encargo del sistema airline-ticketing. Candidatos, no decisiones: el diseño lo cierras tú con
> `/keel-design`.

## Qué resuelve
Saber, en todo momento y para cada tramo de un vuelo, qué asientos quedan; y permitir retenerlos
durante una compra para que dos pasajeros no puedan comprar el mismo.

## De qué es la única fuente de verdad
Del estado de cada asiento de cada tramo: libre, retenido o confirmado.

## Qué NO es suyo
- El **precio** del asiento — es de `fare-pricing`.
- Quién es el pasajero y qué reservó — es de `booking`.
- Los datos del vuelo (ruta, horario) — son de `flight-catalog`; aquí solo se mantiene la copia
  necesaria para construir el mapa de asientos.

## Conceptos que le pertenecen (candidatos a entidad)
- `SeatMap` — la parrilla de asientos de un tramo, derivada de la configuración de cabina.
- `SeatHold` — una retención temporal sobre un asiento, con caducidad.
- (candidata a réplica) `FlightSnapshot` — la copia local de los vuelos, alimentada por eventos.

## Capacidades (candidatas a caso de uso)
- consultar los asientos disponibles de un tramo
- retener un asiento para una compra en curso
- confirmar una retención
- liberar una retención (por cancelación o por caducidad)
- construir el mapa de asientos de un vuelo recién programado
- destruir el mapa de asientos de un vuelo cancelado

## Quién le consume y para qué
`booking`, por HTTP, para retener y confirmar asientos durante una venta. Eso significa **superficie
servidor-a-servidor**: al llegar a la capa `api` habrá que decidir si esas operaciones son propias
(`audience: services`) o compartidas, y `security` tendrá que modelar `booking` como cliente máquina
con mínimo privilegio.

## Integraciones acordadas en el mapa
- **`flight-catalog`, eventos, `replicated`.** Se mantiene una copia local de los vuelos porque el
  mapa de asientos nace al programarse el vuelo y consultarlo en cada búsqueda pondría el pico del
  buscador sobre un servicio que cambia por temporada. Eventos: `FlightScheduled`, `FlightCancelled`.
  El contrato está en `docs/flight-catalog/INTEGRATION.md`.

## Lo que el mapa ya decidió · lo que decides tú al diseñar
Ya decidido: la frontera, los conceptos que le pertenecen, que `booking` le consume por HTTP y que la
copia de vuelos se alimenta por eventos.

**Abierto, y es tuyo:** el ciclo de vida del `SeatHold` y su caducidad · si retener es idempotente y
con qué clave · la política de concurrencia cuando dos ventas piden el mismo asiento (es *la*
decisión de este servicio) · la frontera transaccional · si los eventos se publican con outbox · qué
pasa cuando llega un `FlightScheduled` de un vuelo que ya tenía mapa · qué hace una consulta si la
copia del vuelo no ha llegado todavía (`onMiss`).

## Extracto literal del TDR relevante
> "El usuario […] elige asiento […]. Un asiento no puede venderse dos veces. Si el pago falla, el
> asiento debe volver a estar disponible."
> "Se espera un pico de 20.000 búsquedas por minuto en campaña."

## Huecos del encargo que te afectan
El TDR no dice cuánto dura una retención. Pregúntalo antes de modelar el `lifecycle`.

## Cómo arrancar
    keel new seat-inventory
    /keel-design specs/seat-inventory
```

Fíjate en lo que el brief **no** hace: no escribe una sola línea de YAML del DSL, no decide la
concurrencia (la nombra como la decisión central y la deja abierta) y arrastra el hueco del TDR hasta
la persona que puede resolverlo.
