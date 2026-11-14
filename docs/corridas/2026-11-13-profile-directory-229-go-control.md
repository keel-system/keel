# Corrida de control del historial de cambios (DSL 2.29) — `profile-directory` en keel-go

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.2.0 (DSL 2.29, relacional, 5 capas), con `audit.history: [ContactCard]` y la query `getMyCardHistory` (paginada, filtros `field`/`from`/`to`), sobre el ciclo de vida de la v1.1.0 (borrado lógico, restauración en 30 días y purga) |
| Stack | `postgresql · keycloak` (telemetría `none`) |
| Generador | `keel-go@0.2.0` (`9be8b08d`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **37/37 OK** a la primera (sin arbitrajes) |
| Huella del agente | 194 archivos registrados por `build`, 0 adoptados, **7 reescritos**, 0 borrados |
| Clasificación de la huella | 6 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta (y el README, ver abajo) |
| Huecos del diseño | 0 (el informe dice «ninguno» y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\cards-229-go-postgre\services\profile-directory-go`. Es la cuarta de las cinco corridas
de control del incremento 7 de `PLAN-DSL-229-HISTORIAL.md`, gemela de las de keel-spring, keel-nest y keel-dotnet: el
mismo diseño y el mismo stack. El pipeline tardó unos sesenta minutos desde `build`; la gemela de keel-spring, unos
diez.

## Lo que medía

Lo mismo que las gemelas, todo en verde:

- una entrada por escritura confirmada (FL-CRD-008);
- los filtros por campo y por fechas, con el `at` leído como extremo (FL-CRD-009);
- el historial que sigue a la ficha viva (FL-CRD-010);
- la purga que se lo lleva (FL-CRD-007-C);
- el 401/403 de la query nueva (FL-CRD-003);
- todo lo de la v1.1.0.

## Los dos riesgos anotados

- **`ageDeletion`**: `s.AgeDeletion("ContactCard", cardAna, 31)` en `card_retention_test.go`. Lo usaron cuatro de
  cuatro.
- **FL-CRD-007-C**: lo resuelve con el `s.Db(...)` del arnés y la sentencia sola,
  `SELECT count(*) FROM change_history WHERE root_type = 'ContactCard' AND root_id = '<card-ana>'`, y toma la última
  línea de la salida. La tabla y las columnas son las de la convención, a la primera. Van cuatro de cinco que aciertan
  sin el helper `historyOf`.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe: 37 `FL-*` al 100 %, con el código de salida 0.
- **Las pruebas del agente**, en `tests/integration/`: cuatro archivos de flujo (`card_basic`, `card_deletion`,
  `card_history`, `card_retention`) y `card_helpers_test.go`.
  - Entre escrituras hay una pausa de 25 ms.
  - FL-CRD-010-C prueba también `?callerSubject=sub-ana-001`.
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en
  `D:\keel-tmp\cards-229-go-regen` (ya borrada):
  - Los cinco handlers partían de 2 TODO cada uno, y `contact_card_behavior.go` de 1: el agente escribió
    `NewContactCard(...)` (id con `uuid.NewV7()`) y `Replace(...)`.
  - `GetMyCardHistory` carga la ficha con `FindBySubject` y llama a
    `HistoryOf(ctx, card.ID(), domain.HistoryFilter{...}, pageable)`, como las gemelas.
  - `README.md` solo gana la sección «Despliegue en producción».
  - `go.mod` cambia en lo que añadió `go mod tidy` (el paso que pide `build`). Son todo dependencias `// indirect`, y
    ninguna directa se movió.
- **FL-CRD-008-D**, como en keel-spring y keel-nest: `save_my_card_command_handler.go` comprueba el correo con
  `FindByEmail` antes de guardar, así que el 409 sale sin escribir. De las cuatro corridas sobre PostgreSQL, solo la de
  keel-dotnet pisó el rollback con la entrada ya escrita. En keel-go ese camino lo mide `db-check` (`hi-outside-tx`).
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## La nota del realm

El informe no la menciona. Aun así, el README emitido no nombra `init-keycloak.sh`: es el hueco de documentación que
registró la corrida de keel-nest, común a los cuatro generadores y anotado en el plan. En la fila de huecos de esta
corrida no cuenta.

## Pendiente

- El informe no dice si el baseline de goose se probó sobre una base sin esquema.

## Contra las gemelas

| | keel-spring | keel-nest | keel-dotnet | keel-go |
|---|---|---|---|---|
| Matriz | 37/37 | 37/37 | 37/37 | 37/37 |
| Reescritos | 6 (todos TODO) | 7 (6 TODO y el README) | 7 (6 TODO y el README) | 7 (6 TODO y el README) |
| FL-CRD-008-D | 409 antes de escribir | 409 antes de escribir | 409 de la constraint, con rollback | 409 antes de escribir |
| FL-CRD-007-C | `db(...)` con la línea de `psql` | `db(...)` con la sentencia | `Db(...)` con la sentencia | `s.Db(...)` con la sentencia |

## designGaps

Ninguno.
