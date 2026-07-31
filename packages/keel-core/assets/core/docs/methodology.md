# Metodología Keel

Cómo humanos y agentes colaboran para diseñar un servicio una vez y generarlo en cualquier tecnología.

## El ciclo

El corazón del método es una **fase de diseño iterativa** que se cierra una sola vez; **la generación de código es el paso final** que consume ese diseño ya cerrado. Diseñar y validar no son dos etapas de un pipeline: forman un bucle que se repite capa a capa hasta que el diseño está completo y en verde.

```
   ¿el encargo es un sistema o un servicio?
        │  (un TDR, varios dominios)
        └──sistema──> /keel-decompose ──> system.yaml + SYSTEM.md + un brief por servicio
                            │             (y `keel system` da el orden de construcción)
                            ▼
                      por cada servicio, en el orden de las olas:
                                                     │
   ¿existe ya un diseño que sirva?
        │  (keel registry search)
        ├──tal cual──> adoptarlo (keel registry get) ───────────────────────────────┐
        ├──casi──────> derivarlo (--from registry:<diseño>) ──>┐   ya viene cerrado,  │
        └──no────────> empezar de cero ───────────────────────>┤   con sus derivados  │
                                                               ▼                      │
        ┌──────────── fase de diseño (itera hasta cerrar) ───────────┐                │
        │   diseñar ⇄ validar  ──cierre──>  documentar el diseño      │                │
        │   (capa a capa)                   (DESIGN.md + README +      │                │
        │                                    validation-scenarios)     │                │
        └────────────────────────────┬───────────────────────────────┘                │
                                      │  diseño cerrado (validación en verde)          │
                                      │<─────────────────────────────────────────────┘
                                      ▼
                     ┌──────── derivaciones del spec ────────┐
                     │   generar código        (paso final)  │
                     │   documentar integradores (opcional)  │
                     └───────────────────┬───────────────────┘
                                         │
        /keel-evolve: cambia el spec     └──> vuelve al diseño, versiona y regenera
                                                (spec + TODOS sus derivados)
```

**Antes del ciclo, si el encargo es un sistema y no un servicio: descomponerlo** (`/keel-decompose`). Todo el ciclo que sigue tiene grano de **un servicio** — `/keel-design` parte de un servicio ya nombrado. Cuando lo que llega es un encargo completo (un TDR: "una plataforma de venta de billetes"), falta decidir antes cuántos servicios hay, dónde está la frontera de cada uno, quién consume a quién y **en qué orden se construyen**; y esa decisión no cabe en el DSL, que describe un servicio. `/keel-decompose` entrevista el documento de requisitos y dibuja las fronteras aplicando el mismo reparto de la palabra que el diseño —una frontera la **recomienda** el agente y la **decide** el humano, porque cambia qué puede prometer cada servicio y quién puede desplegar sin pedir permiso—, y produce tres cosas: `system.yaml` (el mapa, declarativo y verificable), `docs/system/SYSTEM.md` (la decisión y su porqué, incluidos los cortes descartados y lo que queda fuera de alcance) y un `docs/system/briefs/<servicio>.md` por servicio, que es el **encargo** con el que otra persona entra al ciclo sin releer el TDR (`/keel-design` lo detecta y arranca desde él, confirmando en vez de asumir). El orden lo calcula `keel system` como orden topológico de las aristas **bloqueantes**: quien publica contrato va antes que quien lo consume, porque el paso 1 del ciclo pide el `INTEGRATION.md` del proveedor y `/keel-consume` degrada sin él. Y `keel system check` es la **única comprobación cross-servicio** del método —`keel validate` no ve más allá de un servicio— porque llega a cruzar dos specs: que el proveedor publique de verdad, en su capa `messaging`, el evento que el mapa promete a su consumidor. Un encargo con una sola fuente de verdad no necesita esta fase. Detalle en [system-decomposition.md](system-decomposition.md).

