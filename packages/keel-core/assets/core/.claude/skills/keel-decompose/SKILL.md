---
name: keel-decompose
description: Convierte un encargo de sistema (un TDR, un documento de requisitos) en un mapa de servicios con su frontera, sus integraciones, su orden de construcción y un brief por servicio listo para /keel-design. Usar cuando el encargo es un sistema completo y todavía no se sabe cuántos servicios hay ni cuál va primero.
argument-hint: "[ruta al TDR]"
---

# /keel-decompose — del encargo al mapa de servicios

Tu rol: arquitecto de sistemas. El resto del método tiene grano de **un servicio**: `/keel-design`
te pide un servicio ya nombrado. Esta skill es el paso anterior — decide **cuántos servicios hay,
dónde está la frontera de cada uno, quién consume a quién y en qué orden se construyen**, y deja
cada servicio listo para que otra persona lo diseñe sin tener que releer el TDR entero.

Produce tres cosas:

| Artefacto | Qué es | Quién lo consume |
|---|---|---|
| `system.yaml` | El mapa, declarativo y verificable | `keel system` y CI |
| `docs/system/SYSTEM.md` | La decisión y su porqué, en prosa | El equipo, los que llegan después |
| `docs/system/briefs/<servicio>.md` | Un encargo por servicio | El diseñador de ese servicio, vía `/keel-design` |

Referencias, que se leen bajo demanda:

- `references/boundary-heuristics.md` — **léela antes del paso 3**: los seis ejes de corte, los
  antipatrones y qué hacer con los casos difíciles.
- `references/worked-example.md` — un TDR real recortado y su descomposición completa. Léela la
  primera vez que uses esta skill: es lo que calibra el **grano** (ni un servicio por tabla, ni un
  monolito con dos nombres).
- `docs/system-decomposition.md` — el schema de `system.yaml` campo a campo.

## Regla de oro

**Un servicio no se justifica por lo que contiene, sino por lo que promete en solitario.** Si no
puedes escribir en una frase de qué es la única fuente de verdad, no es un servicio: es un trozo de
otro. Y si dos candidatos no pueden desplegarse ni fallar por separado sin romper una invariante de
negocio, son uno.

**El brief propone candidatos, nunca decide el diseño.** Escribes conceptos candidatos a entidad y
capacidades candidatas a caso de uso; **jamás** YAML del DSL, ni idempotencia, ni outbox, ni caché,
ni paginación, ni la frontera transaccional. Esas son del diseñador dentro de `/keel-design`, con su
catálogo de decisiones estructurales delante. Un brief que decide de más convierte una entrevista en
un dictado, y el diseñador acaba firmando decisiones que no tomó.

## La última palabra es del diseñador

**Una frontera es una decisión estructural**, de la misma clase que outbox o idempotencia: cambia
qué puede prometer cada servicio, quién puede desplegarse sin pedir permiso y qué se rompe cuando
uno cae. Aplica el mismo protocolo que `keel-design/references/structural-decisions.md`:

- **Recomienda siempre** una partición concreta con su porqué en una frase. Un menú neutro de
  alternativas le devuelve al humano el trabajo de pensar.
- **Pregunta con `AskUserQuestion`** e incluye la **consecuencia observable** de cada opción: qué
  pasa el día que uno de los dos lados falle, qué transacción deja de ser una transacción, qué
  equipo tiene que pedir permiso a qué otro para desplegar.
- **Nunca la escribas en silencio.** Una frontera asumida es la decisión más cara del proyecto: se
  descubre meses después, cuando cambiarla ya cuesta reescribir dos servicios.
- Si el humano elige otra partición, **acátala** y anota su porqué en `SYSTEM.md`.

## Proceso

### 1. Ingesta del encargo

Lee el TDR (ruta como argumento, archivo del workspace o texto pegado). Cópialo o normalízalo a
`docs/system/tdr.md`: es la procedencia del mapa y lo que permite releer mañana de dónde salió cada
servicio.

Extrae cinco inventarios **sin decidir nada todavía** y preséntalos en tablas:

| Inventario | Qué buscas | Para qué sirve luego |
|---|---|---|
| Capacidades | Verbos de negocio ("reservar", "cobrar", "emitir") | Se agrupan en servicios; luego, casos de uso |
| Conceptos | Sustantivos con ciclo de vida propio | Se reparten entre servicios; luego, entidades |
| Actores | Quién hace qué y desde dónde | Anticipa superficies (web, app, otros servidores) |
| Eventos de negocio | Cosas que **pasan** y a alguien más le importan | Son las aristas de eventos del mapa |
| Restricciones | Dinero, regulación, picos de carga, plazos, sistemas ya existentes | Fuerzan fronteras y el orden |

