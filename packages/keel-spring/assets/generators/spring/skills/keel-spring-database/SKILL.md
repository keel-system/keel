---
name: keel-spring-database
description: Guía de base de datos relacional en un proyecto generado por keel-spring — tuning de datasource/Hikari y JPA/Hibernate, particularidades del dialecto elegido y validación; el código JPA (entidades espejo, repositorios, adaptadores) ya lo genera build. Usar cuando keel-stack.json declara database "postgresql", "mysql", "mariadb", "sqlserver", "oracle" o "h2".
---

# Base de datos relacional (database: la de `keel-stack.json`)

El código de persistencia sale **completo** de build (transversal a todos los
dialectos): espejo `XxxJpa`, `JpaRepository`, puerto + adaptador
`XxxRepositoryImpl`, auditoría (`AuditableEntity`) y el datasource en
`parameters/<perfil>/db.yaml`. **No reescribas ese código.** Esta skill cubre
lo que sí varía: tuning de configuración, particularidades del dialecto y
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
  + `com.h2database:h2` como `testRuntimeOnly` (el perfil test corre en H2
  aunque el stack declare otra BD).
- `parameters/<perfil>/db.yaml`: URL/credenciales con gradiente por perfil y
  `ddl-auto` (`update` en local/develop, `validate` en production);
  `parameters/test/db.yaml` con H2 en memoria (`MODE=PostgreSQL`).
- `application.yaml`: `spring.jpa.open-in-view: false` (no lo revertas: las
  relaciones lazy se resuelven dentro del `UseCaseMediator`, no en la vista).
- `infra/docker-compose.yaml`: contenedor de la BD elegida (h2 no levanta
  contenedor) e `infra/reset-db.sh` para vaciar datos entre flujos.

## Qué hace el agente

1. **Esquema definitivo**: `ddl-auto: update` es solo para arrancar; decide el
   esquema final (idealmente migraciones) respetando los índices y claves
   naturales de `persistence.keel.yaml`. En production Hibernate solo valida.
2. **Tuning solo si un escenario lo pide**: pool Hikari, batching, fetch — con
   `references/configuration.md`. No tunees por adelantado.
3. **Dialecto**: revisa `references/dialects/<database>.md` antes de decidir
   tipos de columna no triviales (JSON, UUID, texto largo) o de depurar
   diferencias entre H2 (tests) y la BD real.

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/configuration.md` | Antes de tocar `parameters/<perfil>/db.yaml` o propiedades `spring.jpa.*` (Hikari, batching, N+1, locking) |
| `references/dialects/<database>.md` | Al decidir tipos de columna, depurar el dialecto o preparar su validación/reset (solo el del stack) |
| `references/troubleshooting.md` | Si el arranque, el pool o las queries fallan (pool agotado, LazyInitializationException, drift H2/BD real) |

## Validación

Sondeo y reset por dialecto desde devtools (o el propio contenedor):
`infra/validate-infra.sh` y `bash infra/reset-db.sh` entre flujos.
Recetas completas en `.claude/conventions/infra-validation.md`.
