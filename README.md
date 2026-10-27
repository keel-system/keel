# Keel

**Diseña un servidor una vez. Genéralo en Spring Boot, NestJS o .NET.**

Keel es una metodología para construir servicios de backend con agentes: el diseño se escribe una
sola vez, sin tecnología dentro, en un DSL tipado que se valida con exit code; y un generador por
tecnología lo convierte en un servidor que compila, arranca y pasa el **100 %** de los escenarios del
diseño contra infraestructura real.

La prueba de que la promesa se cumple está en este repo. El mismo diseño (`notification-mailer`, en
su variante relacional y en la documental) se generó con los tres generadores —seis proyectos— y los
seis cerraron **23 de 23 escenarios** con el agente tocando **17 archivos de ~300** que escribió el
generador ([corridas de control](docs/corridas/), 2026-10-18).

## Qué ganas desarrollando con Keel

Cinco cosas, y cada una se comprueba con un comando desde este repo.

### 1. Eliges la tecnología al final — y puedes cambiarla

El diseño Keel no lleva ni lenguaje, ni framework, ni ORM, ni broker, ni base de datos. La tecnología
se pregunta al generar (`keel-<tech> build`) y se guarda en el proyecto generado, no en el diseño. Hoy
hay tres generadores publicados, gobernados por una sola regla: **el mismo diseño genera servidores
equivalentes**. Equivalentes quiere decir medido, no parecido:

- el **mismo contrato HTTP**: el `docs/openapi.yaml` que deriva cada generador es el mismo byte a
  byte (`keel-core/src/lib/gen/openapi.js`, comprobado en `keel-nest/test/openapi.test.js`);
- el **mismo cable**: cómo viaja cada tipo en JSON, la forma del error, la página y la envoltura son
  datos compartidos (`keel-core/src/lib/gen/wire.js`) que la prueba emitida de cada servidor ejecuta;
- los **mismos eventos y destinos**, las **mismas tablas, columnas, índices y FK**, los **mismos
  errores y mensajes**, las **mismas variables de entorno** y las **mismas series de telemetría**.

Lo que no depende del lenguaje no lo reescribe cada generador: vive una vez en el núcleo neutral
`keel-core/gen`, y un test (`gen-neutral.test.js`) impide que ahí entre el nombre de un lenguaje.

| | keel-spring | keel-nest | keel-dotnet |
|---|---|---|---|
| Plataforma | Spring Boot 3.5 · Java 21 · Gradle | NestJS 12 · Fastify · Node 22 · TypeScript strict | .NET 10 · un proyecto por capa · xUnit v3 |
| Relacional | PostgreSQL, MySQL, MariaDB, SQL Server, Oracle | PostgreSQL, MySQL | PostgreSQL, MySQL (EF Core) |
| Documental | MongoDB | MongoDB | MongoDB |
| Brokers | RabbitMQ · Kafka · SNS/SQS | RabbitMQ · Kafka · SNS/SQS | RabbitMQ · Kafka · SNS/SQS |
| Identidad | Keycloak · Cognito | Keycloak · Cognito | Keycloak · Cognito |
| Caché · storage · correo | Redis/Valkey · S3/MinIO · SMTP | Redis/Valkey · S3/MinIO · SMTP | Redis/Valkey · S3/MinIO · SMTP |
| Pagos | Stripe · MercadoPago | Stripe · MercadoPago | Stripe · MercadoPago |

Lo que un generador aún no sostiene **no lo genera a medias: lo rechaza en `build` diciendo por qué**
(`src/lib/supported-features.js` de cada uno). Los motores que faltan en NestJS y .NET faltan porque
ninguna red los ha ejecutado todavía, no porque se hayan olvidado. Y en .NET, ningún paquete con
licencia comercial: versión exacta y SPDX de cada uno en `keel-dotnet/src/lib/dotnet-stack.js`,
comprobado contra nuget.org con los transitivos.

Cambiar de stack —de PostgreSQL a MongoDB, de RabbitMQ a Kafka, de Java a TypeScript o a C#— es volver
a ejecutar `build`, no rediseñar.

### 2. Lo derivable no lo escribe un agente

Casi todo lo que hay en un servicio de backend **se deduce del diseño**: si el dominio declara un
agregado con sus invariantes y los casos de uso declaran la operación que lo toca, entonces el
controller, el DTO, el comando, el handler, el puerto, el espejo de persistencia, el mapeo de
columnas, la jerarquía de errores, la config por perfiles y la infraestructura de prueba **no son
decisiones**: son consecuencias. Pedírselas a un agente es pagar tokens, tiempo y varianza por
recalcular lo que una función calcula siempre igual.

