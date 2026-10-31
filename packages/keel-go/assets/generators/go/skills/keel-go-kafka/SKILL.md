---
name: keel-go-kafka
description: Guía de mensajería con Kafka en un proyecto generado por keel-go — el envío del outbox o de los publishers best-effort y los listeners de las suscripciones, en cmd/server/broker.go; la conexión, el consumo por grupo, el reintento y el descarte en <topic>.DLT ya los genera build. Usar cuando keel-stack.json declara broker "kafka".
---

# Kafka (broker: `kafka`)

Casi todo lo de Kafka sale **de build**, y es el mismo servidor que los de keel-spring, keel-nest y keel-dotnet del
diseño: mismos topics, consumer groups, `.DLT`, headers del descarte, variables de entorno y tablas. Lo tuyo es poco y
concreto: **el envío** y **los listeners**, en un solo archivo. No reescribas lo demás.

| Pieza (build) | Dónde | Qué hace |
|---|---|---|
| Conexión | `internal/infrastructure/kafka/connection.go` | Una por proceso (`Connection`). `Run` mantiene el productor en el errgroup del arranque (acks de todas las réplicas, idempotente); cada `Consume`, el consumidor de una suscripción con su grupo. El servicio arranca SIN broker y el cliente reconecta solo |
| Consumo y reintento | `internal/infrastructure/kafka/consumption.go` | Por suscripción: el topic de la fuente, su consumer group (`messaging.subscriptions.<e>.group-id`), si descarta en `<topic>.DLT` y si reintenta el «no existe». La curva (`ListenerAttempts`, `ListenerBackoff`) e `IsRetryable`: ni el `*domain.Error` ni el `*messaging.ContractError` se reintentan |
| Envoltura y eventos | `internal/infrastructure/messaging/envelope.go`, `<evento>_integration_event.go` | La envoltura del cable (`NewEnvelope`, `Envelope.Wire`, `ParseEnvelope`) y lo que viaja de cada evento |
| Puente | `internal/infrastructure/messaging/bridge.go` | Los repositorios ya le entregan los eventos al guardar: escribe el outbox o publica tras el commit. **No lo llames tú** |
| Outbox | `internal/infrastructure/messaging/outbox.go` | El relay, el backoff y la rendición; el puerto `Dispatcher` con un respaldo que no deja arrancar fuera de `local`/`test` |
| Mensajes | `internal/infrastructure/messaging/<evento>_message.go` | `Read<Evento>Message` y `RequireContract`; su comentario dice **el orden de la guarda y el despacho** de esa suscripción |
| Deduplicación | `internal/infrastructure/messaging/guard.go` | `IdempotencyGuard`: `AlreadyProcessed`/`Record`/`TryRecord`, en su propia transacción |
| Correlación | `internal/infrastructure/messaging/inbound.go` | `Inbound(ctx, metadata)`: el contexto con la correlación de origen, que heredan los eventos que provoque |
| Configuración | `config/parameters/<perfil>/messaging.yaml` y `kafka.yaml` | Destino, routing keys, topics y grupos, relay y conexión (`KAFKA_*`), en `messaging.Settings` |
| Lo que se intercambia | `cmd/server/messaging.go` | Los tipos `outbound`, `inbound` y `listener` que usa tu archivo |

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "kafka"`.
- Lee `specs/messaging.keel.yaml` (eventos, `reliability`, suscripciones con su `contract` y `onFailure`) y el
  comentario de cada mensaje (`internal/infrastructure/messaging/<evento>_message.go`): es el contrato de recepción
  ya traducido, con el despacho escrito.
- Sigue `{{keel:docs}}/conventions/concurrency.md` y `{{keel:docs}}/conventions/errors.md`.

## Lo que escribes: `cmd/server/broker.go`

Es el único archivo tuyo de la mensajería (build lo siembra una vez, sin la cabecera de código generado, y no lo pisa).
Tiene dos funciones que llama `run`:

- **`brokerAdapters(settings, kafkaConn, logger) (outbound, error)`**, antes de construir los repositorios: el envío.
- **`messageListeners(deps inbound) ([]listener, error)`**, después de los casos de uso: un `listener` por
  suscripción, que el arranque pone en su goroutine.

Lo que dejes a `nil` en `outbound` es el respaldo de build. No lo borres: `messaging.NewDispatcherFallback` no deja
arrancar fuera de `local`/`test` si un día vuelve a faltar el dispatcher.

### El envío — `reliability: outbox`

El payload que recibes **ya es la envoltura serializada**: mándalo tal cual, con la routing key como **clave del
registro** (los de la misma clave van a la misma partición, en orden). El tipo viaja dentro de la envoltura
(`metadata.eventType`), que es por donde filtran los consumidores. `Publish` vuelve cuando el broker CONFIRMA, y
devuelve `kafka.ErrUnavailable` (`errors.Is`) si no hay productor, si lo rechaza o si vence `delivery.timeout.ms`; el
relay cuenta ese fallo y reintenta. **Devuelve el error tal cual**: marcar como publicado lo que no salió es lo que el
outbox existe para impedir.

```go
type outboxDispatcher struct {
	kafka *kafka.Connection
}

