# validation-scenarios.md — escenarios de validación del servicio

Formato del artefacto `specs/<servicio>/validation-scenarios.md`: escenarios de aceptación ejecutables (Given/When/Then) derivados del diseño. Es el **contrato de validación de la fase de generación**: el agente del generador lo usa para derivar tests de integración y para ejecutar los escenarios contra el servidor generado en marcha.

Lo produce `/keel-design` como paso final del cierre del diseño, y se regenera cada vez que el spec cambia. Es un artefacto **derivado**: todo (rutas, payloads, códigos de error, estados, eventos) se copia exacto de los artefactos YAML — nunca inventa contrato que no esté en el diseño.

## Por qué existe: contrato de equivalencia

Un diseño Keel puede generar servidores en tecnologías distintas (stacks distintos de framework, base de datos, broker o proveedor de auth). Este archivo es lo que garantiza que **todos esos servidores sean equivalentes**: no que compartan código —no lo comparten—, sino que se comporten igual ante la misma llamada. También es el único gate funcional de la generación: el flujo de generación no produce pruebas unitarias, y la aceptación es el 100% de estos flujos ejecutados contra el servidor real.

Por eso vale la regla que gobierna todo lo demás:

> **Si dos servidores generados del mismo diseño con stacks distintos pudieran diferir en algo observable y el escenario no lo fija, el escenario está incompleto.**

Lo que no fija el escenario lo decide cada generador por su cuenta —el orden de una lista, el formato de una fecha, si un campo vacío viaja como nulo o no viaja— y esas decisiones divergen. Un escenario que solo comprueba `201 Created` da por bueno cualquier cuerpo de respuesta.

## Estructura del archivo

```markdown
# <servicio> — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/<servicio> v<service.version>. Contrato de validación para la fase de generación.

## Convenciones de determinación

<Las convenciones transversales del servicio: formato temporal, escala decimal,
ausencia vs nulo, colación, forma del cuerpo de error. Ver § Determinación observable.>

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| createProduct  | FL-PRD-001 | usuarios |
| getProductPrice | FL-PRD-010 | **servidores (M2M)** |
| ...          | ...   | ... |

> La columna **Superficie** marca los endpoints expuestos a otros servidores
> (`audience: services`/`both`) para que su cobertura como contrato servidor-a-servidor
> sea visible de un vistazo. Omítela si el servicio no expone ninguno.

## <Agrupación natural (p.ej. por entidad o agregado)>

### FL-XXX-NNN: <título en lenguaje de negocio>

**Given**: ...
**When**: ...
**Then**:
1. ...
2. ...
**Orden de evaluación**: ...
**Ramas condicionales**: ...
**Casos borde**: ...
**Notas de determinación**: ...
```

La línea `> specs/<servicio> v<service.version>` es el **sello de frescura** del archivo, no una
cita de cortesía: `keel describe <servicio>` la compara con el manifiesto para detectar que los
escenarios nacieron de una versión anterior del diseño, y `/keel-evolve` decide con ella qué
regenerar. Se actualiza en cada regeneración.

## Aislamiento y orden de ejecución

El **flujo** (`FL-*`) es la unidad de aislamiento:

- El ejecutor **resetea el estado antes de cada flujo**, no entre escenarios.
- Los escenarios **dentro** de un flujo se ejecutan **en orden** y pueden encadenar estado: el primero crea los datos que los siguientes verifican. Un escenario puede dar por hecho lo que dejó el anterior **de su mismo flujo**.
- Cada flujo es **auto-contenido**: ningún `Given` puede depender de la ejecución de **otro** flujo. Tras el reset, ese estado no existiría.
- El estado previo de un flujo se alcanza **por la propia API** (o por los datos de arranque que el diseño declare). Si un `Given` describe un estado al que ninguna operación puede llegar, no es un escenario: es un hueco del diseño.

Escribir los escenarios asumiendo aislamiento por escenario los vuelve repetitivos y lentos; asumir dependencias entre flujos los vuelve inejecutables. El punto medio —flujo auto-contenido, escenarios encadenados dentro de él— es el contrato.

## Determinación observable

Lo que cada escenario debe fijar porque dos stacks lo resolverían distinto. Las convenciones que valen para **todo el servicio** se declaran una vez en `## Convenciones de determinación` y no se repiten; las que son propias de un escenario van en su campo **Notas de determinación**.

> Estas convenciones son **vinculantes para el generador**: no son preferencias de estilo que el código pueda resolver de otro modo. Un generador que no sepa honrar alguna tiene una sola salida legítima —declararlo (rechazar el diseño o avisar en el build de qué produce en su lugar, como hace `supported-features.js` en keel-spring)— y nunca ignorarla en silencio. Al revés también vale: hay decisiones que un generador concreto fija y el diseño no puede cambiar (en keel-spring, la **forma** del sobre de error). Antes de escribir las convenciones, comprobar contra la documentación del generador elegido cuáles son suyas, y escribirlas acordes; una convención que contradice al generador es un ciclo de corrección garantizado.

