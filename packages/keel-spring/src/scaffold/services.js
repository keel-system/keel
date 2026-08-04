// Capa application con patrón mediator (arquitectura del prototipo): por cada
// operación se genera su mensaje CQRS (record en application/commands o
// application/queries; los commands llevan la Bean Validation del diseño
// porque son el body HTTP) y su handler stub en application/usecases — aquí es
// donde el agente implementa la lógica. Los handlers dependen del PUERTO de
// dominio (domain/repository) y del mapper de aplicación, nunca del JPA.

import { javaFile, javaPath, subPackage, javadoc } from './render.js';
import { INTERFACES_PKG, ANNOTATIONS_PKG, MEDIATOR_PKG } from './mediator.js';
import { domainTypeImport } from './entities.js';
import { refTargetsOf } from './ref-resolvers.js';

// Componentes del record mensaje: parámetros de ruta (en el orden del path) +
// campos del body + paginación (queries). Compartidos con el controller para
// construir/fusionar el mensaje.
export function messageComponents(model, operation) {
  const components = [];
  for (const param of operation.pathParams ?? []) components.push(param);
  for (const field of operation.bodyFields) components.push(field);
  if (operation.paginated) {
    if (model.layersPresent.persistence) {
      components.push({
        javaType: 'Pageable',
        name: 'pageable',
        imports: ['org.springframework.data.domain.Pageable'],
        validation: [],
        kind: 'base'
      });
    } else {
      components.push({ javaType: 'int', name: 'page', imports: [], validation: [], kind: 'base' });
      components.push({ javaType: 'int', name: 'size', imports: [], validation: [], kind: 'base' });
    }
  }
  return components;
}

// Tipo de retorno de la operación (compartido con controller y handler).
export function returnTypeOf(operation) {
  if (!operation.responseDto) return 'void';
  // PagedResponse<T> ya es la envoltura de la lista: envolver además en List<>
  // produciría PagedResponse<List<Dto>> y rompería a cualquier cliente.
  if (operation.paginated) return `PagedResponse<${operation.responseDto.name}>`;
  if (operation.returnsList) return `List<${operation.responseDto.name}>`;
  return operation.responseDto.name;
}

// Imports que exige el tipo de retorno.
export function returnTypeImports(model, operation, imports) {
  const dtoPkg = subPackage(model, 'application.dtos');
  if (operation.responseDto) imports.add(`${dtoPkg}.${operation.responseDto.name}`);
  if (operation.paginated) imports.add(`${dtoPkg}.PagedResponse`);
  else if (operation.returnsList) imports.add('java.util.List');
}

export function generate(model) {
  const files = [];
  for (const service of model.services) {
    for (const operation of service.operations) {
      files.push(renderMessage(model, operation));
      files.push(renderHandler(model, service, operation));
    }
    const scheduled = service.operations.filter((operation) => operation.schedule);
    if (scheduled.length > 0) files.push(renderScheduler(model, service, scheduled));
  }
  return files;
}

// Interfaz de mensaje y de handler según el messageKind de la operación.
export function mediatorContracts(operation, returnType) {
  const contracts = {
    query: { message: `Query<${returnType}>`, messageBase: 'Query', handler: `QueryHandler<${operation.messageClass}, ${returnType}>`, handlerBase: 'QueryHandler' },
    returningCommand: { message: `ReturningCommand<${returnType}>`, messageBase: 'ReturningCommand', handler: `ReturningCommandHandler<${operation.messageClass}, ${returnType}>`, handlerBase: 'ReturningCommandHandler' },
    command: { message: 'Command', messageBase: 'Command', handler: `CommandHandler<${operation.messageClass}>`, handlerBase: 'CommandHandler' }
  };
  return contracts[operation.messageKind];
}

export function messagePackage(operation) {
  return operation.messageKind === 'query' ? 'application.queries' : 'application.commands';
}

/**
 * ¿La operación es una actualización parcial (PATCH)? En ese caso un campo
 * opcional del cuerpo tiene TRES estados que el contrato distingue: ausente
 * (conserva el valor actual), presente con null (vacía el campo) y presente con
 * valor. Un tipo plano colapsa los dos primeros, así que los campos opcionales
 * se declaran JsonNullable<T>.
 */
export function isPartialUpdate(operation) {
  return operation.route?.method === 'PATCH';
}

