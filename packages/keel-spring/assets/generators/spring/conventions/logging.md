# Logs: dónde, cómo y qué no

Los logs de un servicio generado tienen **dos dueños**. Build fija los de las **fronteras**, que son los mismos en todos los servicios y se derivan del diseño. El agente solo añade los de **negocio**, con las reglas de abajo. La mayor parte de lo que hace falta ya está puesto: antes de escribir un `log.*`, comprueba que no lo diga ya una frontera.

## Lo que ya loguea build (no lo repitas)

| Frontera | Dónde | Nivel | Campos |
|---|---|---|---|
| Resultado de cada caso de uso: HTTP, mensaje consumido o barrido programado | `UseCaseMediator` | `DEBUG` si salió bien; `INFO` si el dominio lo rechazó (`DomainException`, un 4xx esperado); `ERROR` si falló | `keel.operation`, `keel.outcome` (`ok`/`rejected`/`error`), `keel.duration_ms`, `keel.error_code` o `keel.error_type` |
| Mensaje duplicado descartado | `IdempotencyGuard` | `INFO` | `keel.handler`, `keel.event_id`, `keel.outcome=duplicate` |
| Evento publicado, reintentado o abandonado | `OutboxRelay` | `DEBUG` / `WARN` / `ERROR` | `keel.outbox.id`, `keel.event_type`, `keel.outcome` |
| Llamada saliente fallida o degradada | fallbacks de `infrastructure/http` | `WARN` | cliente y llamada |
| Excepción no controlada, **con su pila** | `ApiExceptionHandler` (HTTP); el contenedor del listener (mensaje); el scheduler (barrido) | `ERROR` | la pila, **una sola vez** |

Cada fallo deja **una** pila, la del adaptador por el que entró, y una línea de frontera del mediator. Por eso ni `@LogExceptions` ni el mediator imprimen la pila: con ellas, cada fallo salía dos veces.

Con telemetría (`telemetry: otel`), cada una de estas líneas lleva además el `traceId`/`spanId` de su traza. En texto va dentro del patrón; en JSON como `trace.id`/`span.id`. Sin telemetría lleva el `correlationId`, que existe siempre.

## Lo que puede añadir el agente

Solo **decisiones de negocio que no son el resultado de un caso de uso**, porque ese ya lo registra el mediator:
- Una rama de negocio no evidente que se tomó: «se aplicó la tarifa reducida», «el pedido se partió en dos envíos».
- Una degradación elegida a propósito: `onFailure: degrade`, un dato de réplica caducado que se sirvió igualmente.
- En un barrido, el recuento del lote (`reclamadas`, `procesadas`), **solo si el lote no está vacío**: un barrido que corre cada minuto sin trabajo no deja rastro.

Niveles:
- `DEBUG` para el detalle de una decisión.
- `INFO` para un hecho de negocio que alguien de soporte querrá encontrar.
- `WARN` para una degradación.
- `ERROR` **nunca** desde el dominio ni los handlers. Un error se lanza como excepción y la frontera lo registra.

## Cómo

- **Parámetros, no concatenación**: `log.info("Pedido {} partido en {} envíos", orderId, count)`. Concatenar construye la cadena aunque el nivel esté apagado y pierde los argumentos como campos.
- **Campos estructurados** para lo que se va a buscar o agregar, con la API fluida de SLF4J 2:
  `log.atInfo().addKeyValue("keel.order_id", id).log("Pedido partido")`. En JSON (ECS) salen como atributos del registro.
- **Nombres de campo en inglés**, con el prefijo `keel.` para lo propio del servicio.
- **Un logger por clase**: `private static final Logger log = LoggerFactory.getLogger(<Clase>.class);`. En `application` y `domain` el logger es SLF4J, que no es Spring: no rompe la frontera hexagonal.

## Qué no se loguea, nunca

- **Datos personales**: nombres, emails, teléfonos, documentos, direcciones, IPs de usuario. Se identifica por id, nunca por el dato.
- **Secretos**: tokens, claves de API, contraseñas, cabeceras `Authorization`, URLs firmadas.
- **Objetos enteros**: un `…Command`, un `…Dto`, un agregado o un cuerpo de petición o de mensaje. Su `toString()` arrastra todo lo anterior y cambia sin que nadie revise el log.
- **Importes y datos de negocio sensibles como etiqueta de métrica**: la cardinalidad explota. En un log puntual, solo si soporte lo necesita.

Lo verifica en estático `infra/check-logging.sh`, con cuatro reglas:

- `concat`: concatenación dentro de un `log.*(`.
- `wholeObject`: un objeto de entrada entero (`command`, `dto`, `request`, `payload`…) como argumento.
- `errorLevel`: un `log.error` o `log.atError()` en `domain/` o `application/`.
- `context`: un executor que no propaga el contexto.

Lo que no puede ver —repetir una línea que ya escribe una frontera, o un `INFO` que debería ser `DEBUG`— depende de seguir esta convención.

## A dónde van

- **La consola es el canal primario**, siempre. En `local` va en texto, para leerla; en `develop` y `production`, en JSON (ECS), para que la plataforma la recoja sin expresiones regulares. En Kubernetes la recoge el colector de la plataforma (`filelog`) o el agente de logs del clúster.
- **OTLP de logs** (solo con telemetría) es opcional y va apagado (`LOG_EXPORT_OTLP=false`). Encenderlo además de recoger la consola duplica cada línea en el backend. Se enciende solo donde nada recoge stdout; `deploy/` es ese caso y lo trae encendido.