Este paso es la mitad del valor de la skill: un TDR siempre tiene huecos, y sacarlos **antes** de
dibujar fronteras cuesta una pregunta. Descubiertos después, cuestan un servicio. Enumera
explícitamente lo que el TDR **no dice** y pregúntalo. No sigas al paso 3 con un concepto cuyo dueño
nadie sabe.

### 2. Buscar antes de descomponer

Por cada capacidad agrupable, `keel registry search <capacidad>`. Un problema ya resuelto no se
descompone: se **deriva**. Si un candidato encaja, márcalo en el mapa con `derivedFrom: <diseño>` y
se materializará con `keel new <servicio> --from registry:<diseño>` — el diseñador arrancará en modo
derivación (entrevista solo del delta) en vez de en una sesión capa a capa. Es el paso más barato del
método y esta skill no lo duplica: lo hereda.

### 3. Fronteras

Lee `references/boundary-heuristics.md`. Agrupa capacidades y conceptos en servicios candidatos y
somete cada corte dudoso al protocolo de arriba. Por cada servicio, cierra tres campos y **no sigas
sin los tres**:

- `responsibility` — de qué es la **única fuente de verdad**, en una frase.
- `notResponsible` — lo que **no** es suyo aunque el TDR lo mencione al lado. Es la mitad de la
  frontera que todo el mundo se salta, y la que evita que dos servicios se peleen por el mismo dato.
- `owns` — los conceptos que le pertenecen, en inglés y PascalCase (candidatos a entidad).

Un concepto pertenece **a un solo servicio**. Si dos lo reclaman, o hay dos conceptos distintos con
el mismo nombre (el `Passenger` de reservas no es el `Passenger` de facturación) o la frontera está
mal. Nómbralos distinto y dilo en `SYSTEM.md`.

### 4. Mapa de contextos

Por cada par de servicios que conversan, decide **sentido, canal y estrategia**, y pregunta lo que
no se deduzca del TDR:

- **Sentido.** Lo dibuja quien **necesita** el dato, no quien lo tiene. Un proveedor no sabe quién le
  consume, y esa ignorancia es la propiedad que hace que se pueda desplegar solo.
- **Canal.** Regla de corte: si el consumidor **no puede completar su operación** sin el dato en el
  instante → `kind: http`. Si solo necesita **reaccionar** a algo que pasó, o mantener una copia
  local → `kind: events`.
- **Estrategia** (`on-demand` | `replicated`). Es la misma decisión que `/keel-consume` entrevista
  dato a dato; acordarla aquí evita reabrirla siete veces, y el brief la arrastra.
- **`why`.** Una arista sin porqué es una integración que nadie pidió. Escríbelo siempre.

Cada arista de eventos declara los **nombres de los eventos** (`events:`) y el proveedor los declara
en su `publishes`. No es burocracia: es lo único que permite a `keel system check` comprobar que el
consumidor no se está integrando contra un evento que nadie publica.

### 5. Orden de construcción

Marca cada arista `blocking: true|false` — **es la decisión que fija el orden**. `blocking: true`
significa "no puedo diseñar este servicio sin el `INTEGRATION.md` del proveedor", que es literalmente
lo que pide el paso 2 de `/keel-design`. `blocking: false` significa que se puede diseñar antes: en
modo degradado, o porque el acoplamiento va en el otro sentido.

Escribe `system.yaml` y ejecuta `keel system`. Las olas las calcula la CLI; no las escribas tú.

**Si aparece un ciclo**, no lo rompas por tu cuenta. Primero comprueba si una arista está dibujada al
revés (el caso más común: el proveedor no tiene por qué conocer al consumidor — le basta recibir su
identificador como dato opaco). Si el ciclo es real, pregunta con `AskUserQuestion` qué lado se
diseña en modo degradado, márcalo `blocking: false` y anota el porqué en `SYSTEM.md`.

### 6. Entregables

**`docs/system/SYSTEM.md`** — la decisión y su porqué. Secciones, en este orden:

1. `## El encargo` — qué resuelve el sistema y de qué TDR sale (enlaza `tdr.md`).
2. `## Servicios` — tabla: servicio · responsabilidad · no es responsable de · conceptos · publica.
3. `## Mapa de contextos` — tabla de aristas: consumidor · proveedor · canal · qué · estrategia ·
   bloqueante · por qué.
4. `## Orden de construcción` — las olas, y por cada una qué desbloquea. Es una proyección de
   `keel system`: dilo y remite ahí en vez de mantener dos verdades.
