// El DOCUMENTO de la persistencia documental, sin lenguaje (keel-core/gen).
//
// Es el gemelo de `relational.js` para `persistence.default.model: document`, y existe por lo mismo:
// cómo se llama cada campo dentro del documento, qué se anida y qué se referencia, con qué tipo BSON
// se guarda cada valor y qué índices llevan qué nombre es contrato observable de los dos
// generadores —el otro servidor lee lo que este escribió, el arnés consulta con mongosh por estas
// rutas y el traductor de errores encuentra el `code` declarado buscando el NOMBRE del índice en el
// mensaje E11000 del driver—. keel-spring lo escribe como anotaciones de su mapeador y keel-nest como
// un mapeo explícito sobre el driver, sobre los MISMOS datos.
//
// La diferencia de fondo con la rama relacional cabe en una frase: el agregado ES el documento. La
// raíz es una colección; sus entidades internas van anidadas dentro de ella; un value object es un
// subdocumento y no columnas con prefijo; una referencia a OTRO agregado sigue siendo su id y nunca
// una referencia navegable.

import { snakeCase } from './naming.js';
import { persistedMembers, uniqueFields, indexName, storedWhenValue, partialUniqueIndexes, LOCK_VERSION, AUDIT_COLUMNS, usesAuditableEntity } from './relational.js';
import { usesOutbox, usesMessageDeduplication, storeColumns } from './messaging-stores.js';
import { usesRequestIdempotency } from './request-idempotency.js';
import { reconciliationClaims, RECONCILIATION_CLAIM } from './reconciliation-stores.js';

// ─── La representación física ────────────────────────────────────────────────

/**
 * Con qué tipo BSON se guarda cada base del DSL. Es la mitad del contrato que no se ve leyendo el
 * documento por el mapeo de su propio servidor —cualquier representación hace ida y vuelta consigo
 * misma— y sí al leerlo desde el otro o al compararlo en una consulta:
 *   · `decimal` como Decimal128, nunca texto: con texto toda comparación y todo orden en la base
 *     pasan a ser lexicográficos ("10" < "9");
 *   · `uuid` como binario de subtipo 4 (la representación estándar), no el subtipo 3 heredado;
 *   · `timestamp` como fecha BSON, que guarda milisegundos;
 *   · `date` como fecha BSON a medianoche UTC del día —el día no tiene zona; un servidor que la
 *     tome en la del sistema guarda otro instante si su zona no es UTC—;
 *   · `json` y `file` como texto: el json embebido viaja serializado y un file es la clave del objeto.
 * Un enum se guarda por la CONSTANTE (`ACTIVE`), no por el literal del diseño: lo mismo que la
 * columna relacional, y por eso los filtros de un índice parcial usan `storedWhenValue`.
 */
export const DOCUMENT_STORAGE = Object.freeze({
  string: 'string',
  text: 'string',
  json: 'string',
  file: 'string',
  int: 'int',
  long: 'long',
  decimal: 'decimal128',
  boolean: 'bool',
  uuid: 'uuid',
  date: 'date',
  timestamp: 'date'
});

/** El nombre del campo que guarda el id de la raíz: `_id`, que no es negociable en MongoDB. */
export const DOCUMENT_ID = '_id';

/** El tipo BSON de un campo escalar del modelo (base, value type escalar o enum). */
export function storageOf(field) {
  if (field.kind === 'enum') return 'string';
  // Un value type sobre una base que el DSL no conoce se trata como texto, que es el mismo
  // criterio con el que se le da representación en el resto del modelo.
  return DOCUMENT_STORAGE[field.base] ?? 'string';
}

// ─── La forma del documento ──────────────────────────────────────────────────

/**
 * Los value objects que tienen subdocumento: los que alcanza cualquier campo de una entidad
 * persistida, transitivamente a través de los value objects anidados. Orden de descubrimiento
 * estable (el de las entidades), para que lo que se emite de aquí no baile entre dos builds.
 */
