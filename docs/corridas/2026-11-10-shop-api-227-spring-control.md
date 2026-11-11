# Corrida de control de la lectura acotada (DSL 2.27) — `shop-api` en keel-spring

| Etiqueta | Valor |
|---|---|
| Diseño | `shop-api` v0.1.1 (DSL 2.27, relacional, 5 capas), con `OrderMain.reads` en `forbidden` y `User.reads` en `not-found` |
| Stack | `postgresql · keycloak` (sin broker, caché ni storage; telemetría `none`) |
| Generador | `keel-spring@0.3.0` (`260c908c` al generar) |
| Diseño listo al generar | no, con --accept-unready (characterized, design-doc, gaps, structural, undecided) |
| Papel | control |
| Matriz final | **92/92 OK** (primera pasada 21 OK · 71 FALLO, por el arnés escrito por el agente) |
| Huella del agente | 327 archivos registrados por `build`, 0 adoptados, **32 reescritos**, 0 borrados |
| Clasificación de la huella | 27 TODO · 5 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 en `design-gaps.yaml` (el agente no lo escribió) + 2 que el informe cuenta en prosa |
| Huecos del generador | 2 (ver § Huecos del generador) |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\shop-227-spring-postgre\services\shop-api-spring`. Corrida de control del incremento 8 de
`PLAN-DSL-227-LECTURA-ACOTADA.md`. La paridad con el legacy se valida aparte.

## Lo que medía

- **Las cargas van acotadas**: `GetOrderQueryHandler` con `loadScoped(query.orderId(), query.readScope())`,
  `GetProfileQueryHandler` con `loadScopedByEmail(query.email(), query.readScope())`, y `ListOrdersQueryHandler` con el finder
  y el scope.
- **La fila ajena**: FL-ORD-005 (`totalElements` 3 con los pedidos de `customer2` fuera), FL-ORD-009 (403) y FL-ACC-009 (404
  `PROFILE_NOT_FOUND`, la decisión `fix-profile-other-404`), en verde.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- La matriz, contra los JUnit de `build/test-results/integrationTest`: 95 casos, 0 fallos, 92 `FL-*` distintos en verde.
- La huella, contra una regeneración limpia con el mismo stack y los mismos `specs/`: 27 de los 32 reescritos tenían un
  TODO. Los otros 5 son consultas añadidas a los puertos y adaptadores de `ProductInfo` y `ProductInOrder` (`findAllByIds`,
  `findAllByOrderIds`, `findByCartIdAndProductId`): lecturas por lote y la línea del carrito. El arnés generado no se tocó.
- Clasificación a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Huecos del generador

1. **`ensurePersona` no valida la longitud del `sub`** (arnés de keel-spring; keel-nest y keel-dotnet tienen el mismo código
   sin la guarda). El `sub` es el id del usuario en `partialImport`, y en Keycloak `USER_ENTITY.ID` es `VARCHAR(36)`: con uno
   más largo responde 500, no hay token, y cayeron 71 flujos en la primera pasada. El `sub` largo lo escribió el agente de
   pruebas (`ShopFlowBase.subOf`), pero el arnés debería rechazarlo con un mensaje claro, y el humo no lo prueba.
2. **La skill cita un schema que el proyecto no tiene.** Pide `design-gaps.yaml` con el schema `design-gaps.schema.json` de
   keel-core, que vive en el workspace (`schema/`) y no en el proyecto. El agente no quiso inventar el formato y no lo
   escribió, así que sus dos observaciones no vuelven solas al diseño.

## designGaps

Salen del informe, en prosa; no hay `design-gaps.yaml`.

- `cart-line-sum-over-max` — `mergeCart` y `addToCart` suman cantidades y el diseño no dice qué pasa si la suma supera el máximo de `count` (1.000.000). El agente usa `Math.addExact`, que solo atrapa el desbordamiento del entero
- `fl-acc-016-profile-unobservable` — FL-ACC-016 afirma que no se crea ningún perfil tras el 401 de un token sin `email`, y por la API no se puede consultar un perfil sin email: la prueba solo afirma el 401