// Campos del cuerpo de un PATCH que van envueltos en JsonNullable<T>.
export function partialUpdateFields(operation) {
  if (!isPartialUpdate(operation)) return [];
  return operation.bodyFields.filter((field) => !field.required && !field.file);
}

// ¿Algún mensaje del servicio usa JsonNullable? Decide la dependencia gradle y
// el módulo Jackson + value extractor que la hacen funcionar.
export function usesPartialUpdate(model) {
  return model.services.some((service) =>
    service.operations.some((operation) => partialUpdateFields(operation).length > 0)
  );
}

export const JSON_NULLABLE_IMPORT = 'org.openapitools.jackson.nullable.JsonNullable';

function partialUpdateType(operation, component, fromPath, imports) {
  if (!isPartialUpdate(operation) || fromPath.has(component.name)) return component.javaType;
  if (component.required || component.file) return component.javaType;
  if (!operation.bodyFields.some((field) => field.name === component.name)) return component.javaType;
  imports.add(JSON_NULLABLE_IMPORT);
  return `JsonNullable<${component.javaType}>`;
}

// Record del mensaje. Lleva la Bean Validation de las constraints del diseño, sea
// command o query: una query también puede ser el body HTTP (una consulta en lote
// viaja en POST y se bindea con @Valid @RequestBody), y cuando se bindea por
// @RequestParam las anotaciones no llegan a evaluarse pero documentan el contrato
// —la validación efectiva de ese caso la ponen los @RequestParam del controller.
function renderMessage(model, operation) {
  const imports = new Set();
  const components = messageComponents(model, operation);
  const returnType = returnTypeOf(operation);
  returnTypeImports(model, operation, imports);
  const contracts = mediatorContracts(operation, returnType);
  imports.add(`${subPackage(model, INTERFACES_PKG)}.${contracts.messageBase}`);
  // Los componentes que vienen de la ruta NUNCA se validan aquí: el cliente no
  // los manda en el cuerpo (van en el path) y el controller los sobrescribe al
  // reconstruir el record. Un @NotNull sobre ellos rechaza con 422 toda petición
  // correcta, sin importar el contenido enviado.
  const fromPath = new Set((operation.pathParams ?? []).map((param) => param.name));

  const rendered = components.map((component) => {
    for (const name of component.imports) imports.add(name);
    const typeImport = domainTypeImport(model, component);
    if (typeImport) imports.add(typeImport);

    const annotations = [];
    if (!fromPath.has(component.name)) {
      // Entrada: sin el formato heredado del value type, que el diseño puede estar
      // normalizando en el handler (mapping.md § Normalización antes que validación
      // de formato). Presencia, tamaño y rango sí se quedan: no compiten con
      // ninguna normalización.
      for (const annotation of component.inputValidation ?? component.validation ?? []) {
        imports.add(`jakarta.validation.constraints.${annotation.slice(1).split('(')[0]}`);
        annotations.push(annotation);
      }
      if (component.kind === 'composite') {
        imports.add('jakarta.validation.Valid');
        annotations.push('@Valid');
      }
    }
    const prefix = annotations.length > 0 ? annotations.join(' ') + ' ' : '';
    const javaType = partialUpdateType(operation, component, fromPath, imports);
    return `        ${prefix}${javaType} ${component.name}`;
  });

  const componentBlock = rendered.length > 0 ? `\n${rendered.join(',\n')}\n` : '';
  const body = `${javadoc(operation.description, '')}public record ${operation.messageClass}(${componentBlock}) implements ${contracts.message} {
}`;

  return {
    path: javaPath(model, messagePackage(operation), operation.messageClass),
    content: javaFile(subPackage(model, messagePackage(operation)), [...imports], body)
  };
}