Así que no se piden. `keel-<tech> build` genera de forma determinista **todo lo transversal al
stack** —más de 70 módulos de scaffolding en cada generador— y el proyecto compila y arranca antes de
que ningún agente lo haya visto. Al agente le queda lo que el diseño genuinamente no determina: la
lógica de negocio y la frontera que depende de la infraestructura elegida.

El proyecto lleva un manifiesto, `keel-generated.json`, que registra cada archivo que escribió
`build`; comparándolo con el árbol final se mide la **huella del agente**:

| Corrida de control (2026-10-18) | Archivos de `build` | Reescritos por el agente | Escenarios |
|---|---|---|---|
| notification-mailer · spring | 320 | 17 | 23/23 |
| notification-mailer · nest | 304 | 17 | 23/23 |
| notification-mailer · dotnet | 329 | 17 | 23/23 |
| notification-mailer-mongo · spring | 305 | 17 | 23/23 |
| notification-mailer-mongo · nest | 294 | 17 | 23/23 |
| notification-mailer-mongo · dotnet | 318 | 18 | 23/23 |

La huella es la misma en los tres lenguajes porque es la huella **del diseño**, no del stack. La
serie completa —64 corridas— la imprime `node packages/keel-spring/scripts/corrida-metrics.js series`.

**Los árbitros tampoco son agentes.** Quien puntúa los escenarios es un script
(`infra/score-scenarios.sh`, desde el XML de JUnit), y con la suite al 100 % el pipeline pasa a la
fase de calidad **sin invocar a ningún árbitro**. Un agente solo se convoca cuando algo está en rojo
y hay que decidir de quién es la culpa.

### 3. Las decisiones se toman a la vista, y antes de generar

Outbox o publicación en línea, qué operación se puede repetir sin cobrar dos veces, cuánto puede
llegar rancia una caché, qué pasa cuando el proveedor del que dependemos no responde: si nadie las
escribe, las decide el agente al teclear, y un valor decidido y uno asumido se escriben igual.

En Keel son **obligaciones con id estable** que `keel validate` deja en rojo hasta que se declaran en
el DSL o se aceptan por escrito, con su motivo, en `decisions.yaml`
([design-obligations.md](packages/keel-core/assets/core/docs/design-obligations.md)). Encima,
`keel validate --ready` compone el veredicto de «diseño listo»: validación estricta, obligaciones,
análisis de huecos, escenarios, careo de flujos y `DESIGN.md`. **`build` se niega a generar un diseño
que no esté listo**; saltárselo exige `--accept-unready`, que queda estampado en el proyecto (4 de 63
corridas lo usaron).

El humano no aprende el DSL: conversa con `/keel-design` capa a capa y revisa el resultado en el panel
`overview.html` y en `DESIGN.md`. El YAML es la interlingua entre agentes —uno diseña, otro genera,
otro valida— y su ventaja sobre un prompt es que es legible, versionable y revisable en un diff.

### 4. Los patrones difíciles vienen puestos — y medidos

Esta es la parte que no se arregla escribiendo mejores prompts. Los mecanismos de fiabilidad
distribuida comparten un rasgo: **cuando están mal, no falla nada visible**. Un relay de outbox cuyo
predicado no casa se comporta igual que un outbox vacío. Una clave de deduplicación a la que le falta
un campo descarta en silencio mensajes que nadie procesó. Una guarda que confirma después del efecto
manda un segundo correo a una persona real y responde 2xx las dos veces.

Por eso en Keel se **derivan del diseño**, los genera `build` enteros en los tres generadores, y cada
uno tiene detrás una red que se ha roto a propósito para comprobar que se pone roja.

