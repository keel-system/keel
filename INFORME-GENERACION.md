# Informe de generación — catalog-spring

Generado desde `specs/catalog` v0.2.0. Lo que sigue **no es de este proyecto**: es lo que
`keel-generate-spring` (o el generador `keel-spring`) debería absorber para que la próxima
generación con este stack no lo vuelva a pagar. Estructura según
`docs/keel/orchestration.md § El cierre devuelve al generador lo que es del generador`.

## 1. Incidencias

### `deploy/docker-compose.yaml` no es orquestable con `podman-compose` cuando `dockerfile` está en subcarpeta

- **Síntoma**: `keel-spring-quality` no pudo ejecutar `deploy/up.sh` en este host
  (Windows + podman). `podman compose` (que delega en `docker-compose.exe`) falla por un
  problema de `podman machine`/named-pipe ajeno al proyecto; pero además
  `podman-compose` 1.5.0 (Python), la vía que sí funcionó para `infra/`, falla con
  `no Containerfile or Dockerfile specified or found in context directory` al no resolver
  `dockerfile: deploy/Dockerfile` cuando difiere de `context: ..`.
- **Causa**: `deploy/docker-compose.yaml` declara `build: { context: .., dockerfile: deploy/Dockerfile }`.
  `podman build -f deploy/Dockerfile .` (invocado directo, sin compose) construye la imagen
  sin error, así que el `Dockerfile` en sí es correcto.
- **Por qué es del generador**: el patrón `context`/`dockerfile` en subcarpetas distintas es
  el mismo en cualquier servicio `keel-spring` con este scaffold de `deploy/`; no depende de
  nada que este proyecto haya decidido.
- **Fix aplicado**: ninguno — `deploy/` no se toca a mano según la regla del pipeline.
- **Recomendación**: o bien mover el `Dockerfile` a la raíz del build context (`deploy/`
  como contexto, con las rutas del `COPY` ajustadas), o documentar en el scaffold la
  invocación alternativa (`podman build -f deploy/Dockerfile -t <tag> .` seguido de
  `podman run`/`podman-compose` solo para el resto de servicios) para hosts con
  `podman-compose` en vez de Docker real.

Ningún `harnessPatches`, ningún `probes[].verdict: FALSO-NEGATIVO` de infraestructura y
ningún `failures` con `culprit: harness` aparecieron en esta generación — los dos fallos que
salieron en la puntuación fueron uno de la prueba (`FL-IMG-001-A`) y uno del código de este
proyecto (`FL-PRD-001-A`), ambos ya corregidos.

## 2. Código determinístico mejorable

| Área | Patrón (no ruta de este proyecto) | Cambio sugerido |
|---|---|---|
| `infrastructure/messaging/<Servicio>DomainEventBridge` | El bridge scaffoldeado calcula una variable local `envelope` y expone un campo `@Value` de routing-key **por evento**, pero cada `<Evento>Publisher` que el agente escribe construye su propio envelope y lee su propia clave — dejando 9 variables y 10 campos sin usar en este proyecto. | Si el diseño del bridge es "solo despacha, el publisher decide forma y destino", el scaffold no debería generar ese cálculo por evento en el bridge; o, si el bridge sí debe centralizar el envelope, los publishers deberían recibirlo por parámetro en vez de reconstruirlo. |

## 3. Agentes y skills

- **`keel-spring-code` y los campos "ausente" de `messaging.keel.yaml`**: el escenario
  `FL-PRD-001-A` falló en `code` porque `ProductCreatedIntegrationEvent` serializaba
  `primaryImage` como `null` en vez de omitirlo, pese a que `docs/keel/conventions/mapping.md`
  (líneas 296-303) ya documenta la regla (`@JsonInclude(NON_NULL)` a nivel de campo, no de
  clase). El agente de código no cruzó explícitamente cada campo de `messaging.keel.yaml`
  marcado como "ausente mientras..." contra esa regla antes de reportar `status: OK`. Costó un
  ciclo completo de arbitraje + fix + re-puntuación. Recomendación: que
  `docs/keel/conventions/mapping.md` o la checklist de cierre del agente de código incluya un
  paso explícito "para cada campo `type: file`/opcional de `messaging.keel.yaml` cuya
  `description` diga 'ausente' o similar, confirmar `@JsonInclude(NON_NULL)` en el DTO de
  evento antes de dar la capa por completa".
