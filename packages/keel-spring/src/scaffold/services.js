// Capa application con patrón mediator (arquitectura del prototipo): por cada
// operación se genera su mensaje CQRS (record en application/commands o
// application/queries; los commands llevan la Bean Validation del diseño
// porque son el body HTTP) y su handler stub en application/usecases — aquí es
// donde el agente implementa la lógica. Los handlers dependen del PUERTO de
// dominio (domain/repository) y del mapper de aplicación, nunca del JPA.

import { javaFile, javaPath, subPackage, javadoc } from './render.js';
import { INTERFACES_PKG, ANNOTATIONS_PKG, MEDIATOR_PKG } from './mediator.js';
import { domainTypeImport } from './entities.js';

// Componentes del record mensaje: [id si la ruta lo lleva] + campos del body +
// paginación (queries). Compartidos con el controller para construir/fusionar.
export function messageComponents(model, operation) {
  const components = [];
  if (operation.hasIdParam) {
    components.push({ javaType: 'UUID', name: 'id', imports: ['java.util.UUID'], validation: [], kind: 'base' });
  }
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
  let returnType = operation.responseDto.name;
  if (operation.returnsList) returnType = `List<${returnType}>`;
  if (operation.paginated) returnType = `PagedResponse<${returnType}>`;
  return returnType;
}

// Imports que exige el tipo de retorno.
export function returnTypeImports(model, operation, imports) {
  const dtoPkg = subPackage(model, 'application.dtos');
  if (operation.responseDto) imports.add(`${dtoPkg}.${operation.responseDto.name}`);
  if (operation.returnsList) imports.add('java.util.List');
  if (operation.paginated) imports.add(`${dtoPkg}.PagedResponse`);
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

// Record del mensaje. Los commands llevan Bean Validation (son el body HTTP).
function renderMessage(model, operation) {
  const imports = new Set();
  const components = messageComponents(model, operation);
  const returnType = returnTypeOf(operation);
  returnTypeImports(model, operation, imports);
  const contracts = mediatorContracts(operation, returnType);
  imports.add(`${subPackage(model, INTERFACES_PKG)}.${contracts.messageBase}`);
  const validated = operation.messageKind !== 'query';

  const rendered = components.map((component) => {
    for (const name of component.imports) imports.add(name);
    const typeImport = domainTypeImport(model, component);
    if (typeImport) imports.add(typeImport);

    const annotations = [];
    if (validated) {
      for (const annotation of component.validation ?? []) {
        imports.add(`jakarta.validation.constraints.${annotation.slice(1).split('(')[0]}`);
        annotations.push(annotation);
      }
      if (component.kind === 'composite') {
        imports.add('jakarta.validation.Valid');
        annotations.push('@Valid');
      }
    }
    const prefix = annotations.length > 0 ? annotations.join(' ') + ' ' : '';
    return `        ${prefix}${component.javaType} ${component.name}`;
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
  const repositoryEntity = model.entities.find(
    (entity) => entity.name === service.entity && entity.persisted && entity.isAggregateRoot
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
    notes.push(`Idempotencia: keySource=${operation.idempotency.keySource}${operation.idempotency.ttlSeconds ? `, ttlSeconds=${operation.idempotency.ttlSeconds}` : ''}`);
  }
  if (operation.cache) {
    notes.push(`Caché: ttlSeconds=${operation.cache.ttlSeconds}, keyFields=[${operation.cache.keyFields.join(', ')}]`);
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