- **Respuesta completa, siempre.** El `Then` verifica el **cuerpo completo** de la respuesta —qué campos vienen, qué campos no vienen, de qué tipo—, no solo el status. Vale para toda superficie, no solo la M2M.
- **Ausencia vs nulo.** Un campo sin valor, ¿no aparece en la respuesta o aparece como nulo? Convención única de servicio; el `Then` dice cuál de las dos y la respeta.
- **Orden de las colecciones.** Toda respuesta con lista declara el orden esperado, o dice explícitamente que el orden es indiferente. Sin esto, dos motores devuelven órdenes distintos y ambos "pasan". Si el campo de orden puede empatar, el orden se declara **total** (criterio de desempate).
- **Fecha y hora.** Formato y zona (instante en UTC ISO-8601 vs fecha local), y qué zona usa el negocio para "hoy". Los valores no deterministas (marcas de tiempo de servidor) se verifican **por forma o por rango**, jamás por valor exacto.
- **Identificadores generados.** Se verifican por su forma y por reutilización simbólica —el id devuelto en un escenario es el que usa el siguiente del flujo—, jamás por valor literal.
- **Números y dinero.** Escala decimal y regla de redondeo del resultado esperado. `10 / 3` no da lo mismo en todos los motores.
- **Mayúsculas y acentos.** El escenario que prueba una colisión de unicidad o una búsqueda dice si `ACME` colisiona con `acme`.
- **Forma del cuerpo de error.** El servicio tiene **una** forma de error: se fija una vez en las convenciones (qué campos lleva) y los escenarios solo especifican el `code` y el status. Suele venir impuesta por el generador —keel-spring emite siempre `{timestamp, status, error, code, message, details}` más `correlationId`—, así que se **describe** la del generador elegido en vez de inventar otra.
- **Status HTTP de todo error.** Todo error del escenario lleva su status. Si `errors[].http` no está en el diseño, es un **hueco: se cierra en el YAML antes de escribir el escenario**, no se decide aquí. Un mismo `code` con status distinto según la operación debe estar declarado en ambas.
- **Cabeceras del contrato.** `Location` en las creaciones, cabeceras de paginación, y las de concurrencia si el diseño las contempla.
- **Idempotencia.** Distingue los dos ejes, porque se ejercitan de forma distinta. *Reintento del llamante HTTP* (`use-cases.<op>.idempotency`): qué clave se envía en la cabecera, qué devuelve el reintento con la **misma** clave (mismo status y mismo cuerpo, sin segundo efecto) y qué ocurre con clave distinta y mismo contenido. *Reentrega de un evento* (`contract.messageId` o una `transitions` irrepetible): se reentrega el mismo mensaje y se afirma que no hay segundo efecto observable — no hay cabecera que enviar, y por eso el escenario se escribe contra el canal, no contra la API. Y un tercer eje, **simultáneo**, que no es lo mismo que la repetición secuencial y no la sustituye: dos peticiones con la misma clave, o dos entregas del mismo mensaje, **a la vez**. La repetición secuencial encuentra el registro ya commiteado; la simultánea cae en la ventana en la que aún no lo está, que es donde vive el fallo real y donde el servicio replicado pasa la mayor parte de su vida. Se escribe como una carrera (ver **Concurrencia**) y su `Then` no depende de quién gane: el efecto observable por la API es exactamente uno.
- **Concurrencia.** Si el diseño contempla actualizaciones concurrentes, un escenario ejercita dos mutaciones sobre la misma entidad y fija el resultado esperado (conflicto declarado vs último gana). Con **último gana**, la fuente de verdad del ganador es el **estado final leído por la API**, y el `Then` se escribe como una disyunción cerrada ("el `name` final es `A` o `B`, y el resto de campos es coherente con el ganador"). Lo que **no** vale es cruzar dos observaciones distintas para deducir quién ganó —comparar el estado final contra el orden de los eventos publicados, o contra una marca de tiempo estampada por el dominio *antes* del commit—: bajo una carrera real esos dos órdenes no tienen por qué coincidir, y el escenario sale no determinista entre corridas sin que nada esté roto. Si el diseño quiere un ganador determinista, no lo resuelve el escenario: lo resuelve declarando el conflicto (bloqueo optimista con su error). La misma forma vale para las otras dos carreras que el servicio tiene que sobrevivir —dos peticiones con la misma clave de idempotencia, dos entregas del mismo mensaje—, y en las tres el `Then` necesita, además de la disyunción, **al menos una afirmación que no dependa del ganador**: normalmente un conteo leído por la API. Un `Then` que solo enumera desenlaces admisibles no puede fallar.
- **Observable por la superficie pública.** Toda afirmación del `Then` se comprueba llamando a la API, consultando por la propia API el estado resultante o escuchando el canal de eventos — **nunca** inspeccionando el almacenamiento interno. Inspeccionar la base de datos sirve para *diagnosticar* un fallo, jamás para *definir* el criterio de aceptación: lo que solo es verificable por dentro no es contrato.

## Reglas de cobertura

