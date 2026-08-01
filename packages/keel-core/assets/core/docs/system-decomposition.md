# Descomponer un sistema en servicios

Cómo se pasa de un encargo ("necesitamos una plataforma de venta de billetes") a un conjunto de
servicios con su frontera, su orden de construcción y un encargo por servicio.

El resto del método tiene grano de **un servicio**: `specs/<servicio>/` es la fuente de verdad y todas
las skills operan sobre uno. Esta es la fase anterior, y solo hace falta cuando el encargo es un
sistema. Si el problema tiene una sola fuente de verdad, el mapa correcto tiene un servicio y esta
fase sobra: se va directo a `/keel-design`.

## Las tres piezas

| Pieza | Qué es | Quién la escribe |
|---|---|---|
| `system.yaml` | El mapa, declarativo y verificable. En la raíz del workspace | `/keel-decompose` |
| `docs/system/SYSTEM.md` | La decisión y su porqué, en prosa | `/keel-decompose` |
| `docs/system/briefs/<servicio>.md` | Un encargo por servicio, para `/keel-design` | `/keel-decompose` |
| `keel system` | Las olas de construcción y la deriva contra los diseños | la CLI |

`system.yaml` **no forma parte del DSL**, igual que `design.yaml`: el DSL describe lo que un servicio
hace, y esto describe cómo se reparte un encargo. Su schema es `schema/system.schema.json` y no es una
capa: no se declara en `layers` de ningún manifiesto y `keel validate` no lo mira.

## El flujo

```
TDR ──> /keel-decompose ──> system.yaml + SYSTEM.md + briefs/<servicio>.md
                                   │
                                   ▼
              ola 1: keel new <x> ──> /keel-design specs/<x> ──> /keel-integrate specs/<x>
                                   │                                      │
                                   │        el INTEGRATION.md del proveedor desbloquea
                                   │        a sus consumidores  ──────────┘
                                   ▼
              ola 2, 3, …          keel system check  (¿quién puede empezar? ¿qué se desvió?)
```

El bucle que sostiene el orden no es una convención de la skill: el paso 2 de `/keel-design` pide el
`INTEGRATION.md` del proveedor y `/keel-consume` degrada sin él. Diseñar un consumidor antes que su
proveedor no es imposible — es diseñarlo contra un contrato inventado.

## `system.yaml` campo a campo

```yaml
system:
  name: airline-ticketing          # kebab-case
  description: Venta y emisión de billetes de avión para web y app móvil.
  tdr: docs/system/tdr.md          # procedencia; informativa, no se resuelve
services:
  seat-inventory:                  # = el nombre de su specs/<servicio>/
    summary: Disponibilidad y retención temporal de asientos por tramo.
    responsibility: Única fuente de verdad de si un asiento está libre, retenido o confirmado.
    notResponsible: [precio del asiento, datos del pasajero]
    owns: [SeatMap, SeatHold]      # candidatos a entidad, en inglés y PascalCase
    publishes: [SeatHeld, SeatReleased, SeatConfirmed]
    status: planned                # planned | designing | designed
    consumes:
      - from: flight-catalog
        kind: events               # events | http
        what: [alta de vuelos, cancelación de vuelos]
        events: [FlightScheduled, FlightCancelled]
        strategy: replicated       # on-demand | replicated
        why: El mapa de asientos nace al programarse el vuelo.
        blocking: true             # ¿necesito su INTEGRATION.md para diseñarme?
```

### `services.<servicio>`

