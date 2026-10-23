# Corrida de control de shop-api: generación (92/92) y primera paridad contra PostgreSQL

> Copias del `PARITY-shop-api-dotnet.md` (keel-recover parity) y del `INFORME-GENERACION.md` del proyecto, tras dar al
> diseño su estado de partida (`fixtures.yaml`, commit 6d4bba1). La paridad salió con keep 27/27 y fix 45/45; su rojo
> eran 19 `new` sin bloque y 23 diferencias, 16 de ellas de la herramienta (arregladas en 5114880).


> Lo escribe `keel-recover parity` (paso 7). Los mismos flujos de `specs/shop-api/validation-scenarios.md` contra el
> legacy (`recordings/characterization/`) y contra el servicio regenerado (`services/shop-api-dotnet`), traducidos por
> `contract-map.yaml`, y todos los datos de cada paso comparados. No se edita a mano.

**Veredicto: en rojo.** new en rojo contra el regenerado: FL-CAT-007, FL-ACC-015, FL-ACC-016, FL-ACC-017, FL-CRT-014, FL-CRT-015, FL-CRT-017, FL-CRT-018, FL-CRT-019, FL-ORD-019, FL-ORD-020, FL-ORD-021, FL-ORD-023, FL-ORD-024, FL-ORD-025, FL-ORD-026, FL-SEL-014, FL-SEL-015, FL-SEL-021; 23 diferencia(s) de datos sin declarar.

## Los flujos

| Marca | legacy | regenerado | Qué se comprueba en el regenerado |
|---|---|---|---|
| `keep` | 27/27 | **27/27** | lo mismo que hace el legacy |
| `fix` | 45/45 (defecto presente) | **45/45** | el defecto, corregido |
| `new` | no aplica | **0/19** | lo que solo existe en el servicio nuevo |
| `frontier` | 1/1 | 1/1 | informativo: el DSL no lo puede declarar |

En rojo contra el regenerado:

