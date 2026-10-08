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

import { javaFile, javaPath, subPackage } from './render.js';
import {
  documentIndexSpecs,
  documentIndexes,
  documentPathsFor,
  nestedIndexWarnings,
  partialDocumentIndexSpecs as neutralPartialSpecs,
  exportIndexesScript as neutralExportIndexesScript,
  INDEX_EXPORT_FILE
} from 'keel-core/gen/document';

// Qué índices hay, sobre qué rutas, con qué nombre y con qué filtro parcial es una lectura del
// diseño que comparte keel-nest (`keel-core/gen/document.js`); aquí solo se escribe como Java.
export { documentPathsFor, INDEX_EXPORT_FILE };

const CONFIG_PKG = 'infrastructure.persistence.config';

export function generate(model) {
  if (!model.layersPresent.persistence || model.persistenceKind !== 'document') return [];
  // Una entidad interna no tiene colección propia: su clave natural o sus índices no se pueden
  // crear como tales, y se dice dónde queda la garantía.
  model.warnings.push(...nestedIndexWarnings(model));
  return [
    renderIndexConfig(model),
    {
      path: 'infra/export-indexes.sh',
      content: neutralExportIndexesScript(model, { indexCreator: 'MongoIndexConfig', errorTranslator: 'ApiExceptionHandler' })
    }
  ];
}

/** Valor de la condición como literal Java (una cadena va entrecomillada; un número o un booleano, no). */
function javaLiteral(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** Índices declarados por una entidad persistida, ya resueltos a rutas del documento. */
export function indexSpecs(model, entity, warnings) {
  return documentIndexSpecs(model, entity, warnings);
}

/**
 * Los índices condicionados del diseño, resueltos a colección, rutas y filtro parcial, más la clase
 * del espejo, que necesita el caso de `index-check` que SÍ pasa por el mapeo (los demás insertan
 * BSON crudo y no la tocan).
 */
export function partialDocumentIndexSpecs(model) {
  return neutralPartialSpecs(model).map(({ entity, ...spec }) => ({ entity, documentClass: `${entity}Document`, ...spec }));
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
  // Las colecciones de los almacenes también: sin el índice del outbox cada pasada del relay
  // recorre la colección entera para reclamar un lote; sin los de caducidad, las purgas igual.
  const collections = documentIndexes(model).map(({ entity, store, collection, specs }) => ({
    collection,
    field: entity ? `${entity[0].toLowerCase()}${entity.slice(1)}Indexes` : `${store}Indexes`,
    specs
  }));

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