| Campo | Oblig. | Para qué |
|---|---|---|
| `summary` | **sí** | Una línea para la tabla de `keel system` |
| `responsibility` | **sí** | De qué es la **única fuente de verdad**. Si no cabe en una frase, la frontera está mal trazada |
| `notResponsible` | no | Lo que **no** es suyo aunque el TDR lo mencione al lado. Es la mitad de la frontera que se olvida, y la que evita que dos servicios se peleen por el mismo dato |
| `owns` | no | Conceptos que le pertenecen (candidatos a entidad). Un concepto tiene un dueño y solo uno |
| `publishes` | no | Eventos que publica. Es lo que hace verificable la arista del consumidor |
| `status` | no (`planned`) | Estado declarado. La CLI lo contrasta con la realidad de `specs/` |
| `external` | no (`false`) | Un sistema que no diseñamos aquí. No se le espera `specs/`, su contrato vive en `contracts/<servicio>/INTEGRATION.md` y **nunca bloquea el orden** |
| `derivedFrom` | no | Diseño del registry del que partirá este servicio, en vez de una sesión de diseño completa. Si hay que ajustarlo, se deriva con `keel new <servicio> --from registry:<diseño>`; si sirve tal cual y el nombre del mapa coincide con el del diseño, se **adopta** con `keel registry get <diseño>` y el servicio nace ya cerrado |
| `after` | no | Servicios que van antes por **prioridad de negocio**, no por contrato |
| `consumes` | no | Las aristas del mapa de contextos |

### `consumes[]`

| Campo | Oblig. | Para qué |
|---|---|---|
| `from` | **sí** | El proveedor. Debe existir en `services` |
| `kind` | **sí** | `http` si el consumidor **no puede completar su operación** sin el dato en el instante; `events` si solo necesita reaccionar o mantener una copia |
| `what` | **sí** | Qué necesita, en lenguaje de negocio. Se convierte en los `needs` de la capa `dependencies` al diseñar |
| `events` | no | Con `kind: events`, los eventos concretos. Sin ellos no se puede comprobar que el proveedor los publique |
| `strategy` | no | `on-demand` o `replicated`, la misma decisión que `/keel-consume` entrevista dato a dato. Declararla aquí la preacuerda a nivel de sistema |
| `why` | **sí** | Por qué existe la arista y por qué por ese canal. Una arista sin porqué es una integración que nadie pidió |
| `blocking` | no (`true`) | **Es lo que fija el orden**: `true` = no puedo diseñarme sin su `INTEGRATION.md` |

Las aristas las dibuja **quien necesita el dato**, nunca quien lo tiene: un proveedor no sabe quién le
consume, y esa ignorancia es la propiedad que le permite desplegarse solo.

## `keel system`

```bash
keel system              # olas de construcción, estado de cada servicio, mapa de contextos
keel system show --json  # el plan completo, machine-readable
keel system check        # contrasta el mapa con los diseños reales — para CI
```

No escriben nada: la prosa la produce `/keel-decompose` y el índice del `README.md`, `keel index`.

### Las olas se calculan, no se declaran

No hay campo `wave`. Las olas son un orden topológico sobre las aristas **bloqueantes** hacia
servicios que diseñamos aquí; cada nivel se ordena alfabéticamente, así que la salida es determinista.
Un `external` no entra en ninguna ola: su contrato ya existe.

Lo que no entra en ninguna ola es un **ciclo**, y `check` lo reporta con las aristas implicadas. Antes
de romperlo, comprueba si una está dibujada al revés — el caso más común es un proveedor que no
necesita conocer a su consumidor (le basta recibir su identificador como dato opaco). Si el ciclo es
real, se elige qué lado se diseña en modo degradado y esa arista se marca `blocking: false`.

### `keel system check`: la única comprobación cross-servicio del método

`keel validate` no puede ver más allá de un servicio: `crossrefs.js` valida referencias **entre capas**
de un mismo diseño. Que el `source: flight-catalog` de una suscripción exista, y que ese servicio
publique de verdad ese evento, no lo comprobaba nada. Eso es lo que hace esta puerta:

1. **El mapa contra sí mismo** — aristas contra servicios no declarados, ciclos bloqueantes, eventos
   suscritos que el proveedor no declara en `publishes`.