- `FL-CAT-007` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-ACC-015` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-ACC-016` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-ACC-017` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-CRT-014` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-CRT-015` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-CRT-017` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-CRT-018` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-CRT-019` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-ORD-019` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-ORD-020` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-ORD-021` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-ORD-023` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-ORD-024` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-ORD-025` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-ORD-026` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-SEL-014` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-SEL-015` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables
- `FL-SEL-021` (new): no trae su bloque ```keel-flow``` con los pasos ejecutables

## Los datos

74 paso(s) con éxito en los dos lados comparados; 44 diferencia(s): **21 declarada(s) y 23 sin declarar**.

### Sin declarar

Cada una es un defecto del diseño recuperado (o del generador) hasta que se explique: se corrige el diseño, o se declara en `contract-map.yaml → declaredDifferences` con su fix o su frontera.

| Tipo | Operación | Campo | legacy | regenerado | Flujos |
|---|---|---|---|---|---|
| solo-keel | addToCart | `added` | — | `true` | FL-CRT-003, FL-CRT-004, FL-CRT-005 y 10 más |
| solo-keel | modifyCartItem | `cartId` | — | `2147483641` | FL-CRT-009 |
| valor | cancelOrder | `products[].categoryType` | `1` | `0` | FL-ORD-014 |
| valor | cancelOrder | `products[].productDescription` | `"Kids Party Food"` | `"Java SE"` | FL-ORD-014 |
| valor | cancelOrder | `products[].productIcon` | `"http://asset1.marksandspencer.com/is/image/mands/MS_FD_F04C_00398503_NC_X_EC_0?$PDP_MAXI_ZOOM_NEW$"` | `"https://images-na.ssl-images-amazon.com/images/I/51S8VRHA2FL._SX357_BO1,204,203,200_.jpg"` | FL-ORD-014 |
| valor | cancelOrder | `products[].productId` | `"F0001"` | `"B0005"` | FL-ORD-014 |
| valor | cancelOrder | `products[].productName` | `"Chicken"` | `"Thinking in Java"` | FL-ORD-014 |
| valor | cancelOrder | `products[].productPrice` | `4` | `30` | FL-ORD-014 |
| valor | cancelOrder | `products[].productStock` | `57` | `199` | FL-ORD-014 |
| valor | getProduct | `productDescription` | `"Learn Spring"` | `null` | FL-SEL-018 |
| valor | getProduct | `productIcon` | `"https://images-na.ssl-images-amazon.com/images/I/51gHy16h5TL._SX397_BO1,204,203,200_.jpg"` | `null` | FL-SEL-018 |
| valor | getProduct | `productName` | `"Spring In Action"` | `"Spring 5"` | FL-SEL-018 |
| valor | getProduct | `productPrice` | `20` | `25` | FL-SEL-018 |
| valor | getProduct | `productStock` | `195` | `10` | FL-SEL-018 |
| valor | listOrders | `items[].products[].categoryType` | `2` | `1` | FL-ORD-006 |
| valor | listOrders | `items[].products[].productDescription` | `"Kids Party Food"` | `"Family s"` | FL-ORD-006 |
| valor | listOrders | `items[].products[].productIcon` | `"http://asset1.marksandspencer.com/is/image/mands/MS_FD_F04C_00398503_NC_X_EC_0?$PDP_MAXI_ZOOM_NEW$"` | `"http://cdn1.thecomeback.com/wp-content/uploads/2017/05/mcdonalds_food-832x447.png"` | FL-ORD-006 |
| valor | listOrders | `items[].products[].productId` | `"F0001"` | `"F0002"` | FL-ORD-006 |
| valor | listOrders | `items[].products[].productName` | `"Chicken"` | `"McDonald‘s Food"` | FL-ORD-006 |
| valor | listOrders | `items[].products[].productPrice` | `4` | `20` | FL-ORD-006 |
| valor | listOrders | `items[].products[].productStock` | `57` | `22` | FL-ORD-006 |
| valor | modifyCartItem | `productIcon` | `null` | `"https://images-na.ssl-images-amazon.com/images/I/51gHy16h5TL._SX397_BO1,204,203,200_.jpg"` | FL-CRT-009 |
| solo-legacy | addToCart | `` | `true` | — | FL-CRT-003, FL-CRT-004, FL-CRT-005 y 10 más |

### Declaradas

| Diferencias | Motivo |
|---|---|
| 9 | fix-status-names: el estado viaja con nombre (NEW, FINISHED, CANCELED; UP, DOWN) en vez de 0, 1 y 2 |
| 5 | fix-update-product-version: el producto del servicio nuevo lleva version y el del legacy no |
| 3 | fix-password-hash-exposure: el servicio nuevo no devuelve la contraseña codificada, que además ya no guarda (fix-identity-oidc) |
| 3 | fix-register-role-escalation y fix-identity-oidc: el servicio nuevo no acepta ni devuelve un rol; los roles salen del proveedor |
| 1 | fix-cart-client-price: la línea del carrito toma sus datos del catálogo y no del cliente |



## INFORME-GENERACION.md


## Matriz final de `bash infra/score-scenarios.sh` (código de salida 0)

```
Compilando la solución…
Humo del arnés (HarnessSmoke)…
Humo del arnés: OK.
Ejecutando la suite completa…

