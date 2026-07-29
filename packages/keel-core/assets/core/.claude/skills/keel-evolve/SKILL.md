---
name: keel-evolve
description: Evoluciona un diseño Keel ya cerrado y propaga el cambio a todos sus derivados (validation-scenarios.md, DESIGN.md, contratos formales, panel e INTEGRATION.md), versionando el spec. Usar cuando haya que cambiar un servicio cuyo diseño ya se cerró.
argument-hint: "<specs/servicio>"
---

# /keel-evolve — cambiar un diseño cerrado sin dejar derivados atrás

Tu rol: guardián de la coherencia del diseño. Un diseño cerrado no es un archivo: es un spec **más
todo lo que nació de él** —los escenarios de validación, el documento de diseño, los contratos
formales, el panel, el contrato servidor-a-servidor—. Cambiar el spec y no regenerar el resto no
deja el diseño «a medias»: deja artefactos que **mienten**, y a un consumidor integrándose contra un
contrato que ya no existe.

Esta skill no diseña ni documenta por su cuenta: **orquesta** las que ya hacen ese trabajo
(`/keel-design`, `/keel-validate`, `/keel-handoff`, `/keel-docs`, `/keel-integrate`) y garantiza que
ninguna se queda sin ejecutar. Lo suyo es el orden, el versionado y el cierre.

## Cuándo se usa esto y cuándo `/keel-design`

- **Sesión de diseño abierta** (el diseño aún no ha cerrado: falta validación en verde, análisis de
  huecos o `validation-scenarios.md`) → `/keel-design`. No hay derivados que propagar todavía.
- **Diseño cerrado** que hay que cambiar → **esta skill**.
- **Diseño cerrado del que nace otro servicio** (no se cambia, se reutiliza) → `keel new <nuevo>
  --from <origen>` y `/keel-design` en modo derivación. El origen no se toca.

## Proceso

### 1. Precondición: el diseño está cerrado

Ejecuta `keel validate specs/<servicio>` (sin `--wip`) y comprueba que existe
`specs/<servicio>/validation-scenarios.md`. Si algo de eso falla, **esto no es una evolución**: el
diseño nunca llegó a cerrarse. Dilo, redirige a `/keel-design specs/<servicio>` y termina — evolucionar
un diseño roto propaga el error a todos sus derivados.

Si la validación falla por algo que el usuario acaba de romper a mano en el spec, corrígelo con él
antes de seguir.

### 2. Inventario e impacto

Ejecuta `keel describe <servicio>`. Da en una pasada las capas declaradas, el contenido de cada una y
—en la sección **Derivados del diseño**— qué derivados existen, cuáles están al día, cuáles quedaron
atrás en una versión anterior y cuáles sobran. Ese inventario es el mapa de lo que habrá que
regenerar al final; léelo **antes** de tocar nada, porque un derivado que ya estaba desactualizado
antes de tu cambio también entra en la cascada.

Pregunta qué cambia y **tradúcelo a capas afectadas antes de editar**, siguiendo el grafo de
dependencias entre capas (`docs/methodology.md § Diseño por capas`):

| Cambia… | Arrastra a… |
|---|---|
| un campo o entidad de `domain` | `use-cases` (inputs/outputs), `api` (schemas), `persistence` (claves, índices), `messaging` (payloads de eventos que lo llevan) |
| una operación de `use-cases` | `api` (endpoint), `security` (regla de acceso), `messaging` (`emits`, suscripciones que la disparan), `dependencies` (`usedBy`) |
| un endpoint de `api` | `security` (acceso y, si es `services`/`both`, `serviceClients` y scopes) |
| un evento de `messaging` | `use-cases` (`emits`), y **todo consumidor externo**: es contrato público |
| un `error` de `use-cases` | `api` (respuestas), `validation-scenarios.md` (cobertura de errores) |
| una capa que se **añade** o se **quita** | el bloque `layers` del manifiesto, y los derivados que dependían de ella (una capa `messaging` retirada deja `asyncapi.yaml` huérfano) |

