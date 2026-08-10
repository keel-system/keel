# Informe de corrida — el fallback estrecho de los clientes HTTP

Corrida completa del pipeline sobre `catalog-extended` en un workspace externo al repo, para
verificar en vivo un cambio del generador que `INFORME-CORRIDA-OUTBOX.md` había dejado anotado y
sin tocar: **el fallback del circuit breaker capturaba `Throwable`**.

**Resultado**: 34 de 34 escenarios `FL-*` en OK **a la primera, cero ciclos de arbitraje** de un
cupo de 2. Las cinco familias de `check-idempotency.sh` en OK, `contextTest: OK`, `baseline: OK`.
Stack PostgreSQL 16 + Kafka + Redis + MinIO + WireMock sobre podman 5.8.3 en Windows, JDK 21.

## El problema

`fallbackMethod` de resilience4j declaraba `Throwable`, así que **cualquier** excepción del
adaptador entraba por el camino escrito para «el proveedor no responde»: un NPE, un
`ClassCastException`, un cuerpo que no deserializa. Con `onFailure: fail` eso se convertía en el
error de indisponibilidad que declara el diseño — el síntoma acusaba al tercero y la causa estaba
en casa. Es el patrón que mantuvo el defecto del punto 7 de la corrida anterior meses sin
diagnosticar, y ese arreglo tapó **una** de sus fuentes, no el embudo que las disfrazaba.

Había un segundo embudo, del mismo problema: la instancia
`resilience4j.circuitbreaker.instances.<x>` no emitía `record-exceptions` ni `ignore-exceptions`,
así que el default de resilience4j contaba **toda** excepción y un 4xx, un error de
deserialización o un NPE llenaban la ventana de fallos. La instancia `retry` sí discriminaba
desde siempre; el circuito no.

## Qué se cambió

### La tabla única (`src/lib/outbound-failures.js`, nuevo)

Es **una** pregunta contestada en **dos** sitios —las sobrecargas del fallback y el
`record-exceptions` del circuito—, así que la tabla vive en un módulo aparte que consumen
`scaffold/http-clients.js` y `scaffold/config.js`. Mismo criterio que `broker-probes.js`: si
divergieran, el circuito se abriría por excepciones que el fallback ya no ve.

Dos columnas, y **la asimetría es deliberada** — es justo lo que un refactor futuro
«unificaría» por error:

| Excepción | Al fallback | Cuenta para el circuito |
|---|---|---|
| `CallNotPermittedException` | sí (solo con circuito) | no — la lanza el propio circuito; contarla lo realimentaría consigo mismo |
| `ResourceAccessException` | sí | sí |
| `HttpServerErrorException` | sí | sí |
| `UnknownHttpStatusCodeException` | sí | sí |
| `HttpClientErrorException` (4xx) | sí, con log propio | **no** — contestar no es estar caído |
| NPE, cast, deserialización | **no** — se propagan | no |

El 4xx fue la decisión que más se discutió. Propagarlo crudo lo habría cruzado por `application`
(rompiendo la frontera hexagonal) y convertido en 500, poniendo en rojo todo escenario que hoy
afirma el error declarado — **sin ganancia**, porque un 4xx no es un bug nuestro *ni* una caída
ajena: es una respuesta con significado. Entra al fallback con su propia línea de log, y queda
fuera de la ventana del circuito para que un 401 por credencial caducada no acuse al proveedor de
lo nuestro.

### Las sobrecargas (`src/scaffold/http-clients.js`)

En vez de un `<call>Fallback(..., Throwable)`, una sobrecarga por entrada de la tabla, todas
delegando en un único `<call>Unavailable(..., Throwable)` donde `fallbackBody()` sigue
generándose **una sola vez**: N copias del cuerpo es la forma de que un día dejen de decir lo
mismo. Lo que ninguna sobrecarga acepta, resilience4j lo relanza — y esa propagación es la
función, no un hueco.

**Detalle que condiciona el diseño y que conviene no perder**: con **un solo** método de fallback
resilience4j entra por un atajo cuya semántica ha cambiado entre versiones (hoy comprueba el
tipo; antes invocaba siempre). Por eso se emiten **siempre ≥2**, incluso sin circuito. Con la
tabla nunca baja de cuatro.

## Dos defectos que aparecieron por el camino

### 1. El `@Retry` estaba muerto en toda llamada con circuit breaker

El orden de aspectos de resilience4j es `Retry(CircuitBreaker(llamada))`: Retry es el **externo**.
Como el `fallbackMethod` iba solo en `@CircuitBreaker`, el aspecto del circuito atrapaba la
excepción, ejecutaba el fallback y le devolvía al de retry **un valor normal** — que veía éxito y
no reintentaba nunca. El `maxAttempts` del diseño no se ejercía.

Peor: `references/implementation.md` afirmaba explícitamente lo contrario («el retry agota
intentos y, si el circuito abre, dispara el fallback»). Corregido, y el `fallbackMethod` movido al
aspecto externo.

Sin este arreglo, la corrida habría verificado en vivo una resiliencia que no existía.

### 2. Código muerto multiplicado por cinco

Un `fallback` en prosa sin `retry` ni `circuitBreaker` emitía un método privado que ninguna
anotación referenciaba. Con las sobrecargas serían cinco. `hasFallback` ahora exige que exista un
aspecto que lo dispare.

## Los tres escenarios nuevos

