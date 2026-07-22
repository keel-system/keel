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
