# Metodología Keel

Cómo humanos y agentes colaboran para diseñar un servicio una vez y generarlo en cualquier tecnología.

## El ciclo

```
diseñar ──> validar ──> generar ──> documentar
   ▲                                    │
   └──────── iterar sobre el spec ◄─────┘
```

1. **Diseñar** (`/keel-design`) — el agente entrevista al humano sobre el dominio y construye el diseño **capa a capa** (ver "Diseño por capas" más abajo): cada capa es un artefacto YAML propio que el humano aprueba antes de pasar a la siguiente, revisable en un diff pequeño. El cierre del diseño produce además `specs/<servicio>/validation-scenarios.md` (formato: [validation-scenarios.md](validation-scenarios.md)): escenarios Given/When/Then que cubren toda operación y todo error declarado, el contrato con el que la fase de generación valida el servidor. Como paso final del cierre, el agente ejecuta automáticamente `/keel-handoff` para derivar `docs/<servicio>/DESIGN.md` (capturando en el momento el porqué de las decisiones) y actualizar el índice de servicios del `README.md` del workspace, de modo que el diseño quede documentado y visible para otros equipos apenas se termina.
2. **Validar** (`/keel-validate`) — tres niveles: JSON Schema por artefacto + referencias cruzadas mecánicas (ambos vía `keel validate specs/<servicio>`) y revisión semántica del agente (reglas ambiguas, errores faltantes, mínimo privilegio). La CLI también detecta **diseño incompleto**: capas que siguen siendo la plantilla y descriptions placeholder (empiezan por `TODO:`, la convención que siembran las plantillas). Durante el diseño se valida el progreso con `keel validate --wip` (los pendientes son avisos); nada se genera desde un diseño inválido o en progreso.
3. **Generar** (`/keel-generate <tech>`) — dos mitades. El comando `keel-<tech> build` (cada generador es un paquete npm con CLI propia, ej. `keel-spring build specs/<servicio>`) pregunta el stack al diseñador y genera de forma determinista el **scaffolding transversal**: todo lo necesario para levantar el proyecto (dependencias del stack, config, infraestructura de prueba) más la estructura que no depende de la infra puntual elegida. Después el agente, con la skill del generador instalado (`generators/<tech>/`: convenciones + referencias por tecnología), escribe el código que sí depende de la infra elegida, la lógica de negocio y los tests, produciendo un servicio como repo git propio en `services/<servicio>-<tech>/` con tests que cubren cada operación y cada error declarado. La verificación final incluye arrancar el servidor generado y ejecutar contra él los escenarios de `validation-scenarios.md` con llamadas reales.
4. **Documentar** — del mismo spec se derivan dos documentaciones complementarias, según a quién sirvan: `/keel-docs` produce `INTEGRATION.md`, `openapi.yaml` y colecciones Postman (`postman/`) para **integradores externos** que consumen el servicio en ejecución; `/keel-handoff` produce `DESIGN.md` (características del dominio + decisiones de diseño con su porqué) para que **otro equipo reutilice el diseño** sin leer el código. `DESIGN.md` y el índice del `README.md` se generan automáticamente al cerrar el diseño (paso 1); `/keel-handoff` los **regenera** cuando el spec cambia (re-deriva lo mecánico y preserva el porqué ya capturado).

La regla que sostiene todo: **si un cambio es funcional, se hace en el spec y se regenera; nunca directamente en el código generado.** El código y la documentación son derivados; el spec es la fuente de verdad.

El versionado sigue la misma separación: el repo del workspace versiona solo el diseño (`specs/`, schemas, docs) — el `.gitignore` sembrado por `keel init` excluye `services/` — y cada servicio generado vive en su propio repo git dentro de `services/<servicio>-<tech>/`, con su ciclo de vida independiente.

## Diseño por capas

Desde keel 2.0 el diseño de un servicio no es un archivo monolítico sino un directorio `specs/<servicio>/` de artefactos relacionados por nombre. Cada capa se itera y aprueba por separado con el humano; el manifiesto `service.keel.yaml` declara cuáles existen.

