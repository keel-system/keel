# Corrida de control del ciclo de vida del dato (DSL 2.28) — `profile-directory` en keel-dotnet

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.1.0 (DSL 2.28, relacional, 5 capas), con el email `personal` y único, `deletion: logical`, `restorableFor` de 30 días y `retention` (`from: deleted`, `then: delete`) |
| Stack | `postgresql · keycloak` (telemetría `none`) |
| Generador | `keel-dotnet@0.2.0` (`f3ff2a3f`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **24/24 OK** en la segunda puntuación, corregida por el propio pipeline (sin arbitrajes) |
| Huella del agente | 212 archivos registrados por `build`, 0 adoptados, **6 reescritos**, 0 borrados |
| Clasificación de la huella | 5 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (el informe dice «Ninguno» y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\cards-228-dotnet-postgre\services\profile-directory-dotnet`. Es la corrida de control del
incremento 7 de `PLAN-DSL-228-CICLO-DE-VIDA.md` en keel-dotnet, gemela de las de keel-spring y keel-nest del mismo día:
el mismo diseño y el mismo stack.

## Lo que medía

Lo mismo que las gemelas: el borrado lógico y la lectura viva (FL-CRD-004), la unicidad entre fichas vivas al reutilizar
el `subject` o el email de una borrada y al restaurar sobre ellos (FL-CRD-005 y FL-CRD-006), la ventana de restauración
(FL-CRD-007) y la purga de la retención (FL-CRD-007-B). Todo en verde. `dotnet test` dio 99/99 y el baseline de
migraciones se verificó en vivo, con 22 elementos del esquema.

## FL-CRD-007: envejecer el borrado

El agente lo resolvió otra vez sin helper nuevo, con el `Db(...)` del arnés. La primera puntuación salió con código 2
porque el Given de `CardRetentionFlow` actualizaba la tabla `contact_card` y la real es `contact_cards`. El subagente
`keel-dotnet-tests` lo corrigió con una constante `CardTable`, y la segunda puntuación salió en verde.

No es un hueco del generador: el nombre está en lo que emite `build` (las filas de EF y `PersistenceModelTests`). Sí es
la primera vez que el SQL a mano de este Given falla. Las tres corridas lo resolvieron de tres maneras distintas:

- keel-spring nombró bien la tabla;
- keel-nest la descubrió por la columna `deleted_at`;
- keel-dotnet se equivocó primero.

Esto cuenta a favor del helper `ageDeletion` en los arneses, que pondría la tabla y la columna desde el modelo. Se decide
al cerrar el incremento 7, con las corridas que faltan.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe: 24 `FL-*` al 100 % y el código de salida 0.
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en `D:\keel-tmp`:
  - Los cuatro handlers, con 2 TODO cada uno, y `ContactCard.cs`, cuyo TODO del factory se convirtió en `Create(...)` más
    `Replace(...)`. Este último es la regla del reemplazo entero de `saveMyCard`.
  - `README.md` solo gana la sección «Despliegue en producción», que no es una decisión.
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Contra las gemelas

| | keel-spring | keel-nest | keel-dotnet |
|---|---|---|---|
| Matriz | 24/24 | 24/24 | 24/24 (segunda puntuación) |
| Reescritos | 5 (todos TODO) | 6 (5 TODO y el README) | 6 (5 TODO y el README) |
| FL-CRD-007 | tabla nombrada bien | tabla descubierta por la columna | tabla mal nombrada y corregida |
| Huecos | 0 | 0 | 0 |

## designGaps

Ninguno.