// Handler de la operación: stub con las notas del diseño; lo implementa el
// agente. Inyecta el puerto de dominio del agregado y el mapper si aplican.
function renderHandler(model, service, operation) {
  // Sin imports de Spring: @ApplicationComponent es propia y la transacción la
  // abre el UseCaseMediator (Query→readOnly, Command→escritura).
  const imports = new Set([`${subPackage(model, ANNOTATIONS_PKG)}.ApplicationComponent`]);
  const returnType = returnTypeOf(operation);
  returnTypeImports(model, operation, imports);
  const contracts = mediatorContracts(operation, returnType);
  imports.add(`${subPackage(model, INTERFACES_PKG)}.${contracts.handlerBase}`);
  imports.add(`${subPackage(model, messagePackage(operation))}.${operation.messageClass}`);

  const dependencies = [];
  const targetEntity = model.entities.find((entity) => entity.name === service.entity);
  const repositoryEntity = model.entities.find(
    (entity) =>
      entity.name === (targetEntity?.rootEntity ?? service.entity) && entity.persisted && entity.isAggregateRoot
  );
  if (repositoryEntity) {
    const port = `${repositoryEntity.name}Repository`;
    imports.add(`${subPackage(model, 'domain.repository')}.${port}`);
    dependencies.push({ type: port, name: port[0].toLowerCase() + port.slice(1) });
  }
  if (operation.responseDto?.entity && model.entities.some((e) => e.name === operation.responseDto.entity)) {
    const mapper = `${operation.responseDto.entity}ApplicationMapper`;
    imports.add(`${subPackage(model, 'application.mappers')}.${mapper}`);
    dependencies.push({ type: mapper, name: mapper[0].toLowerCase() + mapper.slice(1) });
  }
  // Referencias embebidas (`embed`): el mapper las exige por parámetro y el
  // agregado solo guarda el id ajeno, así que sin el resolver el handler ni
  // siquiera compila. Se inyecta el resolver —nunca el repositorio de la otra
  // raíz— porque es lo que resuelve por lote (conventions/read-composition.md).
  const embedded = refTargetsOf(model, operation);
  for (const { entity } of embedded) {
    const resolver = `${entity.name}RefResolver`;
    imports.add(`${subPackage(model, 'application.support')}.${resolver}`);
    dependencies.push({ type: resolver, name: resolver[0].toLowerCase() + resolver.slice(1) });
  }
  // El handler NO publica eventos: los emite el agregado con raise(...) y el
  // adaptador de repositorio los drena al persistir (conventions/domain-modeling.md).

  let fields = '';
  let constructor = '';
  if (dependencies.length > 0) {
    fields = '\n' + dependencies.map((dep) => `    private final ${dep.type} ${dep.name};`).join('\n') + '\n';
    const params = dependencies.map((dep) => `${dep.type} ${dep.name}`).join(', ');
    const assigns = dependencies.map((dep) => `        this.${dep.name} = ${dep.name};`).join('\n');
    constructor = `\n    public ${operation.handlerClass}(${params}) {\n${assigns}\n    }\n`;
  }

  const annotations = ['    @Override'];
  imports.add(`${subPackage(model, ANNOTATIONS_PKG)}.LogExceptions`);
  annotations.push('    @LogExceptions');

  const notes = [];
  for (const text of operation.preconditions) notes.push(`Precondición: ${text}`);
  for (const text of operation.rules) notes.push(`Regla (en orden): ${text}`);
  for (const code of operation.errors) {
    const error = model.errors.find((e) => e.code === code);
    notes.push(`Error: lanzar ${error?.exceptionClass ?? code} (${code}, HTTP ${error?.http ?? 400})${error?.when ? ` cuando: ${error.when}` : ''}`);
  }
  for (const eventName of operation.emits) {
    const event = (model.events ?? []).find((e) => e.name === eventName);
    notes.push(
      `Emite: ${eventName} — lo hace ${event?.aggregate ?? 'el agregado'} con raise(${event?.className ?? `${eventName}Event`}.of(...)) dentro del método de negocio; el handler no publica nada`
    );
  }
  if (operation.idempotency) {
    const ttl = operation.idempotency.ttlSeconds ?? 86400;
    notes.push(
      `Idempotencia: keySource=${operation.idempotency.keySource}, ttlSeconds=${ttl}. El puerto IdempotencyStore y su adaptador ya están generados — NO escribas otro registro (ni tabla propia, ni SET NX en la caché). La clave llega por IdempotencyContext.get() (vacío = el cliente no mandó la cabecera: ejecuta sin deduplicar, no rechaces). Si hay clave: find(scope, clave) con scope="${operation.name}"; si hay registro con la MISMA firma, reconstruye la respuesta desde su resourceId sin re-ejecutar nada (ni escrituras ni eventos); si la firma difiere, lanza el error que el diseño declare para ese caso; si no hay registro, ejecuta y llama a save(...) dentro de la misma transacción del comando`
    );
  }
  if (operation.cache) {
    notes.push(`Caché: ttlSeconds=${operation.cache.ttlSeconds}, keyFields=[${operation.cache.keyFields.join(', ')}]`);
  }
  // Ordenar por un campo de otro agregado es el único caso en que la resolución
  // por lote no basta: no se pagina en BD por una columna ausente de la consulta
  // madre. Aquí el agente necesita saberlo antes de escribir nada.
  for (const criterion of operation.sort ?? []) {
    if (!criterion.embedded) continue;
    notes.push(
      `Orden: el diseño ordena por '${criterion.path}', campo del agregado embebido — el lote no puede ordenar por él. Hace falta un adaptador de LECTURA con JPQL proyectado (left join sobre la columna id), no el repositorio del agregado: skills/keel-spring-database/references/read-queries.md`
    );
  }
  // El patrón se escribe entero en el stub porque es donde el agente decide, y
  // la diferencia entre lote y bucle no se ve en el resultado: solo en el número
  // de consultas (100 elementos × 2 embeds = 201 vs. 3).
  for (const { entity, ref } of embedded) {
    const resolver = `${entity.name[0].toLowerCase()}${entity.name.slice(1)}RefResolver`;
    if (operation.paginated || operation.returnsList) {
      notes.push(
        `Embed ${entity.name}: resolver por LOTE — recoge los ${entity.name[0].toLowerCase()}${entity.name.slice(1)}Id distintos de la página, una sola llamada a ${resolver}.resolve(ids) y ${ref.name} = map.get(id) al mapear cada elemento. NUNCA findById dentro del stream: es un N+1 (conventions/read-composition.md)`
      );
    } else {
      notes.push(
        `Embed ${entity.name}: ${ref.name} = ${resolver}.resolve(<id>) (conventions/read-composition.md)`
      );
    }
  }
  const noteLines = notes.map((note) => `        // ${note}`);

  const paramName = operation.messageKind === 'query' ? 'query' : 'command';
  const handleReturn = operation.messageKind === 'command' ? 'void' : returnType;
  const body = `${javadoc(operation.description, '')}@ApplicationComponent
public class ${operation.handlerClass} implements ${contracts.handler} {
${fields}${constructor}
${annotations.join('\n')}
    public ${handleReturn} handle(${operation.messageClass} ${paramName}) {
        // TODO (agente): implementar la lógica de negocio de esta operación.
${noteLines.length > 0 ? noteLines.join('\n') + '\n' : ''}        throw new UnsupportedOperationException("TODO: ${operation.name}");
    }
}`;

  return {
    path: javaPath(model, 'application.usecases', operation.handlerClass),
    content: javaFile(subPackage(model, 'application.usecases'), [...imports], body)
  };
}

