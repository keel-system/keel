---
name: keel-go-rabbitmq
description: Guía de mensajería con RabbitMQ en un proyecto generado por keel-go — el envío del outbox o de los publishers best-effort y los listeners de las suscripciones, en cmd/server/broker.go; la conexión, la topología, el reintento y la DLQ ya los genera build. Usar cuando keel-stack.json declara broker "rabbitmq".
---

# RabbitMQ (broker: `rabbitmq`)

Casi todo lo de RabbitMQ sale **de build**, y es el mismo servidor que los de keel-spring, keel-nest y keel-dotnet del
diseño: mismos exchanges, colas, DLQ, variables de entorno y tablas. Lo tuyo es poco y concreto: **el envío** y **los
listeners**, en un solo archivo. No reescribas lo demás.

| Pieza (build) | Dónde | Qué hace |
|---|---|---|
| Conexión | `internal/infrastructure/rabbitmq/connection.go` | Una por proceso (`Connection`). `Run` la mantiene en el errgroup del arranque: conecta, declara la topología y reconecta cuando cae. El servicio arranca SIN broker |
| Topología y reintento | `internal/infrastructure/rabbitmq/topology.go` | Consumo: exchange del canal de origen, cola propia (`messaging.subscriptions.<e>.queue`) enlazada con `#`, y su DLQ. Publicación: el exchange del servicio y una cola por canal publicado. La curva de `onFailure.retry` (`ListenerAttempts`, `ListenerBackoff`) e `IsRetryable`: ni el `*domain.Error` ni el `*messaging.ContractError` se reintentan |
| Envoltura y eventos | `internal/infrastructure/messaging/envelope.go`, `<evento>_integration_event.go` | La envoltura del cable (`NewEnvelope`, `Envelope.Wire`, `ParseEnvelope`) y lo que viaja de cada evento |
| Puente | `internal/infrastructure/messaging/bridge.go` | Los repositorios ya le entregan los eventos al guardar: escribe el outbox o publica tras el commit. **No lo llames tú** |
| Outbox | `internal/infrastructure/messaging/outbox.go` | El relay, el backoff y la rendición; el puerto `Dispatcher` con un respaldo que no deja arrancar fuera de `local`/`test` |
| Mensajes | `internal/infrastructure/messaging/<evento>_message.go` | `Read<Evento>Message` y `RequireContract`; su comentario dice **el orden de la guarda y el despacho** de esa suscripción |
| Deduplicación | `internal/infrastructure/messaging/guard.go` | `IdempotencyGuard`: `AlreadyProcessed`/`Record`/`TryRecord`, en su propia transacción |
| Correlación | `internal/infrastructure/messaging/inbound.go` | `Inbound(ctx, metadata)`: el contexto con la correlación de origen, que heredan los eventos que provoque |
| Configuración | `config/parameters/<perfil>/messaging.yaml` y `rabbitmq.yaml` | Destino, routing keys, colas, relay y conexión (`RABBITMQ_*`), en `messaging.Settings` |
| Lo que se intercambia | `cmd/server/messaging.go` | Los tipos `outbound`, `inbound` y `listener` que usa tu archivo |

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "rabbitmq"`.
- Lee `specs/messaging.keel.yaml` (eventos, `reliability`, suscripciones con su `contract` y `onFailure`) y el
  comentario de cada mensaje (`internal/infrastructure/messaging/<evento>_message.go`): es el contrato de recepción
  ya traducido, con el despacho escrito.
- Sigue `{{keel:docs}}/conventions/concurrency.md` y `{{keel:docs}}/conventions/errors.md`.

## Lo que escribes: `cmd/server/broker.go`

Es el único archivo tuyo de la mensajería (build lo siembra una vez, sin la cabecera de código generado, y no lo pisa).
Tiene dos funciones que llama `run`:

- **`brokerAdapters(settings, rabbit, logger) (outbound, error)`**, antes de construir los repositorios: el envío.
- **`messageListeners(deps inbound) ([]listener, error)`**, después de los casos de uso: un `listener` por cola, que
  el arranque pone en su goroutine.

Lo que dejes a `nil` en `outbound` es el respaldo de build. No lo borres: `messaging.NewDispatcherFallback` no deja
arrancar fuera de `local`/`test` si un día vuelve a faltar el dispatcher.

### El envío — `reliability: outbox`

El payload que recibes **ya es la envoltura serializada**: mándalo tal cual. `Publish` vuelve cuando el broker
CONFIRMA, y devuelve `rabbitmq.ErrUnavailable` (`errors.Is`) si no hay conexión, si lo rechaza, si el mensaje no tenía
cola (`mandatory`) o si vence el plazo; el relay cuenta ese fallo y reintenta. **Devuelve el error tal cual**: marcar
como publicado lo que no salió es lo que el outbox existe para impedir.

```go
type outboxDispatcher struct {
	rabbit *rabbitmq.Connection
}

func (d outboxDispatcher) Dispatch(ctx context.Context, destination, routingKey, eventType, payload string) error {
	return d.rabbit.Publish(ctx, destination, routingKey, eventType, payload, nil)
}

func brokerAdapters(_ messaging.Settings, rabbit *rabbitmq.Connection, _ *slog.Logger) (outbound, error) {
	return outbound{Dispatcher: outboxDispatcher{rabbit: rabbit}}, nil
}
```

### El envío — `reliability: best-effort`

Uno por evento, implementando su puerto `messaging.<Evento>Publisher`. El puente lo invoca DESPUÉS del commit; un
error se registra y el evento se pierde (es lo que el diseño eligió).

```go
type dailyDigestClosedPublisher struct {
	rabbit   *rabbitmq.Connection
	settings messaging.Settings
}