- **Toda operación de `use-cases.keel.yaml` aparece en la matriz** con al menos un flujo. Una matriz incompleta significa diseño sin cerrar.
- Cada `command` cubre su camino feliz **y cada `error` declarado** (como paso del orden de evaluación o como caso borde, con su `code` y status HTTP exactos).
- **Todo command con más de un error declara su orden de evaluación**, y al menos un escenario demuestra la **precedencia**: con dos guardas fallando a la vez, cuál de los dos errores ve el cliente. El orden de las guardas no existe como dato estructurado en el DSL — estos escenarios son lo único que lo fija.
- Cada transición de `lifecycle` relevante tiene escenario (y al menos un caso borde de transición inválida). **Todo estado del `lifecycle` es alcanzado por algún flujo**: un estado que ningún escenario alcanza no está validado, y probablemente no esté implementado. Si la operación declara `transitions`, el caso borde es literal: aplicarla desde un estado que **no** está en su `from` y verificar el rechazo con su status.
- **Si el diseño declara `dependencies: compensations`**, cada compensación tiene **tres** escenarios, y ninguno es opcional: (1) llega el evento de fallo y se verifica el efecto completo —el trabajo deshecho **y el estado propio devuelto**, leyéndolo por la API; y si lo que se deshace se le encargó a un proveedor por un cliente saliente, **también la llamada de vuelta que lo cancela**, con su método, su ruta y los campos del cuerpo que identifican el encargo—; (2) **el mismo evento se reentrega** y el `Then` afirma que no hay segundo efecto; y (3) **el mismo evento se entrega dos veces a la vez** y el `Then` afirma lo mismo. El tercero no es el segundo con otras palabras: la reentrega secuencial encuentra la marca de procesado ya escrita, y la simultánea cae en la ventana en la que todavía no lo está — que con varias réplicas es el caso frecuente, no el raro. La llamada de vuelta tampoco es un adorno: el estado propio leído por la API es solo **la mitad de la compensación**, y es la mitad barata. Un servicio que revierte su fila y nunca avisa al proveedor queda internamente coherente y deja fuera un encargo vivo que nadie va a cancelar — y ese desacuerdo no es observable en ningún `Then` que solo mire hacia dentro. Una compensación es lo que se ejecuta cuando algo ya salió mal, por un canal que reentrega: es la parte del servicio con menos probabilidad de ejercitarse a mano y más coste si está rota. Por eso es de las pocas reglas de cobertura que **comprueba `keel validate`** (ver § Lo que se comprueba solo): busca escenarios que mencionen el `onEvent` de la compensación y, entre ellos, uno que lo reentregue y otro que lo entregue por duplicado a la vez, y avisa si no los encuentra.
- Cada evento de `emits` aparece en el **Then** del escenario que lo publica, con su nombre, su payload relevante y —si el diseño lo declara— el `channel` de messaging por el que se emite.
- **Si el diseño declara `messaging: reliability: outbox`**, un escenario ejercita la garantía que ese campo compra y ningún otro escenario alcanza: **el evento sobrevive a un canal indisponible**. Se escribe en dos tiempos, con el canal caído y luego restablecido:

  ```
  ### FL-OBX-001: el evento sobrevive a un canal indisponible
  **Given** el canal `orders` sin mensajes y el canal de eventos indisponible
  **When** se ejecuta `createOrder` con un payload válido
  **Then**
  1. status `201` con el cuerpo completo de la creación — la indisponibilidad del canal no llega al cliente
  2. el pedido es legible por la API con su estado inicial
  3. el canal `orders` no ha recibido ningún mensaje todavía
  **When** el canal vuelve a estar disponible
  **Then**
  4. en <= 10 s el canal `orders` recibe **exactamente un** `OrderCreated`
  5. su payload es el del pedido creado, y su `correlationId` el de la petición del paso anterior
  ```

  Las dos aserciones que hacen que este escenario no pueda pasar por accidente son la **3** y el «exactamente uno» de la **4**, y conviene saber a qué implementación mata cada una. La 3 separa el outbox de publicar directamente contra el canal dentro de la operación: sin ella, un servicio que publica en línea pasa el escenario entero —el mensaje también acaba llegando— y la garantía queda sin probar. El «exactamente uno» separa un relay que marca lo entregado de uno que no: el segundo reentrega para siempre y sin esa palabra pasaría igual. Un escenario que solo afirme «el evento acaba en el canal» es decorativo: lo cumple cualquier servicio que emita eventos, con outbox y sin él. Y hay una tercera aserción que cabe en cualquier escenario del outbox y que conviene añadir siempre: que el servidor **no se haya rendido con ningún evento**. Un relay que entrega tarde es correcto; uno que agota sus reintentos ha perdido el evento, y con el canal ya restablecido los dos se parecen mucho — el mensaje que aparece es el del flujo siguiente. En keel-spring esa cuenta sale por el actuator (`keel.outbox.dead_lettered`), y el escenario la nombra como lo que es —«ningún evento abandonado»—, nunca por el nombre de la métrica, que es del generador.

  Es una de las **dos** reglas de esta sección que exigen tocar la infraestructura —la otra es la del barrido, justo debajo—, y es deliberado: el mecanismo consiste precisamente en no depender de que el canal esté disponible, así que la única forma de observarlo es quitarlo de en medio. El escenario habla del **canal lógico** («indisponible»), nunca del broker concreto ni de cómo se detiene: eso es del generador.

  Y **un segundo escenario**, que es el otro desenlace del mecanismo y el único que pierde datos:
  **el evento que el relay abandona**. Cuando agota su presupuesto de reintentos, la fila deja de
  reclamarse y se queda ahí — el barrido de retención no la borra, porque solo borra lo publicado —,
  así que el evento no sale nunca. El escenario del canal indisponible no lo cubre: allí el evento
  acaba saliendo. Y afirmar «ningún evento abandonado» en los demás tampoco, porque eso comprueba
  el caso bueno.

  ```
  ### FL-OBX-002: el evento que el relay abandona no se pierde en silencio
  **Given** el canal indisponible y una mutación ya ejecutada, con su evento pendiente de salir
  **When** se agota el presupuesto de reintentos de ese evento
  **Then**
  1. el servidor lo dice: informa de **un** evento abandonado
  2. restablecido el canal, ese evento **no** se publica — el relay respeta que se rindió
  3. y el canal no recibe ninguna otra cosa
  ```

  El punto 2 es el que lo hace algo más que una prueba de la señal: sin él, un relay que ignorase
  su propio presupuesto reintentaría para siempre una fila ya dada por perdida, y el escenario
  pasaría igual. El escenario habla del **presupuesto de reintentos**, nunca del número ni del
  nombre de la métrica: los dos son del generador.

