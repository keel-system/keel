# Corrida de control de los lotes (DSL 2.30) — `product-catalog` en keel-spring sobre MySQL

| Etiqueta | Valor |
|---|---|
| Diseño | `product-catalog` v1.2.0 (DSL 2.30, relacional, 5 capas), con `importProducts` (`per-item`, `sync`, con clave, hasta 500) e `importCatalog` (`per-item`, `async`, con clave, hasta 50 000), sobre la v1.1.0 con security nueva (rol `catalog-editor`) |
| Stack | `mysql · keycloak` (telemetría `none`) |
| Generador | `keel-spring@0.3.0` (`e7a1d4b3`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **36/36 OK** tras un ciclo (la primera puntuación, 34/36: FL-PRD-008-E y 009-F, las dos carreras, en rojo por el generador) |
| Huella del agente | 263 archivos registrados por `build`, 0 adoptados, **10 reescritos**, 0 borrados |
| Clasificación de la huella | 8 TODO · 0 consulta · **2 generador** · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (el informe dice «ninguno» y no hay `design-gaps.yaml`) |
| Huecos del generador | **1**: la carrera por la misma clave de un lote, en MySQL, es un interbloqueo y no una violación de unicidad; el alta lo deja salir como 500 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-230-spring-mysql\services\product-catalog-spring`. Es la quinta y última corrida de
control del incremento 11 de `PLAN-DSL-230-LOTES.md`: la de MySQL, gemela de
`2026-11-15-product-catalog-230-spring-control.md` con el motor cambiado. Es la única de las cinco que no sale en verde
sin tocar lo que escribe `build`.

## El hueco del generador: la carrera de la clave en MySQL

La primera puntuación salió con código 1: 34 OK y 2 FALLO, **FL-PRD-008-E y FL-PRD-009-F**, las dos carreras por la
misma `Idempotency-Key` de los lotes. La perdedora respondía **500 sin `code`**, y el escenario solo admite 207/202 o
409 `IDEMPOTENCY_KEY_IN_PROGRESS`.

**Qué pasa.** El alta del trabajo, en `KeyedBatches.start` y en `BatchJobs.accept`, hace en una transacción:

1. `releaseKey`: `UPDATE batch_job SET idempotency_key = NULL WHERE <la clave> AND key_expires_at <= now`;
2. `byKey`, la lectura del trabajo vivo de la clave;
3. el `INSERT` del trabajo nuevo.

En PostgreSQL, la perdedora espera en la unicidad del `INSERT` y recibe la violación cuando la ganadora confirma. Esa
violación es `DataIntegrityViolationException`, que es lo único que capturan los dos archivos. En MySQL (InnoDB,
`REPEATABLE READ`), el `UPDATE` del paso 1 sobre una clave que todavía no existe toma un **bloqueo de hueco** en el
índice único. Las dos peticiones lo toman a la vez (son compatibles entre sí), y después el `INSERT` de cada una espera
al hueco de la otra: **interbloqueo**. MySQL mata a una, que llega como `CannotAcquireLockException`
(`PessimisticLockingFailureException`), no la captura nadie y sale como 500.

**El parche del agente**, en los dos archivos generados («no lo edites»), y anotado en su informe como hallazgo del
generador:

- el `catch` captura también `PessimisticLockingFailureException`;
- si la ganadora no está visible todavía, lanza `BatchKeyInProgressException` en vez de relanzar la excepción original.

La segunda puntuación dio código 0 con el parche. Un `build --refresh` marcará los dos archivos como fusión pendiente.

**Por qué el parche no es el arreglo.**

- Tras el interbloqueo, la ganadora puede no haber confirmado todavía, así que la lectura de la perdedora no la ve.
  En el asíncrono eso da un 409 «en curso» que el contrato no promete: D13 promete el mismo 202. El escenario 009-F lo
  tolera; el comentario del propio `BatchJobs` dice lo contrario.
- Lo correcto es **reintentar el alta entera**. Su `UPDATE` de `releaseKey` espera entonces al registro de la ganadora
  hasta que confirma, y `byKey` lo encuentra: el mismo 202, o el 207 guardado o el 409 en curso del síncrono, igual que
  en PostgreSQL. La otra opción es quitar el bloqueo de hueco: leer la fila de la clave sin bloquear y hacer el
  `UPDATE` solo si existe y ha caducado.

**Alcance.** No es solo de keel-spring. Las sentencias son neutrales (`batchStatements` de
`keel-core/src/lib/gen/batch-store.js`) y los cuatro generadores hacen la misma secuencia. Lo que cambia es qué captura
cada uno:

- keel-nest captura cualquier error que no sea de dominio, relee y relanza si no encuentra a la ganadora. El
  interbloqueo le sale bien cuando la ganadora ya confirmó, y como 500 cuando no.
- keel-dotnet y keel-go están sin medir en este punto.

**Por qué no lo vio ninguna red.** Ninguna de las sondas BK ni BJ lanza dos altas con la misma clave a la vez: BK-3
mide la repetición mientras el primero sigue en marcha, que es secuencial. La carrera solo la miden los escenarios
FL-PRD-008-E y 009-F, y hasta esta corrida solo habían corrido en PostgreSQL.

## Los riesgos anotados en el plan

- **El sondeo del trabajo**, con la convención, como en las otras cuatro: cinco de cinco sin helper del arnés.
- **Las carreras**, en verde solo con el parche (ver arriba). Aquí sí se sabe el desenlace: hubo perdedora, y fue por
  interbloqueo.
- **Los mismos bytes en la repetición**, como en la gemela de PostgreSQL.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe del pipeline: 36 `FL-*` al 100 %, `score-scenarios.sh` con código 0, después de un
  ciclo de código y re-puntuación. El informe reproduce solo las últimas filas de la matriz (`tail -15`); el resumen
  cuenta los 36.
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en
  `D:\keel-tmp\catalog-230-springmysql-regen`:
  - Los siete handlers y `Product.java`, desde su TODO, como en la gemela.
  - `infrastructure/rest/batch/KeyedBatches.java` y `BatchJobs.java`: las dos líneas del parche en cada uno, y nada más.
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Pendiente

- El arreglo en el generador (los cuatro) y una sonda de carrera en las redes de MySQL.
- `baselineTested: PENDING`, como en todas las corridas de keel-spring.

## designGaps

Ninguno.
