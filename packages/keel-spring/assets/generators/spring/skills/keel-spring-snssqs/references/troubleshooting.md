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
