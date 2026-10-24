// La capa de aplicación con el patrón mediator: por cada operación, su mensaje CQRS (Application/Commands o
// Application/Queries) y su handler en Application/UseCases, que es donde el agente implementa la lógica. El
// mismo reparto que keel-spring y keel-nest.
//
// El mensaje es una clase inmutable con propiedades `required`: con muchos campos, una lista posicional se
// desordena sin que el compilador lo note si dos comparten tipo, y `required` obliga a quien lo construye a
// decidir cada valor, también el null. Es clase y no record a propósito: el ToString de un record imprime
// todos los valores, y un comando lleva datos de quien llama.
//
// El handler nace con las notas del diseño (precondiciones, reglas, errores, eventos, transiciones) y termina
// en NotImplementedException: COMPILA y falla en ejecución nombrando la operación, como el
// UnsupportedOperationException de keel-spring. Inyecta el puerto del repositorio de su agregado (incremento 6);
// lo que cuelga de capas que keel-dotnet todavía no genera (el almacén de idempotencia, el correo, los clientes
// salientes) llega con su incremento: el handler de hoy solo inyecta lo que existe.

import { carriesEntryGate, dispatchNote, entryGateNote, ownershipNotes, scheduleDispatch, usesEntryGate } from 'keel-core/gen';
import { textFilterNotes } from 'keel-core/gen/text-filters';
import { finderNote } from 'keel-core/gen/query-filters';
import { finderCall } from './finders.js';
import { followUpRejectionNote } from 'keel-core/gen/rejection-notes';
import { csFile, csMember, declType, fieldUsings, isNullable, located, namespaceOf, typeUsings, xmlDoc } from './render.js';
import { mapperOf } from './mappers.js';
import { repositoryRoots, repositoryOf, portClass, repositoriesNamespace } from './repositories.js';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { idempotencyOutcomeCode } from 'keel-core/gen';
import { DEFAULT_IDEMPOTENCY_TTL_SECONDS } from 'keel-core/gen/request-idempotency';
import { IDEMPOTENCY_PORT, idempotencyNamespace, usesRegistry, usesRequestIdempotency } from './request-idempotency.js';
import { CALLER_SCOPE_PORT, CALLER_ROLES_PORT, callerResolution, roleCheckedOperation, scopedOperation } from './security.js';
import { schedulerPath } from './scheduling.js';
import { callMethod, clientPort, clientsNamespace } from './http-clients.js';
import { mailNamespace, mailPorts, sendsMail } from './mail.js';
import { OPERATION_CACHE_PORT, cacheCall, cachesOperation } from './cache.js';
import { cacheNote } from 'keel-core/gen/cache-plan';
import { projectionNamespace, projectionNotes, projectionsFedBy, readerLocal } from './projections.js';
import { refTargetsOf, listedIdsNote } from 'keel-core/gen/ref-targets';
import { inverseCollectionsNote } from 'keel-core/gen/inverse-collections';
import { resolverClass } from './ref-resolvers.js';
import { usesPersistence } from './persistence.js';
import { naturalKeyBatchFinder } from './repositories.js';
import { uploadNotes } from 'keel-core/gen/buckets';
import { effectiveErrorCode } from 'keel-core/gen/declared-errors';
import { FILE_STORAGE_PORT, UPLOAD_NOTE_NAMES_CS, storageNamespace } from './storage.js';

export function generate(model) {
  const files = [];
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      files.push(renderMessage(model, operation));
      files.push(renderHandler(model, operation));
    }
  }
  if (usesOptional(model)) files.push(optionalFile(model));
  if (usesEntryGate(model)) files.push(entryGateFile(model));
  return files;
}

/** La constante C# de una puerta de keel-core (`HTTP` → `EntryGate.Http`). */
export function entryGateMember(gate) {
  return `EntryGate.${gate[0]}${gate.slice(1).toLowerCase()}`;
}

/**
 * La asignación de la puerta en el inicializador de un mensaje (`EntryGate = EntryGate.Subscription`), o null si el
 * mensaje de esa operación no la lleva. La usan el endpoint, el reloj y las notas de la suscripción.
 */
export function entryGateAssignment(model, operationName, gate) {
  const operation = (model.services ?? []).flatMap((service) => service.operations ?? []).find((candidate) => candidate.name === operationName);
  return operation && carriesEntryGate(model, operation) ? `EntryGate = ${entryGateMember(gate)}` : null;
}

function entryGateFile(model) {
  const { namespace, path } = located(model, 'abstractions', 'EntryGate');
  const body = `/// <summary>
/// La puerta por la que entra una operación. Solo la lleva el mensaje de una operación que entra por HTTP y por alguna
/// otra: HTTP es la única que puede responder un error a quien llamó, y las reglas del diseño distinguen por ella.
/// </summary>
public enum EntryGate
{
    Http,
    Subscription,
    Dispatch,
    Schedule,
}`;
  return { path, content: csFile({ namespace, usings: [], body }) };
}

export function messageNamespace(model, operation) {
  return namespaceOf(model, operation.messageKind === 'query' ? 'queries' : 'commands');
}

/** El tipo de retorno de la operación, o null si no devuelve nada. */
export function returnTypeOf(operation) {
  if (!operation.responseDto) return null;
  // PagedResponse<T> ya envuelve la lista: envolverla además daría PagedResponse<IReadOnlyList<T>>.
  if (operation.paginated) return `PagedResponse<${operation.responseDto.name}>`;
  if (operation.returnsList) return `IReadOnlyList<${operation.responseDto.name}>`;
  return operation.responseDto.name;
}

/** El contrato del mensaje y el de su handler. */
export function contractOf(operation) {
  const result = returnTypeOf(operation);
  if (operation.messageKind === 'query') {
    if (!result) throw new Error(`La consulta ${operation.name} no devuelve nada: el modelo no la deja así`);
    return { message: `IQuery<${result}>`, handler: `IQueryHandler<${operation.messageClass}, ${result}>`, result };
  }
  if (operation.messageKind === 'returningCommand') {
    return { message: `IReturningCommand<${result}>`, handler: `IReturningCommandHandler<${operation.messageClass}, ${result}>`, result };
  }
  return { message: 'ICommand', handler: `ICommandHandler<${operation.messageClass}>`, result: null };
}

/** ¿Es una actualización parcial (PATCH)? Un opcional del cuerpo tiene TRES estados. */
export function isPartialUpdate(operation) {
  return operation.route?.method === 'PATCH';
}

/**
 * Componentes del mensaje: parámetros de ruta (en el orden del path) + campos del cuerpo + paginación. Los
 * comparte el lector de la API (incremento 5) para construir el mensaje.
 */
