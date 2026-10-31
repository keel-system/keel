---
name: keel-go-snssqs
description: Guía de mensajería con SNS/SQS en un proyecto generado por keel-go — el envío del outbox o de los publishers best-effort y los listeners de las suscripciones, en cmd/server/broker.go; la conexión, el sondeo de cada cola, el reintento por visibilidad y la DLQ ya los genera build, y la topología la siembra infra/init-messaging.sh. Usar cuando keel-stack.json declara broker "snssqs".
---

# SNS/SQS (broker: `snssqs`)

Casi todo lo de SNS/SQS sale **de build**, y es el mismo servidor que los de keel-spring, keel-nest y keel-dotnet del
diseño: mismos topics, colas, DLQ, `maxReceiveCount`, variables de entorno y tablas. Lo tuyo es poco y concreto: **el
envío** y **los listeners**, en un solo archivo. No reescribas lo demás.

| Pieza (build) | Dónde | Qué hace |
|---|---|---|
| Conexión | `internal/infrastructure/snssqs/connection.go` | Una por proceso (`Connection`), sobre el SDK de AWS para Go. `Run` la mantiene en el errgroup del arranque; cada `Consume`, el sondeo de la cola de una suscripción. El servicio arranca SIN broker: el sondeo reintenta mientras la cola no existe o LocalStack no responde |
| Consumo y reintento | `internal/infrastructure/snssqs/consumption.go` | Por suscripción: su cola propia (`messaging.subscriptions.<e>.queue`), su DLQ, sus recepciones (`MaxReceive`) y si reintenta el «no existe». La curva (`RetryVisibility`) e `IsRetryable`: ni el `*domain.Error` ni el `*messaging.ContractError` se reintentan |
| Topología | `infra/init-messaging.sh` | Topics, colas, DLQ con su RedrivePolicy y las suscripciones SNS→SQS con raw delivery y filtro por `eventType`. En AWS real la crea la plataforma (IaC), no la aplicación |
| Envoltura y eventos | `internal/infrastructure/messaging/envelope.go`, `<evento>_integration_event.go` | La envoltura del cable (`NewEnvelope`, `Envelope.Wire`, `ParseEnvelope`) y lo que viaja de cada evento |
| Puente | `internal/infrastructure/messaging/bridge.go` | Los repositorios ya le entregan los eventos al guardar: escribe el outbox o publica tras el commit. **No lo llames tú** |
| Outbox | `internal/infrastructure/messaging/outbox.go` | El relay, el backoff y la rendición; el puerto `Dispatcher` con un respaldo que no deja arrancar fuera de `local`/`test` |
| Mensajes | `internal/infrastructure/messaging/<evento>_message.go` | `Read<Evento>Message` y `RequireContract`; su comentario dice **el orden de la guarda y el despacho** de esa suscripción |
| Deduplicación | `internal/infrastructure/messaging/guard.go` | `IdempotencyGuard`: `AlreadyProcessed`/`Record`/`TryRecord`, en su propia transacción |
| Correlación | `internal/infrastructure/messaging/inbound.go` | `Inbound(ctx, metadata)`: el contexto con la correlación de origen, que heredan los eventos que provoque |
| Configuración | `config/parameters/<perfil>/messaging.yaml` y `snssqs.yaml` | Destino, routing keys, topics y colas, relay y conexión (`AWS_*`, `SQS_*`), en `messaging.Settings` |
| Lo que se intercambia | `cmd/server/messaging.go` | Los tipos `outbound`, `inbound` y `listener` que usa tu archivo |

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "snssqs"`.
- Lee `specs/messaging.keel.yaml` (eventos, `reliability`, suscripciones con su `contract` y `onFailure`) y el
  comentario de cada mensaje (`internal/infrastructure/messaging/<evento>_message.go`): es el contrato de recepción
  ya traducido, con el despacho escrito.
- Sigue `{{keel:docs}}/conventions/concurrency.md` y `{{keel:docs}}/conventions/errors.md`.

## Lo que escribes: `cmd/server/broker.go`

Es el único archivo tuyo de la mensajería (build lo siembra una vez, sin la cabecera de código generado, y no lo pisa).
Tiene dos funciones que llama `run`:

- **`brokerAdapters(settings, snssqsConn, logger) (outbound, error)`**, antes de construir los repositorios: el envío.
- **`messageListeners(deps inbound) ([]listener, error)`**, después de los casos de uso: un `listener` por
  suscripción, que el arranque pone en su goroutine.

Lo que dejes a `nil` en `outbound` es el respaldo de build. No lo borres: `messaging.NewDispatcherFallback` no deja
arrancar fuera de `local`/`test` si un día vuelve a faltar el dispatcher.

### El envío — `reliability: outbox`

El payload que recibes **ya es la envoltura serializada**: mándalo tal cual al topic, con el tipo del evento como
message attribute **`eventType`** (obligatorio: sobre él filtran las suscripciones, y sin él `Publish` falla) y la
routing key como atributo `routingKey`. SNS no tiene clave de mensaje. `Publish` vuelve cuando SNS lo ACEPTA, y
devuelve `snssqs.ErrUnavailable` (`errors.Is`) si el topic no existe, si aún no tiene ningún suscriptor confirmado
(SNS descartaría el mensaje sin error) o si SNS no responde; el relay cuenta ese fallo y reintenta. **Devuelve el error
tal cual**: marcar como publicado lo que no salió es lo que el outbox existe para impedir.

```go
type outboxDispatcher struct {
	snssqs *snssqs.Connection
}

