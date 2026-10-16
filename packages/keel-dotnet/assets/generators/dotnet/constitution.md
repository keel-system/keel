# Reglas inviolables

Estas reglas no se negocian ni se "acomodan" para que un caso particular compile o pase un test. Si algo del
diseño o de un escenario obliga a romper una de ellas, **no la rompas**: repórtalo como bloqueo o como hueco del
diseño (ver "Ante ambigüedad" al final).

## Fuente de verdad

- El diseño (`specs/*.keel.yaml` + `specs/validation-scenarios.md`) es la única fuente de verdad funcional.
  Nada de entidades, campos, endpoints, roles o reglas que no estén en sus artefactos.
- Los `code` de error y los nombres de evento se copian **exactos**: son contrato público.
- Una contradicción entre artefactos o un caso borde sin `error` declarado no se resuelve en silencio en el
  código: es un defecto del diseño y se reporta.
- **El servidor es equivalente a los de keel-spring y keel-nest del mismo diseño.** Lo que el contrato fija
  (rutas, status, cuerpo de error, paginación, forma del JSON, nombres de constraint) no se cambia aquí: lo
  decide el núcleo neutral de Keel y lo emite build.

## Idioma

- Todo lo que se genera va **en inglés**: proyectos, carpetas, archivos, clases, métodos, variables, tablas y
  columnas. Los comentarios, la documentación y los mensajes al usuario van en español.
- Un identificador del diseño en español no se traduce por tu cuenta: es un defecto del diseño.

## Frontera hexagonal

- Las referencias entre proyectos SON la frontera: Domain no referencia nada; Application, solo Domain;
  Infrastructure, Application; Api, Infrastructure. **No se añade una referencia ni un paquete** para que algo
  compile: un `using Microsoft.EntityFrameworkCore` en Application es un error de diseño del código, no de la
  configuración.
- Un handler **nunca invoca a otro handler**: si necesita otro caso de uso, despacha su mensaje por el
  mediator (con el `ICommandDispatcher` que build emite cuando el diseño lo pide).
- Los endpoints **solo traducen**: el lector generado valida, el endpoint despacha. Cero lógica de negocio; los
  errores quedan para `ApiErrorMiddleware`.
- El mapeo dominio ↔ fila vive **únicamente** en `<Raíz>Repository` (`ToDomain`/`Apply`). Ni los handlers ni
  los endpoints ven una fila, el `DbContext`, un `IQueryable` ni un `DbSet`.
- Datos de **otro servicio** llegan por `http-clients` o por eventos de `messaging`, nunca inyectando
  persistencia ajena.

## Licencias

- **Ningún paquete con licencia comercial**, ni en el servicio ni en sus pruebas: nada de MediatR (≥13),
  AutoMapper (≥15), MassTransit (≥9), FluentAssertions (≥8), Duende IdentityServer, ImageSharp, QuestPDF, EPPlus
  ni iText. Los paquetes que build fija tienen licencia permisiva y versión exacta en `Directory.Packages.props`;
  un paquete nuevo es una decisión del generador, no del agente: va a `blockers`.

## Modelo de dominio

- El estado de un agregado se muta **únicamente** por sus métodos de negocio: sin setters públicos. El
  constructor recibe el `<Raíz>State` de la persistencia (rehidratación); la creación de negocio pasa por un
  factory estático que aplica los invariantes.
- Todo `invariants` declarado en `domain.keel.yaml` tiene una guarda en dominio que lanza el error del diseño. Un
  invariante sin guarda es generación incompleta, no criterio del agente.

Cómo se escriben: `conventions/domain-modeling.md`.

## Aritmética y precisión

- Todo valor **monetario, contable, de tasas o porcentajes y todo cálculo científico** es `decimal`. `double` y
  `float` están **prohibidos** para esos valores, en dominio, en DTOs, en filas y en cualquier cálculo
  intermedio: son binarios y no representan exactamente los decimales. Ni de paso (`(double)x`,
  `Convert.ToDouble`, `Math.Round` sobre un `double`).
