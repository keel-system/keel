# SNS/SQS — troubleshooting

Síntoma → causa → arreglo. Sondeo básico en
`.claude/conventions/infra-validation.md`.

## El listener no recibe lo que SNS publica

1. **Suscripción inexistente o sin confirmar**: verifica con
   `aws --endpoint-url http://localstack:4566 sns list-subscriptions-by-topic
   --topic-arn <arn>`; con protocolo sqs en LocalStack la confirmación es
   automática, pero la suscripción hay que crearla (script de
   `references/implementation.md`).
2. **Nombre de cola distinto** entre el `@SqsListener` y la cola creada:
   compara con `aws ... sqs list-queues`.
3. **Publicaste en un topic y suscribiste otro** (típico tras renombrar):
   `aws ... sns list-topics`.

## `MessageConversionException` / el payload llega envuelto en JSON de SNS

Falta `RawMessageDelivery=true` en la suscripción: SQS recibe el sobre SNS
(`{"Type":"Notification","Message":"..."}`) en vez del `EventEnvelope`.
Recrea la suscripción con el atributo (no se puede parchear el código para
«desenvolver»: el contrato del proyecto es raw delivery).

## El mensaje llega como `EventEnvelope[metadata=…, data=…]` en vez de JSON

Es el caso **inverso** al anterior, y del lado del publicador: alguien pasó el objeto
`EventEnvelope` a `MessageBuilder.withPayload(...)` y lo envió con `snsTemplate.send(...)`.
El `SnsTemplate` por defecto no tiene `MessageConverter` Jackson, así que publica el
`toString()` del record — texto plano. No lanza, no falla el envío: el mensaje sale y
revienta en el consumidor (o en la aserción del escenario).

Arreglo: serializa el sobre con el `ObjectMapper` de la aplicación y manda el `String`.
`withPayload` + `send` es correcto siempre que lo que entre sea un `String` ya serializado
—lo que entrega el outbox, o lo que produces tú en best-effort—. Tabla completa en
`SKILL.md § Envío al broker`.

## El escenario publica el evento pero la cola está vacía

El síntoma engaña: la operación devuelve `2xx`, el publisher no loguea nada, el topic existe,
la cola existe, y `AbstractFlowIT#publishedMessages` no encuentra el mensaje. Parece un fallo
del arnés y casi nunca lo es.

Causa habitual: el mensaje salió **sin el message attribute `eventType`**, y la `FilterPolicy`
de la suscripción lo descartó. SNS no notifica un mensaje filtrado — para él es el
comportamiento correcto.

Comprueba en este orden:

1. El publisher fija `.setHeader("eventType", "<Evento>")`. Si usa `sendNotification(topic,
   objeto, "<Evento>")`, ese tercer argumento es el **Subject**, que `RawMessageDelivery=true`
   descarta: ese es el fallo.
2. El valor coincide **exactamente** con el nombre del evento del diseño, que es lo que
   `infra/init-messaging.sh` puso en la `FilterPolicy` (distingue mayúsculas).
3. La suscripción tiene el filtro que esperas:
   `aws sns get-subscription-attributes --subscription-arn <arn>`.

## El mismo mensaje se procesa varias veces

- **Visibility timeout menor que el tiempo de proceso**: el mensaje reaparece
  mientras aún se procesa. Sube `VisibilityTimeout` de la cola o
  `messageVisibilitySeconds` del listener (regla: ≥ 6× el tiempo de proceso).
- Reentrega at-least-once normal tras un error: idempotencia de consumo
  (implementation.md), no «arreglos» capturando excepciones.

## Los mensajes van a la DLQ al primer error (o nunca van)

`maxReceiveCount` de la `RedrivePolicy` mal puesto o política ausente.
`aws ... sqs get-queue-attributes --queue-url <url> --attribute-names
RedrivePolicy ApproximateReceiveCount`. Recuerda: el contador de recepciones
incluye las reapariciones por visibility timeout, no solo errores reales.

## `Unable to load credentials` al arrancar

El SDK exige credenciales aunque LocalStack las ignore: verifica que el perfil
activo carga `parameters/<perfil>/snssqs.yaml` (con `test`/`test` en local).
En production sin access-key: la default chain necesita rol IAM/variables de
entorno — es configuración de despliegue, no del código.

## Funciona en local (LocalStack) pero no contra AWS real

Diferencias habituales: la topología real no existe (en AWS la crea IaC, no tu
script), permisos IAM de la cola/topic (`sqs:ReceiveMessage`, `sns:Publish`,
y la **access policy de la cola** que permite a SNS entregarle), y endpoints —
en production no debe quedar ningún `endpoint:` apuntando a LocalStack.

## LocalStack arranca pero SNS/SQS no responden

El compose lo limita a `SERVICES: sns,sqs`: cualquier otro servicio AWS no
está. Sondea `curl -sf http://localstack:4566/_localstack/health` desde
devtools y revisa que el estado de `sns`/`sqs` sea `available`/`running`.
