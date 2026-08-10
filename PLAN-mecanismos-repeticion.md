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
| F | **Dialectos relacionales** distintos de PostgreSQL | El reclamo del outbox usa `SKIP LOCKED`; 5 motores sin verificar | 6 |
| G | Ventana de retención de `processed_event` | Límite de diseño, no hueco de cobertura | 7 |

**Ya cubierto, fuera de alcance**: la compensación a estado **no terminal** (`catalog-extended` declara `retired: [active]` con esa arista explícita) y la compensación **con** llamada de vuelta en relacional (`ComplianceClient` vía `FL-CMP-001`).

**Resultado esperado**: los cinco mecanismos verificados en vivo sobre los dos modelos de persistencia y los tres brokers, con el reclamo del outbox honesto en los seis motores relacionales.

---

## Fase 1 — Gate del descarte en `broker-check` *(eje B)*

*Sin agentes ni pipeline, una sesión. Va primera porque es lo único que respaldaría un arreglo que ya está en `main` sin haberse ejecutado nunca.*

`BRK-10` comprueba hoy solo que `infra/reset-db.sh` sale con 0. Su propio comentario promete «todos los destinos vacíos», pero no lo afirma, y del descarte no sabe nada.

- [ ] **1.1** Ampliar `BRK-10` (o añadir `BRK-13`) en `packages/keel-spring/scripts/broker-check.js`: publicar un marcador único en el destino de descarte → ejecutar `infra/reset-db.sh` → afirmar que la lectura cumple `isEmptyRead(broker, output)`.
  Reutilizar `deadLetterQueue`, que el runner ya resuelve vía `deadLetterDestination` de `src/lib/dead-letter.js`, y los comandos de `src/lib/broker-probes.js` — **nunca** comandos propios: el arnés y el runner renderizan del mismo módulo, y uno escrito a mano haría que el gate probara algo distinto de lo que se genera.
- [ ] **1.2** **Omitir con Kafka, no fallar.** Ahí la purga no existe por diseño y el aislamiento es la marca de offset. Usar el patrón de omisión explícita de `BRK-12`: un escenario que se salta en silencio es peor que uno que falla.
- [ ] **1.3** Documentar la fila nueva en `PLAN-conformidad-brokers.md § Paso 3`.

**Verificación**: `npm run broker-check --workspace packages/keel-spring` en los tres brokers.

---

## Fase 2 — Ampliar `asset-vault` a paridad de mecanismos *(ejes A, D, E)*

*Diseño puro, sin infraestructura. Va antes de la corrida porque una corrida vale por lo que ejercita: con huecos probaría Mongo, pero no los mecanismos.*

`asset-vault` declara los cinco mecanismos sobre Mongo y tiene 11 escenarios, pero su cobertura no llega a la de `stock-reservation`.

- [ ] **2.1** Añadir la **tabla por mecanismo** a `validation-scenarios.md`. Modelo: `stock-reservation/validation-scenarios.md`, sección «la misma matriz leída por mecanismo, que es como se decide si falta algo». Hoy `asset-vault` solo tiene la matriz por operación, y es la otra la que destapa huecos.
- [ ] **2.2** Carrera de idempotencia de petición sobre `uploadAsset` — tipo `FL-RES-001-C`, con `raceOf` y conteo por API.
- [ ] **2.3** Caducidad de la ventana — tipo `FL-RES-001-D`. Con `ttlSeconds: 86400` no se alcanza esperando: hay que **envejecer la fila**, la misma palanca con que `FL-REC-001` mueve `reserveStockAwaitingSince`. Acortar el TTL mediría un servicio distinto del que se opera.
- [ ] **2.4** Rama `tryRecord`. **Cambia la forma del diseño**, no solo los escenarios: hoy toda operación disparada por suscripción declara `transitions` (`quarantineAsset`), así que solo se ejercita `alreadyProcessed`+`record`. Hace falta una suscripción cuyo trigger **no** declare transiciones — el patrón está en `stock-reservation`: `noteStockCount` sobre un contador observable.
- [ ] **2.5** Doble entrega simultánea de la compensación — tipo `FL-CMP-001-C`, con `race` sobre el canal.
- [ ] **2.6** Reconciliación de `reconcileScans`, hoy declarada como hueco en la matriz. Cerrarla como se cerró `FL-REC-001`: envejecer la fila y esperar un tick, **sin acortar el cron** — el umbral de paciencia y la frecuencia del barrido son dos cosas separadas y solo la segunda tiene que ser corta.
- [ ] **2.7** Escenarios de clúster `FL-CLU-*` sobre relay del outbox, barrido y clave. `usesReplica` ya se activa con outbox, así que el arnés lo soporta sin tocar el generador.
- [ ] **2.8** *(eje E)* Dar a la compensación de `asset-vault` una **activación de vuelta**: hoy `quarantineAsset` no aparece en ningún `triggeredBy`, así que `returnClientOf` devuelve `null` y la mitad exigente del check de compensación queda vacía. Con una activación vía `via.client`, el gate pasa a exigir que el handler invoque el `<C>Client`.
- [ ] **2.9** *(eje D)* Añadir una suscripción de **fuente ajena**: `contract.envelope: none` o `wrapped` con `messageId: { location: header, … }`. Es la otra mitad de la idempotencia de consumo —hoy todas las suscripciones de las fixtures con escenarios usan `envelope: keel`, o sea `metadata.eventId`— y la única fixture que declara `contract.messageId` (`metering-digest`) **no tiene capa `api` ni escenarios**, así que no puede conducir un `FL-*`. Escenario asociado: reentrega del mismo `messageId` sin segundo efecto.
  Ojo con la regla nueva de `crossrefs.js`: sin envoltura Keel, compartir canal exige `discriminator`.

