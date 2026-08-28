# Pruebas de integración de los escenarios `FL-*`

Cómo se traduce `specs/validation-scenarios.md` a código en `src/integrationTest/`. Es la
convention del agente `keel-spring-tests`, y la referencia de `keel-spring-validate` cuando
arbitra un fallo.

**Qué no es**: la suite unitaria. Este flujo de generación no produce pruebas unitarias —
sigue siendo un proceso independiente y posterior. Lo que hay aquí son escenarios
end-to-end contra el servidor real y la infraestructura de `infra/docker-compose.yaml`, es
decir, el mismo trabajo que antes se hacía con `curl` a mano, ahora versionado.

## El source set

`build.gradle` declara un source set `integrationTest` separado y una tarea homónima:

- La tarea **no** se engancha a `check`: sin infraestructura levantada no tiene sentido, y
  `./gradlew build -x test` debe seguir siendo el gate de compilación.
- `src/main/java` está en el `runtimeClasspath` pero **no** en el `compileClasspath`. Dos
  consecuencias, ambas buscadas:
  1. `./gradlew compileIntegrationTestJava` compila sin `src/main/java`, así que el agente
     de pruebas trabaja en paralelo con el de código sin quedar preso de un `main` a medio
     escribir.
  2. La caja negra deja de ser una regla de estilo: un test que importe un DTO, un comando
     o una entidad generada **no compila**.

Por lo mismo, `AbstractFlowIT` usa `@SpringBootTest` **sin atributo `classes`**: las clases
de flujo cuelgan de `<basePackage>.flows`, así que Spring localiza la
`@SpringBootConfiguration` subiendo por el paquete en tiempo de **ejecución**.

## Del DSL al cable

Quien escribe estas pruebas no puede mirar el código, así que la forma exacta de la
respuesta —ruta, status, envoltura, nombres de campo— hay que **derivarla**. No se
adivina: está fijada en otros documentos, y esta sección dice en cuáles.

### Orden de precedencia de las fuentes

Lo primero que resuelve una duda, gana:

1. **`specs/validation-scenarios.md`** — el `Then` literal y las convenciones de
   determinación del servicio (ausencia vs nulo, orden de las colecciones, escala
   decimal, colación, formato temporal). Es el contrato de aceptación.
2. **`docs/openapi.yaml` y `docs/asyncapi.yaml`**, si existen — contrato formal ya
   derivado del diseño por `/keel-docs`: rutas, status, esquemas de respuesta y payloads
   de evento, sin interpretación intermedia. Es la vía más barata de acertar. Puede no
   estar (el build avisa y sigue): entonces se deriva del punto 3.
3. **`specs/<capa>.keel.yaml` + `mapping.md`** — la derivación mecánica, tabla de abajo.
4. Nada más. Lo que estas fuentes no fijan es un `designGap`, no un hueco que rellene el
   criterio de quien escribe el test.

Leer `mapping.md`, `openapi.yaml` o `asyncapi.yaml` **no rompe la caja negra**: los tres
son derivados del **diseño**, no del trabajo del agente de código. Que dos lecturas
independientes de la misma fuente coincidan es justamente lo que convierte un verde en
evidencia. Lo prohibido sigue siendo `src/main/java` y `src/test/java`.

### Tabla de derivación

Cada fila remite a su regla; aquí no se reescribe ninguna, para que no puedan divergir.

| Qué necesita el test | De dónde sale |
|---|---|
| **Ruta** | `api.basePath` (build añade `/v1` si el diseño no versiona) + `endpoints.<op>.path`; con `auto: true`, las rutas CRUD por convención (`createX → POST /xs`, `getX → GET /xs/{id}`…) — `mapping.md § api`. En la clase de flujo, el prefijo es la constante `ROUTE_BASE` de la base |
| **Path variable vs. query param vs. cuerpo** | lo decide el **verbo**, no el `kind` de la operación: cada `{segmento}` de la ruta es un path variable con su nombre exacto; el resto del `input` va en el cuerpo en `POST`/`PUT`/`PATCH` y como query param en `GET`/`DELETE`; multipart si el `input` trae un campo `file` — `mapping.md § api` |
| **Status de éxito** | `endpoints.<op>.successStatus`; si no se declara, 200, salvo `DELETE` (204) y las operaciones `create*` (201) — `mapping.md § api` |
| **Cuerpo de error** | sobre único del generador: `{timestamp, status, error, code, message, details, correlationId}`. Los escenarios fijan el `code` y el status; el resto se verifica por presencia y tipo, nunca por valor — `mapping.md § El sobre de error es contrato del generador` |
| **Respuesta paginada** | `PagedResponse` canónico — `items`, `page`, `size`, `totalElements`, `totalPages` —, nunca una lista desnuda ni `items` envuelto dos veces — `mapping.md § api` (fila `pagination`) y `docs/dsl/api.md § Paginación` |
| **Instantes** | ISO-8601 UTC con **exactamente tres** dígitos de fracción y sufijo `Z` — `mapping.md § Formato de los instantes`. Se assertan por forma (`assertIsInstant`), jamás por literal |
| **Campo sin valor** | la convención de determinación del servicio: viaja como `null` o se omite. Decide si la clave va en el JSON esperado del `assertBody` STRICT — `mapping.md § Ausencia vs. nulo` |
| **Campos de relación** | `<rel>Id` cuando apunta a otro agregado; `<Hija>Dto` (objeto anidado) para las entidades hijas del mismo agregado. Un value object compuesto sin ningún valor viaja como `null`, no como `{}` |
| **Dato de otro servicio (`exposedAs`)** | un **objeto anidado** con la forma de su origen —`response.fields` de la llamada de `fetchedFrom`, o los campos de la entidad réplica—, nunca el escalar suelto: `exposedAs: supplierPrice` sobre `{amount, currency, occurredAt}` es un `supplierPrice` con esos tres dentro. El nombre invita a leerlo al revés (`currentPrice` suena a número) y la forma no se ve desde él: hay que ir al contrato — `docs/dsl/dependencies.md § exposedAs`. Es además un nodo objeto, así que le aplican las dos reglas de abajo (variable tipada y `toJson(...)`, nunca `toString()`) |
| **`PATCH`** | ausente ≠ nulo explícito cuando el diseño lo declara: son **dos** escenarios distintos (omitir el campo conserva; mandarlo a `null` vacía), no uno — `mapping.md § Actualización parcial` |
| **Payload de evento** | `messaging.publishing.events.<Evento>.payload` o `docs/asyncapi.yaml`, con el **nombre de evento exacto** del diseño. Se lee del broker real con `publishedMessages(...)` |

### Checklist antes de compilar

Mecánica, sobre las clases ya escritas. Es la simétrica de la auditoría de consistencia
del contrato que hace el agente de código: ataca el mismo modo de fallo desde el otro lado
y ahorra un ciclo entero de validación funcional.

1. Toda ruta usada existe en `api` (o sale de `auto: true`) y su verbo coincide.
2. Todo `code` de error del JSON esperado está copiado **literal** del diseño.
3. Todo campo del `assertBody` aparece en el `output` de esa operación. Si el escenario
   nombra uno que el `output` no declara, es `designGap` — no se inventa el campo ni se
   relaja la aserción a modo laxo.
4. Ningún valor no determinista (id generado, marca de tiempo) se compara por literal.
5. Una clase por flujo, con el id `FL-*` exacto delante de los dos puntos en cada
   `@DisplayName`.
6. Toda restricción que el diseño declara sobre una entrada (`min`, `max`, `minLength`,
   `maxLength`, `minItems`, `maxItems`, `pattern`) tiene su escenario de rechazo con
   **400**, aunque el flujo `FL-*` no la mencione palabra por palabra. Son los casos borde
   que más fácilmente se caen del código generado y los que una prueba de caja negra atrapa
   sin leer una línea de `src/main/java`. Van al final de la clase del flujo que ejercita
   esa operación.
7. Ningún archivo que genera `keel-spring build` se edita en la fase 1:
   `AbstractFlowIT`, `FailureCapture` y `HarnessSmokeIT` son andamiaje del generador, no del
   flujo. Sin infraestructura levantada no hay forma de saber si están rotos, así que lo que
   falte se reporta como `blocker` con la firma propuesta. Qué hacer cuando **sí** están
   rotos —eso solo se ve en la fase 2— está en § El arnés es del generador.
8. Toda aserción de tipo "no se publica ningún evento" lleva `purgeMessages(<canal>)`
   **inmediatamente antes** de la acción bajo prueba. Es auditable con un `grep` del
   `purgeMessages` de cada aserción negativa: si el único reset del canal está en el
   `@BeforeAll`, el test está mal.
9. **Ninguna espera sobre el comportamiento de la aplicación va en `@BeforeAll`.** Ni
   `awaitMailTo`, ni `await(...)`, ni una lectura que dependa de un barrido, ni nada que
   dependa de él (el `db(...)` que retrasa un `requested_at` de un mensaje que tiene que estar
   `sent`, la siembra que solo tiene sentido después). `@BeforeAll` hace lo **determinista**:
   `resetState()` y las llamadas HTTP que devuelven 2xx por contrato. Lo demás va dentro de
   `awaitPreconditions(() -> { … })`, invocado desde un `@BeforeEach` — corre una sola vez y
   memoriza el fallo, así que no se paga la espera por escenario.

   El motivo no es de estilo: en `@BeforeAll` ese fallo es **inatribuible**. JUnit aborta la
   clase con `initializationError`, sus `FL-*` salen de la matriz como `NO_EJERCITADO` —«sin
   cobertura» donde hubo un rojo del servidor— y la corrida vuelve al agente de pruebas, que no
   puede leer `src/main/java`. Desde `@BeforeEach` cae sobre cada escenario como FALLO, con su
   volcado, y lo arbitra quien puede dictaminar `culprit: code`. Es auditable con un `grep`:
   un `awaitMailTo` o un `await(` dentro de un bloque `@BeforeAll` es un fallo.
