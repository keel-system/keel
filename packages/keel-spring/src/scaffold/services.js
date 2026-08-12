// Capa application con patrón mediator (arquitectura del prototipo): por cada
// operación se genera su mensaje CQRS (record en application/commands o
// application/queries; los commands llevan la Bean Validation del diseño
// porque son el body HTTP) y su handler stub en application/usecases — aquí es
// donde el agente implementa la lógica. Los handlers dependen del PUERTO de
// dominio (domain/repository) y del mapper de aplicación, nunca del JPA.

import { FRAMEWORK_ERRORS } from 'keel-core';
import { effectiveErrorCode } from '../lib/declared-errors.js';
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

/**
 * ¿El diseño declara alguna operación disparada por reloj?
 *
 * Lo consume application.js: sin @EnableScheduling, el <Servicio>Scheduler se genera
 * con sus @Scheduled y no se dispara nunca — un barrido de reconciliación que
 * simplemente no ocurre, sin que nada lo delate.
 */
export function hasScheduledOperations(model) {
  return (model.services ?? []).some((service) =>
    (service.operations ?? []).some((operation) => operation.schedule)
  );
}

// El segundo de arranque de cada @Scheduled, repartido dentro del minuto.
//
// El DSL declara un cron de CINCO campos y Spring quiere seis: el de segundos lo pone
// build. Ponerlo a 0 en todos hacía que varios barridos que comparten cadencia —y
// compartirla es lo natural, "cada cinco minutos" es la declaración obvia— arrancaran
// en el mismo instante, y en todas las réplicas a la vez. Lo que se amontona ahí no es
// la base de datos (el reclamo es un UPDATE corto) sino las LLAMADAS SALIENTES: todos
// los barridos empujando a sus proveedores en el mismo segundo.
//
// Repartir la fase no cambia nada de lo que el diseño declara: la cadencia sigue siendo
// la de su cron, solo cambia en qué segundo del minuto cae. Y es la misma decisión que
// build ya tiene tomada a mano para sus purgas (outbox a las 3:00, processed_event a
// las 4:00, idempotency_record a las 4:30), aplicada donde no se aplicaba.
//
// El reparto es por ÍNDICE, no por hash del nombre: lo que se busca es que NO coincidan,
// y solo el índice lo garantiza —un hash reparte igual de bien en promedio y colisiona—.
// El precio es que añadir un barrido corre la fase de los demás, y en un archivo que
// build reescribe entero eso no cuesta nada.
//
// Es una mitigación, no una garantía: reparte el ARRANQUE. Dos barridos que duren más
// que su separación se solapan igual, y contra eso el segundo inicial no puede nada.
export function scheduleSeconds(model) {
  const scheduled = (model.services ?? []).flatMap((service) =>
    (service.operations ?? []).filter((operation) => operation.schedule)
  );
  const seconds = new Map();
  scheduled.forEach((operation, index) => {
    seconds.set(operation.name, Math.round((index * 60) / scheduled.length) % 60);
  });
  return seconds;
}

