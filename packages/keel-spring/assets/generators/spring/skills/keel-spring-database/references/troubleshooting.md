# Base de datos — troubleshooting

Síntoma → causa → arreglo. Particularidades por dialecto en
`references/dialects/<database>.md`; sondeo en
`{{keel:docs}}/conventions/infra-validation.md`.

## `Connection is not available, request timed out` (pool agotado)

Todas las conexiones ocupadas más de `connection-timeout` (30s). Causas por
orden de probabilidad:

1. **Transacciones largas**: un handler hace I/O externo (HTTP, broker) dentro
   de la transacción del `UseCaseMediator`. Saca ese I/O fuera (o a
   `afterCommit`); la transacción debe durar lo que duran las queries.
2. **Fuga**: conexión abierta a mano sin cerrar. Diagnostica con
   `leak-detection-threshold: 60000` en local y mira el stack trace que loguea.
3. Pool realmente corto para la carga: **última** hipótesis; sube
   `maximum-pool-size` solo con evidencia (threads esperando con transacciones
   cortas).

## `LazyInitializationException`

Se accedió a una relación lazy fuera de la transacción (open-in-view está
apagado a propósito). El arreglo es **fetch en el repositorio**: `JOIN FETCH`
en la query o `@EntityGraph` en el método, de modo que el agregado salga
completo del adaptador. Nunca reactives `open-in-view` ni marques la relación
EAGER global: eso convierte cada query en un producto cartesiano silencioso.

## N+1 (una query por elemento de una lista)

Visible en local con `show-sql: true`: una query «madre» y N idénticas
después. **Hay dos N+1 distintos y se ven igual en el log; mira a qué tabla van
las N consultas**, porque el arreglo no es el mismo:

**1. Intra-agregado** — las N consultas van a la tabla de una entidad **hija**
(`select ... from product_image where product_id = ?`). Es el N+1 clásico de
Hibernate: una colección lazy que se toca por elemento. Arreglo estructural:
`JOIN FETCH`/`@EntityGraph` en el método del repositorio que alimenta ese flujo,
de modo que el agregado salga completo del adaptador. Mitigación global:
`hibernate.default_batch_fetch_size` (ver `references/configuration.md`).

**2. Entre agregados** — las N consultas van a la tabla de **otra raíz**
(`select ... from brand where id = ?`), típicamente resolviendo los `embed` de un
listado. Aquí `JOIN FETCH` y `@EntityGraph` **no aplican**: no hay asociación que
recorrer, solo una columna `UUID`, y `default_batch_fetch_size` tampoco (no hay
colección lazy que lotear). El arreglo es **aplicativo**: resolver por lote con el
`<X>RefResolver` que build inyecta en el handler — ver
`{{keel:docs}}/conventions/read-composition.md`. Si además la operación filtra u ordena por un
campo del agregado ajeno, el lote no basta: `references/read-queries.md`.

## `function <nombre>(bytea) does not exist` al listar o buscar

Síntoma: **todos** los endpoints de listado/búsqueda responden `500`, con o sin
término de búsqueda, mientras el resto del servicio funciona. En el log,
PostgreSQL rechaza una función que sí existe (`unaccent`, `similarity`…) con un
tipo de argumento absurdo (`bytea`).

Causa: la query pasa un **parámetro con nombre dentro de una expresión
compuesta** a una función nativa — `function('unaccent', concat('%', :q, '%'))`.
Hibernate emite el parámetro como `?` sin tipo y PostgreSQL no puede inferirlo
en esa posición, así que lo resuelve al tipo por defecto del driver. Falla en
`prepare`, es decir **antes** de evaluar el `:q is null` que protege el resto de
la condición: por eso también fallan las llamadas sin término de búsqueda.

Arreglo: castea el parámetro explícitamente en el JPQL.

```java
// mal
"lower(function('unaccent', p.name)) like lower(function('unaccent', concat('%', :q, '%')))"
// bien
"lower(function('unaccent', p.name)) like lower(function('unaccent', concat('%', cast(:q as string), '%')))"
```

