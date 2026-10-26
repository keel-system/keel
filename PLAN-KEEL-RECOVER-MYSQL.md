# Plan: MySQL en `keel-recover`

## Context

`keel-recover` lee la base del legacy (y la del regenerado, en la paridad) detrás de un adaptador por motor
(`packages/keel-recover/src/lib/db/`). Hoy hay dos: `mongodb.js` y `postgresql.js`. Otro motor es un rechazo
con motivo: `sandbox.schema.json` y `target.schema.json` solo admiten esos dos `tech`, y `target.js` rechaza un
deploy con `mysql`/`mariadb`. El incremento 10 de `PLAN-KEEL-RECOVER.md` dejó escrito «queda MySQL».

Lo que **ya** sabe de MySQL: `fingerprint` y `env-deps` lo detectan (`catalog.js`: `mysql-connector-java`,
`mysql-connector-j`, `mysql`, `mysql2`, `MYSQL_URL`; `images.js` y `readers/urls.js`: la imagen y la URL), y
`fixturesSql` de keel-core ya escribe el estado de partida en dialecto MySQL (lo emiten keel-spring y
keel-dotnet). Lo que falta es todo lo que **pregunta a la base**: huella, snapshot, restauración, exportación,
diff, introspección, vaciado y carga.

**Lo que no se hace: migrar el legacy a PostgreSQL.** El legacy es el oráculo. Lo que se graba, se caracteriza y
se compara en la paridad es lo que hace en producción, y MySQL tiene comportamiento que es contrato observable:
unicidad sin distinguir mayúsculas (collation `_ci`), truncado o conversión silenciosa con `sql_mode` no
estricto, `tinyint(1)` como booleano, `ON UPDATE CURRENT_TIMESTAMP`, claves ajenas que MyISAM no aplica…
Migrarlo graba un sistema que no existe, y la herramienta además nunca toca el legacy. El **regenerado** sí
puede ir sobre PostgreSQL: el diseño es neutral, y solo el lado del legacy necesita el adaptador.

## Principios

Los mismos del inc. 10:

1. **Medir antes de construir.** Las decisiones de `postgresql.js` salieron de `shop-api` (el retraso de
   `pg_stat` en 9.4, las secuencias que consume una escritura fallida, `pg_restore` con el pool abierto). Las de
   MySQL salen de un legacy real del banco, no de la documentación.
2. **La misma interfaz.** Se implementan las diez piezas de `ADAPTER_FUNCTIONS`. Ningún comando (`verify`,
   `introspect`, `probe`, `characterize`, `fixtures`, `parity`) gana una rama por motor.
3. **Lo no medido es un rechazo con motivo.** Una versión o una forma que no se ha medido sale en rojo con su
   porqué, no en un verde silencioso.
4. **Cada red se falsa.** Un sabotaje que conserva la forma por criterio, en rojo con exactamente su id.
5. **Portabilidad de Windows y podman.** El SQL va por stdin y la contraseña por entorno (`MYSQL_PWD`), igual que
   `psql -f -` y `PGPASSWORD`: el cliente de contenedores se come las comillas de la línea de comandos.

## Preguntas que hay que medir (M-*)

Cada una se contesta en el incremento M0 sobre el legacy del banco: `measured` o `refuted`, con su `archivo:línea`.