MATRIZ
  OK       FL-ACC-001           RegisterFlow
  OK       FL-ACC-002           RegisterRoleFlow
  OK       FL-ACC-004           RegisterEmptyFlow
  OK       FL-ACC-005           RegisterDuplicateFlow
  OK       FL-ACC-008           ProfileAccessFlow
  OK       FL-ACC-009           ProfileAccessFlow
  OK       FL-ACC-010           UpdateProfileFlow
  OK       FL-ACC-011           ProfileAccessFlow
  OK       FL-ACC-012           NoPasswordFlow
  OK       FL-ACC-013           PartialProfileUpdateFlow
  OK       FL-ACC-014           RegisterActiveFlow
  OK       FL-ACC-015           NoProfileFlow
  OK       FL-ACC-016           EmailClaimFlow
  OK       FL-ACC-017           EmailClaimFlow
  OK       FL-CAT-001           CatalogFlow
  OK       FL-CAT-002           CatalogFlow
  OK       FL-CAT-003           CatalogFlow
  OK       FL-CAT-004           CatalogFlow
  OK       FL-CAT-005           CatalogFlow
  OK       FL-CAT-006           CatalogFlow
  OK       FL-CAT-007           CatalogFlow
  OK       FL-CAT-008           CatalogFlow
  OK       FL-CAT-009           CatalogFlow
  OK       FL-CRT-001           CartReadFlow
  OK       FL-CRT-002           CartReadFlow
  OK       FL-CRT-003           CartAddFlow
  OK       FL-CRT-004           CartAddTwiceFlow
  OK       FL-CRT-005           CartAddMissingFlow
  OK       FL-CRT-006           CartInvalidQuantityFlow
  OK       FL-CRT-007           CartOverStockFlow
  OK       FL-CRT-008           CartMergeFlow
  OK       FL-CRT-009           CartModifyFlow
  OK       FL-CRT-010           CartModifyMissingFlow
  OK       FL-CRT-011           CartRemoveFlow
  OK       FL-CRT-012           CartCatalogDataFlow
  OK       FL-CRT-013           CartProductDownFlow
  OK       FL-CRT-014           CartWithoutProfileFlow
  OK       FL-CRT-015           CartMergeRepeatedFlow
  OK       FL-CRT-016           CartModifyMinFlow
  OK       FL-CRT-017           CartModifyMinExistingFlow
  OK       FL-CRT-018           CartGuardOrderFlow
  OK       FL-CRT-019           CartMergeGuardFlow
  OK       FL-CRT-020           CartNullableFieldsFlow
  OK       FL-ORD-001           CheckoutFlow
  OK       FL-ORD-002           CheckoutEmptyCartFlow
  OK       FL-ORD-003           CheckoutNoStockFlow
  OK       FL-ORD-004           CheckoutTwiceFlow
  OK       FL-ORD-005           OrderReadFlow
  OK       FL-ORD-006           OrderReadFlow
  OK       FL-ORD-007           OrderReadFlow
  OK       FL-ORD-008           OrderReadFlow
  OK       FL-ORD-009           OrderReadFlow
  OK       FL-ORD-010           FinishOrderFlow
  OK       FL-ORD-011           OrderReadFlow
  OK       FL-ORD-012           OrderReadFlow
  OK       FL-ORD-013           CancelOrderFlow
  OK       FL-ORD-014           CancelOrderOwnershipFlow
  OK       FL-ORD-015           CancelOrderDeletedProductFlow
  OK       FL-ORD-016           CheckoutExactStockFlow
  OK       FL-ORD-017           OrderStatusNamesFlow
  OK       FL-ORD-018           VoidStatus204Flow
  OK       FL-ORD-019           CheckoutIdempotencyFlow
  OK       FL-ORD-020           CheckoutConcurrentFlow
  OK       FL-ORD-021           OrderConcurrentWritesFlow
  OK       FL-ORD-022           CheckoutDeletedProductFlow
  OK       FL-ORD-023           CheckoutProductDownFlow
  OK       FL-ORD-024           ListOrdersNoRoleFlow
  OK       FL-ORD-025           CancelOrderGuardOrderFlow
  OK       FL-ORD-026           CancelOrderStockAboveMaxFlow
  OK       FL-ORD-027           CheckoutAmountExceededFlow
  OK       FL-SEL-001           SellerRejectionsFlow
  OK       FL-SEL-002           CreateProductFlow
  OK       FL-SEL-003           SellerRejectionsFlow
  OK       FL-SEL-004           SellerRejectionsFlow
  OK       FL-SEL-005           SellerRejectionsFlow
  OK       FL-SEL-006           UpdateProductKeepsCreateTimeFlow
  OK       FL-SEL-007           SellerRejectionsFlow
  OK       FL-SEL-008           SellerRejectionsFlow
  OK       FL-SEL-009           UpdateMissingProductFlow
  OK       FL-SEL-010           DeleteProductTwiceFlow
  OK       FL-SEL-011           DeletedProductReadFlow
  OK       FL-SEL-012           SellerRejectionsFlow
  OK       FL-SEL-013           SellerRejectionsFlow
  OK       FL-SEL-014           ProductInputBoundsFlow
  OK       FL-SEL-015           ProductDefaultStatusFlow
  OK       FL-SEL-016           ProductVersionFlow
  OK       FL-SEL-017           SellerRejectionsFlow
  OK       FL-SEL-018           UpdateKeepsCategoryFlow
  OK       FL-SEL-019           ProductInputBoundsFlow
  OK       FL-SEL-020           SellerRejectionsFlow
  OK       FL-SEL-021           SellerRejectionsFlow
  OK       FL-SEL-022           ProductInputBoundsFlow

