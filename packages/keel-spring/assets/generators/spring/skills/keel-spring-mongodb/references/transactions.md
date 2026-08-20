# Transacciones

## Por qué la infraestructura es un replica set incluso en local

Mongo solo admite transacciones multi-documento sobre un replica set. Un `mongod`
suelto no las tiene, y una operación transaccional contra él falla con:

```
Transaction numbers are only allowed on a replica set member or mongos
```

Este servicio las necesita por dos motivos independientes, cada uno suficiente:

1. **El `UseCaseMediator`** abre cada caso de uso con un `TransactionTemplate`, que
   exige un `PlatformTransactionManager` en el contexto. Sin bean, el contexto **no
   arranca** — no es una degradación silenciosa.
2. **El outbox**: con `reliability: outbox`, el documento del agregado y su
   `outbox_event` tienen que entrar en el mismo commit. Si no, o se publica un evento
   de un cambio que revirtió, o se pierde el de un cambio que sí ocurrió. Esa
   atomicidad **es** la razón del patrón.

Por eso `infra/docker-compose.yaml` arranca Mongo con `--replSet rs0` y un
healthcheck que además ejecuta `rs.initiate()` la primera vez. El healthcheck es
idempotente: en las pasadas siguientes `rs.status()` responde y no toca nada.

## Los dos gestores de transacciones

`MongoTransactionConfig` (generado) registra dos beans:

- `@Profile("!test")` → `MongoTransactionManager` real, sobre el replica set.
- `@Profile("test")` → un gestor **no-op**.

El perfil `test` corre sobre flapdoodle, que arranca *standalone*: un gestor real
fallaría en la primera operación transaccional. Ese perfil existe solo para que el
contexto cargue (`contextLoads`), y montar flapdoodle como replica set sería
complejidad sin contrapartida.

**Consecuencia que hay que tener presente**: en el perfil `test` no hay atomicidad.
Lo que ahí «funciona» es que nadie abre una transacción de verdad. Cualquier
escenario que compruebe atomicidad va en `src/integrationTest/`, contra la infra
real — que es donde el pipeline los puntúa de todas formas.

## Alcance de la transacción

- **El agregado no la necesita.** Es un solo documento y una escritura sobre un
  documento ya es atómica. La transacción sirve para lo que cruza colecciones.
- **`@Transactional` en el adaptador** aparece cuando el agregado emite eventos: ahí
  el guardado y la escritura del outbox tienen que ir juntos.
- **El relay del outbox NO es transaccional**, y es deliberado. En la rama relacional
  la transacción existe para sostener el lock pesimista del lote hasta el commit;
  aquí el reclamo ya es atómico por documento (`findAndModify`) y cada actualización
  también. Abrir una transacción solo serviría para mantenerla abierta durante la
  entrega al broker — I/O externo dentro de una transacción de base de datos.

## Reclamo del outbox: el equivalente del SKIP LOCKED

No hay lock pesimista de fila en Mongo, así que el relay reclama con
`findAndModify`, que es atómico por documento: quien gana la operación se lleva la
fila estampándole `claimed_at`, y las demás réplicas dejan de verla. Mismo efecto
que `SELECT … FOR UPDATE SKIP LOCKED` (lotes disjuntos) y sin transacción larga.

Con una diferencia que hay que respetar: **la marca caduca**. Un lock de base de
datos se suelta solo cuando muere la conexión; una marca en un documento no, así que
una réplica que muera entre el reclamo y la entrega retendría la fila para siempre.
De ahí `outbox.relay.claim-timeout-ms`: pasado ese plazo la fila vuelve al polling.
Si lo bajas por debajo de lo que tarda una entrega al broker, dos réplicas pueden
entregar el mismo evento — que es tolerable (la entrega es at-least-once y el
consumidor deduplica) pero no gratis.

## Reclamo de la reconciliación: `reconciliation_claim`

El barrido de una reconciliación reclama con la MISMA técnica pero sobre una colección aparte, que
`build` genera junto a su `ReconciliationClaimStore`: un `upsert` cuyo filtro pide el reclamo ya
caducado, así que si la marca sigue viva no casa con nada, Mongo intenta insertar y el `_id` duplicado
—`<activación>|<id>`— dice que el candidato es de otra réplica. Atómico por documento, sin transacción.

Por qué no va la marca en el documento del agregado, que sería más corto: el estado de espera es justo
lo que el barrido busca, y añadirle un campo de mecánica al documento del diseño lo mezcla con el
dominio. Y por qué la clave lleva la activación: una entidad puede estar esperando varios desenlaces a
la vez, y con una marca compartida el segundo encargo pisaría el reclamo del primero.

Aquí también **la marca caduca** (`reconciliation.<activación>.claim-timeout-ms`), y por el mismo motivo
que en el outbox — con una consecuencia peor si se dimensiona corto: lo que se repite no es una entrega
al broker sino una llamada al proveedor, y eso solo lo absorbe la idempotencia saliente.

## Idempotencia: `insert`, nunca `save`

En `IdempotencyGuard` y en `MongoIdempotencyStore` el registro se escribe con
`insert(...)` y no con `save(...)`.

`save` con un `_id` ya presente **reemplaza en silencio**. Aplicado a un registro de
idempotencia, eso significa que la segunda entrega del mismo mensaje pisaría el
registro de la primera y se procesaría otra vez: exactamente lo que el mecanismo
existe para impedir. Con `insert`, el `_id` arbitra igual que la clave primaria en la
rama relacional y quien pierde recibe `DuplicateKeyException` — una
`DataIntegrityViolationException`, así que el `catch` de siempre sigue valiendo.
