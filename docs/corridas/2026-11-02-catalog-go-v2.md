# Corrida `catalog` — keel-go, repetida con el generador corregido (incremento 13i)

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog` v1.0.0 (DSL 2.23, relacional, 9 capas), los mismos `specs/` que `2026-11-02-catalog-go.md` |
| Stack | `postgresql · kafka · keycloak · redis · minio` |
| Generador | `keel-go@0.1.0` (`d0648c99`, sin el arreglo de `NewPage` de esta corrida) |
| Diseño listo al generar | sí |
| Matriz final | **56/56 OK** (`score-scenarios.sh` con código 0; 108 casos en 429 s; una ronda de arbitraje: FL-PRD-003-D, ver § El arbitraje) |
| Huella del agente | 347 archivos registrados por `build`, 0 adoptados, **23 reescritos**, 0 borrados |
| Clasificación de la huella | 21 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (el árbitro escribió uno, falso, y se borró: ver § El arbitraje) |
| Huecos del generador | 1 (ver § El arbitraje) |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo |

Repite `2026-11-02-catalog-go.md` para ver qué hace el agente con los arreglos de aquella: `afterCommit` y `fileStorage` en
`removeProductImage`, la sesión de Kafka y `useCaseLogger`. Workspace: `spring-live-test/corrida-catalog-go-1102`.

La clasificación la hizo quien arregló el generador, y no un agente de contexto limpio: es una corrida de control y no cuenta
para H1.

## Lo que se vino a medir

| Qué | Corrida anterior | Esta |
|---|---|---|
| Borrado del binario en `removeProductImage` | no se hacía, por el hueco del generador | `fileStorage.Delete` dentro de `afterCommit`, antes del `Save` |
| `FL-CMP-001-B` (el primer consumo tras un reinicio con Kafka) | 43 s, con la espera subida a 70 s | **7,6 s**, con una espera de 30 s |
| Duración de la suite | 991 s | **429 s** |
| Log de un handler | `slog` global, sin JSON ni correlación | `useCaseLogger` en los dos handlers que registran |

Los tiempos son compatibles con el arreglo de la sesión, pero no lo demuestran: las pruebas las escribió otra pasada del agente y
la suite no es la misma. Lo que lo mide es `FL-BRK-001-J` de `broker-check`, con su sabotaje.

**Lo que sigue sin medir: que el binario desaparezca de MinIO.** Se comprobó leyendo el handler. Ningún escenario afirma el borrado,
y añadirlo es decisión de diseño. La prueba emitida `after_commit_test.go` mide cuándo corre un efecto, no este en concreto.

## El arbitraje

La primera puntuación dio 55/56: falló `FL-PRD-003-D`. El árbitro lo atribuyó al diseño, escribió `design-gaps.yaml` con una
«contradicción» y paró, proponiendo cambiar el Then. **Se equivocaba**, y por culpa del generador:

- El Then fija 0/0 de forma expresa («la forma de la página vacía del contrato, también fuera de rango»), lo mismo que
  `docs/dsl/api.md`. La corrida anterior y la de keel-dotnet pasaron la misma aserción.
- Ese texto de `api.md` no llegaba al proyecto generado: ni `wire-contract.md` ni las convenciones lo recogían, y `NewPage`, generado,
  devolvía los totales reales. Que la corrida anterior acertara dependió de que el agente lo dedujera del Then.

Se contestó que era `culprit: code`, y el agente lo arregló en su handler sin tocar `specs/` ni la prueba. Arreglo en el generador:
`NewPage` da la forma de la página vacía, con la prueba emitida `page_shape_test.go` y el sabotaje `empty-page`, y la regla está en
`wire-contract.md` y en las convenciones.

**Sin arreglar en los otros tres:** keel-nest calcula los totales en sus repositorios y keel-spring los toma de la `Page` de Spring Data,
así que dependen también del agente. keel-dotnet no se ha mirado. La regla de `wire-contract.md` ya les llega.

## Lo que dijo el informe, contrastado

Coincide con la huella y con el JUnit (56 ids hoja de `specs/validation-scenarios.md`, 0 fallos). Deja dos avisos sin registrar como hueco:

- `version` suma 1 también en `ConfirmWithdrawalRecorded`: no se afirma en ningún escenario, y el bloqueo optimista no depende de ello.
- Dos `fmt.Errorf` sin centinela en `create_product_command_handler.go`, en la rama de repetición idempotente.

## designGaps
