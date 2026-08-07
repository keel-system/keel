# Informe de generación — asset-vault (rama documental)

Corrida completa de `/keel-generate-spring` sobre `specs/asset-vault` v1.0.0 en un
workspace de diseño externo al repo, con la fixture
`packages/keel-spring/test/fixtures/asset-vault/` copiada como diseño canónico.

Es la **primera vez que se arranca un servidor documental** generado por keel-spring:
`compile-check` solo compila el arnés y `broker-check` no levanta la JVM, así que todo
lo que sigue estaba fuera del alcance de cualquier gate anterior.

**Resultado**: 10 de 10 escenarios `FL-*` en OK, **cero ciclos de arbitraje** consumidos
(el cupo era 2). Pase de calidad `status: OK`, `scenarios: OK`, `contextTest: OK`,
`indexes: OK`, `indexesTested: OK`, `dedupe`/`commandIdempotency`/`compensation` OK,
sin `blockers`.

| Escenario | Resultado | Clase |
|---|---|---|
| FL-AST-001 · -001-B · -001-C | OK | `AssetCustodyFlowIT` |
| FL-AST-002 · -002-B | OK | `AssetPublicationFlowIT` |
| FL-AST-003 · -003-B | OK | `AssetLookupFlowIT` |
| FL-AST-004 | OK | `AssetListingFlowIT` |
| FL-QUA-001 · -001-B | OK | `AssetQuarantineFlowIT` |

Stack: MongoDB 7 (replica set `rs0`), Kafka, Keycloak, Redis, MinIO, WireMock, sobre
podman en Windows. JDK 21.

**Verificación del port** (los fixes viven en el generador, no en el proyecto):
`npm test` en verde en los dos workspaces con los casos de regresión nuevos;
`compile-check` en verde para `asset-vault` con los tres brokers y para
`inspection-reports` como control documental; y el archivo que build genera ahora
—`AuditableDocument`, con su `carryCreationAudit`— sustituido en el proyecto de la
corrida y la suite re-puntuada al 100%, que es lo que prueba que la versión del
generador y la que escribió el agente son la misma cosa.

---

## Defectos del generador (bloquearon la corrida)

Los cuatro están **corregidos en el generador y congelados** como casos de regresión en
`packages/keel-spring/test/document-transversal.test.js` § *Corrida del pipeline completo*.

### 1. El finder de la clave natural no casaba con la propiedad del espejo

`build` generaba `findByOwnerAndSlug(String owner, String slug)` para una
`naturalKey: [owner, slug]`, pero ni el dominio ni el documento tienen propiedad
`owner`: guardan `ownerId`, un `UUID`. Spring Data valida los finders derivados **al
construir el contexto**, así que esto no rompe la compilación — **tumba el arranque**
con `PropertyReferenceException`, y solo se ve levantando la aplicación.

Causa: `naturalKeyParams()` resolvía cada nombre de la clave natural contra
`entity.fields` (solo escalares) y, al no encontrar la relación, caía a un fallback
`String` con el nombre del diseño.

Corregido en `src/scaffold/repositories.js`: se resuelve contra `domainMembers()`, que
ya clasifica el miembro como `externalRef` con su nombre y tipo reales, y lo que no se
resuelve deja aviso en vez de generarse en silencio. **Afecta a los dos modelos de
persistencia** —el fallback era común—, no solo al documental; nadie había declarado
antes una clave natural que atravesara una referencia.

### 2. Cada actualización borraba la auditoría de creación

Con `audit.timestamps/authorship: all`, un `publish` sobre un agregado existente dejaba
`created_at` y `created_by` a **null**.

Causa: el adaptador construye un `XxxDocument` nuevo en cada `save` y Mongo
**reemplaza el documento entero**; el callback de auditoría de Spring Data solo estampa
`@CreatedDate`/`@CreatedBy` cuando el documento es nuevo. No tiene equivalente
relacional: allí el merge de JPA conserva esas columnas por sí solo, y por eso la
política `all` funcionaba desde siempre en esa rama.

Corregido en `src/scaffold/document-entities.js` (`AuditableDocument.carryCreationAudit`,
con los parámetros que correspondan a los ejes declarados) y
`src/scaffold/document-repositories.js` (el `save` relee la raíz y arrastra la creación
antes de guardar).

### 3. El mongod embebido secuestraba la conexión de las pruebas de integración

`HarnessSmokeIT` en rojo, `score-scenarios.sh` con exit 2 y **la suite entera sin
ejecutar**: el contexto no arrancaba porque `EmbeddedMongoAutoConfiguration` reemplazaba
el `MongoDatabaseFactory` y fallaba al instanciar `version`.

Causa: el source set `integrationTest` hereda las dependencias de `test`
(`integrationTestImplementation.extendsFrom testImplementation`), donde vive flapdoodle
por ser la base del perfil `test`. Con él en el classpath, su autoconfiguración se activa
**también** bajo el perfil `local` con el que corren las IT contra la infraestructura
real. No es simétrico con H2, que se limita a estar en el classpath sin reclamar la
conexión — por eso la herencia nunca había hecho daño.

Corregido en `src/scaffold/gradle.js`: las configuraciones de `integrationTest` excluyen
el grupo `de.flapdoodle.embed` cuando el modelo es documental. Sigue declarado en `test`,
que es donde sí es la base del perfil.

### 4. `@NotBlank` sobre un campo de subida

`UploadAssetCommand` declaraba `@NotBlank FileUpload binary`. `@NotBlank` es de
`CharSequence`: no falla al compilar, revienta al validar.