export function documentValueObjects(model) {
  const byName = new Map((model.valueObjects ?? []).map((vo) => [vo.name, vo]));
  const reached = new Set();
  const visit = (name) => {
    const vo = byName.get(name);
    if (!vo || reached.has(vo)) return;
    reached.add(vo);
    for (const sub of vo.fields ?? []) if (sub.kind === 'composite') visit(sub.namedType);
  };
  for (const entity of (model.entities ?? []).filter((e) => e.persisted)) {
    for (const field of entity.fields ?? []) if (field.kind === 'composite') visit(field.namedType);
  }
  return reached;
}

/** Los campos de un value object como subdocumento: `{ name, field, member, storage | valueObject }`. */
export function valueObjectShape(vo) {
  return (vo.fields ?? []).map((sub) =>
    sub.kind === 'composite'
      ? { name: snakeCase(sub.name), member: sub.name, kind: 'subdocument', valueObject: sub.namedType, field: sub }
      : { name: snakeCase(sub.name), member: sub.name, kind: 'scalar', storage: storageOf(sub), field: sub }
  );
}

/**
 * Los campos de primer nivel del documento de una entidad persistida, en el orden en que los lee el
 * diseño. Cada entrada: `{ name, member, kind, … }` con `kind`:
 *   · `id`            el `_id` (también el de una hija anidada, dentro de su subdocumento);
 *   · `scalar`        con su `storage`; la sombra plegada de un campo con `compare` sale aparte;
 *   · `subdocument`   un value object (`valueObject`) o una hija uno-a-uno (`entity`);
 *   · `array`         una lista (`element`: `{ storage }` o `{ valueObject }`) o las hijas
 *                     uno-a-muchos (`element`: `{ entity }`);
 *   · `ref`           una referencia a OTRO agregado: su id en `<relación>_id`;
 *   · `version`       el contador del bloqueo optimista, si no lo declara el diseño;
 *   · `audit`         lo que la política `all` pone en la raíz (`role`).
 * El puntero de vuelta de una hija a su padre no tiene campo: va DENTRO del padre.
 */
export function documentShape(model, entity) {
  const shape = [];
  for (const member of persistedMembers(model, entity)) {
    if (member.kind === 'scalar') {
      const { field } = member;
      // También en una hija anidada: el mapeador de keel-spring proyecta TODA propiedad id sobre
      // `_id`, esté en la raíz o dentro de ella, y el otro servidor tiene que leerla ahí.
      if (field.isId) {
        shape.push({ name: DOCUMENT_ID, member: member.name, kind: 'id', storage: storageOf(field), field });
        continue;
      }
      shape.push({ name: snakeCase(member.name), member: member.name, kind: 'scalar', storage: storageOf(field), field });
      if (member.folded) {
        shape.push({ name: snakeCase(member.folded.name), member: member.folded.name, kind: 'folded', storage: 'string', of: member.name });
      }
    } else if (member.kind === 'vo') {
      shape.push({ name: snakeCase(member.name), member: member.name, kind: 'subdocument', valueObject: member.field.namedType, field: member.field });
    } else if (member.kind === 'externalRef') {
      shape.push({ name: `${snakeCase(member.relation.name)}_id`, member: member.name, kind: 'ref', storage: 'uuid', relation: member.relation });
    } else if (member.kind === 'elementCollection') {
      const { field } = member;
      const element = field.kind === 'composite' ? { valueObject: field.namedType } : { storage: storageOf(field) };
      shape.push({ name: snakeCase(member.name), member: member.name, kind: 'array', element, field });
    } else if (member.kind === 'relationMany') {
      shape.push({ name: snakeCase(member.name), member: member.name, kind: 'array', element: { entity: member.relation.entity }, relation: member.relation });
    } else if (!member.relation?.backReference) {
      shape.push({ name: snakeCase(member.name), member: member.name, kind: 'subdocument', entity: member.relation.entity, relation: member.relation });
    }
  }
  // Concurrencia optimista: solo la raíz, que es la frontera de consistencia. Si el diseño declara
  // su propio `lockVersion`, ya salió arriba como escalar con el mismo nombre.
  if (entity.isAggregateRoot && entity.usesOptimisticLocking && !entity.declaresLockVersion) {
    shape.push({ name: LOCK_VERSION.column, member: LOCK_VERSION.field, kind: 'version', storage: 'long' });
  }
  // La auditoría por política solo la recibe la raíz: lo anidado no es lo que se guarda.
  if (entity.isAggregateRoot && usesAuditableEntity(model)) {
    const axes = [model.audit?.timestamps === 'all' ? 'timestamps' : null, model.audit?.authorship === 'all' ? 'authorship' : null];
    for (const axis of axes.filter(Boolean)) {
      for (const column of AUDIT_COLUMNS[axis]) {
        shape.push({
          name: column.column,
          member: column.field,
          kind: 'audit',
          role: column.role,
          storage: axis === 'timestamps' ? 'date' : 'string'
        });
      }
    }
  }
  return shape;
}

