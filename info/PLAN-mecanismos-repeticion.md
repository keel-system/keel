# Cerrar outbox, compensaciones e idempotencia

Plan incremental para llevar los cinco mecanismos de repetición a cobertura completa. Cada fase es entregable por separado: se puede parar entre fases sin dejar el repo a medias. Las casillas son el estado real — se marcan al cerrar la verificación, no al escribir el código.

## Contexto

La corrida de cierre sobre `stock-reservation` (10-ago-2026, relacional + PostgreSQL + Kafka) dejó **19/19** escenarios en verde contra infraestructura real y `check-idempotency.sh` con las cinco familias en OK. Eso cierra **una silueta, un modelo de persistencia, un motor y un broker**.

Lo que queda no son bugs conocidos: son ramas del generador que hoy solo juzgan comparaciones de cadenas. Una rama así puede estar rota sin que nada lo diga, porque un `includes(...)` verde no distingue «el código es correcto» de «el código existe».

### Los cinco mecanismos y sus ejes

Confundirlos declara garantías que nada implementa, así que el inventario se lee por mecanismo y no por archivo:

| Mecanismo | Disparador en el DSL | Artefacto |
|---|---|---|
| Repetición del llamante HTTP | `use-cases.<op>.idempotency` | `idempotency_record` + `CommandSignature` |
| Reentrega del broker | `subscriptions.<E>` | `processed_event` + `IdempotencyGuard` |
| Reintento nuestro contra un proveedor | `http-clients.calls.<x>.idempotency` | `OutboundIdempotency` |
| Deshacer trabajo ya encargado | `dependencies.<d>.compensations` | *ninguna clase propia* |
| El desenlace que no produce ningún hecho | `activations.<a>.reconciledBy` | operación con `schedule` |

Más el **outbox** (`messaging.publishing.reliability`), que es la garantía de que el encargo sale.

### Matriz de lo pendiente

| # | Eje | Estado hoy | Fase |
|---|---|---|---|
| A | Modelo **documental** (Mongo) | Solo comparaciones de cadenas. Nunca corrido | 2, 3 |
| B | Purga del **descarte** en RabbitMQ/SQS | Arreglo en `main` **sin ejecutar nunca** | 1 |
| C | Eje conductual de **RabbitMQ** y **SNS/SQS** | `FL-*` nunca corrió contra ellos | 5 |
| D | Deduplicación por **`contract.messageId`** (fuente ajena) | La única fixture que lo declara no tiene escenarios ni capa `api` | 2, 3 |
| E | **Compensación con llamada de vuelta** en documental | Solo cubierta en relacional (`catalog-extended`) | 2, 3 |
| F | **Dialectos relacionales** distintos de PostgreSQL | El reclamo del outbox usa `SKIP LOCKED`; 5 motores sin verificar | ~~6~~ **descartada**: riesgo asumido |
| G | Ventana de retención de `processed_event` | Límite de diseño, no hueco de cobertura | 7 |

**Ya cubierto, fuera de alcance**: la compensación a estado **no terminal** (`catalog-extended` declara `retired: [active]` con esa arista explícita) y la compensación **con** llamada de vuelta en relacional (`ComplianceClient` vía `FL-CMP-001`).

**Resultado esperado**: los cinco mecanismos verificados en vivo sobre los dos modelos de persistencia y los tres brokers, con el reclamo del outbox honesto en los seis motores relacionales.

---

## Fase 1 — Gate del descarte en `broker-check` *(eje B)*

*Sin agentes ni pipeline, una sesión. Va primera porque es lo único que respaldaría un arreglo que ya está en `main` sin haberse ejecutado nunca.*

`BRK-10` comprueba hoy solo que `infra/reset-db.sh` sale con 0. Su propio comentario promete «todos los destinos vacíos», pero no lo afirma, y del descarte no sabe nada.

- [x] **1.1** Ampliar `BRK-10` (o añadir `BRK-13`) en `packages/keel-spring/scripts/broker-check.js`: publicar un marcador único en el destino de descarte → ejecutar `infra/reset-db.sh` → afirmar que la lectura cumple `isEmptyRead(broker, output)`.
  Reutilizar `deadLetterQueue`, que el runner ya resuelve vía `deadLetterDestination` de `src/lib/dead-letter.js`, y los comandos de `src/lib/broker-probes.js` — **nunca** comandos propios: el arnés y el runner renderizan del mismo módulo, y uno escrito a mano haría que el gate probara algo distinto de lo que se genera.