5. `## Decisiones de frontera` — una entrada por corte no obvio, con el mismo formato del registro de
   decisiones estructurales de `/keel-design`: la decisión, qué se preguntó, la consecuencia
   observable que la justificó y **lo que se descartó**. Los ciclos rotos van aquí.
6. `## Fuera de alcance` — lo que el TDR menciona y **no** es un servicio de este mapa (autenticación,
   observabilidad, un sistema que ya existe). Sin esta sección alguien lo diseñará por si acaso.
7. `## Huecos del encargo` — lo que el TDR no dice y el humano tampoco supo responder. Son pendientes
   reales: cada uno acabará decidiéndolo por su cuenta el diseñador de un servicio.

**`docs/system/briefs/<servicio>.md`** — un archivo por servicio, porque un archivo es un encargo:
se reparte, se versiona y se difea por separado. Front-matter YAML (índice machine-readable, misma
idea que `INTEGRATION.md`) más prosa:

```markdown
---
service: seat-inventory
system: airline-ticketing
wave: 2
publishes: [SeatHeld, SeatReleased, SeatConfirmed]
consumes: [{ from: flight-catalog, kind: events, strategy: replicated, blocking: true }]
consumedBy: [booking]
---
# Brief — seat-inventory

> Encargo del sistema airline-ticketing. Candidatos, no decisiones: el diseño lo cierras tú con
> `/keel-design`.

## Qué resuelve
## De qué es la única fuente de verdad
## Qué NO es suyo
## Conceptos que le pertenecen (candidatos a entidad)
## Capacidades (candidatas a caso de uso)
## Quién le consume y para qué        ← anticipa la superficie servidor-a-servidor
## Integraciones acordadas en el mapa ← canal, estrategia y su porqué, por arista
## Lo que el mapa ya decidió · lo que decides tú al diseñar
## Extracto literal del TDR relevante
## Cómo arrancar
```

La sección **"lo que decides tú"** no es cortesía: enumerar explícitamente que la idempotencia, la
caché, el outbox, la frontera transaccional y la paginación siguen abiertas es lo que impide que el
diseñador dé por cerrado lo que el brief solo insinuó.

Cierra el brief con las órdenes literales, ya resueltas para ese servicio:

```bash
keel new seat-inventory        # o: keel new seat-inventory --from registry:<diseño>
/keel-design specs/seat-inventory
```

### 7. Cierre

1. `keel system check` en verde. Si sale en rojo, corrige el mapa: no dejes el sistema con hallazgos.
2. Enumera los servicios de la **ola 1** con su orden de arranque, y di explícitamente que los de las
   olas siguientes **esperan** — indicando a qué contrato esperan.
3. Explica el bucle que sostiene el orden: al cerrar cada servicio, `/keel-integrate specs/<servicio>`
   publica su `INTEGRATION.md`, y eso es lo que desbloquea a sus consumidores. `keel system check`
   dice en cada momento quién puede empezar.
4. Recuerda que el mapa es vivo: cuando un diseño real se aparte de él, `keel system check` lo dirá,
   y **se corrige el mapa o se corrige el diseño** — nunca se ignora.

## Cierre de sesión (definition of done)

No des la sesión por terminada sin: `system.yaml` válido y `keel system check` en verde; todo servicio
con `responsibility` y `notResponsible` escritos; toda arista con su `why`; ningún ciclo bloqueante sin
decisión; `SYSTEM.md` con sus siete secciones y un brief por servicio no externo. Si la sesión se corta,
enumera explícitamente qué servicios quedaron sin brief y qué huecos del TDR siguen abiertos.

## Criterios de calidad

- Cada servicio se describe en una frase sin la palabra "y". Dos "y" son dos servicios o un servicio mal
  cortado.
- Ningún servicio existe solo para guardar datos de otro, ni para "compartir" código o tipos: eso es una
  librería, no un servidor.
- Ningún servicio orquesta a todos los demás sin dominio propio. Un coordinador sin estado ni decisiones
  es un método que quedó en el sitio equivocado.
- Un concepto tiene un dueño y solo uno; los homónimos se renombran.
- Toda arista tiene canal justificado por la regla de corte, no por costumbre.
- Toda arista de eventos nombra sus eventos y el proveedor los declara en `publishes`.
- El número de servicios lo justifica el dominio, no una cifra bonita. Si el TDR describe un problema con
  una sola fuente de verdad, **el mapa correcto tiene un servicio** — y entonces esta skill sobra: dilo y
  manda al humano directo a `/keel-design`.
- Autenticación, observabilidad, API gateway y despliegue **no son servicios del mapa**: son
  infraestructura que se decide al generar. Van en "Fuera de alcance".
- Ningún brief contiene YAML del DSL ni resuelve una decisión estructural.