0. **Buscar antes de diseñar** (`keel registry`) — el paso más barato del ciclo es el que evita recorrerlo. Un diseño desde cero cuesta una sesión de entrevista capa a capa; uno derivado de otro que ya resuelve el problema cuesta una revisión de lo que cambia; uno que sirve tal cual no cuesta nada. Antes de arrancar, `keel registry search <dominio>` busca en el registry de diseños publicados y `keel registry show <diseño>` da su ficha —capas, contenido, enlaces a su `DESIGN.md` y su panel— para evaluarlo **sin descargarlo**.

   Según encaje, hay **dos salidas y son distintas**: si el diseño te sirve **tal cual**, `keel registry get <diseño>` lo adopta sin tocarlo —mismo nombre, misma versión, y sus derivados publicados al día en `docs/<diseño>/`—, así que **te saltas la fase de diseño entera** y vas directo a generar (paso 4); si hay que **cambiarlo**, el paso 1 lo deriva con `--from registry:<diseño>`, que trae solo el spec, y `/keel-design` arranca en modo derivación. Derivar para acabar usándolo sin cambios es el camino caro: obliga a regenerar a mano artefactos que ya existían y ya estaban validados.

   Un registry es un repositorio git con la forma de un workspace Keel, así que una organización puede tener el suyo (`KEEL_REGISTRY_URL`) con sus diseños internos y el mecanismo es el mismo. Detalle en [design-registry.md](design-registry.md).
1. **Diseñar** (`/keel-design`) — el agente entrevista al humano sobre el dominio y construye el diseño **capa a capa** (ver "Diseño por capas" más abajo): cada capa es un artefacto YAML propio que el humano aprueba, y **cierra validándose** (`keel validate --wip`, ver paso 2) antes de pasar a la siguiente, revisable en un diff pequeño. Diseñar y validar son el mismo bucle, no fases separadas: se itera hasta que el diseño completo pasa en verde. El **cierre** tiene dos partes. Primero un **análisis de huecos**: con la validación en verde, el agente interroga el diseño buscando lo que **no dice** —estados inalcanzables, errores sin guarda que los dispare, colecciones sin orden, borrados sin política de cascada—, huecos que ninguna regla mecánica puede echar de menos porque no rompen ninguna referencia, y que acabaría decidiendo por su cuenta el agente que genere el código; cada hallazgo se cierra con una decisión del humano que se materializa en los artefactos. El barrido parte de un inventario de las unidades a recorrer y reporta **su cobertura** además de sus hallazgos: sin esa tabla, una clase de huecos que se recorrió y salió limpia es indistinguible de una que nadie miró. Después produce `specs/<servicio>/validation-scenarios.md` (formato: [validation-scenarios.md](validation-scenarios.md)): escenarios Given/When/Then que cubren toda operación y todo error declarado. Ese archivo es el **contrato de equivalencia entre implementaciones**: del mismo diseño se generan servidores en stacks distintos, y es lo único que garantiza que se comporten igual — lo que un escenario no fija (el orden de una lista, el formato de una fecha, el status de un error) lo decide cada generador por su cuenta. Como paso final del cierre, el agente ejecuta automáticamente `/keel-handoff` para derivar `docs/<servicio>/DESIGN.md` (capturando en el momento el porqué de las decisiones) y actualizar el índice de servicios del `README.md` del workspace. Esta es **documentación de diseño**: queda lista al cerrar, **antes de generar nada**, de modo que el diseño sea visible y reutilizable por otros equipos apenas se termina.
2. **Validar** (`/keel-validate`) — es el **bucle y el gate del diseño**, no una etapa posterior. Durante la iteración se valida el progreso con `keel validate --wip` (las capas aún en plantilla y las referencias hacia delante son avisos, no errores); el **cierre** exige `keel validate` sin `--wip` en verde. Tres niveles: JSON Schema por artefacto + referencias cruzadas mecánicas (ambos vía `keel validate specs/<servicio>`) y revisión semántica del agente (reglas ambiguas, errores faltantes, mínimo privilegio). La CLI detecta **diseño incompleto**: capas que siguen siendo la plantilla y descriptions placeholder (empiezan por `TODO:`, la convención que siembran las plantillas). Esa validación completa en verde es lo que **autoriza a generar**: nada se genera desde un diseño inválido o en progreso.
3. **Generar** — **el paso final**, que se ejecuta una vez el diseño está cerrado (validación completa en verde + `validation-scenarios.md`); nunca sobre un diseño en iteración. Son siempre **dos pasos con cambio de directorio en medio**, y el cambio de directorio es lo que separa las dos mitades del trabajo:
   1. **`keel-<tech> build specs/<servicio>`, desde el workspace de diseño.** Cada generador es un paquete npm con CLI propia (ej. `keel-spring build specs/<servicio>`). El comando revalida el diseño, **pregunta el stack al diseñador** —es una decisión humana que ninguna heurística puede tomar: BD, broker, proveedor de auth, caché, storage, solo lo que el diseño necesita— y lo persiste en `keel-stack.json`. Con esa respuesta genera de forma determinista el **scaffolding transversal al stack**: todo lo necesario para levantar el proyecto (dependencias, config por perfiles, infraestructura de prueba) más la estructura cuyo código no depende de la opción de infra concreta. Y deja el proyecto como **repo autosuficiente**: su `.claude/` trae la skill de generación del generador, los agentes, las convenciones y las guías por tecnología del stack elegido, más un snapshot del diseño en `specs/`.
   2. **`cd services/<servicio>-<tech>` y, dentro del proyecto, `/keel-generate-<tech>` (sin argumentos).** Ahí el agente escribe el código que sí depende de la infra elegida y la lógica de negocio, y verifica arrancando el servidor generado y ejecutando contra él los escenarios de `validation-scenarios.md` con llamadas reales.

   El workspace de diseño **no recibe nada del generador**: todo el conocimiento de generación vive dentro del proyecto que produce, y por eso quien clone ese repo puede terminar la generación sin el workspace.
