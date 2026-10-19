# Corrida de control `notification-mailer` — keel-dotnet (incremento 16 de keel-dotnet)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer` v2.0.2 (DSL 2.21, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak` |
| Generador | `keel-dotnet@0.0.1` (en `5a8143e`) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** (67 casos) |
| Huella del agente | 329 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 0 en `design-gaps.yaml` + 2 que no reportó nadie y que destapa la comparación de las seis (ver § designGaps) |
| Huecos del generador | 2: la nota de `resolvedBy` con `undefined` y la regla del cliente de audiencia ajena que faltaba en el agente de pruebas (ver § Arreglos) |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 15 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

La corrida de control que cierra el incremento 16 de `PLAN-KEEL-DOTNET.md`: el par del MVP por los TRES generadores,
desde el mismo commit, con el mismo diseño y el mismo stack (seis corridas). Aquí está la comparación de las seis; las
otras cinco remiten a esta:

- `2026-10-18-notification-mailer-mongo-dotnet-control.md`
- `2026-10-18-notification-mailer-{nest,spring}-control.md`
- `2026-10-18-notification-mailer-mongo-{nest,spring}-control.md`

## Cómo terminó

**23/23 a la primera** (67 casos con los bordes), `score-scenarios.sh` en 0, sin `harnessPatches`, sin fixes de
`infra/` ni de la solución, sin `culprit: harness`. El agente de pruebas dejó un `uncovered`, el 403 por audiencia
ajena de `FL-NTF-001`, creyendo que el arnés no podía pedir ese token. Sí podía: es un hueco del generador (§ Arreglos).

## Paridad: las seis

| | Matriz | Registrados | Reescritos | `design-gaps.yaml` | Ciclos de arreglo |
|---|---|---|---|---|---|
| keel-spring · PostgreSQL | 23/23 | 320 | **17** | — | 0 |
| keel-nest · PostgreSQL | 23/23 | 304 | **17** | — | 0 |
| keel-dotnet · PostgreSQL | 23/23 | 329 | **17** | — | 0 |
| keel-spring · MongoDB | 23/23 | 305 | **17** | 2 | 0 |
| keel-nest · MongoDB | 23/23 | 294 | **17** | — | 0 |
| keel-dotnet · MongoDB | 23/23 | 318 | **18** | — | 2 (`FL-NTF-001-B` code, `FL-DSP-001` test) |

**La huella es la de siempre, archivo por archivo, en los seis:**

- los nueve handlers;
- los tres agregados y `TemplateVariable`;
- el `README.md`;
- la consulta de la versión siguiente de la plantilla: el puerto, su adaptador y, en keel-spring, el repositorio de Spring Data;
- el registro de mensajería (`BrokerBindings.cs` / `broker-bindings.ts`), en keel-nest y keel-dotnet.

El reescrito número 18 de keel-dotnet sobre MongoDB es de entorno, no del diseño ni del generador. Es el `.csproj` de
las pruebas de flujos, al que el agente le puso un `IntermediateOutputPath` corto porque el workspace vive en una ruta
tan profunda que, con las rutas largas deshabilitadas en Windows, MSBuild no escribía el ensamblado intermedio
(`MSB3030`). El agente de keel-spring documental tropezó con lo mismo desde Python. Es la ruta de `spring-live-test/`,
no lo emitido.

La serie del par: 23/23 y huella 17 en las cuatro del 2026-10-12 y en la documental de keel-dotnet del 2026-10-15. Esta
control lo repite en los seis desde un solo commit. Los arreglos de keel-spring y keel-nest de esos seis días (el
OpenAPI derivado, la regla de los huecos ya aceptados en las tres skills, la mensajería sin persistencia rechazada) no
movieron la huella, y los designGaps que se arreglaron en el generador (`openapi-status-per-operation`) no volvieron.

## Arreglos

