# Corrida de control del ciclo de vida del dato (DSL 2.28) — `profile-directory` en keel-spring

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.1.0 (DSL 2.28, relacional, 5 capas), con el email `personal` y único, `deletion: logical`, `restorableFor` de 30 días y `retention` (`from: deleted`, `then: delete`) |
| Stack | `postgresql · keycloak` (telemetría `none`) |
| Generador | `keel-spring@0.3.0` (`f3ff2a3f`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **24/24 OK** a la primera (sin arbitrajes) |
| Huella del agente | 207 archivos registrados por `build`, 0 adoptados, **5 reescritos**, 0 borrados |
| Clasificación de la huella | 5 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (el informe dice «sin `designGaps`» y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\cards-228-spring-postgre\services\profile-directory-spring`. Es la corrida de control del
incremento 7 de `PLAN-DSL-228-CICLO-DE-VIDA.md` en keel-spring.

## Lo que medía

- **El borrado lógico y la lectura viva.** FL-CRD-004 y sus pasos B a D: borrar, leer y obtener un 404, borrar otra vez,
  restaurar, y restaurar sin nada borrado. Todo en verde.
- **La unicidad entre fichas vivas.** El `subject` y el email de una ficha borrada quedan libres (FL-CRD-005 y
  FL-CRD-006). Restaurar cuando otra ficha viva ya los ocupa da 409 `CARD_ALREADY_EXISTS` o `EMAIL_ALREADY_EXISTS`
  (005-B y 006-B). En verde.
- **La ventana de restauración.** Una ficha borrada hace 31 días da 409 `CARD_NOT_RESTORABLE` (FL-CRD-007). En verde.
- **La purga de la retención.** Tras el barrido, restaurar da 404, y lo de Bea sigue intacto (FL-CRD-007-B). En verde.

## FL-CRD-007: envejecer el borrado

Era el riesgo anotado en el plan, porque el arnés no trae ningún helper para envejecer un borrado. El agente se las
arregló sin él. Escribió `ageDeletion(sub, days)` en su propia clase de apoyo de los flujos, `CardFlowSupport.java`
(archivo del agente, fuera del manifiesto). Ese helper ejecuta un `UPDATE contact_cards SET deleted_at = deleted_at -
interval 'N days'` con el `db(...)` del arnés, la misma consulta por `psql` que emiten los otros tres generadores. Es la
salida que el careo dejó aceptada (`unreachable-given`). El helper `ageDeletion` en los arneses sigue sin hacer falta
mientras los otros tres generadores no digan lo contrario.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe del pipeline: 24 `FL-*` al 100 %, `score-scenarios.sh` con código 0.
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en `D:\keel-tmp`. Los cinco
  reescritos partían de un TODO:
  - Los cuatro handlers: `SaveMyCard`, `GetMyCard`, `DeleteMyCard` y `RestoreMyCard`, con 2 TODO cada uno.
  - `ContactCard.java`: el factory `create(...)` y `replaceWith(...)`. Este último es la regla de `saveMyCard`: reemplaza
    la ficha entera, y lo que no llega queda a null.

  `RestoreMyCardCommandHandler` comprueba las dos unicidades antes de llamar a `restore(...)` del adaptador, que es quien
  aplica la ventana de 30 días. Es lo que declara el diseño.
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Pendiente

- `baselineTested: PENDING`: la prueba del baseline `V1__baseline_schema.sql` sobre una base sin esquema la hace el
  diseñador. Es lo mismo que en todas las corridas de keel-spring.

## designGaps

Ninguno.
