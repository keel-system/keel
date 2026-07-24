---
name: keel-spring-database
description: Guía de base de datos relacional en un proyecto generado por keel-spring — migraciones de esquema (Flyway), tuning de datasource/Hikari y JPA/Hibernate, particularidades del dialecto elegido y validación; el código JPA (entidades espejo, repositorios, adaptadores) ya lo genera build. Usar cuando keel-stack.json declara database "postgresql", "mysql", "mariadb", "sqlserver", "oracle" o "h2".
---

# Base de datos relacional (database: la de `keel-stack.json`)

El código de persistencia del **caso común** sale de build (transversal a todos
los dialectos): espejo `XxxJpa`, `JpaRepository`, puerto + adaptador
`XxxRepositoryImpl`, auditoría (`AuditableEntity`) y el datasource en
`parameters/<perfil>/db.yaml`. **No rehagas ese patrón**; extiéndelo/ajústalo
siguiendo `references/jpa-mapping.md` cuando el diseño exija lo que build no
resuelve: relaciones bidireccionales (`mappedBy`/fetch), to-many entre agregados,
value objects anidados o `@Embeddable`, converters, `json`→jsonb, `@Version`
(locking) o autoría (`createdBy`/`updatedBy`). Build nunca deja código que no
compila: donde no puede decidir deja un `// TODO (agente): …` que debes resolver.
Esta skill cubre además lo que solo varía en configuración: tuning, dialecto y
validación/reset de datos.

## Antes de empezar

- Aplica con cualquier valor de `"database"` en `keel-stack.json`; las
  particularidades de tu dialecto están en `references/dialects/<database>.md`
  (lee **solo** ese).
- Lee `specs/persistence.keel.yaml`: mapeo, claves naturales, índices y
  `consistency` — el diseño es la única fuente de verdad funcional.
- Sigue estrictamente `.claude/conventions/mapping.md`; la estructura de
  paquetes está en `.claude/conventions/project-layout.md`.
- **Frontera**: build ya dejó el código JPA, la config por perfil y el compose;
  esta skill cubre solo tuning, dialecto y validación.

## Qué dejó listo build

- `build.gradle`: `spring-boot-starter-data-jpa` + driver del dialecto elegido
  + `flyway-core` y su módulo de dialecto + `com.h2database:h2` como
  `testRuntimeOnly` (el perfil test corre en H2 aunque el stack declare otra BD).
- `parameters/<perfil>/db.yaml`: URL/credenciales con gradiente por perfil,
  `ddl-auto` (`update` solo en local, `validate` en develop/production) y
  `spring.flyway` (apagado en local y test, encendido en los desplegados);
  `parameters/test/db.yaml` con H2 en memoria (`MODE=PostgreSQL`).
- `db/migration/` **vacío** (con su README) y los perfiles auxiliares
  `schema-export` y `migrations`: el mecanismo está, el baseline lo pones tú.
- `application.yaml`: `spring.jpa.open-in-view: false` (no lo revertas: las
  relaciones lazy se resuelven dentro del `UseCaseMediator`, no en la vista).
- `infra/docker-compose.yaml`: contenedor de la BD elegida (h2 no levanta
  contenedor) e `infra/reset-db.sh` para vaciar datos entre flujos.

## Qué hace el agente

1. **Resolver los TODO de build**: busca `// TODO (agente)` en
   `infrastructure/persistence/` (value objects anidados, mapeos que build no pudo
   aplanar) y complétalos con `references/jpa-mapping.md`.
2. **Extender el mapeo estructural**: aplica lo de `references/jpa-mapping.md`
   cuando `persistence.keel.yaml`/`domain.keel.yaml` exijan relaciones
   bidireccionales, to-many entre agregados, `@Embeddable`, converters, `json`→jsonb,
   `@Version` o autoría.
3. **Migraciones (el esquema definitivo)**: `ddl-auto: update` es solo del perfil
   `local` mientras iteras. En `develop`/`production` el esquema lo gobiernan las
   migraciones Flyway de `src/main/resources/db/migration/`, que **están vacías
   hasta que las llenes**: sin baseline el servicio no arranca desplegado. Se
   exporta de las entidades ya finales con `bash infra/export-schema.sh`, se
   revisa y se prueba con `PROFILE=local,migrations` sobre una BD sin esquema.
   Procedimiento completo y checklist en `references/migrations.md`. Es el último
   paso de la persistencia, no el primero.
4. **Tuning solo si un escenario lo pide**: pool Hikari, batching, fetch — con
   `references/configuration.md`. No tunees por adelantado.
5. **Dialecto**: revisa `references/dialects/<database>.md` antes de decidir
   tipos de columna no triviales (JSON, UUID, texto largo) o de depurar
   diferencias entre H2 (tests) y la BD real.

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/jpa-mapping.md` | Al resolver un `// TODO (agente)` de persistencia o al mapear algo que build no cubre (relaciones bidireccionales/to-many entre agregados, VO anidados/`@Embeddable`, converters, `json`→jsonb, `@Version`, autoría) |
| `references/migrations.md` | Al producir el baseline de `db/migration/` (exportar, revisar, probar) y al añadir migraciones posteriores |
| `references/configuration.md` | Antes de tocar `parameters/<perfil>/db.yaml` o propiedades `spring.jpa.*` (Hikari, batching, N+1, locking) |
| `references/dialects/<database>.md` | Al decidir tipos de columna, depurar el dialecto o preparar su validación/reset (solo el del stack) |
| `references/troubleshooting.md` | Si el arranque, el pool o las queries fallan (pool agotado, LazyInitializationException, drift H2/BD real) |

## Validación

Sondeo y reset por dialecto desde devtools (o el propio contenedor):
`infra/validate-infra.sh` y `bash infra/reset-db.sh` entre flujos.
Recetas completas en `.claude/conventions/infra-validation.md`.
