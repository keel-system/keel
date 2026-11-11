# Corrida de control de la lectura acotada (DSL 2.27) con Cognito — `asset-vault` en keel-spring

| Etiqueta | Valor |
|---|---|
| Diseño | `asset-vault` v1.1.3 (DSL 2.27, documental, 9 capas), con `scoping.reads: [getAsset, listAssets]` y `readMiss: forbidden` |
| Stack | `mongodb · rabbitmq · cognito · redis · minio` (telemetría `none`; Cognito es el emulador del docker-compose) |
| Generador | `keel-spring@0.3.0` (`51878aab` al generar) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **32/32 OK** |
| Huella del agente | 368 archivos registrados por `build`, 0 adoptados, **13 reescritos**, 0 borrados |
| Clasificación de la huella | 11 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 1 de los 3 de `design-gaps.yaml` (los otros dos son cobertura del documento de escenarios) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\vault-227-spring-mongo-rabbit-cognito\services\asset-vault-spring`. Corrida de control del
incremento 8 de `PLAN-DSL-227-LECTURA-ACOTADA.md`, gemela de `2026-11-10-asset-vault-227-spring-control.md`: el mismo
diseño, el mismo stack y el mismo generador, y solo cambia el proveedor de identidad.

## Lo que medía

Lo mismo que la gemela con Keycloak (la carga de la ficha acotada y la fila ajena), más lo que solo existe con Cognito:

- **El claim del alcance por el emulador (D6).** FL-AST-003-D (la ficha de un propietario fuera del alcance) y FL-AST-004-B
  (el listado acotado) piden su llamante con `tokenWithScope("vault-reader", "OTRO")`, que con Cognito sale de los mappings
  de alcance del emulador (inc. 4.3 de `PLAN-PROVEEDOR-IDENTIDAD.md`), no de la API de administración de Keycloak.
- **El cliente exento con el id que genera el proveedor (D3).** FL-AST-003-E (el renderizador lee cualquier ficha) pide su
  token con `serviceCredential("rendering-service")`: llega con `client_id` opaco, y el servidor lo reconoce como exento por
  el mapa `security.client-ids`.

Las dos en verde. Es la primera vez que el arnés de una corrida pide los tokens de una persona del alcance y de un cliente
exento al emulador, y no a Keycloak.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- La matriz, contra los JUnit de `build/test-results/integrationTest`: 38 casos, 0 fallos, 32 `FL-*` distintos.
- La huella, contra una regeneración limpia con el mismo stack y los mismos `specs/`:
  - Diez reescritos partían de un TODO: los siete handlers, `Asset`, `Owner` y `AssetRevision`.
  - `RenderingHttpAdapter` también: es el fallback `onUnavailable: degrade` que build deja por escribir.
  - `RenderingClient` solo gana un javadoc, y `README.md` una sección «Decisiones de la generación». Ninguno de los dos
    cuenta como decisión.
- `application.yaml` **intacto**: en la gemela con Keycloak el agente subió `max-part-count` a mano. Es la primera corrida
  después del arreglo (`multipartPartCount` al doble del máximo válido), y lo confirma.
- Clasificación a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Lo que el agente reportó y no es un hueco del diseño

- **Escenarios 400 para las cotas de entrada** (patrón y `maxLength` de `slug`, `title` y `labels`): es cobertura del
  documento de escenarios. Las cotas están declaradas, y el agente no tuvo que decidir nada.
- **Los nulos de un borrador recién subido** (`lastScannedAt`, `quarantineReason`, `revisions`) sin afirmar en el `Then` de
  FL-AST-001: también es cobertura. El dominio no les da valor al subir.

## designGaps

- `quarantine-last-scanned-at` — `quarantineAsset` no dice si renueva `lastScannedAt`. `publishAsset` y `reconcileScans` lo
  fijan con el instante propio del veredicto, y la cuarentena también es un veredicto del escáner. El agente decidió no
  tocarlo. Un archivo en cuarentena no lo barre la reconciliación, que solo mira los publicados, así que hoy solo cambia lo
  que muestra la ficha.