4. **Documentar** — conviene distinguir **dos clases** de documentación, que se producen en momentos distintos:
   - **Documentación de diseño** — `docs/<servicio>/DESIGN.md` (características del dominio + decisiones de diseño con su porqué, para que **otro equipo reutilice el diseño** sin leer el código) y el índice del `README.md`. Se generan **al cerrar el diseño** (paso 1), antes de generar código; `/keel-handoff` los **regenera** cuando el spec cambia (re-deriva lo mecánico y preserva el porqué ya capturado).
   - **Documentación de integradores** — se deriva del mismo spec cuando alguien va a consumir el servicio, tras el cierre e **independiente de que se haya generado código**: `/keel-docs` produce los **contratos formales** de las dos superficies (`openapi.yaml` para HTTP y `asyncapi.yaml` —AsyncAPI 3.0.0— para los eventos, si hay capa `messaging`), las colecciones Postman (`postman/`) para ejercitar la API y `overview.html`, el **panel visual del servicio** con el que el diseñador revisa de un vistazo qué infraestructura exige (persistencia, broker, outbox, caché) y qué hace cada caso de uso, con visores para renderizar ambos contratos; `/keel-integrate` produce `INTEGRATION.md`, el **contrato servidor-a-servidor en prosa** (cómo obtener el token M2M, qué reintentar, qué publicar para activar una operación) para que **otro servidor** lo consuma.
   - El ciclo se cierra en el otro extremo: el diseñador del servicio consumidor le pasa ese `INTEGRATION.md` a **`/keel-consume`**, que entrevista la estrategia de cada dato que necesita y escribe sus capas `dependencies` + `http-clients` + `messaging` coherentes entre sí. `/keel-integrate` publica el contrato; `/keel-consume` lo ingiere. Por eso el front-matter YAML de `INTEGRATION.md` no es decorativo: es la entrada machine-readable del consumidor.

La regla que sostiene todo: **si un cambio es funcional, se hace en el spec y se regenera; nunca directamente en el código generado.** El código y la documentación son derivados; el spec es la fuente de verdad.

