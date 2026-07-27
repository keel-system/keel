# Auditoría de fidelidad al flujo

Checklist **obligatoria antes de editar cada handler**. La ejecuta el agente de código
(`keel-spring-code`) por cada operación, cruzando `use-cases.keel.yaml` +
`domain.keel.yaml` + los flujos `FL-*` de `specs/validation-scenarios.md`. Su objetivo
es que la implementación cubra exactamente lo que el diseño declara — ni menos (casos
borde sin cubrir) ni más (comportamiento inventado).

Si la auditoría revela una **contradicción entre artefactos** (use-cases vs api vs
validation-scenarios) o un hueco del diseño (un caso borde sin `error` declarado),
**detente y repórtalo como bloqueo**: es un defecto del diseño que se corrige en los
artefactos, nunca se resuelve en silencio en el código.

## Checklist por operación

- **Campos opcionales**: si un componente del input tiene `required: false`, parsea o
  consulta ese valor solo cuando venga presente. Nunca `UUID.fromString(command.x())`
  ni una consulta por un campo opcional sin guardia de nulidad.
- **Casos borde**: cada escenario de error o borde de los flujos `FL-*` que tocan la
  operación debe quedar cubierto por una excepción de dominio (`<PascalCode>Error` con
  el `code` **exacto** de `errors[]`), una transición idempotente o una respuesta
  explícita. Si el escenario existe pero el `error` no está declarado en el diseño →
  bloqueo (hueco del diseño).
- **Estado terminal**: un estado del `lifecycle` con transiciones `[]` es terminal.
  Verifica **todos** los métodos afectados (actualización, entidades hijas, cambios de
  estado), no solo el handler de la transición: ninguna mutación debe aceptarse sobre
  una raíz en estado terminal si el diseño no lo permite.
- **Transiciones idempotentes**: si un flujo exige éxito cuando el estado ya es el
  destino, el método de dominio retorna sin re-emitir el evento. El guard genérico
  `transitionTo` no cubre esto: hazlo explícito en el método semántico.
- **Entidades hijas del agregado**: remover o actualizar una hija inexistente debe
  buscar primero y lanzar el `*_NOT_FOUND` declarado; nada de `removeIf` silencioso.
- **Eventos — emisión y no-emisión**: confirma que se publica exactamente lo que
  `emits` declara, y que los caminos de error o idempotentes **no** publican. El
  nombre del evento es contrato público: se copia exacto.
- **Validación cross-agregado**: una precondición que consulta otra raíz de agregado
  del servicio se hace vía **su** repository (puerto), antes del método de dominio, y
  respetando `consistency.transactionalBoundary` (con `per-aggregate`, el command solo
  muta una raíz; la otra solo se lee). Datos de **otro servicio** llegan por la capa
  `http-clients` o por eventos de `messaging`, nunca inyectando persistencia ajena.
- **Bloqueo optimista**: el `lockVersion` (`@Version`) de la raíz de agregado, su
  round-trip por el constructor de rehidratación y el 409 `OPTIMISTIC_LOCK_CONFLICT`
  **ya los genera build**. Es infraestructura: lo incrementa Hibernate en cada flush,
  no sale al contrato y nadie lo toca a mano.
- **`version` declarado por el diseño ≠ `lockVersion`**: son dos contadores distintos.
  Si el diseño declara un campo `version` en la raíz, es un **contador de dominio**
  (viaja en la API y en los payloads de eventos, y los consumidores descartan por él
  los eventos desordenados): lo incrementa **el agregado**, en cada método mutador que
  el diseño describe como cambio observable — incluidos los que solo tocan entidades
  hijas, donde Hibernate no incrementaría nada. Si una regla dice «la version se
  incrementa en uno», la implementas tú. `expectedVersion` de la entrada se compara
  contra **ese** contador antes de mutar, y su mismatch es el error 409 propio del
  diseño (no el `OPTIMISTIC_LOCK_CONFLICT` de Hibernate).
- **Orden de las guardas**: `preconditions`/`rules` se evalúan en el orden del diseño,
  también cuando otra ubicación sería técnicamente más cómoda (validar el tamaño de un
  archivo al recibir el multipart, en vez de después de la guarda de negocio que el
  diseño pone antes). Si dos guardas pueden fallar a la vez, la que responde es la que
  el diseño pone primero — y eso es lo que comprueba el escenario.
