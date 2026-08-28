// Índices del modelo documental: el equivalente del esquema, y lo único de la
// persistencia que hay que declarar aparte del documento.
//
// Aquí NO hay un paso de exportar-revisar-copiar como el baseline de Flyway, y es
// una diferencia real, no un atajo: el baseline relacional existe porque Hibernate
// INFIERE el DDL de las entidades y hay que ver qué infirió. Un índice de Mongo no
// se infiere de nada — sale entero de `naturalKey`, `unique` e `indexes` de
// persistence.keel.yaml, que build ya tiene delante. Por eso se genera completo y
// la revisión del agente de calidad es una verificación (leer los índices vivos y
// contrastarlos), no una redacción.
//
// Los nombres son un CONTRATO con controllers.js: el ApiExceptionHandler traduce
// una violación de unicidad a su error del diseño buscando el nombre del índice
// dentro del mensaje del driver (`E11000 … index: uk_products_natural dup key …`).
// Si estos nombres dejaran de salir de uniqueConstraints(), esa traducción se
// perdería en silencio y toda violación caería en el 409 genérico.

import { snakeCase } from '../lib/naming.js';
import { javaFile, javaPath, subPackage } from './render.js';
import { persistedMembers, uniqueFields, indexName, storedWhenValue } from './persistence-members.js';
import { usesOutbox } from './outbox.js';
import { usesIdempotency } from './idempotency.js';
import { usesHttpIdempotency } from './http-idempotency.js';
import { reconciliationClaims } from './reconciliation-claim.js';

const CONFIG_PKG = 'infrastructure.persistence.config';
export const INDEX_EXPORT_FILE = 'build/schema/indexes.json';

export function generate(model) {
  if (!model.layersPresent.persistence || model.persistenceKind !== 'document') return [];
  warnAboutChildIndexes(model);
  return [renderIndexConfig(model), { path: 'infra/export-indexes.sh', content: exportIndexesScript(model) }];
}

/**
 * Una entidad interna no tiene colección propia: va anidada dentro del documento de
 * su raíz, así que su clave natural o sus índices no se pueden crear como tales.
 * Un índice sobre `sections.code` existiría, pero sería único para TODA la
 * colección, no dentro de cada informe — que es lo que el diseño quiere decir. Es
 * justo el fallo silencioso que este generador no debe cometer: se avisa y se dice
 * dónde queda la garantía.
 */
function warnAboutChildIndexes(model) {
  for (const entity of model.entities) {
    if (!entity.persisted || entity.isAggregateRoot) continue;
    const declares = [];
    if (entity.naturalKey?.length > 0) declares.push('naturalKey');
    if (entity.indexes?.length > 0) declares.push('indexes');
    if (declares.length === 0) continue;
    model.warnings.push(
      `persistence.entities.${entity.name}: declara ${declares.join(' y ')}, pero en el modelo documental ${entity.name} va anidada dentro del documento de ${entity.rootEntity} y no tiene colección propia. No se crea índice: la unicidad dentro del agregado es un invariante que hace cumplir la raíz (domain.invariants), no la base de datos.`
    );
  }
}