10. **El token se pide en cada petición; nunca se guarda en una variable.** Ni en un campo, ni
   en un local de `@BeforeAll`, ni en uno declarado antes de una espera. `tokenFor(...)` renueva
   el token cuando le queda poca vida, pero solo puede hacerlo si se le pregunta: un valor
   capturado esquiva la renovación entera.

   El realm de prueba emite tokens de **cinco minutos**, así que cualquier flujo con esperas
   reales —un rescate, una reconciliación, dos ticks de un barrido— se pasa de ahí a mitad de
   clase. Y lo que se ve entonces no se parece a un problema de credenciales: un `401` con
   cuerpo vacío y un `IllegalArgumentException: json string can not be null or empty` al
   intentar parsearlo, en un `Then` que no tiene nada que ver con la autenticación. Se arbitra
   como `culprit: code` antes de que nadie mire la fecha del token.

   Esto está escrito aquí porque el aviso en el javadoc de `tokenFor` **no bastó**: dos corridas
   distintas, con cuatro clases entre las dos, volvieron a capturarlo. El javadoc se lee al usar
   el método; la decisión de guardarlo se toma antes, al montar la clase. Es auditable con un
   `grep`: una asignación `token = tokenFor(` fuera de la línea de una petición es un fallo.
11. Cada cláusula del `Given` de cada escenario tiene su llamada de siembra y esa llamada
   comprueba su propio status — § Traducir el `Given`. Es auditable leyendo el escenario y el
   test en paralelo: un `Given` que nombra un estado del lifecycle y un test que solo crea la
   entidad es un fallo garantizado, atribuido además al agente equivocado.
12. Todo `jsonPath(...)` y todo `JsonPath.read(...)` se captura en una variable tipada antes
    de pasarlo a nada — nunca anidado dentro de `String.valueOf(...)`, `formatted(...)` u otra
    llamada con sobrecargas, que eligen por el tipo estático y meten un cast que revienta en
    runtime — § `jsonPath(...)` y `JsonPath.read(...)` van siempre a una variable tipada. Y si
    la expresión lleva un filtro `[?(...)]`, el destino es una `List<...>`, nunca un escalar —
    § Un filtro devuelve una lista, no un elemento. Las dos son auditables con un `grep`: `[?(`
    debe leerse siempre en una lista, y `valueOf(jsonPath`/`valueOf(JsonPath` no debe aparecer
    nunca.
13. Toda vía que sirve una entidad desde **caché** compara `createdAt`/`updatedAt` entre la
   lectura que puebla la caché y la que la sirve, no solo los campos de negocio. El
   `Instant` es el campo que primero se rompe en el roundtrip de (de)serialización y el que
   ningún escenario nombra explícitamente: comprobar solo los campos de negocio deja pasar
   exactamente el defecto que la caché introduce.

## Una clase por flujo

```java
@DisplayName("FL-PRD-001: alta de producto")
class ProductCreationFlowIT extends AbstractFlowIT {

    private String productId;

    @BeforeAll
    void prepare() {
        resetState();
    }

    @Test
    @Order(1)
    @DisplayName("FL-PRD-001-A: alta correcta")
    void createsProduct() {
        Response response = post(ROUTE_BASE + "/products", """
            {"sku": "ACME-1", "name": "Martillo", "categoryId": "%s"}""".formatted(categoryId));

        assertThat(response.status()).isEqualTo(201);
        productId = jsonPath(response, "$.id");
        String createdAt = jsonPath(response, "$.createdAt");   // variable tipada, ver abajo
        assertIsUuid(productId);
        assertIsInstant(createdAt);
        assertThat(response.header("Location")).endsWith("/products/" + productId);
        assertBody(response, """
            {"id": "%s", "sku": "ACME-1", "name": "Martillo", "status": "draft",
             "version": 0, "createdAt": "%s", "categoryId": "%s", "images": []}"""
            .formatted(productId, createdAt, categoryId));
    }
}
```

Reglas de forma:

- **Nombre**: `<Flow>FlowIT`, en `src/integrationTest/java/<basePackage>/flows/`.
- **`@DisplayName` con el id exacto delante de los dos puntos** (`FL-PRD-001-A: …`). De ahí
  salen mecánicamente la matriz `scenarios:` del reporte y el nombre del volcado en
  `build/keel-failures/`. Sin el id, el arbitraje pierde la trazabilidad al `Then`.
- **`@Order(n)` en el orden del documento**. La base ya trae
  `@TestMethodOrder(OrderAnnotation.class)` y `@TestInstance(PER_CLASS)`: el estado
  encadenado del flujo vive en campos de instancia.
- **`@BeforeAll` con `resetState()`**. El reset es **por flujo, no entre escenarios**: dentro
  de un flujo el escenario A crea el estado que B verifica (el duplicado, la página
  siguiente, la transición). Resetear entre escenarios rompe el contrato del documento.
- Si el `Given` de un flujo depende de datos creados por **otro** flujo, tras el reset no se
  sostiene: es un hueco del diseño (`designGaps`), no se siembra a mano.

### Traducir el `Given`

El `Then` se traduce aserción por aserción; el `Given` se traduce **cláusula por cláusula**, y
es donde se pierden los tests silenciosamente: crear la entidad no es dejarla en el estado que
el escenario declara. Por cada cláusula del `Given`, escribe la llamada que la satisface y
comprueba que **efectivamente** deja ese estado observable por la API:

| Cláusula del `Given` | No basta con | Hace falta |
|---|---|---|
| `p1 (active)` | crear `p1` (nace en el estado inicial del lifecycle) | la operación que lo transiciona a `active`, y assertar el status de esa llamada |
| `c1 con 3 productos` | crear `c1` | crear los tres y comprobar que quedan asociados |
| `p1 sin imágenes` | crear `p1` | nada más, pero **decláralo**: es la precondición que hace determinista el `Then` |
| `la caché de X poblada` | mutar `X` | una lectura previa que la puebla |

Reglas:

1. **El estado del lifecycle es explícito.** Un agregado con `lifecycle` nace en su estado
   inicial; cualquier otro estado del `Given` exige la operación de transición declarada en el
   diseño, no un atajo.
2. **La preparación se asserta.** Una llamada de siembra cuyo status no se comprueba convierte
   un fallo de preparación en un fallo del escenario, atribuido al código que no lo causó.
3. **Si el `Given` no se puede materializar por la API**, es `designGap`: no se siembra por BD ni
   se relaja el escenario.
4. Recuerda que la preparación **también publica eventos**: si el `Then` afirma "no se publica
   nada", va `purgeMessages(<canal>)` entre el `Given` y el `When` (§ checklist, punto 8).

5. **Al aislar una guarda tardía, las guardas previas se satisfacen con datos válidos.** Un
   escenario que prueba el alcance, la suspensión o cualquier rechazo que ocurre *al final* de la
   cadena de comprobaciones necesita atravesar todo lo anterior: un cuerpo `{}`, un id inventado o
   un token que no alcanza el recurso hacen que la petición muera antes, en otra guarda, con otro
   `code` — y el escenario pasa a medir algo que no es lo suyo. El `Given` es la única fuente de
   qué se está aislando; el resto del fixture tiene que ser **válido a propósito**. Cuando el mismo
   endpoint ya aparece en otro escenario (de esta clase o de otra), cruza tu fixture con las
   constraints y el alcance que aquel declara antes de darlo por bueno: tres de los seis
   arbitrajes de una tanda real fueron este mismo defecto repetido.

## Aserciones: el cuerpo completo o nada


- `assertBody(response, expectedJson)` compara con **JSONAssert en modo STRICT**: verifica
  en una sola aserción los campos presentes *y* la ausencia de los que no deben venir. Es la
  forma directa de cumplir "el `Then` verifica el cuerpo completo" del documento de
  escenarios.
- `assertJson(actualJson, expectedJson)` es lo mismo sobre un JSON que no viene de una
  `Response`: el cuerpo **saliente** que el servidor mandó al proveedor de prueba
  (`stubRequestBody(...)`) o el `data` de un evento leído del broker.
- Los valores **no deterministas** —ids generados, marcas de tiempo del servidor— no se
  comparan por literal: se extraen con `jsonPath(...)`, se verifican por forma
  (`assertIsUuid`, `assertIsInstant`) y se reinyectan en el JSON esperado para que el STRICT
  siga siendo estricto en todo lo demás.
- Las cabeceras del contrato (`Location`, paginación) se assertan explícitamente:
  `response.header("Location")`.
- Un test que solo comprueba el status **no vale**. Es el modo de fallo que esta convention
  existe para eliminar.

### `jsonPath(...)` y `JsonPath.read(...)` van siempre a una variable tipada

