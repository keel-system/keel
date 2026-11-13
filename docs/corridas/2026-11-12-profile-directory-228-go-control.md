# Corrida de control del ciclo de vida del dato (DSL 2.28) — `profile-directory` en keel-go

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.1.0 (DSL 2.28, relacional, 5 capas), con el email `personal` y único, `deletion: logical`, `restorableFor` de 30 días y `retention` (`from: deleted`, `then: delete`) |
| Stack | `postgresql · keycloak` (telemetría `none`) |
| Generador | `keel-go@0.2.0` (`f3ff2a3f`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **24/24 OK** en la segunda puntuación, corregida por el propio pipeline (sin arbitrajes) |
| Huella del agente | 186 archivos registrados por `build`, 0 adoptados, **6 reescritos**, 0 borrados |
| Clasificación de la huella | 5 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (el informe dice «Ninguno» y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\cards-228-go-postgre\services\profile-directory-go`. Es la corrida de control del incremento
7 de `PLAN-DSL-228-CICLO-DE-VIDA.md` en keel-go. Es la cuarta gemela del día: el mismo diseño y el mismo stack que las de
keel-spring, keel-nest y keel-dotnet.

## Lo que medía

Lo mismo que las gemelas: el borrado lógico y la lectura viva (FL-CRD-004), la unicidad entre fichas vivas (FL-CRD-005 y
FL-CRD-006), la ventana de restauración (FL-CRD-007) y la purga de la retención (FL-CRD-007-B). Todo en verde.

## FL-CRD-007: envejecer el borrado

Es el mismo tropiezo que en keel-dotnet. La primera puntuación salió con código 2: 22 OK, y FL-CRD-007 y 007-B
omitidos, porque el Given de `TestRestoreWindow` actualizaba la tabla `contact_card` y la real es `contact_cards`. El
agente de pruebas lo corrigió en `tests/integration/card_holder_test.go`, y la segunda puntuación dio 24/24. No es un
hueco del generador: el nombre está en lo que emite `build`, en las migraciones y en los repositorios.

**De cuatro corridas, dos se equivocaron al nombrar la tabla** con el SQL a mano de este Given. El error fue el mismo en
las dos: el singular de la entidad, que es lo que un agente deduce si no lee el esquema. Es la señal más fuerte del
incremento a favor del helper `ageDeletion` en los arneses, que tomaría la tabla y la columna del modelo.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe: 24 `FL-*` al 100 % y el código de salida 0.
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en `D:\keel-tmp`:
  - Los cuatro handlers, con 2 TODO cada uno, y `contact_card_behavior.go`, cuyo TODO del constructor se convirtió en
    `NewContactCard(...)` más `Replace(...)`. Este último es la regla del reemplazo entero de `saveMyCard`.
  - `README.md` solo gana la sección «Despliegue en producción», que no es una decisión.
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Contra las gemelas

| | keel-spring | keel-nest | keel-dotnet | keel-go |
|---|---|---|---|---|
| Matriz | 24/24 | 24/24 | 24/24 (segunda) | 24/24 (segunda) |
| Reescritos | 5 | 6 | 6 | 6 |
| FL-CRD-007 | tabla bien | descubierta por la columna | `contact_card`, corregida | `contact_card`, corregida |
| Huecos | 0 | 0 | 0 | 0 |

## designGaps

Ninguno.