| Mecanismo | Qué evita |
|---|---|
| **Outbox** + relay con lease, backoff, purga y rendición | publicar un evento que la transacción revirtió, o perderlo sin enterarse |
| **Idempotencia de petición** | que el reintento del cliente ejecute el cobro dos veces |
| **Deduplicación de reentrega** del broker | que la segunda entrega del mismo mensaje vuelva a aplicar el efecto |
| **Idempotencia saliente** | que *nuestro* reintento duplique el cargo en el proveedor |
| **Compensación** | trabajo encargado a un tercero que se queda hecho cuando el flujo se cae |
| **Reconciliación** | la fila que espera para siempre un desenlace que nunca llegó |
| **Reclamo de barrido** y **rescate** con cota temporal | dos réplicas procesando la misma fila, o la fila que una réplica muerta dejó a medias |
| **Guarda de efecto externo irreversible** | el segundo correo real, el segundo envío |
| **Unicidad condicionada al estado** | dos filas activas a la vez por una carrera que el handler no cierra |
| **Eventos de dominio** con envoltura y correlación end-to-end | el evento sin hecho, y la traza que se corta al salir del proceso |
| **Circuit breaker + retry** con fallback tipado | que un proveedor caído se lleve por delante el servicio |
| **Caché** con TTL y degradación a miss | servir datos rancios sin que nadie haya dicho cuánto es demasiado |
| **Seguridad**: realm aprovisionado, matriz M2M, identidad del llamante, alcance por recurso | que el llamante elija de qué inquilino lee |
| **Pagos** con pasarela, avisos verificados y conciliación | cobrar dos veces, o dar por cobrado lo que la pasarela rechazó |

Nada de esto se comprueba leyendo código: **se ejecuta**. Un JPQL que no casa con ninguna fila es
JPQL válido; un `updateOne` con el campo equivocado no falla, modifica cero documentos. La única red
que ve eso es un motor de verdad respondiendo, así que cada generador tiene sus redes en vivo contra
bases de datos, brokers, Keycloak, WireMock, Mailpit y Redis en contenedores.

**Y la disciplina que lo sostiene: medición por mutación.** Una red que nadie ha roto no distingue
«no hay errores» de «no mira». Cada generador lleva su **matriz de paridad**, celda por mecanismo y
motor, con qué red la ejecuta y si se ha falsado:

| Generador | Matriz (`npm run matrix --workspace packages/<gen>`) |
|---|---|
| keel-spring | 54 celdas · 36 verificadas contra un motor real, 33 de ellas falsadas · 12 sin ejecutar · 2 degradadas |
| keel-nest | 38 celdas · 33 verificadas · 3 degradadas · 0 pendientes |
| keel-dotnet | 34 celdas · 29 verificadas, ninguna sin falsar · 3 degradadas · 0 pendientes |

Lo que un motor **no** sostiene —la unicidad condicionada en MariaDB y en Oracle, por ejemplo— se
declara `degradado`, con la garantía que se pierde y las salidas disponibles, en vez de fingirse.

### 5. Todos los servicios salen iguales, y el diseño se reutiliza

La arquitectura del proyecto generado no la elige el agente: hexagonal + CQRS, los mismos paquetes,
los mismos nombres, la misma `infra/` de prueba, el mismo `deploy/`, el mismo `docs/keel/`. En .NET la
frontera hexagonal la impone el compilador (un proyecto por capa). Está escrita y viaja **dentro de
cada proyecto** —`constitution.md`, `architecture.md` y las conventions de su generador—, así que:

- **leer el servicio número N cuesta lo que costó leer el primero**, y quien sabe moverse por un
  servicio Keel sabe moverse por todos;
- **el proyecto es autosuficiente**: lleva el snapshot sellado del diseño, los contratos, la skill del
  generador y sus agentes, y se termina sin el workspace de diseño.

Y el diseño, al no llevar tecnología, se reutiliza en tres direcciones:

