// Espejos documentales de los value objects (XxxDocument), en el mismo paquete que
// los documentos de entidad.
//
// Dos diferencias con embeddables.js, y las dos salen de lo mismo —en Mongo un value
// object es un objeto de verdad, no columnas aplanadas—:
//
//  1. Se generan TODOS los value objects que alcanza una entidad persistida, no solo
//     los usados en colecciones: en la rama relacional un VO suelto se aplana a
//     columnas dentro de la propia Jpa y no necesita clase; aquí siempre es un
//     subdocumento.
//  2. Un value object DENTRO de otro se resuelve solo, recursivamente. Es el caso
//     que en JPA deja un `// TODO (agente)` abierto (no hay columna que aplanar para
//     `location.coords.lat`) y que aquí no requiere ninguna decisión: un objeto
//     dentro de otro objeto.

import { snakeCase } from '../lib/naming.js';
import { documentAnnotations, needsFieldType } from '../lib/type-mapper.js';
import { javaFile, javaPath, subPackage } from './render.js';
import { capitalize } from './entities.js';
import { DOC_PKG } from './document-entities.js';

export function generate(model) {
  if (!model.layersPresent.persistence || model.persistenceKind !== 'document') return [];
  return [...documentValueObjects(model)].map((vo) => renderVoDocument(model, vo));
}

/**
 * Value objects que necesitan espejo documental: los que alcanza cualquier campo de
 * una entidad persistida, transitivamente a través de los value objects anidados.
 * Devuelve un Set con orden de descubrimiento estable (el de las entidades).
 */
export function documentValueObjects(model) {
  const byName = new Map(model.valueObjects.map((vo) => [vo.name, vo]));
  const reached = new Set();

  const visit = (name) => {
    const vo = byName.get(name);
    if (!vo || reached.has(vo)) return;
    reached.add(vo);
    for (const sub of vo.fields) {
      if (sub.kind === 'composite') visit(sub.javaType);
    }
  };

  for (const entity of model.entities.filter((e) => e.persisted)) {
    for (const field of entity.fields) {
      if (field.kind !== 'composite') continue;
      visit(field.list ? field.elementJavaType : field.javaType);
    }
  }
  return reached;
}

function renderVoDocument(model, vo) {
  const imports = new Set(['org.springframework.data.mongodb.core.mapping.Field']);
  const declarations = [];
  const accessors = [];

  for (const sub of vo.fields) {
    const lines = [];
    if (sub.kind === 'composite') {
      // Value object anidado: otro subdocumento, generado por esta misma pasada.
      const nestedDoc = `${sub.javaType}Document`;
      lines.push(`    @Field(name = "${snakeCase(sub.name)}")`, `    private ${nestedDoc} ${sub.name};`);
      declarations.push(lines.join('\n'));
      pushAccessor(accessors, sub.name, nestedDoc);
      continue;
    }
    for (const name of sub.imports) imports.add(name);
    if (sub.kind === 'enum') imports.add(`${subPackage(model, 'domain.enums')}.${sub.javaType}`);
    if (needsFieldType(sub.base)) imports.add('org.springframework.data.mongodb.core.mapping.FieldType');
    for (const annotation of documentAnnotations(sub.name, sub.base)) lines.push(`    ${annotation}`);
    lines.push(`    private ${sub.javaType} ${sub.name};`);
    declarations.push(lines.join('\n'));
    pushAccessor(accessors, sub.name, sub.javaType);
  }

  const body = `/** Espejo documental del value object ${vo.name}: subdocumento anidado. */
public class ${vo.name}Document {

${declarations.join('\n\n')}

${accessors.join('\n\n')}
}`;

  return {
    path: javaPath(model, DOC_PKG, `${vo.name}Document`),
    content: javaFile(subPackage(model, DOC_PKG), [...imports], body)
  };
}

function pushAccessor(accessors, name, javaType) {
  accessors.push(
    `    public ${javaType} get${capitalize(name)}() {\n        return ${name};\n    }`,
    `    public void set${capitalize(name)}(${javaType} ${name}) {\n        this.${name} = ${name};\n    }`
  );
}