RESULTADO: OK — 92 escenario(s) al 100%.
exit=0
```

`dotnet test`: 132 de 132. `check-idempotency.sh` y `check-logging.sh`: OK. Baseline de migraciones: `baseline: OK`,
`baselineTested: OK` (`verify-baseline.sh`: 94 elementos del esquema, los mismos en el modelo y en las migraciones).

## Lo que es del generador

- **`infra/init-keycloak.sh` (harness):** sembraba `customer`, `employee`, `manager` y `customer-2` con
  `<usuario>@example.com` y no creaba `newcomer`, mientras que `infra/fixtures.sql` y los escenarios fijan
  `customer1@email.com`, `employee1@email.com`, `manager1@email.com` y `customer2@email.com`. Eso provocaba 43 de los
  45 fallos de la primera puntuación (404 `CART_NOT_FOUND`, 403 `*_NOT_OWNED`, 401 `invalid_grant`). Parche: función
  `email_of()` con los emails del seed, update idempotente del email en realms existentes y alta de `newcomer`
  (`newcomer@example.com`, rol `customer`, sin perfil). `harnessPatches`: estos dos.
- **`ICallerRoles` fuera del manifiesto de build:** el puerto (`Application/Ports/ICallerRoles.cs`) y su adaptador
  (`Security/CallerRoles.cs`) los añadió el agente de código y no están en `keel-generated.json`. Los handlers de pedidos
  lo piden, pero la prueba de build solo monta `AddUseCases()` y `AddPersistence(Disabled)`. Se registra ahora en
  `UseCaseRegistration.AddUseCases()` (`TryAddScoped`); `SecurityRegistration.cs` volvió a su hash generado.
  `UseCaseRegistration.cs` queda editado: un `--refresh` lo marcará como fusión pendiente y hay que conservar esa línea.
  El generador debería generar el puerto y registrarlo en `AddUseCases`.
- **Arreglos a mano del agente de código** (también pueden dar fusión pendiente): `products` en seis DTOs,
  `ModifyCartItemResponseDto` con `long?`, `productId` en `createProduct`, orden por `orderStatus` y
  `Identifiers.NextLong()` para los ids `long`.
- **`CallerIdentity.Resolve` (code):** sin claim `email` lanzaba `InvalidOperationException` (500); ahora lanza
  `UnauthorizedException` → 401 `UNAUTHENTICATED` (FL-ACC-016).
- `culprit: harness` adicional: ninguno. `probes[].verdict: FALSO-NEGATIVO`: ninguno.

## Aproximaciones en la validación

- FL-ACC-016: el proveedor de prueba siempre emite `email_verified=true`, así que la mitad «email no verificado → 200»
  no se comprueba con un token realmente no verificado; tampoco se comprueba que no se cree perfil tras el 401.
- Reportado, sin cambiar: `getProfile`/`updateProfile` responden 403 `PROFILE_NOT_OWNED` antes de comprobar la
  existencia (orden de guardas del diseño), así que un email ajeno inexistente da 403 y no 404.

## Huecos del diseño

Los huecos, con su propuesta, están en `design-gaps.yaml` (17). Los de seed y personas de prueba (gaps 1-2) se
sortearon con `infra/fixtures.sql` y el parche del realm; siguen siendo del diseño: no declara esos datos.
