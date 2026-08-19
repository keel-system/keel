---
name: keel-consume
description: "Diseña la integración de este servicio con otro servidor a partir de su INTEGRATION.md: entrevista qué dato ajeno necesita y qué trabajo le encarga, y escribe las capas dependencies, http-clients y messaging coherentes entre sí. Usar cuando un servicio necesite un dato que no es suyo, o necesite que otro servicio haga algo."
argument-hint: "<specs/servicio> [INTEGRATION.md del proveedor]"
---

# /keel-consume — diseñar este servicio como consumidor de otro

Simétrica de `/keel-integrate`: aquella **publica** el contrato de un servicio; esta lo **ingiere**.
El resultado es la capa `dependencies` del servicio consumidor más los canales que la sostienen,
escritos de una sola pasada y coherentes entre sí.

Se ejecuta **desde `/keel-design`** (bloque de integración, tras cerrar `use-cases`), y a mano en dos
casos: una dependencia que aparece con el diseño ya cerrado, y una versión nueva del contrato del
proveedor (modo diff).

Referencia del DSL de la capa: `docs/dsl/dependencies.md`. Tablas de decisión y de mapeo:
`references/consume-interview.md` — **léela antes de entrevistar**.

## Regla de oro

**Preguntar y declarar huecos, nunca inferir.** Puedes preguntarle al diseñador cualquier cosa y puedes
dejar constancia de lo que falta; lo que no puedes es deducir una ruta, un payload o un `messageId` de
la prosa de un documento, ni inventarlos "razonablemente". Un hueco declarado es un diseño correcto e
incompleto; un contrato inventado es un diseño incorrecto que parece completo.

## Paso 0 — resolver el contrato del proveedor

Orden de resolución:

1. La ruta pasada como argumento. Si apunta **fuera del workspace**, cópiala a
   `contracts/<proveedor>/INTEGRATION.md` y usa esa copia.
2. `contracts/<proveedor>/INTEGRATION.md` (proveedor externo ya incorporado).
3. `docs/<proveedor>/INTEGRATION.md` — el proveedor se diseñó **en este mismo workspace**. Se lee
   **en sitio, sin copiar**: es el mismo repo y duplicarlo abriría divergencia entre dos copias del
   mismo contrato. Si el archivo no existe pero sí `specs/<proveedor>/`, ofrece ejecutar
   `/keel-integrate specs/<proveedor>` para producirlo.
4. Nada de lo anterior → **modo degradado** (paso 1).

Di siempre qué archivo se usó y con qué versión.

## Paso 1 — leer el contrato

Se parte del **front-matter YAML** de `INTEGRATION.md`: `service`, `version`, `domain`, `basePath`,
`m2mAuth`, `endpoints[]`, `events.published[]`/`consumed[]`, `errors[]`. El cuerpo aporta las formas de
request/response y los payloads de cada evento. Resume al usuario en cinco líneas: qué ofrece, con qué
auth M2M, qué eventos publica, qué versión.

### Modo degradado (sin `INTEGRATION.md`, o sin front-matter)

**No te detengas.** Sáltate este paso, avisa de que se diseña sin contrato publicado y sigue:

- Pide primero el documento al dueño del proveedor (lo genera con `/keel-integrate`); es siempre la
  mejor opción y merece decirlo.
- Entrevista al diseñador sobre lo que sepa con certeza, y **solo sobre eso**.
- Deja `contract` **sin declarar** en la capa (es opcional en el schema precisamente por esto).
- **Enumera los huecos explícitamente** al cerrar: rutas, formas de request/response, payloads de los
  eventos, `messageId`, `discriminator`, `tokenUrl`, códigos de error del proveedor. Cada hueco lleva a
  quién hay que pedírselo.
- La capa `dependencies` se declara igual: de quién dependemos y con qué estrategia es verdad sobre el
  servicio aunque el contrato no esté publicado.

En modo degradado, **una lista de huecos vacía es señal de que algo se inventó**. Revísalo.

## Paso 2 — inventario, con las dos preguntas

Antes de tocar YAML, y en lenguaje de negocio. Recorre las operaciones de `use-cases` del servicio
propio y hazle a cada una **las dos preguntas**, porque hay dos formas de depender de otro servicio:

