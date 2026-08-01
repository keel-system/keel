---
name: keel-consume
description: "Diseña la integración de este servicio como consumidor de otro servidor a partir de su INTEGRATION.md: entrevista la estrategia de cada dato ajeno que necesita y escribe las capas dependencies, http-clients y messaging coherentes entre sí. Usar cuando un servicio necesite un dato que no es suyo."
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

## Paso 2 — inventario de necesidades

Antes de tocar YAML, y en lenguaje de negocio. Recorre las operaciones de `use-cases` del servicio
propio y pregunta, una a una: **¿qué dato que no es nuestro necesita esta operación para decidir?**

Sale la lista de `needs`, cada uno con su `usedBy`. **Nunca al revés**: empezar por los endpoints que el
proveedor ofrece produce clientes HTTP que ninguna operación usa (y `keel validate` te avisará de ello).

Un `need` es un dato ("el precio vigente del producto"), no un endpoint ni un evento.

## Paso 3 — entrevista de estrategia, por need

El núcleo de la skill. **Usa `AskUserQuestion`; no decidas por tu cuenta**: la estrategia cambia lo que
el servicio puede prometer a sus clientes, y eso es del diseñador.

Tres ejes (tabla de decisión completa en `references/consume-interview.md`):

1. **Corrección** — ¿la decisión exige el valor vigente en ese instante, o vale una copia reciente?
2. **Disponibilidad** — ¿puede este servicio seguir operando con el proveedor caído, y con qué
   consecuencia de negocio?
3. **Volumen** — ¿es una consulta por petición, o un listado que exigiría N llamadas?

Si sale `replicated`, segunda ronda:

- **`freshness`** — tolerancia a leer un dato viejo, en prosa. Si el diseñador da un número, tradúcelo a
  la frase de negocio que hay detrás; el umbral cuantificado es del generador.
- **`fedBy`** — ¿qué eventos del proveedor cubren **todas** las vías de cambio? Pregunta explícitamente
  por **bajas y retiradas**: es el olvido más común y deja la copia rancia para siempre.
- **`onMiss`** — qué pasa cuando la copia aún no tiene el dato. Con `fail`, qué error ve el cliente;
  con `degrade`, qué resultado exactamente.
- **Qué campos** se copian: solo los que alguna operación de `usedBy` lee.

## Paso 4 — escritura coherente, en una pasada

Los artefactos se tocan **juntos o quedan incoherentes**; esta es la razón de ser de la skill. Escríbelos
en orden de capa y valida con `keel validate --wip` sobre la marcha.

| Artefacto | Qué escribir |
|---|---|
| `domain` | La entidad de la copia, con **solo los campos que este servicio lee**, `unique: true` en el `keyField`, y una `description` que diga que es una proyección de `<proveedor>` y **no fuente de verdad**. Nunca copies el agregado ajeno entero. |
| `use-cases` | La **operación de proyección** (`internal: true`, p. ej. `applyProductSnapshot`) que la suscripción dispara — una réplica la exige, porque `subscriptions.triggers` es obligatorio. Y los `errors` nuevos que exige `onMiss.action: fail`, en **cada** operación de `usedBy`. |
| `http-clients` | `clients.<proveedor>` con `purpose`, `auth` derivado de `m2mAuth` (`client-credentials` → `oauth2-client-credentials`; **si el front-matter no da `tokenUrl`, pregúntalo**, el schema lo exige), y una `calls.<name>` por endpoint que se use, con `contract` en prosa + `method`/`path` del front-matter + `request`/`response` tipados del cuerpo. `timeoutMs`, `retry`, `circuitBreaker` y `fallback` se **entrevistan**, nunca se ponen por defecto. |
| `messaging` | El canal con `external: true`, y una `subscriptions.<Evento>` por cada evento de `fedBy` y por cada compensación: `source` = nombre del proveedor, `contract` (`envelope: keel` si el proveedor es un servicio Keel), `payload`, `triggers` y `onFailure`. |
| `persistence` | La entidad de la copia en `entities`, con índice por `keyField`. |
| `dependencies` + manifiesto | La capa entera (síntesis de todo lo anterior) y `layers.dependencies` en `service.keel.yaml`. |
| `security` | **Nada** — y dilo al usuario: `serviceClients` cataloga a quien nos consume a nosotros; como consumidores no aportamos scopes propios. |

## Paso 5 — cierre

1. `keel validate specs/<servicio>` (sin `--wip` si el resto del diseño está cerrado; con `--wip` si
   `/keel-consume` se ejecutó a mitad de `/keel-design`).
2. Resume lo escrito: dependencias, needs con su estrategia, y qué capas se tocaron.
3. **Lista de huecos**, cada uno con a quién pedírselo.
4. Sugiere el barrido de las clases 7 y 8 de `keel-design/references/gap-analysis.md` sobre lo escrito.

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
- Tocar `security` para añadirnos como cliente de nosotros mismos.
