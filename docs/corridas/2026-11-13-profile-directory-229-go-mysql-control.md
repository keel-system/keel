# Corrida de control del historial de cambios (DSL 2.29) — `profile-directory` en keel-go sobre MySQL

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.2.0 (DSL 2.29, relacional, 5 capas), con `audit.history: [ContactCard]` y la query `getMyCardHistory` (paginada, filtros `field`/`from`/`to`), sobre el ciclo de vida de la v1.1.0 (borrado lógico, restauración en 30 días y purga) |
| Stack | `mysql · keycloak` (telemetría `none`) |
| Generador | `keel-go@0.2.0` (`9be8b08d`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **37/37 OK** a la primera (sin arbitrajes) |
| Huella del agente | 194 archivos registrados por `build`, 0 adoptados, **7 reescritos**, 0 borrados |
| Clasificación de la huella | 6 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta (y el README, ver abajo) |
| Huecos del diseño | 0 (el informe dice que no hay y no escribe `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\cards-229-go-mysql\services\profile-directory-go`. Es la quinta y última corrida de
control del incremento 7 de `PLAN-DSL-229-HISTORIAL.md`: la de MySQL (T2), gemela de
`2026-11-13-profile-directory-229-go-control.md` con el motor cambiado. En la 2.28 el MySQL fue de keel-dotnet; aquí
es de keel-go, que escribe su propio SQL contra las dos tablas del historial. Calidad limpia según el informe: `gofmt`,
`go vet`, `staticcheck`, `go mod tidy -diff`, `govulncheck` y `go test ./...`.

## Lo que medía: el historial sobre MySQL

Todo en verde, y en particular lo que solo se ve en este motor:

- **La hora de la entrada y los filtros por fecha (FL-CRD-009-C).** La columna `at` es `datetime(6)`, y la sentencia
  del incremento 6 la escribe con `utc_timestamp(3)`, así que queda `.xxx000`. `to=<t2>`, con el `at` leído de la API,
  devuelve las entradas de `<t2>` y `<t1>`, y `from=<t2>&to=<t2>` solo la de `<t2>`. Es el control del arreglo del
  incremento 6 en el motor donde el redondeo podría haber jugado en contra, y sale como en PostgreSQL.
- **El filtro por campo (FL-CRD-009-B)**, que es una igualdad sobre `change_history_field.path` o `.top`, sin operador
  JSON (T2). En verde.
- **`change_kind` en vez de `change`**, la columna que evita la palabra reservada de MySQL: la escritura y la lectura
  pasan.
- El resto, como en las gemelas: FL-CRD-008, FL-CRD-010, FL-CRD-007-C, el 401/403 de la query nueva y lo de la v1.1.0.

## Los dos riesgos anotados

- **`ageDeletion`**: `s.AgeDeletion("ContactCard", cardAna, 31)` en `card_deletion_test.go`, sobre MySQL (la rama
  `DATE_SUB` de la sentencia neutral). Lo usaron cinco de cinco.
- **FL-CRD-007-C**: lo resuelve con `s.Db(...)` y la sentencia sola,
  `SELECT COUNT(*) FROM change_history WHERE root_type = 'ContactCard' AND root_id = '<card-ana>'`, a la primera.
  **Cinco de cinco aciertan sin el helper `historyOf`.** La convención con la tabla y las columnas escritas basta, y el
  helper no entra (ver el cierre en el plan).

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe: las 37 filas en `OK`, con el código de salida 0.
- **Las pruebas del agente**, en `tests/integration/`:
  - Entre escrituras hay una pausa de 20 ms.
  - Los instantes van con `url.QueryEscape`.
  - FL-CRD-010-C prueba también `callerSubject=sub-ana-001`.
  - El 409 de FL-CRD-008-D sale, como en la gemela, de la comprobación con `FindByEmail` antes de guardar.
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en
  `D:\keel-tmp\cards-229-gomysql-regen` (ya borrada):
  - Los cinco handlers partían de 2 TODO cada uno, y `contact_card_behavior.go` de 1 (`NewContactCard` y `Replace`).
  - `README.md` gana la sección «Despliegue en producción».
- **`go.mod`.** El informe avisa de que no pudo comprobar que `go mod tidy` no moviera requisitos directos, porque el
  proyecto no tenía git al empezar. Contra la regeneración limpia: solo cambian dependencias `// indirect`, y ninguna
  directa se movió.
- **Una guarda de más, en las dos corridas de keel-go.** `GetMyCardHistoryQueryHandler` convierte `page.Items == nil`
  en `[]` antes de construir `PagedResponse`. No hace falta: `writeJSON` serializa con `wire.Marshal`, sobre
  `encoding/json/v2`, que escribe un slice nil como `[]`. Además, `PagedResponse` lo documenta («Items sin elementos
  viaja como [], nunca como null») y el generador emite una prueba de `NewPage(nil, …)`. No es un hueco: es una
  defensa redundante que ninguna corrida de los otros tres generadores escribe.
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## La nota del realm

El informe no la menciona. Es el hueco de documentación de la corrida de keel-nest, común a los cuatro generadores y
anotado en el plan; en la fila de huecos de esta corrida no cuenta.

## Las cinco corridas

| | spring | nest | dotnet | go | go · MySQL |
|---|---|---|---|---|---|
| Matriz | 37/37 | 37/37 | 37/37 | 37/37 | 37/37 |
| Reescritos | 6 | 7 | 7 | 7 | 7 |
| `ageDeletion` | sí | sí | sí | sí | sí |
| FL-CRD-007-C sin `historyOf` | sí | sí | sí | sí | sí |
| FL-CRD-008-D con rollback de la entrada | no | no | **sí** | no | no |
| Huecos | 0 | 1 de documentación, común a los cuatro | 0 | 0 | 0 |

## designGaps

Ninguno.