- **`keel-spring-tests` y la técnica de aserción de ausencia**: `FL-IMG-001-A` fue un simple
  error de lectura del `Then` (aserción sobre la ruta equivocada), pero `FL-PRD-001-A` reveló
  además que la primera versión de la prueba probaba "campo ausente" con
  `assertThatThrownBy(() -> JsonPath.read(...)).isInstanceOf(PathNotFoundException.class)`,
  una técnica que depende del `JsonProvider` resuelto por classpath (con
  `JacksonJsonNodeJsonProvider` una hoja ausente devuelve `null` en vez de lanzar). Vale la
  pena documentar en `docs/keel/conventions/integration-tests.md` el patrón correcto y
  agnóstico del provider (parsear a `JsonNode` de Jackson y usar `.has(campo)`) como la forma
  estándar de afirmar ausencia de un campo en un evento o respuesta.

## 4. Huecos del diseño

Consolidados de los cinco agentes (`code`, `infra`, `tests`, `validate`, `quality`). Son del
**diseñador**, no del generador — se proponen como cambio a `specs/catalog/` en el workspace,
vía `/keel-evolve`.

- **`ProductImage.productId` — inconsistencia entre contratos derivados**: `docs/openapi.yaml`
  declara `productId` como campo requerido en el esquema `ProductImage` (tanto en la respuesta
  de `addProductImage` como embebido en `images[]`), pero `specs/validation-scenarios.md`
  (FL-IMG-001, punto 3) fija el cuerpo de imagen exactamente como
  `{ id, file, altText, position, isPrimary }`, sin `productId`. No causó ningún fallo (el
  código real ya sigue `validation-scenarios.md`), pero es una discrepancia real entre
  artefactos derivados de la misma capa `api`. Propuesta: revisar si `api.keel.yaml` declara
  `productId` en el DTO de imagen y, si no debe viajar, corregir la derivación de
  `docs/openapi.yaml` en `/keel-docs`.
- **`Product.slug` — sin código de error para la ventana de carrera del sufijo numérico**: la
  restricción `uk_products_slug` sigue con la convención genérica del scaffolding
  (`PRODUCT_SLUG_ALREADY_EXISTS`) porque `use-cases.keel.yaml` no declara un error específico
  para esa carrera. Propuesta: declarar el error en `createProduct`/`updateProduct`.
- **`BRAND_IN_USE`/`CATEGORY_IN_USE` — sin FK real en el baseline frente a la carrera con
  `createProduct`**: la integridad referencial para esa carrera concreta no quedó en
  `V1__baseline_schema.sql`. Propuesta: si el diseño exige consistencia fuerte ahí, declararlo
  en `persistence.keel.yaml` (índice/constraint) en vez de dejarlo solo a nivel de aplicación.
- **`Idempotency-Key` no declarada obligatoria**: `createProduct`/`addProductImage` ejecutan
  sin deduplicar si el cliente no manda la cabecera — comportamiento correcto según
  `docs/keel/conventions/mapping.md`, pero es una decisión silenciosa sin ningún `Then` que la
  observe. Propuesta: si el diseño quiere garantizar idempotencia, declarar la cabecera como
  obligatoria en `api.keel.yaml` para esas operaciones.
- **`S3FileStorage.download` — sin error declarado y sin caso de uso que lo invoque**: el
  adaptador ya mapea `NoSuchKeyException` a un `FILE_NOT_FOUND` convencional (404), pero
  ningún caso de uso actual descarga una imagen de producto por esta vía, y `domain.keel.yaml`
  no declara ese error. Propuesta: si en el futuro se expone una descarga directa, declarar
  `FILE_NOT_FOUND` (404) en esa operación.

### Nota — cobertura de escenarios de carrera (no es un huecos de diseño, es límite del arnés)

`keel-spring-tests` no pudo ejercitar tres casos borde de concurrencia real (dos altas
paralelas con el mismo `sku`; `createProduct` en carrera con `deleteBrand`/`deleteCategory`;
`reactivateProduct` sobre un producto en `draft` aislado) porque requieren orquestar hilos o
estado que el arnés secuencial de JUnit no aísla determinísticamente. No es un defecto del
generador ni un hueco del diseño: queda anotado aquí para quien decida si vale la pena una
infraestructura de prueba de concurrencia dedicada.
