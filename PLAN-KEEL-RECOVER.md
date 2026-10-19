# Plan de `keel-recover`: ingeniería inversa de un servicio existente

## Context

Keel hoy solo diseña hacia delante. Las entradas del método (`/keel-decompose`, `/keel-design`,
`/keel-consume`) empiezan siempre por un humano que describe lo que quiere. Falta la entrada inversa:
un servicio **que ya existe**, un legacy que no generó Keel o uno que se quiere refactorizar, del que
se quieren obtener **artefactos de diseño fieles** para validarlo con la puerta de Keel y regenerarlo
en cualquier tecnología con keel-spring, keel-nest o keel-dotnet.

Supuestos de partida, que son los del peor caso:
- solo se conoce la tecnología (por ejemplo Java 8 o Node 14), no la arquitectura;
- el humano puede no tener ese entorno instalado;
- puede no haber pruebas de integración ni documentación.

El primer paso de la implementación es copiar este plan a la raíz del repo como
`PLAN-KEEL-RECOVER.md`, para llevar su estado incremento a incremento, como `PLAN-KEEL-NEST.md` y
`PLAN-KEEL-DOTNET.md`.

## 0. Qué significa «fiel», y cómo se mide

«Fiel» no se afirma: se mide en dos ejes, y los dos tienen que salir en un informe al cerrar.

| Eje | Pregunta | Instrumento |
|---|---|---|
| **Corrección** | ¿Lo que dice el diseño es verdad del legacy? | Los escenarios `keep` se ejecutan contra el legacy en marcha y pasan |
| **Completitud** | ¿El diseño cubre todo lo que hace el legacy? | La cobertura de código del legacy bajo las sondas, más la lista de lo no observado |

Y cada elemento del diseño lleva su **procedencia**, con cuatro niveles de más a menos fuerte:

| Nivel | Origen | ¿Admitido en el diseño final? |
|---|---|---|
| `measured` | una grabación del sistema en marcha | sí |
| `read` | lectura del código, con `archivo:línea` | sí, marcado |
| `asked` | lo contestó el humano | sí |
| `inferred` | el agente lo supuso sin evidencia | **no**: se convierte en hueco declarado |

La última fila es la regla de oro de `/keel-consume` aplicada aquí: «un contrato inventado es un
diseño incorrecto que parece completo».

## 1. Principios

1. **La IA propone y lo determinista mide.** El agente construye el entorno, propone sondas e
   interpreta. La evidencia es siempre lo grabado del sistema en marcha. Cada bucle agéntico tiene
   un juez determinista y un **presupuesto** que lo cierra (el `MAX_PASSES` del careo es el
   precedente: un bucle sin tope no converge).
2. **El código del legacy no se toca.** Se monta en solo lectura. Lo que se adapta es el entorno
   (imágenes, mirrors, variables, stubs), y cada adaptación queda escrita con su motivo. Modificar
   el código sería caracterizar otro sistema.
3. **Lo no observado se declara, no se descarta.** La cobertura sin alcanzar y los mecanismos que
   las sondas no pueden disparar van a `unobserved.yaml` y se convierten en preguntas para el humano.
4. **Comportamiento observado no es decisión tomada.** Que el legacy no tenga idempotencia es un
   hecho. Si el servicio nuevo la tendrá, lo decide el humano. Toda decisión estructural sale
   `observed`, `omitted` o `contradicted`, y las `omitted` se preguntan con el protocolo de
   `/keel-design`: nada de defaults tácitos (`CHK-MODEL-IMPLICIT-DEFAULT`, criterio `structural`).
5. **El legacy, nunca en producción.** Las sondas disparan efectos (correos, cobros, llamadas a
   terceros). El runtime corre **sin salida a internet**, y eso lo comprueba el juez, no la buena fe.
6. **La frontera del DSL se declara.** Lo que el legacy hace y el DSL no puede decir (lógica en
   triggers, sesiones con estado, colas con orden global) va a una lista de rechazos con su motivo,
   como `supported-features.js` en los generadores.

