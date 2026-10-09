# Obligaciones de diseño

Las decisiones que un diseño **abre** al declarar algo, y que nadie echa de menos si no se
cierran. Cada una tiene un **id estable**, y ese id es lo único que hace que una decisión sin
tomar se pueda aceptar por escrito, contar en el catálogo y seguir entre corridas.

## Por qué existe esta lista

El método ya tenía el modelo entero: las 17 clases del análisis de huecos, con su disparador,
su severidad y su forma de cierre. Lo que no tenía era **dónde escribir el resultado**. El
análisis se hacía en la conversación, el registro de decisiones estructurales también, y la
clase 16 admite el problema de frente: con el contexto compactado o el diseño heredado, ese
registro desaparece y toda entrada aplicable vuelve a ser un hueco.

En paralelo, `keel validate` ya detectaba decenas de estas decisiones. Las imprimía como avisos
y acto seguido escribía `✔ Servicio válido`. Un aviso que no bloquea, que no se registra y que
nadie está obligado a contestar es indistinguible de no haberlo emitido: lo que las corridas de
`info/` documentan es el mismo hueco reportado como `designGap` cuatro veces seguidas, ya con
un agente escribiendo Java y con `build --force` como única salida.

Una obligación es ese aviso con id. La regla es:

- **Se cierra en el diseño** declarando lo que faltaba. No necesita entrada en ningún sitio.
- **O se acepta por escrito** en `decisions.yaml`, con su motivo y la versión en que se tomó.
  Aceptarla no la esconde: `keel validate` la sigue listando.
- **Lo que no vale es dejarla sin contestar**, y por eso bloquea.

Hay obligaciones que **no admiten aceptación**: aquellas en las que no existe un default seguro,
donde «aceptado» significaría dejársela al generador. Están marcadas como tal en la tabla.

## La tabla

| id | Qué lo enciende | Decisión que abre | Clase | Aceptable |
|---|---|---|---|---|
| `OBL-IDEM-RACE-CODE` | `use-cases`: alguna operación declara `idempotency` | la carrera de la clave no tiene `code` nombrado | 4 | sí |
| `OBL-IDEM-REUSE-CODE` | `use-cases`: alguna operación declara `idempotency` | el desenlace «misma clave, otro cuerpo» no tiene `code` nombrado | 4 | sí |
| `OBL-IDEM-KEY-REQUIRED` | `use-cases`: alguna operación declara `idempotency` con `keySource: client-key` | no está decidido qué pasa si el cliente NO manda la cabecera | 4 | sí |
| `OBL-CONCURRENCY-CODE` | `persistence`: `consistency.optimisticLocking` es `all` o `declared` | el conflicto de escritura concurrente no tiene `code` nombrado | 4 | sí |
| `OBL-ENTITY-UNREACHABLE` | `domain`: una raíz de agregado a la que ninguna operación se refiere | una raíz de agregado que ninguna operación puede crear | 14 | sí |
| `OBL-CALLER-IDENTITY` | `security`: se declara `serviceAuth` (clientes máquina) y alguna operación recibe campos de entrada | con clientes máquina, no está decidido si la identidad del llamante entra en el trabajo | 9 | sí |
| `OBL-DECIMAL-SCALE-POLICY` | `domain`/`use-cases`: un decimal con `scale` llega al `input` de alguna operación | no está decidido qué pasa con un importe de entrada con más decimales que su escala | 12 | sí |
| `OBL-OUTCOME-NEGATIVE-UNDECIDED` | `dependencies`: una activación con `awaits: outcome` cuya llamada devuelve un campo booleano | el desenlace NEGATIVO de la llamada no está decidido | 13 | sí |
| `OBL-GUARD-UNOBSERVABLE` | `mail`: una operación de `sentBy` con estado en vuelo y sin puerta propia | la guarda del efecto irreversible no la mide ningún escenario | 12 | sí |
| `OBL-RESOURCE-SCOPE` | `use-cases`: una operación protegida por rol declara un error 403 | un 403 que nada de lo declarado puede producir | 9 | no |
| `OBL-PAYMENTS-FOLLOWUP-REJECTED` | `payments`: una acción de seguimiento (`capture`, `void`, `refund`) sin `onRejected` | no está decidido qué pasa cuando la pasarela contesta que NO a una acción de seguimiento | 18 | no |
| `OBL-PAYMENTS-REFERENCE-REUSED` | `payments` + `messaging`: una suscripción dispara el cobro y no declara `onFailure.acknowledgeOn` | no está decidido qué se hace con un mensaje distinto cuya referencia de cobro ya tiene cobro | 18 | sí |