- **Entre stacks y lenguajes**: el mismo `specs/<servicio>/`, otro `build`.
- **Entre organizaciones**: los diseños se publican en **registries** —repos con forma de workspace—.
  `keel registry get <x>` **adopta** un diseño tal cual; `keel new <mío> --from registry:<x>` lo
  **deriva** con el linaje estampado. El oficial es
  [keel-system/keel-registry](https://github.com/keel-system/keel-registry)
  ([design-registry.md](packages/keel-core/assets/core/docs/design-registry.md)).
- **Hacia los proyectos ya generados**: `keel-generated.json` distingue lo que escribió `build` de lo
  que escribió el agente, así que `build --refresh --prune` propaga un arreglo del generador **sin
  pisar la lógica de negocio**, y `--check` falla en CI si un proyecto quedó atrás. Cuando lo que
  cambia es el diseño, `build` calcula el delta y escribe `EVOLUTION.md`: el pipeline trabaja solo
  sobre lo que cambió.

Un nivel por encima, `/keel-decompose` reparte un encargo en servicios y `keel system` calcula **en
qué orden se construyen** —orden topológico de las dependencias bloqueantes—, para que varias personas
diseñen en paralelo
([system-decomposition.md](packages/keel-core/assets/core/docs/system-decomposition.md)).

## Qué lo hace distinto de la SDD tradicional

[spec-kit](https://github.com/github/spec-kit) y [OpenSpec](https://github.com/fission-ai/openspec)
especifican **un cambio sobre un repositorio que ya existe**, en prosa, y su salida es un parche.
Keel especifica **un servicio entero**, tipado y sin tecnología dentro, y su salida es el servidor. No
compiten por el mismo hueco, pero la diferencia de objeto arrastra casi todo lo demás:

| | spec-kit / OpenSpec | Keel |
|---|---|---|
| Objeto de la spec | un cambio o feature sobre un repo vivo | un servicio completo, o un sistema de servicios |
| Formato | Markdown en prosa | YAML tipado, una capa por preocupación |
| Validación | estructura del documento + juicio del agente | JSON Schema + referencias cruzadas + obligaciones abiertas + `--ready`, con exit code |
| Tecnología | entra en el plan | fuera del diseño; se elige al generar |
| Salida | tareas que el agente implementa | proyecto generado: scaffolding determinista + lo que depende de la infra |
| Terminado | la checklist de tareas | suite de integración al 100 % contra infraestructura real |
| Reutilización | dentro del repo | entre stacks, **entre lenguajes** y entre organizaciones |
| Alcance | una feature | un sistema: descomposición, olas de construcción y validación cross-servicio |

**El diseño sigue siendo la fuente de verdad después de generar.** Un cambio funcional se hace en el
diseño y se regenera, nunca en el código generado. En la SDD clásica el código se edita a mano y la
especificación se sincroniza después —o se archiva—.

## Cuándo usar Keel — y cuándo no

**Sí:**
- un servicio de backend **nuevo**, que aún no tiene código;
- un encargo con **varios servicios** dentro y fronteras por decidir;
- el mismo dominio en **más de un stack o lenguaje**, o migrando de uno a otro;
- un diseño que alguien tiene que **aprobar antes** de que exista código.

**No** (y ahí spec-kit u OpenSpec encajan mejor):
- evolucionar un repositorio existente que no salió de Keel;
- frontend, scripts, trabajo exploratorio;
- un cambio de una tarde sobre algo que ya funciona.

## Empezar

### Instalación

```bash
npm i -g @keel-system/keel-core    # comando `keel`: diseñar y validar
npm i -g @keel-system/keel-spring  # comando `keel-spring`, si generas en Spring Boot
npm i -g @keel-system/keel-nest    # comando `keel-nest`, si generas en NestJS
npm i -g @keel-system/keel-dotnet  # comando `keel-dotnet`, si generas en .NET
```

El core y cada generador son paquetes independientes: el core más los generadores que vayas a usar.

| Para… | Hace falta |
|---|---|
| Diseñar (`keel init`, `/keel-design`, `keel validate`, `keel system`, `keel registry`) y **generar** (`keel-<tech> build`) | **Node.js >= 18** y nada más. Todo es offline y determinista; el registry es lo único que toca la red. |
| **Completar y validar** el proyecto generado (`/keel-generate-<tech>`) | El toolchain de la tecnología —**JDK 21** para keel-spring, **Node.js >= 22.12** para keel-nest, **SDK de .NET 10** para keel-dotnet— y un **runtime de contenedores: Docker o Podman**. |

El segundo requisito **es el precio de que «terminado» signifique algo**: la validación no usa dobles
de la fontanería, levanta la infraestructura de verdad (`infra/docker-compose.yaml`) y ejecuta contra
ella los escenarios `FL-*`. Sin contenedores el pipeline genera y compila, pero no puntúa un solo
escenario, y lo reporta como `PENDIENTE` en vez de fingir un verde. El runtime se detecta solo
—`docker` primero, `podman` si no— y se fuerza con `CONTAINER_RUNTIME=podman`.

### Uso

```bash
mkdir mi-proyecto && cd mi-proyecto
keel init                                  # siembra el workspace: skills, schemas, plantillas, docs

# ¿Ya existe un diseño que resuelva esto? Adoptarlo no cuesta nada; derivarlo, una revisión.
keel registry search catalogo
keel registry get catalog                  # lo adopta tal cual, listo para generar
keel new mi-servicio --from registry:catalog   # o lo deriva, con linaje en service.basedOn

keel new mi-servicio                       # …o de cero: specs/mi-servicio/

# En Claude Code (u opencode), dentro del workspace:
#   /keel-decompose docs/system/tdr.md     si el encargo es un SISTEMA: fronteras, mapa y briefs
#   /keel-design specs/mi-servicio         diseña capa a capa; al cerrar deriva escenarios y DESIGN.md
#   /keel-docs specs/mi-servicio           openapi.yaml, asyncapi.yaml, Postman y el panel overview.html
keel validate specs/mi-servicio --ready    # ¿listo para generar? la checklist completa del cierre

# Generar: dos pasos, con un cd en medio. <tech> es spring, nest o dotnet.
keel-<tech> check specs/mi-servicio        # opcional: no escribe nada, dice si es generable
keel-<tech> build specs/mi-servicio        # pregunta el stack y genera services/mi-servicio-<tech>/
cd services/mi-servicio-<tech>
#   /keel-generate-<tech>                  sin argumentos; completa el proyecto y valida los escenarios
```

## Cómo se genera: cinco agentes iterando

Dentro del proyecto generado, `/keel-generate-<tech>` **no escribe código**: orquesta cinco subagentes
y decide el avance sobre el bloque estructurado —`status`, `blockers`, `failures`— con el que cada uno
cierra su reporte. Los nodos **redondeados con 🤖** son sesiones de agente (cuestan contexto y tiempo);
los **rectos con ⚙** son deterministas y no cuestan nada.

```mermaid
flowchart TB
    BUILD["⚙ keel-{tech} build (en el workspace)<br/>scaffolding transversal + snapshot del diseño"]
    BUILD --> F1

    subgraph F1["/keel-generate-{tech} · fase 1 — tres agentes en paralelo"]
        CODE(["🤖 keel-{tech}-code<br/>TODOs, negocio, adaptadores del stack"])
        INFRA(["🤖 keel-{tech}-infra<br/>compose up + validate-infra.sh"])
        TESTS(["🤖 keel-{tech}-tests<br/>escenarios FL-* → pruebas, en caja negra"])
    end

    F1 --> SCORE["⚙ fase 2a — infra/score-scenarios.sh<br/>matriz FL-* → OK · FALLO · NO_EJERCITADO<br/>determinista, desde el XML de JUnit"]

    SCORE -->|"1 · hay rojo"| VALIDATE(["🤖 fase 2b — keel-{tech}-validate<br/>arbitra contra el Then original<br/>culprit: code · test · harness · design"])
    SCORE -->|"0 · matriz al 100%"| QUALITY
    SCORE -->|"2 · arnés roto · 3 · entorno bloqueado"| TESTS

    VALIDATE -->|"culprit: code"| CODE
    VALIDATE -->|"culprit: test o harness"| TESTS
    VALIDATE -->|"culprit: design o blockers"| STOP[/"Detenerse: el arreglo es del diseño,<br/>no se acomoda el código"/]

    CODE -.->|"tras el fix se vuelve SIEMPRE al script"| SCORE
    TESTS -.-> SCORE

    QUALITY(["🤖 fase 3 — keel-{tech}-quality<br/>higiene no-conductual + no-regresión<br/>+ baseline del esquema"])
    QUALITY --> CLOSE["⚙ cierre: INFORME-GENERACION.md<br/>compose down + commit"]
```

**Criterio de terminado**: el proyecto compila en verde (`./gradlew build`, `npm run build` o
`dotnet build`) y el **100 %** de los escenarios `FL-*` del diseño pasa contra la infraestructura real,
puntuado por el script y no por un juicio. El pipeline completo de cada generador —gating, handoffs,
ciclos de fix y su cupo— está en su `orchestration.md`:
[spring](packages/keel-spring/assets/generators/spring/orchestration.md) ·
[nest](packages/keel-nest/assets/generators/nest/orchestration.md) ·
[dotnet](packages/keel-dotnet/assets/generators/dotnet/orchestration.md).

## Paquetes

Monorepo npm workspaces; los cuatro paquetes están publicados en npm.

| Paquete | CLI | Qué hace |
|---|---|---|
| [`keel-core`](packages/keel-core/README.md) | `keel` | Siembra workspaces, crea, valida y describe diseños, el mapa del sistema y el registry. Define el DSL (schemas, docs, plantillas) y expone `keel-core/gen`, el núcleo neutral que comparten los generadores. |
| [`keel-spring`](packages/keel-spring/README.md) | `keel-spring` | Generador Spring Boot 3.5 / Java 21: `services/<servicio>-spring/`, con el wrapper de Gradle vendorizado. |
| [`@keel-system/keel-nest`](packages/keel-nest/README.md) | `keel-nest` | Generador NestJS 12 sobre Fastify, ESM, TypeScript strict y Vitest: `services/<servicio>-nest/`. Construido por incrementos medidos (`PLAN-KEEL-NEST.md`). |
| [`keel-dotnet`](packages/keel-dotnet/README.md) | `keel-dotnet` | Generador .NET 10, un proyecto por capa, sin librerías de licencia comercial: `services/<servicio>-dotnet/`. Construido en 16 incrementos medidos (`PLAN-KEEL-DOTNET.md`). |

El detalle de cada generador —qué genera `build`, qué deja al agente y su frontera— está en su README.

## Referencia

### Comandos

| Comando | Qué hace |
|---|---|
| `keel init [--force] [--check]` | Siembra el workspace: skills del flujo de diseño (proyectadas a cada harness), schemas, plantillas, docs y `AGENTS.md`/`CLAUDE.md`. Con `--check` falla si el payload quedó atrás respecto a la CLI instalada. |
| `keel new <servicio> [--from <origen>]` | Crea `specs/<servicio>/` desde plantillas, o lo deriva de un diseño local o `registry:<diseño>` con linaje en `service.basedOn`. |
| `keel validate <ruta> [--ready]` | Schema de cada capa + referencias cruzadas + obligaciones. Con `--ready`, la checklist completa de «diseño listo para generar». |
| `keel describe <servicio>` | Resume un diseño: identidad, capas, contenido y frescura de sus derivados. |
| `keel seals <servicio>` | Imprime los sellos del careo de flujos (`flow-review.yaml`). |
| `keel index [--check]` | Índice de diseños del workspace (`README.md` entre marcadores e `index.json`). Con `--check`, puerta de CI de un registry. |
| `keel system [show \| check]` | El mapa del sistema (`system.yaml`): olas de construcción calculadas y la única comprobación cross-servicio. |
| `keel registry [list \| search \| show \| get]` | Explora y adopta diseños del registry. Fuente con `--source` o `KEEL_REGISTRY_URL`; caché en `~/.keel/registry/`. |
| `keel list` | Los generadores conocidos y su paquete npm. |
| `keel-<tech> check <ruta>` | Pasada en seco: si el diseño es generable y qué quedará como trabajo del agente. No escribe nada. |
| `keel-<tech> build <ruta>` | Valida, exige el diseño listo, pregunta el stack y genera `services/<servicio>-<tech>/`. `--refresh --prune` propaga arreglos a un proyecto ya generado; `--check` falla si quedó atrás. Nunca escribe en el workspace de diseño. |

### El workspace sembrado

```
mi-proyecto/
├── AGENTS.md / CLAUDE.md     # el flujo, para el agente — un archivo de contexto por harness
├── README.md                 # índice de servicios diseñados (enlaza cada DESIGN.md)
├── .claude/skills/           # las ocho skills del flujo de diseño, proyectadas desde una fuente
├── .opencode/skills/         # única: keel-decompose, keel-design, keel-consume, keel-validate,
│                             # keel-docs, keel-integrate, keel-handoff, keel-evolve
├── schema/                   # un JSON Schema por capa + common.schema.json
├── system.yaml               # el mapa del sistema, si hay más de un servicio (de /keel-decompose)
├── specs/<servicio>/         # el diseño de cada servicio, un artefacto por capa — la fuente de verdad
│   ├── service.keel.yaml     #   manifiesto: identidad + capas declaradas
│   ├── domain.keel.yaml      #   entidades, types, invariantes (obligatoria)
│   ├── use-cases.keel.yaml   #   operaciones, idempotencia, caché (obligatoria)
│   └── *.keel.yaml           #   api, security, messaging, http-clients, dependencies,
│                             #   persistence, storage, mail, payments (opcionales)
├── templates/service/        # una plantilla por capa
├── contracts/<proveedor>/    # INTEGRATION.md de servidores externos de los que dependemos
├── index.json                # índice máquina de los diseños (keel index)
├── docs/                     # methodology, dsl-reference, dsl/<capa>.md, building-a-generator…
└── services/<servicio>-<tech>/  # proyectos generados por `keel-<tech> build` (un repo git cada uno)
```

El workspace es **solo diseño**: todo el conocimiento de generación vive dentro de cada proyecto generado.

### Principios

- **El diseño es la fuente de verdad.** Todo lo que un generador necesita saber está en los artefactos.
- **Ninguna decisión estructural sin respuesta.** El agente recomienda con su porqué, el humano decide,
  y lo que queda sin decidir bloquea la validación hasta que se declara o se acepta por escrito.
- **Cero tecnología en el diseño.** Lenguaje, framework, ORM, broker, proveedor de identidad o base de
  datos se deciden al generar.
- **Lo que no se sabe generar se rechaza, no se ignora.** Cada generador dice qué no sostiene y por qué.
- **Regenerable.** Cambiar de stack o de lenguaje es volver a ejecutar la generación.

## Estado y roadmap

- **DSL Keel 2.23**: once capas (dos obligatorias, nueve opcionales) con validación en tres niveles
  —JSON Schema por capa, referencias cruzadas mecánicas y revisión semántica del agente— y el veredicto
  `--ready`.
- **CLI `keel` completa**: `init`, `new`, `list`, `validate`, `describe`, `seals`, `index`, `system` y
  `registry`, más las ocho skills del flujo de diseño.
- **Tres generadores publicados** en npm —[`keel-spring`](https://www.npmjs.com/package/keel-spring),
  [`@keel-system/keel-nest`](https://www.npmjs.com/package/@keel-system/keel-nest) y
  [`keel-dotnet`](https://www.npmjs.com/package/keel-dotnet)— sobre
  [`keel-core`](https://www.npmjs.com/package/keel-core), cerrados con la corrida de control del par
  del MVP: 6 × 23/23, huella 17.
- **Verificación del propio Keel**: 292 suites de test (`npm test`), 15 fixtures de diseño —entre ellas
  pares que solo se diferencian en el modelo de persistencia— y redes en vivo por generador contra
  motores, brokers, proveedores de identidad y buzones en contenedores (ver `CLAUDE.md § Comandos`).
  64 corridas registradas en [docs/corridas](docs/corridas/).
- **Pendiente**: `keel-recover`, ingeniería inversa de un servicio existente a un diseño Keel
  (`PLAN-KEEL-RECOVER.md`); MariaDB, SQL Server y Oracle medidos en vivo en keel-nest y
  keel-dotnet; las pasarelas de pago contra su sandbox real; detección de drift entre spec y código
  generado.

## Contribuir: estructura de este repo

```
keel/
├── package.json                  # raíz privada: workspaces packages/*
└── packages/
    ├── keel-core/                # el core (Node 18+, ESM, sin build step)
    │   ├── src/cli.js            # entry (commander)
    │   ├── src/lib/              # validación, referencias cruzadas, readiness, registry, sistema
    │   ├── src/lib/gen/          # el núcleo NEUTRAL de los generadores (keel-core/gen)
    │   └── assets/               # lo que `keel init` siembra (skills, schemas, plantillas, docs)
    ├── keel-spring/              # generador Spring Boot
    ├── keel-nest/                # generador NestJS
    └── keel-dotnet/              # generador .NET
        ├── src/                  # cada uno: build, check y su scaffolding (src/scaffold, src/lib)
        └── assets/               # lo que build instala en el proyecto (skill, agentes, conventions…)
```

Los assets **son** la metodología: el DSL se documenta en
[dsl-reference.md](packages/keel-core/assets/core/docs/dsl-reference.md) y la metodología completa en
[methodology.md](packages/keel-core/assets/core/docs/methodology.md). Para crear un generador nuevo:
[building-a-generator.md](packages/keel-core/assets/core/docs/building-a-generator.md). La guía
de operación de la telemetría opcional está en [OBSERVABILIDAD.md](OBSERVABILIDAD.md).

## Autor y licencia

Keel lo diseña y mantiene **[asuridev](https://github.com/asuridev)** — el DSL, la metodología, la CLI y
los generadores.

Publicado bajo licencia [MIT](LICENSE). Si lo usas en un proyecto o construyes un generador sobre él,
la atribución se agradece; las [issues](https://github.com/keel-system/keel/issues) y las propuestas de
generador, más.