Las dos son genéricas (`protected <T> T jsonPath(Response, String)`, `static <T> T JsonPath.read(...)`)
y no validan nada: **el tipo lo elige el sitio de la llamada**, no lo que hay dentro del JSON.

**Antes de tipar, mira la FORMA del campo en el contrato.** El que más engaña es el dato que
viene de un `need` con `exposedAs`: viaja con la forma entera de su origen, así que
`currentPrice` es un objeto (`{amount, currency, occurredAt}`) aunque el nombre suene a
número. Tiparlo `String` compila y revienta al leer el primer cuerpo. Lo mismo con cualquier
campo que el DTO declare como objeto anidado o lista.

Anidar
la llamada dentro de otra deja que `javac` resuelva la sobrecarga a costa tuya y mete un cast que
revienta en runtime:

```java
// MAL: único argumento de un varargs Object..., javac infiere T = Object[]
//      y el cast interno lanza ClassCastException con el String real que devuelve.
"…%s…".formatted(jsonPath(response, "$.category.id"));

// MAL: entre String.valueOf(Object) y String.valueOf(char[]), la SEGUNDA es más
//      específica, así que javac la elige e inserta un checkcast a char[] en el
//      propio call site → ClassCastException: String cannot be cast to [C.
String sku = String.valueOf(JsonPath.read(payload, "$.data.sku"));

// BIEN: el tipo queda anclado en la declaración, y la sobrecarga ya no se elige sola.
String categoryId = jsonPath(response, "$.category.id");
"…%s…".formatted(categoryId);

Object raw = JsonPath.read(payload, "$.data.sku");
String sku = String.valueOf(raw);
```

La regla es una sola y no depende de qué método reciba el valor: **captura primero en una variable
(`String` si sabes que es texto, `Object` si no), usa después**. Nunca anides la extracción dentro de
una llamada con sobrecargas — `String.valueOf`, `formatted`, `assertThat`, `List.of`… todas eligen
por el tipo estático, que aquí es el que tú no has escrito.

Vale la pena reconocer el síntoma, porque no se parece a lo que lo causa: una
`ClassCastException` cruda (`class java.lang.String cannot be cast to class [C`) sin relación
aparente con el `Then` que medía el escenario. Parece un defecto del arnés y no lo es —
sustituir el proveedor de JsonPath no lo cambia, porque el cast lo puso el compilador en el
código de la prueba. En la corrida del 14/08/2026 costó una ronda entera de arbitraje.

Además de evitar el fallo, capturar deja la aserción de forma (`assertIsUuid`, `assertIsInstant`)
junto a la extracción, que es donde se lee.

### Todo formateo de números y fechas lleva `Locale.ROOT`

`String.format`/`.formatted(...)` usan el locale **por defecto de la JVM**, que es el del host donde
corre la generación. En un host con coma decimal (`es_ES`, `es_CO`, `pt_BR`…) el importe se
serializa con coma y el cuerpo deja de ser JSON válido:

```java
// MAL: en un host con locale de coma decimal produce "price": 89,90
"{\"price\": %.2f}".formatted(price);

// BIEN: el formato del fixture no depende de dónde se ejecute.
"{\"price\": %s}".formatted(String.format(Locale.ROOT, "%.2f", price));
```

El síntoma es desconcertante porque no menciona el locale: la petición muere con **400** en el
`Given` (montando el fixture), mucho antes de llegar a la regla que el escenario quería probar, y
la misma suite pasa en verde en un host con punto decimal. Aplica a cualquier helper de fixture
que componga texto a partir de un número o una fecha — `priceFor(...)`, `amountFor(...)`,
formateo de `Instant`/`LocalDate` con `DateTimeFormatter` (que también acepta `withLocale`).

### Un filtro devuelve una lista, no un elemento

Una expresión de filtro `[?(...)]` devuelve **siempre** un `JSONArray`, aunque case un solo
elemento, y encadenarle un índice final **no** lo desenvuelve. Es la trampa más cara de esta
página porque tiene dos caras y solo una avisa:

```java
// MAL, y AVISA: el destino es escalar → ClassCastException
//      (net.minidev.json.JSONArray → String).
String url = jsonPath(response, "$.images[?(@.id=='%s')].url[0]".formatted(imageId));

// MAL, y NO AVISA: el destino es Object, así que no hay cast que falle. Jayway
//      devuelve una JSONArray VACÍA —nunca null, nunca PathNotFoundException—
//      valga lo que valga el campo, así que esto es constantemente `true`.
Object value = jsonPath(response, "$.items[?(@.id=='%s')].awaitingSince[0]".formatted(id));
return value != null;
```

La segunda es la que hay que temer. Montada dentro de un `await(...)`, produce un **timeout que
parece latencia del servidor** cuando el servidor ya había convergido — y manda a buscar el
defecto donde no está. En la corrida del 13/08/2026 costó un ciclo de arbitraje completo y
contaminó el diagnóstico de un defecto real que coincidía en el mismo lote.

Por eso `jsonPath(...)` **rechaza** un path que indexe después de un filtro: lanza
`IllegalArgumentException` explicando el porqué, en vez de dejar pasar una comprobación que no
comprueba nada. Para localizar un elemento por uno de sus campos está `itemById(...)`, que filtra
y toma el primero **en Java**:

```java
// BIEN: sin JsonPath después del filtro. Un campo nulo da vacío igual que un
//       elemento ausente, que es justo lo que la pregunta quiere decir.
boolean awaiting = itemById(response, "$.items", "id", productId)
        .map(item -> item.get("awaitingSince"))
        .isPresent();
```

Si de verdad hace falta la lista, se lee como lista y se indexa en Java, con su tamaño afirmado:

```java
List<String> urls = jsonPath(response, "$.images[?(@.id=='%s')].url".formatted(imageId));
assertThat(urls).hasSize(1);
String url = urls.get(0);
```

El `hasSize(1)` no es decoración: sin él, un filtro que casa cero elementos falla más tarde y en
otro sitio (`IndexOutOfBounds` en el `get(0)`), y uno que casa dos pasa desapercibido. Casi
siempre es más legible **evitar el filtro**: si el escenario fija el orden de la colección, indexa
por posición (`$.images[0].url`) y deja que el STRICT de `assertBody` cubra el resto.

### Un nodo objeto o array no se vuelve JSON con `toString()`

La trampa más cara de las de este bloque, porque **no falla donde está**. Un `$.campo` escalar
devuelve el `String`/`Integer` que se espera, pero un nodo **objeto o array** lo materializa el
proveedor por defecto de JsonPath como `LinkedHashMap`/`List` (jackson-databind está en el
classpath vía `spring-boot-starter-web`), y `Object.toString()` sobre ellos da sintaxis de Java
—`{clave=valor}`—, no JSON. El texto resultante parece correcto en un log y es basura para
cualquier lector de JSON:

```java
// MAL: el 'data' del evento sale como "{productId=…, sku=…}"; el JsonPath.read
//      posterior lanza PathNotFoundException y el JSONAssert falla por su propia
//      técnica, aunque el evento del broker sea exactamente el que pide el Then.
String data = JsonPath.read(payload, "$.data").toString();
String sku = JsonPath.read(data, "$.sku");

// BIEN: se re-serializa con el helper del arnés, agnóstico del proveedor de JsonPath.
String data = toJson(JsonPath.read(payload, "$.data"));
String sku = JsonPath.read(data, "$.sku");
```

`toJson(Object)` es `protected` en `AbstractFlowIT` y vale para cualquier nodo, venga de
`jsonPath(response, …)` o de un `JsonPath.read` sobre otra cadena. Donde más aparece es el
`data` de un evento leído del broker (la envoltura `{metadata, data}` de
`architecture.md § Forma del mensaje publicado`), y ahí el modo de fallo es especialmente
traicionero: el error se atribuye al código o a la mensajería, no a la aserción. En una
generación real este patrón enmascaró **doce escenarios en un ciclo de validación entero**.

### Ausencia de campo: STRICT, no `isNull()`

La vía normal es `assertBody(...)`: JSONAssert en modo STRICT ya falla si aparece una clave que
el JSON esperado no declara. Si hace falta comprobarlo puntualmente, **no** se usa
`assertThat((Object) jsonPath(response, "$.campo")).isNull()`: `JsonPath.read` sobre una clave
**ausente** lanza `PathNotFoundException`, no devuelve `null`, así que esa aserción falla por su
propia técnica aunque el servidor cumpla el contrato. El patrón correcto:

```java
assertThatThrownBy(() -> jsonPath(response, "$.categoryId"))
        .isInstanceOf(PathNotFoundException.class);
```

(`null` explícito **sí** devuelve `null`: si el diseño distingue ausente de nulo —`mapping.md §
Ausencia vs. nulo`— son dos aserciones distintas.)

Vale igual para el `data` de un evento, con un matiz de fontanería: ahí no hay `Response`, así
que se parte de `toJson(JsonPath.read(message, "$.data"))` —JSON de verdad, no el `toString()`
de un `Map`, § anterior— y se lee sobre esa cadena. Y suele bastar con la comparación STRICT
del `data` completo: un campo que el diseño manda omitir y llega como `null` es una clave extra,
y JSONAssert ya falla por ella sin ninguna aserción dedicada.

## Idempotencia, credenciales y estado

- `Idempotency-Key`: la base añade una uuid **nueva por request** en toda mutación.
  Reutilizar la clave entre flujos devuelve la respuesta del flujo anterior durante todo el
  `ttlSeconds` del diseño, y parece un bug del código que no existe. Solo el escenario que
  prueba la deduplicación repite clave, con `exchangeWithKey(...)`.