## 2. Dónde vive

Un paquete nuevo, **`packages/keel-recover`** (CLI `keel-recover`), que depende de `keel-core`.

- **No va en keel-core** porque lleva adaptadores por tecnología del legacy (Maven, Gradle, npm…) y
  orquesta contenedores. Eso es de la misma naturaleza que un generador, no del núcleo del DSL.
- **Escribe en el workspace de diseño**: `legacy/<servicio>/` (sandbox y evidencia) y
  `specs/<servicio>/`. Es una **entrada** al diseño, no un generador, así que la regla «un generador
  nunca siembra en el workspace» no aplica. Igualmente lo dejo escrito en `CLAUDE.md`, porque es la
  primera excepción.
- Su skill `/keel-recover` vive en `packages/keel-recover/assets/skills/` con frontmatter neutral y
  tokens `{{keel:…}}`, y se proyecta con `emitHarnessFiles()` de `keel-core/src/lib/harness.js`.
- La procedencia va en un archivo lateral `specs/<servicio>/provenance.yaml`. Lleva fila en
  `SPEC_SIDE_FILES` (`keel-core/src/lib/spec-files.js`), y **no viaja ni al publicar ni al derivar**,
  porque cita rutas de un código privado.

## 3. El flujo

### Paso 0. Sandbox: levantar el legacy donde el humano no puede

| Sub | Qué | Quién |
|---|---|---|
| 0a | **Huella del runtime**: versión del lenguaje y de la herramienta de build, empaquetado y servidor de aplicaciones, leídos de `pom.xml`, `build.gradle` + wrapper, `package.json#engines`, `.nvmrc`, `.tool-versions`, `lockfileVersion` y un Dockerfile si existe. Sale `runtime.yaml` con `archivo:línea` | determinista |
| 0b | **Dependencias externas**: grep de lo que el código lee del entorno (`System.getenv`, `process.env`, `@Value`, `application*.yml`, `.env.example`). Clasificación: base o broker → su contenedor; tercero HTTP → WireMock; SMTP → Mailpit; desconocido → pregunta | grep determinista + agente |
| 0c | **Dockerfile multi-etapa** con la cadena antigua (`maven:3.6-jdk-8`, `node:14`), medidor de cobertura (JaCoCo, c8/`NODE_V8_COVERAGE`) e imágenes fijadas por digest, más `compose.yaml` con lo de 0b | agente |
| 0d | **Bucle de build** con presupuesto. Fallos conocidos: Maven por http o jcenter desaparecido (mirror en `settings.xml`), npm despublicado, `node-gyp` con python2, Debian EOL (`archive.debian.org`), registro privado (credenciales del humano). Cada adaptación queda en `environment.yaml` con su motivo | agente |
| 0e | **Bucle de arranque** con presupuesto: variables que faltan, esquema (las migraciones de la app; si no hay, un dump del humano) y seed (derivado del esquema y sus FK, o un dump anonimizado) | agente + humano |
| 0f | **Juez** `keel-recover verify`: la app responde sin 5xx, está conectada a la base, la cobertura graba y **el runtime no tiene salida a internet**. Si pasa, toma el snapshot de la base | determinista |

**Se rechaza con su motivo** lo que no se puede contenerizar: .NET Framework sobre Windows,
middleware con licencia (WebLogic, IBM MQ) y mainframes.

### Paso 1. Observación

- **1a. Introspección** (determinista). Rutas con su handler (`/actuator/mappings`, la tabla del
  router, ApiExplorer), `information_schema` (tablas, únicos, FK, índices, valores distintos de las
  columnas de estado) y la API del broker (exchanges, colas, bindings, listeners). Sale
  `surface.yaml`.
