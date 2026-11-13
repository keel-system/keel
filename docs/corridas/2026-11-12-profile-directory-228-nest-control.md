# Corrida de control del ciclo de vida del dato (DSL 2.28) — `profile-directory` en keel-nest

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.1.0 (DSL 2.28, relacional, 5 capas), con el email `personal` y único, `deletion: logical`, `restorableFor` de 30 días y `retention` (`from: deleted`, `then: delete`) |
| Stack | `postgresql · keycloak` (telemetría `none`) |
| Generador | `keel-nest@0.2.0` (`f3ff2a3f`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **24/24 OK** a la primera (sin arbitrajes) |
| Huella del agente | 188 archivos registrados por `build`, 0 adoptados, **6 reescritos**, 0 borrados |
| Clasificación de la huella | 5 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (el informe dice que no hay huecos y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\cards-228-nest-postgre\services\profile-directory-nest`. Es la corrida de control del
incremento 7 de `PLAN-DSL-228-CICLO-DE-VIDA.md` en keel-nest, gemela de
`2026-11-12-profile-directory-228-spring-control.md`: el mismo diseño y el mismo stack.

## Lo que medía

Lo mismo que la gemela: el borrado lógico y la lectura viva (FL-CRD-004), la unicidad entre fichas vivas al reutilizar el
`subject` o el email de una borrada y al restaurar sobre ellos (FL-CRD-005 y FL-CRD-006), la ventana de restauración
(FL-CRD-007) y la purga de la retención (FL-CRD-007-B). Todo en verde.

## FL-CRD-007: envejecer el borrado

El agente lo resolvió sin helper nuevo, con el `db(...)` del arnés: `UPDATE … SET deleted_at = deleted_at - interval '31
days' WHERE id = …`. A diferencia de keel-spring, no nombra la tabla. La descubre en `information_schema.columns` por la
columna `deleted_at`, porque las pruebas son de caja negra y no conocen el esquema. Va dentro de la propia prueba
(`restore-window-retention.test.ts`), que es un archivo del agente fuera del manifiesto. El informe lo declara como el
supuesto que el careo dejó aceptado.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe: 24 `FL-*` al 100 %, y la no-regresión del pase de calidad dio la misma línea final.
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en `D:\keel-tmp`:
  - Los cuatro handlers, con 2 TODO cada uno, y `contact-card.ts`, cuyo TODO del factory se convirtió en `create(...)` más
    `replace(...)`. Este último es la regla del reemplazo entero de `saveMyCard`.
  - `README.md` solo gana la sección «Despliegue en producción», que no es una decisión.
- El baseline de migraciones se verificó en vivo (`baselineTested: OK`), cosa que en keel-spring queda pendiente.
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Contra la gemela de keel-spring

| | keel-spring | keel-nest |
|---|---|---|
| Matriz | 24/24 | 24/24 |
| Reescritos | 5 (todos TODO) | 6 (5 TODO y el README) |
| FL-CRD-007 | `ageDeletion` propio con la tabla nombrada | `UPDATE` en la prueba, con la tabla descubierta por la columna |
| Huecos | 0 | 0 |

## designGaps

Ninguno.
