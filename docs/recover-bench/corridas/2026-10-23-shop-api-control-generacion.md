# Corrida de control de shop-api: generación con keel-dotnet (fase 1, validación parcial)

> Copia del `INFORME-GENERACION.md` y del `design-gaps.yaml` del proyecto generado, antes de tirarlo. 19/92 en verde; los 71
> FALLO son todos de precondición (datos de partida y personas de prueba que el diseño no entrega), ninguno de negocio.

## design-gaps.yaml

```yaml
service: shop-api
version: 0.1.0
generator: keel-dotnet
gaps:
  # --- 1. El seed que los escenarios dan por supuesto y el diseño no entrega -----------------------
  - layer: persistence
    unit: ProductCategory
    kind: missing
    scenario: FL-CAT-001
    source: keel-dotnet-tests
    proposal: >-
      Los flujos parten de un seed (validation-scenarios.md, «Estado de partida»: 12 productos B0001..F0002,
      4 categorías de tipo 0 a 3) que el diseño no entrega. decisions.yaml y domain.keel.yaml aceptan que las
      categorías «se cargan como datos iniciales», pero ningún artefacto declara esos datos, así que el generador
      no tiene de dónde sembrarlos ni qué cargar tras un reset. Declarar en el diseño el conjunto inicial
      (categorías con su categoryType y los 12 productos con sus campos, version 0 incluida) como un artefacto
      del que el generador pueda derivar la carga. Sin él, estos flujos dan CATEGORY_NOT_FOUND /
      PRODUCT_NOT_FOUND o listas vacías: FL-CAT-001..003/005/007..009, FL-CRT-020, FL-ORD-026/027 y
      FL-SEL-002/003/006/010/011/014/015/016/018/019/021/022.
  - layer: persistence
    unit: User
    kind: missing
    scenario: FL-CRT-001
    source: keel-dotnet-tests
    proposal: >-
      El seed de usuarios y carritos tampoco está declarado: los escenarios necesitan los perfiles customer1,
      customer2, employee1 y manager1 (customer1 con teléfono 123456789 y dirección «3200 West Road») y un carrito
      vacío por cliente. Sin ellos, todo flujo que toca el carrito responde CART_NOT_FOUND (FL-CRT-001/003..013/
      015/017/019, FL-ORD-001..004/013/015/016/018..020/022/023) y FL-ACC-008/010/013 no tienen perfil que leer. Declarar
      esos registros iniciales con sus identificadores, junto al dato de la gap anterior.
  - layer: persistence
    unit: OrderMain
    kind: missing
    scenario: FL-ORD-005
    source: keel-dotnet-tests
    proposal: >-
      Los flujos de pedidos dependen de ocho pedidos del seed con ids estables (2147483648 y siguientes), estado,
      importe, líneas y createTime concretos (FL-ORD-006 los detalla; 3 son de customer1 y 5 de customer2). Nada
      del diseño los declara y el generador no puede inventarlos: FL-ORD-005/006/008..011/014/017/021/025 dan
      ORDER_NOT_FOUND o listas vacías. Declarar los pedidos y sus líneas iniciales con esos valores exactos.
  - layer: persistence
    unit: service
    kind: missing
    scenario: FL-ORD-005
    source: keel-dotnet-tests
    proposal: >-
      El estado de partida de cada flujo es «el seed», pero el reset entre flujos (infra/reset-db.sh) hace TRUNCATE
      de todas las tablas, y un diseño que declara datos iniciales tiene que decir cómo se restauran. Declarar que
      el reset de prueba restaura el seed y no deja la base vacía, o que las categorías (que ninguna operación
      puede recrear) quedan fuera del vaciado. Con la base vacía solo 19 de los 92 escenarios son ejercitables.

  # --- 2. Las personas de prueba necesitan su email --------------------------------------------------
  - layer: security
    unit: identity
    kind: missing
    scenario: FL-ACC-008
    source: keel-dotnet-tests
    proposal: >-
      El perfil se identifica por el claim email (fix-identity-oidc) y los escenarios nombran a sus actores por
      email: customer1@email.com, customer2@email.com, employee1@email.com, manager1@email.com. El diseño no
      declara las personas de prueba, y el realm que siembra el generador crea los usuarios con
      <usuario>@example.com, así que el email del token no coincide con el del seed y getProfile/updateProfile
      responden 403 PROFILE_NOT_OWNED (FL-ACC-008/010/013). Declarar cada persona con su username, su rol y su
      email para que el generador siembre el proveedor de identidad con ellos.
  - layer: security
    unit: identity
    kind: missing
    scenario: FL-ACC-001
    source: keel-dotnet-tests
    proposal: >-
      El actor n1 («newcomer») es un cliente autenticado que todavía no tiene perfil; el realm de prueba no tiene
      ese usuario y pedir su token falla con 401 invalid_grant. Afecta a FL-ACC-001/002/004/005/012/014/015 y
      FL-CRT-014/018. Declarar entre las personas de prueba una con el rol customer, un email que no esté en el
      seed y sin perfil, para que el generador la siembre en el proveedor de identidad.
  - layer: security
    unit: identity
    kind: missing
    scenario: FL-ACC-016
    source: keel-dotnet-tests
    proposal: >-
      FL-ACC-016 necesita un token válido sin claim email y otro con email unverified@x.io y emailVerified false;
      el arnés no tiene forma de pedirlos y el realm no tiene esos usuarios. El escenario queda NO_EJERCITADO.
      Declarar esas dos personas (sin email, y con email sin verificar) para que el generador las siembre y el
      arnés pueda pedir su token.
  - layer: security
    unit: identity
    kind: missing
    scenario: FL-ACC-017
    source: keel-dotnet-tests
    proposal: >-
      FL-ACC-017 compara el email distinguiendo mayúsculas y necesita dos personas, n1 con Bob@x.io y n2 con
      bob@x.io; el realm no las tiene y el arnés no tiene cómo pedir un token con un email arbitrario. El
      escenario queda NO_EJERCITADO. Declarar las dos personas y cómo se obtiene un token con cada email tal cual.

  # --- 3. Arreglos a mano sobre código generado (keel-dotnet-code) ------------------------------------
  - layer: security
    unit: security.ownership.exemptRoles
    kind: missing
    scenario: FL-ORD-009
    source: keel-dotnet-code
    proposal: >-
      Arreglo a mano 1. getOrder, cancelOrder y listOrders eximen de la comprobación de propiedad a employee y
      manager, pero Application no ve el token y el generador no deja ningún camino para que el handler sepa el
      rol de quien llama. Se añadió a mano el puerto ICallerRoles (Application/Ports/ICallerRoles.cs), su adaptador
      Infrastructure/Security/CallerRoles.cs y una línea en SecurityRegistration.cs. El generador debe emitir ese
      puerto cuando una regla de ownership tenga exemptRoles; una futura build --refresh puede dar fusión pendiente
      en SecurityRegistration.cs.
  - layer: api
    unit: getCart
    kind: missing
    scenario: FL-CRT-003
    source: keel-dotnet-code
    proposal: >-
      Arreglo a mano 2. Los DTOs de respuesta de getCart, mergeCart, getOrder, listOrders, cancelOrder y
      finishOrder salieron sin la propiedad products porque la línea (ProductInOrder) es otra raíz; los escenarios
      afirman products.N.*. Se añadió ProductLineDto, la propiedad Products en los seis DTOs y se cambió la firma
      de los mapeadores de carrito y pedido para recibir las líneas. El generador debe emitir una relación
      uno-a-muchos entre raíces como colección en el DTO de respuesta; hasta entonces, build --refresh puede
      pisar o dar fusión pendiente en esos seis DTOs y sus mapeadores.
  - layer: api
    unit: modifyCartItem
    kind: contradiction
    scenario: FL-CRT-009
    source: keel-dotnet-code
    proposal: >-
      Arreglo a mano 3. ModifyCartItemResponseDto tipaba CartId y OrderId como Guid? mientras el dominio guarda
      Cart.cartId y el id del pedido como long, así que el mapeo no cerraba. Se cambió a long? y el mapeador los
      rellena. El generador debe derivar el tipo del DTO del tipo del campo referenciado y no de un uuid por
      defecto en una relación entre raíces.
  - layer: api
    unit: createProduct
    kind: missing
    scenario: FL-SEL-002
    source: keel-dotnet-code
    proposal: >-
      Arreglo a mano 4. El diseño dice que quien crea el producto manda su productId (código natural, no generado),
      pero el comando y el lector generados lo descartaban. Se añadió ProductId a CreateProductCommand y a
      ReadCreateProduct en ProductInfoV1Endpoints.cs, con la misma comprobación de formato que updateProduct. El
      generador debe incluir en el comando los campos de entrada no generados de la entidad que sean su
      identificador.
  - layer: persistence
    unit: listOrders
    kind: contradiction
    scenario: FL-ORD-006
    source: keel-dotnet-code
    proposal: >-
      Arreglo a mano 5. El orden por orderStatus en OrderMainRepository.Sortable salía por el texto de la columna
      (CANCELED, FINISHED, NEW) cuando el diseño ordena por la posición de declaración del enum (NEW, FINISHED,
      CANCELED). Se cambió por una expresión CASE. El generador debe ordenar una columna de enum por la posición
      de declaración y no por su nombre.
  - layer: persistence
    unit: ProductInfo
    kind: missing
    scenario: FL-SEL-002
    source: keel-dotnet-code
    proposal: >-
      Los ids long marcados generated: true no tienen generador en la base (ValueGeneratedNever, sin secuencia).
      Se añadió a mano Domain/Support/Identifiers.NextLong() (creciente en el proceso, por encima de los ids del
      seed y por debajo de 2^53); dos réplicas podrían colisionar en el mismo milisegundo y verlo como 409. El
      generador debe emitir una secuencia o un generador de ids para esos campos, o el diseño declarar cómo se
      asignan.

  # --- 4. Discrepancias entre docs/openapi.yaml y los escenarios --------------------------------------
  - layer: api
    unit: getCart
    kind: contradiction
    scenario: FL-CRT-003
    source: keel-dotnet-tests
    proposal: >-
      docs/openapi.yaml omite products en las respuestas de getCart, mergeCart, getOrder, listOrders, cancelOrder
      y finishOrder (GetCartResponseDto solo declara cartId), mientras validation-scenarios.md afirma products.N.*
      en ellas. Corregir en el diseño de la capa api el tipo de respuesta de esas seis operaciones para que
      incluya la colección de líneas y regenerar el contrato con /keel-docs.
  - layer: api
    unit: createProduct
    kind: contradiction
    scenario: FL-SEL-002
    source: keel-dotnet-tests
    proposal: >-
      CreateProductRequest en docs/openapi.yaml no incluye productId y marca productStatus como obligatorio, pero
      los escenarios mandan productId y omiten productStatus (FL-SEL-002, FL-SEL-015: un producto sin estado queda
      a la venta). Añadir productId y quitar productStatus de required en el cuerpo de createProduct, y regenerar
      el contrato.
  - layer: api
    unit: modifyCartItem
    kind: contradiction
    scenario: FL-CRT-009
    source: keel-dotnet-tests
    proposal: >-
      ModifyCartItemResponseDto declara cartId y orderId como string uuid en docs/openapi.yaml, pero Cart.cartId
      es long (el resto del contrato lo declara integer int64). Declararlos como integer int64 en el diseño y
      regenerar el contrato.
```

