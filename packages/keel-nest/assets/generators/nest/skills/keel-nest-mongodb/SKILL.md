---
name: keel-nest-mongodb
description: Guía de la persistencia documental (MongoDB) en un proyecto generado por keel-nest — ampliar un puerto de repositorio y su adaptador sobre el driver, verificar los índices vivos, los ayudantes del arnés que fabrican precondiciones (mongoEval, el rescate, la reconciliación) y los fallos típicos; el código de persistencia (documentos, adaptadores, transacción, índices, almacenes del generador, traducción de E11000) ya lo genera build. Usar cuando keel-stack.json declara database "mongodb".
---

# Persistencia documental (database: mongodb)

El código de persistencia sale entero de build, sobre el driver oficial y sin ODM:

- **el agregado es el documento**: la raíz es una colección y sus hijas van ANIDADAS dentro; un value object
  es un subdocumento; una referencia a otro agregado es su id (`<relación>_id`), nunca un documento embebido;
- el **documento es contrato**: el mismo que escribe el servidor de keel-spring del diseño —claves en
  `snake_case`, `_id` binario uuid (subtipo 4), `decimal` como `Decimal128` con su escala, enums por la
  constante—. El otro servidor lo lee, y el arnés y los checks consultan por esos nombres;
- un adaptador por raíz (`<Raíz>RepositoryImpl`) con el mapeo dominio ↔ documento escrito campo a campo y
  cada valor por `src/infrastructure/persistence/bson-values.ts`;
- la transacción que abre el mediator (`src/infrastructure/persistence/transaction-context.ts`, sobre una
  sesión; el replica set de `infra/` es lo que la hace posible) y el `WriteConflict` reintentado;
- los índices del diseño, con sus nombres, creados al ARRANCAR (`src/infrastructure/persistence/document-indexes.ts`);
- la traducción de cada violación al error del diseño (`src/infrastructure/persistence/persistence-errors.ts`,
  por el nombre del índice en el mensaje E11000);
- los almacenes del generador (outbox, mensajes procesados, registro de idempotencia, reclamos) con su
  documento y su `_id` del contrato.

**No rehagas ese patrón**: extiéndelo.

## Antes de empezar

- Lee `specs/persistence.keel.yaml`: claves naturales, índices (y su `when`), `consistency`.
- Sigue `{{keel:docs}}/conventions/mapping.md` § persistence.

## Qué hace cada agente aquí

| Agente | Trabajo | Referencia |
|---|---|---|
| código | ampliar un puerto de `domain/repository` **y** su adaptador cuando un handler necesita una consulta que build no derivó | `references/repository-adapters.md` |
| pruebas | fabricar una precondición que ninguna operación produce (un documento atascado, una marca de espera vencida) y mirar el almacén | `references/harness.md` |
| calidad | **verificar los índices vivos** contra los que crea el servidor | `references/indexes.md` |
| cualquiera | diagnosticar un fallo del motor | `references/troubleshooting.md` |

## Reglas que no se rompen

- Ningún handler ni controlador importa `mongodb`, una colección ni una sesión: la frontera hexagonal lo
  prohíbe y `npm run check:architecture` lo comprueba.
- El adaptador pasa **siempre** `{ session: this.session }` (la de la transacción abierta por el mediator):
  sin ella la operación va fuera de la transacción y un aborto no la desharía.
- Nada de operaciones en paralelo (`Promise.all`) dentro de una transacción: el driver no las admite sobre
  la misma sesión.
- Los nombres de los índices son **contrato**: el filtro de errores traduce por ellos al `code` del diseño,
  y keel-spring usa los mismos. No se renombran ni se crean a mano.
- Las claves del documento son las de `documentShape` (las que ya usa el adaptador): un `$set` sobre un
  nombre que no existe NO falla, crea otro campo.
- `lock_version` no se toca: el adaptador ya pone la versión en el FILTRO del update y lo traduce a 409.
- Un registro (`processed_event`, `idempotency_record`) se escribe con `insertOne`: un reemplazo o un upsert
  sobre un `_id` presente pisaría el de la otra petición en vez de perder la carrera. El gate
  `infra/check-idempotency.sh` lo exige.
