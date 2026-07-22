// Enums de domain: nominales, inline y de lifecycle, preservando el literal
// exacto del diseño en el contrato JSON (@JsonValue).

import { javaFile, javaPath, subPackage, javadoc } from './render.js';

export function generate(model) {
  return model.enums.map((enumDef) => {
    const constants = enumDef.values.map(({ constant, literal }) => `    ${constant}("${literal}")`).join(',\n');
    const body = `${javadoc(enumDef.description)}public enum ${enumDef.name} {

${constants};

    private final String value;

    ${enumDef.name}(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }
}`;

    return {
      path: javaPath(model, 'domain.enums', enumDef.name),
      content: javaFile(subPackage(model, 'domain.enums'), ['com.fasterxml.jackson.annotation.JsonValue'], body)
    };
  });
}