- Con capa `security`, `tokenFor("<rol>")` devuelve un Bearer token cacheado por rol y
  `serviceCredential("<cliente>")` la credencial de máquina de los escenarios `level: service`
  (nunca un token de usuario). Los nombres de cliente y los secretos **no se escriben en el
  test**: salen de `infra/test-credentials.env`, que genera `keel-spring build` junto al
  script de aprovisionamiento y que `AbstractFlowIT` lee. Un literal inventado a este lado es
  una apuesta contra la infraestructura, y cuando falla bloquea la suite entera en
  `@BeforeAll` sin decir por qué.
- Con **alcance por recurso** (`authentication.scoping`), el recurso al que alcanzan los usuarios
  no exentos se pide con **`scopedResource()`** — nunca se escribe el código a mano. Ese valor lo
  siembra `build` en el realm y lo publica en `test-credentials.env`, así que escribirlo aquí
  crea una tercera copia del mismo dato: exactamente lo que tumbó tres clases con un
  `403 APPLICATION_FORBIDDEN` en su `@BeforeAll`, y lo que hizo que arreglar el realm no
  arreglara nada. Los roles exentos alcanzan cualquier recurso, así que el escenario negativo
  —403 sobre otro recurso— se escribe con un rol **no** exento. La convención completa —realm, cliente de prueba, usuario
  por rol— está en [infra-validation](infra-validation.md) § Obtener un token.
- Los **fixtures de identidad que ya documenta una skill del stack** (los clientes
  `test-m2m-*` de Keycloak, el usuario `no-role`, el cliente `<artifactId>-test`) se asumen
  existentes al escribir el test: los crea el aprovisionamiento generado. Nunca se declara
  `uncovered` un escenario de seguridad "porque el diseño no define un segundo cliente sin
  scope" — está definido, en `skills/keel-spring-keycloak/references/test-clients.md`. Si el
  fixture resultara faltar, eso es un fallo que la validación detecta y corrige; dejar la
  cobertura sin escribir, no.
- Con protocolo `api-key`, las claves ya vienen sembradas en
  `src/main/resources/parameters/local/security.yaml`: se usan tal cual (`apiKey()`,
  `serviceCredential(...)`), no se inventan ni se edita el YAML.

## CORS: los dos escenarios que no se parecen entre sí

Con bloque `cors` en el diseño, la base trae dos helpers y **elegir mal es lo que hace que el
escenario pase sin probar nada**:

| Qué prueba el escenario | Helper | Por qué |
|---|---|---|
| El **preflight** | `preflight(path, origin, requestMethod, requestHeaders)` | Manda `OPTIONS` con `Origin` y `Access-Control-Request-*`, y **sin `Authorization`** — que es como lo manda un navegador. Un `2xx` aquí es lo único que prueba que el filtro de CORS corre **antes** de la autorización; un `401` significa que la SPA no puede hacer ni una llamada |
| Una petición **normal** cross-origin | `exchangeWithHeaders(method, path, body, token, Map.of("Origin", origin))` | Lo que se afirma es `Access-Control-Expose-Headers` (lo que el navegador deja **leer** de la respuesta), y eso solo aparece si la petición dice de qué origen viene. **No es un preflight**: lleva su token y su verbo normales |

Las cabeceras de respuesta se leen con `response.header("Access-Control-Allow-Origin")`, como
cualquier otra. Los orígenes permitidos son dato de ambiente, no de diseño: en `local` valen
`http://localhost:3000` y `http://localhost:5173`, así que el `Origin` del escenario sale de ahí
y el caso negativo usa cualquier otro.

`exchangeWithHeaders` **no es la vía para `Authorization` ni para `Idempotency-Key`**: los dos
tienen su propio parámetro y su propia semántica (`tokenFor(...)` cachea por rol, la clave se
repite solo donde se prueba la deduplicación). Colarlos por el mapa salta esas garantías.

## Lo que no se ve por HTTP

Toda afirmación del `Then` se comprueba, por orden de preferencia:

1. Por la **propia API** (consultar el estado resultante con una query del diseño).
2. Por el **canal de eventos**: `publishedMessages("<destino>", n)` lee del broker **real**
   del compose vía el contenedor `devtools`, igual que `infra/validate-infra.sh`.
   **Nunca `@EmbeddedKafka`, `@MockBean` ni dobles**: lo que se valida es la infraestructura
   levantada, no una simulación de ella.

   El `<destino>` es el **nombre del canal** de `messaging.keel.yaml` § `channels`, y cada
   broker lo materializa a su manera: en Kafka es el topic; en RabbitMQ, la **cola** que la
   topología declara con ese nombre y bindea al exchange del servicio; en SNS/SQS, la cola.

   **Una aserción negativa de mensajería no vale sola.** `publishedMessages(canal, n)` vacío
   no distingue "correctamente no publicado" de "el canal está roto": si falta el binding, o
   el broker no arrancó, o el nombre no coincide, el test pasa igual y da falsa seguridad.
   Toda clase que afirme "no se publica evento" en un canal tiene que contener también, en
   algún test de la misma clase, la evidencia **afirmativa** de que ese canal entrega —
   normalmente el escenario positivo que abre el flujo. Si el flujo no tiene ninguno, se
   añade una comprobación explícita de que el canal existe antes de la aserción negativa.

   **Y va precedida de `purgeMessages(canal)`, justo antes de la acción bajo prueba.** El
   reset del `@BeforeAll` no basta: si el `Given` del propio escenario ejecuta una operación
   que publica —crear el recurso que después se borra, por ejemplo—, ese evento de
   preparación sigue en el canal y la aserción "no se publica nada" falla por algo que no
   tiene que ver con la acción. La ventana de observación se abre **donde empieza lo que se
   está probando**, no donde empieza el flujo.

   **Lo que devuelve es la respuesta del broker, con el evento ANIDADO dentro.** No es el
   sobre suelto: cada broker lo entrega en su propio envoltorio, y el sobre de aplicación
   (`metadata` + `data`) viaja en un campo de ese envoltorio.

   | Broker | Dónde está el sobre | Cómo se afirma |
   |---|---|---|
   | RabbitMQ | campo `payload` de cada elemento del array | `JsonPath` sobre `$[*].payload…`: el arnés lo deja embebido como JSON |
   | SNS/SQS | campo `Body` de cada mensaje | por substring: el arnés lo desescapa en el texto, que deja de ser JSON navegable |
   | Kafka | el registro **es** el sobre | `JsonPath` por línea |

   En RabbitMQ y en SQS el campo llega del broker como **cadena JSON escapada dentro del
   JSON de la respuesta**, y el arnés lo desescapa antes de devolverlo: sin eso, una
   aserción tan normal como `.contains("\"status\":\"active\"")` no casaría NUNCA
   aunque el evento publicado fuera correcto — y el fallo es **mudo**: un falso negativo,
   no un error.

   Lo que **no** funciona en ningún broker es **contar apariciones de un substring**: el
   nombre del evento aparece también en las propiedades del mensaje, y el id del recurso
   viaja en otro punto del sobre, así que un `.split("ProductUpdated").length` cuenta
   cabeceras, no eventos. Localizar y contar se hacen sobre el sobre deserializado:

   ```java
   /** Cuántos eventos del tipo dado hay en el canal para ese recurso (RabbitMQ). */
   private static long countEvents(String messages, String eventType, String productId) {
       // Map, NO String: el arnés ya desescapó el `payload` y lo dejó como objeto JSON.
       // Tiparlo como String es un ClassCastException en cuanto se lee el primer mensaje.
       List<Map<String, Object>> payloads = JsonPath.read(messages, "$[*].payload");
       return payloads.stream()
               .filter(p -> eventType.equals(JsonPath.read(p, "$.metadata.eventType")))
               .filter(p -> productId.equals(JsonPath.read(p, "$.data.productId")))
               .count();
   }
   ```

   **El tipo depende del broker, y equivocarlo no es un matiz**: en RabbitMQ el sobre viene
   ya deserializado (`Map`), y en SNS/SQS el arnés lo desescapa **dentro del texto**, así que
   ahí `$..Body` sigue siendo `String` y hay que releerlo con `JsonPath.parse(body)`. La
   tabla de arriba dice cuál es cuál; copiar el ejemplo del otro broker falla en la primera
   lectura, no en una aserción.

   Un `hasEvent(...)` que además compare un campo del `data` (el estado resultante, por
   ejemplo) es la misma forma con `anyMatch`. Los dos son **helpers privados de la clase de
   flujo**: cada flujo cuenta lo suyo, y compartirlos por herencia acopla clases que se
   escriben por separado.

