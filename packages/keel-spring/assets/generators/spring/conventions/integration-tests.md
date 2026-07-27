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
7. Ningún archivo que genera `keel-spring build` se edita para hacer pasar un test:
   `AbstractFlowIT` y `FailureCapture` son andamiaje del generador, no del flujo. Si uno de
   ellos está mal, es un `blocker` del reporte — parchearlo en local esconde el defecto y lo
   reintroduce la siguiente regeneración.

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
        assertThat(response.header("Location")).endsWith("/products/" + productId);
        productId = jsonPath(response, "$.id");
        assertIsUuid(productId);
        assertBody(response, """
            {"id": "%s", "sku": "ACME-1", "name": "Martillo", "status": "draft",
             "version": 0, "createdAt": "%s", "categoryId": "%s", "images": []}"""
            .formatted(productId, jsonPath(response, "$.createdAt"), categoryId));
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
3. Por `devtools(...)` en crudo, solo para lo que ninguna de las dos vías alcanza.

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
| `./gradlew integrationTest` | fase 2, con infra arriba y código compilando | `keel-spring-validate` |
| `./gradlew integrationTest --tests '<Clase>'` | tras corregir un `culprit: test` | `keel-spring-tests` |
| `./gradlew integrationTest` | fase 3, no-regresión tras el pase de calidad | `keel-spring-quality` |

`./gradlew build -x test` **no** las ejecuta, a propósito: sigue siendo el gate de
compilación y debe poder correrse sin infraestructura.
