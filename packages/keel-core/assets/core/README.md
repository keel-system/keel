# Diseños de servicios

Este repositorio contiene **diseños de servicios Keel**: cada servicio se describe como un conjunto de
artefactos declarativos agnósticos de tecnología (`specs/<servicio>/`, un artefacto YAML por capa), a
partir de los cuales se genera la implementación en la tecnología que se quiera.

> Edita libremente esta introducción para describir tu organización, convenciones o cómo contribuir.
> La tabla de la sección **Servicios diseñados** la genera `keel index` (lo ejecutan `/keel-design` al
> cerrar un diseño y `/keel-handoff`); **no edites a mano el contenido entre los marcadores**, se pisa
> en la siguiente ejecución. `keel index --check` comprueba, sin escribir, que el índice sigue al día.

## Servicios diseñados

Cada servicio enlaza su **documento de diseño** (`DESIGN.md`: modelo de dominio, invariantes, decisiones y
cómo reutilizarlo), y, si existen, su **contrato servidor-a-servidor** (`INTEGRATION.md`, de `/keel-integrate`)
y sus **contratos formales y panel de revisión** (`openapi.yaml`, `asyncapi.yaml`, Postman y
`overview.html`, de `/keel-docs`).

<!-- keel:servicios:start -->
_Aún no hay servicios diseñados. Cierra un diseño con `/keel-design specs/<servicio>` para poblar esta tabla._
<!-- keel:servicios:end -->

## Cómo trabajar aquí

Este directorio es un **workspace Keel** (ver `CLAUDE.md` para el flujo completo):

