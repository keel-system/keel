# Índices

Los índices son, en este modelo, el equivalente del esquema: lo único de la
persistencia que hay que declarar aparte del documento.

## Por qué aquí no hay un «baseline» que redactar

En la rama relacional, Hibernate **infiere** el DDL de las entidades, y por eso hace
falta exportarlo, revisarlo y congelarlo como migración: nadie sabe qué infirió hasta
que lo mira.

Un índice de Mongo no se infiere de nada. Sale entero de `naturalKey`, `unique` e
`indexes` de `specs/persistence.keel.yaml`, que build ya tiene delante — así que
build lo genera completo en `MongoIndexConfig` y **tu trabajo es verificarlo, no
escribirlo**. Es una diferencia real entre las dos ramas, no un atajo.

## El contrato de los nombres

`MongoIndexConfig` nombra cada índice explícitamente:

```java
inspectionReportIndexes.createIndex(
        new Index()
                .on("site_code", Sort.Direction.ASC)
                .on("inspected_on", Sort.Direction.ASC)
                .unique()
                .named("uk_inspection_reports_natural"));
```

Ese nombre **no es cosmético**. Cuando una escritura viola la unicidad, el driver
lanza `DuplicateKeyException` con el nombre dentro del mensaje:

```
E11000 duplicate key error collection: inspection_reports.inspection_reports
index: uk_inspection_reports_natural dup key: { site_code: "S-1", inspected_on: … }
```

y el `ApiExceptionHandler` lo busca ahí para traducir la violación al **error
declarado por el diseño** (un 409 con su `code`) en vez de a un conflicto genérico.

De ahí las dos reglas:

- `auto-index-creation` queda apagada. Si Spring crea los índices desde las
  anotaciones, les pone el nombre que él decide y la traducción deja de encontrarlo.
- Todo índice único nuevo se crea con `.named("uk_<colección>_<qué>")` y se registra
  en el mapa del `ApiExceptionHandler`.

## Verificación (lo que sí te toca)

```bash
bash infra/export-indexes.sh     # → build/schema/indexes.json
```

Solo lee: no arranca la app, no escribe y no borra. Se puede ejecutar con la suite de
integración corriendo contra la misma base — al contrario que la prueba del baseline
relacional, que exige vaciar el esquema. Por eso esta comprobación **sí** se hace
dentro de la generación.

Contrasta en los **dos** sentidos:

1. Cada `uk_*`/`idx_*` de `MongoIndexConfig` aparece en el export, con las mismas
   claves, el mismo orden y el mismo `unique`.
2. No sobra ninguno. Un índice que no salga de `MongoIndexConfig` lo creó otra cosa
   (una anotación, un `mongosh` de alguien), y su nombre no lo conoce el
   `ApiExceptionHandler`.
3. Cada `naturalKey`, cada campo `unique` y cada entrada de `indexes` de
   `specs/persistence.keel.yaml` tiene el suyo.

Requisito previo: la infraestructura arriba y la app arrancada **al menos una vez**
(los índices se crean en el arranque).

## Añadir o cambiar un índice

`createIndex` es idempotente mientras la definición no cambie. Si cambia la forma
—otras claves, otro orden, otro `unique`— Mongo **rechaza** recrear el mismo nombre:
hay que borrarlo antes.

```javascript
db.inspection_reports.dropIndex("idx_inspection_reports_status")
```

En un entorno desplegado eso es un paso previo, igual que una migración: déjalo
escrito en el README.

## Índices que no salen del diseño

Build también crea los de la infraestructura, y no son opcionales:

| Colección | Índice | Sin él |
|---|---|---|
| `outbox_event` | `ix_outbox_event_pending` sobre `published_at, created_at` | cada pasada del relay (una por segundo) recorre la colección entera para reclamar un lote |
| `processed_event` | `ix_processed_event_processed_at` | la purga diaria escanea todo |
| `idempotency_record` | `ix_idempotency_record_expires_at` | ídem |

`processed_event` e `idempotency_record` no llevan índice único: su unicidad ya la da
el `_id`, que Mongo indexa siempre.

## TTL index: por qué no lo genera build

Mongo puede caducar documentos solo, con `expireAfterSeconds` sobre `processed_at` o
`expires_at`, y eso haría innecesarias las purgas `@Scheduled`. No se genera porque
el hilo TTL corre con granularidad de ~60 s y no se puede forzar desde un test: un
purgado con reloj propio vuelve inestable cualquier escenario `FL-*` que dependa de
él, y el gate del pipeline es justo la puntuación determinista de esos escenarios.

Es una buena idea **en producción**, como añadido a las purgas y no en su lugar:

```javascript
db.processed_event.createIndex({ processed_at: 1 }, { expireAfterSeconds: 1209600 })
```
