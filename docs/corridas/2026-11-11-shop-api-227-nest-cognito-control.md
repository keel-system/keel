# Corrida de control de la lectura acotada (DSL 2.27) con Cognito — `shop-api` en keel-nest

| Etiqueta | Valor |
|---|---|
| Diseño | `shop-api` v0.1.1 (DSL 2.27, relacional, 5 capas), con `OrderMain.reads` en `forbidden` y `User.reads` en `not-found` |
| Stack | `postgresql · cognito` (sin broker, caché ni storage; telemetría `none`; Cognito es el emulador del docker-compose) |
| Generador | `keel-nest@0.2.0` (`51878aab` al generar) |
| Diseño listo al generar | no, con --accept-unready (characterized, design-doc, gaps, structural, undecided) |
| Papel | control |
| Matriz final | **92/92 OK** (primera pasada 90 OK · 2 FALLO, FL-SEL-002 y FL-SEL-006, `culprit: code`) |
| Huella del agente | 301 archivos registrados por `build`, 0 adoptados, **30 reescritos**, 0 borrados |
| Clasificación de la huella | 25 TODO · 4 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 1 (en `design-gaps.yaml`, sobre dos operaciones) |
| Huecos del generador | 1, menor (ver § Huecos del generador) |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\shop-227-nest-postgre-cognito\services\shop-api-nest`. Corrida de control del incremento 8
de `PLAN-DSL-227-LECTURA-ACOTADA.md`, cruzada: shop-api con Cognito en keel-nest. Su gemela con Keycloak en keel-nest
(`shop-227-nest-postgre`) está pendiente, y la referencia hoy es `2026-11-10-shop-api-227-spring-control.md`.

## Lo que medía

Lo mismo que la corrida de keel-spring (las cargas acotadas, FL-ORD-005, FL-ORD-009 y FL-ACC-009), más lo que solo existe
con Cognito:

- **Las personas por el emulador, con su email (D5).** Todos los flujos piden su llamante con
  `tokenAs(sub, { email }, role)`, y en Cognito ese token sale de los mappings de persona del emulador (inc. 4.3 de
  `PLAN-PROVEEDOR-IDENTIDAD.md`), no de la API de administración de Keycloak. El email es la identidad del llamante
  (`callerIdentity`) en todas las operaciones, y llega por ahí, igual que el rol
  de administrador de las operaciones de catálogo. Los 92 en verde.
- **El token sin email**: FL-ACC-016 (401), en verde con el emulador.

En local el email viaja en el access token porque el emulador lo pone. Con Cognito real hace falta configurarlo (aviso
`requires-configuration` de `build` y `docs/keel/identity-contract.md`), y eso no lo prueba ninguna corrida.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- La matriz, contra `build/test-results/integration/junit.xml`: 97 casos, 0 fallos, 92 `FL-*` distintos.
- La huella, contra una regeneración limpia con el mismo stack y los mismos `specs/`:
  - 25 de los reescritos partían de un TODO: los 19 handlers y los 6 agregados.
  - `product-info.ts` incluye el arreglo del ciclo de `code`: `productPrice` a escala 2 al crear y editar, que es lo que
    afirman FL-SEL-002 y -006.
  - Los otros 4 son las mismas consultas por lote que añadió keel-spring: `findAllByIds` en el puerto y el adaptador de
    `ProductInfo`, y `findAllByOrderIds` en los de `ProductInOrder`. Las 4 cuentan como consulta.
  - `README.md` gana una sección «Despliegue en producción», que no es una decisión.
- El agente añadió `src/migrations/1000000000000-baseline-schema.ts`, verificado con `infra/verify-baseline.sh`. Es suyo,
  y no está en la huella porque build no lo registra.
- Clasificación a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Huecos del generador

1. **El reset de prueba antes del primer arranque.** El paso 7 del agente `keel-nest-infra` manda ejecutar
   `infra/reset-db.sh` una vez, «porque un reset que falla ahora fallaría en todos». En `local` el esquema lo crea la app
   al arrancar, así que con la base vacía el vaciado pasa, pero la carga de `infra/fixtures.sql` falla
   (`relation "users" does not exist`). El agente lo reportó KO, el orquestador lo entendió como esperado y la corrida no
   se desvió. Menor: la instrucción debería decir que con `fixtures.sql` el reset solo vale después del primer arranque,
   o el reset debería distinguir el esquema que todavía no existe. Las corridas sin `fixtures.yaml` no lo ven.

## designGaps

- `cart-line-sum-over-max` — `addToCart` y `mergeCart` suman la cantidad pedida a la de la línea, y el diseño no dice qué
  error sale si la suma supera el máximo de `count` (1.000.000). Segunda corrida con este hueco, y la primera que lo
  escribe en `design-gaps.yaml`, como dos entradas, una por operación.