// ─── Rutas e índices ─────────────────────────────────────────────────────────

/**
 * Nombre lógico del diseño (campo, relación, `relaciónId` o dot-path de un value object) → rutas
 * reales dentro del documento.
 *
 * Es el gemelo de `columnsFor()` de la rama relacional, y la diferencia es la que define el modelo:
 * allí un value object se APLANA a columnas con prefijo (`price.amount` → `price_amount`), aquí sigue
 * siendo un subdocumento y la ruta es literal (`price.amount`). Y un dot-path a una entidad hija, que
 * en relacional no era indexable porque vivía en otra tabla, aquí sí lo es: va anidada en el mismo
 * documento.
 */
export function documentPathsFor(model, entity, members, logicalName, warnings) {
  const [head, ...rest] = String(logicalName).split('.');
  const member = members.find(
    (m) => m.name === head || m.relation?.name === head || (m.relation && `${m.relation.name}Id` === head)
  );

  if (member?.kind === 'scalar') return [snakeCase(member.name)];
  // MongoDB indexa un array indexando cada elemento (multikey): la ruta es la del propio campo.
  if (member?.kind === 'elementCollection') return [snakeCase(member.name)];
  if (member?.kind === 'externalRef') return [`${snakeCase(member.relation.name)}_id`];
  if (member?.kind === 'vo') {
    const sub = rest.length > 0 ? member.vo?.fields?.find((f) => f.name === rest[0]) : null;
    if (sub) return [`${snakeCase(member.name)}.${snakeCase(sub.name)}`];
    if (rest.length === 0 && member.vo?.fields?.length > 0) {
      return member.vo.fields.map((f) => `${snakeCase(member.name)}.${snakeCase(f.name)}`);
    }
  }
  if (member?.kind === 'relationOne' || member?.kind === 'relationMany') {
    if (rest.length > 0) return [`${snakeCase(member.name)}.${rest.map((part) => snakeCase(part)).join('.')}`];
    return [snakeCase(member.name)];
  }

  warnings?.push(
    `persistence.entities.${entity.name}: el índice declara "${logicalName}", que no es un campo ni una relación de la entidad; se usa "${snakeCase(head)}" tal cual y el índice puede no crearse.`
  );
  return [snakeCase(head)];
}

/** Nombre del índice de la clave natural. Contrato: el traductor de errores busca `uk_` en el E11000. */
export function naturalKeyIndexName(entity) {
  return `uk_${entity.collectionName}_natural`;
}

/**
 * Índices declarados por una entidad persistida, resueltos a rutas del documento:
 * `[{ name, unique, paths, partialFilter, source }]`, en el orden en que se crean —que es el orden
 * en que se leen al verificarlos—.
 */