function renderScheduler(model, service, scheduled) {
  const className = service.className.replace(/Service$/, 'Scheduler');
  const imports = new Set([
    `${subPackage(model, MEDIATOR_PKG)}.UseCaseMediator`,
    'org.springframework.scheduling.annotation.Scheduled',
    'org.springframework.stereotype.Component'
  ]);

  const methods = scheduled.map((operation) => {
    const description = operation.schedule.description ? `${javadoc(operation.schedule.description, '    ')}` : '';
    const components = messageComponents(model, operation);
    let call;
    if (components.length === 0) {
      imports.add(`${subPackage(model, messagePackage(operation))}.${operation.messageClass}`);
      call = `mediator.dispatch(new ${operation.messageClass}());`;
    } else {
      call = `// TODO (agente): el mensaje requiere argumentos; construirlos aquí.
        throw new UnsupportedOperationException("TODO: despachar ${operation.messageClass} desde el scheduler");`;
    }
    // El DSL usa cron de 5 campos; Spring añade el campo de segundos al inicio.
    return `${description}    @Scheduled(cron = "0 ${operation.schedule.cron}")
    public void ${operation.name}() {
        ${call}
    }`;
  });

  const body = `@Component
public class ${className} {

    private final UseCaseMediator mediator;

    public ${className}(UseCaseMediator mediator) {
        this.mediator = mediator;
    }

${methods.join('\n\n')}
}`;

  // El scheduler es un adaptador de entrada (timer): vive en infraestructura.
  return {
    path: javaPath(model, 'infrastructure.scheduling', className),
    content: javaFile(subPackage(model, 'infrastructure.scheduling'), [...imports], body)
  };
}