Causa: `asPayloadField()` (`src/lib/model.js`) ya corregía la anotación, pero **solo en
la lista `validation`**; el command se anota desde `inputValidation`, que se quedaba con
la heredada del tipo `string`. Corregido escribiendo las dos listas.

---

## Defecto del generador detectado y corregido en la misma corrida

### 5. Los imports del tipo del finder (regresión de la corrección 1)

Al resolver la clave natural por miembros, los imports del tipo (`java.time.LocalDate`,
`java.math.BigDecimal`…) dejaron de viajar: un miembro escalar **envuelve** al campo
resuelto y los imports viven dentro. Lo cazó `java-syntax.test.js` sobre
`inspection-reports` y `metering-digest` antes de salir del repo, que es exactamente
para lo que existe esa red. Corregido en `repositories.js`.

---

## Carencias del arnés (`blockers` del agente de pruebas) — pendientes

No bloquearon la corrida, pero dejaron tres cláusulas `Then` **sin asertar**. Son del
generador (`src/scaffold/integration-tests.js`), no de este proyecto:

1. **`stubCallCount(método, ruta)` solo cuenta.** No permite exigir que la llamada
   saliente llevara un cuerpo concreto ni una cabecera. Por eso FL-AST-002 · Then 2 y 3
   (que la llamada al escáner lleve `assetId`/`storageKey` y la cabecera
   `Idempotency-Key`) quedan como `uncovered`. Propuesta del agente: un
   `stubRequests(method, pathPattern)` que devuelva el log de `/__admin/requests/find`.
2. **No hay helper para vaciar la caché** del servicio; las clases lo hacen con
   `devtoolsShell('redis-cli … DEL')`. Propuesta: `clearCache()` en `AbstractFlowIT`,
   con la misma orden que `infra/reset-db.sh`.
3. **`devtools()` no puede hablar con la base**: su imagen no trae `mongosh`, así que
   toda interacción con MongoDB exige plumbing propio en la clase de prueba. Propuesta:
   un `db(String... argv)` que ejecute en el contenedor de la BD con la misma resolución
   de runtime.

También queda anotado un **desvío de proceso**: la skill manda relanzar al agente de
pruebas ante un exit 2, pero el defecto 3 vivía en `build.gradle` —salida de `build`,
fuera del alcance de ese agente—, así que lo corrigió el orquestador como portador del
fix del generador.

---

## Huecos del diseño (`designGaps`)

Son de la fixture `asset-vault`, no del generador. Los tres agentes coincidieron en los
dos primeros, que son los importantes:

1. **`Owner` no tiene operación de alta.** Es raíz de agregado con clave natural y
   `uploadAsset` declara `OWNER_NOT_FOUND`, pero ninguna operación lo crea: el `Given`
   «existe el propietario `<o1>`» **no es materializable por la API** y bloquea los 10
   escenarios. El agente de pruebas lo sembró con `mongosh`, declarándolo en
   `assumptions`. Procede declarar `registerOwner`, o marcar `Owner` como agregado de
   solo lectura alimentado por una suscripción del servicio dueño.
2. **FL-AST-001 exige `createdAt`/`createdBy` en el cuerpo**, pero `audit: all` mantiene
   la auditoría fuera del dominio y de todo contrato: ningún DTO los proyecta. O el
   escenario deja de pedirlos, o el diseño los declara con `audit: declared`.
3. **La cuarentena no invalida la caché.** `quarantineAsset` no emite evento y el
   `invalidatedBy` de `getAsset` solo cubre `AssetUploaded`/`AssetPublished`: la ficha
   cacheada sigue diciendo `published` durante los 300 s del TTL.
4. **El `need` de miniatura no tiene dónde aterrizar**: `rendering.thumbnail` va
   `usedBy: [getAsset]`, pero el output es `{ entity: Asset }` y `Asset` no declara
   campo para ella. La llamada se hace y el resultado no puede viajar en la respuesta.
5. **Errores no declarados** que el scaffolding cubre con codes de convención:
   unicidad de `Owner.code`, misma clave de idempotencia con otro cuerpo
   (`IDEMPOTENCY_KEY_REUSED`), tipo de contenido y tamaño fuera de la política del bucket
   (`UNSUPPORTED_CONTENT_TYPE`, `FILE_TOO_LARGE`), clave inexistente en el bucket
   (`FILE_NOT_FOUND`) y veredicto sucio del escáner (distinto de `SCANNER_UNAVAILABLE`).
6. **`quarantineAsset` recibe `reason`** pero `Asset` no declara campo donde custodiarlo:
   el motivo solo queda en la traza.
7. **`reconcileScans` declara cuándo corre, no qué hacer**: el handler observa y registra
   a WARN, sin efecto de negocio — inventarlo sería inventar diseño.

---

## Observaciones de alcance (no son defectos)

- `idx_assets_owner` es redundante con el prefijo de `uk_assets_natural (owner_id, slug)`:
  Mongo ya sirve las consultas por `owner_id` con el índice compuesto. Está declarado en
  el diseño, así que quitarlo es decisión del diseño.
- `findStaleIdsByStatus` consulta por `(status, updated_at)` y solo hay índice por
  `status`: con volumen alto, el barrido de `reconcileScans` escanea.
- El pase de calidad no encontró más casos de la familia del defecto 2: el arrastre está
  aplicado simétricamente en los dos adaptadores y todos los finders derivados casan con
  propiedades reales del documento.