Generalización, aplicable a cualquier dialecto: **una función nativa invocada
sobre `concat`/`coalesce`/aritmética con un parámetro con nombre necesita
`cast(:param as <tipo>)`**. El cast no cuesta nada y hace la query portable.
Antes de comprometerte con `function(...)` en JPQL, mira si la vía 1 o la 3 de
`jpa-mapping.md` § Búsqueda que ignora mayúsculas y acentos te evitan el
problema entero.

## `OptimisticLockException` en escenarios concurrentes

Es el comportamiento **deseado** del `lockVersion` (`@Version`): dos updates sobre
la misma versión. Mapéala en el handler al error de conflicto (409) declarado en el
diseño; si el diseño no declara ese conflicto, es un hueco → repórtalo como
`designGap`, no lo silencies reintentando. Ojo: esto **no** es un mismatch de
`expectedVersion` contra un `version` de dominio — ese lo detecta el handler del
caso de uso antes de mutar, y suele tener su propio `code`.

## Verde en tests, rojo contra la BD real (drift H2)

El perfil test corre H2 `MODE=PostgreSQL` sea cual sea la BD del stack:
funciones, collations, casing de identificadores y semántica de NULL difieren
(detalle en el dialect correspondiente). El test unitario no se «arregla»
degradando la query: confirma contra la BD real (escenario `FL-*`) y, si la
query no puede expresarse portable, documenta la decisión.

## `violates check constraint "<tabla>_<campo>_check"` con un valor que el enum sí declara

En `local` el esquema lo mantiene `ddl-auto: update`, que **solo añade**: crea la
`CHECK` de un enum una vez, con los valores de entonces, y no vuelve a tocarla. Si el
diseño renombró o añadió un valor (`RETIRED` → `DISCONTINUED`) entre dos generaciones
sobre la misma BD, la tabla conserva la lista vieja y rechaza el valor nuevo aunque el
`enum` de Java, la entidad y el DDL que exportarías hoy sean correctos. Y no hay
migración que lo reconcilie: en `local` no hay Flyway hasta el baseline del cierre.

No lo busques en el código ni en una anotación `@Check`: comprueba la constraint viva
(`\d+ <tabla>` en psql, `information_schema.check_constraints` en el resto) y compárala
con el enum. La salida es recrear el esquema —`bash infra/reset-db.sh --schema`—, no
editar la constraint a mano, que dejaría la BD distinta del DDL que Hibernate generaría.

## `ddl-auto: validate` falla al arrancar en production

El esquema real no coincide con las entidades (columna/tipo/nullable). Es un
error **bueno**: la fuente de verdad del esquema son las migraciones, no
Hibernate. Corrige el esquema (o la entidad si el diseño cambió), nunca relajes
a `update` en production.

Causa habitual: el baseline de `db/migration/` se exportó antes de terminar de
mapear las entidades. Vuelve a exportarlo (`bash infra/export-schema.sh`) y, si
`V1` ya se aplicó en algún ambiente, el cambio va en una `V2` — nunca editando
`V1`. Procedimiento en `migrations.md`.

## `Schema-validation: missing table` con `db/migration/` vacío

No hay baseline: Flyway no aplicó nada y Hibernate no crea nada fuera de `local`.
No es un bug de configuración — es el paso pendiente de `migrations.md`.

## `Migration checksum mismatch` al arrancar

Se editó una migración ya aplicada. Flyway compara checksums a propósito.
Revierte el archivo a su contenido original y mete el cambio en una migración
nueva. No uses `repair` para tapar un cambio de contenido deliberado: solo
aplica cuando la corrección del propio archivo es la reparación buscada y nadie
más ha aplicado esa versión.

## Tras `reset-db.sh` el arranque intenta reaplicar `V1`

El historial de Flyway se perdió. El script excluye `flyway_schema_history` a
propósito: si alguien quitó esa exclusión (o se truncó la tabla a mano), Flyway
cree que la BD está virgen y choca con las tablas existentes. Restaura la
exclusión y recrea la BD (`docker compose ... down -v`) para partir limpio.

## La app arranca pero `reset-db.sh` no limpia

- El script vacía **datos** preservando esquema; si añadiste tablas después
  del último arranque, re-ejecuta la app antes de validar.
- Ids no reseteados (SQL Server usa DELETE; Oracle no reinicia secuencias):
  los Given de los escenarios no deben asumir ids concretos — crea los datos
  del Given vía API y usa los ids devueltos.