func (d outboxDispatcher) Dispatch(ctx context.Context, destination, routingKey, eventType, payload string) error {
	return d.kafka.Publish(ctx, destination, routingKey, payload, nil)
}

func brokerAdapters(_ messaging.Settings, kafkaConn *kafka.Connection, _ *slog.Logger) (outbound, error) {
	return outbound{Dispatcher: outboxDispatcher{kafka: kafkaConn}}, nil
}
```

### El envío — `reliability: best-effort`

Uno por evento, implementando su puerto `messaging.<Evento>Publisher`. El puente lo invoca DESPUÉS del commit; un
error se registra y el evento se pierde (es lo que el diseño eligió).

```go
type dailyDigestClosedPublisher struct {
	kafka    *kafka.Connection
	settings messaging.Settings
}

func (p dailyDigestClosedPublisher) Publish(ctx context.Context, event messaging.DailyDigestClosedIntegrationEvent) error {
	payload, err := messaging.NewEnvelope(ctx, event.Metadata, event).Wire()
	if err != nil {
		return err
	}
	return p.kafka.Publish(ctx, p.settings.Destination, p.settings.RoutingKeys["DailyDigestClosed"], payload, nil)
}
```

Va en `outbound{Publishers: messaging.Publishers{DailyDigestClosed: dailyDigestClosedPublisher{…}}}`. El topic y la
clave salen de `messaging.Settings`, nunca literales.

### Los listeners — uno por SUSCRIPCIÓN

Cada suscripción tiene su consumer group, y cada grupo recibe el topic **entero**: dos suscripciones de la misma fuente
leen el mismo topic, y cada una se queda con lo suyo por el tipo. Una suscripción sin listener deja su grupo vacío y
sus mensajes sin leer (el arnés lo dice al abrir el flujo: «¿falta el listener de su suscripción?»).

```go
func messageListeners(deps inbound) ([]listener, error) {
	handleStockReserved := func(ctx context.Context, message kafka.Message) error {
		envelope, err := messaging.ParseEnvelope(message.Value) // *messaging.ContractError si no es una envoltura
		if err != nil {
			return err
		}
		if envelope.Metadata.EventType != "StockReserved" {
			return nil // otro evento del topic: es de otra suscripción (o de nadie), se confirma sin efecto
		}
		ctx = messaging.Inbound(ctx, envelope.Metadata)
		payload, err := messaging.ReadStockReservedMessage(envelope.Data)
		if err != nil {
			return err
		}
		if err := payload.RequireContract(); err != nil {
			return err
		}
		eventID := envelope.Metadata.EventID
		// El orden que dice el comentario de StockReservedMessage:
		if seen, err := deps.Guard.AlreadyProcessed(ctx, "stock-reserved", eventID); err != nil || seen {
			return err
		}
		err = deps.UseCases.ApplyStockReserved.Handle(ctx, application.ApplyStockReservedCommand{OrderID: *payload.OrderID})
		if err != nil && !raceResolved(err) {
			return err
		}
		return deps.Guard.Record(ctx, "stock-reserved", eventID)
	}
	return []listener{
		func(ctx context.Context) error { return deps.Kafka.Consume(ctx, "StockReserved", handleStockReserved) },
		// … uno por cada suscripción que lista el comentario de messageListeners
	}, nil
}

