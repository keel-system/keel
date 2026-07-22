# SNS/SQS — configuración y tuning

Propiedades de Spring Cloud AWS que el agente puede necesitar en
`parameters/<perfil>/snssqs.yaml`. Build ya dejó región, credenciales y (en
local/develop) los endpoints de LocalStack con el gradiente por perfil: **no
las toques**; en production no hay endpoint (el SDK resuelve el real de AWS).

## Listener SQS (globales del contenedor)

```yaml
spring:
  cloud:
    aws:
      sqs:
        listener:
          # Mensajes procesándose a la vez por cola; súbelo solo si la operación
          # destino es segura en concurrencia.
          max-concurrent-messages: 10
          # Long polling: espera hasta 10s a que haya mensajes (menos requests
          # vacíos que el short polling; el máximo de SQS es 20).
          poll-timeout: 10s
          max-messages-per-poll: 10
```

Los ajustes por-listener (`maxConcurrentMessages`, `pollTimeoutSeconds`,
`messageVisibilitySeconds`, `acknowledgementMode`) van como atributos de
`@SqsListener` y tienen precedencia sobre estos globales.

## Visibility timeout: la propiedad que más incidencias da

Cuando un consumidor recibe un mensaje, SQS lo oculta durante el visibility
timeout (default de la cola: 30s). Si el procesamiento supera ese tiempo, el
mensaje **reaparece y se procesa dos veces**. Regla: visibility timeout ≥ 6×
el tiempo de proceso esperado. Se fija al crear la cola
(`--attributes VisibilityTimeout=60`) o por listener
(`messageVisibilitySeconds`).

## Acknowledgement

El modo por defecto (`ON_SUCCESS`) borra el mensaje solo si el listener
termina sin excepción — correcto para el despacho vía `UseCaseMediator`, no lo
cambies. `ALWAYS` pierde mensajes ante error; `MANUAL` (inyectando
`Acknowledgement`) solo para acks diferidos/por lotes.

## Topología (se crea, no se configura en YAML)

Los topics, colas, suscripciones y redrive policies **no** van en propiedades:
se crean contra el emulador en local (script o arranque) y contra AWS real por
IaC de la plataforma. Receta local en `references/implementation.md`. Los
nombres sí van en YAML (`messaging.subscriptions.<evento>.topic`, ARN del
topic de publicación) para que el código no los hardcodee.

## Por perfil

- **local**: endpoints `http://localhost:4566` (la app) — desde devtools es
  `http://localstack:4566`; credenciales `test`/`test` (LocalStack ignora el
  valor pero el SDK exige que existan).
- **develop**: endpoint LocalStack por env var con default (ya generado).
- **production**: sin endpoint; credenciales por rol IAM si la plataforma lo
  da — entonces borra `access-key`/`secret-key` del fragmento production y
  deja que la default credentials chain resuelva.

## Qué no hacer

- No fijes `spring.cloud.aws.endpoint` global en production «por si acaso»:
  romperá la resolución regional del SDK.
- No uses short polling (`poll-timeout: 0`): multiplica requests y costes.
- No proceses >1 vez sin idempotencia: SQS estándar es at-least-once y sin
  orden garantizado (ver implementation.md para FIFO).