export function messageComponents(operation, model) {
  const components = [...(operation.pathParams ?? []), ...(operation.bodyFields ?? [])];
  if (operation.paginated) {
    if (model && repositoryRoots(model).length > 0) {
      // Con persistencia, la página viaja como un Pageable (página, tamaño y orden), el de Spring Data.
      components.push({ name: 'pageable', csType: 'Pageable', elementCsType: 'Pageable', kind: 'base', required: true, pageable: true, usings: [repositoriesNamespace(model)] });
    } else {
      // Sin persistencia, dos enteros.
      components.push({ name: 'page', csType: 'int', elementCsType: 'int', kind: 'base', base: 'int', required: true, usings: [] });
      components.push({ name: 'size', csType: 'int', elementCsType: 'int', kind: 'base', base: 'int', required: true, usings: [] });
    }
  }
  return components;
}

/**
 * ¿Es un opcional de TRES estados? En un PATCH, un opcional del cuerpo distingue AUSENTE (conserva el valor)
 * de PRESENTE CON NULL (vacía el campo). También una lista: ausente no la toca, y null o [] la vacían
 * (list-never-null, keel-core/gen/wire.js), como el JsonNullable de keel-spring.
 */
export function isThreeState(operation, component) {
  const fromPath = (operation.pathParams ?? []).some((param) => param.name === component.name);
  return isPartialUpdate(operation) && !fromPath && !component.required && (operation.bodyFields ?? []).some((f) => f.name === component.name);
}

function usesOptional(model) {
  return (model.services ?? []).some((service) =>
    (service.operations ?? []).some((operation) => messageComponents(operation, model).some((component) => isThreeState(operation, component)))
  );
}

/** El tipo con el que el mensaje DECLARA un componente. */
export function componentType(operation, component, model = null) {
  // La identidad resuelta contra varias credenciales (resolvedBy) puede no ser de nadie: el mensaje lleva null y la
  // operación responde con el error que declare el diseño (la misma decisión que keel-spring y keel-nest).
  if (component.resolvedIdentity && model && callerResolution(model)) return `${component.csType}?`;
  if (isThreeState(operation, component)) {
    const inner = component.list ? component.csType : `${component.csType}?`;
    return `Optional<${inner}>`;
  }
  // Un campo con default puede no llegar (por eso la entrada no exige su presencia): en el mensaje admite
  // null, y el default lo aplica el dominio.
  if (component.initializer != null && !component.generated && !component.list && !isNullable(component)) return `${component.csType}?`;
  return declType(component);
}

/**
 * `constraints.scalePolicy: round` (DSL 2.14): el decimal escalar se redondea a su escala al ENTRAR. No tiene
 * clase propia donde normalizarse —la de un compuesto la pone su value object—, así que va en el mensaje, el
 * primer punto por el que pasa. `reject` no necesita nada aquí: lo dice la validación del borde.
 */
function scaleRounding(component, type) {
  const numeric = component.numeric;
  if (component.kind === 'composite' || !numeric?.decimal || numeric.scalePolicy !== 'round' || numeric.scale == null) return null;
  if (type.startsWith('Optional<')) return null;
  return type.endsWith('?')
    ? `init => field = value is null ? null : Decimals.SetScale(value.Value, ${numeric.scale});`
    : `init => field = Decimals.SetScale(value, ${numeric.scale});`;
}

/** ¿Redondea algún mensaje su escala al entrar? Entonces el dominio tiene que emitir Decimals aunque no tenga value objects. */
export function messagesRoundScale(model) {
  return (model.services ?? []).some((service) =>
    (service.operations ?? []).some((operation) =>
      messageComponents(operation, model).some((component) => scaleRounding(component, componentType(operation, component, model)) != null)
    )
  );
}