export function generate(model) {
  const files = [];
  // Se calcula una vez para todo el modelo, no por servicio: dos agregados con barrido
  // son dos clases Scheduler distintas, pero corren en el mismo proceso y contra los
  // mismos proveedores. Repartir dentro de cada clase los dejaría coincidiendo entre sí.
  const seconds = scheduleSeconds(model);
  for (const service of model.services) {
    for (const operation of service.operations) {
      files.push(renderMessage(model, operation));
      files.push(renderHandler(model, service, operation));
    }
    const scheduled = service.operations.filter((operation) => operation.schedule);
    if (scheduled.length > 0) files.push(renderScheduler(model, service, scheduled, seconds));
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

/** ¿Este componente va envuelto en `JsonNullable<T>` por ser opcional de un PATCH? */
function isWrappedInJsonNullable(operation, component, fromPath) {
  if (!isPartialUpdate(operation) || fromPath.has(component.name)) return false;
  if (component.required || component.file) return false;
  return operation.bodyFields.some((field) => field.name === component.name);
}

/**
 * Tipo del componente y sus anotaciones, ya colocadas donde Bean Validation las
 * entiende.
 *
 * <p>La colocación es lo delicado, y equivocarla no da un aviso: da un 500. Sobre un
 * campo envuelto, `@Size(max = 200) JsonNullable<String>` deja la constraint sobre el
 * CONTENEDOR, y Hibernate Validator resuelve el validador por el tipo declarado —
 * antes de mirar el valor—, así que lanza `UnexpectedTypeException` (HV000030) en
 * **toda** petición que traiga el campo, sea válido o no. El endpoint entero nace
 * roto, y de una forma que ninguna comparación de cadenas ve: el texto contiene la
 * anotación y contiene el tipo.
 *
 * <p>Lo correcto es dentro del genérico —`JsonNullable<@Size(max = 200) String>`—,
 * que es además lo que dice el contrato: la restricción es del VALOR, no de que el
 * campo venga o deje de venir. El `JsonNullableValueExtractor` que genera `web.js`
 * es lo que hace que Bean Validation sepa desenvolverlo.
 */
function renderComponentType(operation, component, fromPath, imports, annotations) {
  const prefix = annotations.length > 0 ? `${annotations.join(' ')} ` : '';
  if (!isWrappedInJsonNullable(operation, component, fromPath)) {
    return `${prefix}${component.javaType}`;
  }
  imports.add(JSON_NULLABLE_IMPORT);
  return `JsonNullable<${prefix}${component.javaType}>`;
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
    return `        ${renderComponentType(operation, component, fromPath, imports, annotations)} ${component.name}`;
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

  // Dependencias con otros servidores. Mismo criterio que el RefResolver: lo que
  // el handler necesita para cumplir lo que el diseño le atribuyó se inyecta, o
  // el camino de menor resistencia es no llamarlo. `usedBy` y `triggeredBy` son
  // el único enlace del DSL entre el caso de uso y el trabajo que delega.
  const injected = new Set(dependencies.map((dep) => dep.type));
  const inject = (type, pkg) => {
    if (injected.has(type)) return;
    injected.add(type);
    imports.add(`${subPackage(model, pkg)}.${type}`);
    dependencies.push({ type, name: type[0].toLowerCase() + type.slice(1) });
  };
  for (const { need } of operation.dependencyNeeds ?? []) {
    // on-demand: se pide al proveedor en el momento, por el puerto del cliente.
    if (need.strategy === 'on-demand' && need.fetch) inject(need.fetch.clientClass, 'domain.clients');
    // replicada: se lee por el Reader, que es quien aplica onMiss. Nunca el
    // repositorio de la réplica: saltárselo se salta la política declarada.
    if (need.strategy === 'replicated' && need.replica) inject(need.replica.readerClass, 'application.projection');
  }
  for (const { activation } of operation.dependencyActivations ?? []) {
    // Solo el canal síncrono inyecta: `via.publishes` lo emite el agregado.
    if (activation.http) inject(activation.http.clientClass, 'domain.clients');
  }
  // El registro de idempotencia, por el mismo criterio que lo anterior: el diseño
  // le atribuyó a esta operación la garantía de no ejecutarse dos veces, y sin el
  // puerto delante el camino de menor resistencia es no usarlo — o escribir otro.
  if (operation.idempotency && model.layersPresent.persistence) {
    inject('IdempotencyStore', 'domain.idempotency');
  }

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
    const common =
      `find(scope, clave) con scope="${operation.name}"; si hay registro con la MISMA firma, reconstruye la respuesta desde su resourceId sin re-ejecutar nada (ni escrituras ni eventos); si la firma difiere, lanza IdempotencyReuseException (${FRAMEWORK_ERRORS.idempotencyReuse.http} ${effectiveErrorCode(model, FRAMEWORK_ERRORS.idempotencyReuse)}), que build genera para eso — no inventes un code ni reutilices el de la carrera, que es otro desenlace; si no hay registro, ejecuta y llama a save(...) dentro de la misma transacción del comando. ` +
      // La CARRERA no la resuelve el find: dos peticiones simultáneas lo fallan las dos
      // —ninguna ha commiteado— y llegan las dos a save. Quien arbitra es la clave
      // primaria del registro, y el adaptador ya traduce esa violación al 409 del
      // contrato. Sin decirlo, el camino de menor resistencia es envolver save en un
      // try/catch «defensivo» que se traga justo la excepción que cierra la ventana, y
      // el resultado es un servidor que pasa el reintento secuencial y ejecuta dos veces
      // bajo concurrencia — que es el caso normal en cuanto hay más de una réplica.
      `La CARRERA (dos peticiones con la misma clave a la vez) no la ve find: las dos encuentran vacío y las dos llegan a save. La arbitra la clave primaria del registro y el adaptador ya traduce la violación a IdempotencyConflictException (${FRAMEWORK_ERRORS.idempotencyRace.http} ${effectiveErrorCode(model, FRAMEWORK_ERRORS.idempotencyRace)}) — NO captures esa excepción ni la DataIntegrityViolationException que la origina: dejarla subir es lo que garantiza que de dos peticiones idénticas se ejecutó exactamente una. ` +
      `Qué NO cubre: la reentrega del mismo mensaje por el broker — esa la para el IdempotencyGuard del listener (tabla processed_event), que es otro mecanismo y no se toca desde aquí`;
    // De dónde sale la clave cambia el ESQUELETO del handler, no un detalle: con
    // payload-hash no hay cabecera que pueda faltar, así que la rama "sin clave,
    // ejecuta sin deduplicar" no existe — escribirla dejaría la operación sin
    // deduplicar nunca, en silencio.
    const source =
      operation.idempotency.keySource === 'payload-hash'
        ? `La clave es CommandSignature.of(command) (application/support), que también es la firma: aquí NO hay cabecera ni IdempotencyContext, y por tanto tampoco caso "sin clave" — siempre se deduplica. `
        : `La clave llega por IdempotencyContext.get() (vacío = el cliente no mandó la cabecera: ejecuta sin deduplicar, no rechaces) y la firma es CommandSignature.of(command) (application/support) — no la calcules a mano. Si hay clave: `;
    notes.push(
      `Idempotencia: keySource=${operation.idempotency.keySource}, ttlSeconds=${ttl}. El puerto IdempotencyStore, su adaptador y CommandSignature ya están generados — NO escribas otro registro (ni tabla propia, ni SET NX en la caché) ni otra forma de firmar. ${source}${common}`
    );
  }
  // Reconciliar es lo contrario de reaccionar: esta operación no la dispara ningún
  // hecho, la dispara el reloj, y lo que busca es lo que NO ha pasado. Sin esta nota
  // su stub sería un @Scheduled vacío.
  for (const { dependency, activation, waiting } of operation.reconciles ?? []) {
    notes.push(
      `Reconciliación de ${dependency}.${activation.name}: barre los encargos que nunca recibieron desenlace — el evento que los cerraría puede no llegar nunca. ` +
        (waiting.length > 0
          ? `Los candidatos son ${waiting.join(', ')} que llevan demasiado tiempo ahí. `
          : `Los candidatos son las entidades que quedaron esperando el desenlace. `) +
        `DESDE CUÁNDO: el estado dice que espera, no cuánto lleva. La marca temporal es un campo de la entidad que estampa la operación que encarga; por convención se llama ${activation.name}AwaitingSince, así que empieza buscando ese, y si el diseño lo nombró de otro modo busca la marca de espera equivalente. NO uses createdAt —es cuándo nació la entidad, no cuándo empezó a esperar— ni un updatedAt de auditoría, que rejuvenece con cualquier otra escritura y deja la entidad invisible al barrido para siempre. Si la entidad espera VARIOS desenlaces, usa la marca de ESTA activación y no la de otra: con una compartida el segundo encargo pisa la del primero y el umbral mide una espera que no es la suya. Si el diseño no declara ninguna marca, es designGap. ` +
        `El umbral de "demasiado tiempo" NO lo declara el diseño: sácalo de parameters/ con un default explícito, nunca de una constante en el código. ` +
        `Y decide qué hace con cada uno según el efecto declarado ("${activation.effect}"): reintentar el encargo o disparar la compensación. Si el diseño no lo dice, es designGap. ` +
        `CONCURRENCIA: este método corre en TODAS las réplicas del servicio a la vez, así que la consulta tiene que RECLAMAR los candidatos, no solo leerlos, y el lote va acotado (Pageable/limit) para que cada réplica se lleve un conjunto disjunto. ` +
        `CÓMO se reclama no es indiferente, porque la llamada al proveedor va EN MEDIO: reclama con una MARCA PERSISTIDA (UPDATE … SET ${activation.name}ClaimedAt = now, o findAndModify en Mongo) que confirmas ANTES de llamar, no con un lock pesimista. Un lock solo aísla mientras dura su transacción, así que sostenerlo durante la llamada retendría una conexión del pool por la latencia de un tercero. El ejemplo a copiar es la rama DOCUMENTAL de OutboxRelay (claimPending(), con claim-timeout-ms); la relacional usa lock pesimista y NO es el modelo aquí, porque lo que envuelve su transacción es la entrega al broker, corta y local. ` +
        `La marca CADUCA: como sobrevive al commit, sobrevive también a la réplica que muera con el candidato en vuelo, y sin plazo lo retendría para siempre. El timeout sale de parameters/ igual que el umbral, y se dimensiona claim-timeout > lote × timeout de llamada; por debajo, dos réplicas actúan sobre el mismo candidato. ` +
        `NO vale reclamar con SKIP LOCKED y confirmar antes de llamar: al confirmar se suelta el lock y no queda nada en la fila que diga que alguien la tomó, así que las N vuelven a verla y todas actúan — el fallo exacto que el reclamo evita, con apariencia de resuelto. Es lo único de este barrido que check-idempotency.sh no puede distinguir: ve el patrón del reclamo, no dónde cae el commit. ` +
        `La transición del agregado NO basta: las réplicas leen antes de que ninguna confirme, así que todas pasan el guard y todas actúan; lo único que absorbe las llamadas repetidas al proveedor es la idempotencia saliente. ` +
        `Y si lo que haces es reencargar publicando un evento, no lo absorbe nada: cada réplica hace su propio raise y estampa un metadata.eventId distinto, así que para el consumidor son N hechos y su processed_event no los deduplica. ` +
        `ORDEN: son DOS commits y no se confunden — (1) marcar el reclamo y confirmar, que es lo que lo hace visible a las demás réplicas; (2) llamar al proveedor, fuera de toda transacción; (3) transición al estado final y confirmar. Si actúas contra el proveedor y mueres antes de (3), la entidad sigue reclamada y al caducar la marca la siguiente pasada repite la llamada, que es lo que absorbe la idempotencia saliente: tiene red. Al revés —confirmar el desenlace y luego actuar— si mueres en medio dejas la entidad resuelta y el trabajo vivo en el proveedor: un huérfano que no detecta nadie. ` +
        `CARRERA CON EL CAMINO FELIZ: mientras barres puede llegar el evento de desenlace. Si al mover el candidato lo encuentras ya fuera del estado de espera, ganó el otro camino: es la carrera resuelta, no un fallo — no lo registres como error ni lo reintentes`
    );
  }
  // Compensar no es "otra escritura": deshace trabajo ya encargado a otro servidor,
  // llega por un canal at-least-once y puede llegar antes que el hecho que compensa.
  // Nada de eso se ve leyendo la operación sola, así que se escribe aquí.
  if (operation.compensates) {
    const { dependency, undoes, moves, event, deduplicated } = operation.compensates;
    const restored = new Set((operation.transitions ?? []).map((transition) => transition.entity));
    const pending = moves.filter((entity) => !restored.has(entity));
    const guard = (operation.transitions ?? []).length > 0 ? 'transitions' : deduplicated ? 'messageId' : null;
    notes.push(
      `Compensación de ${dependency}${undoes ? ` — deshace la activación '${undoes}'` : ''}: la dispara la suscripción a ${event}. ` +
        (moves.length > 0
          ? `El trabajo que deshaces movió el lifecycle de ${moves.join(', ')}: devolver ese estado es parte de la compensación, no un extra${pending.length > 0 ? ` (el diseño NO declara transición sobre ${pending.join(', ')} — repórtalo como designGap en vez de inventar el estado destino)` : ''}. `
          : '') +
        (guard === 'transitions'
          ? `Aplicarla dos veces no debe deshacer dos veces: la guarda es la transición del agregado, que rechaza la segunda desde un estado que ya no está en 'from'. Va en el DOMINIO, no en el handler.`
          : guard === 'messageId'
            ? `Aplicarla dos veces no debe deshacer dos veces: la guarda es la deduplicación del listener por el id del mensaje (IdempotencyGuard). El handler no añade ninguna otra.`
            : `Aplicarla dos veces no debe deshacer dos veces y el diseño no declara guarda: repórtalo como designGap.`)
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
  // Lo que este caso de uso debe a otros servidores. Va al final de las notas
  // porque es lo último que se resuelve: el dato de fuera se trae antes de
  // decidir, y el trabajo delegado sale después de haber decidido.
  for (const { dependency, need } of operation.dependencyNeeds ?? []) notes.push(needNote(dependency, need, operation));
  for (const { dependency, activation } of operation.dependencyActivations ?? []) {
    notes.push(activationNote(dependency, activation));
  }
  // Orden de los efectos. Solo se dice cuando hay las dos cosas, porque solo entonces
  // se puede equivocar: una llamada saliente NO participa de la transacción, así que
  // si sale antes de la guarda de estado y la guarda rechaza, el rollback deshace la
  // fila y deja el encargo hecho. Es el fallo que convierte una reentrega inocente en
  // un doble efecto real contra otro servidor.
  //
  // Y NO se dice en un barrido, aunque tenga las dos cosas: ahí el orden lo fija la nota
  // de reconciliación, que es el contrario y por buenas razones. La regla de abajo existe
  // para que la guarda del agregado rechace ANTES de una llamada irreversible; en un
  // barrido esa arbitración ya la hizo el reclamo, y la transición no es la precondición
  // sino el DESENLACE de la llamada. Aplicarla primero sería resolver la entidad sin saber
  // si el proveedor aceptó — el orden que deja el trabajo vivo y a nadie buscándolo. Dos
  // órdenes opuestos en el mismo stub no son dos consejos: son uno que el agente va a
  // elegir al azar.
  const outgoing = (operation.dependencyActivations ?? []).filter(({ activation }) => activation.http);
  if ((operation.transitions ?? []).length > 0 && outgoing.length > 0 && !(operation.reconciles ?? []).length) {
    const names = outgoing.map(({ dependency, activation }) => `${dependency}.${activation.name}`).join(', ');
    const guards = operation.transitions
      .map((t) => `${t.entity}: ${(t.from ?? []).join('|')} → ${t.to}`)
      .join('; ');
    notes.push(
      `ORDEN de los efectos: aplica PRIMERO la transición de estado (${guards}) y solo después llama a ${names}. ` +
        `La llamada saliente no es transaccional: si sale antes y la guarda del agregado rechaza el cambio, el rollback ` +
        `revierte la fila pero el trabajo ya está encargado en el otro servidor y nadie lo deshace`
    );
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

function decap(name) {
  return name[0].toLowerCase() + name.slice(1);
}

// Nota de una necesidad (`needs`): de dónde sale el dato ajeno que esta
// operación necesita, y por dónde NO se lee.
// Dónde TERMINA el dato, cuando el diseño declara que además se devuelve. Sin esta
// mitad, la nota decía cómo traerlo y nada más: el camino de menor resistencia era
// pedirlo, mapearlo a dominio y descartarlo. El mapper ya lo exige por parámetro —no
// compila sin él—, así que esto solo dice de dónde sacarlo.
function exposeNote(need, operation) {
  if (!need.exposedAs || !need.dtoName) return '';
  const many = Boolean(operation?.returnsList || operation?.paginated);
  const batch =
    need.strategy === 'replicated' && many
      ? ` Como la salida es de varios elementos, resuélvelo POR LOTE (una consulta con todas las claves) y NUNCA con una llamada dentro del stream: eso es un N+1.`
      : '';
  return ` El dato SALE en la respuesta: el mapper pide un ${need.dtoName} por parámetro y lo pone en el campo '${need.exposedAs}' — si no lo tienes, pásalo nulo, que es lo que el contrato admite cuando el proveedor no responde.${batch}`;
}

function needNote(depId, need, operation) {
  const why = need.description ? ` — ${need.description}` : '';
  if (need.strategy === 'on-demand') {
    if (!need.fetch) {
      return `Dependencia ${depId}.${need.name} (on-demand)${why}: el diseño no resuelve la llamada (fetchedFrom no apunta a ninguna de http-clients). No inventes el canal: dilo en el reporte`;
    }
    return `Dependencia ${depId}.${need.name} (on-demand)${why}: pide el dato a ${depId} con ${decap(need.fetch.clientClass)}.${need.fetch.call}(...) y mapea el ${need.fetch.resultType} a dominio con ${decap(need.fetch.mapperClass)} — el record wire nunca cruza a domain ni a application. El retry y el circuit breaker ya están en el adaptador: no los repitas (conventions/dependencies.md).${exposeNote(need, operation)}`;
  }

  const { replica } = need;
  if (!replica) {
    return `Dependencia ${depId}.${need.name} (replicada)${why}: la réplica no se pudo resolver (revisa los avisos del build); no leas el dato por tu cuenta`;
  }
  const reader = `${decap(replica.readerClass)}.byKey(...)`;
  const onMiss = {
    fetch: `Si la copia aún no tiene el dato, el Reader lo pide al proveedor y lo guarda: no lo hidrates tú.`,
    fail: `Si la copia aún no tiene el dato, el Reader lanza ${replica.onMiss.exceptionClass ?? replica.onMiss.error}: no lo captures para seguir con un valor inventado.`,
    degrade: `Si la copia aún no tiene el dato, el Reader devuelve vacío y el resultado degradado lo escribes TÚ, distinguible por el cliente de una respuesta normal: ${replica.onMiss.degradedTo}`
  }[replica.onMiss.action];
  return `Dependencia ${depId}.${need.name} (replicada)${why}: lee ${replica.entityName} por ${reader}, que ya aplica onMiss: ${replica.onMiss.action}. ${onMiss} NUNCA leas el repositorio de la réplica directamente ni la escribas desde aquí — la proyección solo se escribe desde ${replica.projectorClass} (conventions/dependencies.md).${exposeNote(need, operation)}`;
}

// Nota de una activación (`activations`): el trabajo que esta operación delega
// en otro servidor. Es lo que el DSL declara y ningún artefacto materializaba.
function activationNote(depId, activation) {
  if (activation.event) {
    const raise = activation.event.className ? `raise(${activation.event.className}.of(...))` : 'raise(...)';
    return `Activación ${depId}.${activation.name}: ${activation.effect} — se delega publicando ${activation.event.name}, que emite el agregado con ${raise} dentro del método de negocio. El handler no publica nada, y no esperes respuesta: publicar un evento no devuelve resultado`;
  }
  if (!activation.http) {
    return `Activación ${depId}.${activation.name}: ${activation.effect} — el diseño no resuelve el canal (via.client/call no existe en http-clients). No inventes la llamada: dilo en el reporte`;
  }

  const awaits = {
    outcome: `awaits: outcome — el resultado que devuelve ${depId} condiciona el desenlace de esta operación: usa el cuerpo de la respuesta, no basta con que la llamada no falle.`,
    acknowledgement: `awaits: acknowledgement — basta con que ${depId} acuse recibo; no interpretes el cuerpo como parte del desenlace.`,
    nothing: `awaits: nothing — no se espera nada de vuelta, pero la llamada sigue siendo síncrona y ocurre DENTRO de la transacción que abrió el UseCaseMediator: su timeout la mantiene abierta (conventions/dependencies.md § transacción).`
  }[activation.awaits];

  const onFailure = activation.onFailure;
  const failure = {
    ignore: `onFailure: ignore — que ${depId} no responda no interrumpe esta operación; el fallback del adaptador ya lo absorbe y lo registra. No lo reintentes aquí.`,
    fail: `onFailure: fail — si ${depId} no responde, esta operación falla con ${onFailure?.exceptionClass ?? onFailure?.error}; el fallback del adaptador ya la lanza. No la captures para convertirla en otra cosa.`,
    degrade: `onFailure: degrade — si ${depId} no responde, esta operación degrada y el resultado degradado lo escribes TÚ: ${onFailure?.degradedTo}`
  }[onFailure?.action];

  return `Activación ${depId}.${activation.name}: ${activation.effect} — invoca ${decap(activation.http.clientClass)}.${activation.http.call}(...). ${awaits} ${failure ?? ''}`.trim();
}

function renderScheduler(model, service, scheduled, seconds) {
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
    // El DSL usa cron de 5 campos; Spring añade el campo de segundos al inicio, y ese
    // segundo lo reparte scheduleSeconds() para que dos barridos con la misma cadencia
    // no arranquen a la vez. No es decorativo: si vuelve a 0 en todos, vuelven a salir
    // todas las llamadas al mismo tiempo.
    return `${description}    @Scheduled(cron = "${seconds.get(operation.name) ?? 0} ${operation.schedule.cron}")
    public void ${operation.name}() {
        ${call}
    }`;
  });

  const body = `/**
 * Disparadores por reloj de las operaciones que declaran \`schedule\`.
 *
 * <p><strong>Cada método corre en TODAS las réplicas del servicio</strong>: \`@Scheduled\` es
 * "una vez por instancia", no "una vez en el clúster". El handler de una operación que
 * ACTÚA sobre lo que encuentra (un barrido de reconciliación) tiene que reclamar sus
 * candidatos en vez de solo leerlos — el patrón está en {@code OutboxRelay} y en
 * docs/keel/conventions/dependencies.md. Las purgas generadas no lo necesitan: borrar lo
 * caducado es idempotente por forma.
 *
 * <p><strong>El campo de segundos del cron no es 0 por casualidad.</strong> El diseño
 * declara cinco campos y build añade el sexto, repartiendo el arranque dentro del minuto
 * para que dos operaciones con la misma cadencia no salgan a la vez: lo que se amontona
 * cuando coinciden no son las consultas —el reclamo es corto— sino las llamadas a los
 * proveedores. La cadencia declarada no cambia; solo en qué segundo del minuto cae.
 * Igualarlos a 0 «por limpieza» deshace ese reparto.
 */
@Component
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
