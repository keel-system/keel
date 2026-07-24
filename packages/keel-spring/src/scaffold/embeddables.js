// Espejos @Embeddable de los value objects usados en colecciones (DSL 2.1 list).
// Un `@ElementCollection List<DiscountJpa>` necesita que DiscountJpa sea @Embeddable;
// viven en el mismo paquete que las entidades Jpa (infrastructure.persistence.entities).
// Los VOs que solo se usan sueltos en una entidad se siguen aplanando a columnas con
// prefijo en la propia Jpa (persistence-entities.js), sin pasar por aquí.

import { snakeCase } from '../lib/naming.js';
import { javaFile, javaPath, subPackage } from './render.js';
import { capitalize } from './entities.js';
import { JPA_PKG } from './persistence-entities.js';

export function generate(model) {
  if (!model.layersPresent.persistence) return [];
  return model.valueObjects.filter((vo) => vo.usedInCollection).map((vo) => renderEmbeddable(model, vo));
}

function renderEmbeddable(model, vo) {
  const imports = new Set(['jakarta.persistence.Embeddable']);
  const declarations = [];
  const accessors = [];

  const pushAccessor = (name, javaType) => {
    accessors.push(
      `    public ${javaType} get${capitalize(name)}() {\n        return ${name};\n    }`,
      `    public void set${capitalize(name)}(${javaType} ${name}) {\n        this.${name} = ${name};\n    }`
    );
  };

  for (const sub of vo.fields) {
    // Value object anidado: sin columna aplanada; lo completa el agente (paridad
    // con el trato del VO anidado en persistence-entities.js).
    if (sub.kind === 'composite') {
      declarations.push(
        `    // TODO (agente): ${vo.name}.${sub.name} es un value object anidado; mapéalo con @Embedded o columnas (ver skill keel-spring-database).`
      );
      continue;
    }
    for (const name of sub.imports) imports.add(name);
    const lines = [];
    if (sub.kind === 'enum') {
      imports.add('jakarta.persistence.Enumerated');
      imports.add('jakarta.persistence.EnumType');
      imports.add(`${subPackage(model, 'domain.enums')}.${sub.javaType}`);
      lines.push('    @Enumerated(EnumType.STRING)');
    }
    imports.add('jakarta.persistence.Column');
    lines.push(`    @Column(name = "${snakeCase(sub.name)}")`);
    lines.push(`    private ${sub.javaType} ${sub.name};`);
    declarations.push(lines.join('\n'));
    pushAccessor(sub.name, sub.javaType);
  }

  const body = `@Embeddable
public class ${vo.name}Jpa {

${declarations.join('\n\n')}

${accessors.join('\n\n')}
}`;

  return {
    path: javaPath(model, JPA_PKG, `${vo.name}Jpa`),
    content: javaFile(subPackage(model, JPA_PKG), [...imports], body)
  };
}
