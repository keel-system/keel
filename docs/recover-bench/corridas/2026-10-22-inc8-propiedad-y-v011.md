# Incremento 8: conduit v0.1.1 con propiedad, regenerado y medido contra el legacy

| Etiqueta | Valor |
|---|---|
| Incremento | 8 (DSL 2.23, autorización por propietario). Puerta del plan: la fixture con propiedad genera en los tres generadores y su 403 sale en una red en vivo; FL-ART-004 y FL-COM-002 se vuelven a ejecutar contra el regenerado |
| Legacy | `realworld-node` @ ba04b70, el sandbox del inc. 1 (verify en verde, snapshot nuevo) |
| Diseño | `conduit` **v0.1.1** (DSL 2.23): los tres defectos de la paridad del inc. 7 corregidos, `ownership` declarado, `Follow` como agregado, procedencia con ids del inventario |
| Generación | keel-dotnet 0.0.2, **desde cero** (`build --accept-unready` sobre un directorio vacío; el proyecto del inc. 1 queda en `services/conduit-dotnet-v010`), stack del inc. 1 (MongoDB + Keycloak). Pipeline `/keel-generate-dotnet` lanzado por el humano |
| `--ready` al generar | 9 de 13: faltan revisión, huecos, careo y `DESIGN.md` (paso 6, fuera del banco) |
| Escenarios | **33/33** en la primera puntuación final, FL-ART-004 y FL-COM-002 (el 403 de propiedad) incluidos; `dotnet test` 91/91; índices vivos OK |
| Huella del agente | 245 archivos registrados por `build`, 0 adoptados, **32 reescritos**, 0 borrados (inc. 1: 240 registrados, 32 reescritos) |

## La paridad, contra la del inc. 7

| | inc. 7 (v0.1.0) | inc. 8 (v0.1.1) |
|---|---|---|
| `keep` contra el legacy / el regenerado | 19/19 · 19/19 | **21/21 · 21/21** (FL-ART-004 y FL-COM-002 dejan de ser frontera) |
| `fix` | 5/5 · 5/5 | **6/6 · 6/6** (FL-FOL-004, el orden del feed) |
| `new` | 1/1 | **1/1** |
| `frontier` | 2/2 informativo | **0/0** |
| Pasos comparados | 52 | **55** |
| Diferencias | 66: 33 declaradas, **33 sin declarar** | 27: 27 declaradas, **0 sin declarar** |
| Veredicto | rojo | **verde**, dos ejecuciones seguidas |

Las 27 son contrato a propósito: el `id` del recurso (21, F-WIRE), el email y el token que pasan al proveedor OIDC (4,
fix-identity) y el `updatedAt` del comentario (2). Las 33 del inc. 7 eran los tres defectos del diseño recuperado
(`author.subject` expuesto, la imagen por defecto perdida, `favorited`/`following` ausentes), y las 6 de `F-OPTIONAL-AUTH`
ya no salen: con los campos calculados, el regenerado contesta `false` como el legacy sin token.

## Lo que la corrida confirmó del inc. 8

- **El 403 de propiedad** sale en vivo, en el pipeline y en la paridad, sin que el agente lo dejara como `designGap`
  (en el inc. 1 lo dejó e implementó el 403 «solo porque los escenarios lo pedían»).
- **Las personas**: las pruebas usan el `TokenAs` que emite build (`ConduitFlow.cs`). En el inc. 1 el agente escribió
  su propio emisor (`People.cs`) porque un diseño sin roles no tenía cliente de usuario.
- **Los tres defectos de v0.1.0** no reaparecen en `design-gaps.yaml`.

## Del generador: dos defectos, arreglados después de la corrida

- **El índice único repetido** (`uk_profiles_username` dos veces en `DocumentIndexes.cs`): `Profile.username` es
  `unique` en el dominio y la persistencia declara su índice para darle el `error`. Salía igual en los TRES generadores;
  el arreglo es neutral (`documentIndexSpecs` de `keel-core/src/lib/gen/document.js`) con su prueba en
  `test/document.test.js`, falsada.
- **El humo de la API** (SMOKE-4) pedía una ruta inexistente sin token y esperaba 404; con `access.default: required`
  y sin roles ni clientes la regla de cierre responde 401 antes de enrutar. `closingCredentialOf`
  (`keel-core/src/lib/gen/access-plan.js`) devuelve ahora una persona cuando la identidad está en el `sub`, y keel-dotnet
  y keel-nest piden con `TokenAs`/`tokenAs` (keel-spring no tiene ese caso). Prueba en
  `keel-dotnet/test/ownership.test.js`, falsada.

## Del diseño: lo que queda abierto (`design-gaps.yaml`)

- `updateArticle` no distingue `tagList` ausente de `[]`: no se pueden vaciar las etiquetas.
- `updateMyProfile` no distingue `bio`/`image` ausentes de `null`: no se pueden vaciar.

Los dos son la misma pregunta (qué significa vaciar en una actualización parcial) y la responde el humano; el primero ya
salió en el inc. 1.

## Al construir el incremento

- `ts-check` de keel-nest destapó que el lector de una operación redeclaraba su parámetro `body` cuando un campo se
  llama `body` (`Article.body`, `Comment.body`): ninguna fixture lo tenía. Arreglado con un sufijo `_` en la variable
  local y `test/reader-locals.test.js`, falsado.
- `CHK-DOMAIN-COLLECTION-CROSSES-AGGREGATE` no veía la auto-referencia a-muchos de una raíz (`Profile.follows`), que el
  generador dejaba sin campo al agente. Extendido, con su mutación; conduit ganó el agregado `Follow`.
