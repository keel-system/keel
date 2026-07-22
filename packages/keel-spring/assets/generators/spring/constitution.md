# Reglas inviolables

Estas reglas no se negocian ni se "acomodan" para que un caso particular compile o pase un test. Si algo del diseño o de un escenario obliga a romper una de ellas, **no la rompas**: repórtalo como bloqueo o como hueco del diseño (ver "Ante ambigüedad" al final).

## Fuente de verdad

- El diseño (`specs/*.keel.yaml` + `specs/validation-scenarios.md`) es la única fuente de verdad funcional. Nada de entidades, campos, endpoints, roles o reglas que no estén en sus artefactos.
- Los `code` de error y los nombres de evento se copian **exactos**: son contrato público, no se abrevian ni se traducen.
- Una contradicción entre artefactos (use-cases vs api vs validation-scenarios) o un caso borde sin `error` declarado no se resuelve en silencio en el código: es un defecto del diseño y se reporta como bloqueo.

## Frontera hexagonal

- `domain` no depende de JPA, Spring ni de ningún paquete de `infrastructure`. Solo POJOs, records y errores puros (`Page`/`Pageable` en los puertos se acepta como único pragmatismo).
- `application` no importa Spring. Sus componentes se marcan `@ApplicationComponent` (nunca `@Component` ni `@Transactional`): la frontera transaccional la abre `UseCaseMediator`, no el handler.
- Un handler de `application` **nunca invoca a otro handler directamente**: si necesita otro caso de uso, despacha su mensaje vía `UseCaseMediator`.
- `infrastructure/rest` (controllers) **solo traduce**: construye o fusiona el mensaje desde los parámetros HTTP y lo despacha vía `UseCaseMediator`. Cero lógica de negocio; los errores quedan para `ApiExceptionHandler`.
- El mapeo domain↔JPA vive **únicamente** en `XxxRepositoryImpl` (`toDomain`/`toJpa` explícitos). Ni los handlers ni los controllers importan ni ven una clase `Jpa`.
- Datos de **otro servicio** llegan por la capa `http-clients` o por eventos de `messaging`, nunca inyectando persistencia ajena.

## Consistencia y transacciones

- `consistency.transactionalBoundary: per-aggregate` (cuando el diseño lo declara): un command muta una sola raíz de agregado dentro de la transacción del mediator; nunca dos agregados en la misma transacción.
- Un evento se publica exactamente lo que `emits` declara; los caminos de error o idempotentes no publican.
- Un `@Version` (bloqueo optimista) sin round-trip completo (`toDomain`/`toJpa` propagándolo) no protege nada: no se introduce a medias.

## Configuración y secretos

- Ninguna credencial real en `local`/`develop`: el gradiente de perfiles va de literal (local) a `${VAR:default}` (develop) a `${VAR}` sin default (production).
- Configuración nueva va en el fragmento `parameters/<perfil>/*.yaml` correspondiente, nunca hardcodeada en un único yaml compartido.

## Ante ambigüedad

Orden de autoridad: **diseño > conventions > golden > criterio del agente** (documentado en el README del proyecto generado). Nunca se inventa comportamiento no declarado en los artefactos para tapar un hueco.