```
service (manifiesto)
   └── domain ──> use-cases ──> api ──────────┐
                     │            └──> security
                     ├──> messaging
                     ├──> http-clients
                     ├──> persistence
                     └──> storage
```

- **Obligatorias**: `domain` (entidades, invariantes) y `use-cases` (operaciones).
- **Opcionales**: `api`, `security`, `messaging`, `http-clients`, `persistence`, `storage` — se declaran solo si aplican. Un worker sin API no tiene `api`; un servicio sin estado no tiene `persistence`; uno que no maneja archivos no tiene `storage`.
- La capa `api` distingue el público de cada endpoint (`audience`: usuarios web/mobile, otros servicios M2M, o ambos) y `security` modela a los consumidores máquina (`serviceAuth`, `serviceClients`, `level: service` con scopes); ver `dsl/api.md` y `dsl/security.md`.
- Orden de diseño: **domain → use-cases → api → security → messaging → http-clients → persistence → storage**. Hay dos referencias hacia delante: `emits` (use-cases nombra eventos que se definen al llegar a messaging) y los campos `file` del domain (que nombran buckets definidos al llegar a storage); mientras la capa destino no exista, `keel validate --wip` las reporta como pendientes en vez de error.
- Cada capa se cierra con `keel validate --wip specs/<servicio>` (las capas aún en plantilla son avisos, no errores); el diseño completo se cierra con `keel validate` sin flag, en verde, más `validation-scenarios.md` con su matriz de cobertura completa.
- `keel new <servicio>` crea el directorio con manifiesto + domain + use-cases; el resto se añade desde `templates/service/` cuando aplique.
- `keel new <nuevo> --from <origen>` deriva un servicio de un diseño existente: clona sus artefactos (sin `validation-scenarios.md`, que se regenera al cerrar), arranca en versión `0.1.0` con `service.basedOn: <origen>@<versión>` como linaje y deja la `description` marcada como pendiente de revisar; el diseño continúa con `/keel-design` en modo derivación (entrevista solo sobre lo que cambia respecto al origen). Antes de derivar, `keel describe <origen>` resume el diseño (identidad, estado, capas y contenido por capa) para decidir si sirve tal cual o qué hay que adaptar; el análisis completo, con las decisiones y su porqué, está en `docs/<origen>/DESIGN.md`.
- Referencia completa de cada capa: [dsl-reference.md](dsl-reference.md).

### Migración desde specs monolíticos 1.0

| Sección 1.0 | Artefacto 2.0 |
|-------------|---------------|
| `keel`, `service` | `service.keel.yaml` (+ bloque `layers`) |
| `types`, `entities` | `domain.keel.yaml` (+ `aggregates`) |
| `operations` | `use-cases.keel.yaml` (+ `idempotency`, `cache`, `schedule`, `internal` por operación) |
| `api` | `api.keel.yaml` |
| `policies.auth` | `security.keel.yaml` (`access`, ahora con `roles`/`permissions`) |
| `policies.pagination` | `api.keel.yaml` (`pagination`) |
| `policies.idempotency` | `use-cases.keel.yaml` (`idempotency` en cada operación) |
| `events.published` | `messaging.keel.yaml` (`publishing.events`, + `reliability`) |
| `events.consumed` | `messaging.keel.yaml` (`subscriptions`, + `onFailure`) |
| `integrations` kind `http` | `http-clients.keel.yaml` (+ resiliencia por llamada) |
| `integrations` kind `storage` (BD) | `persistence.keel.yaml` |
| `integrations` kind `storage` (archivos/blobs) | `storage.keel.yaml` (buckets) + campos `file` en `domain.keel.yaml` |

## División de responsabilidades

