// La autorización por propietario (`security.ownership`, DSL 2.23): neutral, la misma nota en keel-spring, keel-nest y
// keel-dotnet.
//
// «Solo el autor edita o borra su artículo» no se podía declarar: `scoping` acota por un claim del token, no por un campo
// del recurso. El inc. 1 de keel-recover lo encontró sobre RealWorld (conduit) y el agente de la generación implementó el
// 403 solo porque los escenarios lo pedían, dejándolo como designGap. Ahora el diseño dice de qué entidad, por qué camino
// se llega a su dueño y con qué code se rechaza; lo que queda es lógica del handler —cargar el recurso en el orden de sus
// reglas y comparar—, y build le deja la nota con todo eso para que no lo adivine. Por eso no hay pieza ejecutable aquí:
// la comparación vive donde se carga el agregado, y cada operación lo carga a su manera.

/** Las reglas de propiedad que exigen ESTA operación (una por entidad; normalmente una sola). */
export function ownershipRulesOf(model, operation) {
  return (model.security?.ownership ?? []).filter((rule) => rule.operations.includes(operation.name));
}

/**
 * Las notas del handler de una operación acotada por propietario, una por regla. `read(field)` es cómo se lee en el
 * lenguaje del generador el campo del mensaje que lleva la identidad del llamante (`command.callerSubject()`,
 * `command.callerSubject`, `command.CallerSubject`).
 */
export function ownershipNotes(model, operation, { read }) {
  const caller = model.security?.callerIdentity?.field;
  if (!caller) return [];
  return ownershipRulesOf(model, operation).map((rule) => {
    const path = rule.relations.length
      ? `sigue ${rule.relations.join(' → ')} hasta ${rule.field} (${rule.owner})`
      : `su campo ${rule.field}`;
    const exempt = rule.exemptRoles.length
      ? ` Exentos, que operan sobre cualquier ${rule.entity}: ${rule.exemptRoles.map((role) => `el rol ${role}`).join(', ')}.`
      : '';
    return (
      `Propiedad (security.ownership.${rule.entity}): solo el dueño del ${rule.entity} ejecuta esta operación. Carga el ` +
      `${rule.entity} en el orden que dicen las reglas (si no existe, su error de no encontrado), ${path} y compáralo ` +
      `con ${read(caller)}, la identidad que estampó el servidor desde la credencial —nunca con nada del cuerpo—; si no ` +
      `coincide, ${rule.error} (403), antes de cambiar nada.${exempt}`
    );
  });
}