- **Si una operación con `schedule` saca filas de un estado EN VUELO** —uno al que alguna
  transición del lifecycle llega— no está vaciando una cola: está tomando filas en las que otra
  réplica puede estar trabajando. Eso solo es correcto con una cota temporal, y la cota exige
  **dos** escenarios.

  ```
  ### FL-RSC-001: se rescata lo que otra réplica dejó a medias
  **Given** una fila en el estado en vuelo, con su reloj más atrás que el plazo tolerado — el
  estado exacto en que queda una réplica que murió con ella en la mano
  **When** pasa un ciclo del barrido
  **Then**
  1. la fila avanza al estado siguiente;
  2. el trabajo que se perdió se vuelve a encargar (el mensaje sale **exactamente una vez**);
  3. **ninguna fila queda en vuelo con el reloj sin estampar**

  ### FL-RSC-002: lo que acaba de entrar en vuelo NO se toca
  **Given** una fila en el mismo estado, con el reloj a **ahora**
  **When** pasan dos ciclos del barrido
  **Then** sigue igual, su reloj no ha cambiado, y no se ha encargado nada
  ```

  El segundo es el que importa: un rescate sin cota pasa el primero sin despeinarse y falla aquí,
  y su modo de fallo en producción no es un error — son dos réplicas haciendo el mismo trabajo a
  la vez. El punto 3 del primero cubre el instante ANTERIOR, que ningún escenario mira: si el
  reclamo mueve el estado sin estampar el reloj, la fila queda irrescatable para siempre.

  El `Given` no espera el plazo real ni lo baja: pone la fila en ese estado con el reloj que toque
  (en keel-spring, `stallInFlight(...)` y `putInFlight(...)`). El **plazo** es del generador; el
  **reloj** lo declara el diseño, y sin él no hay rescate que generar.

- **Si una activación declara `reconciledBy`**, un escenario ejercita el desenlace que no produce ningún hecho:
  el encargo sale, **nadie contesta**, y el barrido se rinde. Es la garantía que ese campo compra y ningún otro
  escenario alcanza — el camino feliz y la compensación cubren los dos desenlaces que SÍ llegan.

  El `Given` no espera el plazo real ni lo baja por configuración: fabrica el silencio **para esa fila**
  (en keel-spring, `ageForReconciliation(<activación>, id)`). El cron sigue disparando solo.

  ```
  ### FL-REC-001: el encargo que nadie contesta se suelta
  **Given** un pedido en `awaitingStock`, con su encargo ya publicado y el canal purgado
  **When** su marca de espera lleva más de `unansweredAfterSeconds` y pasa un ciclo del barrido
  **Then**
  1. el pedido queda en `released` con su motivo, legible por la API
  2. el canal recibe **exactamente un** `StockReservationCancelled` — rendirse tiene dos mitades, y sin esta
     el almacén se queda con stock bloqueado para un pedido que ya no existe
  3. un segundo ciclo del barrido no vuelve a soltarlo ni publica un segundo mensaje
  ```

  El punto 3 no es adorno: es lo que distingue un barrido que **reclama** de uno que **lee**, y el único que lo
  ve desde fuera. Un barrido que lee vuelve a encontrar la misma fila en cada pasada.
