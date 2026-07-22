// Eventos de dominio (messaging.publishing.events → domain/events): records
// inmutables con el payload del diseño. El nombre del evento es contrato
// público; el record añade el sufijo Event.

import { javaFile, javaPath, subPackage, javadoc } from './render.js';
import { domainTypeImport } from './entities.js';

const EVENTS_PKG = 'domain.events';

export function generate(model) {
  return model.events.map((event) => {
    const imports = new Set();
    const components = event.fields.map((field) => {
      for (const name of field.imports) imports.add(name);
      const typeImport = domainTypeImport(model, field);
      if (typeImport) imports.add(typeImport);
      return `${field.javaType} ${field.name}`;
    });

    const body = `${javadoc(event.description ?? `Evento ${event.name} del diseño.`)}public record ${event.className}(${components.join(', ')}) {
}`;

    return {
      path: javaPath(model, EVENTS_PKG, event.className),
      content: javaFile(subPackage(model, EVENTS_PKG), [...imports], body)
    };
  });
}
