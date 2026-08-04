# Informe de generación — catalog-spring (specs/catalog v0.3.0)

Lo que apareció durante esta generación y **no es de este proyecto**, sino del generador
`keel-spring` o del diseño en `specs/catalog`. Estructura según
`docs/keel/orchestration.md § El cierre devuelve al generador lo que es del generador`.

## 1. Incidencias del arnés (harnessPatches)

### Formato de precio sensible al locale por defecto de la JVM

- **Síntoma**: `FL-PRD-030` y `FL-PUB-010` fallaron en la corrida completa (`ProductQueryFlowIT`,
  `PublicListingFlowIT`) con 400 en vez de 201 al crear los productos de fixture.
- **Causa**: el helper `priceFor(int)`, duplicado en ambas clases de test, usaba
  `"%.2f".formatted(price)` sin fijar `Locale`. En un host cuyo locale por defecto de la JVM usa
  coma decimal (`es_CO`, el de este entorno de generación), el precio se serializaba como
  `"89,90"` en vez de `"89.90"`, rompiendo el JSON del cuerpo de la petición.
- **Por qué es del generador y no de este proyecto**: el patrón `priceFor(...)` lo produce
  `keel-spring-tests` al traducir cada escenario `FL-*` a Java; es el mismo helper duplicado en
  cualquier servicio generado que necesite montos en sus fixtures de prueba, y el defecto es
  puramente de idioma Java (`String.format` sin locale explícito), no de este dominio.
- **Fix aplicado**: `String.format(Locale.ROOT, "%.2f", price)` en las dos ocurrencias
  (`ProductQueryFlowIT.priceFor`, `PublicListingFlowIT.priceFor`).
- **Recomendación**: la guía de `keel-spring-tests` (o su prompt de agente) debería advertir
  explícitamente que cualquier formateo numérico/de fecha en fixtures de test use `Locale.ROOT`
  — el mismo defecto reaparecerá en cualquier servicio cuyo host de CI/desarrollo tenga un locale
  con coma decimal.

## 2. Código determinístico mejorable

| Área | Archivo (patrón) | Cambio sugerido |
|---|---|---|
| Parámetros por perfil | `src/main/resources/parameters/test/` | `keel-spring build` generó `db.yaml`, `storage.yaml` y `oauth2.yaml` para el perfil `test`, pero omitió `messaging.yaml` a pesar de que el servicio declara capa `messaging` y tiene publishers Kafka que resuelven `${messaging.publishing.destination}` en su constructor. `./gradlew test` (arranque del contexto bajo perfil `test`, sin infraestructura) fallaba con `PlaceholderResolutionException` hasta que se añadió el archivo a mano. El generador debería producir un `parameters/test/<capa>.yaml` con valores inertes por cada capa presente en el manifiesto que tenga `${...}` referenciados desde un bean que se instancia en el contexto `test`, igual que ya hace para `local`/`develop`/`production`. |

## 3. Agentes y skills

- **Diagnóstico de la columna fantasma `ever_published`** (ver §4 de designGaps: el campo se
  renombró a `slugFrozen`/`slug_frozen` durante el diseño) consumió un ciclo completo de
  arbitraje + fix + re-puntuación porque `ddl-auto: update` en el perfil `local` deja columnas
  obsoletas sin eliminar cuando un campo del dominio cambia de nombre entre iteraciones. Ninguna
  skill del stack (`keel-spring-database`) menciona este riesgo. Una nota en
  `.claude/skills/keel-spring-database/SKILL.md` del tipo *"si un nombre de campo cambió durante
  el diseño o entre ciclos de fix, considera recrear el volumen de la BD local antes de
  revalidar — `ddl-auto: update` nunca elimina columnas obsoletas"* habría evitado el ciclo de
  arbitraje: el síntoma (409 genérico por `DataIntegrityViolationException` enmascarando la causa
  real) no fue evidente sin leer el XML de JUnit crudo, no el volcado JSON resumido.