3. Por **descarga directa desde la JVM del test**, para lo que quedó en un bucket de
   storage. Un `Then` que afirma "el archivo subido está en el bucket y es el que se envió"
   se comprueba pidiendo la URL pública que devolvió la propia API con
   `java.net.http.HttpClient`, y comparando bytes o su SHA-256. Que la respuesta traiga una
   URL y no la key no es una suposición del test: sobre un bucket `visibility: public` el
   `ResponseDto` expone la URL absoluta por construcción, y la compone el mapper que genera
   build (conventions/mapping.md § `storage`):

   ```java
   HttpResponse<byte[]> stored = HttpClient.newHttpClient().send(
           HttpRequest.newBuilder(URI.create(url)).GET().build(),
           HttpResponse.BodyHandlers.ofByteArray());
   assertThat(stored.statusCode()).isEqualTo(200);
   assertThat(stored.body()).isEqualTo(sentBytes);   // o su digest, si el cuerpo es grande
   ```

   Es el mismo consumidor que el real —quien lea esa URL en producción es un cliente HTTP,
   no una CLI— y no depende de la topología de red del compose. **No se hace desde
   `devtools`**: dentro de un contenedor `localhost` es el propio contenedor, no el host, así
   que una URL pública (`http://localhost:9000/…`) no resuelve ahí — en docker igual que en
   podman. La `public-base-url` del perfil `local` ya apunta ahí por eso mismo. Con un bucket
   `visibility: private` no hay URL pública —el `ResponseDto` lleva la key— y la vía es la
   operación del diseño que firma o media el acceso, no un atajo por la infraestructura.
4. Por **la base de datos**, con `db("cli", "arg", …)` —`dbShell("…")` **solo** si hace falta un
   pipe o una redirección—, para el efecto que ninguna operación del diseño devuelve. Resuelve el
   contenedor correcto por sí solo: con Mongo y con Oracle la CLI vive dentro del contenedor de la
   BD, no en el toolbox, y esa regla no se escribe a mano en una clase de prueba. El javadoc del
   método generado trae la invocación concreta del motor elegido (credenciales y URI incluidas),
   copiada de la que usa `infra/validate-infra.sh`. Sigue siendo el penúltimo recurso: si el
   servicio expone el estado por su API, se comprueba por ahí, que es lo que hace un cliente.

   **La sentencia entra como un elemento del argv, nunca dentro de una cadena para `sh -c`.**
   No es una preferencia de estilo: el comando pasa por el cliente de contenedores antes que por
   el shell, y en Windows `podman.exe`/`docker.exe` reinterpreta las comillas dobles de un
   `psql -c "…"` armado a mano — del SQL sobrevive un fragmento y el motor responde con un error
   de sintaxis que no se parece a la causa. La regla vale para los helpers **propios**: un
   `seedCategory()` que arma su INSERT como cadena es el caso real que ha tumbado dos
   generaciones, y como esos helpers viven en `@BeforeAll`, el fallo no es de un escenario sino
   de la clase entera (`initializationError`, todos sus `FL-*` en `NO_EJERCITADO`). La única
   excepción es Oracle, cuyo `sqlplus` lee la sentencia por la entrada estándar; ahí el javadoc
   generado dice explícitamente que la forma argv no existe.

   **Y con MongoDB la forma argv tampoco basta: el script va por `mongoEval(...)`.** El argv
   protege las comillas que envuelven un argumento, no las que van DENTRO de él, y un script de
   mongosh lleva comillas dentro casi siempre (`db.getCollection("x")`). En Windows el cliente
   de contenedores se las come y mongosh responde `ReferenceError: x is not defined`. `mongoEval`
   —que build genera— copia el script como archivo y lo ejecuta desde ahí, que es el mismo
   mecanismo con el que viaja cualquier cuerpo JSON. En la quinta corrida esto tumbó
   `HarnessSmokeIT` y con él la suite entera antes de ejercitar un solo flujo.

   **El nombre de la tabla no se adivina.** Es el error que más ciclos de arbitraje ha
   gastado en las corridas, y siempre con el mismo desenlace: un `culprit: test` por
   `UPDATE reservation …` contra una tabla que se llama `reservations`. La regla es
   mecánica y no exige leer `src/main/java`: **el nombre de la entidad, pluralizado y en
   `snake_case`** (`Reservation` → `reservations`, `StockCount` → `stock_counts`), con las
   columnas en `snake_case` del campo (`reserveStockAwaitingSince` →
   `reserve_stock_awaiting_since`); en el modelo documental la colección sale de la misma
   regla. **Las tablas del propio mecanismo son la excepción y van en singular**, porque no
   son entidades del diseño: `processed_event`, `idempotency_record`, `outbox_event`.
   Cuando exista, el DDL exportado en `build/schema/baseline.sql` lo confirma sin salir de
   la caja negra — pero en la fase 1 todavía no existe, así que la regla es la fuente. Un
   `db(...)` que falla por «relation does not exist» no es un defecto del servidor y no
   debe escribirse como si lo fuera.

   **Un UUID tampoco se escribe a mano: va por `uuidLiteral(id)`.** El motor decide cómo se
   escribe un identificador dentro de una sentencia, y en MySQL la columna no es texto —
   Hibernate mapea `java.util.UUID` a `binary(16)`, así que hace falta `UUID_TO_BIN('…')`.
   `build` genera ese helper en `AbstractFlowIT` con la forma del motor elegido; compónerlo a
   mano es adivinar.

   Y este falla **peor** que el nombre de una tabla, que es lo que lo hace caro: el literal en
   texto plano no casa con ninguna fila **ni da error**. El `WHERE` sale vacío, el `INSERT`
   guarda algo que después no encuentra nadie, y lo que se lee no es «he escrito mal el SQL»
   sino «el servicio no hizo lo que tenía que hacer». En una corrida se adivinó mal **tres
   veces**, en tres clases distintas y a lo largo de dos rondas de arbitraje.

   **Y la columna del bloqueo optimista se llama `lock_version`, no `version`.** Una fila
   sembrada sin ella —o con el nombre equivocado— falla al primer `UPDATE` del servicio, y el
   rojo aparece en el escenario, no en la siembra que lo causó.
5. Por `devtools("cli", "arg", …)` en crudo, solo para lo que ninguna de las vías anteriores
   alcanza. Los argumentos van como **lista**, nunca como una cadena concatenada: es un
   `<runtime> exec` directo, sin shell. Si hace falta un pipe o una redirección, la variante
   explícita es `devtoolsShell("…")`. Y los servicios de respaldo se nombran **por su nombre
   de red** (`db`, `minio`, `kafka`, `keycloak`), nunca por `localhost`, por lo mismo que en
   el punto anterior.

## Eventos entrantes: `deliverXxx(...)` y la reentrega

`publishedMessages` lee lo que este servicio **publica**. Su simétrico es
`deliver<Evento>(messageId, payloadJson)`, que `build` genera por cada suscripción del
diseño y **entrega** un mensaje en el canal real del proveedor, como si lo hubiera puesto
él. Es la única forma de materializar un `When` del tipo «llega el evento X», y por tanto
la única de ejercitar una suscripción de punta a punta.

El helper ya sabe cuatro cosas que son del **diseño**, no del test, y por eso no se
reimplementan: el destino físico de la suscripción (que **no** es el topic propio del
servicio, sino el del proveedor), la envoltura que declara su `contract`
(`keel` / `wrapped` / `none`, con su `payloadPath`), dónde viajan el discriminador y la
clave de deduplicación (cabecera o campo), y **dónde viaja la identidad de quien pide el
trabajo**. El test solo aporta el payload.

Esa cuarta es la que cambia la firma. Cuando la suscripción declara `identity`, el helper
recibe un parámetro más:

```java
deliver<Evento>(String messageId, String source, String payloadJson)
```

`source` es el valor que el consumidor va a resolver a un inquilino, puesto exactamente
donde `identity.from` dice que viaja (un campo de la envoltura, o una cabecera del broker).
Es un parámetro y no una constante porque **el escenario multi-inquilino consiste
precisamente en variarlo**: dos entregas que solo difieren en `source` son dos emisores
distintos, y un valor que no corresponda a nadie registrado es lo que ejercita
`onUnresolved`. Sin ese parámetro todos los mensajes del arnés vienen del mismo emisor y
ese grupo de escenarios no es escribible — el dato no puede colarse por `payloadJson`,
porque el DSL prohíbe que la identidad viaje en el payload.

Las suscripciones que **no** declaran `identity` conservan la firma de dos parámetros.

**La reentrega se escribe llamando dos veces con el mismo `messageId`:**

```java
String mid = UUID.randomUUID().toString();
deliverWithdrawalRejected(mid, "{\"productId\":\"" + productId + "\"}");
await(Duration.ofSeconds(15), () -> "active".equals(jsonPath(get("/api/v1/products/" + productId), "$.status")));

deliverWithdrawalRejected(mid, "{\"productId\":\"" + productId + "\"}");   // MISMO mid: reentrega
// El Then afirma que NO hay segundo efecto.
```

Con `messageId` **distintos** son dos hechos distintos, no una reentrega: un escenario así
pasa en verde contra un consumidor que no deduplica nada, que es exactamente el fallo que
se pretendía cazar. Es el mismo error que una aserción negativa de mensajería sin evidencia
afirmativa, y cuesta lo mismo: falsa seguridad.

Dos consecuencias prácticas:

- **El efecto es asíncrono.** Se afirma con `await(...)` sobre una lectura por la API, nunca
  en la línea siguiente a la entrega.
- **Una compensación siempre lleva los tres escenarios** —el efecto completo, la reentrega y
  la doble entrega simultánea—, porque deshacer dos veces el mismo trabajo no es deshacerlo.
  Es el camino que menos se ejercita a mano y el que más cuesta cuando está roto: solo se
  ejecuta cuando algo ya había salido mal.

### La doble entrega simultánea y la llamada de vuelta

Los otros dos escenarios de una compensación no son variantes del primero.

