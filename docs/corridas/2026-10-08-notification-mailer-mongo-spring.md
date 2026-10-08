# Corrida `notification-mailer-mongo` — keel-spring (gemela de la 12e de keel-nest)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer-mongo` v2.0.2 (DSL 2.19, documental, 7 capas) |
| Stack | `mongodb · rabbitmq · keycloak` |
| Generador | `keel-spring@0.1.6` |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** |
| Huella del agente | 300 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 1 (3 en `design-gaps.yaml`: 1 real, 1 falso positivo y 1 del contrato del cable, no del diseño; ver § Lo que dijo el informe) |
| Huecos del generador | 1: `export-indexes.sh` no exportaba el filtro parcial (ver § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 14 TODO · 3 consulta · 0 generador · 0 diseño · 0 puerta (el hueco real no tocó ningún archivo) |
| Agujeros de la puerta | 0 |

La gemela de keel-spring de la corrida 12e de keel-nest (`2026-10-08-notification-mailer-mongo-nest.md`): el mismo
diseño, el mismo stack, para comparar los dos servidores. Es además la primera corrida de keel-spring sobre la
variante documental del par del MVP desde R9.

## Cómo terminó

**23/23** sin arbitraje, sin `harnessPatches`, sin `culprit: harness` ni falsos negativos. Los gates en verde sobre el
proyecto terminado, `mailDelivery` incluida (reclamo y envío). El agente de pruebas reportó tres `designGaps`; el de
calidad verificó los índices vivos con `export-indexes.sh` y dejó una nota: el índice único condicionado de
`templates` salía sin su filtro parcial, así que su condición solo se pudo contrastar en `MongoIndexConfig`.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los nueve handlers de `application/usecases/` | TODO legítimo |
| `domain/aggregate/{Application,Notification,Template}.java`, `domain/entity/TemplateVariable.java` | TODO legítimo |
| `README.md` | TODO legítimo: la guía de despliegue |
| `domain/repository/TemplateRepository.java`, `TemplateMongoRepository.java`, `TemplateRepositoryImpl.java` | Consulta de negocio: `findLatestVersion` para «la versión es la siguiente», regla escrita en `registerTemplate` (el mismo finder, con el mismo nombre, que el agente de keel-nest) |

## Lo que dijo el informe y lo que resultó ser

1. **`copyRecipients` sin informar, ¿`[]` o `null`?** No es una decisión que el diseño pueda tomar —el DSL no tiene
   dónde— ni la tomó ningún agente: los dos dominios generados guardan una lista vacía, nunca `null`, y los dos
   servidores responden `[]`. Lo que falta es escribirlo en el contrato del cable (`wire-contract.md` no dice nada de
   una lista ausente). Del método, no del diseño. Ver § Pendientes.
2. **`INVALID_STATE_TRANSITION` «sin declarar»** es un falso positivo: es un `code` del catálogo cerrado del
   generador (`framework-errors.md`, el rechazo de una transición que el `lifecycle` no admite), y por eso el diseño no
   lo declara. Además el hueco salió con la unidad equivocada (`sendAcceptedNotification`, cuando el escenario citado,
   `FL-TPL-010`, es de `publishTemplate`). Lo que delata es otra cosa: **el catálogo no viaja al proyecto generado**
   —el agente de pruebas, que trabaja en caja negra, solo lo encuentra en los escenarios—. Ver § Pendientes.
3. **El orden de las variables** es un hueco real y pequeño: el diseño no dice si el orden de una lista de value
   objects o de entidades internas es significativo. Los dos servidores lo tratan como indiferente.
4. **La nota de calidad sobre `export-indexes.sh`** es un defecto del generador, y común a los dos (ver § Arreglos).

## Arreglos

- **`export-indexes.sh` exporta el `partialFilterExpression`** de cada índice que lo tiene (`keel-core/gen/document.js`,
  el mismo script para keel-spring y keel-nest), y su guía pide contrastarlo. Fijado en `keel-core/test/document.test.js`,
  que EJECUTA el fragmento de mongosh del script contra un `db` falso; falsado deshaciendo el arreglo. La línea base de
  keel-spring cambia solo en `infra/export-indexes.sh` de los diseños documentales (9 puntos).

## Pendientes

- **El catálogo de `framework-errors.md` en el proyecto generado** (los dos generadores): sin él, un agente en caja
  negra no distingue un `code` del generador de uno que el diseño olvidó.
- **La lista ausente en el contrato del cable**: escribir en `wire-contract.md` que una lista no informada viaja como
  `[]`, que es lo que ya hacen los dos servidores.
- **La precedencia del formato** (ver la ficha de keel-nest): aquí el agente validó los formatos antes de buscar la
  plantilla y responde 400; el de keel-nest, después, y responde 422.

## designGaps

- `list-order-significance` — si el orden de las variables declaradas de una plantilla (y de las de un envío) es
  significativo; hoy se trata como indiferente.