- **Si el diseño declara `messaging: subscriptions`**, cada suscripción tiene al menos un escenario que valida su **consumo**: **Given** el estado previo, **When** llega un evento entrante por su `channel`/`source` declarado con un payload de ejemplo, **Then** se ejecuta la operación `triggers` y se producen sus efectos observables. Además, un **caso borde de fallo** ejercita la política `onFailure`: reintentos (`retry`) y, si `deadLetter: true`, el envío del mensaje a la DLQ tras agotarlos. Y **si la suscripción declara cualquier guarda contra la reentrega** —`contract.messageId`, la envoltura `keel` (que ya trae `metadata.eventId`, así que la guarda existe sin declarar nada) o una transición de lifecycle irrepetible—, un escenario **entrega otra vez el mismo `messageId`** y verifica que **no** hay segundo efecto observable. Con `messageId` distintos son dos hechos distintos, y un escenario así pasa contra un consumidor que no deduplica nada. No es una regla de las compensaciones: el canal es at-least-once para todas las suscripciones, y la guarda declarada es una promesa que sin ese escenario no comprueba nadie —el gate del generador mira la FORMA del listener, no el efecto—. Lo comprueba `keel validate` (ver § Lo que se comprueba solo). La doble entrega **simultánea** sigue exigiéndose solo a la compensación, donde deshacer dos veces cuesta lo que cuesta.
- **Si una operación declara `schedule` y ACTÚA sobre lo que encuentra** —mueve el lifecycle, publica, o dispara una activación—, tiene además un escenario de **clúster**: dos instancias vivas y varias filas candidatas, con un `Then` que cuenta el efecto externo **recibido** y afirma que ocurrió **exactamente una vez por fila**. `@Scheduled` no es «una vez en el clúster», es «una vez por instancia»: sin reclamo, las N réplicas se llevan las mismas filas y cada una actúa. Es la única propiedad que ningún escenario de una sola instancia distingue — con una réplica, reclamar y leer dan el mismo resultado—, y el gate del generador solo puede mirar la FORMA del reclamo, no que reparta. Tres detalles que no son adorno: **varias filas y no una**, porque con una sola la ventana en que las dos réplicas coinciden es tan estrecha que el escenario pasaría por suerte; el efecto **recibido** y no su consecuencia, porque con idempotencia saliente declarada el proveedor absorbería los duplicados y los escondería; y una fila de **control** que no cumple la condición, que es lo que separa «reclamó bien» de «se lo llevó todo». Las purgas quedan fuera: borrar lo caducado dos veces es borrarlo una. Lo comprueba `keel validate` (ver § Lo que se comprueba solo), buscando un escenario que **nombre la operación** y hable de dos réplicas.
- **Si una operación declara `idempotency`**, tiene **dos** escenarios y el segundo no es una variante del primero: (1) el **reintento secuencial** con la misma clave devuelve el mismo status y el mismo cuerpo sin segundo efecto, y con clave distinta y mismo contenido sí produce un segundo recurso; (2) **dos peticiones con la misma clave a la vez**, escrita como carrera (ver § Concurrencia). El `Then` de la segunda es una disyunción cerrada —ambas devuelven la respuesta del recurso, o una la devuelve y la otra falla con el error de clave en curso (`409`)— **más un conteo leído por la API que afirma que existe exactamente un recurso**, sea quien sea el ganador. Sin ese conteo, el escenario enumera desenlaces admisibles y no puede fallar. La razón de separarlos: el reintento secuencial encuentra el registro de la clave ya commiteado y lo resuelve una simple lectura; el simultáneo cae en la ventana en la que todavía no lo está, que es donde vive el fallo real y donde un servicio replicado pasa la mayor parte de su vida. El status y el `code` de esa colisión son **contrato público** y los fija el catálogo de `framework-errors.md` (`409 IDEMPOTENCY_KEY_IN_PROGRESS`), así que se describen, no se inventan — salvo que el diseño declare el suyo, y entonces se usa ese. El mecanismo tiene un tercer desenlace que también se puede afirmar y que casi nunca se escribe: la misma clave con un **contenido distinto**, que es `409 IDEMPOTENCY_KEY_REUSED` y no debe confundirse con la carrera.
- Las validaciones de input (constraints de value types, campos requeridos) se cubren como casos borde `400`.
- **Toda query que devuelve colección** cubre el orden declarado (con datos que lo hagan distinguible de otro orden posible) y, si es `paginated`, la primera página, la página siguiente, la página vacía y el tope `maxSize`.
- **Toda query de colección que resuelve referencias** —un `embed`, un `exposedAs`, o un `need` `on-demand` que la operación lee por elemento— declara además **una afirmación de coste**: el trabajo de la operación **no crece con el tamaño de la página**. Se escribe comparando dos páginas de tamaños muy distintos («veinte elementos no cuestan más que dos»), **nunca fijando un número absoluto**: una cota ajustada al valor de hoy se rompe con cualquier cambio de motor o de proyección y acaba subiéndose sin mirar, que es como un gate se vuelve decorativo. Es la única regla de esta sección que no habla de corrección sino de coste, y está aquí porque **ninguna aserción funcional la ve**: resolver las referencias una a una devuelve exactamente el mismo cuerpo que resolverlas en lote, así que un listado que paga una consulta por elemento pasa todos los demás escenarios. Vale igual para el coste de **red** que para el del almacén —una hidratación o una llamada saliente por elemento de la página es el caso caro, y es el que el diseño puede prevenir cambiando la estrategia a `replicated`—. El escenario afirma la **forma**; cómo se mide es del generador. Requiere capa `api`: sin una petición que medir no hay nada que afirmar.
- **Todo command con entrada por lotes** —un `input` con una lista acotada por `maxItems`— declara **la misma afirmación de coste**, y por la misma razón: el trabajo de la operación no crece con el tamaño de la lista. Es la cara simétrica de la regla anterior y se escribe igual (dos tamaños muy distintos, nunca un número absoluto), pero el hueco que tapa es peor. En un listado, al menos el generador sabe que hay referencias que resolver y puede darle al implementador una vía por lote; con una lista de **entrada**, lo que el implementador tiene delante es un finder de un solo elemento y un bucle que funciona: la respuesta es idéntica, los demás escenarios pasan en verde, y una petición de veinte destinatarios se lleva veinte consultas que nadie va a echar de menos. Aplica a la comprobación que la operación hace **por elemento** de la lista —una lista de supresión, una de existencia, una de permisos—, no al trabajo que por definición es uno por elemento (crear veinte filas son veinte filas).
- **Si una query declara `cache`**, un escenario lee, muta por **cada** vía declarada en `invalidatedBy`, y vuelve a leer verificando el valor nuevo. Es la única forma de detectar una invalidación incompleta.
- **Toda caché con TTL exige además un escenario de *retención***: se lee (la caché se puebla), se cambia el dato por una vía que **no** está en `invalidatedBy`, se vuelve a leer dentro del TTL y el `Then` afirma que se sirve el valor **viejo**. Sin él, la cobertura de caché es ciega al peor fallo posible: una caché que no cachea nada pasa todos los escenarios de invalidación —porque sin caché el dato también sale fresco— y solo se descubre en producción, cuando la base de datos recibe el 100% de las lecturas. Un escenario que solo comprueba que "el cambio se refleja" no puede distinguir una caché sana de una que no existe.
- **Autorización por operación**: cada operación protegida cubre la llamada **sin credencial** (`401`) y **con credencial sin el permiso exigido** (`403`). No es exclusivo de la superficie M2M.
- **Si el diseño declara `security.cors`**, dos escenarios que no se parecen entre sí porque no prueban lo mismo: (1) el **preflight** —una petición `OPTIONS` **sin credencial** sobre una ruta protegida, cuyo `Then` afirma que se aceptan el método y las cabeceras que la política declara (`allowedHeaders`) y el tiempo de cacheo (`maxAgeSeconds`)—; y (2) una petición **normal cross-origin**, cuyo `Then` afirma que el navegador puede leer las cabeceras de `exposedHeaders` (correlación, paginación). El primero prueba que el preflight no muere en la cadena de seguridad; el segundo, que la respuesta llega **utilizable** al navegador — un servicio que contesta al preflight y no expone sus cabeceras pasa el primero y rompe al cliente igual. Los escenarios hablan de la **política** y de «un origen web», nunca de los orígenes concretos: esos son despliegue y no están en el diseño.
- **Si el diseño declara `dependencies`**, cada `need` se valida por su comportamiento observable, no por el canal que usa:
  - Todo `onMiss` con `action: fail` o `degrade` tiene **escenario propio**: **Given** que la copia local no tiene el dato, **When** se ejecuta una operación de `usedBy`, **Then** el error declarado con su `code` y status, o el resultado degradado exacto que describe `degradedTo`. Es la situación más frecuente en producción (arranque en frío, alta recién creada en el proveedor) y la que más divergencia produce entre stacks si no se fija.
  - Todo `need` con `onUnavailable` tiene **escenario propio**, y no es el anterior con otras palabras: `onMiss` dice qué pasa cuando **la copia** no tiene el dato; `onUnavailable`, cuando **el proveedor no contesta**. **Given** el proveedor indisponible, **When** se ejecuta una operación de `usedBy`, **Then** lo que la política prometió — con `fail`, el error declarado con su `code` y status; con `degrade`, el resultado degradado exacto de `degradedTo`. Con `lastKnown` son **dos** escenarios, y el segundo es el que lo hace fallable: (a) el **rescate** —el dato se leyó antes, cae el proveedor, y la operación responde con el último valor conocido—; y (b) el **arranque en frío** —ese dato no se leyó nunca, cae el proveedor, y la operación falla con el `error` declarado—. Sin (b), un servicio que no llega a guardar nunca nada pasa (a) en cuanto una lectura previa lo pobló por casualidad, y la política degrada en silencio a «fallar siempre», que es justo lo que se declaró para evitar. La ventana de `maxAgeSeconds` solo se ejercita si el diseño declaró un umbral corto: cuando no lo sea, el escenario lo dice en vez de simular el paso del tiempo.
  - Todo need `replicated` cubre además el **camino de puesta al día**: **Given** una copia con un valor viejo, **When** llega uno de los eventos de `fedBy` con un valor nuevo, **Then** las operaciones de `usedBy` deciden con el valor nuevo. Y una **reentrega del mismo evento** no debe producir un segundo efecto ni duplicar la copia.
  - Los escenarios hablan del **dato** ("el precio vigente del producto `p1`"), nunca de la tabla de proyección ni del cliente HTTP: la estrategia es diseño, su materialización es del generador.