/** Valor de la condición como literal Java (una cadena va entrecomillada; un número o un booleano, no). */
function javaLiteral(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * Índices declarados por una entidad persistida, ya resueltos a rutas del documento.
 * Devuelve `[{ name, unique, paths, source }]` en el mismo orden en que build los
 * crea, que es el orden en que los lee el agente al verificarlos.
 */
export function indexSpecs(model, entity, warnings) {
  const members = persistedMembers(model, entity);
  const specs = [];

  if (entity.naturalKey?.length > 0) {
    specs.push({
      name: `uk_${entity.collectionName}_natural`,
      unique: true,
      paths: entity.naturalKey.flatMap((field) => documentPathsFor(model, entity, members, field, warnings)),
      source: 'naturalKey'
    });
  }
  for (const field of uniqueFields(entity)) {
    specs.push({
      name: `uk_${entity.collectionName}_${snakeCase(field.name)}`,
      unique: true,
      paths: documentPathsFor(model, entity, members, field.name, warnings),
      source: 'unique'
    });
  }
  for (const index of entity.indexes ?? []) {
    specs.push({
      name: indexName(entity, index),
      unique: index.unique,
      paths: index.fields.flatMap((field) => documentPathsFor(model, entity, members, field, warnings)),
      // La condición del diseño se traduce a partialFilterExpression, que es como
      // MongoDB expresa una unicidad condicionada al estado. La ruta del campo se
      // resuelve igual que la de los demás: en el documental un value object sigue
      // siendo un subdocumento, no columnas aplanadas.
      partialFilter: index.when
        ? {
            path: documentPathsFor(model, entity, members, index.when.field, warnings)[0],
            // El valor ALMACENADO, no el literal del diseño: Spring Data serializa un enum
            // por name(), igual que @Enumerated(EnumType.STRING) en la rama relacional, así
            // que un filtro con el literal no casaría con ningún documento y el índice
            // parcial no indexaría nada. Ver persistence-members.js § storedWhenValue.
            equals: storedWhenValue(model, entity, index.when)
          }
        : null,
      source: 'indexes'
    });
  }
  return specs;
}

/**
 * Nombre lógico del diseño (campo, relación, `relaciónId` o dot-path de un value
 * object) → rutas reales dentro del documento.
 *
 * Es el gemelo de columnsFor() de la rama relacional, y la diferencia es la que
 * define el modelo: allí un value object se APLANA a columnas con prefijo
 * (`price.amount` → `price_amount`), aquí sigue siendo un subdocumento y la ruta es
 * literal (`price.amount`). Y un dot-path a una entidad hija, que en JPA no era
 * indexable porque vivía en otra tabla, aquí sí lo es: la hija va anidada dentro
 * del mismo documento.
 */
export function documentPathsFor(model, entity, members, logicalName, warnings) {
  const [head, ...rest] = String(logicalName).split('.');
  const member = members.find(
    (m) => m.name === head || m.relation?.name === head || (m.relation && `${m.relation.name}Id` === head)
  );

  if (member?.kind === 'scalar') return [snakeCase(member.name)];
  if (member?.kind === 'elementCollection') {
    // Mongo indexa un array indexando cada uno de sus elementos (multikey), así que
    // la ruta es la del propio campo.
    return [snakeCase(member.name)];
  }
  if (member?.kind === 'externalRef') return [`${snakeCase(member.relation.name)}_id`];
  if (member?.kind === 'vo') {
    const sub = rest.length > 0 ? member.vo?.fields?.find((f) => f.name === rest[0]) : null;
    if (sub) return [`${snakeCase(member.name)}.${snakeCase(sub.name)}`];
    if (rest.length === 0 && member.vo?.fields?.length > 0) {
      return member.vo.fields.map((f) => `${snakeCase(member.name)}.${snakeCase(f.name)}`);
    }
  }
  if (member?.kind === 'relationOne' || member?.kind === 'relationMany') {
    // Entidad hija anidada: el dot-path atraviesa el array/subdocumento.
    if (rest.length > 0) return [`${snakeCase(member.name)}.${rest.map((part) => snakeCase(part)).join('.')}`];
    return [snakeCase(member.name)];
  }

  warnings?.push(
    `persistence.entities.${entity.name}: el índice declara "${logicalName}", que no es un campo ni una relación de la entidad; se usa "${snakeCase(head)}" tal cual y el índice puede no crearse.`
  );
  return [snakeCase(head)];
}

/**
 * Índices de las colecciones que no salen del diseño sino del mecanismo: el outbox,
 * los dos registros de idempotencia y el reclamo de la reconciliación. En la rama relacional los declara la propia
 * entidad JPA (@Index) o los crea la clave primaria; aquí hay que pedirlos.
 *
 * No llevan índice único ninguno: la unicidad de processed_event y de
 * idempotency_record ya la da su _id, que Mongo indexa siempre.
 */
function infrastructureIndexes(model) {
  const entries = [];
  if (usesOutbox(model)) {
    entries.push({
      collection: 'outbox_event',
      field: 'outboxIndexes',
      specs: [
        // El mismo orden de claves que consulta el reclamo del relay: pendientes
        // primero, y dentro de ellas por antigüedad.
        { name: 'ix_outbox_event_pending', unique: false, paths: ['published_at', 'created_at'] }
      ]
    });
  }
  if (usesIdempotency(model)) {
    entries.push({
      collection: 'processed_event',
      field: 'processedEventIndexes',
      specs: [{ name: 'ix_processed_event_processed_at', unique: false, paths: ['processed_at'] }]
    });
  }
  if (usesHttpIdempotency(model)) {
    entries.push({
      collection: 'idempotency_record',
      field: 'idempotencyRecordIndexes',
      specs: [{ name: 'ix_idempotency_record_expires_at', unique: false, paths: ['expires_at'] }]
    });
  }
  if (reconciliationClaims(model).length > 0) {
    entries.push({
      collection: 'reconciliation_claim',
      field: 'reconciliationClaimIndexes',
      // De la purga, no del reclamo: el reclamo va por _id, que Mongo indexa siempre.
      specs: [{ name: 'ix_reconciliation_claim_claimed_at', unique: false, paths: ['claimed_at'] }]
    });
  }
  return entries;
}

function renderIndexConfig(model) {
  const imports = new Set([
    'org.springframework.boot.ApplicationRunner',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    'org.springframework.data.domain.Sort',
    'org.springframework.data.mongodb.core.MongoTemplate',
    'org.springframework.data.mongodb.core.index.Index',
    'org.springframework.data.mongodb.core.index.IndexOperations'
  ]);

  const blocks = [];
  const collections = [
    ...model.entities
      .filter((e) => e.persisted && e.isAggregateRoot)
      .map((entity) => ({
        collection: entity.collectionName,
        field: `${entity.name[0].toLowerCase()}${entity.name.slice(1)}Indexes`,
        specs: indexSpecs(model, entity, model.warnings)
      })),
    // Colecciones de infraestructura. Sus índices no salen del diseño pero son igual
    // de necesarios: sin el del outbox, cada pasada del relay recorre la colección
    // entera para reclamar un lote; sin los de caducidad, las purgas hacen lo mismo.
    ...infrastructureIndexes(model)
  ].filter((entry) => entry.specs.length > 0);

  // Solo si algún índice lleva condición: importar PartialIndexFilter y Criteria
  // siempre dejaría dos imports sin usar en la mayoría de los proyectos.
  if (collections.some(({ specs }) => specs.some((spec) => spec.partialFilter))) {
    imports.add('org.springframework.data.mongodb.core.index.PartialIndexFilter');
    imports.add('org.springframework.data.mongodb.core.query.Criteria');
  }

  for (const { collection, field: indexField, specs } of collections) {
    const statements = specs.map((spec) => {
      const keys = spec.paths.map((path) => `\n                            .on("${path}", Sort.Direction.ASC)`).join('');
      const unique = spec.unique ? '\n                            .unique()' : '';
      // La unicidad condicionada: el índice existe solo para los documentos que
      // cumplen el filtro. Sin él, `.unique()` sobre esas claves prohibiría también
      // las versiones históricas, que es el invariante contrario al declarado.
      const partial = spec.partialFilter
        ? `\n                            .partial(PartialIndexFilter.of(Criteria.where("${spec.partialFilter.path}").is(${javaLiteral(spec.partialFilter.equals)})))`
        : '';
      return `            ${indexField}.createIndex(
                    new Index()${keys}${unique}${partial}
                            .named("${spec.name}"));`;
    });
    blocks.push(
      `            IndexOperations ${indexField} = mongoTemplate.indexOps("${collection}");\n` + statements.join('\n')
    );
  }

  const body = `/**
 * Índices de las colecciones del servicio, derivados de persistence.keel.yaml:
 * clave natural, campos únicos e índices declarados.
 *
 * Se crean explícitamente, no por anotación: \`auto-index-creation\` está apagada a
 * propósito (ver el fragmento db de la configuración). Los índices que Spring
 * infiere llevan el nombre que él decide, y el ApiExceptionHandler traduce una
 * violación de unicidad al error del diseño buscando AQUÍ el nombre —\`uk_*\`— dentro
 * del mensaje del driver.
 *
 * \`createIndex\` es idempotente mientras la definición no cambie, así que esto corre
 * en cada arranque sin efecto. Si un índice cambia de forma hay que borrarlo antes:
 * Mongo rechaza recrear el mismo nombre con otras claves.
 */
@Configuration
public class MongoIndexConfig {

    @Bean
    public ApplicationRunner ensureMongoIndexes(MongoTemplate mongoTemplate) {
        return args -> {
${blocks.join('\n\n')}
        };
    }
}`;

  return {
    path: javaPath(model, CONFIG_PKG, 'MongoIndexConfig'),
    content: javaFile(subPackage(model, CONFIG_PKG), [...imports], body)
  };
}

/**
 * Exporta los índices VIVOS de cada colección. Es el gemelo de export-schema.sh de
 * la rama relacional, con una diferencia que importa para el pipeline: aquí no hay
 * que arrancar la aplicación con un perfil aparte ni tocar la base, solo leer. Por
 * eso el agente de calidad sí puede ejecutar esta comprobación de verdad, mientras
 * que la del baseline relacional se queda en PENDING para el diseñador.
 */
function exportIndexesScript(model) {
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
#        y la aplicación haber arrancado al menos una vez (MongoIndexConfig crea los
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
        return { name: ix.name, key: ix.key, unique: ix.unique === true };
      });
    });
    print(JSON.stringify(out, null, 2));
  ' > "$OUT"

echo "Índices exportados a $OUT"
echo
echo "Qué contrastar (es la verificación, no una redacción: build ya generó los índices):"
echo "  1. Cada uk_*/idx_* de MongoIndexConfig aparece aquí, con las MISMAS claves y unique."
echo "  2. No sobra ninguno: un índice que no salga de MongoIndexConfig lo creó otra cosa,"
echo "     y su nombre no lo conoce el ApiExceptionHandler."
echo "  3. Cada naturalKey/unique/indexes de specs/persistence.keel.yaml tiene el suyo."
`;
}
