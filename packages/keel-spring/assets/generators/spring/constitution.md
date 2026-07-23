# Reglas inviolables

Estas reglas no se negocian ni se "acomodan" para que un caso particular compile o pase un test. Si algo del diseño o de un escenario obliga a romper una de ellas, **no la rompas**: repórtalo como bloqueo o como hueco del diseño (ver "Ante ambigüedad" al final).

## Fuente de verdad

- El diseño (`specs/*.keel.yaml` + `specs/validation-scenarios.md`) es la única fuente de verdad funcional. Nada de entidades, campos, endpoints, roles o reglas que no estén en sus artefactos.
- Los `code` de error y los nombres de evento se copian **exactos**: son contrato público, no se abrevian ni se traducen.
- Una contradicción entre artefactos (use-cases vs api vs validation-scenarios) o un caso borde sin `error` declarado no se resuelve en silencio en el código: es un defecto del diseño y se reporta como bloqueo.

## Idioma

- Todo lo que se genera va **en inglés**: nombres de paquetes, directorios, archivos, clases, métodos, variables, tablas y columnas. Los comentarios, la documentación y los mensajes al usuario van en español.
- Los identificadores del diseño ya deben venir en inglés (regla transversal del DSL). Si un artefacto trae un identificador en español, **no lo traduzcas por tu cuenta**: en contratos públicos (`code` de error, nombres de evento, rutas) sería reescribir el contrato, y en el resto crearía divergencia entre diseño y código. Es un defecto del diseño: repórtalo como bloqueo para corregirlo aguas arriba.

## Frontera hexagonal

- `domain` no depende de JPA, Spring ni de ningún paquete de `infrastructure`. Solo POJOs, records y errores puros (`Page`/`Pageable` en los puertos se acepta como único pragmatismo).
- `application` no importa Spring. Sus componentes se marcan `@ApplicationComponent` (nunca `@Component` ni `@Transactional`): la frontera transaccional la abre `UseCaseMediator`, no el handler.
- Un handler de `application` **nunca invoca a otro handler directamente**: si necesita otro caso de uso, despacha su mensaje vía `UseCaseMediator`.
- `infrastructure/rest` (controllers) **solo traduce**: construye o fusiona el mensaje desde los parámetros HTTP y lo despacha vía `UseCaseMediator`. Cero lógica de negocio; los errores quedan para `ApiExceptionHandler`.
- El mapeo domain↔JPA vive **únicamente** en `XxxRepositoryImpl` (`toDomain`/`toJpa` explícitos). Ni los handlers ni los controllers importan ni ven una clase `Jpa`.
- Datos de **otro servicio** llegan por la capa `http-clients` o por eventos de `messaging`, nunca inyectando persistencia ajena.
- Un cliente HTTP saliente se consume **solo por su puerto** `<Cliente>Client` de `domain/clients`; los DTOs wire del tercero y el mapper de anticorrupción (`<Cliente>Mapper`) viven únicamente en `infrastructure/http` — ni handlers ni dominio importan un `<Llamada>Request`/`<Llamada>Response` wire, y un cambio de contrato del tercero se absorbe en el adaptador/mapper, jamás en dominio o application.
- Las credenciales de la auth saliente (`clients.C.auth`) llegan por configuración (`parameters/<perfil>/http-clients.yaml`, env vars), nunca del diseño ni hardcodeadas.

## Modelo de dominio

- El estado de un agregado se muta **únicamente** por sus métodos de negocio: sin setters públicos. El constructor completo es rehidratación desde persistencia (`XxxRepositoryImpl.toDomain`); la creación de negocio pasa por un factory que aplica los invariantes.
- Todo `invariants` declarado en `domain.keel.yaml` tiene una guarda en dominio que lanza el error del diseño. Un invariante sin guarda es generación incompleta, no criterio del agente.

Cómo se escriben esas guardas, el factory, los métodos semánticos del `lifecycle` y los value objects: `conventions/domain-modeling.md`.

## Consistencia y transacciones

- `consistency.transactionalBoundary: per-aggregate` (cuando el diseño lo declara): un command muta una sola raíz de agregado dentro de la transacción del mediator; nunca dos agregados en la misma transacción.
- Un evento se publica exactamente lo que `emits` declara; los caminos de error o idempotentes no publican.
- **Los eventos los emite el agregado**: cada evento de `emits` se hace `raise(<E>Event.of(...))` dentro del método de negocio que provoca el cambio, después de las guardas. Un handler que construya o publique un evento —o un adaptador que lo haga fuera del drenaje de `pullDomainEvents()`— es una fuga del dominio y se corrige, no se justifica. La traducción a evento de integración y la entrega ya vienen generadas (`<Servicio>DomainEventBridge`): el agente solo implementa el puerto de salida del broker.
- La `EventMetadata` se estampa **una vez**, en el `raise`, y viaja intacta hasta el wire: su `eventId` es la clave de idempotencia del consumidor. Regenerarla aguas abajo rompe la deduplicación.
- Un `@Version` (bloqueo optimista) sin round-trip completo (`toDomain`/`toJpa` propagándolo) no protege nada: no se introduce a medias.

## Configuración y secretos

- Ninguna credencial real en `local`/`develop`: el gradiente de perfiles va de literal (local) a `${VAR:default}` (develop) a `${VAR}` sin default (production).
- Configuración nueva va en el fragmento `parameters/<perfil>/*.yaml` correspondiente, nunca hardcodeada en un único yaml compartido.
- En la medida de lo posible, ningún valor configurable va quemado en el código: timeouts, URLs base, tamaños de página por defecto, límites, reintentos, feature flags y cualquier constante operativa que pueda variar por entorno se parametriza en el fragmento `parameters/<perfil>/*.yaml` y se inyecta vía `@ConfigurationProperties`/`@Value`. Solo permanecen como literales las constantes verdaderamente invariantes del contrato (p. ej. `code` de error o nombres de evento, que son contrato público).

## Ante ambigüedad

Orden de autoridad: **diseño > conventions > golden > criterio del agente** (documentado en el README del proyecto generado). Nunca se inventa comportamiento no declarado en los artefactos para tapar un hueco.