La columna **Clase** es la del análisis de huecos (`gap-analysis.md`), para que el barrido del
agente y la validación mecánica hablen del mismo hueco con el mismo nombre.

## Cómo se cierran

`OBL-RESOURCE-SCOPE` va aparte porque es la única que **no admite aceptación**. Se cierra
declarando `authentication.scoping` —de dónde sale la acotación por recurso: el claim del
token, qué identifica al recurso, qué error rechaza y qué roles quedan exentos— o retirando
ese 403 si el permiso no se acota por recurso. Aceptarla significaría que el generador decide
quién alcanza qué, y lo que decide por omisión es que todo el mundo alcanza todo.

Las otras tres se cierran igual entre sí, porque son la misma decisión sobre tres mecanismos: el
conflicto que enciende el mecanismo llega al cliente con un `code`, y el diseño puede nombrarlo
o dejar que se use el canónico de `framework-errors.md`. Nombrarlo es declarar en `errors` un
`code` de la familia del canónico, con su mismo status. Aceptarlo es decir por escrito que el
canónico es el contrato público de este servicio.

Lo que no es opción es ignorarlo: el `code` sale por la API de todas formas, lo ven los
integradores y lo afirman los escenarios.

## `decisions.yaml`

Vive junto a las capas, en `specs/<servicio>/`. No forma parte del DSL: no describe lo que el
servicio hace, sino qué se decidió no declarar y por qué.

```yaml
decisions:
  - id: OBL-IDEM-REUSE-CODE
    scope: use-cases
    reason: >
      El único cliente es nuestro BFF, que nunca reutiliza una clave con otro cuerpo.
      Se acepta IDEMPOTENCY_KEY_REUSED como contrato público del servicio.
    since: 1.4.0

  - id: CHK-USECASES-CODE-MULTI-STATUS
    scope: use-cases.errors.ORDER_NOT_FOUND
    reason: >
      Deliberado: 404 al leer un pedido que no existe y 422 al referenciarlo desde otra
      operación, donde es un dato de entrada inválido y no un recurso ausente.
    since: 1.4.0
```

- `scope` es el que la obligación nombra al levantarse. Una decisión sobre un `scope` que el
  diseño ya no levanta se reporta como **huérfana**: describe un hueco que no existe.
- `reason` es lo único que distingue una decisión de un olvido. Una frase que no dice nada no
  vale de nada.
- `since` es el `service.version` en que se tomó. Cuando el diseño cambia de **minor o de
  major** la aceptación **caduca** y hay que reafirmarla: la asunción que la sostenía puede
  haber dejado de ser cierta. Un patch no la caduca — reafirmar por cada errata corregida
  enseña a subir el número sin leer, que es el hábito que este archivo existe para romper.
- **Viaja con el diseño.** Al publicarlo (`keel index` lo lista en `files`), al adoptarlo
  (`keel registry get`, donde sigue vigente porque la versión no cambia) y al derivarlo
  (`keel new --from`, donde llega para reafirmar). Sin él, el diseño llega mecánicamente válido
  pero con las decisiones otra vez abiertas, y el `keel-<tech> build` del consumidor lo rechaza
  por preguntas que el autor ya había contestado.
- `coverage` ya no vive aquí: «qué se miró» pertenece a `review.yaml`, y un `decisions.yaml` que
  todavía la lleve se rechaza con un mensaje que dice a dónde moverla.

## Decisiones no tomadas en los avisos (`nature: undecided`)

`keel validate` imprime avisos de dos naturalezas distintas, y cada comprobación del catálogo
(`src/lib/checks.js`) declara cuál es la suya con una pregunta: **¿el diseño se arregla
corrigiendo algo, o respondiendo a una pregunta?**

- Una **incoherencia** (`incoherence`) se corrige. Un rol que ninguna regla exige, un canal con
  el nombre del broker: no hay nada que decidir, hay algo mal escrito.
- Una **decisión no tomada** (`undecided`) se contesta. Un `POST` sin `successStatus`, una
  suscripción sin `onFailure`, un `code` con dos status: el diseño es coherente, pero calla algo
  que el generador tendrá que decidir por su cuenta, y lo decidirá con un default que cambia de
  un stack a otro.

Una decisión no tomada se cierra igual que una obligación: **declarándola en el DSL** o
**aceptándola por escrito aquí**, con un `CHK-*` como `id` y el `scope` que `keel validate`
imprime debajo del aviso. El scope es por unidad (`api.endpoints.createOrder`,
`use-cases.errors.ORDER_NOT_FOUND`), así que una aceptación vale para esa unidad y no para las
demás. Caduca con el minor, se queda huérfana si el diseño deja de levantarla y viaja con el
diseño, como cualquier otra entrada.

