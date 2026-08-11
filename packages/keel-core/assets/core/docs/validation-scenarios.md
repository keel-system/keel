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

  Las dos aserciones que hacen que este escenario no pueda pasar por accidente son la **3** y el «exactamente uno» de la **4**, y conviene saber a qué implementación mata cada una. La 3 separa el outbox de publicar directamente contra el canal dentro de la operación: sin ella, un servicio que publica en línea pasa el escenario entero —el mensaje también acaba llegando— y la garantía queda sin probar. El «exactamente uno» separa un relay que marca lo entregado de uno que no: el segundo reentrega para siempre y sin esa palabra pasaría igual. Un escenario que solo afirme «el evento acaba en el canal» es decorativo: lo cumple cualquier servicio que emita eventos, con outbox y sin él.

  Es la **única** regla de esta sección que exige tocar la infraestructura, y es deliberado: el mecanismo consiste precisamente en no depender de que esté disponible, así que la única forma de observarlo es quitarla de en medio. El escenario habla del **canal lógico** («indisponible»), nunca del broker concreto ni de cómo se detiene: eso es del generador.
- **Si el diseño declara `messaging: subscriptions`**, cada suscripción tiene al menos un escenario que valida su **consumo**: **Given** el estado previo, **When** llega un evento entrante por su `channel`/`source` declarado con un payload de ejemplo, **Then** se ejecuta la operación `triggers` y se producen sus efectos observables. Además, un **caso borde de fallo** ejercita la política `onFailure`: reintentos (`retry`) y, si `deadLetter: true`, el envío del mensaje a la DLQ tras agotarlos. Si la suscripción declara `messageId`, un escenario reentrega el mismo mensaje y verifica que **no** hay segundo efecto.
- **Si una operación declara `idempotency`**, tiene **dos** escenarios y el segundo no es una variante del primero: (1) el **reintento secuencial** con la misma clave devuelve el mismo status y el mismo cuerpo sin segundo efecto, y con clave distinta y mismo contenido sí produce un segundo recurso; (2) **dos peticiones con la misma clave a la vez**, escrita como carrera (ver § Concurrencia). El `Then` de la segunda es una disyunción cerrada —ambas devuelven la respuesta del recurso, o una la devuelve y la otra falla con el error de clave en curso (`409`)— **más un conteo leído por la API que afirma que existe exactamente un recurso**, sea quien sea el ganador. Sin ese conteo, el escenario enumera desenlaces admisibles y no puede fallar. La razón de separarlos: el reintento secuencial encuentra el registro de la clave ya commiteado y lo resuelve una simple lectura; el simultáneo cae en la ventana en la que todavía no lo está, que es donde vive el fallo real y donde un servicio replicado pasa la mayor parte de su vida. El status y el `code` de esa colisión son **contrato público** y los fija el catálogo de `framework-errors.md` (`409 IDEMPOTENCY_KEY_IN_PROGRESS`), así que se describen, no se inventan — salvo que el diseño declare el suyo, y entonces se usa ese. El mecanismo tiene un tercer desenlace que también se puede afirmar y que casi nunca se escribe: la misma clave con un **contenido distinto**, que es `409 IDEMPOTENCY_KEY_REUSED` y no debe confundirse con la carrera.
- Las validaciones de input (constraints de value types, campos requeridos) se cubren como casos borde `400`.
- **Toda query que devuelve colección** cubre el orden declarado (con datos que lo hagan distinguible de otro orden posible) y, si es `paginated`, la primera página, la página siguiente, la página vacía y el tope `maxSize`.
- **Si una query declara `cache`**, un escenario lee, muta por **cada** vía declarada en `invalidatedBy`, y vuelve a leer verificando el valor nuevo. Es la única forma de detectar una invalidación incompleta.
- **Toda caché con TTL exige además un escenario de *retención***: se lee (la caché se puebla), se cambia el dato por una vía que **no** está en `invalidatedBy`, se vuelve a leer dentro del TTL y el `Then` afirma que se sirve el valor **viejo**. Sin él, la cobertura de caché es ciega al peor fallo posible: una caché que no cachea nada pasa todos los escenarios de invalidación —porque sin caché el dato también sale fresco— y solo se descubre en producción, cuando la base de datos recibe el 100% de las lecturas. Un escenario que solo comprueba que "el cambio se refleja" no puede distinguir una caché sana de una que no existe.
- **Autorización por operación**: cada operación protegida cubre la llamada **sin credencial** (`401`) y **con credencial sin el permiso exigido** (`403`). No es exclusivo de la superficie M2M.
- **Si el diseño declara `dependencies`**, cada `need` se valida por su comportamiento observable, no por el canal que usa:
  - Todo `onMiss` con `action: fail` o `degrade` tiene **escenario propio**: **Given** que la copia local no tiene el dato, **When** se ejecuta una operación de `usedBy`, **Then** el error declarado con su `code` y status, o el resultado degradado exacto que describe `degradedTo`. Es la situación más frecuente en producción (arranque en frío, alta recién creada en el proveedor) y la que más divergencia produce entre stacks si no se fija.
  - Todo need `replicated` cubre además el **camino de puesta al día**: **Given** una copia con un valor viejo, **When** llega uno de los eventos de `fedBy` con un valor nuevo, **Then** las operaciones de `usedBy` deciden con el valor nuevo. Y una **reentrega del mismo evento** no debe producir un segundo efecto ni duplicar la copia.
  - Los escenarios hablan del **dato** ("el precio vigente del producto `p1`"), nunca de la tabla de proyección ni del cliente HTTP: la estrategia es diseño, su materialización es del generador.