// raceResolved dice si el despacho perdió una carrera que otro camino ya resolvió (el comentario del mensaje la anota).
func raceResolved(err error) bool {
	return errors.Is(err, domain.ErrInvalidStateTransition) || errors.Is(err, domain.ErrConcurrentModification)
}
```

`Consume` recibe el **nombre de la suscripción en el diseño**, no el topic: el topic y el grupo los resuelve la
conexión desde `messaging.Settings` (con lo que el perfil haya renombrado).

Las cuatro reglas que deciden si un mensaje se pierde, en `references/listeners.md` con su porqué:

1. **Lo ajeno se confirma con `return nil`; lo propio roto se DEVUELVE como error.** `nil` confirma (el offset
   avanza): un cuerpo tuyo que no se lee o incumple el contrato tiene que llegar al descarte, y llega devolviendo el
   `*messaging.ContractError` que ya dan `Read<Evento>Message` y `RequireContract` (descarte sin reintento).
2. **El orden de la guarda lo dicta el diseño** (el comentario del mensaje), no tú. Y el reintento en memoria repite
   el MISMO registro: con `TryRecord`, el primer reintento se lo encuentra marcado.
3. **La carrera ya resuelta no es un fallo**: `domain.ErrInvalidStateTransition` o `domain.ErrConcurrentModification`
   cuando otro camino llegó antes se confirman (y con el orden `Record`, se registran igual).
4. **Devolver un error es fallar**: un `*domain.Error` va al descarte sin reintento (salvo el «no existe» donde la
   suscripción lo reintenta); cualquier otro error se reintenta con la curva del diseño. No lo envuelvas en otro tipo
   ni lo captures para «reintentar».

## Qué no hacer

- **No crees topics** ni abras otro cliente de franz-go: el productor y los consumidores son de build. En infra/ el
  broker crea el topic con el primer mensaje; en producción los gobierna la plataforma.
- **No llames al puente ni al relay**, ni escribas en `outbox_event`: los eventos salen solos al guardar.
- **No escribas otro registro de procesados** ni otro reintento, ni publiques tú en `<topic>.DLT`: son de build.
- **No confirmes offsets a mano**: el desenlace lo pone la conexión según lo que devuelva tu handler, y el
  `kafka.Message` no te da el registro a propósito.
- **No lances goroutines** desde el handler: los mensajes de una suscripción se procesan de uno en uno y el offset
  avanza después de cada desenlace; una goroutine suelta confirmaría lo que aún no ha terminado.

## Validación

`go build ./...` y `go vet ./...` limpios; con la infra arriba, `bash infra/validate-infra.sh` comprueba el broker. Las
pruebas de flujo usan los helpers del arnés (`s.Deliver<Suscripción>`, `s.PublishedMessages`, `s.DeadLetterMessages`,
`s.StopBroker`…, `{{keel:docs}}/conventions/integration-tests.md` § La mensajería); en Kafka la «purga» es una marca de
offset.

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/listeners.md` | Al escribir un listener: un grupo por suscripción, contratos `keel`/`wrapped`/`none`, el orden de la guarda, la carrera y la identidad del emisor |
| `references/troubleshooting.md` | Si un mensaje no llega, llega dos veces, no va al descarte o el outbox se rinde |