- **La nota de `resolvedBy` del mensaje del broker salía con `undefined`** (keel-dotnet). El comentario de
  `Messaging/Subscriptions/NotificationRequestedMessage.cs` decía «credenciales de undefined (resolvedBy:
  undefined.undefined) … `IundefinedRepository.FindByUndefinedContaining`». El diseño escribe `resolvedBy` como texto
  (`Application.credentialKeys`) y `messaging.js` lo leía como objeto; los finders sí lo partían (`resolvedByOf` de
  `repositories.js`). Ahora la nota usa el mismo `resolvedByOf`, con la forma de keel-nest (`resolvedByNote`). Lo
  vieron los dos agentes de keel-dotnet, que usaron el finder real igualmente. Lo fija un caso nuevo de
  `keel-dotnet/test/caller-resolution.test.js`, que afirma la entidad, el campo y el finder en la nota de las dos
  fixtures. Falsado: con el `messaging.js` anterior, sus dos casos salen rojos.
- **El 403 por audiencia ajena se dejaba sin cubrir** (keel-nest y keel-dotnet). La matriz de clientes de prueba es
  neutral (`keel-core/gen/identity-realm.js` siembra `test-m2m-bad-aud` con `validateAudience: true`) y la describe el
  `test-clients.md` de la skill de Keycloak de cada generador. El agente de pruebas de keel-spring lleva la regla
  «un fixture de infraestructura documentado no es un `uncovered`: escribe el test contra el nombre convencional»; los
  de keel-nest y keel-dotnet no la tenían. El resultado salió partido por la mitad: dos agentes encontraron el cliente
  leyendo `init-keycloak.sh` (keel-nest relacional y keel-dotnet documental) y dos dijeron que el arnés no podía
  (keel-nest documental y keel-dotnet relacional). La regla está ahora en `keel-nest-tests.md` y `keel-dotnet-tests.md`.
  Es texto para el agente y no lleva test propio: la red es la próxima corrida.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los nueve handlers de `Application/UseCases/` | TODO legítimo |
| `Domain/Aggregate/{Application,Notification,Template}.cs`, `Domain/Entity/TemplateVariable.cs` | TODO legítimo |
| `Infrastructure/Messaging/BrokerBindings.cs` | TODO legítimo |
| `README.md` | TODO legítimo |
| `Domain/Repository/ITemplateRepository.cs` y `Persistence/Repositories/TemplateRepository.cs` | Consulta de negocio: la versión siguiente de la plantilla |

## designGaps

Ninguno de los dos lo reportó esta corrida. Salen de comparar los seis servidores, que es lo único que los ve: cada
agente decidió por su cuenta sin creer que decidía.

- `required-value-blank` — «toda variable que la plantilla declara como requerida llega con valor»
  (`requestNotification`, y lo mismo en `acceptNotificationRequest`). ¿`""` o `"  "` es un valor?
  `TemplateVariableValue.value` es `required` sin `notBlank`, así que la entrada lo deja pasar. Los seis eligieron tres
  contratos distintos para `{"name":"x","value":""}`:
  - keel-spring documental: 422 `TEMPLATE_VARIABLE_MISSING` con `""` y también con `"  "` (`isBlank`). Es el único
    que lo reportó.
  - keel-dotnet relacional: 422 con `""`, pero acepta `"  "` (`IsNullOrEmpty`).
  - los otros cuatro: aceptan los dos y mandan el correo con el hueco vacío.

  Lo cierra el diseño: o `notBlank` en `value` (400 en el borde), o la regla dice que en blanco cuenta como faltante.
- `rendered-subject-bound` (**repetido**: ya salió en `2026-10-12-notification-mailer-nest-control.md`) — el
  `maxLength: 200` de `Notification.renderedSubject` sobre el asunto YA interpolado no tiene desenlace declarado. Lo
  reportó como decisión propia el agente de keel-spring relacional, que trunca a 200. Por lectura del código, sin
  ejecutarlo: keel-spring relacional trunca; en el resto la columna o la guarda del agregado lo rechazan como fallo
  sin `code` (relacional), o se guarda entero (documental). Segunda corrida, así que pasa a **candidato obligatorio a
  id**, por la regla de `series`.