**Simultánea.** La reentrega secuencial encuentra la marca de `processed_event` ya
commiteada, así que pasa aunque nada arbitre la ventana previa al commit — que con réplicas
es el caso normal. Se escribe con `race`, con el mismo `messageId` en las dos ramas:

```java
String mid = UUID.randomUUID().toString();
String body = "{\"productId\":\"" + productId + "\"}";
race(List.of(
    () -> { deliverWithdrawalRejected(mid, body); return null; },
    () -> { deliverWithdrawalRejected(mid, body); return null; }
));
// El Then: disyunción cerrada del estado + un conteo por la API que no dependa del ganador.
```

**La llamada de vuelta.** El estado propio leído por la API es solo la mitad de la
compensación, y la barata. Si lo que se deshace se le encargó a un proveedor por un cliente
de `http-clients`, el `Then` afirma también **la cancelación que sale hacia él**, con
`stubCallCount(...)` y `stubRequests(...)`:

```java
await(Duration.ofSeconds(15), () -> stubCallCount("DELETE", "/withdrawals/.*") == 1);
String body = stubRequestBody(stubRequests("DELETE", "/withdrawals/.*").get(0));
```

Sin esa aserción, un servidor que revierte su fila y nunca avisa al proveedor pasa el
escenario entero: queda internamente coherente y deja un encargo vivo ahí fuera que nadie va
a cancelar. Es caja negra —el proveedor de prueba es un proceso aparte que habla HTTP por el
mismo socket—, así que **no** se sustituye por mirar la base de datos.

## Outbox: el canal indisponible

Solo con `reliability: outbox` en el diseño. Es el **único** escenario del arnés que toca la
infraestructura, y la razón es que el mecanismo consiste precisamente en no depender de que
esté disponible: no hay forma de observarlo sin quitarla de en medio.

`AbstractFlowIT` genera dos helpers para eso: `stopBroker()` detiene el contenedor del broker
y `startBroker()` lo levanta **y espera a que vuelva a aceptar conexiones** (con LocalStack,
además resiembra la topología, que no sobrevive al reinicio).

```java
purgeMessages("catalog.events");                         // la ventana empieza aquí
stopBroker();
try {
    Response created = post("/api/v1/products", body);
    assertBody(created, EXPECTED);                       // la API responde igual
    assertFalse(publishedMessages("catalog.events", 1).contains("ProductCreated"));
} finally {
    startBroker();                                       // SIEMPRE, pase lo que pase arriba
}
await(Duration.ofSeconds(20), () -> publishedMessages("catalog.events", 5).contains("ProductCreated"));
```

Tres reglas, y saltarse cualquiera convierte el escenario en decorativo o en una avería:

- **El `startBroker()` va en un `finally`.** Un flujo que deje el broker caído envenena todos
  los siguientes de la suite, que fallarán por una causa que no es la suya. Como red,
  `resetState()` lo levanta al principio de cada clase de flujo, pero eso es la red, no el
  plan: entre el fallo y el siguiente `@BeforeAll` puede haber varios escenarios del mismo
  flujo dando por buena una infraestructura que no está.
- **La aserción del canal vacío va ANTES de levantar el broker**, y es la que hace que el
  escenario pruebe algo. Sin ella, un servidor que publica en línea dentro de la transacción
  pasa el escenario completo: su mensaje también acaba llegando.
- **«Exactamente uno» tras la recuperación**, no «al menos uno». Un relay que entrega pero no
  marca la fila reentrega para siempre, y sin ese conteo pasaría igual.

**## Lo que acabó en el descarte

Solo con `onFailure.deadLetter` en la suscripción. `deadLetterMessages(<suscripción>, n)`
devuelve los últimos `n` mensajes de su cola de descarte, o cadena vacía si no hay ninguno.
El destino lo resuelve build por broker (`<topic>.DLT` en Kafka, `<destino>-dlq` en RabbitMQ,
`<cola>-dlq` en SQS): el escenario nombra la **suscripción del diseño**, nunca una cola.

Su uso principal es la aserción **negativa**, y es la que justifica que exista:

```java
deliverWithdrawalRejected(messageId, payload);
deliverWithdrawalRejected(messageId, payload);          // el mismo messageId, otra vez
await(..., () -> "active".equals(statusOf(productId)));
assertTrue(deadLetterMessages("WithdrawalRejected", 5).isBlank());
```

Que el efecto ocurra una sola vez no dice **cómo**. Un duplicado absorbido por la guarda de
idempotencia y un duplicado que reventó por dentro dejan el estado propio idéntico: la
diferencia es que el segundo acabó en el descarte, y sin esta aserción un servicio que trata
la repetición como error pasa el escenario en verde mientras llena la DLQ en producción.

Dos avisos:

- **Con Kafka el topic `.DLT` no existe hasta el primer descarte**, así que el helper traduce
  «topic desconocido» a vacío. Es correcto —no hay descarte— pero significa que la aserción
  negativa también pasa si la topología no se creó: la positiva (un escenario que sí mande
  algo al descarte) es la que prueba que el canal existe.
- **No lo uses como sinónimo de «falló»**. Un mensaje llega al descarte tras agotar los
  reintentos declarados, así que entre el fallo y el descarte hay tiempo: aserta con `await`,
  no con una lectura puntual.

El tiempo de espera tras levantar el broker no lo manda el backoff del relay.** Es el error
natural —el relay es lo que estamos mirando— y hace fallar el escenario con el servidor
funcionando perfectamente. Quien domina la recuperación es el **cliente del broker**: cuando el
canal cae, el envío no falla rápido, sino que arrastra la conexión muerta hasta su timeout de
petición. Con Kafka eso es `request.timeout.ms`, **30 s por defecto**, y hasta que esa petición no
se cancela el relay sigue bloqueado en su `join()` sin volver a intentarlo. Un backoff acortado a
1–2 s en el perfil `local` no adelanta nada.

Así que la ventana tiene que cubrir **timeout del cliente + reconexión + un ciclo de relay**:
**60 segundos** es el mínimo prudente con los defaults. Medido, no estimado: en una corrida real
con ventana de 20 s el evento llegó **1,3 s después** de que expirara la espera, y el veredicto
del arbitraje fue `culprit: test` — la aserción era demasiado estricta, no el servidor
incumplidor.

Que la espera sea larga no la vuelve laxa: lo que se afloja es cuánto se espera al **primero**,
nunca el «exactamente uno» de la regla anterior.

Este escenario cumple por sí solo la regla de § Lo que no se ve por HTTP sobre las aserciones
negativas: la evidencia afirmativa de que el canal entrega es el propio `await` final, en el
mismo test. No hace falta añadir ninguna otra.

## Idempotencia simultánea

Toda operación con `idempotency` lleva dos escenarios, y el segundo es una carrera: el
reintento secuencial encuentra el registro de la clave ya commiteado y lo resuelve una
lectura, así que pasa aunque nada arbitre la ventana previa al commit — que es justo la que
golpea un cliente con reintentos automáticos.

```java
String key = idempotencyKey();
List<Response> results = raceOf(2, () -> exchangeWithKey(HttpMethod.POST, "/api/v1/orders", body, null, key));
// Disyunción cerrada: ambas 201, o una 201 y la otra 409 IDEMPOTENCY_KEY_IN_PROGRESS.
// Y la aserción que no depende del ganador: la API cuenta exactamente un pedido.
```

`409 IDEMPOTENCY_KEY_IN_PROGRESS` **no es un fallo**: es el contrato de la perdedora, cuya
transacción revirtió entera, así que de las dos peticiones se ejecutó exactamente una. Un
`Then` que solo enumere los desenlaces admisibles no puede fallar: el conteo leído por la API
es obligatorio.

Si `deliverXxx` deja el escenario en timeout mudo, los dos sospechosos por orden son el
**topic** al que escucha el listener (tiene que ser el que declara `parameters/`, que es al
que el arnés entrega) y el **discriminador** del contrato, no el arnés.

### Qué deja limpio el reset, exactamente

`resetState()` cubre lo que enumera `infra/reset-db.sh`: **datos de la BD** (esquema
intacto — en relacional, `flyway_schema_history` aparte; en documental, colecciones e
índices en pie), **claves `<servicio>:*` de la caché** y los **destinos de mensajería
declarados** en `messaging.keel.yaml § channels` (en Kafka, que no tiene purga, la ventana la
abre una marca de offset con el mismo efecto observable).

El reset limpia **datos**, nunca **esquema**. Si un campo del dominio cambió de nombre entre
iteraciones, `ddl-auto: update` dejó la columna vieja con su `NOT NULL` y toda escritura de ese
agregado falla con un conflicto de integridad que ningún `Then` menciona; con base documental
el equivalente es un índice que cambió de forma y que Mongo se niega a recrear con el mismo
nombre. Ninguno de los dos lo arregla `resetState()` sino `bash infra/reset-db.sh --schema`, y
el diagnóstico está en `infra-validation.md § Cuando el esquema queda a medio camino`.

**`clearCache()`** es el subconjunto de caché de ese reset, con su misma orden: vacía las claves
`<servicio>:*` sin tocar nada más. Es lo que necesita el `Then` que mide un *miss* a mitad de
flujo —que un dato se volvió a pedir al proveedor después de invalidarse— sin llevarse por
delante los datos que dejaron los escenarios anteriores del mismo flujo. No se sustituye por un
`devtoolsShell("redis-cli … DEL")` escrito a mano: el conjunto de claves que borra el helper y el
que borra el reset son el mismo por construcción, y dos órdenes distintas se desalinean.

