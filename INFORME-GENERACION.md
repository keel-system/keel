# Informe de generación

Lo que apareció durante la generación de `catalog-spring` y no es responsabilidad de este proyecto, sino del
generador (`keel-spring`) o del diseño (`specs/catalog`). Fuente: los bloques estructurados de los agentes del
pipeline (`keel-spring-code`, `keel-spring-tests`, `keel-spring-infra`, `keel-spring-validate`,
`keel-spring-quality`).

## Parches al andamiaje (harnessPatches)

Ninguno. Los defectos encontrados en `src/integrationTest/` durante el arbitraje (sintaxis JsonPath, escapado del
payload de RabbitMQ, doble URL-encoding) fueron locales a las clases de flujo escritas por `keel-spring-tests`, no
al arnés compartido (`AbstractFlowIT`, `HarnessSmokeIT`): se corrigieron sin tocar el arnés y no generaron
`harnessPatches`.

## Fallos con culprit: harness

Ninguno.

## Falsos negativos de infraestructura

Ninguno reportado por `keel-spring-infra`. Sí hay una particularidad de **entorno** (no del proyecto): en este host
Windows, `podman compose` delega en `docker-compose.exe` y falla porque la tubería de compatibilidad Docker de
`podman-machine-default` está rota; la solución operativa (usar el `podman-compose` de Python vía
`PODMAN_COMPOSE_PROVIDER`) es del entorno del ejecutor, no un defecto de `infra/docker-compose.yaml` ni de los
scripts del proyecto.

## Huecos de diseño (designGaps)

- **FK entre agregados ausentes en el diseño de persistencia.** `specs/persistence.keel.yaml` no declara
  explícitamente las foreign keys `products.brand_id → brands.id` y `products.category_id → categories.id`, pese a
  que `specs/use-cases.keel.yaml` define la regla de integridad `BRAND_IN_USE`/`CATEGORY_IN_USE` para
  `deleteBrand`/`deleteCategory`. Sin la FK física, existe una ventana de carrera entre la comprobación aplicativa
  y el borrado real. Se añadieron las FK (`fk_products_brand`, `fk_products_category`) al baseline de migraciones
  como cierre de este hueco; se propone reflejarlo en el artefacto de diseño para que generadores futuros no
  dependan de que el agente lo infiera.

- **Contradicción entre `openapi.yaml` y `validation-scenarios.md` sobre `ProductImage.productId`.**
  `docs/openapi.yaml` declara `productId` como campo requerido del esquema `ProductImage` (tanto en la respuesta de
  `addProductImage` como embebido en `Product.images[]`), pero `specs/validation-scenarios.md` fija la proyección
  canónica de `images[]` como exactamente `{id, file, altText, position, isPrimary}`, con la cláusula "ninguna
  enumeración de este documento se aparta de esto". Las pruebas de integración siguieron la fuente de mayor
  precedencia (el documento de validación) y omiten `productId` del `assertBody` estricto. Corresponde arbitrar
  cuál de los dos documentos manda y corregir el otro derivado.

## Resumen

Dos huecos de diseño detectados y documentados arriba (uno ya cerrado en el código generado vía el baseline de
migraciones, el otro pendiente de arbitraje entre contratos). Sin parches al arnés ni fallos imputables al
generador.
