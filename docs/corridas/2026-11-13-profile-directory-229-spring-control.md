# Corrida de control del historial de cambios (DSL 2.29) — `profile-directory` en keel-spring

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.2.0 (DSL 2.29, relacional, 5 capas), con `audit.history: [ContactCard]` y la query `getMyCardHistory` (paginada, filtros `field`/`from`/`to`), sobre el ciclo de vida de la v1.1.0 (borrado lógico, restauración en 30 días y purga) |
| Stack | `postgresql · keycloak` (telemetría `none`) |
| Generador | `keel-spring@0.3.0` (`9be8b08d`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **37/37 OK** a la primera (sin arbitrajes) |
| Huella del agente | 222 archivos registrados por `build`, 0 adoptados, **6 reescritos**, 0 borrados |
| Clasificación de la huella | 6 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (el informe dice «ninguno confirmado» y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\cards-229-spring-postgre\services\profile-directory-spring`. Es la primera de las cinco
corridas de control del incremento 7 de `PLAN-DSL-229-HISTORIAL.md`. El pipeline tardó unos diez minutos desde `build`.

## Lo que medía

- **Una entrada por escritura confirmada** (FL-CRD-008): el alta con sus tres campos, un guardado igual sin entrada, el
  cambio de correo con ese campo y solo ese, el 409 sin entrada y la página de una en una. En verde.
- **Los filtros** (FL-CRD-009): por campo, por fechas con los extremos incluidos y combinados. En verde. Era el riesgo
  del arreglo del incremento 6: `?to=<t2>` con el `at` leído de la API tiene que devolver la entrada de `<t2>`, y lo
  devuelve. Antes de truncar la hora al milisegundo, este paso habría salido rojo.
- **El historial sigue a la ficha viva** (FL-CRD-010): 404 con la ficha borrada, `restored` y `deleted` tras restaurar
  sin perder el `created`, y el historial ajeno inalcanzable también con `?callerSubject=` en la query. En verde.
- **La purga se lleva el historial** (FL-CRD-007-C). En verde (ver abajo).
- **El 401 y el 403 de la query nueva** (FL-CRD-003 y 003-D), y todo lo de la v1.1.0 (FL-CRD-001 a 007-B). En verde.

## Los dos riesgos anotados

- **`ageDeletion`, estrenado.** Es la primera corrida desde que el helper entró en el arnés de los cuatro (cierre de
  la 2.28). El agente lo usó en el Given de FL-CRD-007: `ageDeletion("ContactCard", cardAna, 31)`, con el nombre de la
  entidad y el id. Ya no escribió el SQL a mano, como en la 2.28.
- **FL-CRD-007-C: el historial de la ficha purgada, leído en la base.** El agente lo comprobó con el `db(...)` genérico
  del arnés:
  `SELECT count(*) FROM change_history WHERE root_type = 'ContactCard' AND root_id = '<card-ana>'`.
  La tabla, las columnas y el valor de `root_type` son los que nombra la convención «historial de una ficha purgada»,
  y acertó a la primera. Una corrida no basta para decidir el helper `historyOf`: hay que ver si las otras cuatro
  también aciertan. El coste de no tenerlo se ve en la invocación, que repite entera la línea de `psql` con su
  contraseña:
  `db("env", "PGPASSWORD=changeme", "psql", "-h", "db", …)`.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe del pipeline: 37 `FL-*` al 100 %, `score-scenarios.sh` con código 0.
- **Las pruebas del agente**, en `src/integrationTest/.../flows/`. Diez clases de flujo más `CardFlowSupport.java`.
  - Las precondiciones de FL-CRD-009 van en `awaitPreconditions`, que corre una vez por clase, así que `<t1>`…`<t3>`
    son los mismos en sus cuatro pasos.
  - Las tres escrituras van separadas por una pausa de 25 ms, que cumple la convención de los 10 ms.
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en
  `D:\keel-tmp\cards-229-spring-regen`. Los seis reescritos partían de un TODO:
  - Los cinco handlers.
    - `GetMyCardHistory` hace lo que dice su nota: `historyOf(<id>, new HistoryFilter(...), pageable)` y
      `PagedResponse.from`.
    - Antes carga la ficha con `findBySubject`, porque el puerto lee el historial por id. Es una carga de más (`historyOf` vuelve a
      cargarla como su ficha), pero no cambia el resultado.
  - `ContactCard.java`: el factory `create(...)` y `replaceWith(...)`, como en la 2.28.
- **Lo que FL-CRD-008-D no discrimina.** `SaveMyCardCommandHandler` comprueba el correo con `findByEmail` antes de
  guardar, así que el 409 sale sin llegar a escribir. El escenario pasa igual que si la constraint hubiera abortado una
  transacción con la entrada ya escrita, y en esta corrida el camino del rollback no se pisó. Ese camino lo mide HI-1 en
  `history-check` (`hi-outside-tx`), no la corrida.
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Pendiente

- `baselineTested: PENDING`: la prueba del baseline `V1__baseline_schema.sql` sobre una base sin esquema la hace el
  diseñador. Es lo mismo que en todas las corridas de keel-spring.
- HI-11 (ningún valor personal del historial en logs ni spans) no se mide aquí: esta corrida va sin telemetría.

## designGaps

Ninguno.
