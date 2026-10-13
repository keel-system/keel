// Enums del dominio: nominales, inline y de lifecycle.
//
// Un enum de C# cuyo miembro es el valor del diseño en PascalCase (`in-review` → `InReview`) y que
// declara con [JsonStringEnumMemberName] el VALOR que viaja: el contrato del cable dice que un enum
// viaja por su valor, tal cual. Es el papel del `@JsonValue` de keel-spring y del enum de cadenas de
// keel-nest. El atributo es de System.Text.Json, de la biblioteca base: el dominio sigue sin framework.

import { enumMember } from '../lib/cs-projection.js';
import { csFile, csString, located, xmlDoc } from './render.js';

export function generate(model) {
  return (model.enums ?? []).map((enumDef) => {
    const { namespace, path } = located(model, 'enums', enumDef.name);
    const members = enumDef.values.map(({ literal }) => `    [JsonStringEnumMemberName(${csString(literal)})]\n    ${enumMember(literal)},`);
    const body = `${xmlDoc(enumDef.description)}public enum ${enumDef.name}\n{\n${members.join('\n')}\n}`;
    return { path, content: csFile({ namespace, usings: ['System.Text.Json.Serialization'], body }) };
  });
}

/** El miembro C# de una constante de enum del modelo (`DRAFT`), buscando su valor en la definición. */
export function memberOf(model, enumName, constant) {
  const value = (model.enums ?? []).find((e) => e.name === enumName)?.values.find((v) => v.constant === constant);
  return enumMember(value ? value.literal : constant);
}
