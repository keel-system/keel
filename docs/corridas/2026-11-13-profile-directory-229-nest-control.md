# Corrida de control del historial de cambios (DSL 2.29) — `profile-directory` en keel-nest

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.2.0 (DSL 2.29, relacional, 5 capas), con `audit.history: [ContactCard]` y la query `getMyCardHistory` (paginada, filtros `field`/`from`/`to`), sobre el ciclo de vida de la v1.1.0 (borrado lógico, restauración en 30 días y purga) |
| Stack | `postgresql · keycloak` (telemetría `none`) |
| Generador | `keel-nest@0.2.0` (`9be8b08d`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **37/37 OK** a la primera (sin arbitrajes) |
| Huella del agente | 197 archivos registrados por `build`, 0 adoptados, **7 reescritos**, 0 borrados |
| Clasificación de la huella | 6 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta (y el README, ver abajo) |
| Huecos del diseño | 0 (el informe dice «ninguno» y no hay `design-gaps.yaml`) |
| Huecos del generador | 1, de documentación: el README emitido no dice que tras `infra/up.sh` hay que sembrar el realm con `infra/init-keycloak.sh`. No tocó la corrida, y está igual en los cuatro generadores |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\cards-229-nest-postgre\services\profile-directory-nest`. Es la segunda de las cinco
corridas de control del incremento 7 de `PLAN-DSL-229-HISTORIAL.md`, gemela de
`2026-11-13-profile-directory-229-spring-control.md`: el mismo diseño y el mismo stack.

## Lo que medía

Lo mismo que la gemela, todo en verde:

- una entrada por escritura confirmada (FL-CRD-008);
- los filtros por campo y por fechas, con el `at` leído como extremo (FL-CRD-009);
- el historial que sigue a la ficha viva (FL-CRD-010);
- la purga que se lo lleva (FL-CRD-007-C);
- el 401/403 de la query nueva (FL-CRD-003);
- todo lo de la v1.1.0.

## Los dos riesgos anotados

- **`ageDeletion`.** El agente lo usó en el Given de FL-CRD-007 (`ageDeletion('ContactCard', cardAna, 31)`, en
  `card-retention.test.ts`). En la 2.28, keel-nest descubría la tabla en `information_schema` por la columna
  `deleted_at`, porque las pruebas no conocían el esquema. Con el helper, ese rodeo desaparece.
- **FL-CRD-007-C.** El agente lo comprobó con el `db(...)` del arnés:
  `SELECT count(*) FROM change_history WHERE root_type = 'ContactCard' AND root_id = '${cardAna}'`.
  La tabla y las columnas son las de la convención, a la primera. Aquí `db(...)` recibe la sentencia sola, sin la línea
  de `psql`, así que el coste de no tener `historyOf` es menor que en keel-spring. Van dos de cinco que aciertan.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe: 37 `FL-*` al 100 %, con el código de salida 0.
- **Las pruebas del agente**, en `test/integration/`. Diez archivos de flujo y `support/flow.ts`.
  - FL-CRD-009 siembra las tres escrituras dentro de su primer paso, con 25 ms entre una y otra, y guarda
    `<t1>`…`<t3>` para los pasos siguientes.
  - Los instantes van con `encodeURIComponent` en la query.
  - FL-CRD-010-C prueba sin parámetros y con `?callerSubject=sub-ana-001`.
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en
  `D:\keel-tmp\cards-229-nest-regen`:
  - Los cinco handlers partían de 2 TODO cada uno, y `contact-card.ts` de 1: el agente escribió `create(...)` y
    `replaceWith(...)`.
  - `GetMyCardHistory` carga la ficha con `findBySubject` y después llama a
    `historyOf(card.id, { field, from, to }, pageable)`, igual que la gemela.
  - `README.md` solo gana la sección «Despliegue en producción», como en la 2.28, y no es una decisión.
- **Lo que FL-CRD-008-D no discrimina**, igual que en la gemela. `save-my-card-command-handler.ts` comprueba el correo
  con `findByEmail` antes de guardar, así que el 409 sale sin llegar a escribir. El rollback con la entrada ya escrita
  lo mide `db-check` (`hi-outside-tx`), no la corrida.
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## La nota del generador: el realm de Keycloak

El informe dice que «`infra/up.sh` no siembra el realm de Keycloak», y que sin `bash infra/init-keycloak.sh` el humo del
arnés sale KO con «Realm does not exist». Lo contrasté contra lo emitido:

- **Que `up.sh` no siembre es a propósito.** El paso 6 del agente `keel-nest-infra` manda ejecutar `init-keycloak.sh`
  después de `up.sh` y antes de cualquier flujo. Así se hizo, y por eso la matriz salió verde. Según el informe, el KO
  vino de levantar la infraestructura otra vez sin ese paso.
- **Lo que falta es decirlo fuera del agente.** El `README.md` del proyecto no nombra `init-keycloak.sh`, y tampoco lo
  nombran los README que emiten keel-spring, keel-dotnet y keel-go para este mismo diseño. Todos enseñan
  `bash infra/up.sh` a secas. Quien levante la infraestructura a mano para depurar se queda sin realm.
- El arreglo va en los README de los cuatro generadores: la línea `bash infra/init-keycloak.sh` tras `up.sh` cuando el
  stack lleva Keycloak. Queda para después de las corridas.

## Contra la gemela de keel-spring

| | keel-spring | keel-nest |
|---|---|---|
| Matriz | 37/37 | 37/37 |
| Reescritos | 6 (todos TODO) | 7 (6 TODO y el README) |
| FL-CRD-007 | `ageDeletion` del arnés | `ageDeletion` del arnés |
| FL-CRD-007-C | `db(...)` con la línea de `psql` entera | `db(...)` con la sentencia sola |
| Huecos | 0 | 0 de diseño; 1 de documentación del generador, común a los cuatro |

## designGaps

Ninguno.
