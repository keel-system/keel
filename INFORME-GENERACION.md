# Informe de generación

Lo que apareció durante la generación de `catalog-spring` y no es responsabilidad de este proyecto, sino del
generador (`keel-spring`) o del diseño (`specs/catalog`). Fuente: los bloques estructurados de los agentes del
pipeline (`keel-spring-code`, `keel-spring-tests`, `keel-spring-infra`, `keel-spring-validate`,
`keel-spring-quality`), **contrastados después contra los artefactos reales**: cada hallazgo de abajo lleva la
evidencia que lo sostiene o lo desmiente.

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

**Ninguno.** El hallazgo que se reportó como tal no lo es, y se documenta abajo con la evidencia para que no
vuelva a reabrirse.

### Descartado: «FK entre agregados ausentes en el diseño de persistencia»

Se reportó que `specs/persistence.keel.yaml` no declara las foreign keys `products.brand_id → brands.id` y
`products.category_id → categories.id`, y se propuso reflejarlas en el artefacto de diseño. **Es un falso
positivo por partida doble:**

- **El DSL no tiene dónde declararlas.** `assets/core/schema/persistence.schema.json` es
  `additionalProperties: false` y una entidad solo admite `persisted`, `naturalKey` e `indexes`. El diseño no
  omitió nada que estuviera en su mano declarar; añadirlo exigiría una capa nueva del DSL, no corregir un diseño.
- **La señal de diseño ya está completa y en la capa que le corresponde.** `domain.keel.yaml` declara las
  relaciones `brand` y `category` (`many-to-one`, `required: true`) y las invariantes «no puede eliminarse
  mientras exista algún producto que la referencie»; `use-cases.keel.yaml` declara los errores `BRAND_IN_USE` y
  `CATEGORY_IN_USE`. Eso es exactamente el disparador que la convención busca.

Lo que ocurrió es **comportamiento prescrito**, no un hueco: `src/scaffold/persistence-entities.js` mapea una
referencia a otro agregado como columna `UUID` plana sin asociación JPA (frontera entre agregados), de modo que
Hibernate no emite ninguna FK; y `conventions/mapping.md` («la garantía es una FK real en el esquema, sin
asociación JPA… va en el baseline de migraciones, escrito a mano») junto con
`skills/keel-spring-database/references/migrations.md` («FK entre agregados: nunca están en el DDL exportado, y a
veces tienen que estarlo… la añades tú») **instruyen al agente a hacer justo lo que hizo**.

El cierre además está completo, no a medias: el baseline lleva `fk_products_brand` y `fk_products_category`, y
`ApiExceptionHandler` mapea ambos nombres de constraint a `BrandInUseError`/`CategoryInUseError`, de forma que la
violación por carrera devuelve el mismo `409` y el mismo `code` que el camino no concurrente. Vale la pena
recordar el caveat que la propia convención exige reportar: en perfil `local` el esquema lo crea `ddl-auto`, así
que la FK no existe hasta que se corre contra el baseline.

## Defectos en los derivados de contrato

Dos, ambos en `docs/catalog/openapi.yaml` (y en la copia embebida de `docs/catalog/openapi.html`), ambos por
incumplir reglas que `/keel-docs` ya tiene escritas. **No son contradicciones que haya que arbitrar**: la regla
está decidida, y el derivado se apartó de ella.

- **`ProductImage.productId` no debe existir.** El schema lo declaraba en `properties` y en `required`, pero
  `keel-docs/SKILL.md` dice literalmente que la back-reference de una entidad hija hacia la raíz de su propio
  agregado **se omite** —y cita `ProductImage.productId` por su nombre como el ejemplo de lo que no hay que
  hacer—. El generador aplica esa misma regla en código (`model.js`, `relationPayloadFields`: una relación
  marcada `backReference` se descarta), y el servidor no devuelve el campo: `ProductImageDto` es
  `(id, file, altText, position, isPrimary)`. `specs/validation-scenarios.md` fija la misma proyección, así que
  las pruebas de integración —que omitieron `productId` del `assertBody` estricto— hicieron lo correcto y no hay
  nada que arbitrar en su contra. El único artefacto equivocado era el OpenAPI, y el riesgo es el que la propia
  skill anticipa: quien integre contra el contrato se cree un campo que nunca va a recibir.

- **`ProductImage.file` iba sin `format: uri`.** Detectado al verificar el punto anterior, misma clase de
  defecto. `storage.keel.yaml` declara el bucket `productImages` con `visibility: public`, y la regla de
  `type: file` de `keel-docs/SKILL.md` obliga en ese caso a publicar `type: string` + `format: uri` descrito como
  URL absoluta. El servidor devuelve una URL absoluta de verdad (`ProductApplicationMapper` y
  `ProductImageApplicationMapper` llaman a `fileStorage.publicUrl(...)`), pero el contrato lo describía como
  «referencia al objeto en el bucket lógico». El request multipart, que sí debe ser `format: binary`, ya era
  correcto.

**Corregidos** en los tres sitios donde vivía el derivado: el workspace de diseño (`docs/catalog/`), el snapshot
del proyecto generado (`services/catalog-spring/docs/`, que `keel-spring build` refresca) y el **registry**
(`keel-registry/docs/catalog/`), este último para que el defecto no se replique en quien adopte el diseño con
`keel registry get catalog`. Verificado con `@redocly/cli lint` en verde en ambos repos, paridad del snapshot por
`diff`, y `keel index --check` + `keel validate` en verde en el registry.

## Resumen

Cero huecos de diseño: el único reportado como tal era comportamiento prescrito por las conventions y quedó
correctamente cerrado en el código generado. Dos defectos reales, ambos en el mismo derivado de contrato y ambos
por apartarse de reglas explícitas de `/keel-docs`; corregidos en workspace, proyecto generado y registry. Sin
parches al arnés ni fallos imputables al generador.
