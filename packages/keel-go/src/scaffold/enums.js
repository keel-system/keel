// Enums del dominio: nominales, inline y de lifecycle.
//
// Un enum es un `type X string` con una constante por valor (`ProductStatusDraft ProductStatus = "draft"`): el
// contrato del cable dice que un enum viaja por su valor, tal cual, y un tipo cadena lo escribe así sin nada
// más. Lo que la cadena no da es el rechazo: `ParseX` y `UnmarshalText` solo admiten los valores del diseño,
// así que uno de fuera es un error de dominio (ErrInvalidValue) venga del cable, de la base o de la ruta. Es el
// papel del `@JsonValue` de keel-spring, del enum de cadenas de keel-nest y del [JsonStringEnumMemberName] de
// keel-dotnet.

import { enumConstant } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { docComment, domainPath, layout, packageFile } from './render.js';

export function generate(model) {
  const { domain } = layout(model);
  return (model.enums ?? []).map((enumDef) => ({
    path: domainPath(model, enumDef.name),
    content: packageFile(model, domain, { imports: [], body: enumBody(enumDef) })
  }));
}

/** La constante Go de una constante de enum del modelo (`DRAFT`), buscando su valor en la definición. */
export function constantOf(model, enumName, constant) {
  const value = (model.enums ?? []).find((e) => e.name === enumName)?.values.find((v) => v.constant === constant);
  return enumConstant(enumName, value ? value.literal : constant);
}

function enumBody(enumDef) {
  const { name, values } = enumDef;
  const receiver = name[0].toLowerCase();
  // Cada constante lleva su comentario, que corta la alineación de gofmt: cada una es su propia sección.
  const constants = alignRows(
    values.flatMap(({ literal }) => [
      { text: `\t// ${enumConstant(name, literal)} es ${goString(literal)}.` },
      { indent: '\t', cells: [enumConstant(name, literal), `${name} = ${goString(literal)}`] }
    ])
  );
  const arms = values.map(({ literal }) => enumConstant(name, literal)).join(', ');
  return `
${docComment(name, enumDef.description, `enum ${name} del diseño`)}type ${name} string

const (
${constants.join('\n')}
)

// Parse${name} lee un ${name} de su valor: solo admite los del diseño.
func Parse${name}(text string) (${name}, error) {
	switch v := ${name}(text); v {
	case ${arms}:
		return v, nil
	}
	return "", Errorf(ErrInvalidValue, "%q no es un valor de ${name}", text)
}

// UnmarshalText lee el valor del cable, de la ruta o de la base con Parse${name}.
func (${receiver} *${name}) UnmarshalText(text []byte) error {
	v, err := Parse${name}(string(text))
	if err != nil {
		return err
	}
	*${receiver} = v
	return nil
}
`;
}
