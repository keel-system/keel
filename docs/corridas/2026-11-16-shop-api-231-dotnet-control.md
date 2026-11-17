# Corrida de control de la guarda del agregado (DSL 2.31) — `shop-api` en keel-dotnet

| Etiqueta | Valor |
|---|---|
| Diseño | `shop-api` v0.1.1 (DSL 2.31, relacional, 5 capas), con el `exactlyOne: [cart, order]` de `ProductInOrder`, la cota de `count` como invariante de la línea y U6 (`createProduct` con `input.fields`, `ProductInfo.productStock` sin máximo) |
| Stack | `postgresql · keycloak` (sin broker, caché ni storage; telemetría `none`) |
| Generador | `keel-dotnet@0.2.0` (`ddcd183f` al generar) |
| Diseño listo al generar | no, con --accept-unready (characterized, design-doc, gaps, review, structural) |
| Papel | control |
| Matriz final | **92/92 OK** (el informe no da la primera pasada; pruebas unitarias 155/155) |
| Huella del agente | 337 archivos registrados por `build`, 0 adoptados, **26 reescritos**, 0 borrados |
| Clasificación de la huella | 25 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`, y el informe dice «ninguno») |
| Huecos del generador | 1, el de la escala de la corrida de keel-nest (ver § Huecos del generador) |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\shop-231-dotnet-postgre\services\shop-api-dotnet`. Tercera de las cinco corridas de
control del incremento A9 de `PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md`. La referencia es
`2026-11-11-shop-api-227-dotnet-cognito-control.md` (mismo generador, con Cognito).

## Lo que medía

- **`cart-line-sum-over-max` desaparece.** `ProductInOrder.AddQuantity` es `Count += quantity`, sin comprobar la cota, y
  ningún handler de `application` la repite ni nombra 1.000.000. No sale como `designGap`; en la 2.27 este generador
  lo reportó en `design-gaps.yaml`.
- **Lo que escribe `build` no se toca.** El `EnsureInvariants()` de las cinco raíces es byte a byte el que emite `build`
  hoy, y ningún adaptador está entre los reescritos.
- **La huella baja de 28 a 26 reescritos**: 25 partían de un TODO (19 handlers y 6 agregados) y el `README.md` gana una
  sección que no es una decisión. Las dos consultas de la 2.27 no vuelven a salir.

## Lo que se contrastó

- La matriz es la de `infra/score-scenarios.sh` (código 0), no hay `design-gaps.yaml`, y la huella la imprime
  `corrida-metrics.js footprint`.
- La guarda, con el mismo script que las corridas de keel-spring y keel-nest: 5 iguales, 0 distintas, 0 ausentes.
- La clasificación, comparando cada reescrito con lo que emite `planService` sobre el snapshot. El script cuenta el
  README entre los de TODO porque su texto nombra la palabra; no es un hueco que rellenar.

## Huecos del generador

- **La escala de un `decimal` de entrada con `scalePolicy: reject`** (el de `2026-11-16-shop-api-231-nest-control.md`).
  El agente escribió `Decimals.SetScale(productPrice, 2)` en `ProductInfo` al crear y al editar: lo que `build` no hace
  con `reject`. En la 2.27 esta misma generación falló FL-SEL-002 y FL-SEL-006 en la primera pasada por la misma causa.
  Ya son keel-nest y keel-dotnet; keel-spring pasa sin ese arreglo.

## designGaps

Ninguno: no hay `design-gaps.yaml` y el informe dice «ninguno».