**Verificación**: `keel validate specs/asset-vault` sin avisos de escenarios · `npm test` · `npm run compile-check --workspace packages/keel-spring asset-vault`.

---

## Fase 3 — Corrida documental de `asset-vault` *(ejes A, D, E)*

*Pipeline completo. La fase de más valor: la única que puede destapar bugs de generación que hoy nadie mira.*

- [ ] **3.1** Workspace hermano `corrida-asset-vault-doc/` con `keel init`; copiar la fixture ampliada; `keel validate` + `keel describe` como puerta previa.
- [ ] **3.2** `keel-spring build specs/asset-vault` con **MongoDB + Kafka** (Kafka para comparar con la corrida anterior en igualdad de condiciones). Comprobar en caliente que `check-idempotency.sh` sale **ROJO** recién generado: un verde ahí significa que el gate mira mal, no que el código esté bien.
- [ ] **3.3** `git init` y `/keel-generate-spring` sin argumentos, desde una sesión abierta **en la raíz del proyecto generado**.

Puntos de atención propios de la rama documental:

- **El replica set es condición de las transacciones**, y con ellas del outbox y de la idempotencia. Lo levanta el healthcheck con `rs.initiate` idempotente, y `cliValidateCmd` sondea `rs.status().ok` en vez de un ping justamente para no dar verde a una base sin replica set. Si `validate-infra.sh` sale rojo aquí, el problema es de infraestructura, no de código.
- **El gate de esquema cambia de naturaleza**: no hay baseline que redactar, hay índices que verificar en vivo (`infra/export-indexes.sh`). El agente de calidad debe devolver `indexes: OK` **e** `indexesTested: OK`, nunca `PENDING` — leer índices no destruye la base de su propia no-regresión. Esta corrida **cierra sola**: no deja el paso manual que dejó la relacional.
- `check-idempotency.sh` pierde a propósito dos de sus seis comprobaciones en documental (las de `Persistable`): el gate estático protege **menos** justo donde no hay corrida previa que lo respalde. Razón de más para que esta fase exista.
- El reclamo del outbox se verifica contra `findAndModify` y `claimed_at` caducable, no contra `SKIP LOCKED`. El patrón `claim` del gate ya admite ambos.

**Verificación**: `./gradlew build -x test` verde · `score-scenarios.sh` exit 0 al 100 % · `check-idempotency.sh` exit 0 · `export-indexes.sh` verificado en vivo.

---

## Fase 4 — Cosecha de la corrida documental

*Obligatoria: sin ella la corrida es una anécdota, no una mejora del generador.*

- [ ] **4.1** Leer `INFORME-GENERACION.md`: `harnessPatches`, `failures` con `culprit: harness`, `designGaps`, `probes[].verdict: FALSO-NEGATIVO`.
- [ ] **4.2** Parches del arnés → `src/scaffold/integration-tests.js`. Si tocan un comando de broker → **`src/lib/broker-probes.js`**, nunca un literal.
- [ ] **4.3** Hallazgos falsos del gate → matriz de `src/scaffold/idempotency-check.js` + test en `test/idempotency-check.test.js`.
- [ ] **4.4** Cada corrección **con su test**, ninguno dependiente de infraestructura: los opt-in siguen siendo `compile-check` y `broker-check`.
- [ ] **4.5** Publicar `INFORME-CORRIDA-DOCUMENTAL.md` en la raíz, según la convención existente.

---

## Fase 5 — Eje conductual de los otros dos brokers *(eje C)*

*Dos corridas. Es el único modo de ejercitar los `FL-*` contra un broker distinto: `compile-check` cubre el eje estático y `broker-check` el de fontanería, pero **ninguno arranca la aplicación** —a propósito, porque el `main` recién generado no compila.*