| id | Pregunta | Por qué importa | Hipótesis de partida |
|---|---|---|---|
| M-01 | ¿Restaura `mysql < dump` con el pool de la app conectado? | El dump hace `DROP TABLE`. Una transacción abierta del pool retiene el *metadata lock* y la restauración se queda colgada | Con conexiones ociosas restaura; con una transacción abierta se cuelga. Medir `--lock-wait-timeout` y decidir si el criterio sale en rojo con su motivo |
| M-02 | ¿Cuándo es fresco el `AUTO_INCREMENT` leído? | En 8.0, `information_schema.tables.AUTO_INCREMENT` se cachea (`information_schema_stats_expiry`, 86400 s por defecto): una huella que lo lea no ve la inserción. Es el mismo problema de `pg_stat` en 9.4 | `SET SESSION information_schema_stats_expiry = 0` en cada consulta (8.0); en 5.7 se lee en vivo |
| M-03 | ¿Una escritura fallida consume `AUTO_INCREMENT`? | Es un efecto, como la secuencia en SA-EFFECT-04 | Sí con `innodb_autoinc_lock_mode` 1 y 2 (duplicado de UNIQUE). Medir en la versión del legacy |
| M-04 | ¿Devuelve la restauración el contador? | Si no vuelve, la misma sonda da otro id y la repetibilidad cae | `mysqldump` escribe `AUTO_INCREMENT=` en el `CREATE TABLE`: vuelve. En 5.7 un reinicio lo recalcula como `max+1`, cosa que el snapshot no ve |
| M-05 | ¿Cómo se exporta el contenido de forma determinista? | `JSON_ARRAYAGG` no admite `ORDER BY`, y 5.6 o anterior no tiene funciones JSON | Una línea por fila con `JSON_OBJECT(...)` ordenada por la PK, y el agrupado en JS. Mínimo 5.7.8; 5.6 o anterior es rechazo con motivo (ver M0) |
| M-06 | ¿Qué forma tiene en JSON cada tipo? | La huella y el diff tienen que ser estables, y `fixtures` traduce esos valores al diseño | `DECIMAL` como texto, para conservar la escala; `BINARY(16)`/`BLOB` en hex; `tinyint(1)` como número (es booleano solo si el código lo dice); `TIMESTAMP` con `time_zone = '+00:00'` en la sesión; fechas cero (`0000-00-00`) como texto literal |
| M-07 | ¿La collation de cada columna llega a la superficie? | `UNIQUE` sobre `varchar` `_ci` es «único sin mayúsculas»: es un hecho del dominio (`compare`/sombra plegada en el DSL), y la sonda que lo demuestra es un duplicado con otro *case* | Leerla de `information_schema.columns.COLLATION_NAME` |
| M-08 | ¿Qué `sql_mode` corre el legacy? | Sin `STRICT_TRANS_TABLES`, un texto largo se trunca con 200 y no se rechaza con 400. Es comportamiento grabable, y `keep` o `fix` a sabiendas | `@@GLOBAL.sql_mode` y el de la sesión de la app, si el driver lo fija (Connector/J y los ORM a veces lo hacen) |
| M-09 | ¿Qué columnas cambian solas? | `ON UPDATE CURRENT_TIMESTAMP` y `DEFAULT CURRENT_TIMESTAMP` meten en el diff valores que no son del flujo | Marcarlas en la introspección (`EXTRA`) y normalizarlas como volátiles en `probe` |
| M-10 | ¿Hay tablas MyISAM? | MyISAM no tiene transacciones y **no aplica** las claves ajenas: una FK declarada no es integridad, y `--single-transaction` no le da consistencia | `ENGINE` por tabla en la superficie. La FK sobre MyISAM entra en `evidence-to-dsl` como referencia sin integridad |
| M-11 | ¿Triggers y procedimientos? | Es comportamiento que vive en la base | `information_schema.triggers` y `routines` en la superficie; el dump los lleva con `--triggers --routines` |
| M-12 | ¿Qué hay que adaptar en el sandbox para que arranque el driver viejo? | Connector/J 5.1 o `mysql` 2.x de Node no hablan `caching_sha2_password` (el default de 8.0) | Una `adaptation` conocida: `--default-authentication-plugin=mysql_native_password`, o la imagen de la versión de la CI. Va a la skill del sandbox |
| M-13 | ¿Qué privilegios necesita `mysqldump`? | Desde 8.0.21 pide `PROCESS` para los tablespaces | `--no-tablespaces`, o entrar como root con `MYSQL_ROOT_PASSWORD` |

## Incrementos

