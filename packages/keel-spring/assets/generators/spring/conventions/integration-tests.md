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
9. Cada cláusula del `Given` de cada escenario tiene su llamada de siembra y esa llamada
   comprueba su propio status — § Traducir el `Given`. Es auditable leyendo el escenario y el
   test en paralelo: un `Given` que nombra un estado del lifecycle y un test que solo crea la
   entidad es un fallo garantizado, atribuido además al agente equivocado.
10. Todo `jsonPath(...)` se captura en una variable tipada antes de interpolarlo —
    § `jsonPath(...)` va siempre a una variable tipada. Y si la expresión lleva un filtro
    `[?(...)]`, el destino es una `List<...>`, nunca un escalar — § Un filtro devuelve una
    lista, no un elemento. Es auditable con un `grep` de `[?(`: cada uno debe leerse en una
    lista.
11. Toda vía que sirve una entidad desde **caché** compara `createdAt`/`updatedAt` entre la
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

## Aserciones: el cuerpo completo o nada

- `assertBody(response, expectedJson)` compara con **JSONAssert en modo STRICT**: verifica
  en una sola aserción los campos presentes *y* la ausencia de los que no deben venir. Es la
  forma directa de cumplir "el `Then` verifica el cuerpo completo" del documento de
  escenarios.
- Los valores **no deterministas** —ids generados, marcas de tiempo del servidor— no se
  comparan por literal: se extraen con `jsonPath(...)`, se verifican por forma
  (`assertIsUuid`, `assertIsInstant`) y se reinyectan en el JSON esperado para que el STRICT
  siga siendo estricto en todo lo demás.
- Las cabeceras del contrato (`Location`, paginación) se assertan explícitamente:
  `response.header("Location")`.
- Un test que solo comprueba el status **no vale**. Es el modo de fallo que esta convention
  existe para eliminar.

### `jsonPath(...)` va siempre a una variable tipada

`jsonPath` es genérico (`protected <T> T jsonPath(Response, String)`) y no valida nada: el tipo
sale del sitio de la llamada. Interpolarlo directamente revienta en runtime:

```java
// MAL: único argumento de un varargs Object..., javac infiere T = Object[]
//      y el cast interno lanza ClassCastException con el String real que devuelve.
"…%s…".formatted(jsonPath(response, "$.category.id"));

// BIEN: el tipo queda anclado en la declaración.
String categoryId = jsonPath(response, "$.category.id");
"…%s…".formatted(categoryId);
```

La regla es la misma aunque haya varios argumentos: **captura primero, interpola después**.
Además de evitar el fallo, deja la aserción de forma (`assertIsUuid`, `assertIsInstant`) junto a
la extracción, que es donde se lee.

### Un filtro devuelve una lista, no un elemento

La segunda causa de `ClassCastException`, y la que más se propaga porque se copia entre clases.
Una expresión de filtro `[?(...)]` devuelve **siempre** un `JSONArray`, aunque case un solo
elemento, y encadenarle un índice final **no** lo desenvuelve con la configuración por defecto de
la librería:

```java
// MAL: el filtro ya devolvió una lista; el [0] no la desenvuelve y el destino
//      es escalar → ClassCastException (net.minidev.json.JSONArray → String).
String url = jsonPath(response, "$.images[?(@.id=='%s')].url[0]".formatted(imageId));

// BIEN: la lista se lee como lista, se comprueba su tamaño y se indexa en Java.
List<String> urls = jsonPath(response, "$.images[?(@.id=='%s')].url".formatted(imageId));
assertThat(urls).hasSize(1);
String url = urls.get(0);
```

El `hasSize(1)` no es decoración: sin él, un filtro que casa cero elementos falla más tarde y en
otro sitio (`IndexOutOfBounds` en el `get(0)`), y uno que casa dos pasa desapercibido. Casi
siempre es más legible **evitar el filtro**: si el escenario fija el orden de la colección, indexa
por posición (`$.images[0].url`) y deja que el STRICT de `assertBody` cubra el resto.

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
  `@BeforeAll` sin decir por qué. La convención completa —realm, cliente de prueba, usuario
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
3. Por `devtools("cli", "arg", …)` en crudo, solo para lo que ninguna de las dos vías
   alcanza. Los argumentos van como **lista**, nunca como una cadena concatenada: es un
   `<runtime> exec` directo, sin shell. Si hace falta un pipe o una redirección, la variante
   explícita es `devtoolsShell("…")`.

### Qué deja limpio el reset, exactamente

`resetState()` cubre lo que enumera `infra/reset-db.sh`: **datos de la BD** (esquema
intacto, `flyway_schema_history` aparte), **claves `<servicio>:*` de la caché** y los
**destinos de mensajería declarados** en `messaging.keel.yaml § channels` (en Kafka, que no
tiene purga, la ventana la abre una marca de offset con el mismo efecto observable).

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

Inspeccionar la base de datos sirve para **diagnosticar** un fallo, jamás para **definir** el
criterio de aceptación: lo que solo es verificable por dentro no es contrato.

## Lo que se declara en vez de simularse

Un escenario que el diseño no permite ejercitar de forma determinista no se traduce a un
test que siempre pasa: se declara en `uncovered` con su motivo. Casos típicos: la DLQ de
`onFailure` (exige provocar el fallo del handler desde fuera), las operaciones con
`schedule`, y `onMiss: degrade` cuando depende de un proveedor externo. Declararlo es
información; un test decorativo es ruido que además da falsa seguridad.

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