- **1b. Exploración por rondas**, con presupuesto:
  1. El agente lee **solo** los handlers y DTO que nombra `surface.yaml` (y las ramas sin cubrir) y
     escribe `probes/round-N.yaml`. La forma de cada petición se descubre por el DSL del framework
     si existe (OpenAPI, springdoc), por el DTO o por los 400 del propio legacy.
  2. `keel-recover probe` restaura el snapshot, envía la petición o publica el evento, espera a que
     el sistema esté quieto y graba, todo normalizado (ids, fechas, orden):
     - la respuesta;
     - el diff de la base;
     - los mensajes que caen en colas espía;
     - las llamadas que recibe WireMock;
     - el correo de Mailpit.
  3. Se vuelca la cobertura de la ronda.

  El bucle para cuando la cobertura se estanca o se agota el presupuesto.
- **Sondas de clase**, que cubren lo que una petición suelta no ve:

  | Qué | Cómo se sondea |
  |---|---|
  | Autorización | La misma sonda con cada rol de las credenciales de prueba, y sin token |
  | Concurrencia | Dos sondas iguales en paralelo: ¿409, último gana o duplicado? |
  | Repetición | La misma sonda dos veces: ¿idempotente? |
  | Ciclo de vida | Cada transición sobre cada estado observado en la columna de estado |
  | Fallo saliente | WireMock en 500 y en timeout |
  | Broker caído | La sonda con el broker parado: ¿se pierde el evento? (outbox o best-effort) |

  Lo que no se puede disparar desde fuera, como un `@Scheduled` o un cron, se encuentra por lectura
  (`read`) y va a `unobserved.yaml`, salvo que el humano permita acelerarlo o invocarlo.

### Paso 2. Partir un monolito, si lo es

`/keel-decompose` con `surface.yaml` y las grabaciones como insumo. Los grupos de tablas por FK y las
rutas que las escriben sugieren las fronteras, y una base compartida entre esas fronteras es un
hallazgo de `system.yaml`. El humano confirma. Después se ejecuta un `/keel-recover` por servicio.

### Paso 3. Recuperar el diseño (`/keel-recover specs/<servicio>`)

Las capas se escriben en el orden de `/keel-design`, cada elemento con su procedencia en
`provenance.yaml`. La correspondencia es directa:

| Evidencia | Elemento del DSL |
|---|---|
| Diff de la base | entidades, agregados (filas que cambian juntas en una sonda) e `indexes` |
| Valores de la columna de estado + transiciones sondeadas | `lifecycle` |
| Mensajes en las colas espía | `emits` y eventos de `messaging` |
| Llamadas a WireMock | `dependencies` y `http-clients`, por el modo degradado de `/keel-consume` |
| Sondas por rol | `security` |
| 4xx observados | `errors` con su `code` y su `http` |
| Sondas de clase | las decisiones estructurales `observed`/`omitted`, en `decisions.yaml → structural:` con `origin` y `evidence` |

La lógica que el código tiene y el DSL solo puede escribir en prosa va a `rules`/`invariants`, con
la referencia al código.

### Paso 4. Caracterizar

Las grabaciones pasan a `validation-scenarios.md` como escenarios de caracterización. Cada uno lo
marca el humano:
- **`keep`**: el servicio nuevo tiene que hacer lo mismo.
- **`fix`**: es un defecto que se corrige a propósito, con su entrada en `decisions.yaml`.

Para un refactor, la lista de `fix` **es** su backlog.

### Paso 5. Medir la fidelidad

- Los escenarios `keep` se ejecutan contra el sandbox del legacy, con la colección de `/keel-docs` y
  el ejecutor de sondas. El bucle vuelve a los pasos 3 y 4 hasta que todos pasen, con presupuesto.
- **Sale** `legacy/<servicio>/FIDELITY.md`:
  - los `keep` en verde;
  - la cobertura final;
  - el reparto de procedencias (cuántos `measured`, `read` y `asked`, y ningún `inferred`);
  - lo no observado;
  - los rechazos por la frontera del DSL.
- El criterio nuevo **`characterized`** de `keel validate --ready` exige esa ejecución en verde,
  sellada con el hash de los escenarios, como el careo.