export function documentIndexSpecs(model, entity, warnings) {
  const members = persistedMembers(model, entity);
  const specs = [];
  const shadowOf = (name) => members.find((m) => m.kind === 'scalar' && m.name === name)?.folded;

  if (entity.naturalKey?.length > 0) {
    specs.push({
      name: naturalKeyIndexName(entity),
      unique: true,
      // Un miembro de la clave que pliega (`compare`) entra por su sombra, como en relacional.
      paths: entity.naturalKey.flatMap((field) => {
        const shadow = shadowOf(field);
        return shadow ? [snakeCase(shadow.name)] : documentPathsFor(model, entity, members, field, warnings);
      }),
      partialFilter: null,
      source: 'naturalKey'
    });
  }
  for (const field of uniqueFields(entity)) {
    // Con `compare` distinto de exact el índice va sobre la SOMBRA plegada (DSL 2.14): solo ella
    // sabe que `ACME` y `acme` son iguales.
    const shadow = shadowOf(field.name);
    specs.push({
      name: `uk_${entity.collectionName}_${snakeCase(field.name)}`,
      unique: true,
      paths: shadow ? [snakeCase(shadow.name)] : documentPathsFor(model, entity, members, field.name, warnings),
      partialFilter: null,
      source: 'unique'
    });
  }
  for (const index of entity.indexes ?? []) {
    specs.push({
      name: indexName(entity, index),
      unique: index.unique,
      paths: index.fields.flatMap((field) => documentPathsFor(model, entity, members, field, warnings)),
      // La unicidad condicionada al estado es un `partialFilterExpression`. El valor es el
      // ALMACENADO, no el literal del diseño: un filtro con el literal de un enum no casaría con
      // ningún documento y el índice parcial no indexaría nada.
      partialFilter: index.when
        ? {
            path: documentPathsFor(model, entity, members, index.when.field, warnings)[0],
            equals: storedWhenValue(model, entity, index.when)
          }
        : null,
      source: 'indexes'
    });
  }
  return specs;
}

/**
 * Los índices condicionados del diseño, ya resueltos a colección, rutas y filtro parcial: el sujeto
 * de las sondas que miden si el índice SOSTIENE lo que el diseño pidió. Derivarlo en la sonda sería
 * medir una copia de sí mismo. La forma va alineada con la del spec relacional (`entity`, `name` y el
 * valor almacenado aparte del literal del diseño) para que las dos ramas compartan casos.
 */
export function partialDocumentIndexSpecs(model) {
  const specs = [];
  for (const entity of (model.entities ?? []).filter((e) => e.persisted)) {
    const members = persistedMembers(model, entity);
    for (const index of partialUniqueIndexes(entity)) {
      const paths = index.fields.flatMap((field) => documentPathsFor(model, entity, members, field, model.warnings));
      const [whenPath] = documentPathsFor(model, entity, members, index.when.field, model.warnings);
      specs.push({
        entity: entity.name,
        collection: entity.collectionName,
        name: indexName(entity, index),
        unique: index.unique,
        paths,
        // La clave natural completa: el índice condicionado no puede haberla desplazado.
        naturalKeyPaths: (entity.naturalKey ?? []).flatMap((field) =>
          documentPathsFor(model, entity, members, field, model.warnings)
        ),
        naturalKeyName: entity.naturalKey?.length > 0 ? naturalKeyIndexName(entity) : null,
        partialFilter: { path: whenPath, equals: storedWhenValue(model, entity, index.when) },
        whenField: (entity.fields ?? []).find((field) => field.name === index.when.field) ?? null,
        fields: index.fields,
        when: index.when
      });
    }
  }
  return specs;
}

/**
 * Los avisos de una entidad interna que declara clave natural o índices: no tiene colección propia,
 * así que un índice sobre `sections.code` existiría pero sería único para TODA la colección, no
 * dentro de cada documento —que es lo que el diseño quiere decir—. No se crea, y se dice dónde
 * queda la garantía.
 */