Y la regla que gobierna el reparto de la palabra dentro del diseño: **el agente recomienda, el diseñador decide el comportamiento estructural.** Hay una clase de decisiones —qué se pierde ante un fallo (outbox), qué se puede repetir sin daño (idempotencia), qué puede llegar rancio (caché), quién consume el contrato (superficie M2M), qué transacción envuelve qué, cómo se degrada una dependencia caída— que no son preguntas técnicas: cambian lo que el servicio puede **prometer** a sus clientes y el coste de operarlo. El agente conoce el mecanismo y propone siempre una opción concreta con su porqué; el humano conoce el negocio que lo paga y tiene la última palabra, en el momento de diseñar la capa. Ninguna se escribe en silencio, ni siquiera cuando la respuesta parece obvia: un default tácito es una decisión que tomó el agente sin decirlo, y el análisis de huecos la caza precisamente por eso — contra el registro de decisiones con el que cierra cada capa, no contra la memoria de la sesión: un valor decidido y uno asumido se escriben igual en el YAML. El catálogo con los ejes de decisión de cada una vive en `.claude/skills/keel-design/references/structural-decisions.md`.

El versionado sigue la misma separación: el repo del workspace versiona solo el diseño (`specs/`, schemas, docs) — el `.gitignore` sembrado por `keel init` excluye `services/` — y cada servicio generado vive en su propio repo git dentro de `services/<servicio>-<tech>/`, con su ciclo de vida independiente.

## Diseño por capas

Desde keel 2.0 el diseño de un servicio no es un archivo monolítico sino un directorio `specs/<servicio>/` de artefactos relacionados por nombre. Cada capa se itera y aprueba por separado con el humano; el manifiesto `service.keel.yaml` declara cuáles existen.

```
service (manifiesto)
   └── domain ──> use-cases ──> api ──────────┐
                     │            └──> security
                     ├──> messaging
                     ├──> http-clients
                     ├──> dependencies
                     ├──> persistence
                     └──> storage
```

- **Obligatorias**: `domain` (entidades, invariantes) y `use-cases` (operaciones).
- **Opcionales**: `api`, `security`, `messaging`, `http-clients`, `dependencies`, `persistence`, `storage` — se declaran solo si aplican. Un worker sin API no tiene `api`; un servicio sin estado no tiene `persistence`; uno que no maneja archivos no tiene `storage`; uno que se basta a sí mismo no tiene `dependencies`.
- La capa `api` distingue el público de cada endpoint (`audience`: usuarios web/mobile, otros servicios M2M, o ambos) y `security` modela a los consumidores máquina (`serviceAuth`, `serviceClients`, `level: service` con scopes); ver `dsl/api.md` y `dsl/security.md`.
- La capa `dependencies` declara de qué **otros servidores** depende este: qué dato necesita de cada uno, qué caso de uso lo usa, si lo lee bajo demanda o mantiene una copia local, y qué hace cuando le falta. Es una capa de síntesis — solo referencia a `http-clients`, `messaging`, `domain` y `use-cases`, nunca las redeclara. La escribe `/keel-consume` a partir del `INTEGRATION.md` del proveedor; ver `dsl/dependencies.md`.
- Orden de diseño: **domain → use-cases → dependencies → api → security → messaging → http-clients → persistence → storage**. `dependencies` se diseña pronto (en cuanto se sabe qué dato ajeno hace falta) aunque se valide la última, y `/keel-consume` escribe de una pasada todas las capas que toca. Hay dos referencias hacia delante: `emits` (use-cases nombra eventos que se definen al llegar a messaging) y los campos `file` del domain (que nombran buckets definidos al llegar a storage); mientras la capa destino no exista, `keel validate --wip` las reporta como pendientes en vez de error.
- Cada capa se cierra con `keel validate --wip specs/<servicio>` (las capas aún en plantilla son avisos, no errores); el diseño completo se cierra con `keel validate` sin flag, en verde, más el análisis de huecos cerrado y `validation-scenarios.md` con su matriz de cobertura completa.
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
| `integrations` que expresan **dependencia de otro servidor** | `dependencies.keel.yaml` (el porqué y la estrategia) + `http-clients`/`messaging` como canales |
| `integrations` kind `storage` (BD) | `persistence.keel.yaml` |
| `integrations` kind `storage` (archivos/blobs) | `storage.keel.yaml` (buckets) + campos `file` en `domain.keel.yaml` |

## División de responsabilidades