function renderMessage(model, operation) {
  const place = operation.messageKind === 'query' ? 'queries' : 'commands';
  const { namespace, path } = located(model, place, operation.messageClass);
  const contract = contractOf(operation);
  const usings = [namespaceOf(model, 'abstractions'), ...resultUsings(model, operation)];
  const properties = messageComponents(operation, model).map((component) => {
    usings.push(...fieldUsings(model, component));
    const type = componentType(operation, component, model);
    const rounding = scaleRounding(component, type);
    if (rounding) usings.push(namespaceOf(model, 'domainSupport'));
    if (type.startsWith('Optional<')) usings.push(namespaceOf(model, 'appSupport'));
    // Un opcional de tres estados no es `required`: no mandarlo es justo lo que significa «no tocar».
    const required = type.startsWith('Optional<') ? '' : 'required ';
    const notes = componentNotes(model, operation, component);
    return `${notes}${xmlDoc(component.description, '    ')}    public ${required}${type} ${csMember(component.name)} { get; ${rounding ?? 'init;'} }`;
  });
  // La puerta por la que llegó (keel-core/gen/entry-gates.js): obligatoria, así que nadie construye el mensaje sin decirla.
  if (carriesEntryGate(model, operation)) {
    properties.push(`    /// <summary>La puerta por la que llegó este mensaje. La fija quien lo construye: el endpoint generado pone Http.</summary>
    public required EntryGate EntryGate { get; init; }`);
  }
  const scope = idempotencyScope(model, operation);
  if (scope && (operation.idempotency.partitionBy ?? []).length > 0) usings.push('System.Globalization');
  const members = scope ? [...properties, scope] : properties;
  const body = `${xmlDoc(operation.description)}public sealed class ${operation.messageClass} : ${contract.message}
{
${members.join('\n\n')}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

/**
 * El ÁMBITO de la clave de idempotencia, ya compuesto (DSL 2.17, `idempotency.partitionBy`): la misma decisión que
 * keel-spring y keel-nest. Es un MÉTODO, no una propiedad: la firma canónica del comando recorre sus propiedades, y el
 * ámbito no es contenido de la petición.
 */
function idempotencyScope(model, operation) {
  if (!usesRegistry(model, operation)) return null;
  const partition = operation.idempotency.partitionBy ?? [];
  const what =
    partition.length > 0
      ? `la operación y ${partition.join(', ')} (idempotency.partitionBy)`
      : 'la operación (sin partitionBy la clave es GLOBAL entre llamantes: lo decidió el diseño)';
  const value =
    partition.length > 0
      ? `string.Create(CultureInfo.InvariantCulture, $"${[operation.name, ...partition.map((field) => `{${csMember(field)}}`)].join(':')}")`
      : `"${operation.name}"`;
  return `    /// <summary>Ámbito de la clave de idempotencia: ${what}. No lo compongas a mano.</summary>
    public string IdempotencyScope() => ${value};`;
}

function resultUsings(model, operation) {
  if (!operation.responseDto) return [];
  return typeUsings(model, [operation.responseDto.name, ...(operation.paginated ? ['PagedResponse'] : [])]);
}

/** Las notas de un componente que el diseño obliga a decir donde se ve. */
function componentNotes(model, operation, component) {
  if ((operation.pathParams ?? []).some((param) => param.name === component.name)) return '';
  const lines = [];
  if (component.resolvedIdentity) {
    lines.push(
      'Lo resuelve el servidor desde la credencial (security.authentication.callerIdentity): no llega del',
      'cuerpo, lo estampa el lector del endpoint con CallerIdentity.Resolve().'
    );
    const resolution = callerResolution(model);
    if (resolution) {
      // Resuelto ya en la puerta: el endpoint y el listener pasan la clave natural, así que el handler no vuelve a mirar
      // credenciales. Lo único que decide es qué hacer con el null.
      lines.push(
        `Llega YA resuelto a la clave natural de ${resolution.entity.name} (${resolution.keyField}): por HTTP lo resuelve`,
        `CallerIdentityResolver con ${resolution.port}.${resolution.finder}(...), y por eventos el listener con el`,
        `mismo finder. null = la credencial no pertenece a ningún ${resolution.entity.name}: es la precondición de la`,
        'operación y responde con el error que el diseño declare para ella.'
      );
    }
  }
  const inherited = component.list ? null : component.inheritedPattern;
  if (!inherited || !(model.formatTypes ?? []).some((type) => type.name === component.typeName)) {
    return lines.length > 0 ? `${lines.map((line) => `    // ${line}`).join('\n')}\n` : '';
  }
  lines.push(
    `El formato del value type ${component.typeName} (${inherited}) se valida YA en la entrada: mal formado`,
    'es un 400 antes que cualquier precondición. No lo valides otra vez al principio del handler.',
    `El dominio lo repite con ${component.typeName}Format.Validate(...) (${located(model, 'valueObjects', `${component.typeName}Format`).path})`,
    'en el factory o el método de negocio de la entidad que recibe el valor: es lo que cubre lo que no entra por',
    'la API (un evento, una operación interna), y lo exige el gate check-domain-guards.sh.'
  );
  return `${lines.map((line) => `    // ${line}`).join('\n')}\n`;
}

function renderHandler(model, operation) {
  const { namespace, path } = located(model, 'useCases', operation.handlerClass);
  const contract = contractOf(operation);
  const usings = [namespaceOf(model, 'abstractions'), messageNamespace(model, operation), ...resultUsings(model, operation)];
  const dependencies = [];
  const mapper = mapperOf(model, operation);
  if (mapper) {
    usings.push(namespaceOf(model, 'mappers'));
    dependencies.push(mapper);
  }
  // El puerto del repositorio del agregado de la operación (el de su raíz si opera sobre una hija): sin él, el
  // handler no tendría con qué leer ni guardar, y el camino de menor resistencia sería inventárselo.
  const repository = repositoryOf(model, operation);
  if (repository) {
    usings.push(repositoriesNamespace(model));
    dependencies.push(portClass(repository));
  }
  // El registro de idempotencia de petición: el handler lo usa con el algoritmo de su nota.
  if (usesRegistry(model, operation)) {
    usings.push(idempotencyNamespace(model));
    dependencies.push(IDEMPOTENCY_PORT);
  }
  // El alcance por recurso (security.authentication.scoping): lo reciben las operaciones que declaran su error.
  if (scopedOperation(model, operation)) {
    usings.push(namespaceOf(model, 'appSupport'));
    dependencies.push(CALLER_SCOPE_PORT);
  }
  // Los exentos de una regla de propiedad: el puerto ya está generado con su adaptador.
  if (roleCheckedOperation(model, operation)) {
    usings.push(namespaceOf(model, 'appSupport'));
    dependencies.push(CALLER_ROLES_PORT);
  }
  // El despacho de otro caso de uso (use-cases.dispatches, DSL 2.21): el diseño dice que esta operación ejecuta
  // otra, así que recibe el puerto delante y la nota de cómo. El mismo criterio que keel-spring y keel-nest.
  if ((operation.dispatches ?? []).length > 0) {
    usings.push(namespaceOf(model, 'ports'));
    dependencies.push('ICommandDispatcher');
  }
  // El trabajo que el diseño le atribuye a esta operación en otro servidor (`dependencies.activations`, por
  // `triggeredBy`): el puerto del cliente se inyecta, o el camino de menor resistencia es no llamarlo. Solo el canal
  // síncrono: `via.publishes` lo emite el agregado. El mismo criterio que keel-spring y keel-nest.
  for (const { activation } of operation.dependencyActivations ?? []) {
    const client = (model.httpClients ?? []).find((candidate) => candidate.clientClass === activation.http?.clientClass);
    if (!client || dependencies.includes(clientPort(client))) continue;
    usings.push(clientsNamespace(model));
    dependencies.push(clientPort(client));
  }
  // El dato que esta operación PIDE a otro servidor (`dependencies.needs`, por `usedBy`), bajo demanda: el puerto del
  // cliente se inyecta por el mismo criterio que el de una activación (incremento 13i, como keel-spring y keel-nest). La
  // réplica (`replicated`) se lee por su lector y llega en el 13j.
  for (const { need } of operation.dependencyNeeds ?? []) {
    // Replicada (13j): se lee por el lector, que es quien aplica onMiss; nunca el repositorio de la réplica.
    if (need.strategy === 'replicated' && need.replica) {
      if (!dependencies.includes(need.replica.readerClass)) {
        usings.push(projectionNamespace(model));
        dependencies.push(need.replica.readerClass);
      }
      continue;
    }
    if (need.strategy !== 'on-demand' || !need.fetch) continue;
    const client = (model.httpClients ?? []).find((candidate) => candidate.clientClass === need.fetch.clientClass);
    if (!client || dependencies.includes(clientPort(client))) continue;
    usings.push(clientsNamespace(model));
    dependencies.push(clientPort(client));
  }
  // Las referencias embebidas (`embed`): el mapper exige la RefDto por parámetro y el agregado solo guarda el id ajeno, así
  // que el handler recibe el resolver —nunca el repositorio de la otra raíz—, que resuelve por lote. Como keel-spring y keel-nest.
  if (usesPersistence(model)) {
    for (const { entity } of refTargetsOf(model, operation)) {
      if (dependencies.includes(resolverClass(entity))) continue;
      usings.push(namespaceOf(model, 'appSupport'));
      dependencies.push(resolverClass(entity));
    }
  }
  // La operación de proyección (la que dispara la suscripción del `fedBy` de una réplica) recibe su proyector.
  for (const { need } of projectionsFedBy(model, operation)) {
    if (dependencies.includes(need.replica.projectorClass)) continue;
    usings.push(projectionNamespace(model));
    dependencies.push(need.replica.projectorClass);
  }
  // La salida por correo, por el mismo criterio (mail.sentBy es el único enlace del DSL entre un caso de uso y el
  // correo): sin el puerto delante, el camino de menor resistencia es no mandarlo, y no lo detecta nada.
  if (sendsMail(model, operation)) {
    usings.push(namespaceOf(model, 'ports'), mailNamespace(model));
    for (const port of mailPorts(model)) if (!dependencies.includes(port)) dependencies.push(port);
  }
  // La caché de lectura (use-cases.<op>.cache): el puerto delante, y la caché del diseño en CachedOperations. Dónde se
  // consulta lo decide el handler (después de lo que dependa de quién llama), como en keel-spring y keel-nest.
  if (cachesOperation(model, operation)) {
    usings.push(namespaceOf(model, 'ports'), namespaceOf(model, 'appSupport'));
    dependencies.push(OPERATION_CACHE_PORT);
  }
  // La subida: la operación con un campo `file` comprueba la política de su bucket y sube el binario. Los dos puertos, como
  // en keel-spring y keel-nest (los agentes de catalog los inyectaron a mano).
  if (uploadNotes(model, operation, { sizeCode: '' }).length > 0) {
    usings.push(storageNamespace(model));
    dependencies.push('StoragePolicies', FILE_STORAGE_PORT);
  }
  const local = (type) => {
    const name = type.replace(/^I(?=[A-Z])/, '');
    return name[0].toLowerCase() + name.slice(1);
  };
  const primary = dependencies.length > 0 ? `(${dependencies.map((type) => `${type} ${local(type)}`).join(', ')})` : '';
  // Cada dependencia en un campo: el agente la usa desde el método, y el parámetro del constructor primario no
  // queda capturado a medias.
  const fields = dependencies.map((type) => `    private readonly ${type} ${local(type)} = ${local(type)};`);
  const param = operation.messageKind === 'query' ? 'query' : 'command';
  const returns = contract.result ? `Task<${contract.result}>` : 'Task';
  const notes = handlerNotes(model, operation);
  const body = `${xmlDoc(operation.description)}public sealed class ${operation.handlerClass}${primary} : ${contract.handler}
{
${fields.length > 0 ? `${fields.join('\n')}\n\n` : ''}    public ${returns} Handle(${operation.messageClass} ${param}, CancellationToken cancellationToken)
    {
        // TODO (agente): implementar la lógica de negocio de esta operación.
${notes.map((note) => `        // ${note}`).join('\n')}${notes.length > 0 ? '\n' : ''}        throw new NotImplementedException("TODO: ${operation.name}");
    }
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

function handlerNotes(model, operation) {
  const notes = [];
  const dispatch = dispatchNote(model, operation, { call: 'await commandDispatcher.{variant}(new {message} { ... }, cancellationToken)' });
  if (dispatch) notes.push(dispatch);
  const gate = entryGateNote(model, operation, { read: 'command.EntryGate', value: entryGateMember });
  if (gate) notes.push(gate);
  // La búsqueda con finder (DSL 2.22) ya aplica sus filtros, plegado incluido: su nota sustituye a las de los filtros de texto.
  const finder = finderNote(operation, { call: operation.finder ? finderCall(model, operation.finder) : '' });
  if (finder) notes.push(finder);
  if (!operation.finder) for (const note of textFilterNotes(model, operation, { names: (symbol) => symbol[0].toUpperCase() + symbol.slice(1) })) notes.push(note);
  for (const note of scheduleNotes(model, operation)) notes.push(note);
  for (const note of idempotencyNotes(model, operation)) notes.push(note);
  for (const note of uploadNotes(model, operation, { sizeCode: effectiveErrorCode(model, FRAMEWORK_ERRORS.fileTooLarge), names: UPLOAD_NOTE_NAMES_CS })) notes.push(note);
  for (const text of operation.preconditions ?? []) notes.push(`Precondición: ${text}`);
  for (const text of operation.rules ?? []) notes.push(`Regla (en orden): ${text}`);
  // Lo que hace el handler cuando la pasarela contesta que NO (DSL 2.20): nota neutral, la de los tres generadores.
  const rejection = followUpRejectionNote(model.payments, operation.name);
  if (rejection) notes.push(rejection);
  for (const code of operation.errors ?? []) {
    const error = model.errors.find((e) => e.code === code);
    notes.push(
      `Error: lanzar ${error?.exceptionClass ?? code} (${code}, HTTP ${error?.http ?? 400})${error?.when ? ` cuando: ${error.when}` : ''}` +
        (error ? ` — ${located(model, 'errors', error.exceptionClass).path}` : '')
    );
  }
  // La propiedad (DSL 2.23): nota neutral, la misma en los tres generadores.
  const ownerParam = operation.messageKind === 'query' ? 'query' : 'command';
  for (const note of ownershipNotes(model, operation, { read: (field) => `${ownerParam}.${field[0].toUpperCase()}${field.slice(1)}`, hasRole: (role) => `callerRoles.Has("${role}")` })) notes.push(note);
  const scoping = model.security?.scoping;
  if (scopedOperation(model, operation)) {
    const exempt = [...scoping.exemptRoles, ...(scoping.exemptClients ?? []).map((client) => `cliente ${client}`)];
    notes.push(
      `Alcance (security.authentication.scoping): callerScope ya está inyectado; comprueba ` +
        `callerScope.Covers(<${scoping.over} del recurso>) donde lo digan las reglas; fuera del alcance, ${scoping.error}. ` +
        `Exentos: ${exempt.join(', ') || 'ninguno'}. En un listado, filtra por callerScope.ScopedValues() con un finder acotado que escribes tú`
    );
  }
  for (const transition of operation.transitions ?? []) {
    notes.push(
      `Transición: ${transition.entity} ${(transition.from ?? []).join('|')} → ${transition.to}. La aplica el método semántico ` +
        'del agregado (que llama a TransitionTo), nunca el handler asignando el estado.'
    );
  }
  if (sendsMail(model, operation)) {
    const guard = operation.guardClaim;
    notes.push(
      'Correo: esta operación lo manda (mail.sentBy). Compón el MailMessage y llama a mailSender.Send(...). ' +
        'Un correo que sale NO lo deshace ningún rollback, así que la guarda tiene que estar CONFIRMADA antes del envío — ' +
        'no basta con que haya ocurrido: ' +
        (guard
          ? `empieza por ${csMember(guard.method)}(...) del puerto I${guard.entity}Repository, que pasa el agregado a ${guard.to} en su PROPIA ` +
            'transacción y devuelve null si otra ejecución llegó antes (la carrera perdida: NO envíes, y termina como digan las reglas, sin efecto o con el error ' +
            'que el diseño declare). Hacer esa transición solo en memoria la deja sin existir para nadie hasta el ' +
            `commit final, que llega DESPUÉS del envío: si el proceso cae en medio, el agregado vuelve a ${guard.from.join(' o ')} ` +
            'y el ciclo siguiente manda un SEGUNDO correo a una persona real'
          : `${operation.idempotency ? 'la clave de idempotencia' : 'la transición declarada'} tiene que estar persistida y ` +
            'confirmada antes de llamar a mailSender.Send(...), no solo aplicada en memoria') +
        '. Un MailDeliveryException con Partial() es un correo que SALIÓ para alguien: no lo trates como «no salió». ' +
        'El adaptador y el renderizador ya están escritos: no los toques — ver la skill keel-dotnet-mail'
    );
  }
  const caching = cacheNote(model, operation, { call: cacheCall(operation) });
  if (caching) notes.push(caching);
  for (const note of reconciliationNotes(operation)) notes.push(note);
  const compensation = compensationNote(operation);
  if (compensation) notes.push(compensation);
  for (const note of activationNotes(model, operation)) notes.push(note);
  for (const { dependency, need } of operation.dependencyNeeds ?? []) notes.push(needNote(model, dependency, need, operation));
  for (const note of projectionNotes(model, operation)) notes.push(note);
  for (const note of embedNotes(model, operation)) notes.push(note);
  for (const eventName of operation.emits ?? []) {
    const event = (model.events ?? []).find((e) => e.name === eventName);
    const emitters = [...new Set((event?.emittedBy ?? []).filter((e) => e.operation === operation.name && e.aggregate).map((e) => e.aggregate))];
    notes.push(
      `Emite: ${eventName} — lo hace ${emitters.length > 0 ? emitters.join(' o ') : 'el agregado'} con Raise(${event?.className ?? `${eventName}Event`}.Of(...)) dentro del método de negocio; el handler no publica nada`
    );
  }
  return notes.flatMap((note) => wrap(note));
}

/**
 * La nota de un barrido de RECONCILIACIÓN (incremento 11c), la de keel-spring y keel-nest. Dos formas: con el reclamo
 * generado no se le dice CÓMO reclamar —sería pedirle que reescriba lo que existe, y el camino de menor resistencia es
 * un segundo mecanismo en paralelo—; sin él, sí. Lo que es suyo en las dos (el ORDEN de los commits, la carrera con el
 * camino feliz, qué hacer con cada candidato) va en las dos.
 */
function reconciliationNotes(operation) {
  return (operation.reconciles ?? []).map(({ dependency, activation, waiting, claim }) => {
    const head =
      `Reconciliación de ${dependency}.${activation.name}: barre los encargos que nunca recibieron desenlace — el evento que los cerraría puede no llegar nunca. `;
    const decide = `Decide qué hace con cada uno según el efecto declarado ("${activation.effect}"): reintentar el encargo o disparar la compensación. Si el diseño no lo dice, es designGap. `;
    const noTransaction =
      'SIN TRANSACCIÓN ABARCADORA: el scheduler lo despacha con DispatchWithoutTransaction, así que cada llamada al adaptador de repositorio confirma la SUYA y la llamada al proveedor cae fuera de todas. ';
    const race =
      'CARRERA CON EL CAMINO FELIZ: mientras barres puede llegar el evento de desenlace. Si al mover el candidato lo encuentras ya fuera del estado de espera (la transición del agregado lo rechaza, o el Save pierde el bloqueo optimista), ganó el otro camino: es la carrera resuelta, no un fallo — no lo registres como error ni lo reintentes, y sigue con el siguiente. ';
    const republish =
      'Y si lo que haces es reencargar publicando un evento, no lo absorbe nada: cada réplica hace su propio Raise y estampa un metadata.eventId distinto, así que para el consumidor son N hechos. ';
    if (claim) {
      const repository = `${claim.entity[0].toLowerCase()}${claim.entity.slice(1)}Repository`;
      return (
        head +
        `EL RECLAMO YA ESTÁ GENERADO: toma el lote con await ${repository}.${csMember(claim.method)}(cancellationToken). Devuelve SOLO los candidatos que ESTA réplica se llevó —el barrido corre en todas a la vez— y ya trae dentro el umbral que declara el diseño, la cota del lote y la caducidad de la marca (config/parameters/<perfil>/reconciliation.yaml). NO escribas otro reclamo (ni un finder por estado, ni un lock, ni una marca propia en ${claim.entity}): un segundo mecanismo en paralelo al generado no reclama nada, solo reparte peor. ` +
        decide +
        noTransaction +
        reconciliationOrder(operation, activation, true) +
        'El reclamo no sustituye a la idempotencia saliente: lo que absorbe una llamada repetida al proveedor —tras una caducidad o un reintento— es solo esa. ' +
        republish +
        race +
        'Lo verifica infra/check-idempotency.sh, familia reconciliation'
      );
    }
    return (
      head +
      (waiting.length > 0 ? `Los candidatos son ${waiting.join(', ')} que llevan demasiado tiempo ahí. ` : 'Los candidatos son las entidades que quedaron esperando el desenlace. ') +
      `build NO pudo generar el reclamo (su aviso dice por qué), así que lo escribes tú, en el adaptador del repositorio y no aquí. DESDE CUÁNDO: la marca temporal la declara el diseño en awaitingSince${activation.awaitingSince ? ` (${activation.awaitingSince})` : ''}; NO uses createdAt ni un updatedAt de auditoría. ` +
      `Los tres números —umbral (del diseño), caducidad del reclamo y cota del lote— están en ReconciliationSettings.Windows[${JSON.stringify(activation.name)}] (Infrastructure/Persistence/ReconciliationSettings.cs, inyectable): léelos de ahí, no de una constante. ` +
      'CÓMO reclamar: con la MISMA tienda que build genera para los reclamos que sí puede (ReconciliationClaimStore.Claim, una marca persistida que caduca), confirmada ANTES de llamar al proveedor; no con un lock, que solo aísla mientras dura su transacción. ' +
      decide +
      noTransaction +
      reconciliationOrder(operation, activation, false) +
      republish +
      race +
      'Lo verifica infra/check-idempotency.sh, familia reconciliation'
    );
  });
}

/**
 * El ORDEN de un barrido de reconciliación, el de keel-spring y keel-nest: si reintenta la misma activación, proveedor
 * primero y transición después; si llama a OTRA que DESHACE el encargo, la entidad se resuelve primero.
 */
function reconciliationOrder(operation, activation, claimGenerated) {
  const calls = (operation.dependencyActivations ?? []).filter(({ activation: called }) => called.http);
  const retries = calls.some(({ activation: called }) => called.name === activation.name);
  const undoes = calls.filter(({ activation: called }) => called.name !== activation.name);
  const first = claimGenerated ? '(1) el reclamo, que ya está hecho y confirmado' : '(1) marcar el reclamo y confirmar, que es lo que lo hace visible a las demás réplicas';
  if (undoes.length > 0 && !retries) {
    const names = undoes.map(({ dependency, activation: called }) => `${dependency}.${called.name}`).join(', ');
    return (
      `ORDEN: aquí el barrido no reintenta el encargo, lo DESHACE con ${names}, así que va al revés que un reintento — ` +
      `${first}; (2) transición al estado final y confirmar (Save); (3) después, fuera de toda transacción, llamar a ${names}. ` +
      'Llamar antes y morir antes de confirmar dejaría deshecho el trabajo del proveedor y la entidad todavía en espera. Si una regla del diseño fija el orden, manda la regla. '
    );
  }
  return (
    `ORDEN: son DOS commits y no se confunden — ${first}; (2) llamar al proveedor, FUERA de toda transacción; (3) transición al estado final y confirmar (Save). ` +
    'Si actúas y mueres antes de (3), la marca caduca y la pasada siguiente repite la llamada, que es lo que absorbe la idempotencia saliente. ' +
    'Al revés —confirmar el desenlace y luego actuar— si mueres en medio dejas la entidad resuelta y el trabajo vivo en el proveedor: un huérfano que no detecta nadie. Si una regla del diseño fija el orden, manda la regla. '
  );
}

/** La nota de una COMPENSACIÓN (incremento 11c), la de keel-spring y keel-nest. */
function compensationNote(operation) {
  if (!operation.compensates) return null;
  const { dependency, undoes, moves, event, deduplicated } = operation.compensates;
  const restored = new Set((operation.transitions ?? []).map((transition) => transition.entity));
  const pending = moves.filter((entity) => !restored.has(entity));
  const guard = (operation.transitions ?? []).length > 0 ? 'transitions' : deduplicated ? 'messageId' : null;
  return (
    `Compensación de ${dependency}${undoes ? ` — deshace la activación '${undoes}'` : ''}: la dispara la suscripción a ${event}. ` +
    (moves.length > 0
      ? `El trabajo que deshaces movió el lifecycle de ${moves.join(', ')}: devolver ese estado es parte de la compensación, no un extra${pending.length > 0 ? ` (el diseño NO declara transición sobre ${pending.join(', ')} — repórtalo como designGap en vez de inventar el estado destino)` : ''}. `
      : '') +
    (guard === 'transitions'
      ? "Aplicarla dos veces no debe deshacer dos veces: la guarda es la transición del agregado, que rechaza la segunda desde un estado que ya no está en 'from'. Va en el DOMINIO, no en el handler."
      : guard === 'messageId'
        ? 'Aplicarla dos veces no debe deshacer dos veces: la guarda es la deduplicación del listener por el id del mensaje (IdempotencyGuard). El handler no añade ninguna otra.'
        : 'Aplicarla dos veces no debe deshacer dos veces y el diseño no declara guarda: repórtalo como designGap.')
  );
}

/**
 * Las notas de las activaciones de esta operación (`dependencies.activations`) y el ORDEN de sus efectos: las de
 * keel-spring y keel-nest, con los nombres de este proyecto. En un barrido de reconciliación el orden es otro y lo dice
 * su propia nota, así que aquí no se da: dos órdenes opuestos en el mismo handler no son dos consejos, son uno que el
 * agente elegiría al azar.
 */
function activationNotes(model, operation) {
  const notes = [];
  const sweep = Boolean(operation.schedule);
  const reconciles = (operation.reconciles ?? []).length > 0;
  for (const { dependency, activation } of operation.dependencyActivations ?? []) notes.push(activationNote(model, dependency, activation, sweep));
  const calls = (operation.dependencyActivations ?? []).filter(({ activation }) => activation.http);
  if ((operation.transitions ?? []).length === 0 || calls.length === 0 || reconciles) return notes;
  const fromKeys = operation.transitions.flatMap((t) => (t.from ?? []).map((state) => `${t.entity}::${state}`));
  const branches = fromKeys.some((key, index) => fromKeys.indexOf(key) !== index);
  const decided = branches ? calls.filter(({ activation }) => activation.awaits === 'outcome') : [];
  const decidedNames = new Set(decided.map(({ activation }) => activation.name));
  if (decided.length > 0) {
    notes.push(
      `ORDEN de los efectos: ${decided.map(({ dependency, activation }) => `${dependency}.${activation.name}`).join(', ')} es awaits: outcome y su resultado DECIDE la transición. ` +
        'Comprueba primero la precondición de estado SIN escribir nada, llama después y aplica la transición que corresponda al veredicto. ' +
        'Si una regla del diseño fija el orden, manda la regla'
    );
  }
  const outgoing = calls.filter(({ activation }) => !decidedNames.has(activation.name));
  if (outgoing.length > 0) {
    const guards = operation.transitions.map((t) => `${t.entity}: ${(t.from ?? []).join('|')} → ${t.to}`).join('; ');
    notes.push(
      `ORDEN de los efectos: aplica PRIMERO la transición de estado (${guards}) y solo después llama a ${outgoing.map(({ dependency, activation }) => `${dependency}.${activation.name}`).join(', ')}. ` +
        'La llamada saliente no es transaccional: si sale antes y la guarda del agregado rechaza el cambio, el rollback revierte la fila ' +
        'pero el trabajo ya está encargado en el otro servidor y nadie lo deshace'
    );
  }
  return notes;
}

/**
 * La nota de un dato que esta operación pide a otro servidor (`needs`): la de keel-spring y keel-nest, con los nombres de
 * este proyecto. La réplica no llega aquí todavía (13j): la frontera la rechaza.
 */
function needNote(model, depId, need, operation) {
  const why = need.description ? ` — ${need.description}` : '';
  if (need.strategy !== 'on-demand') return replicaNote(model, depId, need, operation, why);
  if (!need.fetch) {
    return `Dependencia ${depId}.${need.name} (on-demand)${why}: el diseño no resuelve la llamada (fetchedFrom no apunta a ninguna de http-clients). No inventes el canal: dilo en el reporte`;
  }
  const client = (model.httpClients ?? []).find((candidate) => candidate.clientClass === need.fetch.clientClass);
  const call = client?.calls.find((candidate) => candidate.name === need.fetch.call);
  const port = client ? clientPort(client) : `I${need.fetch.clientClass}`;
  const local = `${port.slice(1, 2).toLowerCase()}${port.slice(2)}`;
  const method = call ? callMethod(call) : need.fetch.call;
  const policy = need.onUnavailable
    ? ` Si ${depId} no responde, el fallback del adaptador ya aplica onUnavailable: ${need.onUnavailable.action}; no lo captures para convertirlo en otra cosa.`
    : '';
  const exposed =
    need.exposedAs && need.dtoName
      ? ` El dato SALE en la respuesta: el mapper pide un ${need.dtoName} por parámetro y lo pone en el campo '${need.exposedAs}' — si no lo tienes, pásalo null, que es lo que el contrato admite cuando el proveedor no responde.`
      : '';
  return (
    `Dependencia ${depId}.${need.name} (on-demand)${why}: pide el dato con await ${local}.${method}(..., cancellationToken), que ya devuelve el resultado de dominio ` +
    `(${need.fetch.resultType}): el DTO del cable no cruza a Application. El retry y el circuito ya están en el adaptador: no los repitas.${policy}${exposed}`
  );
}

/** Las notas de las referencias embebidas y de la query que recibe la lista de ids: las de keel-spring y keel-nest. */
function embedNotes(model, operation) {
  if (!usesPersistence(model)) return [];
  const notes = [];
  for (const { entity, ref } of refTargetsOf(model, operation)) {
    const resolver = `${resolverClass(entity)[0].toLowerCase()}${resolverClass(entity).slice(1)}`;
    notes.push(
      operation.paginated || operation.returnsList
        ? `Embed ${entity.name}: por LOTE — recoge los ids de ${entity.name} de la página, UNA llamada a await ${resolver}.ResolveAll(ids, cancellationToken) y ${ref.name} = refs[id] al mapear cada elemento. NUNCA FindById dentro del bucle: es un N+1`
        : `Embed ${entity.name}: await ${resolver}.Resolve(<id>, cancellationToken)`
    );
  }
  const repository = operation.responseDto?.entity ? `${operation.responseDto.entity[0].toLowerCase()}${operation.responseDto.entity.slice(1)}Repository` : 'repository';
  const listed = listedIdsNote(model, operation, { call: `await ${repository}.FindAllById(query.{ids}, cancellationToken)` });
  if (listed) notes.push(listed);
  // Los finders del puerto van en PascalCase en C#: FindAllByCartId.
  const inverse = inverseCollectionsNote(operation, { port: (name) => `await ${name[0].toLowerCase()}${name.slice(1)}Repository`, id: '<id del agregado>, cancellationToken' });
  if (inverse) notes.push(inverse.replace(/.findAllBy/g, '.FindAllBy'));
  return notes;
}

/** La nota de un dato replicado: se lee por el lector, que aplica onMiss (la de keel-spring y keel-nest). */
function replicaNote(model, depId, need, operation, why) {
  const { replica } = need;
  if (!replica) return `Dependencia ${depId}.${need.name} (replicada)${why}: la réplica no se pudo resolver (revisa los avisos del build); no leas el dato por tu cuenta`;
  const reader = readerLocal(replica);
  const onMiss = {
    fetch: `Si la copia aún no tiene el dato, el lector lo pide a ${depId} y lo guarda (su Hydrate es tuyo: lo dice su TODO).`,
    fail: `Si la copia aún no tiene el dato, el lector lanza ${replica.onMiss.exceptionClass ?? replica.onMiss.error}: no lo captures para seguir con un valor inventado.`,
    degrade: `Si la copia aún no tiene el dato, el lector devuelve null y el resultado degradado lo escribes TÚ, distinguible por el cliente de una respuesta normal: ${replica.onMiss.degradedTo}`
  }[replica.onMiss.action];
  const entity = (model.entities ?? []).find((candidate) => candidate.name === replica.entityName);
  const batch = (operation.returnsList || operation.paginated) && entity && naturalKeyBatchFinder(model, entity)?.reason === 'replica-listing'
    ? ` Esta operación devuelve una lista: lee la página entera con await ${reader}.ByKeys(..., cancellationToken) (UNA consulta) y pasa por ByKey(...) solo las claves que falten, que es donde se aplica onMiss.`
    : '';
  const exposed = need.exposedAs && need.dtoName ? ` El dato SALE en la respuesta: el mapper pide un ${need.dtoName} por parámetro y lo pone en el campo '${need.exposedAs}'.` : '';
  return `Dependencia ${depId}.${need.name} (replicada)${why}: lee ${replica.entityName} con await ${reader}.ByKey(..., cancellationToken), que ya aplica onMiss: ${replica.onMiss.action}. ${onMiss}${batch} NUNCA leas el repositorio de la réplica directamente ni la escribas desde aquí: la copia solo se escribe desde ${replica.projectorClass}.${exposed}`;
}

/** La nota de una activación: el trabajo que esta operación delega en otro servidor (la de keel-spring y keel-nest). */
function activationNote(model, depId, activation, sweep) {
  if (activation.event) {
    return `Activación ${depId}.${activation.name}: ${activation.effect} — se delega publicando ${activation.event.name}, que emite el agregado con Raise(${activation.event.className ?? '...'}.Of(...)) dentro del método de negocio. El handler no publica nada, y no esperes respuesta: publicar un evento no devuelve resultado`;
  }
  if (!activation.http) {
    return `Activación ${depId}.${activation.name}: ${activation.effect} — el diseño no resuelve el canal (via.client/call no existe en http-clients). No inventes la llamada: dilo en el reporte`;
  }
  const awaits = {
    outcome: `awaits: outcome — el resultado que devuelve ${depId} condiciona el desenlace de esta operación: no basta con que la llamada no falle. Qué significa un desenlace negativo lo dice el diseño: si specs/decisions.yaml acepta OBL-OUTCOME-NEGATIVE-UNDECIDED, manda esa decisión (y puede que el cuerpo no importe).`,
    acknowledgement: `awaits: acknowledgement — basta con que ${depId} acuse recibo; no interpretes el cuerpo como parte del desenlace.`,
    nothing: sweep
      ? 'awaits: nothing — no se espera nada de vuelta, pero la llamada sigue siendo síncrona y su timeout bloquea la pasada del barrido.'
      : 'awaits: nothing — no se espera nada de vuelta, pero la llamada sigue siendo síncrona y ocurre DENTRO de la transacción que abrió el mediator: su timeout la mantiene abierta.'
  }[activation.awaits];
  const onFailure = activation.onFailure;
  const failure = {
    ignore: `onFailure: ignore — que ${depId} no responda no interrumpe esta operación; el fallback del adaptador ya lo absorbe y lo registra. No lo reintentes aquí.`,
    fail: `onFailure: fail — si ${depId} no responde, esta operación falla con ${onFailure?.exceptionClass ?? onFailure?.error}; el fallback del adaptador ya la lanza. No la captures para convertirla en otra cosa.`,
    degrade: `onFailure: degrade — si ${depId} no responde, esta operación degrada y el resultado degradado lo escribes TÚ: ${onFailure?.degradedTo}`
  }[onFailure?.action];
  const client = (model.httpClients ?? []).find((candidate) => candidate.clientClass === activation.http.clientClass);
  const call = client?.calls.find((candidate) => candidate.name === activation.http.call);
  const port = client ? clientPort(client) : `I${activation.http.clientClass}`;
  const local = `${port.slice(1, 2).toLowerCase()}${port.slice(2)}`;
  const method = call ? callMethod(call) : activation.http.call;
  return `Activación ${depId}.${activation.name}: ${activation.effect} — invoca await ${local}.${method}(..., cancellationToken). El retry y el circuito ya están en el adaptador: no los repitas. ${awaits ?? ''} ${failure ?? ''}`.trim();
}

/**
 * La nota de una operación disparada por reloj: cómo la despacha su scheduler (keel-core/gen/scheduling.js, la misma
 * decisión que keel-spring y keel-nest) y lo que eso le cambia al handler.
 */
function scheduleNotes(model, operation) {
  if (!operation.schedule) return [];
  const mode = scheduleDispatch(model, operation);
  const where = schedulerPath(model, model.services.find((service) => service.operations.includes(operation)));
  return [
    `Por reloj (cron ${operation.schedule.cron}): la dispara ${where} en TODAS las réplicas a la vez. Lo que ` +
      'actúa sobre lo que encuentra tiene que RECLAMARLO (marcar la fila y quedarse con las que esta réplica se llevó), no solo leerlo.',
    mode.withoutTransaction
      ? 'SIN TRANSACCIÓN ABARCADORA: el scheduler la despacha con DispatchWithoutTransaction, así que cada llamada al adaptador de ' +
        'repositorio confirma la SUYA. El orden es el de los commits: reclamar y confirmar, actuar fuera de toda transacción, ' +
        'confirmar el desenlace. Un fallo en una fila no puede revertir las demás.'
      : 'Corre en UNA transacción, la del caso de uso: no llama a nadie en medio de su trabajo, así que todo o nada.',
    ...(operation.claim ?? []).map((claim) => {
      const call = `${claim.entity[0].toLowerCase()}${claim.entity.slice(1)}Repository.${claim.method[0].toUpperCase()}${claim.method.slice(1)}(cancellationToken)`;
      return claim.stalled
        ? `EL RESCATE YA ESTÁ GENERADO: ${call} devuelve los ${claim.entity} que llevan atascados en ` +
            `${claim.stalled.state} más que su plazo y que ESTA réplica se llevó, SIGUIENDO en ${claim.stalled.state} con ${claim.stalled.stampField} ` +
            `renovado. La transición a ${claim.to} la haces TÚ con el método del agregado (fija los campos que ${claim.to} exige) y la guardas. ` +
            'No escribas otro rescate, ni un finder por estado, ni una cota propia. Un fallo en una fila NO corta el lote: cada Save va en ' +
            'su try, y un conflicto de versión es la carrera con quien saca la fila del estado a la vez (la ganó él): sigue con la siguiente. ' +
            'Sin eso, una sola fila que pierde la carrera deja las demás arrendadas sin rescatar hasta que vuelva a vencer su plazo.'
        : `EL RECLAMO YA ESTÁ GENERADO: toma el lote con ${call}, que devuelve SOLO los ${claim.entity} ` +
            `que ESTA réplica se llevó, ya en ${claim.to}${claim.stamps ? ` y con ${claim.stamps.field} estampado` : ''}. El tamaño del lote no se pasa: ` +
            `lo acota el adaptador con sweep.${claim.sweepKey}.batch-size. No escribas otro reclamo (ni un finder por estado ni un lock): ` +
            'un segundo mecanismo en paralelo no reclama nada. Actúa sobre cada fila y guárdala: un fallo en una no revierte las demás.';
    })
  ];
}

/**
 * Las notas de la idempotencia de petición: el algoritmo que el agente escribe con las piezas que build ya generó. Las
 * mismas reglas que keel-spring y keel-nest, con los nombres de este proyecto: sin ellas el camino de menor resistencia
 * es escribir otro registro, o guardar la clave AL FINAL, que deja a la perdedora de una carrera con el code de la
 * primera restricción de negocio que encuentre.
 */
function idempotencyNotes(model, operation) {
  const idempotency = operation.idempotency;
  if (!idempotency) return [];
  if (idempotency.guard === 'natural-key') {
    return [
      `Idempotencia: keySource=payload-field, keyField=${idempotency.keyField}. La guarda es la CLAVE NATURAL ` +
        `(${(idempotency.naturalKey ?? []).join(', ')}) del agregado, no un registro: build NO genera IIdempotencyStore para ` +
        'esta operación y no debes escribir otro. Busca por la clave natural ANTES de insertar; si ya existe, devuelve ese mismo ' +
        'recurso sin re-ejecutar nada — una repetición devuelve la respuesta original, NO un error. La carrera la arbitra la ' +
        'constraint: no captures su violación para «arreglarla».'
    ];
  }
  if (!usesRequestIdempotency(model)) return [];
  const ttl = idempotency.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  const reuse = `${FRAMEWORK_ERRORS.idempotencyReuse.http} ${idempotencyOutcomeCode(model, operation.name, FRAMEWORK_ERRORS.idempotencyReuse)}`;
  const race = `${FRAMEWORK_ERRORS.idempotencyRace.http} ${idempotencyOutcomeCode(model, operation.name, FRAMEWORK_ERRORS.idempotencyRace)}`;
  const source =
    idempotency.keySource === 'payload-hash'
      ? 'La clave es CommandSignature.Of(command), que también es la firma: NO hay cabecera ni IdempotencyContext, y por tanto tampoco caso «sin clave» — siempre se deduplica.'
      : idempotency.keySource === 'payload-field'
        ? `La clave es el campo ${csMember(idempotency.keyField)} del comando; la firma, CommandSignature.Of(command). No hay cabecera.`
        : 'La clave es IdempotencyContext.Get() (Application/Support): null = el cliente no mandó la cabecera, y entonces se ejecuta SIN deduplicar (no se rechaza). La firma es CommandSignature.Of(command).';
  return [
    `Idempotencia: keySource=${idempotency.keySource}, ttlSeconds=${ttl}. El puerto IIdempotencyStore (inyectado), su adaptador, ` +
      'la tabla idempotency_record y CommandSignature ya están generados: NO escribas otro registro, otra tabla ni otra firma, y ' +
      'no toques el mediator ni el endpoint para esto. ' +
      source,
    'Algoritmo, dentro de la transacción del comando (ya abierta por el mediator): var scope = command.IdempotencyScope() (build lo ' +
      'compone desde el diseño); var previous = await idempotencyStore.Find(scope, clave, cancellationToken). Si hay previa con la ' +
      'MISMA firma, reconstruye la respuesta desde previous.ResourceId sin re-ejecutar nada (ni escrituras ni eventos). Si la firma ' +
      `difiere, lanza IdempotencyReuseException (${reuse}). Si no hay previa, RECLAMA PRIMERO: decide el id del recurso ` +
      `(Guid.CreateVersion7()), await idempotencyStore.Save(scope, clave, firma, id.ToString(), ${ttl}, cancellationToken) y SOLO ` +
      'DESPUÉS ejecuta el negocio con ese id.',
    'La CARRERA (dos peticiones con la misma clave a la vez) no la ve Find: la arbitra la clave primaria del registro, y el ' +
      `adaptador la traduce a IdempotencyConflictException (${race}). NO la captures. Y por eso el orden de arriba: con Save ` +
      'al final, la perdedora choca antes contra la primera restricción de negocio y sale su code, no el de la clave en curso.'
  ];
}

/** Parte una nota larga en líneas de comentario legibles. */
function wrap(text, width = 100) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = `  ${word}`;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function optionalFile(model) {
  const { namespace, path } = located(model, 'appSupport', 'Optional');
  const body = `/// <summary>
/// Un campo de TRES estados en una actualización parcial (PATCH): ausente (no tocar), presente con valor y
/// presente con null (vaciar). Es el JsonNullable de keel-spring: un <c>T?</c> solo distingue dos.
/// </summary>
public readonly record struct Optional<T>
{
    private readonly T value;

    private Optional(T value)
    {
        this.value = value;
        IsPresent = true;
    }

    /// <summary>¿Lo mandó quien llama? Por defecto, no: un Optional sin asignar es «no tocar».</summary>
    public bool IsPresent { get; }

    /// <summary>El valor mandado (que puede ser null). Leerlo de un campo ausente es un error del handler.</summary>
    public T Value => IsPresent ? value : throw new InvalidOperationException("El campo no viene en la petición: no hay valor que leer");

    public static Optional<T> Of(T value) => new(value);

    public static Optional<T> Absent => default;
}`;
  return { path, content: csFile({ namespace, body }) };
}