Un recurso que **no** esté en esa lista no se da por limpio por analogía con la BD: o se
purga en el propio test, o se declara en `assumptions` del reporte. Sin declararlo, el
supuesto solo se rompe cuando alguien lleva varias sesiones de trabajo acumuladas — y
entonces falla media suite a la vez por una razón que ningún `Then` menciona.

## El arnés es del generador

`AbstractFlowIT`, `FailureCapture` y `HarnessSmokeIT` los escribe `keel-spring build`. No
son del flujo y no se tocan para hacer pasar un test.

- **Fase 1** (sin infraestructura): solo lectura. Lo que falte va a `blockers`.
- **Fase 2**, con un fallo que el arbitraje clasifica como `culprit: harness`: se permite el
  parche local **mínimo**, y es **obligatorio** registrarlo en `harnessPatches:` del reporte
  (archivo, método, causa raíz, fix). Ese bloque es la única vía por la que un defecto del
  arnés vuelve al generador: sin él, cada proyecto que se genere lo redescubre desde cero y
  paga otra vez el mismo diagnóstico.

`HarnessSmokeIT` es lo primero que ejecuta la fase 2
(`./gradlew integrationTest --tests '*HarnessSmokeIT'`): comprueba el reset, el servidor,
las credenciales, la lectura/purga de los canales declarados y el vaciado de la caché. En
rojo, el problema es del arnés o de la infraestructura y **no se ejecuta la suite**: correr
26 clases sobre una fontanería rota produce una matriz de fallos que parecen de negocio y
no lo son.

Los efectos asíncronos (publicación, consumo de una suscripción) se esperan con
`await(Duration.ofSeconds(n), () -> …)`, nunca con `Thread.sleep` a ojo.

Y `n` tampoco se elige a ojo: **el techo de cualquier espera tiene que exceder el periodo
del mecanismo que produce el efecto que espera**. Si lo que empuja el trabajo es una
operación con `schedule`, ese periodo es su `cron` — más el desfase de fase que `build`
reparte entre barridos de la misma cadencia (hasta 60 s: ver `conventions/dependencies.md`
§ varios barridos en el mismo proceso). Un techo menor que el periodo no falla siempre:
falla **según la fase del minuto en que arranque la suite**, que es verde o rojo por el
reloj y no por el código — el peor modo de fallo que puede tener una prueba, porque
reintentarla la "arregla".

Lo mismo, y por la misma razón, en las aserciones **negativas**: un «no debe salir» que
espera menos que el periodo del barrido sale verde **siempre**, también cuando el efecto
acaba ocurriendo. Ahí el margen corto no produce un test intermitente, produce uno que no
comprueba nada.

Los helpers de espera que `build` genera ya vienen dimensionados así (`MAIL_AWAIT_SECONDS`
sale del `schedule` más rápido del diseño). Si te encuentras subiendo un techo a mano para
que un escenario deje de ser intermitente, eso es un **defecto del arnés**, no tuyo:
repórtalo en vez de parchearlo, porque el siguiente proyecto que se genere lo redescubrirá.

## Escenarios de carrera

Un escenario cuyo `When` dice «a la vez» se escribe con `race(...)` o `raceOf(n, ...)` del arnés, **nunca
con un `ExecutorService` propio**: los helpers arrancan todas las tareas del mismo latch, y sin eso
«simultáneo» acaba siendo «una detrás de otra» —el coste de crear cada hilo basta para serializarlas— y el
escenario pasa en verde sin haber ejercitado ninguna carrera.

```java
List<Response> responses = raceOf(2, () -> exchangeWithKey("POST", "/api/v1/reservations", body, token, key));
```

Tres reglas al usarlos:

- **Toda aserción, en el hilo del test.** `race` junta y devuelve; no assertes dentro de la lambda. Es
  también lo que mantiene íntegro el volcado de `FailureCapture`.
- **El `Then` va como disyunción cerrada**: enumera los desenlaces admisibles, porque bajo una carrera real
  no hay uno solo. Lo que **no** vale es cruzar dos observaciones distintas para deducir quién ganó.
- **Más al menos una afirmación que no dependa del ganador**, y esa es la que prueba algo de verdad:
  normalmente un conteo leído por la API («la lista contiene exactamente un recurso»). Un escenario que
  solo enumera desenlaces admisibles no puede fallar.

Estas carreras se ejercitan **dentro de una instancia**, y basta: el servidor es multihilo y el árbitro de
la carrera —la clave primaria, el lock de fila— es el mismo que arbitraría entre réplicas. Lo que no se
puede ejercitar así son las carreras entre `@Scheduled` de réplicas distintas; ver
[`concurrency.md` § Lo que ningún gate cubre](concurrency.md).

Inspeccionar la base de datos sirve para **diagnosticar** un fallo, jamás para **definir** el
criterio de aceptación: lo que solo es verificable por dentro no es contrato.

## El proveedor de prueba (capa `http-clients`)

Los servidores de los que este depende por HTTP **no están** en `infra/`: en su lugar hay un
**WireMock** en `http://localhost:8090`, y las `base-url` de los clientes apuntan ahí en el perfil
`local` —el que activan estas pruebas—. Sin él, cualquier flujo que atraviese un cliente falla por
conexión rechazada, que no dice nada sobre el código.

**No contradice la regla de arriba.** Lo prohibido son los dobles que sustituyen la fontanería
*dentro* de la JVM (`@MockBean`, `@EmbeddedKafka`): con ellos no se valida el adaptador real, ni la
serialización, ni el timeout, ni el circuit breaker. El stub es un proceso aparte que habla HTTP por
el mismo socket que hablaría el proveedor — exactamente lo que LocalStack es para SNS/SQS. El
servidor no sabe que no es real, y la prueba sigue siendo de caja negra.

Helpers de `AbstractFlowIT`:

| Helper | Para qué |
|---|---|
| `stubFor(método, patrónRuta, status, cuerpoJson)` | El Given: qué responde el proveedor en **este** escenario |
| `stubFailure(método, patrónRuta, status)` | Ejercitar `onFailure`/`onMiss` y el circuit breaker (5xx reintenta, 4xx no) |
| `stubConnectionFault(método, patrónRuta)` | El proveedor **no contesta**: corta la conexión. Lo que ejercita `retryOn: [connection]` |
| `stubTimeout(método, patrónRuta, msDeRetraso)` | El proveedor tarda más de lo que la llamada tolera. Lo que ejercita `retryOn: [timeout]`; el retraso tiene que superar el `timeoutMs` declarado |
| `stubCallCount(método, patrónRuta)` | El Then: cuántas veces se llamó al proveedor — la única forma en caja negra de afirmar que un dato se cacheó, o que algo no se reintentó |
| `stubRequests(método, patrónRuta)` | El Then que no se conforma con cuántas veces, sino con **qué** se envió: devuelve el log de peticiones recibidas, cada una como el JSON del stub |
| `stubRequestBody(peticiónJson)` | El cuerpo saliente de una de esas peticiones, para compararlo con `assertJson(...)` |
| `deadLetterMessages(suscripción, n)` | Lo que acabó en la cola de descarte de una suscripción con `onFailure.deadLetter`; vacío si nada. Ver § Lo que acabó en el descarte |
| `stubRequestHeader(peticiónJson, nombre)` | Una cabecera de esa petición, sin distinguir mayúsculas (el caso lo elige el cliente HTTP, no el contrato). `null` si no viajaba |
| `resetStubs()` | Limpieza explícita a mitad de un flujo; entre clases ya lo hace `resetState()` |

Reglas:

- **El Given programa lo suyo, y solo lo suyo.** Un mapping que sobrevive a su escenario es estado
  global: el orden de ejecución acaba decidiendo el resultado. `resetState()` los borra por clase.
- **Los mappings van en el test, no en `infra/http-stubs/mappings/`.** Un archivo esconde en otro
  sitio la mitad del escenario. El directorio existe para lo que no pertenece a ningún flujo.
- **El patrón de ruta es la ruta del proveedor**, la que declara la llamada en `http-clients`
  (`urlPathPattern`, regex sobre el path sin query).
- **El modo de fallo del Given es el que declara `retryOn`, no el más cómodo de escribir.** Un
  5xx y un corte de conexión no son intercambiables: una escritura ajena suele declarar
  `retryOn: [timeout, connection]` —repetir un 5xx puede duplicar el efecto— y con ella un
  `stubFailure(..., 503)` **no** se reintenta. Un escenario que espera reintentos sobre un 503
  ahí no mide el retry: contradice el diseño, y el arbitraje correcto es corregir el escenario.
- **Un `Then` sobre lo que se envió se asserta con el log, no con el conteo.** «La llamada al
  proveedor llevaba tal dato» y «la llamada iba con `Idempotency-Key`» son cláusulas distintas de
  «se llamó una vez», y `stubCallCount` no las cubre: dan igual con el cuerpo vacío. La segunda es
  la que sostiene que un reintento *nuestro* no encarga dos veces el mismo trabajo, así que
  dejarla sin asertar deja sin probar la garantía entera:

  ```java
  String call = stubRequests("POST", "/scans").get(0);
  assertJson(stubRequestBody(call), """
      {"assetId": "%s", "storageKey": "%s"}""".formatted(assetId, storageKey));
  Assertions.assertNotNull(stubRequestHeader(call, "Idempotency-Key"));
  ```