- [x] **1.2** **Omitir con Kafka, no fallar.** Ahí la purga no existe por diseño y el aislamiento es la marca de offset. Usar el patrón de omisión explícita de `BRK-12`: un escenario que se salta en silencio es peor que uno que falla.
- [x] **1.3** Documentar la fila nueva. `PLAN-conformidad-brokers.md` ya no existe —lo borró
  `3f1865c` al cerrarse aquel plan—, así que la cobertura queda donde hoy se describe:
  `CLAUDE.md § Comandos de desarrollo` (con el motivo de por qué el descarte se afirma aparte
  de `BRK-10`) y los comentarios del propio escenario.

**Verificación**: hecha el 11-ago-2026 con podman. `npm run broker-check` **exit 0** en los
tres brokers: `BRK-13` OK en rabbitmq y snssqs, omitido con motivo en kafka. Y falsado —
quitando la purga del descarte de `devtools.js`, `BRK-13` sale KO mientras `BRK-10` sigue OK,
que es exactamente el hueco que cierra.

---

## Fase 2 — Ampliar `asset-vault` a paridad de mecanismos *(ejes A, D, E)*

*Diseño puro, sin infraestructura. Va antes de la corrida porque una corrida vale por lo que ejercita: con huecos probaría Mongo, pero no los mecanismos.*

`asset-vault` declara los cinco mecanismos sobre Mongo y tiene 11 escenarios, pero su cobertura no llega a la de `stock-reservation`.

- [x] **2.1** Añadir la **tabla por mecanismo** a `validation-scenarios.md`. Modelo: `stock-reservation/validation-scenarios.md`, sección «la misma matriz leída por mecanismo, que es como se decide si falta algo». Hoy `asset-vault` solo tiene la matriz por operación, y es la otra la que destapa huecos.
- [x] **2.2** Carrera de idempotencia de petición sobre `uploadAsset` — tipo `FL-RES-001-C`, con `raceOf` y conteo por API.
- [x] **2.3** Caducidad de la ventana — tipo `FL-RES-001-D`. Con `ttlSeconds: 86400` no se alcanza esperando: hay que **envejecer la fila**, la misma palanca con que `FL-REC-001` mueve `reserveStockAwaitingSince`. Acortar el TTL mediría un servicio distinto del que se opera.
- [x] **2.4** Rama `tryRecord`. **Cambia la forma del diseño**, no solo los escenarios: hoy toda operación disparada por suscripción declara `transitions` (`quarantineAsset`), así que solo se ejercita `alreadyProcessed`+`record`. Hace falta una suscripción cuyo trigger **no** declare transiciones — el patrón está en `stock-reservation`: `noteStockCount` sobre un contador observable.
- [x] **2.5** Doble entrega simultánea de la compensación — tipo `FL-CMP-001-C`, con `race` sobre el canal.
- [x] **2.6** Reconciliación de `reconcileScans`, hoy declarada como hueco en la matriz. Cerrarla como se cerró `FL-REC-001`: envejecer la fila y esperar un tick, **sin acortar el cron** — el umbral de paciencia y la frecuencia del barrido son dos cosas separadas y solo la segunda tiene que ser corta.
- [x] **2.7** Escenarios de clúster `FL-CLU-*` sobre relay del outbox, barrido y clave. `usesReplica` ya se activa con outbox, así que el arnés lo soporta sin tocar el generador.
- [x] **2.8** *(eje E)* Dar a la compensación de `asset-vault` una **activación de vuelta**: hoy `quarantineAsset` no aparece en ningún `triggeredBy`, así que `returnClientOf` devuelve `null` y la mitad exigente del check de compensación queda vacía. Con una activación vía `via.client`, el gate pasa a exigir que el handler invoque el `<C>Client`.
- [x] **2.9** *(eje D)* Añadir una suscripción de **fuente ajena**: `contract.envelope: none` o `wrapped` con `messageId: { location: header, … }`. Es la otra mitad de la idempotencia de consumo —hoy todas las suscripciones de las fixtures con escenarios usan `envelope: keel`, o sea `metadata.eventId`— y la única fixture que declara `contract.messageId` (`metering-digest`) **no tiene capa `api` ni escenarios**, así que no puede conducir un `FL-*`. Escenario asociado: reentrega del mismo `messageId` sin segundo efecto.
  Ojo con la regla nueva de `crossrefs.js`: sin envoltura Keel, compartir canal exige `discriminator`.

**Cómo quedó, y las cuatro decisiones que el plan no fijaba** (11-ago-2026):

- **Sufijos**: `-C` ya estaba ocupado por el choque de clave natural, así que la carrera es
  `FL-AST-001-D` y la caducidad `FL-AST-001-E`.