export function nestedIndexWarnings(model) {
  const warnings = [];
  for (const entity of model.entities ?? []) {
    if (!entity.persisted || entity.isAggregateRoot) continue;
    const declares = [];
    if (entity.naturalKey?.length > 0) declares.push('naturalKey');
    if (entity.indexes?.length > 0) declares.push('indexes');
    if (declares.length === 0) continue;
    warnings.push(
      `persistence.entities.${entity.name}: declara ${declares.join(' y ')}, pero en el modelo documental ${entity.name} va anidada dentro del documento de ${entity.rootEntity} y no tiene colección propia. No se crea índice: la unicidad dentro del agregado es un invariante que hace cumplir la raíz (domain.invariants), no la base de datos.`
    );
  }
  return warnings;
}

/**
 * Los índices de las colecciones que no salen del diseño sino del mecanismo: el outbox, los dos
 * registros de idempotencia y el reclamo de la reconciliación. En relacional los declara la tabla;
 * aquí hay que pedirlos. Ninguno es único: la unicidad de `processed_event`, `idempotency_record` y
 * `reconciliation_claim` la da su `_id`, que MongoDB indexa siempre. Cada entrada lleva `store`, el
 * nombre estable del almacén, para que cada generador nombre su variable como quiera.
 */
export function storeDocumentIndexes(model) {
  const entries = [];
  if (usesOutbox(model)) {
    // El mismo orden de claves que consulta el reclamo del relay: pendientes primero, por antigüedad.
    entries.push({ store: 'outbox', collection: 'outbox_event', specs: [{ name: 'ix_outbox_event_pending', unique: false, paths: ['published_at', 'created_at'] }] });
  }
  if (usesMessageDeduplication(model)) {
    entries.push({ store: 'processedEvent', collection: 'processed_event', specs: [{ name: 'ix_processed_event_processed_at', unique: false, paths: ['processed_at'] }] });
  }
  if (usesRequestIdempotency(model)) {
    entries.push({ store: 'idempotencyRecord', collection: 'idempotency_record', specs: [{ name: 'ix_idempotency_record_expires_at', unique: false, paths: ['expires_at'] }] });
  }
  if (reconciliationClaims(model).length > 0) {
    // De la purga, no del reclamo: el reclamo va por `_id`.
    entries.push({ store: 'reconciliationClaim', collection: 'reconciliation_claim', specs: [{ name: 'ix_reconciliation_claim_claimed_at', unique: false, paths: ['claimed_at'] }] });
  }
  return entries;
}

/**
 * Todos los índices que el servidor crea al arrancar: los de cada raíz (en el orden de las
 * entidades) y los de los almacenes. Las colecciones sin índices no aparecen.
 */
export function documentIndexes(model, warnings = model.warnings) {
  return [
    ...(model.entities ?? [])
      .filter((e) => e.persisted && e.isAggregateRoot)
      .map((entity) => ({ entity: entity.name, collection: entity.collectionName, specs: documentIndexSpecs(model, entity, warnings) })),
    ...storeDocumentIndexes(model)
  ].filter((entry) => entry.specs.length > 0);
}

// ─── Los almacenes del generador como documentos ─────────────────────────────

/**
 * El `_id` del documento de un almacén del generador (outbox_event, processed_event, idempotency_record,
 * reconciliation_claim), derivado de su clave primaria:
 *   · una columna → ese valor es el `_id` (`value`: el uuid del outbox);
 *   · varias → un SUBDOCUMENTO con esas columnas en su orden (`subdocument`). MongoDB compara un `_id`
 *     subdocumento campo a campo Y en orden: `{ handler_id, event_id }` y `{ event_id, handler_id }` son
 *     dos claves distintas, así que el orden es contrato;
 *   · la marca de la reconciliación es la excepción: su clave va APLANADA en un texto
 *     (`reconciliationClaimDocumentId`) y las columnas se guardan además como campos (`flattened`).
 */
export function storeDocumentKey(table) {
  const primary = table.columns.filter((column) => column.primary);
  if (table.table === RECONCILIATION_CLAIM.table) {
    return { kind: 'flattened', columns: primary.map((column) => column.name), separator: '|' };
  }
  if (primary.length === 1) return { kind: 'value', columns: [primary[0].name], storage: storageOf(primary[0]) };
  return { kind: 'subdocument', columns: primary.map((column) => column.name) };
}