func (d outboxDispatcher) Dispatch(ctx context.Context, destination, routingKey, eventType, payload string) error {
	return d.snssqs.Publish(ctx, destination, payload, map[string]string{"eventType": eventType, "routingKey": routingKey})
}

func brokerAdapters(_ messaging.Settings, snssqsConn *snssqs.Connection, _ *slog.Logger) (outbound, error) {
	return outbound{Dispatcher: outboxDispatcher{snssqs: snssqsConn}}, nil
}
```

### El envío — `reliability: best-effort`

Uno por evento, implementando su puerto `messaging.<Evento>Publisher`. El puente lo invoca DESPUÉS del commit; un
error se registra y el evento se pierde (es lo que el diseño eligió).

```go
type dailyDigestClosedPublisher struct {
	snssqs   *snssqs.Connection
	settings messaging.Settings
}

func (p dailyDigestClosedPublisher) Publish(ctx context.Context, event messaging.DailyDigestClosedIntegrationEvent) error {
	payload, err := messaging.NewEnvelope(ctx, event.Metadata, event).Wire()
	if err != nil {
		return err
	}
	attributes := map[string]string{"eventType": "DailyDigestClosed", "routingKey": p.settings.RoutingKeys["DailyDigestClosed"]}
	return p.snssqs.Publish(ctx, p.settings.Destination, payload, attributes)
}
```

Va en `outbound{Publishers: messaging.Publishers{DailyDigestClosed: dailyDigestClosedPublisher{…}}}`. El topic y la
routing key salen de `messaging.Settings`, nunca literales.

### Los listeners — uno por SUSCRIPCIÓN

Cada suscripción tiene **su cola propia**, suscrita al topic de su fuente con un filtro por `eventType`: a cada
listener solo le llega lo suyo. Una suscripción sin listener deja su cola llenándose sin que nadie la lea.

```go
func messageListeners(deps inbound) ([]listener, error) {
	handleStockReserved := func(ctx context.Context, message snssqs.Message) error {
		envelope, err := messaging.ParseEnvelope(message.Body) // *messaging.ContractError si no es una envoltura
		if err != nil {
			return err
		}
		if envelope.Metadata.EventType != "StockReserved" {
			return nil // el filtro de la suscripción ya lo deja fuera; si llega, no es nuestro y se borra sin efecto
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
		func(ctx context.Context) error { return deps.SNSSQS.Consume(ctx, "StockReserved", handleStockReserved) },
		// … uno por cada suscripción que lista el comentario de messageListeners
	}, nil
}

// raceResolved dice si el despacho perdió una carrera que otro camino ya resolvió (el comentario del mensaje la anota).
func raceResolved(err error) bool {
	return errors.Is(err, domain.ErrInvalidStateTransition) || errors.Is(err, domain.ErrConcurrentModification)
}
```

`Consume` recibe el **nombre de la suscripción en el diseño**, no la cola: la cola la resuelve la conexión desde
`messaging.Settings` (con lo que el perfil haya renombrado).

Las cuatro reglas que deciden si un mensaje se pierde, en `references/listeners.md` con su porqué:

1. **Lo ajeno se borra con `return nil`; lo propio roto se DEVUELVE como error.** `nil` borra el mensaje de la cola:
   un cuerpo tuyo que no se lee o incumple el contrato tiene que llegar a la DLQ, y llega devolviendo el
   `*messaging.ContractError` que ya dan `Read<Evento>Message` y `RequireContract` (DLQ sin reintento).
2. **El orden de la guarda lo dicta el diseño** (el comentario del mensaje), no tú. Y en SQS el reintento es una
   recepción NUEVA del mismo mensaje: con `TryRecord`, la segunda recepción se lo encuentra marcado.
3. **La carrera ya resuelta no es un fallo**: `domain.ErrInvalidStateTransition` o `domain.ErrConcurrentModification`
   cuando otro camino llegó antes se confirman (y con el orden `Record`, se registran igual).
4. **Devolver un error es fallar**: un `*domain.Error` va a la DLQ sin reintento (salvo el «no existe» donde la
   suscripción lo reintenta); cualquier otro error se reintenta alargando la visibilidad con la curva del diseño, y al
   agotar `MaxReceive` la RedrivePolicy lo lleva a la DLQ. No lo envuelvas en otro tipo ni lo captures para
   «reintentar».

## Qué no hacer

- **No crees topics ni colas** ni otro cliente del SDK: los clientes son de build y la topología la siembra
  `infra/init-messaging.sh` (en producción, la plataforma). Crear el topic al publicar publica en un topic sin
  suscriptores, y SNS lo descarta sin error.
- **No llames al puente ni al relay**, ni escribas en `outbox_event`: los eventos salen solos al guardar.
- **No escribas otro registro de procesados** ni otro reintento, ni mandes tú nada a la DLQ: son de build.
- **No borres mensajes ni cambies su visibilidad a mano**: el desenlace lo pone la conexión según lo que devuelva tu
  handler, y el `snssqs.Message` no te da el receipt handle a propósito.
- **No deduplices por `message.MessageID`**: es el id de SQS y cambia en cada reenvío a la cola. La clave es la del
  contrato (con envoltura Keel, `envelope.Metadata.EventID`).
- **No lances goroutines** desde el handler: los mensajes de una cola se procesan de uno en uno y se borran después
  de cada desenlace; una goroutine suelta borraría lo que aún no ha terminado.

## Validación

`go build ./...` y `go vet ./...` limpios; con la infra arriba, `bash infra/init-messaging.sh` y
`bash infra/validate-infra.sh` (comprueba que los topics y las colas existen). Las pruebas de flujo usan los helpers
del arnés (`s.Deliver<Suscripción>`, `s.PublishedMessages`, `s.DeadLetterMessages`, `s.StopBroker`…,
`{{keel:docs}}/conventions/integration-tests.md` § La mensajería); en SNS/SQS lo publicado se lee de las colas de
arnés, una por canal.

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/listeners.md` | Al escribir un listener: una cola por suscripción, contratos `keel`/`wrapped`/`none`, el orden de la guarda, la carrera y la identidad del emisor |
| `references/troubleshooting.md` | Si un mensaje no llega, llega dos veces, no va a la DLQ o el outbox se rinde |
