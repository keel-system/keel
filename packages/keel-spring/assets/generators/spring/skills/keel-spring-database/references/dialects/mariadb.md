# MariaDB (`database: "mariadb"`)

Lo que build dejó: driver `org.mariadb.jdbc:mariadb-java-client`, contenedor
`mariadb:11` (usuario = nombre de la BD, password `changeme`), URL
`jdbc:mariadb://localhost:3306/<servicio_snake>`.

Casi todo lo dicho para MySQL aplica (InnoDB, utf8mb4, collations
case-insensitive, gap locks); diferencias que importan:

## Secuencias

MariaDB **sí** tiene secuencias nativas (10.3+): Hibernate 6 con el dialecto
MariaDB puede usar `GenerationType.SEQUENCE`, lo que **habilita el batching de
inserts** (`jdbc.batch_size`) que en MySQL se pierde con IDENTITY. Si hay
escritura masiva en el diseño, prefiere SEQUENCE en las entidades Jpa nuevas
(las generadas por build usan la estrategia por defecto; no las cambies sin
motivo de rendimiento real).

## Tipos

- **UUID**: MariaDB 10.7+ tiene tipo `uuid` nativo; el driver y Hibernate 6
  recientes lo usan — verifica el DDL generado (`ddl-auto: update` en local) y
  fija `binary(16)` o `uuid` conscientemente si migra de una a otra.
- **JSON**: en MariaDB `JSON` es un alias de `LONGTEXT` con check de validez;
  sin índices sobre el documento (columnas virtuales sí). `@JdbcTypeCode(SqlTypes.JSON)`
  funciona igual.
- **Fechas**: `datetime(6)` para `Instant`; mismo aviso 2038 para `TIMESTAMP`.

### Reclamo de un barrido

`FOR UPDATE SKIP LOCKED` desde **10.6** (MariaDB lo incorporó bastante después que MySQL: no des por
hecho la paridad de versiones entre los dos). Por debajo, el reclamo sigue siendo correcto —lo
garantiza el `UPDATE` condicional— pero las réplicas compiten por la misma página de candidatos.

**Y todo método que reclame fija `READ_COMMITTED`**, igual que en MySQL y por el mismo motivo — es
el mismo InnoDB con el mismo default:

```java
@Transactional(propagation = Propagation.REQUIRES_NEW, isolation = Isolation.READ_COMMITTED)
public List<Job> claimForDrainJobs(int batchSize) { … }
```

En `REPEATABLE READ`, una lectura con bloqueo toma **next-key locks**: el registro *más el hueco que
lo precede*. El hueco bloqueado impide `INSERT` de filas **nuevas** en ese rango, y `SKIP LOCKED` no
salva de eso — salta las filas que otro tiene tomadas, pero los huecos los toma esta consulta. El
síntoma es un alta ajena esperando hasta `ERROR 1205: Lock wait timeout exceeded` cada vez que pasa
el barrido, y no se parece en nada a un problema de bloqueo.

Ver `dialects/mysql.md` § Reclamo de un barrido para el razonamiento completo: costó dos rondas de
arbitraje en una corrida en vivo. `build` ya lo emite en los reclamos que genera; esta nota es para
los que escribes tú.

## Validación y reset

Desde devtools (`mariadb`, ya instalado):

```bash
mariadb -h db -u <db> -p'changeme' -e 'SELECT 1' <db>
```

`infra/reset-db.sh` trunca todas las tablas del esquema desactivando
`FOREIGN_KEY_CHECKS`; los `auto_increment`/secuencias se reinician — los
escenarios no deben asumir ids de ejecuciones previas.

## Diferencias con H2 (perfil test)

El perfil test corre H2 en `MODE=PostgreSQL` (no MariaDB): collations,
funciones y el comportamiento de identidad difieren. Toda query no trivial se
confirma con escenarios `FL-*` contra el MariaDB real.

## Escribir un UUID y una fecha en una sentencia a mano

Lo que el arnés usa —y lo que hay que usar en cualquier SQL que se escriba a mano contra la
base de prueba—:

```sql
-- el id de una fila: TEXTO ENTRECOMILLADO, no UUID_TO_BIN
SELECT * FROM jobs WHERE id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
-- un instante infinitamente rancio
UPDATE jobs SET running_since = TIMESTAMP '1970-01-01 00:00:00' WHERE ...;
```

**MariaDB no es MySQL aquí**, y es la trampa: `UUID_TO_BIN` es una función de MySQL 8 que MariaDB
no tiene, y el tipo tampoco coincide. Contra `mariadb:11` la columna sale como `uuid` NATIVO (el
tipo que MariaDB tiene desde 10.7 y que el dialecto usa), no como `binary(16)`. Medido con
`SHOW COLUMNS`, no deducido.

Y por qué importa el detalle: un literal que no casa con el tipo **no falla**. El `WHERE` devuelve
vacío, el `UPDATE` afecta a cero filas, y un escenario que fabrica su precondición así pasa en
verde sin haber preparado nada. Si alguien baja la imagen por debajo de 10.7 (sin tipo nativo, el
mapeo cae a binario), esto cambia — y lo dice `npm run claim-check --database=mariadb`.
