# Los índices: el equivalente del esquema

Sobre documentos no hay migraciones. Los índices salen ENTEROS del diseño (`naturalKey`, `unique`, `indexes`
con su `when`) y de los almacenes del generador, y los crea el servidor al arrancar desde
`src/infrastructure/persistence/document-indexes.ts`, con los nombres del contrato (`uk_<colección>_natural`,
`uk_…`, `idx_…`, `ix_…`). Por eso la revisión del agente de calidad es una **verificación**, no una redacción.

## Verificarlos (agente de calidad)

Con la infraestructura arriba y el servidor arrancado al menos una vez (la no-regresión ya lo hizo):

```bash
bash infra/export-indexes.sh      # solo LEE: build/schema/indexes.json
```

Contrasta `build/schema/indexes.json` con `DOCUMENT_INDEXES` de `document-indexes.ts`:

1. cada índice está vivo con las MISMAS claves (y en su orden), la misma unicidad y el mismo
   `partialFilterExpression` —el valor del filtro es la CONSTANTE del enum, no el literal del diseño—;
2. no sobra ninguno: uno que no salga de ahí lo creó otra cosa, y su nombre no lo conoce el traductor de
   errores (su violación saldría como un 409 sin `code`);
3. cada `naturalKey`/`unique`/`indexes` de `specs/persistence.keel.yaml` tiene el suyo. Los de una entidad
   ANIDADA no existen a propósito: su unicidad dentro del agregado la hace cumplir la raíz.

Reporta `indexes: OK | KO` e `indexesTested: OK`. Un índice que falta o difiere es un defecto de build:
a `blockers`, nunca un `createIndex` ni un `dropIndex` a mano.

## Cambiar la forma de un índice

`createIndex` es idempotente mientras la definición no cambie. Si el diseño cambia las claves de un índice
existente, el servidor NO arranca (MongoDB rechaza recrear el mismo nombre con otra forma): en local,
`bash infra/reset-db.sh --schema` borra la base entera y el siguiente arranque los crea de nuevo.