2. **El mapa contra la realidad** — el `status` declarado contra el estado real de `specs/`, diseños
   del workspace que el mapa no conoce, servicios `external` que sin embargo tienen `specs/`.
3. **Un diseño contra el mapa** — dependencias que el diseño declara y el mapa no conoce (integración
   que nadie planificó) y suscripciones a fuentes que el mapa no contempla.
4. **Un diseño contra otro diseño** — que el proveedor publique en su capa `messaging` los eventos que
   el mapa promete a su consumidor.

**Asimetría deliberada:** lo que el mapa planificó y un diseño aún no implementa solo es deriva cuando
ese diseño está **cerrado** — mientras se diseña, faltar es lo normal y reportarlo sería ruido en cada
ejecución. Una dependencia que un diseño declara y el mapa no conoce, en cambio, es deriva **siempre**.

Cualquier hallazgo pone el comando en rojo, avisos incluidos, igual que `keel index --check`: un mapa
que no coincide con los diseños es un mapa que miente, y da lo mismo si miente por error o por
quedarse atrás. Se corrige el mapa o se corrige el diseño; nunca se ignora.

## El brief: un archivo, un encargo

`docs/system/briefs/<servicio>.md` es lo que se le pasa a quien va a diseñar ese servicio. Un archivo
por servicio, porque un archivo se reparte, se versiona y se difea por separado. Lleva front-matter
YAML (índice machine-readable, misma idea que `INTEGRATION.md`) y prosa: qué resuelve, de qué es la
única fuente de verdad, qué **no** es suyo, conceptos y capacidades candidatas, quién le consume, las
integraciones acordadas con su porqué, el extracto literal del TDR y las órdenes para arrancar.

`/keel-design` lo detecta solo: si existe `docs/system/briefs/<servicio>.md`, arranca la entrevista
desde ahí en vez de desde cero — **confirmando cada punto, no asumiéndolo**. El brief es una hipótesis
del sistema, no un spec.

**La regla que hace que el brief sirva:** propone **candidatos** y fija **fronteras**; nunca escribe
YAML del DSL ni decide idempotencia, outbox, caché, paginación o frontera transaccional. Esas son del
diseñador, con su catálogo de decisiones estructurales delante. Un brief que decide de más convierte
una entrevista en un dictado, y el diseñador acaba firmando decisiones que no tomó.

## Qué NO es un servicio del mapa

Autenticación, observabilidad, API gateway y despliegue son **infraestructura**, y se deciden al
generar: la capa `security` declara protocolo, roles y clientes máquina, y el proveedor concreto se
elige en `keel-<tech> build`. Un `auth-service` en el mapa es una frontera dibujada por capa técnica.
Van a la sección "Fuera de alcance" de `SYSTEM.md`, que existe precisamente para que nadie los diseñe
por si acaso.

Tampoco lo son un `shared`/`common` (lo compartido que es código es una librería; lo que es dato tiene
un dueño de negocio), ni un servicio por tabla, ni un orquestador sin dominio propio. El catálogo
completo de antipatrones, con los seis ejes de corte, está en
`references/boundary-heuristics.md` de la skill `keel-decompose`.

## Relación con el registry

Son ejes distintos y conviene no confundirlos:

- **`family` del sidecar `design.yaml`** agrupa **variantes alternativas del mismo problema**
  (`notifications-multichannel` vs. `notifications-push-only`). No es composición.
- **`system.yaml`** describe **composición**: varios servicios distintos que forman un sistema.

Un servicio del mapa puede resolverse desde el registry (`derivedFrom`), derivándolo o adoptándolo tal
cual, y entonces `design.yaml.requires` de ese diseño debería ser coherente con sus aristas del mapa. Un
servicio **adoptado** entra en el mapa ya con `status` de diseño cerrado y publica su contrato desde el
primer día, así que no bloquea a nadie: es la forma más barata de cerrar una ola. Detalle del registry en
[design-registry.md](design-registry.md).