- **Si el diseño declara `storage`**, las operaciones que suben archivos a un bucket cubren el **camino feliz** (el archivo queda almacenado en su bucket y es referenciable desde la entidad) y, según la `visibility` del bucket, la forma de lectura resultante (acceso directo si `public`; URL firmada o lectura mediada si `private`). Cubren además como casos borde el rechazo por tamaño (`FILE_TOO_LARGE`) y por content-type no permitido (`UNSUPPORTED_CONTENT_TYPE`), según las políticas del bucket. Y si alguna operación **lee** un archivo por su clave, un escenario cubre la clave que ya no existe en el bucket, con el error declarado para ese caso (`FILE_NOT_FOUND`, `404`): sin él, el fallo real —un objeto borrado o migrado, con la entidad conservando todavía su key— sale como un `500` que ningún contrato describe.
- **Si el diseño declara `mail`**, cada operación de `sentBy` cubre tres cosas, y las tres se afirman **sobre el correo que salió**, no sobre el status de la respuesta: que sale el correo esperado (destinatario, asunto ya interpolado con los datos del `When`, y las partes del cuerpo que declara `delivery.parts`); que **no** sale ninguno cuando la operación rechaza —cada `error` declarado que ocurra antes del envío necesita su escenario, porque es lo único que afirma que el rechazo llegó antes y no después—; y que repetir la operación con su guarda (`idempotency` o la transición declarada) **no manda un segundo correo**. Esto último no es un caso borde: un correo que sale no lo deshace ninguna transacción, y el destinatario es una persona real. La respuesta de la operación acepta el encargo, no lo cumple: un `Then` que solo comprueba el `202` no cubre nada de lo anterior.
- Operaciones `internal: true` (sin endpoint) se describen por su disparador real (subscription, schedule u operación interna consumida por otro servicio). Una operación con `schedule` **no se alcanza desde fuera**, así que su escenario no se escribe contra la llamada sino contra el **efecto**: qué cambia ahí fuera cuando el barrido pasa (una transición que otra operación deja ver, un evento que aparece en su canal, un correo que llega al buzón). Si el diseño no declara ningún efecto observable para ese barrido —ni `transitions` ni `emits`—, no hay nada contra lo que afirmar y el escenario saldría decorativo: ese caso va al § siguiente, no a esta lista. `keel validate` lo avisa.
- **Si el diseño declara endpoints expuestos a otros servidores** (capa api con `audience: services`/`both` y security con `serviceAuth`), cada operación con `level: service` se valida como **superficie de integración servidor-a-servidor** —el mismo contrato que documenta `/keel-integrate` en `INTEGRATION.md`—, no solo por su auth:
  - **Contrato funcional (camino feliz)**: la llamada con credencial de máquina válida y los scopes exigidos, con la **forma real del request** (los campos del payload que otro servidor envía) y la verificación en el **Then** del **response completo** que ese servidor consume (los campos del payload que viajan por M2M, coherentes con `INTEGRATION.md`), no solo el status `2xx`.
  - **Errores declarados**: cada `error` de la operación se cubre **ejercido con credencial de máquina** (mismo criterio que la regla general de commands, pero desde el público servidor), con su `code` y status HTTP exactos.
  - **Auth**: la llamada con credencial de máquina **sin** el scope exigido (`403`), y —si `validateAudience: true`— el token emitido para otra audiencia. **El status de ese segundo caso no lo decide el diseño**: lo fija el generador, y escribirlo a ojo produce un escenario que ningún servidor correcto pasa (en keel-spring es `403`, no `401`: el token es legítimo, simplemente no está emitido para este servicio). Se toma de la lista «lo que no decide el diseñador» que `/keel-design` aplica al redactar los escenarios, y no se duplica aquí. Los endpoints `audience: both` cubren además el acceso con token de usuario, y fijan si la respuesta es idéntica a la del público humano.
  - Los escenarios hablan de "credencial de máquina del cliente `<serviceClient>`", nunca del proveedor concreto. Y ese `<serviceClient>` es uno que **el diseño declara**: nombrar una identidad que `security.serviceClients` no tiene describe una superficie que no existe —no hay credencial que aprovisionar— y el escenario no será ejercitable por la vía que él mismo exige. Lo mismo con los roles humanos: se nombran los de `security.roles`, o no hay token que emitir. Si el escenario necesita una identidad que el diseño no tiene (dos aplicaciones distintas, un cliente con un scope y sin otro), lo que falta es declararla, no redactarlo como si existiera. `keel validate` lo avisa, y para verlo tiene que reconocer la forma canónica: escrito de otra manera, el aviso no salta y el hueco vuelve a ser invisible.