- La sonda `SMOKE-6` cubre el ciclo entero (programar, llamar, contar, resetear). Si está roja, el
  problema es del arnés o del compose: no se ejecuta la suite.

## El buzón de correo (capa `mail`)

Un servicio que manda correo tampoco tiene a quién mandárselo en `infra/`: en su lugar hay un
**Mailpit** en `http://localhost:8025`, y `spring.mail.*` apunta a su SMTP (`localhost:1025`) en el
perfil `local`. Es un servidor SMTP real que acepta la conexión y el mensaje y **no entrega nada a
nadie**: se lo queda y lo sirve por una API REST.

Vale la misma justificación que el proveedor de prueba: es un proceso aparte hablando SMTP por el
mismo socket que hablaría el proveedor contratado, no un doble dentro de la JVM. Y da algo que un
doble no daría: ningún correo de pruebas puede llegar a una dirección real.

**Lo que separa una prueba de regresión de «lo he mirado y se ve bien» es esa API.** Sin ella, la
verificación del correo es siempre manual.

| Helper | Para qué |
|---|---|
| `awaitMailTo(dirección, n)` | **Por aquí empieza todo Then sobre correo** — y solo dentro de un `@Test` o de `awaitPreconditions(...)`, nunca en `@BeforeAll` (regla 9). Espera hasta `MAIL_AWAIT_SECONDS` (derivado del `schedule` más rápido del diseño) a que haya `n` correos para esa dirección y devuelve sus ids, el más reciente primero |
| `lastMailTo(dirección)` | El más reciente, ya resuelto a su detalle completo (espera igual que el anterior) |
| `mailSubject(mensaje)` | El asunto tal como lo lee quien lo recibe: ya interpolado y ya saneado |
| `mailHtml(mensaje)` / `mailText(mensaje)` | Las dos partes del cuerpo. Con `delivery.parts: [html, text]` hay que afirmar sobre las dos |
| `mailFrom(mensaje)` | El remitente desde el que salió |
| `mailCount(dirección)` | Cuántos hay **ahora**, sin esperar. Para el segundo correo que NO debe existir |
| `assertNoMailTo(dirección)` | Que no salió ninguno. El Then de los rechazos |

Reglas, y las tres primeras son la misma idea:

- **El `Then` afirma sobre el buzón, no sobre el status.** La operación responde **aceptando el
  encargo** (un `202`, o cualquier salida que no prometa que el correo ya salió), y eso es
  deliberado: es lo que impide que la disponibilidad del proveedor SMTP entre en la transacción de
  quien llama. Un escenario cuyo `Then` menciona el correo y solo comprueba el `202` no cubre nada.
- **La espera no es opcional.** La entrega ocurre **después** de la respuesta. Una lectura seca
  justo tras el 2xx es una carrera: el escenario fallaría unas veces sí y otras no, que es peor que
  fallar siempre. Por eso `awaitMailTo` espera y `mailCount` no.
- **`mailCount` nunca es la primera lectura.** Es para afirmar que no hay un *segundo* correo, y
  solo vale después de haber esperado al primero con `awaitMailTo`. Contar sin haber esperado nada
  mide el estado de antes de que ocurriera lo que se quería medir, y sale verde siempre.
- **Un rechazo se afirma con `assertNoMailTo`, no con la ausencia de aserción.** Es lo único que
  distingue «el rechazo llegó antes del envío» de «el rechazo llegó después, y el correo ya salió».
  Cada `error` declarado que ocurra antes del envío necesita su escenario.
- **La repetición se prueba de verdad.** Un correo que sale no lo deshace ninguna transacción, y el
  destinatario es una persona real: el escenario que repite la operación con su guarda
  (`idempotency` o la transición declarada) y comprueba `mailCount == 1` es el que sostiene esa
  garantía. Sin él, la guarda está declarada y nadie sabe si se aplica.
- **La espera va donde su fallo sea atribuible.** Si el correo es una *precondición* del
  escenario y no su `Then` —hay que esperarlo para sembrar lo siguiente—, no se sube a
  `@BeforeAll`: se envuelve en `awaitPreconditions(...)` desde `@BeforeEach`. Regla 9.
- **Un `Then` sobre un estado transitorio se lee sin esperar.** «En este instante todavía no ha
  salido», «aún no», «antes de que el despacho corra» son afirmaciones sobre el **ahora**, y se
  leen con `mailCount`/`lastMailTo` directos. `assertNoMailTo` no vale ahí: espera —más de lo que
  tarda el cron de despacho—, así que para cuando responde el correo ya salió y el escenario falla
  midiendo un instante que no era el suyo. `assertNoMailTo` es para los rechazos **permanentes**:
  el correo que no va a salir nunca.
- `resetState()` vacía el buzón entre clases. Un correo del flujo anterior haría que el primer
  `awaitMailTo` devolviera el mensaje equivocado — el mismo fallo que la purga de los canales evita
  en el broker.

Lo que **no** se puede probar aquí, y por eso no se intenta: Mailpit no rebota nada (una lista de
supresión alimentada por el webhook del proveedor se ejercita invocando el endpoint con un payload
de ejemplo, nunca provocando un rebote), no dice nada sobre entregabilidad (SPF, DKIM, DMARC y
reputación son trabajo de DNS y de proveedor) y no aplica los límites del proveedor: lo acepta todo.


## Lo que se declara en vez de simularse

Un escenario que el diseño no permite ejercitar de forma determinista no se traduce a un
test que siempre pasa: se declara en `uncovered` con su motivo. Casos típicos: la DLQ de
`onFailure` (exige provocar el fallo del handler desde fuera) y las operaciones con
`schedule`. Declararlo es información; un test decorativo es ruido que además da falsa seguridad.

Con una salvedad que conviene decir en voz alta, porque es donde esa exención sale más
cara: la operación de una **reconciliación** (`activations.<a>.reconciledBy`) siempre cae
aquí —el arnés es caja negra y un cron no se alcanza desde fuera— y es justo la que
detecta lo que no ha pasado. `uncovered` no significa que nadie la mire: la cubre
`infra/check-idempotency.sh` en estático (que el `@Scheduled` ya no lance, que el umbral
salga de `parameters/`), y la prueba en vivo la hace el diseñador. Lo que no vale es
inventarle un escenario que dispare el barrido por una puerta que el diseño no tiene.

**El outbox estuvo en esta lista y ya no está**, y la razón vale como criterio general. Su
disparador tampoco es alcanzable —el relay corre por el reloj, igual que el barrido—, pero su
**efecto sí**: el evento aparece o no aparece en el canal, y quitando la infraestructura de en
medio esa diferencia se vuelve observable (ver § Outbox: el canal indisponible). Antes de
declarar `uncovered` un mecanismo, la pregunta no es «¿puedo llamarlo?» sino «¿hay algo que
cambie ahí fuera según esté bien o mal?». Si lo hay, el escenario existe aunque no se parezca
a los demás.

**Depender de otro servidor ya no es motivo de `uncovered`**: con el stub, un flujo que lee o activa
a un proveedor se programa y se puntúa como cualquier otro, y su camino de fallo también
(`stubFailure`). Solo queda fuera lo que el stub no reproduce de forma determinista — una caída a
mitad de respuesta, o una degradación que depende de la latencia real del proveedor.

## Ejecución

| Comando | Cuándo | Quién |
|---|---|---|
| `./gradlew compileIntegrationTestJava` | fase 1, al terminar de escribir | `keel-spring-tests` |
| `bash infra/score-scenarios.sh` | fase 2, y tras **cada** ciclo de fix | Orquestador (script, sin agente) |
| `./gradlew integrationTest --tests '<Clase>'` | tras corregir un `culprit: test` | `keel-spring-tests` |
| `./gradlew integrationTest --tests '<Clase>'` | tras corregir un `culprit: code` (fase 2) | `keel-spring-code` |
| `./gradlew integrationTest` | fase 3, no-regresión tras el pase de calidad | `keel-spring-quality` |

El script encadena el humo del arnés (`--tests '*HarnessSmokeIT'`) y, solo con él en verde, la
suite completa; después compone la matriz desde el XML de JUnit. `keel-spring-validate` **no
ejecuta nada**: recibe los fallos ya puntuados y solo los arbitra.

Los dos usos de `--tests` sobre una clase de flujo son **verificación local del propio fix**,
no un veredicto: la matriz de aceptación sale siempre de la ejecución completa del script,
que es la única que puede ver una regresión en un flujo distinto del corregido.

Cuando lo corregido es un componente **compartido** (un método de `AbstractFlowIT`, un helper
que usan varias clases), la verificación local no son dos o tres clases de muestra: se hace
`grep` del método corregido y se ejecutan **todas** las clases que lo usan. Un arreglo en el
arnés puede tapar un síntoma y dejar debajo una segunda causa distinta en el mismo archivo —
que es como un solo defecto acaba costando tres pasadas completas de validación. Y como ambos agentes
ejecutan la suite sobre la misma base de datos —`resetState()` la vacía en cada `@BeforeAll`—,
el orquestador los relanza en serie, nunca a la vez.

`./gradlew build -x test` **no** las ejecuta, a propósito: sigue siendo el gate de
compilación y debe poder correrse sin infraestructura.