- **Si el diseño declara `storage`**, las operaciones que suben archivos a un bucket cubren el **camino feliz** (el archivo queda almacenado en su bucket y es referenciable desde la entidad) y, según la `visibility` del bucket, la forma de lectura resultante (acceso directo si `public`; URL firmada o lectura mediada si `private`). Cubren además como casos borde el rechazo por tamaño (`FILE_TOO_LARGE`) y por content-type no permitido (`UNSUPPORTED_CONTENT_TYPE`), según las políticas del bucket. Y si alguna operación **lee** un archivo por su clave, un escenario cubre la clave que ya no existe en el bucket, con el error declarado para ese caso (`FILE_NOT_FOUND`, `404`): sin él, el fallo real —un objeto borrado o migrado, con la entidad conservando todavía su key— sale como un `500` que ningún contrato describe.
- Operaciones `internal: true` (sin endpoint) se describen por su disparador real (subscription, schedule u operación interna consumida por otro servicio). Las operaciones con `schedule` declaran cómo se dispara la ejecución y qué queda observable después.
- **Si el diseño declara endpoints expuestos a otros servidores** (capa api con `audience: services`/`both` y security con `serviceAuth`), cada operación con `level: service` se valida como **superficie de integración servidor-a-servidor** —el mismo contrato que documenta `/keel-integrate` en `INTEGRATION.md`—, no solo por su auth:
  - **Contrato funcional (camino feliz)**: la llamada con credencial de máquina válida y los scopes exigidos, con la **forma real del request** (los campos del payload que otro servidor envía) y la verificación en el **Then** del **response completo** que ese servidor consume (los campos del payload que viajan por M2M, coherentes con `INTEGRATION.md`), no solo el status `2xx`.
  - **Errores declarados**: cada `error` de la operación se cubre **ejercido con credencial de máquina** (mismo criterio que la regla general de commands, pero desde el público servidor), con su `code` y status HTTP exactos.
  - **Auth**: la llamada con credencial de máquina **sin** el scope exigido (`403`), y —si `validateAudience: true`— el token emitido para otra audiencia (`401`). Los endpoints `audience: both` cubren además el acceso con token de usuario, y fijan si la respuesta es idéntica a la del público humano.
  - Los escenarios hablan de "credencial de máquina del cliente `<serviceClient>`", nunca del proveedor concreto.

## Lo que no tiene escenario, y por qué

Un hueco declarado es honesto; uno tapado con un escenario decorativo es peor que el hueco, porque además apaga la sospecha. Hay una obligación del diseño que **no** produce escenario, y conviene que esté escrita aquí para que nadie se la invente:

- **La reconciliación de un desenlace silencioso** (`activations.<a>.reconciledBy`, y en general toda operación cuyo único disparador sea el paso del tiempo dentro del servidor). Su disparador no es una petición ni un mensaje, así que no hay puerta por la que un ejecutor de caja negra pueda llamarla, y su condición de entrada —«lleva demasiado tiempo esperando»— es un umbral de configuración, no una entrada del escenario. Inventarle un disparador que el diseño no tiene sería probar una puerta que el servidor de producción no abre. Lo que sí se declara en el diseño es el umbral y qué queda observable **después** de la reconciliación, y su verificación es **estática**: en keel-spring, la familia `reconciliation` de `infra/check-idempotency.sh`.

Nótese la asimetría con el outbox, que hasta hace poco estaba en esta misma lista: allí el disparador tampoco es alcanzable, pero **su efecto sí** —el evento aparece o no aparece en el canal—, y quitar la infraestructura de en medio convierte esa diferencia en observable. Antes de dar por no ejercitable un mecanismo, la pregunta correcta no es «¿puedo llamarlo?» sino «¿hay algo que cambie ahí fuera según esté bien o mal?».

## Lo que se comprueba solo

Casi todo lo de § Reglas de cobertura es revisión de `/keel-validate`, que lee y juzga. Cuatro reglas están además **mecanizadas** en `keel validate`, que busca las señales en el texto de este archivo y **avisa** cuando no las encuentra: los dos escenarios de repetición de cada compensación (reentrega y doble entrega simultánea), el escenario de carrera de cada operación con `idempotency`, y el escenario de canal indisponible cuando el diseño declara `reliability: outbox`.

Son avisos, no errores, y la razón es lo que son: lectura de texto. Puede no reconocer una redacción rara, y el coste de equivocarse por ese lado es una frase de más; por el contrario, un mecanismo roto que nadie echa de menos. Se mecanizaron estas cuatro y no otras porque comparten un rasgo: el gate del generador solo puntúa lo que este documento declara, así que un escenario que faltaba aquí **no lo echaba de menos nadie** — ni el diseño, que no lo exigía, ni el generador, que no lo esperaba —, y las cuatro cubren caminos que solo se ejecutan cuando algo ya salió mal.

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