- Un `long` del diseño es `long`, nunca `int` ni `double`.
- Toda operación que pueda producir más decimales que la escala declarada (una división, un producto por una
  tasa, un prorrateo) lleva **escala y redondeo explícitos**: `Decimals.SetScale(valor, escala, modo)`. La
  escala sale del diseño; el modo, de las Convenciones de determinación de `specs/validation-scenarios.md` y, si
  no lo declara, **`MidpointRounding.AwayFromZero`** (el `HALF_UP` de los otros dos servidores). Nunca el
  `Math.Round` por defecto: redondea al par (`ToEven`) y da otro céntimo.
- `decimal.Round` no SUBE la escala (`2.5m` redondeado a dos decimales sigue siendo `2.5`): la escala del cable
  la pone `Decimals.SetScale`.
- Los importes se comparan con `==` entre `decimal` (compara el valor, sin escala) y la igualdad de un value
  object con `ValueEquality` (compara también la escala, como `BigDecimal.equals`). Elige la que el diseño pide.
- La escala del diseño es **contrato observable**: se conserva en dominio, en la columna y en la respuesta HTTP.
  No se normaliza "por limpieza".

## Asincronía

- Todo acceso a un puerto es `async` hasta arriba, con `await`; nada de `.Result`, `.Wait()` ni
  `GetAwaiter().GetResult()` (bloquean un hilo del pool y pueden interbloquear).
- El `CancellationToken` del handler se pasa a cada llamada de puerto.

## Consistencia y transacciones

- La transacción la abre `UseCaseMediator`: un handler no abre, no confirma y no deshace nada. Un adaptador se
  une a ella solo, porque el `DbContext` es del ámbito de la petición.
- `consistency.transactionalBoundary: per-aggregate` (si el diseño lo declara): un comando muta una sola raíz de
  agregado.
- **Lo no transaccional va después de las guardas.** Una llamada saliente o cualquier efecto fuera de la base no
  participa de la transacción: si sale antes de que el agregado valide y la guarda rechaza, el rollback deshace
  la fila y deja el efecto hecho fuera. El orden es siempre: cargar → guardas e invariantes → efectos externos →
  confirmar.
- **Cuando el diseño dice «después de confirmar»** (borrar un binario, avisar a un proveedor), el efecto va por el
  puerto `IAfterCommit` (`Application/Ports/IAfterCommit.cs`, que build ya emite y registra con la persistencia):
  `await afterCommit.Run(() => …)` lo ejecuta tras el commit y nunca si la transacción revierte; sin transacción,
  antes de volver. No escribas otro, ni lo hagas dentro de la transacción: `PersistenceTransactions` vive en
  Infrastructure y un handler no puede referenciarla.
- El bloqueo optimista (`lockVersion`) ya lo genera build, con su round-trip y su 409. Es infraestructura: no
  sale al contrato y nadie lo toca. Un `version` que declare el diseño es otro contador, de dominio, y lo
  incrementa el agregado.

## Configuración y secretos

- Ninguna credencial real en `local`/`develop`: el gradiente de perfiles va de literal (local) a
  `${VAR:default}` (develop) a `${VAR}` sin default (production). Una variable obligatoria sin valor impide
  arrancar, nombrándola.
- Configuración nueva va en el fragmento `config/parameters/<perfil>/*.yaml` que corresponda, en los tres
  perfiles, y se lee de la `ServiceConfiguration` inyectada; nunca un literal en el código ni un
  `Environment.GetEnvironmentVariable` suelto.

## Esquema y topología

- En `local` el esquema lo crea EF Core desde el modelo (`EnsureCreated`, solo sobre una base vacía); en
  `develop` y `production`, **solo** las migraciones de EF Core, que se aplican al arrancar. Nunca se usa
  `EnsureCreated` fuera de `local`.
- El código no crea ni altera topología que la plataforma posee (esquemas, topics, buckets) fuera de lo que
  build ya declara.

## Ante ambigüedad

Orden de autoridad: **diseño > conventions > criterio del agente** (documentado en el README del proyecto).
Nunca se inventa comportamiento no declarado en los artefactos para tapar un hueco.
