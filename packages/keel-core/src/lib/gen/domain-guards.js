// Los campos cuyo FORMATO tiene que hacer cumplir alguien después de normalizar (keel-core/gen).
//
// La validación de entrada deja caer a propósito el formato heredado de un value type ESCALAR: el
// formato describe el valor YA normalizado y la validación del borde corre antes de que nadie
// normalice. build genera la clase `<Tipo>Format` con la regex del diseño, pero la LLAMADA es del
// agente, y cada generador emite un gate (`infra/check-domain-guards.sh`) que comprueba que existe.
// Las filas de ese gate son una decisión del diseño, la misma para cualquier lenguaje: si cada
// generador las derivara por su cuenta, un servidor vigilaría campos que el otro no.
//
// Una fila por (entidad, campo) y no por tipo, porque es el campo el que se escapa: `EmailAddress`
// estaba comprobado en `Application` y sin comprobar en `SuppressedAddress`, y una fila por tipo
// habría salido verde con el primero.

export function guardedFields(model) {
  const declared = new Set((model.formatTypes ?? []).map((type) => type.name));
  const rows = [];
  for (const entity of model.entities ?? []) {
    for (const field of entity.fields ?? []) {
      if (!field.inheritedPattern || !field.typeName) continue;
      if (!declared.has(field.typeName)) continue;
      rows.push({ entity: entity.name, field: field.name, type: field.typeName });
    }
  }
  return rows;
}