func (p dailyDigestClosedPublisher) Publish(ctx context.Context, event messaging.DailyDigestClosedIntegrationEvent) error {
	payload, err := messaging.NewEnvelope(ctx, event.Metadata, event).Wire()
	if err != nil {
		return err
	}
	return p.rabbit.Publish(ctx, p.settings.Destination, p.settings.RoutingKeys["DailyDigestClosed"], "DailyDigestClosed", payload, nil)
}
```

Va en `outbound{Publishers: messaging.Publishers{DailyDigestClosed: dailyDigestClosedPublisher{…}}}`. El destino y la
routing key salen de `messaging.Settings`, nunca literales; el tipo es el **nombre del evento en el diseño** (sobre él
filtran los consumidores).

### Los listeners — uno por COLA, no por suscripción

Cuenta las colas antes de escribir el primero: varias suscripciones de la misma fuente comparten cola
(`deps.Settings.Subscriptions[<e>].Queue`; el comentario de `messageListeners` las lista), y dos `Consume` sobre una
cola **compiten** —cada mensaje llega a uno solo—. Un listener por cola, que enruta por el tipo:

```go
func messageListeners(deps inbound) ([]listener, error) {
	queue := deps.Settings.Subscriptions["StockReserved"].Queue
	handle := func(ctx context.Context, message rabbitmq.Message) error {
		envelope, err := messaging.ParseEnvelope(message.Body) // *messaging.ContractError si no es una envoltura
		if err != nil {
			return err
		}
		ctx = messaging.Inbound(ctx, envelope.Metadata)
		switch envelope.Metadata.EventType {
		case "StockReserved":
			payload, err := messaging.ReadStockReservedMessage(envelope.Data)
			if err != nil {
				return err
			}
			if err := payload.RequireContract(); err != nil {
				return err
			}
			eventID := envelope.Metadata.EventID
			// El orden que dice el comentario de StockReservedMessage:
			if seen, err := deps.Guard.AlreadyProcessed(ctx, "inventory-events", eventID); err != nil || seen {
				return err
			}
			err = deps.UseCases.ApplyStockReserved.Handle(ctx, application.ApplyStockReservedCommand{OrderID: *payload.OrderID})
			if err != nil && !raceResolved(err) {
				return err
			}
			return deps.Guard.Record(ctx, "inventory-events", eventID)
		default:
			return nil // un evento de la fuente que este servicio no consume: se confirma sin efecto
		}
	}
	return []listener{func(ctx context.Context) error { return deps.Rabbit.Consume(ctx, queue, handle) }}, nil
}

// raceResolved dice si el despacho perdió una carrera que otro camino ya resolvió (el comentario del mensaje la anota).
func raceResolved(err error) bool {
	return errors.Is(err, domain.ErrInvalidStateTransition) || errors.Is(err, domain.ErrConcurrentModification)
}
```

Las cuatro reglas que deciden si un mensaje se pierde, en `references/listeners.md` con su porqué:

1. **Lo ajeno se confirma con `return nil`; lo propio roto se DEVUELVE como error.** `nil` confirma y borra el
   mensaje: un cuerpo tuyo que no se lee o incumple el contrato tiene que llegar a la DLQ, y llega devolviendo el
   `*messaging.ContractError` que ya dan `Read<Evento>Message` y `RequireContract` (descarte sin reintento).
2. **El orden de la guarda lo dicta el diseño** (el comentario del mensaje), no tú. Y el reintento en memoria repite
   la MISMA entrega: con `TryRecord`, el primer reintento se encuentra el mensaje marcado.
3. **La carrera ya resuelta no es un fallo**: `domain.ErrInvalidStateTransition` o `domain.ErrConcurrentModification`
   cuando otro camino llegó antes se confirman (y con el orden `Record`, se registran igual).
4. **Devolver un error es fallar**: un `*domain.Error` va a la DLQ sin reintento (salvo el «no existe» donde la cola lo
   reintenta); cualquier otro error se reintenta con la curva del diseño. No lo envuelvas en otro tipo ni lo captures
   para «reintentar».

## Qué no hacer

- **No declares topología** (`ExchangeDeclare`, `QueueDeclare`, `QueueBind`) ni abras otra conexión o canal con
  amqp091: build ya declara todo, y RabbitMQ rechaza con `PRECONDITION_FAILED` una cola redeclarada con otros
  argumentos.
- **No llames al puente ni al relay**, ni escribas en `outbox_event`: los eventos salen solos al guardar.
- **No escribas otro registro de procesados** ni otro reintento: son de build.
- **No confirmes ni rechaces a mano** (`Ack`/`Nack`): el desenlace lo pone la conexión según lo que devuelva tu
  handler, y el `rabbitmq.Message` no te da la entrega a propósito.
- **No lances goroutines** desde el handler: las entregas de una cola se procesan de una en una, y el apagado espera a
  la que esté en vuelo; una goroutine suelta quedaría fuera de las dos cosas.

## Validación

`go build ./...` y `go vet ./...` limpios; con la infra arriba, la UI de management (`http://localhost:15672`,
guest/guest) muestra exchanges, colas, mensajes y la conexión del servicio (con el nombre del servicio). Las pruebas de
flujo usan los helpers del arnés (`s.Deliver<Suscripción>`, `s.PublishedMessages`, `s.DeadLetterMessages`,
`s.StopBroker`…, `{{keel:docs}}/conventions/integration-tests.md` § La mensajería).

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/listeners.md` | Al escribir un listener: cola compartida, contratos `keel`/`wrapped`/`none`, el orden de la guarda, la carrera y la identidad del emisor |
| `references/troubleshooting.md` | Si un mensaje no llega, llega dos veces, no va a la DLQ o el outbox se rinde |
