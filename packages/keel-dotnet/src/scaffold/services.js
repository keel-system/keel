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

import { dispatchNote, scheduleDispatch } from 'keel-core/gen';
import { textFilterNotes } from 'keel-core/gen/text-filters';
import { followUpRejectionNote } from 'keel-core/gen/rejection-notes';
import { csFile, csMember, declType, fieldUsings, isNullable, located, namespaceOf, typeUsings, xmlDoc } from './render.js';
import { mapperOf } from './mappers.js';
import { repositoryRoots, repositoryOf, portClass, repositoriesNamespace } from './repositories.js';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { idempotencyOutcomeCode } from 'keel-core/gen';
import { DEFAULT_IDEMPOTENCY_TTL_SECONDS } from 'keel-core/gen/request-idempotency';
import { IDEMPOTENCY_PORT, idempotencyNamespace, usesRegistry, usesRequestIdempotency } from './request-idempotency.js';
import { CALLER_SCOPE_PORT, scopedOperation } from './security.js';
import { schedulerPath } from './scheduling.js';

export function generate(model) {
  const files = [];
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      files.push(renderMessage(model, operation));
      files.push(renderHandler(model, operation));
    }
  }
  if (usesOptional(model)) files.push(optionalFile(model));
  return files;
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
export function componentType(operation, component) {
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
      messageComponents(operation, model).some((component) => scaleRounding(component, componentType(operation, component)) != null)
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
    const type = componentType(operation, component);
    const rounding = scaleRounding(component, type);
    if (rounding) usings.push(namespaceOf(model, 'domainSupport'));
    if (type.startsWith('Optional<')) usings.push(namespaceOf(model, 'appSupport'));
    // Un opcional de tres estados no es `required`: no mandarlo es justo lo que significa «no tocar».
    const required = type.startsWith('Optional<') ? '' : 'required ';
    const notes = componentNotes(model, operation, component);
    return `${notes}${xmlDoc(component.description, '    ')}    public ${required}${type} ${csMember(component.name)} { get; ${rounding ?? 'init;'} }`;
  });
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
  // El despacho de otro caso de uso (use-cases.dispatches, DSL 2.21): el diseño dice que esta operación ejecuta
  // otra, así que recibe el puerto delante y la nota de cómo. El mismo criterio que keel-spring y keel-nest.
  if ((operation.dispatches ?? []).length > 0) {
    usings.push(namespaceOf(model, 'ports'));
    dependencies.push('ICommandDispatcher');
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
  for (const note of textFilterNotes(model, operation)) notes.push(note);
  for (const note of scheduleNotes(model, operation)) notes.push(note);
  for (const note of idempotencyNotes(model, operation)) notes.push(note);
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
