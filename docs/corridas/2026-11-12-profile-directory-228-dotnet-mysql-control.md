# Corrida de control del ciclo de vida del dato (DSL 2.28) — `profile-directory` en keel-dotnet con MySQL

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.1.0 (DSL 2.28, relacional, 5 capas), con el email `personal` y único, `deletion: logical`, `restorableFor` de 30 días y `retention` (`from: deleted`, `then: delete`) |
| Stack | `mysql · keycloak` (telemetría `none`) |
| Generador | `keel-dotnet@0.2.0` (`f3ff2a3f`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **24/24 OK** en la segunda puntuación, corregida por el propio pipeline (sin arbitrajes) |
| Huella del agente | 212 archivos registrados por `build`, 0 adoptados, **6 reescritos**, 0 borrados |
| Clasificación de la huella | 5 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (el informe dice «Ninguno» y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\cards-228-dotnet-mysql\services\profile-directory-dotnet`. Es la corrida de control del
incremento 7 de `PLAN-DSL-228-CICLO-DE-VIDA.md` con MySQL. Lleva el mismo diseño y el mismo generador que
`2026-11-12-profile-directory-228-dotnet-control.md`, y solo cambia el motor.

## Lo que medía: T2

Con MySQL, la unicidad entre fichas vivas no puede ser un índice parcial: es una **columna generada** al final del índice
único. El baseline que generó `dotnet ef` las trae las dos:

- `uk_contact_cards_natural_flag` y `uk_contact_cards_email_flag`, `tinyint` almacenadas, con `CASE WHEN deleted_at IS
  NULL THEN 1 END`;
- los índices `uk_contact_cards_natural (subject, …_flag)` y `uk_contact_cards_email (email, …_flag)`.

Una ficha borrada deja la columna a NULL y sale de la unicidad, porque MySQL no compara los NULL entre sí. FL-CRD-005 y
FL-CRD-006 (el `subject` y el email de una ficha borrada quedan libres) y sus pasos B (restaurar sobre ellos da 409) pasan
en verde sobre ese esquema. **T2 queda medido en una corrida**, además de en `db-check --database=mysql`.

El resto también en verde: el borrado lógico (FL-CRD-004), la ventana (FL-CRD-007) y la purga (FL-CRD-007-B).
`dotnet test` dio 100/100, y el baseline se verificó en vivo, con 27 elementos del esquema iguales en el modelo y en las
migraciones.

## FL-CRD-007: envejecer el borrado

Es el tercer tropiezo con el nombre de la tabla. La primera puntuación salió con código 2 y FL-CRD-007 omitido, porque
el Given usaba `contact_card`. `keel-dotnet-tests` lo corrigió. El SQL ya estaba en el dialecto de MySQL (`deleted_at -
INTERVAL 31 DAY`): el agente supo el motor, pero no la tabla.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe: 24 `FL-*` al 100 % y el código de salida 0.
- **Las columnas generadas**, en `Persistence/Migrations/<fecha>_Baseline.cs` y en `Rows/ContactCardRow.cs`.
- **La huella**: los mismos seis archivos que en la gemela de PostgreSQL. Son los cuatro handlers, `ContactCard.cs` y el
  README. La clasificación se toma de esa gemela, que sí se comparó con una regeneración limpia, porque el motor no cambia
  ningún archivo con TODO.

## Una observación del agente de código

`keel-dotnet-code` anota que la carrera de dos primeros guardados simultáneos del mismo titular depende de que la
constraint única de la clave natural se traduzca a `CARD_ALREADY_EXISTS` (`naturalKeyError`), y que ningún escenario la
ejerce. Es cierto, y por eso esa traducción no depende del agente: la genera `build`
(`keel-core/gen/constraint-errors.js`), y `db-check` la mide en los dos motores con el sujeto `cards-logical`. No es un
hueco.

## designGaps

Ninguno.
