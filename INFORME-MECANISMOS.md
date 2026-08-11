# Estado de los mecanismos de repetición y compensación

Cierre del `PLAN-mecanismos-repeticion.md`. Qué cerró cada corrida, con qué evidencia, y qué
queda abierto a sabiendas. 11-ago-2026.

Los mecanismos son **cinco**, más el outbox que garantiza que el encargo sale. Confundirlos
declara garantías que nada implementa, así que el estado se lee por mecanismo:

| Mecanismo | Disparador | Verificado en vivo sobre |
|---|---|---|
| Repetición del llamante HTTP | `use-cases.<op>.idempotency` | Relacional (3 brokers) y **documental** |
| Reentrega del broker, **con** guarda de dominio | `subscriptions.<E>` + `transitions` | Relacional (3 brokers) y **documental** |
| Reentrega del broker, **sin** guarda (`tryRecord`) | `subscriptions.<E>` sin `transitions` | Relacional (Kafka) y **documental**, esta con clave en **cabecera nativa** |
| Reintento nuestro contra un proveedor | `http-clients.calls.<x>.idempotency` | Relacional y documental (cabecera verificada en el cable) |
| Deshacer trabajo ya encargado | `dependencies.<d>.compensations` | Relacional (con y sin llamada de vuelta) y **documental con vuelta** |
| El desenlace que no llega | `activations.<a>.reconciledBy` | Relacional y **documental**, las dos con gate conductual |
| Outbox | `messaging.publishing.reliability` | Los **tres** brokers, con el canal caído de verdad |

## Cierre por eje

| Eje | Estado | Evidencia |
|---|---|---|
| **A** · documental | **Cerrado** | Corrida de `asset-vault` (Mongo + Kafka) con los tres gates en verde, `indexes: OK` e `indexesTested: OK`. `INFORME-CORRIDA-DOCUMENTAL.md` |
| **B** · purga del descarte | **Cerrado** | `BRK-13` en `broker-check`, verde en RabbitMQ y SNS/SQS, omitido con motivo en Kafka — y **falsado**: sin la purga sale KO mientras `BRK-10` sigue OK |
| **C** · brokers | **Cerrado** | Corridas completas con RabbitMQ y con SNS/SQS. `INFORME-CORRIDA-RABBITMQ.md`, `INFORME-CORRIDA-SNSSQS.md` |
| **D** · fuente ajena | **Cerrado** | `ThumbnailDelivered` en `asset-vault`: canal `external`, `envelope: none`, identidad en la cabecera `X-Render-Event-Id`, con escenario de reentrega y contraste de que la clave es la cabecera y no el cuerpo |
| **E** · compensación con vuelta | **Cerrado** | `quarantineAsset` dispara `purgeThumbnail`: la familia `compensation` del gate exige el `RenderingClient` en el handler, y `FL-QUA-001` cuenta la retirada |
| **F** · dialectos | **Fuera de alcance** | Decisión del diseñador (ver abajo) |
| **G** · retención | **Cerrado como doctrina** | Presente en las tres capas: `docs/dsl/messaging.md`, `conventions/dependencies.md` y el javadoc del `<Evento>Message` |

## Lo que cambió del generador, y de dónde salió

Ocho defectos, **ninguno de negocio**: todos del arnés, del gate o de la instrucción que
precede al agente — las herramientas con las que se juzga todo lo demás.

| # | Defecto | Lo destapó | Dónde vive el arreglo |
|---|---|---|---|
| 1 | `reset-db.sh` no vaciaba el destino de descarte y `BRK-10` no lo miraba | Fase 1 | `scripts/broker-check.js` (BRK-13) |
| 2 | El arnés no sabía dirigir una subida multipart a la segunda réplica (`FL-CLU-003` sin ejercitar) | Corrida documental | `integration-tests.js` (`onReplicaMultipart`) |
| 3 | `init-keycloak.sh` daba por muerto un Keycloak sano (frontend de compose propio) | Corrida documental | `auth-provisioning.js` (usa la resolución de `up.sh`) |
| 4 | El gate exigía `@Value` en `application`, capa sin Spring | Corrida documental | `idempotency-check.js` |
| 5 | `deadLetterMessages` no traducía «cola viva y vacía» (`"[]"`, `{}`) | Corrida RabbitMQ | `integration-tests.js`, con el predicado de `broker-probes.js` |
| 6 | El gate exigía un listener por evento donde RabbitMQ obliga a uno por cola — y el skill decía lo mismo | Corrida RabbitMQ | `idempotency-check.js` + `keel-spring-rabbitmq/SKILL.md` |
| 7 | El umbral del barrido, exigido en el archivo equivocado (segunda vez) | Corrida RabbitMQ | `idempotency-check.js` |
| 8 | Las entregas entrantes no llevaban el atributo `eventType` que filtra SNS; `publishedMessages` ignoraba el límite de lote de SQS | Corrida SNS/SQS | `integration-tests.js` |

