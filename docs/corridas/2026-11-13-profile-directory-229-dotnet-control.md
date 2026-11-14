# Corrida de control del historial de cambios (DSL 2.29) — `profile-directory` en keel-dotnet

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.2.0 (DSL 2.29, relacional, 5 capas), con `audit.history: [ContactCard]` y la query `getMyCardHistory` (paginada, filtros `field`/`from`/`to`), sobre el ciclo de vida de la v1.1.0 (borrado lógico, restauración en 30 días y purga) |
| Stack | `postgresql · keycloak` (telemetría `none`) |
| Generador | `keel-dotnet@0.2.0` (`9be8b08d`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **37/37 OK** a la primera (sin arbitrajes); la no-regresión del agente de calidad dio la misma línea |
| Huella del agente | 223 archivos registrados por `build`, 0 adoptados, **7 reescritos**, 0 borrados |
| Clasificación de la huella | 6 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta (y el README, ver abajo) |
| Huecos del diseño | 0 (el informe no trae ninguno y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\cards-229-dotnet-postgre\services\profile-directory-dotnet`. Es la tercera de las cinco
corridas de control del incremento 7 de `PLAN-DSL-229-HISTORIAL.md`, gemela de las de keel-spring y keel-nest: el
mismo diseño y el mismo stack. Pruebas unitarias 119/119 y baseline de migraciones verificado en vivo
(`baselineTested: OK`).

## Lo que medía

Lo mismo que las gemelas, todo en verde:

- una entrada por escritura confirmada (FL-CRD-008);
- los filtros por campo y por fechas, con el `at` leído como extremo (FL-CRD-009);
- el historial que sigue a la ficha viva (FL-CRD-010);
- la purga que se lo lleva (FL-CRD-007-C);
- el 401/403 de la query nueva (FL-CRD-003);
- todo lo de la v1.1.0.

## Lo que esta corrida pisa y las gemelas no: el rollback de FL-CRD-008-D

En keel-spring y keel-nest el agente comprobaba el correo con `findByEmail` antes de guardar, y el 409 salía sin
escribir nada. Aquí `SaveMyCardCommandHandler` no comprueba nada: crea o reemplaza y llama a `Save`. El 409
`EMAIL_ALREADY_EXISTS` sale de la constraint única, que el borde traduce. En esa misma transacción el adaptador ya había
escrito la entrada del historial, y el escenario afirma que la página sigue con sus dos entradas: la entrada se fue con
el rollback. Es HI-1 ejecutado por una corrida, no solo por `db-check`.

Las dos formas son válidas para el diseño: la rule de `saveMyCard` no fija dónde se detecta el choque. Que el escenario
pase con las dos es lo que hace de FL-CRD-008-D un control del historial y no del handler.

## Los dos riesgos anotados

- **`ageDeletion`**: `AgeDeletion("ContactCard", cardAna, 31)` en `CardRetentionFlow.cs`. Lo usaron tres de tres.
- **FL-CRD-007-C**: lo resuelve con el `Db(...)` del arnés y la sentencia sola,
  `SELECT count(*) FROM change_history WHERE root_type = 'ContactCard' AND root_id = '<card-ana>'`. La tabla y las
  columnas son las de la convención, a la primera. El `root_id` es el texto del `Guid` en minúsculas, el mismo que
  guarda el adaptador. Van tres de cinco que aciertan sin el helper `historyOf`.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe: 37 `FL-*` al 100 %, con el código de salida 0.
- **Las pruebas del agente**, en `tests/ProfileDirectory.IntegrationTests/`. Diez clases de flujo y su base
  `CardFlowTest.cs`.
  - Entre escrituras hay una pausa de 30 ms.
  - Los instantes van escapados en la query (`Q(t2)`).
  - FL-CRD-010-C prueba también `?callerSubject=sub-ana-001`.
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en
  `D:\keel-tmp\cards-229-dotnet-regen` (ya borrada):
  - Los cinco handlers partían de 2 TODO cada uno, y `ContactCard.cs` de 1: el agente escribió `Create(...)` y
    `Replace(...)`.
  - `GetMyCardHistoryQueryHandler` carga la ficha con `FindBySubject` y llama a
    `HistoryOf(card.Id, new HistoryFilter(...), pageable)`, como las gemelas.
  - El id de la ficha nace con `Guid.CreateVersion7()`. Las entradas del historial usan el `HistorySupport.NextId()`
    monótono que emite el generador, así que esto no le afecta.
  - `README.md` cierra su TODO con la sección «Despliegue en producción», como en las otras corridas de keel-dotnet.
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## La nota del realm

El informe no la menciona. Aun así, el README emitido tampoco nombra `init-keycloak.sh`: es el hueco de documentación
que registró la corrida de keel-nest, común a los cuatro generadores y anotado en el plan. En la fila de huecos de esta
corrida no cuenta, para no contarlo dos veces.

## Contra las gemelas

| | keel-spring | keel-nest | keel-dotnet |
|---|---|---|---|
| Matriz | 37/37 | 37/37 | 37/37 |
| Reescritos | 6 (todos TODO) | 7 (6 TODO y el README) | 7 (6 TODO y el TODO del README) |
| FL-CRD-008-D | 409 antes de escribir | 409 antes de escribir | 409 de la constraint, con rollback de la entrada |
| FL-CRD-007-C | `db(...)` con la línea de `psql` | `db(...)` con la sentencia | `Db(...)` con la sentencia |
| `baselineTested` | PENDING | (el informe no lo dice) | OK |

## designGaps

Ninguno.