`FL-CMP-002/003/004`, sobre `compliance.recordWithdrawal` (`onFailure: fail` →
`COMPLIANCE_UNAVAILABLE`), y **ninguno necesitó primitivas nuevas del arnés**. Para materializar
el primero se bajó `slidingWindowSize` de 10 a 5 en el diseño de la fixture: se acorta el umbral,
no la semántica — igual que la corrida anterior bajó un cron a `* * * * *`.

- **`FL-CMP-002` — el circuito se abre.** Es la **primera vez que un circuito se abre en vivo** en
  una corrida de este repo. `CallNotPermittedException` no aparecía en ningún sitio del código
  generado y llegaba al fallback solo porque este declaraba `Throwable`: sin su sobrecarga, el
  primer circuito que abriera en producción le habría estampado al llamante una excepción cruda de
  resilience4j en vez del rechazo declarado. Era el fallo más caro posible de este cambio.
- **`FL-CMP-003` — un cuerpo que viola el contrato.** El escenario que separa el comportamiento
  nuevo del viejo, y el que reproduce la clase de defecto que motivó todo: un fallo de integración
  **nuestro** disfrazado de caída ajena. Su `Then` es deliberadamente incómodo — dice que la
  respuesta **no** puede ser `COMPLIANCE_UNAVAILABLE` y que un 500 es el resultado correcto.
- **`FL-CMP-004` — un 4xx.** No-regresión pura: el desenlace es idéntico al de antes, que es
  exactamente lo que compraba la decisión de seguir enrutándolo al fallback.

El agente de pruebas se anticipó a un riesgo que habría envenenado el arbitraje: el circuit
breaker vive en el contexto de Spring, que JUnit reutiliza entre clases, y `waitDurationMs`
sobrevive a `resetState()` — que vacía la base, no el estado del circuito. Sin nada, `FL-CMP-002`
podía dejar en 502 la primera retirada del flujo siguiente y el árbitro habría culpado al agente
equivocado. Puso un `@AfterAll` que cierra el circuito pasándole llamadas reales, que es la única
palanca que existe en caja negra.

## Lo que la corrida destapó y NO se arregló aquí

**Los mappers no comprueban los campos `required` de la respuesta.** El conversor JSON del
`RestClient` ignora las propiedades desconocidas, así que un cuerpo sin un campo declarado
`required: true` deserializa a `null` y el mapper fabrica un resultado de dominio con ese nulo
dentro: una respuesta que **viola el contrato** pasa por una correcta.

Lo destapó `FL-CMP-003`, que no era distinguible de una inscripción correcta hasta que el agente
de código añadió a mano una guarda en `ComplianceMapper.toRecordWithdrawalResult` — **un archivo
propiedad de build**. Que el arreglo caiga en un archivo build-owned es la misma señal que en el
punto 7 de la corrida anterior: el arreglo va en el generador.

Alcance real: las cuatro llamadas del diseño declaran todos sus campos de respuesta `required` y
solo una tiene guarda. Y la misma omisión está en código que build genera entero — la rama
`if (response == null)` construye el resultado con **todos** los campos a nulo y sigue, pese a que
ya imprime `"el contrato declara N campo(s)"`: build **tiene** la información en el momento de
emitir y no actúa sobre ella.

No se replicó en los otros tres mappers porque **cambiaría el desenlace observable** de esas
llamadas (un `amount` nulo pasaría de degradación silenciosa a 500). Es conductual, es del
generador, y merece su propia decisión — exactamente el mismo razonamiento por el que el fallback
`Throwable` no se arregló de propina en la corrida anterior.

## Verificación

- `npm test` en verde en los dos workspaces con los casos de regresión nuevos.
- Los tests **muerden**: se comprobó revirtiendo el código. La primera versión de la prohibición
  de `Throwable` **no mordía** —cazaba el nombre de la variable, así que `Throwable t` colaba— y se
  endureció para prohibir el tipo. Es la lección del punto 6 de la corrida anterior: un test que
  fija la forma defectuosa sale verde y no distingue nada.
- `compile-check` en verde para los tres brokers.
- **El adaptador compiló de verdad** dentro del pipeline (`./gradlew build -x test`), que es la
  única red real: `compile-check` solo compila el source set `integrationTest` y nunca toca `main`.

## Confirmaciones colaterales

- **El fallback a `podman-compose` de `infra/up.sh` se activó de verdad**: `podman compose ls`
  falló y el lanzador cayó al frontend alternativo. Es el arreglo de la corrida anterior,
  ejercitado por primera vez.
- `record-exceptions` y `retry-exceptions` como listas explícitas son lo que hace que la
  `IllegalStateException` de la guarda no se reintente, no llene la ventana y no la acepte ninguna
  sobrecarga. Los tres efectos son los que `FL-CMP-003` pide y ninguno es accidental.

## Nota de método

El pipeline se ejecutó desde una sesión externa al proyecto, así que los cuatro agentes se
lanzaron como genéricos con la obligación de leer su archivo de `.claude/agents/` y seguirlo. En
el pipeline nativo el candado es el `tools:` del frontmatter; aquí fue una instrucción. Además, el
agente de pruebas **portó** los siete flujos anteriores de una corrida previa del mismo diseño en
vez de volver a derivarlos: siguen siendo derivación del mismo documento y en caja negra, pero el
trabajo nuevo son los tres flujos `FL-CMP-002/003/004`, y es sobre esos donde el resultado
significa algo.