/**
 * Los campos del documento de un almacén, fuera del `_id`, en el orden de la tabla y con su tipo BSON.
 * Incluye lo que solo existe en documental (`claimed_at` del outbox) y, en la clave aplanada, las
 * columnas de la clave como campos.
 */
export function storeDocumentFields(table) {
  const key = storeDocumentKey(table);
  return storeColumns(table, 'document')
    .filter((column) => key.kind === 'flattened' || !column.primary)
    .map((column) => ({ name: column.name, storage: storageOf(column), nullable: column.nullable }));
}

// ─── export-indexes.sh ───────────────────────────────────────────────────────

/** Dónde deja `export-indexes.sh` los índices vivos. */
export const INDEX_EXPORT_FILE = 'build/schema/indexes.json';

/**
 * `infra/export-indexes.sh`: exporta los índices VIVOS de cada colección para contrastarlos con
 * los que el servidor crea al arrancar. Solo lee —no arranca la aplicación, no escribe—, así que el
 * agente de calidad la ejecuta de verdad. Lo único que cambia entre generadores es cómo se llama
 * la pieza que crea los índices y la que traduce sus violaciones (`platform.indexCreator`,
 * `platform.errorTranslator`).
 */
export function exportIndexesScript(model, platform) {
  const dbName = model.service.name.replace(/-/g, '_');
  const container = `${model.service.name}-db`;
  return `#!/usr/bin/env bash
# Exporta los índices de cada colección a ${INDEX_EXPORT_FILE}.
#
# Solo LEE: no arranca la aplicación, no escribe y no borra nada, así que se puede
# ejecutar con la suite de integración corriendo contra la misma base.
#
# Uso:  bash infra/export-indexes.sh
# Antes: la infraestructura tiene que estar arriba (bash infra/up.sh)
#        y la aplicación haber arrancado al menos una vez (${platform.indexCreator} crea los
#        índices en el arranque).
set -euo pipefail

cd "$(dirname "$0")/.."

RUNTIME="\${CONTAINER_RUNTIME:-}"
if [ -z "$RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then RUNTIME=podman
  else echo "ERROR: no se encontró docker ni podman." >&2; exit 1
  fi
fi

DB="${dbName}"
OUT="${INDEX_EXPORT_FILE}"
mkdir -p "$(dirname "$OUT")"

# mongosh vive dentro de la imagen de Mongo: no hace falta CLI en el host.
"$RUNTIME" exec -i "${container}" mongosh \\
  "mongodb://$DB:changeme@localhost:27017/$DB?authSource=admin&directConnection=true" \\
  --quiet --eval '
    const out = {};
    db.getCollectionNames().sort().forEach(function (name) {
      out[name] = db.getCollection(name).getIndexes().map(function (ix) {
        // El filtro parcial va también: sin él, el índice único CONDICIONADO es indistinguible de uno normal y
        // su condición no se puede contrastar (corrida notification-mailer-mongo, 12e).
        const entry = { name: ix.name, key: ix.key, unique: ix.unique === true };
        if (ix.partialFilterExpression) entry.partialFilterExpression = ix.partialFilterExpression;
        return entry;
      });
    });
    print(JSON.stringify(out, null, 2));
  ' > "$OUT"

echo "Índices exportados a $OUT"
echo
echo "Qué contrastar (es la verificación, no una redacción: build ya generó los índices):"
echo "  1. Cada uk_*/idx_* de ${platform.indexCreator} aparece aquí, con las MISMAS claves y unique,"
echo "     y el condicionado con su partialFilterExpression (el literal guardado del estado)."
echo "  2. No sobra ninguno: un índice que no salga de ${platform.indexCreator} lo creó otra cosa,"
echo "     y su nombre no lo conoce el ${platform.errorTranslator}."
echo "  3. Cada naturalKey/unique/indexes de specs/persistence.keel.yaml tiene el suyo."
`;
}