Presenta el impacto —capas a tocar + derivados a regenerar— y **pide aprobación antes de editar**.
Un cambio que el usuario cree pequeño y arrastra cinco capas es justo lo que hay que enseñar aquí.

### 3. Edición: una capa por vez

Para cada capa afectada, trabaja con el **modo iteración de capa de `/keel-design`** (skill
`keel-design`): no repitas la entrevista completa del servicio, ve directo a la capa y ciérrala como
siempre —aprobación del usuario + `keel validate --wip specs/<servicio>` + **registro de decisiones
estructurales**—.

Ese registro no es opcional en una evolución. Si el cambio reabre una entrada del catálogo
(`keel-design/references/structural-decisions.md`) —una operación nueva necesita decidir su
idempotencia, un evento nuevo su fiabilidad de publicación, una suscripción nueva su política de
fallo—, **se vuelve a preguntar al diseñador**. La decisión que tomó para otra operación hace tres
meses no se hereda en silencio: heredarla es exactamente el default tácito que la metodología
prohíbe.

Termina esta fase con `keel validate specs/<servicio>` en verde, sin `--wip`.

### 4. Versionado del contrato

`service.version` es semver **del contrato**, no del código. Clasifica el cambio según
`docs/methodology.md § Versionado y evolución del spec`:

- **patch** — aclaraciones de prosa, descriptions, reglas reescritas sin cambiar comportamiento.
- **minor** — adiciones compatibles: operación nueva, campo opcional, evento publicado nuevo, error nuevo.
- **major** — rompe integradores: quitar o renombrar operaciones, campos, códigos de error o eventos;
  cambiar tipos; volver requerido un campo opcional; cambiar el payload de un evento existente.

Propón la clasificación con `AskUserQuestion` **explicando qué rompe** (no la etiqueta sola: «renombrar
`SKU_ALREADY_EXISTS` obliga a cambiar el manejo de errores de todo cliente que lo trate» ). Recuerda
la regla dura: **códigos de error y nombres de evento son contrato público, renombrarlos siempre es
major**, aunque el cambio parezca cosmético.

Escribe la versión nueva en `specs/<servicio>/service.keel.yaml` **preservando comentarios y estilo**
del archivo (edítalo, no lo reescribas desde plantilla). Es el número contra el que se comparan todos
los sellos de la fase 6: si no se sube, la cascada no se puede verificar.

### 5. Análisis de huecos acotado

Ejecuta el barrido de `keel-design/references/gap-analysis.md` **sobre las capas tocadas y las
referencias cruzadas afectadas**, no sobre el diseño entero. Un cambio pequeño sobre un diseño
maduro abre huecos nuevos que la validación mecánica no ve: un estado añadido al `lifecycle` al que
ninguna operación lleva, una operación quitada que deja un error inalcanzable, una colección nueva
sin orden total, un campo nuevo sin política de autorización a nivel de dato.

Reporta la **tabla de cobertura** además de los hallazgos —es lo que distingue una clase que se
recorrió y salió limpia de una que nadie miró— y cierra cada hallazgo con una decisión del usuario.
Ninguno queda `abierto`.

### 6. Cascada de regeneración

En **este orden** (cada uno alimenta al siguiente) y **solo sobre lo que procede**:

1. **`validation-scenarios.md`** — regenéralo con `keel-design/references/scenario-authoring.md` y sus
   dos pasadas de auto-revisión (cobertura en recorrido inverso + equivalencia). Toda operación con
   al menos un flujo, todo error declarado cubierto. Refresca su sello `> specs/<servicio> v<versión>`.
