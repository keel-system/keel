---
name: keel-dotnet-mongodb
description: Guía de la persistencia documental (MongoDB) en un proyecto generado por keel-dotnet — ampliar un puerto de repositorio y su adaptador sobre el driver, verificar los índices vivos, los ayudantes del arnés que fabrican precondiciones (MongoEval, el rescate, la reconciliación) y los fallos típicos; el código de persistencia (documentos, adaptadores, transacción, índices, almacenes del generador, traducción de E11000) ya lo genera build. Usar cuando keel-stack.json declara database "mongodb".
---

# Persistencia documental (database: mongodb)

El código de persistencia sale entero de build, sobre el driver oficial (`MongoDB.Driver`) y **sin mapeo de clases**:

- **el agregado es el documento**: la raíz es una colección y sus hijas van ANIDADAS dentro; un value object es un
  subdocumento; una referencia a otro agregado es su id (`<relación>_id`), nunca un documento embebido;
- el **documento es contrato**: el mismo que escriben los servidores de keel-spring y keel-nest del diseño —claves en
  `snake_case`, `_id` binario uuid (subtipo 4), `decimal` como `Decimal128` con su escala, enums por la constante—. El
  otro servidor lo lee, y el arnés y los checks consultan por esos nombres;
- un adaptador por raíz (`Persistence/Repositories/<Raíz>Repository.cs`) con el mapeo dominio ↔ `BsonDocument` escrito
  campo a campo (`ToDocument<Tipo>`/`ToDomain<Tipo>`) y cada valor por `Persistence/BsonValues.cs`;
- la transacción que abre el mediator (`Persistence/PersistenceTransactions.cs`, sobre una sesión; el replica set de
  `infra/` es lo que la hace posible) y el `WriteConflict` reintentado;
- los índices del diseño, con sus nombres, creados al ARRANCAR (`Persistence/DocumentIndexes.cs`);
- la traducción de cada violación al error del diseño (`Persistence/PersistenceErrors.cs`, por el nombre del índice en
  el mensaje E11000);
- los almacenes del generador (outbox, mensajes procesados, registro de idempotencia, reclamos, purgas) con su documento
  y su `_id` del contrato.

**No rehagas ese patrón**: extiéndelo.

## Antes de empezar

- Lee `specs/persistence.keel.yaml`: claves naturales, índices (y su `when`), `consistency`.
- Sigue `{{keel:docs}}/conventions/mapping.md` § persistence.

## Qué hace cada agente aquí

| Agente | Trabajo | Referencia |
|---|---|---|
| código | ampliar un puerto de `Domain/Repository` **y** su adaptador cuando un handler necesita una consulta que build no derivó | `references/repository-adapters.md` |
| pruebas | fabricar una precondición que ninguna operación produce (un documento atascado, una marca de espera vencida) y mirar el almacén | `references/harness.md` |
| calidad | **verificar los índices vivos** contra los que crea el servidor | `references/indexes.md` |
| cualquiera | diagnosticar un fallo del motor | `references/troubleshooting.md` |

## Reglas que no se rompen

- Un filtro con `compare: ignore-case` o `ignore-case-accents` (en el campo o solo en la query) va contra el campo sombra
  `<campo>_normalized` que build mantiene en el documento, con el término plegado por `TextFold` (y escapado con
  `Regex.Escape` si va en una `$regex`). Nunca `$regex` con la opción `i` ni una collation: son otra función de plegado,
  y el mismo diseño servido por keel-spring pliega con `TextFold`.
- Ningún handler ni endpoint usa `MongoDB.Driver`, una colección ni una sesión: la frontera hexagonal lo prohíbe, y el
  proyecto Application no referencia el de Infrastructure (el compilador lo impide).
- El adaptador opera en la sesión de la transacción abierta (`transactions.Session`): sin ella la operación va fuera de
  la transacción y un aborto no la desharía. Las búsquedas pasan por el `Find(...)` del propio adaptador, que ya la toma.
- Nada de operaciones en paralelo (`Task.WhenAll`) dentro de una transacción: la sesión no las admite.
- Los nombres de los índices son **contrato**: el traductor de errores traduce por ellos al `code` del diseño, y
  keel-spring y keel-nest usan los mismos. No se renombran ni se crean a mano.
- Las claves del documento son las de `ToDocument<Raíz>` (las del contrato): un `$set` sobre un nombre que no existe NO
  falla, crea otro campo.
- `lock_version` no se toca: el adaptador ya pone la versión en el FILTRO del update y lo traduce a 409.
- Un registro (`processed_event`, `idempotency_record`) se escribe con `InsertOneAsync`: un reemplazo o un upsert sobre
  un `_id` presente pisaría el de la otra petición en vez de perder la carrera. El gate `infra/check-idempotency.sh` lo
  exige.