## INFORME-GENERACION.md


## Matriz final de `bash infra/score-scenarios.sh` (código de salida 1)

```
MATRIZ
  FALLO    FL-ACC-001           RegisterFlow                 build/keel-failures/FL-ACC-001.json
  FALLO    FL-ACC-002           RegisterRoleFlow             build/keel-failures/FL-ACC-002.json
  FALLO    FL-ACC-004           RegisterEmptyFlow            build/keel-failures/FL-ACC-004.json
  FALLO    FL-ACC-005           RegisterDuplicateFlow        build/keel-failures/FL-ACC-005.json
  FALLO    FL-ACC-008           ProfileAccessFlow            build/keel-failures/FL-ACC-008.json
  OK       FL-ACC-009           ProfileAccessFlow
  FALLO    FL-ACC-010           UpdateProfileFlow            build/keel-failures/FL-ACC-010.json
  OK       FL-ACC-011           ProfileAccessFlow
  FALLO    FL-ACC-012           NoPasswordFlow               build/keel-failures/FL-ACC-012.json
  FALLO    FL-ACC-013           PartialProfileUpdateFlow     build/keel-failures/FL-ACC-013.json
  FALLO    FL-ACC-014           RegisterActiveFlow           build/keel-failures/FL-ACC-014.json
  FALLO    FL-ACC-015           NoProfileFlow                build/keel-failures/FL-ACC-015.json
  FALLO    FL-CAT-001           CatalogFlow                  build/keel-failures/FL-CAT-001.json
  FALLO    FL-CAT-002           CatalogFlow                  build/keel-failures/FL-CAT-002.json
  FALLO    FL-CAT-003           CatalogFlow                  build/keel-failures/FL-CAT-003.json
  OK       FL-CAT-004           CatalogFlow
  FALLO    FL-CAT-005           CatalogFlow                  build/keel-failures/FL-CAT-005.json
  OK       FL-CAT-006           CatalogFlow
  FALLO    FL-CAT-007           CatalogFlow                  build/keel-failures/FL-CAT-007.json
  FALLO    FL-CAT-008           CatalogFlow                  build/keel-failures/FL-CAT-008.json
  FALLO    FL-CAT-009           CatalogFlow                  build/keel-failures/FL-CAT-009.json
  FALLO    FL-CRT-001           CartReadFlow                 build/keel-failures/FL-CRT-001.json
  OK       FL-CRT-002           CartReadFlow
  FALLO    FL-CRT-003           CartAddFlow                  build/keel-failures/FL-CRT-003.json
  FALLO    FL-CRT-004           CartAddTwiceFlow             build/keel-failures/FL-CRT-004.json
  FALLO    FL-CRT-005           CartAddMissingFlow           build/keel-failures/FL-CRT-005.json
  FALLO    FL-CRT-006           CartInvalidQuantityFlow      build/keel-failures/FL-CRT-006.json
  FALLO    FL-CRT-007           CartOverStockFlow            build/keel-failures/FL-CRT-007.json
  FALLO    FL-CRT-008           CartMergeFlow                build/keel-failures/FL-CRT-008.json
  FALLO    FL-CRT-009           CartModifyFlow               build/keel-failures/FL-CRT-009.json
  FALLO    FL-CRT-010           CartModifyMissingFlow        build/keel-failures/FL-CRT-010.json
  FALLO    FL-CRT-011           CartRemoveFlow               build/keel-failures/FL-CRT-011.json
  FALLO    FL-CRT-012           CartCatalogDataFlow          build/keel-failures/FL-CRT-012.json
  FALLO    FL-CRT-013           CartProductDownFlow          build/keel-failures/FL-CRT-013.json
  FALLO    FL-CRT-014           CartWithoutProfileFlow       build/keel-failures/FL-CRT-014.json
  FALLO    FL-CRT-015           CartMergeRepeatedFlow        build/keel-failures/FL-CRT-015.json
  OK       FL-CRT-016           CartModifyMinFlow
  FALLO    FL-CRT-017           CartModifyMinExistingFlow    build/keel-failures/FL-CRT-017.json
  FALLO    FL-CRT-018           CartGuardOrderFlow           build/keel-failures/FL-CRT-018.json
  FALLO    FL-CRT-019           CartMergeGuardFlow           build/keel-failures/FL-CRT-019.json
  FALLO    FL-CRT-020           CartNullableFieldsFlow       build/keel-failures/FL-CRT-020.json
  FALLO    FL-ORD-001           CheckoutFlow                 build/keel-failures/FL-ORD-001.json
  FALLO    FL-ORD-002           CheckoutEmptyCartFlow        build/keel-failures/FL-ORD-002.json
  FALLO    FL-ORD-003           CheckoutNoStockFlow          build/keel-failures/FL-ORD-003.json
  FALLO    FL-ORD-004           CheckoutTwiceFlow            build/keel-failures/FL-ORD-004.json
  FALLO    FL-ORD-005           OrderReadFlow                build/keel-failures/FL-ORD-005.json
  FALLO    FL-ORD-006           OrderReadFlow                build/keel-failures/FL-ORD-006.json
  OK       FL-ORD-007           OrderReadFlow
  FALLO    FL-ORD-008           OrderReadFlow                build/keel-failures/FL-ORD-008.json
  FALLO    FL-ORD-009           OrderReadFlow                build/keel-failures/FL-ORD-009.json
  FALLO    FL-ORD-010           FinishOrderFlow              build/keel-failures/FL-ORD-010.json
  FALLO    FL-ORD-011           OrderReadFlow                build/keel-failures/FL-ORD-011.json
  OK       FL-ORD-012           OrderReadFlow
  FALLO    FL-ORD-013           CancelOrderFlow              build/keel-failures/FL-ORD-013.json
  FALLO    FL-ORD-014           CancelOrderOwnershipFlow     build/keel-failures/FL-ORD-014.json
  FALLO    FL-ORD-015           CancelOrderDeletedProductFlow build/keel-failures/FL-ORD-015.json
  FALLO    FL-ORD-016           CheckoutExactStockFlow       build/keel-failures/FL-ORD-016.json
  FALLO    FL-ORD-017           OrderStatusNamesFlow         build/keel-failures/FL-ORD-017.json
  FALLO    FL-ORD-018           VoidStatus204Flow            build/keel-failures/FL-ORD-018.json
  FALLO    FL-ORD-019           CheckoutIdempotencyFlow      build/keel-failures/FL-ORD-019.json
  FALLO    FL-ORD-020           CheckoutConcurrentFlow       build/keel-failures/FL-ORD-020.json
  FALLO    FL-ORD-021           OrderConcurrentWritesFlow    build/keel-failures/FL-ORD-021.json
  FALLO    FL-ORD-022           CheckoutDeletedProductFlow   build/keel-failures/FL-ORD-022.json
  FALLO    FL-ORD-023           CheckoutProductDownFlow      build/keel-failures/FL-ORD-023.json
  OK       FL-ORD-024           ListOrdersNoRoleFlow
  FALLO    FL-ORD-025           CancelOrderGuardOrderFlow    build/keel-failures/FL-ORD-025.json
  FALLO    FL-ORD-026           CancelOrderStockAboveMaxFlow build/keel-failures/FL-ORD-026.json
  FALLO    FL-ORD-027           CheckoutAmountExceededFlow   build/keel-failures/FL-ORD-027.json
  OK       FL-SEL-001           SellerRejectionsFlow
  FALLO    FL-SEL-002           CreateProductFlow            build/keel-failures/FL-SEL-002.json
  FALLO    FL-SEL-003           SellerRejectionsFlow         build/keel-failures/FL-SEL-003.json
  OK       FL-SEL-004           SellerRejectionsFlow
  OK       FL-SEL-005           SellerRejectionsFlow
  FALLO    FL-SEL-006           UpdateProductKeepsCreateTimeFlow build/keel-failures/FL-SEL-006.json
  OK       FL-SEL-007           SellerRejectionsFlow
  OK       FL-SEL-008           SellerRejectionsFlow
  OK       FL-SEL-009           UpdateMissingProductFlow
  FALLO    FL-SEL-010           DeleteProductTwiceFlow       build/keel-failures/FL-SEL-010.json
  FALLO    FL-SEL-011           DeletedProductReadFlow       build/keel-failures/FL-SEL-011.json
  OK       FL-SEL-012           SellerRejectionsFlow
  OK       FL-SEL-013           SellerRejectionsFlow
  FALLO    FL-SEL-014           ProductInputBoundsFlow       build/keel-failures/FL-SEL-014.json
  FALLO    FL-SEL-015           ProductDefaultStatusFlow     build/keel-failures/FL-SEL-015.json
  FALLO    FL-SEL-016           ProductVersionFlow           build/keel-failures/FL-SEL-016.json
  OK       FL-SEL-017           SellerRejectionsFlow
  FALLO    FL-SEL-018           UpdateKeepsCategoryFlow      build/keel-failures/FL-SEL-018.json
  FALLO    FL-SEL-019           ProductInputBoundsFlow       build/keel-failures/FL-SEL-019.json
  OK       FL-SEL-020           SellerRejectionsFlow
  FALLO    FL-SEL-021           SellerRejectionsFlow         build/keel-failures/FL-SEL-021.json
  FALLO    FL-SEL-022           ProductInputBoundsFlow       build/keel-failures/FL-SEL-022.json
  NO_EJERC FL-ACC-016
  NO_EJERC FL-ACC-017

RESULTADO: KO — 19 OK · 71 FALLO · 0 omitido(s) · 2 no ejercitado(s).
  evidencia por fallo: build/keel-failures/<FL-id>.json (request, response y aserción)
  log del servidor: build/keel-scenarios/server.log
  log completo de dotnet: build/keel-scenarios/run.log
exit=1
```

