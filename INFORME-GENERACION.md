# Informe de generación

Lo que apareció durante la generación de `catalog-spring` desde `specs/catalog` v0.1.0 y **no es de
este proyecto**, sino del generador (`keel-spring`) o de los artefactos que trae. Cada entrada dice
de quién es.

## Parches al arnés de test compartido (`AbstractFlowIT` y utilidades hermanas)

Detectados por `keel-spring-tests` al corregir sus propias clases; el defecto vive en el patrón que
el generador siembra en cada proyecto, no en este repo en particular.

1. **`Events.java` — `JsonPath.read(payload, "$.data").toString()` no produce JSON válido.**
   Con json-path 2.9.0 y Jackson en el classpath (vía `spring-boot-starter-web`), `$.data` se
   materializa como `java.util.LinkedHashMap`, y `LinkedHashMap.toString()` da sintaxis de `Map` de
   Java (`{clave=valor}`), no JSON. Cualquier re-lectura posterior con `JsonPath.read(...)` sobre ese
   string falla con `PathNotFoundException`, aunque el evento real en el broker sea correcto. Enmascaró
   12 escenarios en un ciclo de validación entero antes de detectarse. Fix aplicado: re-serializar con
   `ObjectMapper.writeValueAsString(...)` (agnóstico del proveedor de JsonPath activo) en vez de
   `.toString()` sobre el resultado crudo.

2. **Mismo patrón roto repetido en una clase individual.** `BrandCreationFlowIT.java` tenía
   `firstItem.toString()` sobre un nodo `Map` extraído con `jsonPath(...)` — el mismo bug de raíz,
   copiado por el propio agente al escribir la clase. Sugiere que el patrón correcto para comparar
   fragmentos JSON extraídos con JsonPath no está claro desde las conventions/skills que consume el
   agente de tests; valdría la pena documentarlo explícitamente (p. ej. un helper `Events.toJson(Object)`
   en el andamiaje base, no reinventado por cada proyecto).

3. **Verificación de binarios de storage acoplada a una topología de red que no se cumple en podman.**
   `ProductImageFlowIT` verificaba el SHA-256 del archivo subido ejecutando `curl` **dentro del
   contenedor `devtools`** contra la URL pública (`http://localhost:9000/...`), resoluble desde el host
   pero no desde dentro de ese contenedor en este entorno (podman, no docker). Fix aplicado: descargar
   el binario directamente desde el proceso JVM del test con `java.net.http.HttpClient` contra la URL
   pública, sin pasar por `devtools`. Si el patrón "verificar con curl desde devtools" es el que
   documentan las skills `keel-spring-s3`, conviene revisar si asume una topología de red (docker
   compose "clásico") que no es universal entre runtimes de contenedor.


## Huecos de diseño (`designGaps`)

Reportados por `keel-spring-code` y `keel-spring-quality` a lo largo del pipeline. Ninguno bloqueó los
escenarios `FL-*` (los tres primeros son invisibles en la validación funcional actual); se documentan
para que se evalúen como cambios a `specs/catalog` vía `/keel-evolve`, no se acomodaron en el código.

1. **`removeProductImage`**: `specs/api.keel.yaml` declara `successStatus: 204`, pero
   `specs/use-cases.keel.yaml` declara `output: { entity: Product, embed: [brand, category] }`. Un
   `204` no debería llevar cuerpo; el controller generado por `build` los combina tal cual vienen del
   diseño. Propuesta: `api.keel.yaml` a un status con cuerpo (200) o `use-cases.keel.yaml` a
   `output: "void"`.

2. **`Idempotency-Key` requerida sin `code` de error para su ausencia.** El diseño exige la cabecera en
   `createProduct`/`addProductImage` pero no declara qué pasa si falta. Decisión tomada en este proyecto:
   sin cabecera, se ejecuta sin deduplicar.

3. **Colisión de `Product.slug` bajo alta simultánea sin `code` declarado.** Se usa
   `PRODUCT_SLUG_ALREADY_EXISTS` por convención del scaffolding (mismo patrón que ya aplica a otras
   unicidades no declaradas), no por contrato.

4. **`S3FileStorage.download` mapea `NoSuchKeyException` a `IllegalStateException`** en vez de a un
   error de dominio, porque `storage.keel.yaml` no declara un error `FILE_NOT_FOUND` para el bucket
   `productImages`. Invisible en los escenarios `FL-*` actuales porque ningún caso de uso invoca
   `download` todavía (solo `signedUrl`, que no falla al ser el bucket público); se activaría con el
   primer consumidor futuro del método.

## Otros

Ninguno adicional que reportar.