2. **`/keel-handoff`** (skill `keel-handoff`) — `DESIGN.md` + índice del `README.md`. Re-deriva lo
   mecánico y **preserva** «Decisiones de diseño» y `### Supuestos y limitaciones`; pregunta solo por
   las decisiones nuevas que abrió esta evolución y revisa que las registradas sigan vigentes (una
   decisión cuya operación ya no existe se retira).
3. **`/keel-docs`** (skill `keel-docs`) — `openapi.yaml`, `asyncapi.yaml`, colecciones Postman,
   `overview.html` y los visores. Se sobrescriben enteros, nunca se editan incrementalmente, y se
   revalidan con `@redocly/cli lint` y `@asyncapi/cli validate`. `postman/auth-collection.json` no se
   toca (es idempotente por diseño).
4. **`/keel-integrate`** (skill `keel-integrate`) — `INTEGRATION.md`, entero. Su front-matter lleva la
   `version` nueva.

Reglas de la cascada:

- **Lo que existía se regenera; lo que nunca se generó, no se crea por sorpresa.** Si `keel describe`
  lo daba como «no generado», dilo al cerrar y ofrécelo, pero no lo produzcas sin que el usuario lo
  pida: que un servicio no tenga `INTEGRATION.md` puede ser deliberado.
- **Lo que ahora aplica y antes no, se ofrece.** Si la evolución añadió capa `messaging`, `asyncapi.yaml`
  pasó de «no aplica» a faltar: propónlo.
- **Lo huérfano se borra.** Si la evolución quitó la capa que justificaba un derivado (`keel describe`
  lo marca `✘ sobra`), bórralo con el visto bueno del usuario. Un `asyncapi.yaml` de eventos que ya no
  se publican es peor que no tenerlo.
- **Un derivado nunca se edita a mano** para «ponerlo al día»: se regenera con su skill. El spec es la
  única fuente de verdad.

### 7. Cierre (definition of done)

1. `keel validate specs/<servicio>` en verde, sin `--wip`.
2. `keel describe <servicio>` **sin ningún derivado desactualizado ni huérfano**. Este es el gate real
   de la skill: si algo sigue en `⚠` o `✘`, la evolución no ha terminado.
3. Si la evolución fue **minor o major**, avisa explícitamente a quién afecta hacia fuera:
   - **Consumidores del contrato.** `INTEGRATION.md` cambió de versión: el diseñador de cada servicio
     que dependa de este debe pasarle el documento nuevo a `/keel-consume`, que lo compara en modo
     diff contra su `dependencies.<proveedor>.contract.version` declarada. Enumera los consumidores
     que conozcas (los que aparezcan en `security.serviceClients` o en el `README.md` del workspace);
     esta es la mitad del ciclo publicar↔ingerir que nadie dispara solo.
   - **Servidores ya generados.** Si existe algún `services/<servicio>-<tech>/`, hay que re-ejecutar
     `keel-<tech> build specs/<servicio>` y volver a entrar al proyecto con `/keel-generate-<tech>`:
     el build refresca el snapshot del diseño y de los docs, y el agente reimplementa lo que cambió.
     **Tú no lo ejecutas**: el workspace de diseño no invoca generadores. Dilo como siguiente paso.
4. Un commit por evolución sobre `specs/<servicio>/` + `docs/<servicio>/`: el diseño vive en git y el
   diff completo —spec y derivados juntos— es lo que hace revisable el cambio de contrato.

## Criterios de calidad

- El cambio se tradujo a capas **antes** de editar, y el usuario aprobó el impacto.
- Ninguna decisión estructural reabierta se resolvió por herencia silenciosa de la versión anterior.
- `service.version` subió, y la clase (patch/minor/major) la eligió el usuario viendo qué rompe.
- El análisis de huecos se ejecutó sobre lo tocado, con su tabla de cobertura, y no quedó nada abierto.
- Todos los derivados que existían se regeneraron; los huérfanos se borraron; ninguno se editó a mano.
- Los consumidores conocidos quedaron avisados con nombre, no con un «avisa a quien corresponda».
