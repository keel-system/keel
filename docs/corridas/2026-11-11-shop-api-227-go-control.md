# Corrida de control de la lectura acotada (DSL 2.27) — `shop-api` en keel-go

| Etiqueta | Valor |
|---|---|
| Diseño | `shop-api` v0.1.1 (DSL 2.27, relacional, 5 capas), con `OrderMain.reads` en `forbidden` y `User.reads` en `not-found` |
| Stack | `postgresql · keycloak` (sin broker, caché ni storage; telemetría `none`) |
| Generador | `keel-go@0.2.0` (`4da2c080` al refrescar con `build --refresh --prune`) |
| Diseño listo al generar | no, con --accept-unready (characterized, design-doc, gaps, structural, undecided) |
| Papel | control |
| Matriz final | **92/92 OK** a la primera (sin arbitrajes) |
| Huella del agente | 290 archivos registrados por `build`, 0 adoptados, **28 reescritos**, 0 borrados |
| Clasificación de la huella | 25 TODO · 0 consulta · 2 generador (`go.mod`, `deploy/Dockerfile`) · 0 diseño · 0 puerta |
| Huecos del diseño | 1, no reportado; el que escribió el agente es del generador |
| Huecos del generador | 2, arreglados (ver § Huecos del generador) |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\shop-227-go-postgre\services\shop-api-go`. Corrida de control del incremento 8 de
`PLAN-DSL-227-LECTURA-ACOTADA.md`, gemela de `2026-11-10-shop-api-227-spring-control.md` con keel-go.

## Lo que medía

Lo mismo que la corrida de keel-spring: las cargas acotadas, FL-ORD-005 (el listado sin los pedidos de otro), FL-ORD-009
(403) y FL-ACC-009 (404 `PROFILE_NOT_FOUND`). En verde.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- La matriz, contra `build/test-results/integration/junit.xml`: 191 casos (con subtests), 0 fallos, 92 `FL-*` distintos.
- La huella, contra una regeneración limpia con el generador de la corrida:
  - 25 reescritos partían de un TODO: los 19 handlers y los 6 `_behavior.go`. El pase de calidad quitó de los handlers
    las directivas `//lint:ignore U1000` que deja build en sus campos, porque staticcheck sigue limpio sin ellas. Es
    lo esperado: sirven mientras el handler está por escribir.
  - Sin consultas añadidas a los puertos: en keel-go las consultas de negocio van en los `<raíz>_queries.go` del agente,
    que build no registra.
  - `go.mod` y `deploy/Dockerfile` son el toolchain (hueco 1). `README.md` gana la mención del toolchain y una sección
    de despliegue.
- El agente escribió `internal/domain/ids.go` con su propio `NextLongID()` (hueco 2). Es suyo y build no lo registra.
- Clasificación a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Huecos del generador

1. **El toolchain con GO-2026-6859** (`net/http` de `go1.27.3`). Es el mismo que el de
   `2026-11-11-asset-vault-227-go-cognito-control.md`, y aquí el agente lo subió también en la imagen de
   `deploy/Dockerfile`. Arreglado allí: `GO_TOOLCHAIN = 'go1.27.4'`, que mueve `go.mod`, el Dockerfile y el README.
2. **`NextLongID()` no existía.** Las notas del constructor de `User`, `OrderMain` y `ProductInOrder` dicen
   `id = NextLongID()` (los ids `long` con `generated: true`). La proyección la declara como el gemelo de `LongIds.next()`
   de los otros tres, con la forma neutral de `keel-core/gen/ids.js` (41 bits de milisegundos desde 2020 y 12
   aleatorios), pero keel-go no la emitía. El agente escribió la suya: milisegundos desplazados 10 bits y un `+1` atómico
   dentro del proceso. Lo reportó como hueco del diseño (`design-gaps.yaml`, `unit: NextLongID`), pero no lo es: el
   diseño declara `generated: true`, y keel-core decide la forma.

   **Arreglado:** `src/scaffold/long-ids.js` emite `internal/domain/long_ids.go`, con cabecera de generado, cuando alguna
   entidad tiene un id `long` generado. Usa `crypto/rand`, porque la regla de idiomas prohíbe `math/rand` fuera de las
   pruebas. La red es `test/long-ids.test.js`: toda fixture que cita `NextLongID()` trae su definición y ninguna otra la
   emite, con las constantes de keel-core. Falsada: sin el emisor caen las dos pruebas. La forma, medida a mano con go1.27.4
   sobre shop-api: el id cae entre los milisegundos de antes y de después, por debajo de 2^53, y 2000 llamadas dan más de
   1000 valores distintos en los 12 bits aleatorios.

   Observación, no defecto: el agente quería además que el id fuera creciente dentro del proceso, para que las líneas de
   un carrito salgan en el orden de alta. Con la forma neutral, dos altas del mismo milisegundo pueden salir en otro
   orden, igual en los cuatro generadores. Ningún escenario lo pidió.

## designGaps

- `cart-line-sum-over-max` — `AddCount` rechaza con 400 (`ErrInvalidValue`) la suma que pasa del máximo de `count`, y no
  lo reporta (no reportado). En keel-dotnet la misma suma se acepta sin guarda: el hueco ya da dos servidores distintos
  para el mismo diseño. Cuarta corrida con este hueco.