Un caso particular es `CHK-MODEL-IMPLICIT-DEFAULT`: un campo del catálogo de decisiones
estructurales que tiene default en el schema (`publishing.reliability`,
`consistency.optimisticLocking`, `audit.timestamps`, `audit.authorship`, la `visibility` de un
bucket) y que el diseño no escribió. Se puede aceptar, porque el default está documentado y es
seguro, pero lo natural es cerrarlo escribiendo el campo, aunque sea con el mismo valor: cuesta
lo mismo y el YAML dice ya que se decidió. El scope es el propio campo
(`persistence.audit.authorship`, `storage.buckets.invoices.visibility`).

La diferencia con una obligación está en **qué bloquea**. Una obligación abierta bloquea la
generación. Una decisión no tomada no bloquea `keel-<tech> build`; lo que bloquea es
`keel validate --ready`, el criterio `undecided` del diseño listo. Lo que sí bloquea desde el
primer momento es una aceptación mal escrita:

- aceptar una **incoherencia**: se corrige, no se acepta;
- aceptar una decisión que **no admite aceptación** (`waivable: false`): son las que la doctrina
  del análisis de huecos ya fija —el orden de las colecciones (`CHK-USECASES-COLLECTION-NO-SORT`)
  y la autorización (`CHK-API-NO-SECURITY`)— y aquellas en las que el generador elegiría con una
  heurística sobre un nombre o con el default del stack (`CHK-API-POST-NO-STATUS`,
  `CHK-MSG-SUB-NO-ONFAILURE`, `CHK-MSG-NO-SCHEMAREF`, `CHK-HTTP-NO-TIMEOUT`,
  `CHK-STORAGE-NO-MAXSIZE`). Todas se cierran con una línea de YAML;
- un `CHK-*` que el catálogo no tiene.

## Incoherencias y falsos positivos (`nature: incoherence`)

Una incoherencia no se acepta: se corrige. Tampoco bloquea `keel-<tech> build`, pero sí
`keel validate --ready`, en el criterio `incoherences`. Hasta el 2026-09-28 no contaba en ningún
criterio. `asset-vault` cruzó a generación en 10/10 con tres a la vista: dos escenarios
afirmaban en la respuesta lo que el `output` no devuelve. El agente generador eligió al revés en
cada uno, y la corrida salió en rojo.

Quedan fuera del criterio las que ya tienen dueño en otro: la matriz de cobertura
(`coverage-matrix`), el careo (`flow-review`) y los contratos derivados (`CHK-DOCS-*`, que se
arreglan regenerándolos).

Los detectores leen prosa y aplican heurísticas, y se equivocan. Para eso existe una salida, y no
es una aceptación: es declarar que **el detector** se equivocó, en `falsePositives`:

```yaml
falsePositives:
  - id: CHK-SEC-UNUSED-ROLE
    match: roles.auditor              # un fragmento del mensaje: la unidad que nombra
    reason: >-
      El rol lo asigna el proveedor de identidad a los auditores externos, y la regla que lo
      exige vive en el gateway, fuera de este diseño.
    since: 1.2.0
```

- Casa con todo aviso de ese `id` cuyo mensaje contenga `match`.
- Caduca con el minor, como las aceptaciones.
- Se queda huérfana si el aviso deja de salir.
- Solo admite avisos de naturaleza `incoherence`. Un error no tiene excusa, y una decisión se
  acepta en `decisions` con su `scope`.

`keel validate` cuenta las declaradas aparte, como **deuda de los detectores**: cada una es un
detector que hay que arreglar en keel-core, y el sitio de ese arreglo es `crossrefs.js`, no el
diseño.

## Añadir una obligación

1. Fila en `src/lib/obligations.js`, con su `gapClass`, su `kind` y su `waivable`.
2. Fila en la tabla de este documento. `test/obligations.test.js` ata las dos: una obligación
   que el generador levanta y el documento no explica manda a cerrar algo que nadie sabe qué es.
3. El emisor. Para `kind: decision` es `crossrefs.js`, que la levanta con el helper `obligation(...)`
   — nunca con un literal, porque el helper es lo que garantiza que el id exista.

Un `kind: review` no tiene emisor mecánico a propósito: es lo que solo un lector puede juzgar, y
su fila existe para que `/keel-validate` la recorra y dé veredicto por id.