- **2.4 y 2.9 se cierran con UNA suscripción**, no dos: `ThumbnailDelivered` viene de un canal
  `external` del renderizador, llega **plano** (`envelope: none`) con la identidad en la cabecera
  nativa `X-Render-Event-Id`, y dispara `noteThumbnailDelivery`, que **no declara transiciones**.
  Las dos ramas que faltaban —`tryRecord` y clave fuera de la envoltura— son la misma pieza vista
  por dos lados, y separarlas alargaba la corrida sin ejercitar nada más. La fuente es `rendering`
  y no un proveedor nuevo porque una dependencia del DSL exige `needs` o `activations`: un
  `delivery-cdn` de adorno no valida. Canal propio, así que la regla del `discriminator` no aplica
  —dos fuentes, dos destinos físicos.
- **2.6 sí acorta el cron** (`*/30` → `* * * * *`), al contrario de lo que decía la casilla y de
  acuerdo con su propio razonamiento: lo que no se toca es el **umbral de paciencia**, que vive en
  `parameters/`. Con media hora el barrido no se alcanza en caja negra y seguiría sin gate
  conductual, que es justo lo que la fase quería cerrar. Es el mismo trato que `stock-reservation`.
  Además hizo falta una **marca temporal** que envejecer: `lastScannedAt`, que no se llama
  `scanAssetAwaitingSince` porque aquí no se espera un desenlace, se revalida una creencia.
- **2.8** entra por `rendering.activations.purgeThumbnail` (`DELETE /thumbnails/{assetId}`,
  `onFailure: ignore`): retirar la miniatura de un binario infectado es la mitad de la
  compensación que vive fuera, y ahora `returnClientOf` la ve.

**Verificación**: `keel validate` sin ningún aviso de escenarios —los dos que pedían la carrera y
la doble entrega simultánea desaparecieron al escribirlas, que es la señal de que el validador las
reconoce— · `npm test` 391+475 en verde · `compile-check` sobre `asset-vault`.

---

## Fase 3 — Corrida documental de `asset-vault` *(ejes A, D, E)*

*Pipeline completo. La fase de más valor: la única que puede destapar bugs de generación que hoy nadie mira.*

- [x] **3.1** Workspace hermano `corrida-asset-vault-doc/` con `keel init`; copiar la fixture ampliada; `keel validate` + `keel describe` como puerta previa.
- [x] **3.2** `keel-spring build specs/asset-vault` con **MongoDB + Kafka** (Kafka para comparar con la corrida anterior en igualdad de condiciones). Comprobar en caliente que `check-idempotency.sh` sale **ROJO** recién generado: un verde ahí significa que el gate mira mal, no que el código esté bien.
  → Hecho con `-y` (el motor lo decide el diseño: con `model: document` la lista tiene un solo
  elemento y no se pregunta). Stack resultante: mongodb, kafka, keycloak, redis, minio. 299
  archivos. `check-idempotency.sh` **exit 1 con las cinco familias KO y 8 hallazgos**, y dos de
  ellos son la prueba de que la fase 2 llegó al gate: `dedupe` lista los **dos** órdenes
  (`alreadyProcessed`+`record` para MalwareDetected, `tryRecord` para ThumbnailDelivered) y
  `compensation` **exige `RenderingClient`** en el handler de `quarantineAsset`, que antes de la
  activación de vuelta no exigía nada.
- [x] **3.3** `git init` y `/keel-generate-spring` sin argumentos, desde una sesión abierta **en la raíz del proyecto generado**.
  → `git init` con el scaffolding en `8fe8bfe` como línea base; la corrida la lanzó el diseñador y
  dejó `cf1e7bb`. Resultado: suite en verde con **`FL-CLU-003` NO_EJERCITADO** (hueco del arnés,
  aceptado explícitamente y corregido en la fase 4), `indexes: OK` + `indexesTested: OK`, y las
  cinco familias del gate en OK.

Puntos de atención propios de la rama documental:

- **El replica set es condición de las transacciones**, y con ellas del outbox y de la idempotencia. Lo levanta el healthcheck con `rs.initiate` idempotente, y `cliValidateCmd` sondea `rs.status().ok` en vez de un ping justamente para no dar verde a una base sin replica set. Si `validate-infra.sh` sale rojo aquí, el problema es de infraestructura, no de código.
- **El gate de esquema cambia de naturaleza**: no hay baseline que redactar, hay índices que verificar en vivo (`infra/export-indexes.sh`). El agente de calidad debe devolver `indexes: OK` **e** `indexesTested: OK`, nunca `PENDING` — leer índices no destruye la base de su propia no-regresión. Esta corrida **cierra sola**: no deja el paso manual que dejó la relacional.
- `check-idempotency.sh` pierde a propósito dos de sus seis comprobaciones en documental (las de `Persistable`): el gate estático protege **menos** justo donde no hay corrida previa que lo respalde. Razón de más para que esta fase exista.
- El reclamo del outbox se verifica contra `findAndModify` y `claimed_at` caducable, no contra `SKIP LOCKED`. El patrón `claim` del gate ya admite ambos.

**Verificación**: `./gradlew build -x test` verde · `score-scenarios.sh` exit 0 al 100 % · `check-idempotency.sh` exit 0 · `export-indexes.sh` verificado en vivo.

---

## Fase 4 — Cosecha de la corrida documental

*Obligatoria: sin ella la corrida es una anécdota, no una mejora del generador.*

- [x] **4.1** Leer `INFORME-GENERACION.md`: `harnessPatches`, `failures` con `culprit: harness`, `designGaps`, `probes[].verdict: FALSO-NEGATIVO`.
- [x] **4.2** Parches del arnés → `src/scaffold/integration-tests.js`. Si tocan un comando de broker → **`src/lib/broker-probes.js`**, nunca un literal.
- [x] **4.3** Hallazgos falsos del gate → matriz de `src/scaffold/idempotency-check.js` + test en `test/idempotency-check.test.js`.
- [x] **4.4** Cada corrección **con su test**, ninguno dependiente de infraestructura: los opt-in siguen siendo `compile-check` y `broker-check`.
- [x] **4.5** Publicar `INFORME-CORRIDA-DOCUMENTAL.md` en la raíz, según la convención existente.

---

## Fase 5 — Eje conductual de los otros dos brokers *(eje C)*

*Dos corridas. Es el único modo de ejercitar los `FL-*` contra un broker distinto: `compile-check` cubre el eje estático y `broker-check` el de fontanería, pero **ninguno arranca la aplicación** —a propósito, porque el `main` recién generado no compila.*

- [x] **5.1** Corrida completa de `stock-reservation` con **RabbitMQ**. Ejercita además, en vivo, la purga de DLQ de `reset-db.sh` que la fase 1 solo comprueba en aislado.
  → Hecha el 11-ago-2026 en `corrida-stock-rabbitmq/` (PostgreSQL + RabbitMQ, 229 archivos,
  línea base `36f4041`, corrida en `e1b90b4`). El broker se fija escribiendo `keel-stack.json`
  antes de construir: un build limpio en vez de un build de Kafka reescrito con `--force`.
  Suite en verde, un `culprit: code` en un ciclo y dos `culprit: test` esperables. Cosecha en
  `INFORME-CORRIDA-RABBITMQ.md`: tres defectos del generador corregidos —el descarte que no
  traducía «cola vacía» (que arreglaba también SNS/SQS), el gate que exigía un listener por
  evento donde RabbitMQ obliga a uno por cola, y mi propia corrección de la fase 4 sobre el
  umbral del barrido, mal ubicada por segunda vez—.
- [x] **5.2** Corrida completa de `stock-reservation` con **SNS/SQS**. Cola por consumidor, DLQ por redrive, y topología que no sobrevive al reinicio — `needsBrokerReseed` verdadero.
  → Hecha el 11-ago-2026 en `corrida-stock-snssqs/` (línea base `a0ce2bb`, corrida `d7466d8`).
  Suite en verde; el supuesto de la resiembra se confirma (`startBroker()` ejecuta
  `init-messaging.sh` y falla explícito si no puede). Dos `culprit: code`, ninguno del
  scaffolding — uno de ellos, la carrera de la clave perdida contra la constraint de unicidad,
  es el MISMO que cazó `FL-RES-001-C` en la corrida con RabbitMQ, en otro servidor y con otro
  agente.
- [x] **5.3** Cosecha de ambas, con el mismo procedimiento de la fase 4.
  → `INFORME-CORRIDA-RABBITMQ.md` (3 defectos) e `INFORME-CORRIDA-SNSSQS.md` (2 defectos), los
  cinco corregidos en el generador con su caso de regresión. Los cinco eran **del arnés o del
  gate**: invisibles para `compile-check` (compila pero no arranca) y para `broker-check` (habla
  con el broker pero no levanta la JVM). Ninguno era un bug de negocio.

**Verificación**: en cada corrida, los tres gates en verde (`build -x test`, `score-scenarios.sh` al 100 %, `check-idempotency.sh`).

