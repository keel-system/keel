# Corrida de control de la guarda del agregado (DSL 2.31) en MySQL — `shop-api` en keel-nest

| Etiqueta | Valor |
|---|---|
| Diseño | `shop-api` v0.1.1 (DSL 2.31, relacional, 5 capas), con el `exactlyOne: [cart, order]` de `ProductInOrder`, la cota de `count` como invariante de la línea y U6 (`createProduct` con `input.fields`, `ProductInfo.productStock` sin máximo) |
| Stack | `mysql · keycloak` (sin broker, caché ni storage; telemetría `none`) |
| Generador | `keel-nest@0.2.0` (`ddcd183f` al generar) |
| Diseño listo al generar | no, con --accept-unready (characterized, design-doc, gaps, review, structural) |
| Papel | control |
| Matriz final | **92/92 OK** (primera pasada 84 OK · 8 FALLO, todos `culprit: code` y por la escala de `productPrice`) |
| Huella del agente | 306 archivos registrados por `build`, 0 adoptados, **30 reescritos**, 0 borrados |
| Clasificación de la huella | 25 TODO · 4 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`, y el informe dice «ninguno») |
| Huecos del generador | 1, el de la escala (ver § Huecos del generador) |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\shop-231-nest-mysql\services\shop-api-nest`. Quinta y última corrida de control del
incremento A9 de `PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md`, gemela de `2026-11-16-shop-api-231-nest-control.md`
cambiando solo el motor. Es la primera corrida de control de keel-nest sobre MySQL.

## Lo que medía

- **`cart-line-sum-over-max` desaparece**, también en MySQL. `ProductInOrder.addCount` suma sin comprobar y ningún
  handler repite la cota. No sale como `designGap`.
- **Lo que escribe `build` no se toca.** El `ensureInvariants()` de las cinco raíces es byte a byte el que emite `build`,
  y los dos adaptadores reescritos siguen llamándolo en su `save`.
- **La huella, idéntica a la de PostgreSQL**: 30 reescritos (25 con TODO, las mismas 4 consultas por lote y el README).
  El motor no le pidió al agente nada distinto.
- **El baseline de migraciones**, probado en vivo contra MySQL por el agente de calidad (`baselineTested: OK`).

## Lo que se contrastó

- La matriz es la de `infra/score-scenarios.sh` (código 0), no hay `design-gaps.yaml`, y la huella la imprime
  `corrida-metrics.js footprint`.
- La guarda, con el mismo script que las otras cuatro corridas: 5 iguales, 0 distintas, 0 ausentes.

## Huecos del generador

- **La escala de un `decimal` de entrada con `scalePolicy: reject`**, el de las corridas de keel-nest y keel-dotnet sobre
  PostgreSQL: 8 fallos en la primera pasada, que el agente arregló escalando `productPrice` en `ProductInfo`. El motor no
  cambia nada: el `save` de keel-nest devuelve la entidad en memoria, no lo que guardó la columna `decimal(19,2)`.

## designGaps

Ninguno: no hay `design-gaps.yaml` y el informe dice «ninguno».
