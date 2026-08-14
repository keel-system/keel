# Informe de corrida — stock-reservation con SNS/SQS (eje C, cierre)

Corrida completa de `/keel-generate-spring` sobre `specs/stock-reservation` v1.0.0 en
`corrida-stock-snssqs/`, con **PostgreSQL + LocalStack (SNS/SQS)**. 11-ago-2026. Cierra el
eje conductual de los tres brokers: con esta, los `FL-*` han corrido contra los tres.

Es la más distinta de las tres, y por eso valía la pena: cola por consumidor en vez de
destino compartido, descarte por `RedrivePolicy` en vez de por configuración de la
aplicación, y una topología que **no sobrevive al reinicio del contenedor** — LocalStack la
sirve desde memoria—, así que `FL-OBX-001` depende de que `startBroker()` resiembre con
`init-messaging.sh`.

**Resultado**: la suite en verde. Dos `culprit: code` resueltos en su ciclo, ninguno del
scaffolding: el bridge de eventos pasaba el nombre de la **clase Java**
(`StockReservationRequestedIntegrationEvent`) como `eventType` en vez del nombre del evento
del diseño, y la carrera de la clave de idempotencia la ganaba la constraint de unicidad del
pedido — el mismo defecto que cazó `FL-RES-001-C` en la corrida con RabbitMQ, en otro
servidor escrito por otro agente. Ese escenario se está ganando el sueldo.

**Sin falsos negativos de infraestructura.** El primer `validate-infra.sh` falló por
topología ausente antes de sembrarla: no es un falso negativo, es que no existía.

---

## Defectos del generador (corregidos y congelados)

Los dos son del arnés, los dos propios de SQS, y los dos los tuvo que parchear el agente
dentro del proyecto para poder puntuar.

### 1. La entrega de eventos entrantes no llevaba el `eventType`

`deliverStockReserved` y sus dos hermanas llamaban a `deliverMessage(..., Map.of())`. La
`FilterPolicy` que **el propio `build`** siembra en `init-messaging.sh` filtra por el
*message attribute* `eventType` de SNS, no por el `metadata.eventType` del cuerpo: sin el
atributo, SNS descarta el mensaje **en silencio**. Seis escenarios afectados (`FL-CMP-001`,
`-001-B`, `-001-C`, `FL-CNT-001`, `-001-B`, `FL-RES-003`), y todos fallando con la peor forma
posible — el efecto no ocurre y la sospecha cae sobre el handler, que ni llegó a enterarse.

Es un desacuerdo del generador consigo mismo: una mitad monta el filtro y la otra manda el
mensaje sin la clave por la que filtra.

**Corrección** (`src/scaffold/integration-tests.js`): toda entrega de suscripción lleva
`"eventType"` con el nombre del evento del diseño. En los tres brokers, no solo en SNS: allí
enruta, y en Kafka y RabbitMQ es lo que estampa un emisor real (`props.setType`, header del
record), así que mandarlo iguala el arnés a la fuente que suplanta. Si el diseño ya declara
un discriminador de cabecera llamado `eventType`, no se duplica — `Map.of` con dos claves
iguales revienta en ejecución.

Verificado además contra el proyecto de la corrida: lo que el generador emite ahora es
**byte a byte** lo que el agente había escrito a mano.

### 2. `publishedMessages` no respetaba el límite de lote de SQS

Pasaba `count` tal cual a `--max-number-of-messages`, que SQS acota a 1–10 y contesta
`InvalidParameterValue` por encima. Un escenario de clúster que espera más de diez mensajes
no reventaba por lo que mide, sino por la lectura. Afectó a `FL-CLU-001`.

**Corrección**: se pide por lotes de `min(restante, 10)` y se corta en cuanto uno vuelve
**incompleto**, que es la señal de que la cola no tiene más. El corte no es un detalle: con
`--visibility-timeout 0` el mensaje sigue visible, así que seguir pidiendo devolvería otra
vez los mismos y un conteo sobre el texto acumulado los contaría dos veces —convertiría el
arreglo de un error de lectura en un falso «llegó dos veces».

**Verificación de las dos**: `npm test` 400 en verde (2 casos nuevos) · `compile-check` sobre
`stock-reservation` y `asset-vault` con los tres brokers, que es lo único que juzga Java
emitido por plantilla.

`publishRaw` se deja como está: publica en el canal propio, solo lo usa el humo del arnés y
en SNS/SQS ni siquiera se genera.

---

## Huecos de diseño

Los dos de la corrida con RabbitMQ vuelven a salir, y aparece un tercero de la misma familia
—**mecanismos cuyo desenlace de conflicto el DSL no deja nombrar**—:

- **«Misma clave, cuerpo distinto»** (`use-cases.<op>.idempotency`). Tercera corrida
  consecutiva que lo reporta, y tercer `code` distinto improvisado:
  `IDEMPOTENCY_KEY_IN_PROGRESS` (RabbitMQ), `IDEMPOTENCY_KEY_REUSED` (SNS/SQS y `asset-vault`).
  Tres servidores del mismo diseño con tres contratos públicos distintos para el mismo hecho.
- **Conflicto de bloqueo optimista** (`consistency.optimisticLocking: all`). Observable por la
  API y sin `code` declarado: se usó `OPTIMISTIC_LOCK_CONFLICT` (409) por convención. Mismo
  patrón que el anterior — un mecanismo que el diseño enciende y cuyo error no puede declarar.
- **Umbral y lote del barrido**, fijados en `parameters/` (15 min, lote 100) a confirmación
  del diseñador. Coherente con la doctrina, pero conviene decidir si el umbral es operativo o
  de negocio.

**Recomendación consolidada** (ya apuntada en la corrida anterior, ahora con tres casos):
que los bloques que encienden un mecanismo admitan el `code` de su conflicto, o que la
doctrina fije uno por mecanismo y lo documente como contrato. Hoy lo elige cada corrida, y
eso convierte un contrato público en una tirada de dados.

## Estado del eje C

| Broker | Corrida | Estado |
|---|---|---|
| Kafka | `stock-reservation`, 10-ago | 19/19 |
| RabbitMQ | `corrida-stock-rabbitmq`, 11-ago | verde, 3 defectos cosechados |
| SNS/SQS | `corrida-stock-snssqs`, 11-ago | verde, 2 defectos cosechados |

Los cinco defectos que las dos corridas nuevas destaparon eran **invisibles** para los gates
existentes: `compile-check` compila pero no arranca, y `broker-check` habla con el broker pero
no levanta la JVM. Ninguno era un bug de negocio; los cinco eran del arnés o del gate, es
decir, de las herramientas con las que se juzga todo lo demás.
