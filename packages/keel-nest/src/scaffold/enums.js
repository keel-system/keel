// Enums del dominio: nominales, inline y de lifecycle.
//
// Un `enum` de cadenas de TypeScript cuyo VALOR es el literal exacto del diseño: el contrato del
// cable dice que un enum viaja por su valor (`draft`, no `DRAFT`), y así lo escribe JSON.stringify
// sin serializador propio — el mismo papel que el `@JsonValue` de keel-spring.

import { DIRS, classPath, tsModule, tsdoc, tsString } from './render.js';

export function generate(model) {
  return (model.enums ?? []).map((enumDef) => {
    const constants = enumDef.values.map(({ constant, literal }) => `  ${constant} = ${tsString(literal)}`).join(',\n');
    const file = classPath(DIRS.enums, enumDef.name);
    return { path: file, content: tsModule(file, [], `${tsdoc(enumDef.description)}export enum ${enumDef.name} {\n${constants}\n}`) };
  });
}