Dos observaciones que valen más que los arreglos:

- **El #4 y el #7 son el mismo error cometido dos veces**: suponer *dónde* vive una pieza en
  vez de comprobar que existe. Un gate que exige la implementación incorrecta es peor que no
  tenerlo, porque su camino de menor resistencia es romper el código para callarlo. Está
  escrito como lección en `CLAUDE.md`, fila «Nuevo eje de repetición o de compensación».
- **`FL-RES-001-C` cazó el mismo defecto en dos corridas distintas**: la carrera de la clave
  de idempotencia resuelta por la constraint de unicidad del pedido en vez de por el registro,
  en dos servidores escritos por dos agentes. Un escenario que caza lo mismo dos veces no es
  redundante: es el que mide algo que el camino natural de implementación se salta.

## Lo que queda abierto, a sabiendas

**1. El DSL no deja nombrar el desenlace de conflicto de los mecanismos que enciende.**
Reportado por **las tres** corridas, con tres improvisaciones distintas para el mismo hecho:
`IDEMPOTENCY_KEY_IN_PROGRESS`, `IDEMPOTENCY_KEY_REUSED` y —para el bloqueo optimista—
`OPTIMISTIC_LOCK_CONFLICT`. Son contratos públicos que hoy elige cada corrida. La salida es
una de dos, y conviene decidirla antes de la siguiente: que el bloque que enciende el
mecanismo (`idempotency`, `consistency.optimisticLocking`) admita el `code` de su conflicto,
o que la doctrina fije uno por mecanismo y lo documente como parte del contrato. No es un
hueco de cobertura: es un hueco del lenguaje.

**2. Dialectos relacionales distintos de PostgreSQL** (eje F, descartado por decisión del
diseñador). Lo demostrado es que el hint `jakarta.persistence.lock.timeout = -2` se traduce a
`SKIP LOCKED` **en PostgreSQL**. El modo de fallar de los otros cinco motores no es un error
sino una degradación silenciosa —«dos relays se reparten el lote» pasa a «uno espera al
otro»—, y lo único que la vería es `FL-CLU-001` con dos réplicas. Igual de abierta queda la
traducción del choque de clave duplicada a `DataIntegrityViolationException`, que depende del
SQLState de cada motor y es lo que sostiene `processed_event` e `idempotency_record`.

**3. La ventana de retención no se cierra con cobertura, y no es un pendiente.** La garantía
es «no se procesa dos veces **dentro de la retención**» (`processed-event.purge.retention-days`,
14 días). Una reentrega posterior se procesa como nueva. Con guarda de dominio da igual —el
agregado no caduca—; sin ella, el efecto se repite. Cuando el negocio necesita una ventana
mayor, el mecanismo correcto es una guarda de dominio, no un parámetro más grande. Está dicho
en los tres sitios donde alguien puede tropezarse con ello.

## Gates que existen hoy, y qué ve cada uno

Ninguno sustituye a otro; el orden es de más barato a más caro:

| Gate | Coste | Qué ve | Qué NO ve |
|---|---|---|---|
| `npm test` | segundos | Todo lo que es comparación de cadenas sobre lo que emite `build` | Si el Java compila o si el comando es correcto |
| `java-syntax.test.js` | segundos | Estructura balanceada y tipos sin import, sobre la matriz fixtures × brokers | Semántica |
| `compile-check` | minutos, opt-in | Que el arnés compile de verdad, con los tres brokers | La aplicación (el `main` no compila a propósito) |
| `broker-check` | minutos, opt-in | La fontanería contra los tres brokers reales, incluida la palanca de parar y levantar | No arranca la JVM |
| `check-idempotency.sh` | segundos, en el pipeline | Que el agente USE los mecanismos que build generó | Si el algoritmo es correcto |
| `score-scenarios.sh` | la corrida entera | El comportamiento, contra infraestructura real | Lo que ningún `FL-*` alcanza: el cron y la entrega del outbox antes de arrancar |

Los ocho defectos de la tabla anterior eran invisibles para los cuatro primeros. Esa es la
razón por la que las corridas completas siguen haciendo falta, y por la que su cosecha —volver
el hallazgo al generador con su caso de regresión— es la mitad que las hace rentables.