## Alcance acordado: validación parcial

La generación **no está validada**: el servicio compila y 19 de 92 escenarios pasan, pero el resto no se ha podido
ejercitar. Por decisión del diseñador (opción 3), los flujos que dependen de un seed que el diseño no entrega, o de
personas que el realm de prueba no tiene, **no se validan**, y no se ha traducido ni inventado ningún dato:

- No hay `seed.sql`, ni se ha tocado `infra/reset-db.sh` (hace TRUNCATE de todo y no restaura nada), ni los usuarios
  de `infra/init-keycloak.sh` (emails `<usuario>@example.com`, sin `newcomer`).
- No se invocó a `keel-dotnet-validate`: los 71 FALLO se clasificaron por su volcado en `build/keel-failures/`.
  Todos fallan por una precondición ausente, ninguno por una aserción de negocio:
  - 401 `invalid_grant` al pedir el token de la persona (`newcomer`): FL-ACC-001/002/004/005/012/014/015, FL-CRT-014/018.
  - 403 `PROFILE_NOT_OWNED` por email distinto del seed: FL-ACC-008/010/013.
  - `CART_NOT_FOUND`, `ORDER_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `CATEGORY_NOT_FOUND` o listas vacías: el resto.
- FL-ACC-016 y FL-ACC-017 no se ejercitan (faltan tokens sin email, con email sin verificar y con mayúsculas).
- Los 19 OK son los que no necesitan datos previos: FL-ACC-009/011, FL-CAT-004/006, FL-CRT-002/016, FL-ORD-007/012/024
  y FL-SEL-001/004/005/007/008/009/012/013/017/020.

## Sin hacer, por no estar todo en verde

- **Fase 3 (calidad + baseline de migraciones): no se ejecutó.** Sin `Baseline` ni `baselineTested`, el servicio
  pasa lo que pasa en el perfil `local` pero **no arranca en `develop` ni en `production`**.
- **Guía de despliegue en el README: no escrita.**
- **Sin commit:** hay escenarios en FALLO. El repo git está inicializado, sin commits.

## Del generador

- Arreglos a mano de `keel-dotnet-code` (una futura `build --refresh` puede dar fusión pendiente): `ICallerRoles`
  (puerto, adaptador y línea en `SecurityRegistration.cs`), `products` en seis DTOs, `ModifyCartItemResponseDto`
  con `long?`, `productId` en `createProduct`, orden por `orderStatus`; y `Identifiers.NextLong()` para los ids `long`.
- `harnessPatches`: ninguno. `culprit: harness`: ninguno. `FALSO-NEGATIVO`: ninguno.
- Reportado, sin cambiar: `getProfile`/`updateProfile` responden 403 `PROFILE_NOT_OWNED` antes de comprobar la
  existencia (orden de guardas del diseño), así que el email ajeno inexistente da 403 y no 404.
- Un `grep` global de `keel-dotnet-tests` tocó una línea de comentario de `ProductCategory` en `src/`; sin efecto.

Los 17 huecos, con su propuesta, están en `design-gaps.yaml`.