## Lo que no tiene escenario, y por qué

Un hueco declarado es honesto; uno tapado con un escenario decorativo es peor que el hueco, porque además apaga la sospecha. Hay UNA obligación del diseño que **no** produce escenario, y conviene que esté escrita aquí para que nadie se la invente:

- **El barrido cuya condición de entrada es el paso del tiempo** (`purgeMessagePersonalData` y sus parientes: retención, caducidad, archivado a los N meses). No es que no se pueda llamar —eso también le pasa al barrido que despacha una cola, y ese sí se verifica por su efecto—: es que su condición de entrada es *«la fila lleva 18 meses»*, y ninguna suite espera 18 meses ni puede fabricar el pasado sin escribir directamente en el almacén, que es exactamente lo que un ejecutor de caja negra no hace. Un `Given` que lo simulase estaría probando una puerta que el servidor de producción no abre. Lo que sí se declara es la política (qué se purga, cada cuánto, qué se conserva) y su verificación es **estática**. Si el barrido tiene que ser verificable en el pipeline, la salida no es inventarle un escenario: es que el diseño **exponga un disparador** además del `schedule`, y entonces deja de estar en esta lista.

Dos mecanismos estuvieron en esta lista y ya no están, y sus salidas fijan el criterio. El **outbox**: su
disparador tampoco es alcanzable, pero su efecto sí —el evento aparece o no aparece en el canal—, y quitar la
infraestructura de en medio convierte esa diferencia en observable. Y la **reconciliación**
(`activations.<a>.reconciledBy`): su efecto también lo es, y por partida doble —mueve el lifecycle y publica la
cancelación al proveedor—; lo que faltaba era llegar a su condición de entrada, y se llega envejeciendo la marca
de espera **de esa fila** (en keel-spring, `ageForReconciliation(...)` del arnés). El cron sigue disparando solo:
no se le abre ninguna puerta, se fabrica el silencio que el diseño dice que el barrido busca.

Dos matices que esa salida deja escritos, porque es donde se tuerce:

- **Se envejece la fila, no el umbral.** `unansweredAfterSeconds` es global: bajarlo en el perfil de prueba se
  lleva por delante las filas de todos los demás escenarios, que están legítimamente esperando su desenlace. Un
  escenario que sabotea a los otros no es cobertura.
