# MySQL (`database: "mysql"`)

Lo que build dejó: driver `com.mysql:mysql-connector-j`, contenedor `mysql:8.0`
(usuario = nombre de la BD, password `changeme`), URL
`jdbc:mysql://localhost:3306/<servicio_snake>`.

## Tipos y mapeos

- **Charset**: asegúrate de que tablas nuevas queden en `utf8mb4` (default en
  8.0, pero verifica si defines `columnDefinition`): `utf8` de MySQL son 3
  bytes y rompe con emojis.
- **UUID**: no hay tipo nativo; Hibernate 6 lo mapea a `binary(16)` por
  defecto. Si necesitas legibilidad en SQL, `@JdbcTypeCode(SqlTypes.CHAR)` →
  `char(36)` (más grande y lento en índices; decide y sé consistente).
- **JSON**: tipo `json` nativo con `@JdbcTypeCode(SqlTypes.JSON)`; sin índices
  sobre el documento (solo columnas generadas).
- **Fechas**: usa `TIMESTAMP` solo hasta 2038; para `Instant`/fechas futuras
  Hibernate usa `datetime(6)` — correcto, no lo fuerces a timestamp.
- Comparaciones de texto **case-insensitive** por collation default
  (`utf8mb4_0900_ai_ci`): una clave natural «única» puede chocar por mayúsculas;
  si el diseño distingue casing, usa una collation `_bin` en esa columna.

## Identidad e inserts masivos

- Sin secuencias: Hibernate usa `GenerationType.IDENTITY` (auto_increment).
  **El batching de inserts de Hibernate no funciona con IDENTITY** — no añadas
  `jdbc.batch_size` esperando lotes de insert (updates sí agrupan).
- `rewriteBatchedStatements=true` en la URL JDBC agrupa a nivel driver y sí
  mejora los inserts masivos.

## Concurrencia

- InnoDB bloquea por índice: updates sin índice sobre la condición escalan a
  bloqueos amplios; respeta los índices de `persistence.keel.yaml`.
- Deadlocks frecuentes con inserts concurrentes + uniques: ordena las escrituras
  y reintenta la transacción si el diseño lo permite. Y **el perdedor de un
  INSERT duplicado no siempre sale por violación de restricción**: InnoDB lo
  hace esperar sobre el lock del primero, así que puede salir por lock-wait o
  deadlock. Quien capture solo `DataIntegrityViolationException` se lleva una
  excepción sin tratar justo cuando hay competencia.
- **Los gap locks de una lectura con bloqueo son otra cosa, y tienen otra
  respuesta** — ver abajo. Ordenar y reintentar no arregla ese caso.

### Reclamo de un barrido

`FOR UPDATE SKIP LOCKED` desde **8.0**. En 5.7 no existe y la consulta falla con error de sintaxis
—que al menos falla en voz alta—, pero el `UPDATE` condicional del reclamo sigue siendo correcto sin
él: lo que se pierde es que las réplicas se repartan los candidatos, no la exclusión mutua.

**Y todo método que reclame fija `READ_COMMITTED`.** No es una preferencia:

```java
@Transactional(propagation = Propagation.REQUIRES_NEW, isolation = Isolation.READ_COMMITTED)
public List<Job> claimForDrainJobs(int batchSize) { … }
```

InnoDB arranca en `REPEATABLE READ`, y en ese nivel una lectura con bloqueo no toma solo los
registros que devuelve: toma **next-key locks**, que son el registro *más el hueco que lo precede*.
El hueco bloqueado impide `INSERT` de filas **nuevas** en ese rango — filas que todavía no existen.
`SKIP LOCKED` no salva de esto: salta las filas que OTRO tiene tomadas, pero los huecos los toma
esta misma consulta.

El síntoma no se parece a un problema de bloqueo: el barrido escanea `status IN (...)` para
reclamar su lote y, mientras, un alta que no tiene nada que ver se queda esperando hasta
`ERROR 1205: Lock wait timeout exceeded`. **Y no es un problema de pruebas** — con un barrido cada
minuto, es la API dejando de aceptar altas cada vez que pasa. Costó dos rondas completas de
arbitraje encontrarlo en una corrida en vivo, porque nada apuntaba aquí.

La documentación de MySQL lo dice del nivel de al lado: *«In the READ COMMITTED isolation level,
InnoDB disables gap locking for locking reads, UPDATE, and DELETE statements, except for
foreign-key and duplicate-key checking»*.

Bajar el aislamiento aquí es seguro: la transacción de un reclamo es diminuta y no necesita
lecturas repetibles — selecciona candidatos, los marca uno a uno con el `UPDATE` condicional (que
es quien garantiza la exclusión mutua, no el nivel) y commitea.

`build` ya lo emite en los reclamos que genera. Esta nota es para los que escribes **tú**: el
barrido cuyo reclamo no pudo generarse —build lo dice en voz alta cuando ocurre— y cualquier
consulta con bloqueo que añadas por tu cuenta.

## Validación y reset

Desde devtools (`mysql`, ya instalado):

```bash
mysql -h db -u <db> -p'changeme' -e 'SELECT 1' <db>
```

`infra/reset-db.sh` trunca todas las tablas del esquema desactivando
`FOREIGN_KEY_CHECKS`; los `auto_increment` se reinician — los escenarios no
deben asumir ids de ejecuciones previas.

## Diferencias con H2 (perfil test)

El perfil test corre H2 en `MODE=PostgreSQL` (no MySQL): collations,
`GROUP BY` estricto, funciones de fecha y el comportamiento de IDENTITY
difieren. Toda query no trivial se confirma con escenarios `FL-*` contra el
MySQL real.