## 4. Huecos del diseño (designGaps)

Consolidados de `keel-spring-code`; ningún otro agente reportó huecos de diseño en sus corridas.

1. **`Product.slugFrozen` no declarado en `domain.keel.yaml`**: el invariante "el slug de un
   producto ya publicado no vuelve a cambiar" necesita persistir ese hecho incluso si el producto
   vuelve a `draft` (unpublish), pero el diseño no declara ningún campo para ello. Se implementó
   como campo interno no expuesto (`Product.slugFrozen`, columna `slug_frozen`). Propuesta:
   declarar el campo explícitamente en `domain.keel.yaml`, o reformular el invariante para que no
   dependa de estado oculto.

2. **Formato de SKU sin `code` de error declarado**: el escenario de "SKU con formato inválido"
   en `validation-scenarios.md` solo exige `400`, sin `code`. Se usó `INVALID_SKU_FORMAT` como
   convención. Propuesta: `use-cases.keel.yaml` debería fijar el `code` explícitamente para que no
   quede a criterio del generador.

3. **`FileStorage.publicUrl(key)` no declarado en el puerto de diseño**: el dominio guarda la
   storage key (per `mapping.md`), pero resolverla a una URL pública en los `ResponseDto` requiere
   un método que ningún artefacto de `storage.keel.yaml` declara explícitamente. Se añadió al
   puerto como la única forma de cumplir ambos requisitos sin romper la separación wire/API.
   Propuesta: declarar `publicUrl` (o equivalente) como parte del contrato del puerto `FileStorage`
   en el DSL cuando un bucket es `visibility: public`.

   > **Resuelto — aceptado en parte.** El síntoma era real; el diagnóstico no. El puerto **sí**
   > declaraba un resolutor key→URL: `signedUrl(key)`, emitido siempre, y la skill
   > `keel-spring-s3` instruía que con todos los buckets públicos ese método compusiera la URL
   > pública — semántica sobrecargada que la firma no dice y que el agente no encontró. Y la
   > propuesta de llevarlo al DSL no procede: `storage.keel.yaml` es agnóstico del proveedor
   > por diseño y no declara contratos de puertos de ninguna capa.
   >
   > La causa raíz era mayor: el generador **no había decidido** si un campo `file` viaja como
   > key o como URL. `build` emitía la key, `mapping.md` decía que el `ResponseDto` "puede"
   > resolverla, `integration-tests.md` daba por hecho que la API devuelve una URL, y los dos
   > derivados de este mismo diseño ya divergían (`openapi.yaml` publicaba referencia,
   > `INTEGRATION.md` una URL absoluta).
   >
   > Ahora se deriva de `visibility`, sin tocar el schema: bucket `public` → el `ResponseDto`
   > expone la URL absoluta, que compone el `<Entidad>ApplicationMapper` **generado por build**;
   > bucket `private` → la key. Los eventos siguen llevando la key siempre. El puerto declara
   > `publicUrl` si y solo si hay bucket público y `signedUrl`/`download` si y solo si lo hay
   > privado, todos con el bucket lógico en la firma, y la config gana `storage.public-base-url`
   > (la que ve el consumidor, no el endpoint interno con el que el servicio habla con MinIO).

4. **Deduplicación por `Idempotency-Key` a nivel HTTP no cubierta por el scaffolding**: el
   `IdempotencyGuard` que genera `build` solo cubre mensajería (consumo de eventos); para
   `keySource: client-key` a nivel HTTP (`createProduct`, `addProductImage`) no había ningún
   mecanismo generado. Se implementó un `JpaIdempotencyStore` propio (tabla `idempotency_record`)
   como decisión de agente. Propuesta: si `keySource: client-key` en un endpoint HTTP es un patrón
   soportado por el DSL, el generador debería producir el store genérico igual que hace para la
   idempotencia de mensajería, en vez de dejarlo a criterio de cada generación.