1. **¿Qué dato que no es nuestro necesita esta operación para decidir?** → sale un `need`, con su `usedBy`.
2. **¿Qué parte de esta operación no es responsabilidad nuestra y se la pedimos a otro?** → sale una
   `activation`, con su `triggeredBy`.

**Nunca al revés**: empezar por los endpoints que el proveedor ofrece produce clientes HTTP que ninguna
operación usa (y `keel validate` te avisará de ello).

El corte entre las dos, en una frase: **¿me llevo un dato suyo, o le dejo un trabajo?** Un `need` es un
dato ("el precio vigente del producto"); una `activation` es un trabajo ("que mande el correo de
confirmación"). No es una distinción de estilo: al leer, el proveedor no sabe que existimos; al
activarlo, **nosotros** nos acoplamos a su firma de entrada, y eso es lo que hay que declarar. Si una
llamada saliente es un `POST` que cambia estado en el otro y no devuelve un dato que usemos para
decidir, es una activación, no un `need` con `strategy: on-demand`.

Un mismo proveedor puede aparecer de las dos formas: un solo bloque con `needs` y `activations`.

## Paso 3a — entrevista de estrategia, por need

El núcleo de la skill. **Usa `AskUserQuestion`; no decidas por tu cuenta**: la estrategia cambia lo que
el servicio puede prometer a sus clientes, y eso es del diseñador.

Tres ejes (tabla de decisión completa en `references/consume-interview.md`):

1. **Corrección** — ¿la decisión exige el valor vigente en ese instante, o vale una copia reciente?
2. **Disponibilidad** — ¿puede este servicio seguir operando con el proveedor caído, y con qué
   consecuencia de negocio?
3. **Volumen** — ¿es una consulta por petición, o un listado que exigiría N llamadas?

Y una cuarta pregunta que no es de estrategia pero se cierra aquí, porque cambia el **contrato
público**: **¿el dato además sale en la respuesta?** (`exposedAs`). El default —no exponerlo— es lo
correcto casi siempre, pero se pregunta igual en vez de asumirlo: un dato ajeno en nuestra salida
acopla nuestro contrato al del proveedor, y viaja con la **forma entera** del origen (un objeto, no un
escalar). Si además la operación devuelve varios elementos, la respuesta vuelve al eje **Volumen**.
Trampas en `references/consume-interview.md § 1b`.

Si sale `replicated`, segunda ronda:

- **`freshness`** — tolerancia a leer un dato viejo, en prosa. Si el diseñador da un número, tradúcelo a
  la frase de negocio que hay detrás; el umbral cuantificado es del generador.
- **`fedBy`** — ¿qué eventos del proveedor cubren **todas** las vías de cambio? Pregunta explícitamente
  por **bajas y retiradas**: es el olvido más común y deja la copia rancia para siempre.
- **`onMiss`** — qué pasa cuando la copia aún no tiene el dato. Con `fail`, qué error ve el cliente;
  con `degrade`, qué resultado exactamente.
- **Qué campos** se copian: solo los que alguna operación de `usedBy` lee.

## Paso 3b — entrevista de encargo, por activación

También con `AskUserQuestion`, y por el mismo motivo: qué pasa cuando el trabajo delegado no se hace es
una promesa al cliente, no un detalle técnico.

1. **`effect`** — ¿qué hace exactamente el proveedor al recibirlo? En lenguaje de negocio, y **sacado de
   su `INTEGRATION.md`, no supuesto**. Si no está claro qué provoca la llamada, no está claro el encargo.
2. **`awaits`** — ¿esta operación necesita **el resultado** del trabajo para continuar (`outcome`), le
   basta con que el proveedor lo aceptara (`acknowledgement`), o lo delega y sigue (`nothing`)? Pregúntalo
   así, en consecuencias: con `acknowledgement` o `nothing`, el trabajo **puede no llegar a hacerse** y
   la operación propia habrá respondido que todo fue bien. ¿Es aceptable?
3. **Desenlace diferido** — si la respuesta al punto 2 es «necesito enterarme, pero el proveedor no
   puede contestar en el acto», la salida **no** es subir a `outcome`: es la tercera forma de encargar.
   Se publica el encargo, la entidad queda en un **estado de espera** y el desenlace llega por un evento
   de resultado al que nos suscribimos. `awaits` sigue siendo `acknowledgement` —la operación propia sí
   terminó—. Pregunta entonces por dónde llega ese desenlace, y por el estado en el que la entidad se
   queda mientras tanto.

   Ojo con el error contrario: **el estado de espera no lo crea el evento, lo crea necesitar el
   desenlace.** Un encargo `awaits: nothing` no lleva estado intermedio; ponérselo fabrica una espera
   que el negocio no tiene y de la que nadie va a sacar a la entidad.

   Si hay desenlace diferido, son **cuatro declaraciones acopladas** (detalle en
   `references/consume-interview.md § Desenlace diferido`): el estado en `domain: lifecycle` con sus
   aristas de salida y la `transitions` de la operación que encarga; **la marca de cuándo empezó a
   esperar**, un campo propio que estampa esa operación —`createdAt` y `updatedAt` no valen, y el porqué
   está en la referencia—; la operación `internal` que aplica el desenlace bueno, disparada por la
   suscripción al evento de resultado; y `reconciledBy` con una operación `schedule` que barra lo que
   lleve demasiado tiempo esperando. Sin la tercera has construido
   un sitio donde las cosas se quedan atascadas para siempre sin producir ningún error. Y avisa de que
   ese estado es **contrato público**: la operación deja de poder prometer «confirmado» en su respuesta.
4. **`via`** — el canal se deduce de lo anterior, no se elige por gusto: `outcome` exige una llamada de
   `http-clients`; un encargo que se delega —con desenlace diferido o sin él— va por un evento propio
   (`{ publishes: <Evento> }`).
5. **`onFailure`** (solo con `via` HTTP) — `fail` con qué error visible, `degrade` con qué resultado
   exacto, o `ignore`. Cuidado con `ignore`: solo es honesto si el negocio de verdad no cuenta con ese
   trabajo; si alguien lo va a echar de menos, es `fail` o `degrade`.
6. **`contract.version`** — con más razón que al leer. Una activación nos acopla al contrato de
   **entrada** del proveedor, y un campo nuevo obligatorio en su firma nos rompe sin que toquemos nada.

**Si la activación va por evento**, hay un compromiso del otro lado que hay que verificar, no suponer:
su diseño tiene que declarar ese evento en `messaging: subscriptions.<Evento>` con `nature: request`. Si
en su `INTEGRATION.md` §Suscripciones no aparece, no está aceptando el encargo: publicar el evento y
esperar que actúe es una integración que nadie ha acordado. Decláralo como hueco y di a quién pedírselo.

## Paso 4 — escritura coherente, en una pasada

Los artefactos se tocan **juntos o quedan incoherentes**; esta es la razón de ser de la skill. Escríbelos
en orden de capa y valida con `keel validate --wip` sobre la marcha.

| Artefacto | Qué escribir |
|---|---|
| `domain` | La entidad de la copia, con **solo los campos que este servicio lee**, `unique: true` en el `keyField`, y una `description` que diga que es una proyección de `<proveedor>` y **no fuente de verdad**. Nunca copies el agregado ajeno entero. **Con desenlace diferido**, además: el **estado de espera** en el `lifecycle` de la entidad que queda esperando, con sus aristas de salida (confirmación, rechazo, rendición del barrido), y la **marca temporal** de cuándo entró en él (un campo propio, no `createdAt` ni `updatedAt`), normalmente fuera del contrato con `exclude`. |
| `use-cases` | La **operación de proyección** (`internal: true`, p. ej. `applyProductSnapshot`) que la suscripción dispara — una réplica la exige, porque `subscriptions.triggers` es obligatorio. Y los `errors` nuevos que exige `onMiss.action: fail`, en **cada** operación de `usedBy`. **Con desenlace diferido**, además: la `transitions` que mete la entidad en la espera, la operación `internal` que **aplica el desenlace** (p. ej. `applyStockReserved`) y la operación con `schedule` que barre. |
| `http-clients` | `clients.<proveedor>` con `purpose`, `auth` derivado de `m2mAuth` (`client-credentials` → `oauth2-client-credentials`; **si el front-matter no da `tokenUrl`, pregúntalo**, el schema lo exige), y una `calls.<name>` por endpoint que se use, con `contract` en prosa + `method`/`path` del front-matter + `request`/`response` tipados del cuerpo. `timeoutMs`, `retry`, `circuitBreaker` y `fallback` se **entrevistan**, nunca se ponen por defecto. |
| `messaging` (entrada) | El canal con `external: true`, y una `subscriptions.<Evento>` por cada evento de `fedBy`, por cada compensación y —con desenlace diferido— por el **evento de resultado** del encargo: `source` = nombre del proveedor, `contract` (`envelope: keel` si el proveedor es un servicio Keel), `payload`, `triggers` y `onFailure`. |
| `messaging` (salida) | Con una activación por evento: el `publishing.events.<Evento>` que se emite, **con el payload que exige el proveedor** — lo copias de su `INTEGRATION.md` §Suscripciones, campo a campo; su firma la fija él, no nosotros. |
| `persistence` | La entidad de la copia en `entities`, con índice por `keyField`. |
| `dependencies` + manifiesto | La capa entera (síntesis de todo lo anterior: `needs` y `activations`) y `layers.dependencies` en `service.keel.yaml`. |
| `security` | **Nada** — y dilo al usuario: `serviceClients` cataloga a quien nos consume a nosotros; como consumidores no aportamos scopes propios. |

## Paso 5 — cierre

1. `keel validate specs/<servicio>` (sin `--wip` si el resto del diseño está cerrado; con `--wip` si
   `/keel-consume` se ejecutó a mitad de `/keel-design`).
2. Resume lo escrito: dependencias, needs con su estrategia, activaciones con su `awaits`, y qué capas
   se tocaron.
3. **Lista de huecos**, cada uno con a quién pedírselo.
4. Si el workspace tiene `system.yaml`, avisa de qué aristas hay que añadirle: los proveedores nuevos de
   los que se **lee** van a `consumes` del servicio, y aquellos a los que se les **encarga** trabajo van
   a `invokes`. `keel system check` lo reportará si no; y una activación apuntada como `consumes` del
   proveedor hacia nosotros invierte el orden de construcción.
5. Sugiere el barrido de las clases 7 y 8 de `keel-design/references/gap-analysis.md` sobre lo escrito.

## Modo diff — el proveedor publica una versión nueva

Cuando ya existe `dependencies.<proveedor>.contract.version`: compara el front-matter del contrato nuevo
con la versión declarada y **presenta qué cambió antes de tocar nada** — endpoints añadidos/eliminados/
con la forma cambiada, eventos nuevos o retirados, códigos de error nuevos, cambios de auth. Solo
después, y con aprobación explícita, aplica los cambios y sube `contract.version`.

Un evento que el proveedor **deja de publicar** y que alguna réplica declaraba en `fedBy` es un
hallazgo grave, no una línea a borrar: esa copia se queda sin una de sus vías de puesta al día.

## Prohibiciones

- Escribir credenciales, secretos o URLs de entorno en el diseño. Solo el mecanismo.
- Copiar el modelo de datos completo del proveedor.
- Declarar `strategy: replicated` sin capa `persistence`.
- Inventar rutas, payloads, `messageId` o `discriminator`.
- Declarar una llamada HTTP que ninguna operación usa, o una suscripción que no alimenta ninguna réplica
  ni dispara nada.
- **Declarar como `need` lo que es una activación** — un `strategy: on-demand` cuyo `fetchedFrom` apunta
  a una llamada que no devuelve ningún dato que se use para decidir. Valida, y miente: dice que el dato
  vive en el proveedor cuando lo que vive allí es el trabajo, y deja el acoplamiento fuera del mapa.
- Inventar el payload de un evento de activación. Su firma la fija el proveedor, y sale de su
  `INTEGRATION.md` §Suscripciones o no sale.
- Tocar `security` para añadirnos como cliente de nosotros mismos.