0. **¿El encargo es un sistema o un servicio?** Si es un sistema —un documento de requisitos con varios
   dominios dentro—, antes de crear nada hay que decidir **qué servicios hay y en qué orden se
   construyen**: ver [Diseñar un sistema completo](#diseñar-un-sistema-completo) más abajo. Si es un
   servicio, sigue desde el paso 1.
1. `keel new <servicio>` — crea `specs/<servicio>/` (manifiesto + capas obligatorias).
2. `/keel-design specs/<servicio>` — diseña capa a capa con el agente; al cerrar, genera
   `validation-scenarios.md`, el documento de diseño `docs/<servicio>/DESIGN.md` y actualiza este índice.
3. `keel-<tech> build specs/<servicio>` — elige el stack y genera el proyecto en `services/<servicio>-<tech>/`.
4. `cd services/<servicio>-<tech>` y, dentro del proyecto, `/keel-generate-<tech>` — completa la implementación.
5. `/keel-docs specs/<servicio>` — contratos formales (`openapi.yaml`, `asyncapi.yaml`), colecciones
   Postman y el panel visual del servicio (`overview.html`).
6. `/keel-integrate specs/<servicio>` — el contrato servidor-a-servidor (`INTEGRATION.md`), para que
   **otro servidor** pueda consumir este.
7. `/keel-evolve specs/<servicio>` — cuando haya que **cambiar un diseño ya cerrado**: versiona el
   contrato y regenera en cascada todos sus derivados. `keel describe <servicio>` dice en cualquier
   momento cuáles están al día y cuáles quedaron atrás.

## Diseñar un sistema completo

Todo el flujo de arriba tiene grano de **un servicio**: `/keel-design` parte de un servicio ya nombrado.
Cuando lo que llega es un encargo entero ("una plataforma de venta de billetes de avión"), falta una fase
previa que decida cuántos servicios hay, dónde está la frontera de cada uno, quién consume a quién y en
qué orden se construyen. Esto es esa fase, con ese encargo de ejemplo.

### 1. Descomponer el encargo

Deja el documento de requisitos en `docs/system/tdr.md` y ejecuta:

```
/keel-decompose docs/system/tdr.md
```

La sesión no empieza dibujando servicios. Primero extrae del encargo cinco inventarios —capacidades
(verbos), conceptos con ciclo de vida propio, actores, eventos de negocio y restricciones (dinero,
regulación, picos de carga)— y te los presenta para que confirmes. Ese paso es la mitad del valor: un
encargo siempre tiene huecos, y sacarlos ahora cuesta una pregunta; descubiertos después, cuestan un
servicio.

Después propone las fronteras. **Una frontera es una decisión tuya, no del agente**: el agente
recomienda una partición concreta con su consecuencia observable (qué pasa el día que uno de los dos
lados falle, qué transacción deja de ser una transacción) y tú decides. Es el mismo reparto de la
palabra que en `/keel-design` con outbox o idempotencia.

Al terminar tienes tres artefactos, y conviene no confundirlos:

| Artefacto | Qué es | Quién lo usa |
|---|---|---|
| `system.yaml` | **El dato**: qué servicios hay, quién consume a quién, qué es bloqueante. Fuente de verdad, validado con `schema/system.schema.json` | `keel system` y CI |
| `docs/system/SYSTEM.md` | **El porqué**: las decisiones de frontera con las alternativas descartadas, lo que queda fuera de alcance y los huecos del encargo | Personas |
| `docs/system/briefs/<servicio>.md` | **Un encargo por servicio**: su frontera, conceptos y capacidades candidatas, quién le consume, las integraciones acordadas | El diseñador de ese servicio |

Misma división que ya conoces un nivel más abajo: `specs/<servicio>/*.keel.yaml` es a `DESIGN.md` lo que
`system.yaml` es a `SYSTEM.md`.

### 2. Preguntar quién empieza

```
keel system
```

```
airline-ticketing — Venta y emisión de billetes de avión para web y app móvil.
Encargo: docs/system/tdr.md

Ola  Servicio        Estado       Consume de                Publica
───  ──────────────  ───────────  ────────────────────────  ────────────────────────────────────────────
1    flight-catalog  sin diseñar  —                         FlightScheduled, FlightCancelled
1    payments        sin diseñar  card-gateway (http)       PaymentCaptured, PaymentFailed, RefundIssued
2    fare-pricing    sin diseñar  flight-catalog (http)     —
2    seat-inventory  sin diseñar  flight-catalog (events)   SeatHeld, SeatReleased, SeatConfirmed
3    booking         sin diseñar  seat-inventory (http), …  BookingConfirmed, BookingCancelled
4    ticketing       sin diseñar  booking (events), …       TicketIssued
5    notifications   sin diseñar  booking (events), …       —

Externos (contrato en contracts/<servicio>/INTEGRATION.md, no se diseñan aquí):
  card-gateway — Pasarela de pago con tarjeta contratada por la compañía.

Aún no se pueden diseñar (falta el contrato de su proveedor):
  booking ← fare-pricing (sin contrato), payments (sin contrato), seat-inventory (sin contrato)
  fare-pricing ← flight-catalog (sin contrato)
  notifications ← booking (sin contrato), flight-catalog (sin contrato), ticketing (sin contrato)
  seat-inventory ← flight-catalog (sin contrato)
  ticketing ← booking (sin contrato), flight-catalog (sin contrato)

Se pueden diseñar ya
  keel new flight-catalog && /keel-design specs/flight-catalog
  keel new payments && /keel-design specs/payments
```

_(La columna «Consume de» va recortada con `…` para que quepa aquí; la salida real la imprime completa, y
además lista el mapa de contextos arista por arista con su estrategia.)_

No hay que deducir nada de la tabla: **«se pueden diseñar ya» y «aún no se pueden diseñar» lo dicen
literalmente**, con el comando ya resuelto y el motivo de cada espera.

Una **ola** es un grupo de servicios que se pueden diseñar **al mismo tiempo** porque ninguno espera
nada que aún no exista. Sale de una restricción concreta y no de una convención: el paso 2 de
`/keel-design` pide el `INTEGRATION.md` del proveedor, así que quien publica contrato va antes que quien
lo consume. Con eso, las olas son el orden topológico de las aristas marcadas `blocking` en el mapa:
la ola 1 son los que no esperan a nadie nuestro, y cada servicio cae en `1 + la ola más tardía de sus
proveedores`. El número de olas es la longitud de la cadena de dependencias más larga.

**Las olas se calculan, no se declaran**: no hay campo `wave` en `system.yaml`. Lo único que se declara
es `blocking`, y guardar además el resultado sería una segunda verdad que se desincroniza.

Ojo a la diferencia entre las dos cosas que ves ahí: la **ola** es estructural (sale del mapa y no cambia
mientras el mapa no cambie), mientras que **«se pueden diseñar ya»** es temporal — se mide contra la
realidad, comprobando si el `INTEGRATION.md` de cada proveedor existe y está al día. Un servicio de la
ola 2 no se desbloquea porque los de la ola 1 hayan terminado de diseñarse, sino cuando han **publicado
su contrato**.

### 3. Repartir el trabajo

Cada diseñador coge una línea de «Se pueden diseñar ya», lee su brief y arranca:

```
keel new flight-catalog                     # o --from registry:<diseño> si el brief lo indica
/keel-design specs/flight-catalog           # detecta docs/system/briefs/flight-catalog.md y arranca de ahí
```

Los dos servicios de la ola 1 se diseñan **a la vez, por dos personas distintas**. Eso es el punto de
todo el mecanismo: la ola no te dice en qué orden trabajar, te dice cuánta gente cabe trabajando ahora.

`/keel-design` encuentra el brief solo y arranca la entrevista desde él, pero **confirmando cada punto
en vez de asumirlo**: el brief es una hipótesis del sistema, no un spec. Trae candidatos a entidad y a
caso de uso, y una sección de «lo que decides tú» que enumera a propósito lo que sigue abierto
(idempotencia, caché, outbox, frontera transaccional, concurrencia, paginación).

### 4. Publicar el contrato al cerrar

```
/keel-integrate specs/flight-catalog
```

Es el paso que cierra el bucle, y el que se olvida: **lo que desbloquea al siguiente no es que tú
termines, es que publiques tu `INTEGRATION.md`**. Hasta entonces, quien te consume sigue apareciendo en
la lista de bloqueados.

### 5. Volver a preguntar

```
keel system
```

`flight-catalog` desaparece de los bloqueadores y `seat-inventory` y `fare-pricing` aparecen en «se
pueden diseñar ya». El equipo no consulta una hoja de ruta: consulta el estado, tantas veces como haga
falta.

### 6. Vigilar la deriva

```
keel system check
```

Es la **única comprobación cross-servicio** del método —`keel validate` no ve más allá de un servicio— y
sirve de puerta de CI. Cuatro barridos:

- **el mapa contra sí mismo** — aristas contra servicios no declarados, ciclos bloqueantes, eventos
  suscritos que el proveedor no dice publicar;
- **el mapa contra la realidad** — el `status` declarado frente al estado real de `specs/`, diseños que
  el mapa no conoce;
- **un diseño contra el mapa** — dependencias que el diseño declara y nadie planificó;
- **un diseño contra otro diseño** — que el proveedor publique de verdad, en su capa `messaging`, el
  evento que el mapa promete a su consumidor.

Cualquier hallazgo pone el comando en rojo, avisos incluidos: un mapa que no coincide con los diseños
miente igual que un `DESIGN.md` que quedó atrás. **Se corrige el mapa o se corrige el diseño**, nunca se
ignora.

### Si te toca un servicio bloqueado

Nada te lo impide, y es a propósito. `/keel-design` te pedirá el `INTEGRATION.md` que falta y
`/keel-consume` entrará en **modo degradado**: declara la dependencia igualmente, anota los huecos de
contrato y te los enumera al cerrar la sesión, con a quién hay que pedírselos. Saltarse el orden no
rompe nada — produce un diseño válido e **incompleto**, con la deuda escrita en vez de escondida. Es la
misma filosofía que `keel validate --wip`.

### Cuándo no hace falta nada de esto

Si el encargo tiene **una sola fuente de verdad**, el mapa correcto tiene un servicio y esta fase sobra:
ve directo al paso 1 de «Cómo trabajar aquí». Descomponer un problema que no lo pide sale caro — cada
frontera de más es una transacción que deja de serlo.

Referencia completa (el schema de `system.yaml` campo a campo, las heurísticas de frontera y los
antipatrones): `docs/system-decomposition.md`.