| | Humano | Agente |
|---|---|---|
| Descomposición | **Última palabra**: dónde está la frontera de cada servicio y qué se queda fuera del alcance | Extrae capacidades y conceptos del encargo, recomienda una partición con su consecuencia observable, calcula el orden y redacta los briefs |
| Diseño | Conoce el dominio, decide qué hace el servicio, aprueba secciones | Pregunta, propone el spec, fuerza los casos incómodos (errores, estados) |
| Comportamiento estructural | **Última palabra**: outbox, idempotencia, caché, superficie M2M, política de fallo, resiliencia, frontera transaccional, concurrencia | Recomienda una opción concreta con su porqué y su consecuencia observable; nunca la escribe sin respuesta |
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
- Antes de un cambio major, ejecutar `/keel-docs` y `/keel-integrate` sobre ambas versiones y comparar los `openapi.yaml` (contrato HTTP), los `asyncapi.yaml` (contrato de eventos) y los `INTEGRATION.md` (contrato servidor-a-servidor) para enumerar exactamente qué rompe.
- Los códigos de error y nombres de evento son contrato público: renombrarlos siempre es major.
- **Un diseño cerrado se cambia con `/keel-evolve`**, no reentrando a mano por cada skill. La documentación nunca se edita a mano.

### La cascada: el spec no es lo único que cambia

Del spec nacen siete derivados —`validation-scenarios.md`, `DESIGN.md`, `openapi.yaml`, `asyncapi.yaml`, las colecciones Postman, `overview.html` e `INTEGRATION.md`— repartidos entre cuatro skills. Cambiar el spec y olvidar uno no deja el diseño «a medias»: deja un artefacto que **miente**, y en el caso de `INTEGRATION.md` deja a otro equipo integrándose contra un contrato que ya no existe.

Por eso la evolución es una skill propia y no una nota al pie. **`/keel-evolve`** traduce el cambio a capas afectadas antes de editar, itera solo esas con `/keel-design` (reabriendo las decisiones estructurales que el cambio toca, en vez de heredarlas en silencio), clasifica el salto de versión con el diseñador según la tabla de arriba, reejecuta el análisis de huecos sobre lo tocado y **regenera en cascada** los derivados que existían, en orden: escenarios → `/keel-handoff` → `/keel-docs` → `/keel-integrate`.

Lo que hace verificable esa cascada es que **cada derivado lleva estampado el `service.version` del que nació** (`info.version` en los contratos formales, la variable `keelVersion` en Postman, un comentario `keel:version` en el panel y los visores, la línea `> specs/<servicio> v<versión>` en los dos markdown derivados, el front-matter en `INTEGRATION.md`). `keel describe <servicio>` compara cada sello con el manifiesto y reporta los que quedaron atrás, los que nunca se generaron y los que **sobran** (un `asyncapi.yaml` que sobrevivió a la retirada de la capa `messaging`). Es la única comprobación mecánica de frescura del método: el resto —qué regenerar y en qué orden— lo decide la skill.

## Código generado y ediciones manuales

El flujo asume regeneración completa: el proyecto generado se puede borrar y volver a producir desde el spec. Re-ejecutar `keel-<tech> build` sobre un proyecto ya existente es **seguro**: solo añade archivos nuevos y nunca pisa lo que el agente implementó; sobrescribir todo lo generado exige `--force` explícito. Regla práctica: lo funcional al spec, lo puramente operativo (Dockerfile, CI, config de despliegue) puede vivir solo en el proyecto generado — y sobrevive porque el generador no lo produce.

## Añadir una tecnología nueva

Cada tecnología es un generador con paquete npm y CLI propios — `npm i -g keel-<tech>`, y `keel-<tech> build specs/<servicio>` genera el proyecto (los conocidos: `keel list`) —: su contrato (README), su skill de generación, sus conventions (tabla de mapeo spec → código) y sus skills por tecnología del stack (instaladas condicionalmente en el proyecto generado según `keel-stack.json`). Todo eso se instala en el `.claude/` del proyecto generado, nunca en el workspace de diseño. La receta completa para crear uno está en [building-a-generator.md](building-a-generator.md). El generador es el "template": mejora con cada generación.