- **Proyección de la respuesta**: el DTO debe exponer **exactamente** los campos que declara
  el `output` de la operación —campos, referencias (`<relación>Id`, o el objeto anidado
  si el output las marca con `embed`) y entidades hijas
  (`List<XxxDto>`), que build ya proyecta. Los `exclude` con **dot-path**
  (`lines.costPrice`, `address.zip`) recortan el DTO **anidado**, que build genera
  completo: lo avisa con un warning y el recorte lo haces tú. Un campo que el diseño
  excluye y acaba en la respuesta es una fuga del contrato, no un detalle de mapeo.
- **Convenciones de determinación**: las que `validation-scenarios.md` fija —en su
  sección de convenciones o en las **Notas de determinación** del escenario— son
  contrato observable, no preferencia de estilo: orden de las colecciones devueltas
  (con su desempate), formato y zona de fechas, escala y redondeo de los importes,
  campo ausente vs nulo en la respuesta, sensibilidad a mayúsculas de la unicidad.
  Implementarlas de otro modo compila, pasa la revisión y hace que este servidor deje
  de ser equivalente al que generaría otro stack del mismo diseño. La escala y el
  redondeo tienen además regla dura —`BigDecimal` con escala y `RoundingMode`
  explícitos, `compareTo` en las comparaciones— en `constitution.md` ("Aritmética y
  precisión") y su forma canónica en `conventions/domain-modeling.md`.
- **Wiring HTTP**: si el binding, el `successStatus`, el `Location` o los query params
  generados no coinciden con `api.keel.yaml`, repórtalo como defecto del scaffolding —
  no cambies firmas ni contratos generados para compensarlo.
- **Imports y compilación**: tras tocar agregados/handlers/mappers/servicios, verifica
  que errores, value objects y DTOs usados están importados y el proyecto compila.

## Revisión mecánica final (una sola pasada, al terminar el código)

Tres defectos reales de generaciones anteriores no rompían la compilación y solo
salieron a la luz ejercitando el servidor. Son verificables **leyendo el código**,
así que recórrelos antes de reportar `status`, aunque nada esté marcado con un TODO:

- **Binding contra la ruta declarada**: por cada endpoint de `api.keel.yaml`, cada
  `{segmento}` de la ruta tiene su `@PathVariable` homónimo en la firma; el cuerpo
  solo aparece en `POST`/`PUT`/`PATCH`; los filtros de un `GET` son `@RequestParam`.
  Un desajuste es defecto del scaffolding: repórtalo, no lo compenses.
- **Ciclos en los mappers**: ningún `toDomain`/`toJpa` de una entidad **hija** invoca
  el mapper completo de su padre. Esa llamada es recursión infinita por construcción
  (`StackOverflowError` al guardar), aunque el flujo que la dispara no esté escrito
  todavía. La back-reference la estampa el padre al mapear su colección.
- **Un solo `ObjectMapper` por comportamiento**: toda configuración que serialice
  objetos del servicio (caché, cliente HTTP, mensajería) usa el `ObjectMapper` de la
  aplicación o replica su configuración, `JavaTimeModule` incluido. Un componente
  serializador escrito «aislado» rompe en el primer campo `Instant`/`LocalDate`, en
  runtime.
- **Claims y credenciales externas**: ningún cambio que dependa del **nombre o la
  forma** de un claim de un JWT, de una cabecera o del payload de una credencial
  externa se da por cerrado sin haberlo comprobado contra un token real ya emitido
  en el entorno de prueba:

  ```bash
  echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq .
  ```

  El nombre de un claim no se deduce de la memoria ni de la spec OIDC: Keycloak
  emite `client_id` (snake_case) donde la intuición dice `clientId`, Cognito no
  emite `aud` en sus access tokens, y cada IdP anida los roles a su manera. Una
  condición escrita sobre un claim que no existe es siempre `false` — compila,
  arranca, y tumba en silencio toda la superficie que protege. Diez segundos de
  `base64 -d` valen un ciclo entero de validación.

- **Vocabulario del contrato**: cada nombre de campo que `validation-scenarios.md`
  menciona en una respuesta existe con ese nombre exacto en el DTO. Es la pasada que
  detecta que un agregado expone `category` y otro `categoryId` para la misma clase de
  relación. Procedimiento completo en `mapping.md`, § Auditoría de consistencia del
  contrato.

## Cierre del paso

Tras implementar el handler, repasa la checklist de nuevo: ningún caso borde de los
flujos que tocan la operación puede quedar sin cubrir. Los tests derivados
(`mapping.md`, sección Tests) son la red que lo confirma.