| # | Qué | Puerta |
|---|---|---|
| M0 | **Banco: un legacy real con MySQL, medido a mano.** Elegido el 2026-10-26: `show-ticketing` ([f-lab-edu/show-ticketing-service](https://github.com/f-lab-edu/show-ticketing-service) `7eacae89`, Java 8, MyBatis, MySQL 8 maestro y réplica, Redis; repinado desde su HEAD 9c8e8c8, cuyo login da siempre 500), con su hoja `docs/recover-bench/show-ticketing.answers.yaml` y el clon y el diario en `../keel-recover-lab/show-ticketing/`. **Paso 0 medido el mismo día**: 61 de 68 hechos `measured` y 3 `refuted`; M-01 (sin transacción abierta), M-02, M-03, M-04, M-07, M-08, M-12 y M-13 contestadas (ST-ENV-11). **Ronda 0 el mismo día** con `tools/probe.mjs` (rama MySQL nueva): 30 sondas, 30/30 repetibles, 86 % de líneas; contesta M-05 y M-06 (ST-ENV-12) y deja la hoja en 63 measured. **Puerta cerrada**: `docs/recover-bench/corridas/2026-10-26-show-ticketing-m0.md`. Versión mínima: **MySQL 8.0** (el DDL del legacy no carga en 5.7), así que 5.6/5.7 siguen fuera. Cubre M-01 a M-08, M-12 y M-13; **no** tiene MyISAM, `ON UPDATE CURRENT_TIMESTAMP`, triggers ni `ENUM` (M-09, M-10 y M-11), que se miden solo con la fixture de M2. Paso 0 a mano (sandbox, versión de la CI fijada por digest, snapshot y restauración con la app conectada) y una ronda de sondas a mano. **Decide la versión mínima soportada** (5.7.8 con JSON, o también 5.6 con exportación en TSV) | Corrida en `docs/recover-bench/corridas/` con cada M-* en `measured` o `refuted` y las adaptaciones del sandbox escritas. Sin esto no se escribe `mysql.js` |
| M1 | **Adaptador y registro.** `src/lib/db/mysql.js` con las diez piezas, cliente `mysql` dentro del contenedor (`env MYSQL_PWD=… mysql -N -B --default-character-set=utf8mb4`, el SQL por stdin): huella del CONTENIDO más `_auto_increment` (M-02); snapshot `mysqldump --single-transaction --routines --triggers --no-tablespaces` en `/tmp/recover-snapshot.sql`; restauración con `mysql` (M-01, M-04); exportación por fila (M-05, M-06) con `$keys`; diff por PK, con `_auto_increment` en el papel de `_sequences` (generalizar `dbDiff` de `postgresql.js` a un módulo común `db/relational.js` en vez de copiarlo); `HISTORY_TABLES` compartida. La entrada `mysql` en `ADAPTERS`, `mysql` en los enums de `sandbox.schema.json` y `target.schema.json`. Lo puro, con salidas grabadas del legacy de M0 | `test/db.test.js`: el registro atado a los enums, `parseExport` con los tipos de M-06 (decimal, binario, fecha cero, `TIMESTAMP` en otra zona), el diff con `_auto_increment` y la huella que cambia con un insert fallido. `npm test` en verde. **Hecho el 2026-10-26**: `db/mysql.js` + `db/relational.js` (diff, huella, contador e historial comunes; `probe` y `fixtures` ya no nombran `_sequences`), el motor en los dos schemas y en `target.js` (deploy MySQL de los tres generadores). Las diez piezas ejecutadas a mano contra show-ticketing con las dos credenciales (las del `MYSQL_USER` y root de la imagen): snapshot, huella que cambia con un insert fallido, restauración a la misma huella, introspección, vaciado y carga con rollback. Lo puro, con salidas grabadas de ese legacy. Fuera: la fecha cero y `TIMESTAMP` en otra zona (sin columnas así en el legacy: M2); `surface.yaml` ya lleva `engine`, `collation`, `autoIncrement`, `unsigned` y los valores de un `ENUM`, y `onUpdate` y los triggers quedan para M3 |
| M2 | **Fixture `fixtures/sandbox/node-mysql`**, gemela de `node-postgres` por HTTP (el mismo `stock-design.js`): `AUTO_INCREMENT`, `UNIQUE` sobre `varchar` `_ci`, FK en cascada, ciclo de vida en `ENUM` o `CHECK` (este, desde 8.0.16), cantidad en `JSON`, `updated_at ON UPDATE CURRENT_TIMESTAMP` y la misma carrera de `take` con el pool caliente. MySQL de la versión de M0, fijado por digest. Eje `--database=mysql` en `verify-check` | `npm run verify-check -- --database=mysql`: verde tal cual y los sabotajes en rojo con su criterio (red con salida, sin cobertura, base caída con `/health` en 200, escritura sin rastro). Uno más, propio de M-02: la huella leyendo el contador cacheado, que debe dar `VER-DB-TRACE` en rojo |
| M3 | **Introspección y efectos.** `introspectDb` sobre `information_schema` (`columns` con `COLUMN_TYPE`, `COLLATION_NAME` y `EXTRA`; `table_constraints`, `key_column_usage`, `referential_constraints` con `DELETE_RULE`; `check_constraints` en 8.0.16+; `statistics` para los índices; `tables.ENGINE`; triggers y rutinas). Las columnas de estado por su forma, como en PostgreSQL. Los `ENUM` nativos salen de `COLUMN_TYPE`. `surface.yaml` (sin schema propio) gana `collation`, `engine`, `onUpdate` y `triggers` como claves opcionales, que el adaptador de PostgreSQL no emite. `probe` normaliza las columnas `onUpdate` (M-09). Eje `--database=mysql` en `probe-check` y `characterize-check` | `npm run probe-check -- --database=mysql` en verde y con sus sabotajes por canal (la carrera solo visible en paralelo, con `parallel-exec` ocultándola), y una sonda del duplicado con otro *case* que graba el 409 (M-07). `npm run characterize-check -- --database=mysql`: los cuatro flujos en verde y los cuatro sabotajes en rojo con exactamente sus flujos |
| M4 | **La skill.** `evidence-to-dsl.md` gana las filas de MySQL: collation `_ci` → `compare`/sombra plegada (con su sonda), `sql_mode` no estricto → truncado `keep` o `fix`, `tinyint(1)` → booleano solo con `read`, `ENUM` de columna → estados del `lifecycle`, FK en MyISAM → referencia sin integridad, `onUpdate` → no es campo del flujo, `_auto_increment` → efecto técnico. `sandbox-files.md` (`tech: mysql`, `user`, la adaptación del plugin de M-12) y `exploration.md` (las sondas de clase de MySQL: el duplicado con otro *case* y el texto por encima de la columna) | Un test nuevo, porque hoy ninguno ata la superficie con la skill: cada clave que emite `introspect` (en los tres motores) tiene su fila en `evidence-to-dsl.md`. `class-probes.test.js` con las dos sondas de clase nuevas |
| M5 | **La paridad contra un regenerado en MySQL.** `target.js`: entrada `mysql` en `ENGINES` (imagen `mysql:`, `MYSQL_DATABASE`, `MYSQL_USER`/`MYSQL_PASSWORD` o root con `MYSQL_ROOT_PASSWORD`) y fuera de la regex de rechazo. `empty`: `SET FOREIGN_KEY_CHECKS=0` y `TRUNCATE` en la MISMA sesión (reinicia el `AUTO_INCREMENT`), sin las tablas de historial y contando lo que queda. `loadScript`: el `infra/fixtures.sql` del regenerado, que ya viene en su dialecto (uuid en `BINARY(16)` en keel-dotnet). `keel-recover fixtures` traduce los valores exportados de M-06 a los del diseño (hex → uuid, decimal, booleano) | `test/target.test.js` con un deploy de keel-spring y otro de keel-dotnet sobre MySQL. Red en vivo pequeña, `scripts/target-db-check.js` (nuevo): vaciado y carga del `fixtures.sql` de la fixture `shop-api` generado por los dos sobre un MySQL real, y su sabotaje (una tabla que el vaciado se salta) en rojo |
| M6 | **Corrida de control.** `/keel-recover-run` sobre el legacy de M0, de punta a punta: diseño recuperado, generado con keel-spring o keel-dotnet sobre MySQL, `characterize` y `parity` en verde. Y lo que destape, arreglado en los generadores con la fixture del legacy si toca, como con `shop-api` | Corrida en `docs/recover-bench/corridas/` con la tabla de paridad (`keep`, `fix`, `frontier`, `new`, diferencias declaradas y sin declarar). Fila 11 de `PLAN-KEEL-RECOVER.md` cerrada y la línea de MySQL en `CLAUDE.md` |

## Fuera de alcance, con motivo

- **MariaDB.** Comparte cliente y dump, pero diverge en lo que este adaptador pregunta: el binario se llama
  `mariadb`/`mariadb-dump` desde la 11, `JSON` es un alias de `LONGTEXT`, tiene objetos `SEQUENCE` (10.3) y tablas
  versionadas por sistema. Va detrás, como un `flavor` del mismo adaptador, cuando un legacy del banco lo pida.
  Hasta entonces sigue siendo rechazo con motivo.
- **MySQL 5.6 o anterior**, salvo que M0 decida lo contrario: sin funciones JSON, la exportación necesita otro
  camino (TSV tipado en JS), y no se construye sin un legacy que lo mida.
- **Replicación, sharding y varios esquemas.** El adaptador lee una base (`database.name`), como el de PostgreSQL lee
  `public`.
- **`lower_case_table_names`.** Un legacy que en producción corría sobre Windows (valor 1) y en el sandbox corre
  sobre Linux (valor 0) puede romper consultas con mayúsculas. Si M0 lo encuentra, es una `adaptation` del sandbox,
  no del adaptador.

## Riesgos

- **La restauración con el pool abierto (M-01)** es lo que más puede costar. Si el *metadata lock* bloquea, las
  salidas son malas (matar las conexiones de la app cambia su comportamiento) y hay que medirlas, no suponerlas.
- **MyISAM** convierte el snapshot en no transaccional. Una sonda concurrente sobre una tabla MyISAM no tiene la
  misma semántica que sobre InnoDB, y eso hay que grabarlo, no corregirlo.
- **La zona horaria.** `TIMESTAMP` se convierte a la zona de la sesión. Exportar con otra zona que la del legacy
  cambia la huella entre dos ejecuciones del mismo estado si alguien la toca. Se fija `+00:00` en la sesión del
  adaptador y se comprueba en M1.
- **El tamaño del dump** de un legacy con datos reales. El snapshot vive dentro del contenedor, como en PostgreSQL.

## Verificación

- Cada incremento cierra con su puerta de la tabla y con `npm test` en verde en todo el monorepo.
- Las redes en vivo con `--database=mysql` siguen en su color con `mongodb` y `postgresql`: añadir un motor no
  puede cambiar el resultado de los otros dos.
- M6 es la medida final: la misma tabla de paridad en dos ejecuciones seguidas.