| | Humano | Agente |
|---|---|---|
| Diseño | Conoce el dominio, decide qué hace el servicio, aprueba secciones | Pregunta, propone el spec, fuerza los casos incómodos (errores, estados) |
| Validación | Resuelve ambigüedades señaladas | Ejecuta schema + checklist semántica, propone correcciones |
| Generación | Elige tecnología y decisiones de despliegue (BD, broker, object storage) | Produce el código completo con tests y lo verifica |
| Documentación | Revisa que los escenarios reflejen el uso real | Deriva docs coherentes con el spec |

## Convenciones de nombres

- Servicios e integraciones: `kebab-case` (`product-catalog`).
- Entidades, types y eventos: `PascalCase` (`Product`, `SKU`, `ProductCreated`).
- Campos y operaciones: `camelCase` (`createdAt`, `retireProduct`).
- Códigos de error: `SCREAMING_SNAKE_CASE` (`SKU_ALREADY_EXISTS`).
- Roles: `kebab-case` (`catalog-admin`); permisos: `recurso:accion` (`product:write`).
- Operaciones nombradas por intención de negocio: `retireProduct`, no `updateProductStatus`.
- Eventos en pasado: `ProductCreated`, no `CreateProduct`.
- Un directorio por servicio: `specs/<nombre-servicio>/` con un artefacto por capa (`<capa>.keel.yaml`).

## Versionado y evolución del spec

`service.version` es semver **del contrato**, no del código:

- **Patch** (1.0.0 → 1.0.1): aclaraciones de texto, descripciones, reglas reescritas sin cambiar comportamiento.
- **Minor** (1.0.x → 1.1.0): adiciones compatibles — nueva operación, campo opcional, evento publicado nuevo, error nuevo.
- **Major** (1.x → 2.0.0): rompe integradores — quitar/renombrar operaciones, campos o códigos de error, cambiar tipos, volver requerido un campo opcional, cambiar el payload de un evento existente.

Prácticas:

- El diseño vive en git; cada cambio es un commit sobre `specs/<servicio>/`, no sobre el código generado. El diseño por capas hace que cada commit toque normalmente un solo artefacto.
- Antes de un cambio major, ejecutar `/keel-docs` sobre ambas versiones y comparar los `openapi.yaml` para enumerar exactamente qué rompe.
- Los códigos de error y nombres de evento son contrato público: renombrarlos siempre es major.
- Tras cambiar el spec: `/keel-validate` → regenerar los proyectos afectados → `/keel-docs`. La documentación nunca se edita a mano.

## Código generado y ediciones manuales

El flujo asume regeneración completa: el proyecto generado se puede borrar y volver a producir desde el spec. Si un proyecto generado se editó a mano (ajustes de infraestructura, tuning), `/keel-generate` avisa antes de sobrescribir. Regla práctica: lo funcional al spec, lo puramente operativo (Dockerfile, CI, config de despliegue) puede vivir solo en el proyecto generado — y sobrevive porque el generador no lo produce.

## Añadir una tecnología nueva

Cada tecnología es un generador con paquete npm y CLI propios — `npm i -g keel-<tech>` y `keel-<tech> build specs/<servicio>` lo instalan en el workspace (los conocidos: `keel list`) —: su contrato (README), su skill de generación, sus conventions (tabla de mapeo spec → código), sus skills por tecnología del stack (`skills/`, instaladas condicionalmente en el proyecto generado) y su golden example. La receta completa para crear uno está en [building-a-generator.md](building-a-generator.md). El generador es el "template": mejora con cada generación.

## Estado actual y fases

- **Fase 1 (esta)**: metodología, DSL v2.0 multi-artefacto (schemas por capa, cross-refs en la CLI), skills, y la CLI `keel` (init/new/add/list/validate); generador `spring` como esqueleto (aún pendiente de adaptar a 2.0).
- **Fase 2**: primer servicio real (productos/catálogos) generado en Spring Boot; adaptar el generador spring al diseño por capas y poblar su `golden/`.
- **Futuro**: más generadores (nest, fastapi), publicación en npm, detección de drift entre spec y código generado, sincronización inversa.
