# Base de datos — configuración y tuning (transversal a dialectos)

Propiedades que el agente puede necesitar añadir en
`parameters/<perfil>/db.yaml`. Build ya dejó URL/credenciales (gradiente por
perfil), `ddl-auto` y `open-in-view: false`: **no las toques**; añade el resto
solo cuando un escenario o un problema real lo pida.

## Pool de conexiones (HikariCP, el default de Boot)

```yaml
spring:
  datasource:
    hikari:
      # Pool pequeño y fijo rinde más que uno grande: empieza en 10 (default)
      # y dimensiona con la fórmula (núcleos * 2 + discos) del wiki de HikariCP,
      # no con el número de hilos de la app (virtual threads no multiplican BD).
      maximum-pool-size: 10
      minimum-idle: 10            # igual a maximum-pool-size = pool fijo (recomendado)
      connection-timeout: 30000   # ms esperando conexión libre antes de fallar
      # Debe ser MENOR que el timeout de conexión inactiva del servidor/proxy
      # (p. ej. wait_timeout de MySQL, idle timeouts de balanceadores).
      max-lifetime: 1800000
      # Sube el umbral solo para diagnosticar fugas (0 = apagado).
      leak-detection-threshold: 0
```

- El pool lo comparten todos los handlers; con `UseCaseMediator` cada dispatch
  usa una conexión durante la transacción completa: transacciones cortas > pool
  grande.
- No configures `validation-timeout`/`connection-test-query` con drivers JDBC4
  (todos los del catálogo): Hikari usa `isValid()` solo.

## Hibernate: batching y fetch

Solo si hay escritura masiva o N+1 detectado:

```yaml
spring:
  jpa:
    properties:
      hibernate:
        jdbc.batch_size: 50          # agrupa INSERT/UPDATE en lotes JDBC
        order_inserts: true          # reordena para poder agrupar
        order_updates: true
        # Carga colecciones lazy en lotes (mitiga N+1 sin tocar queries).
        default_batch_fetch_size: 16
        # IN (?,?,...) con tamaños en potencias de 2: mejora el hit del plan cache.
        query.in_clause_parameter_padding: true
```

- El batching **no funciona** con `GenerationType.IDENTITY` (MySQL/MariaDB sin
  secuencias): ver el dialect correspondiente.
- El arreglo estructural del N+1 es `JOIN FETCH` / `@EntityGraph` en el
  repositorio, no configuración; `default_batch_fetch_size` es la red de
  seguridad.

## Locking optimista

Si el diseño declara concurrencia sobre un agregado (o `flow-fidelity` detecta
updates concurrentes), añade `@Version` en la entidad `XxxJpa` (campo
`private Long version`): Hibernate lanza `OptimisticLockException` → mapéala al
error de conflicto (409) que declare el diseño. No uses locking pesimista salvo
que el diseño lo pida explícitamente.

## Logging SQL

Build deja `show-sql: true` solo en local. Para ver parámetros bind (solo
depuración local, jamás en production — loguea datos):

```yaml
logging:
  level:
    org.hibernate.SQL: DEBUG
    org.hibernate.orm.jdbc.bind: TRACE
```

## Esquema por perfil

- `local`: `ddl-auto: update` y Flyway apagado — el único perfil donde Hibernate
  gobierna el esquema, para poder iterar sobre las entidades.
- `develop`/`production`: `ddl-auto: validate` y Flyway encendido
  (`${FLYWAY_ENABLED:true}`) — el esquema lo ponen las migraciones de
  `db/migration/`, Hibernate solo comprueba que cuadra. Ver `migrations.md`.
- Auxiliares aditivos (`PROFILE=local,<perfil>`): `schema-export` (exporta el DDL
  de las entidades a un archivo, sin tocar la BD) y `migrations` (reproduce en
  local el gobierno por migraciones, para probar el baseline).
- `test`: `create-drop` sobre H2 (ya generado). Verde en H2 ≠ verde en la BD
  real: los escenarios `FL-*` contra el servidor con la BD del compose son la
  validación que cuenta.

## Qué no hacer

- No revertas `open-in-view: false` para «arreglar» una
  `LazyInitializationException`: el fetch que falta se resuelve en el
  repositorio (ver troubleshooting).
- No actives cache de segundo nivel de Hibernate: si el diseño pide caché, va
  por la capa `cache` del stack (skill `keel-spring-redis`).
- No pongas `spring.jpa.database-platform`: Boot detecta el dialecto del driver.