- **El escenario tiene que caber en un tick del cron.** Con un `schedule` poco frecuente deja de ser puntuable, y
  entonces se declara `uncovered` con ese motivo — nunca se le baja el cron al diseño para que la prueba quepa.

Antes de dar por no ejercitable un mecanismo, la pregunta correcta no es «¿puedo llamarlo?» sino «¿hay algo que
cambie ahí fuera según esté bien o mal?». Y si lo hay, la segunda pregunta es cómo fabricar su precondición sin
inventarle una puerta.

## Lo que se comprueba solo

Casi todo lo de § Reglas de cobertura es revisión de `/keel-validate`, que lee y juzga. Once reglas están además **mecanizadas** en `keel validate`, que busca las señales en el texto de este archivo y **avisa** cuando no las encuentra: los dos escenarios de repetición de cada compensación (reentrega y doble entrega simultánea), **la reentrega de cualquier otra suscripción con guarda declarada**, el escenario de carrera de cada operación con `idempotency`, los DOS escenarios del outbox cuando el diseño declara `reliability: outbox` —el del canal indisponible y el del evento abandonado—, la espera agotada de cada `reconciledBy`, el rescate de lo que otra réplica dejó en vuelo, **el escenario de clúster de cada barrido que actúa**, los `serviceClient` y los roles que los escenarios nombran y el diseño no declara, y el barrido que no tiene ni puerta ni efecto declarado contra el que afirmar.

Son avisos, no errores, y la razón es lo que son: lectura de texto. Puede no reconocer una redacción rara, y el coste de equivocarse por ese lado es una frase de más; por el contrario, un mecanismo roto que nadie echa de menos. Se mecanizaron estas y no otras porque comparten un rasgo: el gate del generador solo puntúa lo que este documento declara, así que un escenario que faltaba aquí **no lo echaba de menos nadie** — ni el diseño, que no lo exigía, ni el generador, que no lo esperaba —, y todas cubren caminos que solo se ejecutan cuando algo ya salió mal.

## Secciones de cada escenario

- **Id**: `FL-<PREFIJO>-NNN`, donde `<PREFIJO>` son 3-4 letras de la entidad/agrupación (`CAT`, `PRD`) y `NNN` es secuencial dentro de ella.
- **Given** — estado previo mínimo y verificable: entidades existentes con los campos que importan, y lo que *no* existe cuando la unicidad es la regla bajo prueba. Alcanzable por la API dentro del propio flujo (ver § Aislamiento).
- **When** — la llamada concreta: **el nombre de la operación de `use-cases`** más el método + ruta del artefacto api (con versión y path params) y body de ejemplo realista. El nombre de la operación es lo estable entre stacks; la ruta es una proyección de la capa `api`. Para triggers no HTTP, el evento (con su `channel`/`source`) o schedule que dispara la operación.
- **Then** — **lista numerada de aserciones**, una por línea, cada una comprobable de forma independiente: status HTTP; cuerpo completo de la respuesta (campos presentes, ausentes y sus tipos); cabeceras del contrato (`Location`, paginación); estado resultante de las entidades (campos y transiciones) consultado por la API; eventos publicados con su payload y su canal. Un `Then` en prosa no es ejecutable de forma equivalente en dos stacks: cada frase se convierte en una aserción numerada.
- **Orden de evaluación** — en todo command con preconditions/rules o con más de un error: la secuencia numerada de guardas en el orden del artefacto use-cases, cada una con su error (`code` + status) si falla. Es el contrato de implementación: el orden importa, y no está en ningún otro sitio.
- **Ramas condicionales** — solo si la operación se comporta distinto según qué campos del input llegan (p.ej. updates parciales que recalculan campos `computed` solo si su fuente cambió, o campos omitidos que significan "no tocar").
- **Casos borde** — entradas inválidas (`400`), colisiones (`409`), no encontrados (`404`), y cualquier combinación de estado que active un error declarado no cubierto por otro flujo.
- **Notas de determinación** — opcional: las convenciones de § Determinación observable que aplican a este escenario y no están ya en las convenciones globales (orden concreto de una lista, redondeo del importe calculado, campos verificados por forma).

## Criterios de calidad

- Datos de ejemplo realistas y coherentes entre escenarios (mismo dominio de negocio, mismos identificadores simbólicos `c1`, `p1` reutilizados en los Given).
- Aislamiento según § Aislamiento y orden de ejecución: flujos auto-contenidos, escenarios encadenados dentro del flujo.
- **Un escenario que no puede fallar no prueba nada.** Si el `Then` se cumpliría con cualquier implementación razonable (solo `2xx`, "se crea el pedido"), el escenario es decorativo: concreta hasta que una implementación plausible pero distinta lo suspendería.
- Toda afirmación del `Then` debe ser comprobable por un ejecutor que **solo conoce el contrato público** del servicio.
- Nada de tecnología: los escenarios hablan de HTTP, estados, eventos y canales lógicos del diseño, jamás de tablas, frameworks, brokers, topics o colas concretos. Los nombres lógicos de `channel` y `bucket` son contrato del diseño y sí aparecen; su materialización (Kafka/RabbitMQ, S3/MinIO) no.
- Los ids `FL-*` son estables: al iterar el diseño se añaden flujos nuevos, no se renumeran los existentes.