---

## Fase 6 — Barrido de dialectos relacionales *(eje F)* — **DESCARTADA**

**Decisión del diseñador (11-ago-2026): no se hace.** El supuesto que se adopta es que un
motor relacional que no sea PostgreSQL no presenta mayor dificultad, y el coste de
verificarlo no compensa hoy.

Queda escrito lo que ese supuesto deja abierto, para que la fase 7 no lo consolide como
cubierto:

- Lo que PostgreSQL demuestra es que el hint `jakarta.persistence.lock.timeout = -2` se
  traduce a `SKIP LOCKED` **en ese dialecto**. Los otros cinco de `DATABASES` no se han
  ejecutado.
- El modo de fallar **no es un error**: un dialecto que degrade el hint a un bloqueo normal
  compila, pasa todos los `includes(...)` y convierte «dos relays se reparten el lote» en
  «uno espera al otro». Lo único que lo vería es `FL-CLU-001` con dos réplicas, y el propio
  código ya admite que en H2 (perfil `test`) puede degradarse.
- Lo mismo, sin verificar, para la traducción del choque de clave duplicada a
  `DataIntegrityViolationException`, que depende del SQLState de cada motor y es lo que
  sostiene `processed_event` e `idempotency_record`.

Si algún día muerde, el enfoque sigue siendo el de `broker-check`: un script opt-in que
levante cada motor y ejercite dos reclamos concurrentes sobre `outbox_event` afirmando que
los lotes son disjuntos, sin arrancar la aplicación.

---

## Fase 7 — Cierre documental *(eje G y consolidación)*

- [x] **7.1** Documentar la **ventana de retención** donde se decide, no donde se sufre: la garantía es «no se procesa dos veces **dentro de la retención**» (`processed-event.purge.retention-days`, 14 días por defecto), no «nunca jamás». Ya está en `docs/dsl/messaging.md`; comprobar que la doctrina llega también al javadoc del `<Evento>Message` y a `conventions/dependencies.md`. **Esto no se cierra con cobertura**: una reentrega posterior a la retención se procesa como nueva, y si el negocio necesita una ventana mayor el mecanismo correcto es una guarda de dominio, que no caduca.
- [x] **7.2** Actualizar la fila «Nuevo eje de repetición o de compensación» de `CLAUDE.md` con lo que las corridas hayan cambiado del reparto build/agente.
- [x] **7.3** Consolidar en un único `INFORME-MECANISMOS.md` el estado final de la matriz: qué eje cerró cada corrida y con qué evidencia.
  → Publicado. Incluye además lo que el plan no preveía: los **ocho** defectos del generador que
  las corridas destaparon (ninguno de negocio: arnés, gate o la instrucción que precede al
  agente), la tabla de gates con qué ve y qué no ve cada uno, y los tres frentes que quedan
  abiertos a sabiendas — el hueco del DSL para nombrar el conflicto de un mecanismo, los
  dialectos del eje F y la ventana de retención, que no se cierra con cobertura.

---

## Orden y dependencias

```
1 ─────────────────────────────► (independiente, primero por barato)
2 ──► 3 ──► 4 ──► 5 ──► 7
6 ─────────────────────────────► DESCARTADA (riesgo asumido)
```

- **2 → 3** es la única dependencia dura: la corrida vale por lo que ejercita.
- **5 después de 4** para no repetir en tres brokers un defecto del arnés que la cosecha ya habría corregido.
- **6** no depende de nada y puede adelantarse si preocupa más la corrección que la cobertura.
- **1** primero siempre: respalda algo ya commiteado.

## Verificación global

El trabajo está cerrado cuando:

| Eje | Comprobación |
|---|---|
| A · documental | Corrida de `asset-vault` con los tres gates en verde e `indexesTested: OK` |
| B · descarte | `npm run broker-check` con el escenario nuevo en OK (kafka omitido con motivo) |
| C · brokers | `score-scenarios.sh` al 100 % en corridas con RabbitMQ y con SNS/SQS |
| D · fuente ajena | Escenario de reentrega por `contract.messageId` en verde |
| E · compensación con vuelta | `check-idempotency.sh` de `asset-vault` con `compensation` exigiendo el `<C>Client` |
| F · dialectos | **Fuera de alcance por decisión del diseñador**: se asume que los demás motores se comportan como PostgreSQL |
| G · retención | Doctrina presente en las tres capas de documentación |
| Regresión | `npm test` verde · `compile-check` sobre `asset-vault` y `stock-reservation` |