- [ ] **5.1** Corrida completa de `stock-reservation` con **RabbitMQ**. Ejercita además, en vivo, la purga de DLQ de `reset-db.sh` que la fase 1 solo comprueba en aislado.
- [ ] **5.2** Corrida completa de `stock-reservation` con **SNS/SQS**. Es la más distinta de las tres: cola por consumidor, DLQ por redrive, y topología que **no sobrevive al reinicio del contenedor** — `needsBrokerReseed` es verdadero aquí, así que `FL-OBX-001` depende de que `startBroker()` resiembre con `init-messaging.sh`. Si el supuesto fuera falso, el escenario fallaría por «destino inexistente» en vez de por lo que prueba.
- [ ] **5.3** Cosecha de ambas, con el mismo procedimiento de la fase 4.

**Verificación**: en cada corrida, los tres gates en verde (`build -x test`, `score-scenarios.sh` al 100 %, `check-idempotency.sh`).

---

## Fase 6 — Barrido de dialectos relacionales *(eje F)*

*El eje que no se ve hasta que muerde. El reclamo del outbox es `@Lock(PESSIMISTIC_WRITE)` + `@QueryHint(jakarta.persistence.lock.timeout = -2)`, que Hibernate traduce a `SKIP LOCKED` **donde el dialecto lo soporta**. Solo se ha verificado en PostgreSQL, y quedan cinco motores en `DATABASES`.*

Un dialecto que degrade el hint a un lock normal no rompe la compilación ni ningún `includes(...)`: convierte «dos relays se reparten el lote» en «uno bloquea al otro», y lo único que lo vería es `FL-CLU-001` con dos réplicas. El propio código ya admite que en H2 (perfil `test`) puede degradarse.

- [ ] **6.1** Determinar, **en vivo y por motor**, si el hint produce salto de filas bloqueadas: MySQL, MariaDB, Oracle, SQL Server, H2. Enfoque `broker-check`: script opt-in que levanta el contenedor de cada motor y ejercita dos reclamos concurrentes sobre la tabla `outbox_event`, afirmando que los lotes son **disjuntos**. Sin arrancar la aplicación, igual que `broker-check`.
- [ ] **6.2** Verificar también la **traducción del choque de clave duplicada** a `DataIntegrityViolationException` por motor: es lo que sostiene `processed_event` e `idempotency_record`, y depende del SQLState que devuelve cada uno.
- [ ] **6.3** Hacer honesto al generador con lo que resulte: un motor que no soporte el salto **no puede callarlo**. O `build` avisa al elegirlo (como ya avisa de otras traducciones parciales en `supported-features.js`), o el reclamo se emite distinto para ese dialecto. Documentarlo en la referencia por dialecto de `keel-spring-database`, donde hoy solo `read-queries.md` menciona `SKIP LOCKED`.
- [ ] **6.4** Tests del comportamiento nuevo + entrada en el `package.json` de `keel-spring` si nace un script opt-in.

**Verificación**: el script nuevo en verde para los motores que lo soportan y en aviso explícito para los que no; `npm test` verde.

---

## Fase 7 — Cierre documental *(eje G y consolidación)*

- [ ] **7.1** Documentar la **ventana de retención** donde se decide, no donde se sufre: la garantía es «no se procesa dos veces **dentro de la retención**» (`processed-event.purge.retention-days`, 14 días por defecto), no «nunca jamás». Ya está en `docs/dsl/messaging.md`; comprobar que la doctrina llega también al javadoc del `<Evento>Message` y a `conventions/dependencies.md`. **Esto no se cierra con cobertura**: una reentrega posterior a la retención se procesa como nueva, y si el negocio necesita una ventana mayor el mecanismo correcto es una guarda de dominio, que no caduca.
- [ ] **7.2** Actualizar la fila «Nuevo eje de repetición o de compensación» de `CLAUDE.md` con lo que las corridas hayan cambiado del reparto build/agente.
- [ ] **7.3** Consolidar en un único `INFORME-MECANISMOS.md` el estado final de la matriz: qué eje cerró cada corrida y con qué evidencia.

---

## Orden y dependencias

```
1 ─────────────────────────────► (independiente, primero por barato)
2 ──► 3 ──► 4 ──► 5 ──► 7
6 ─────────────────────────────► (independiente de todo lo demás)
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
| F · dialectos | Salto de filas bloqueadas verificado por motor, o avisado por `build` |
| G · retención | Doctrina presente en las tres capas de documentación |
| Regresión | `npm test` verde · `compile-check` sobre `asset-vault` y `stock-reservation` |