### Paso 6. Cierre y regeneración: lo que ya existe

`keel validate --ready` hasta 10/10 (análisis de huecos, careo, `DESIGN.md`). Después,
`keel-<tech> build` → `cd` → `/keel-generate-<tech>`.

### Paso 7. Paridad con el legacy

`keel-recover probe` ejecuta las **mismas sondas** contra el servicio regenerado y compara las
grabaciones con las del legacy: respuestas **y** efectos (las filas, los eventos y las llamadas
salientes). El resultado esperado es igual en los `keep`, con la diferencia declarada en los `fix`.
Se registra en `docs/corridas/`.

**Queda fuera de este plan:** migrar los datos y el corte de tráfico (estrangulamiento o cambio de
golpe).

## 4. Incrementos

| # | Qué | Puerta |
|---|---|---|
| 0 | Copiar este plan a `PLAN-KEEL-RECOVER.md` | — |
| 1 | **Prueba manual, sin código**: pasos 0, 1, 5 y 7 a mano sobre dos legacys reales (uno Java 8 + Maven, uno Node 14), regenerando uno con keel-dotnet | Corrida en `docs/corridas/` con intentos de 0d/0e, adaptaciones, cobertura por ronda, `keep` que fallan la primera vez y la tabla de paridad. **Decide si el paso 0 es viable antes de construirlo** |
| 2 | Paquete `keel-recover`: `fingerprint` (0a) y `env-deps` (0b) con adaptadores Java/Maven, Java/Gradle y Node; schemas `runtime`/`environment` fuera del DSL | Deterministas byte a byte sobre fixtures de legacy mínimas (`fixtures/legacy/java8-maven`, `node14`) |
| 3 | Skill del sandbox (0c–0e) + `verify` (0f) | `verify` falsado: rojo con salida a internet, con cobertura vacía y con 5xx |
| 4 | `introspect` (1a) + `probe` (1b): restauración, captura de efectos, normalización y cobertura. Reutiliza WireMock, Mailpit, `keel-core/src/lib/gen/broker-probes.js` y la `infra/` neutral | Una app legacy de fixture, en vivo como los `*-check`: cada efecto capturado y uno saboteado por tipo (por ejemplo, la cola espía sin enlazar sale en rojo) |
| 5 | Skill `/keel-recover` (pasos 3 y 4) + `provenance.yaml` (fila en `SPEC_SIDE_FILES`) + `origin`/`evidence` en `structural-register.js` | `npm test` en keel-core; un `inferred` en el diseño final sale en rojo |
| 6 | Criterio `characterized` en `readiness.js` + `FIDELITY.md` | `test/readiness.test.js`: romper el sello apaga `characterized` y solo ese criterio |
| 7 | Paridad legacy ↔ regenerado (paso 7) | La corrida de control del incremento 1, repetida con la herramienta: la misma tabla |

## 5. Riesgos

- **El paso 0 puede costar más que todo lo demás.** Por eso el incremento 1 lo mide antes de invertir.
- **La cobertura alta no es fidelidad.** Una línea ejecutada no es un comportamiento afirmado. La
  completitud la da la cobertura, y la corrección solo la dan los escenarios `keep` en verde. Por
  eso se miden los dos ejes.
- **No determinismo del propio legacy** (reloj, orden, aleatorios). La normalización lo absorbe, y lo
  que no se pueda normalizar se declara.
- **Seguridad del build.** Un legacy trae dependencias viejas con CVE y scripts de `postinstall`. El
  build corre aislado y el runtime sin red externa. Nunca se usan secretos de producción.

## Verificación

- El incremento 1 deja una corrida con la tabla de paridad legacy ↔ regenerado: los mismos `keep` en
  verde en los dos servicios, y `FIDELITY.md` escrito a mano.
- Del incremento 2 al 7, cada uno cierra con su puerta de la tabla del §4 y con `npm test` en verde
  en todo el monorepo.
