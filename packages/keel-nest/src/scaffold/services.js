// Capa application con el patrón mediator: por cada operación, su mensaje CQRS (en
// application/commands o application/queries) y su handler en application/usecases, que es donde el
// agente implementa la lógica. El mismo reparto que keel-spring.
//
// El mensaje es una clase inmutable con sus campos declarados (los decoradores de validación del
// borde los pone el incremento 5 sobre ellos) y un constructor por objeto: con muchos campos, una
// lista posicional se desordena sin que el compilador lo note si dos comparten tipo.
//
// El handler nace con las notas del diseño (precondiciones, reglas, errores, eventos, formato) y
// termina en `throw`: COMPILA y falla en ejecución nombrando la operación, como el
// UnsupportedOperationException de keel-spring. No importa nada de Nest: lo marca
// @ApplicationComponent(), declara su mensaje con @Handles(...) y sus dependencias en `inject`.
//
// Lo que cuelga de capas que keel-nest todavía no genera (el puerto del repositorio, el almacén de
// idempotencia, el correo, los clientes salientes) llega con su incremento: el handler de hoy solo
// inyecta lo que existe.

import { DIRS, classPath, declType, fieldImports, isNullable, tsModule, tsdoc } from './render.js';
import { callerResolution } from './security.js';
import { mailPorts, sendsMail } from './mail.js';
import { ANNOTATIONS_TS, HANDLERS_TS, MESSAGES_TS } from './mediator.js';
import { PAGED_RESPONSE_TS } from './dtos.js';
import { repositoryRoots, portClass, portPath, occupantFinders, PAGE_TS } from './repositories.js';
import { relievingOperations, effectiveErrorCode, scheduleDispatch } from 'keel-core/gen';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { DEFAULT_IDEMPOTENCY_TTL_SECONDS } from 'keel-core/gen/request-idempotency';
import { IDEMPOTENCY_STORE_TS, usesRequestIdempotency } from './request-idempotency.js';
import { CALLER_SCOPE_TS, scopedOperation } from './security.js';
import { schedulerPath } from './scheduling.js';
import { followUpRejectionNote } from 'keel-core/gen/rejection-notes';
import { portPath as clientPortPath } from './http-clients.js';

export function generate(model) {
  const files = [];
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      files.push(renderMessage(model, operation));
      files.push(renderHandler(model, operation));
    }
  }
  return files;
}

export function messagePath(operation) {
  return classPath(operation.messageKind === 'query' ? DIRS.queries : DIRS.commands, operation.messageClass);
}

export function handlerPath(operation) {
  return classPath(DIRS.usecases, operation.handlerClass);
}

/**
 * Componentes del mensaje: parámetros de ruta (en el orden del path) + campos del cuerpo +
 * paginación. Los comparte el controlador (incremento 5) para construir el mensaje.
 */
export function messageComponents(model, operation) {
  const components = [...(operation.pathParams ?? []), ...(operation.bodyFields ?? [])];
  if (operation.paginated) {
    if (repositoryRoots(model).length > 0) {
      // Con persistencia, la página viaja como un Pageable (página, tamaño y orden), el de Spring Data.
      components.push({ name: 'pageable', tsType: 'Pageable', elementTsType: 'Pageable', kind: 'base', required: true, pageable: true, imports: [{ symbol: 'Pageable', from: PAGE_TS, type: true }] });
    } else {
      // Sin persistencia, dos enteros.
      components.push({ name: 'page', tsType: 'number', elementTsType: 'number', kind: 'base', base: 'int', required: true, imports: [] });
      components.push({ name: 'size', tsType: 'number', elementTsType: 'number', kind: 'base', base: 'int', required: true, imports: [] });
    }
  }
  return components;
}

/** El tipo de retorno de la operación, o null si no devuelve nada. */
export function returnTypeOf(operation) {
  if (!operation.responseDto) return null;
  // PagedResponse<T> ya envuelve la lista: envolverla además daría PagedResponse<T[]>.
  if (operation.paginated) return `PagedResponse<${operation.responseDto.name}>`;
  if (operation.returnsList) return `${operation.responseDto.name}[]`;
  return operation.responseDto.name;
}

function returnImports(operation) {
  const imports = [];
  if (operation.responseDto) imports.push({ symbol: operation.responseDto.name, from: classPath(DIRS.dtos, operation.responseDto.name), type: true });
  if (operation.paginated) imports.push({ symbol: 'PagedResponse', from: PAGED_RESPONSE_TS, type: true });
  return imports;
}

/** ¿Es una actualización parcial (PATCH)? Un opcional del cuerpo tiene TRES estados. */
export function isPartialUpdate(operation) {
  return operation.route?.method === 'PATCH';
}

/** Mensaje y handler que corresponden a la clase de la operación. */
function contracts(operation, returnType) {
  if (operation.messageKind === 'query') {
    return { base: `Query<${returnType ?? 'void'}>`, baseSymbol: 'Query', handler: `QueryHandler<${operation.messageClass}, ${returnType ?? 'void'}>`, handlerSymbol: 'QueryHandler' };
  }
  if (operation.messageKind === 'returningCommand') {
    return { base: `ReturningCommand<${returnType}>`, baseSymbol: 'ReturningCommand', handler: `ReturningCommandHandler<${operation.messageClass}, ${returnType}>`, handlerSymbol: 'ReturningCommandHandler' };
  }
  return { base: 'Command', baseSymbol: 'Command', handler: `CommandHandler<${operation.messageClass}>`, handlerSymbol: 'CommandHandler' };
}

function renderMessage(model, operation) {
  const file = messagePath(operation);
  const returnType = returnTypeOf(operation);
  const contract = contracts(operation, returnType);
  const imports = [{ symbol: contract.baseSymbol, from: MESSAGES_TS }, ...returnImports(operation)];
  const fromPath = new Set((operation.pathParams ?? []).map((param) => param.name));
  const partial = isPartialUpdate(operation);
  const components = messageComponents(model, operation);

  const declarations = [];
  const props = [];
  const assigns = [];
  for (const component of components) {
    imports.push(...fieldImports(model, component));
    // En un PATCH, un opcional del cuerpo distingue AUSENTE (undefined: conserva el valor) de
    // PRESENTE CON NULL (vacía el campo). El tipo lo dice: `campo?: T | null`.
    const threeState = partial && !fromPath.has(component.name) && !component.required && !component.list && (operation.bodyFields ?? []).some((f) => f.name === component.name);
    // Un campo con default puede no llegar (por eso la entrada no exige su presencia): en el
    // mensaje admite null, y el default lo aplica el dominio.
    // La identidad resuelta contra varias credenciales (resolvedBy) puede no ser de nadie: el mensaje lleva
    // null y la operación responde con el error que declare el diseño (la misma decisión que keel-spring).
    const unresolvable = component.resolvedIdentity && callerResolution(model) != null;
    const type = (component.initializer != null && !component.generated && !component.list && !isNullable(component)) || unresolvable
      ? `${declType(component)} | null`
      : declType(component);
    const optional = threeState ? '?' : '';
    const notes = componentNotes(model, component, fromPath);
    declarations.push(`${notes}${tsdoc(component.description, '  ')}  readonly ${component.name}${optional}: ${type}${threeState && !isNullable(component) ? ' | null' : ''};`);
    props.push(`    readonly ${component.name}${optional}: ${type}${threeState && !isNullable(component) ? ' | null' : ''};`);
    assigns.push(`    this.${component.name} = ${scaleRounded(component, `props.${component.name}`)};`);
  }

  const scope = idempotencyScope(operation);
  const body = `${tsdoc(operation.description)}export class ${operation.messageClass} extends ${contract.base} {
${declarations.join('\n')}${declarations.length > 0 ? '\n\n' : ''}  constructor(${components.length > 0 ? `props: {\n${props.join('\n')}\n  }` : ''}) {
    super();${assigns.length > 0 ? `\n${assigns.join('\n')}` : ''}
  }${scope}
}`;
  return { path: file, content: tsModule(file, imports, body) };
}

/**
 * `constraints.scalePolicy: round` (DSL 2.14): el decimal escalar se redondea a su escala al
 * ENTRAR. No tiene clase propia donde normalizarse —la de un compuesto la pone su value object—,
 * así que va en el mensaje, el primer punto por el que pasa. `reject` no necesita nada aquí: lo dice
 * la validación del borde (incremento 5).
 */
function scaleRounded(component, expression) {
  const numeric = component.numeric;
  if (component.kind === 'composite' || !numeric?.decimal || numeric.scalePolicy !== 'round') return expression;
  return `${expression} == null ? ${expression} : ${expression}.setScale(${numeric.scale}, 'HALF_UP')`;
}

/** Las notas de un componente del mensaje que el diseño obliga a decir donde se ve. */
function componentNotes(model, component, fromPath) {
  const notes = [];
  if (fromPath.has(component.name)) return '';
  // El formato heredado de un value type se valida YA en la entrada (keel-core/gen/constraints.js): un valor mal
  // formado es un 400 antes que cualquier error de negocio. El dominio lo repite para lo que no entra por la API.
  const inherited = component.list ? null : component.inheritedPattern;
  if (inherited) {
    notes.push(
      `El formato del value type ${component.typeName ?? 'del campo'} (${inherited}) se valida YA en la entrada: mal formado`,
      'es un 400 antes que cualquier precondición. No lo valides otra vez al principio del handler.',
      `El dominio lo repite con ${component.typeName}Format.validate(...) (${classPath(DIRS.valueObjects, `${component.typeName}Format`)})`,
      'en el factory o el método de negocio de la entidad que recibe el valor: es lo que cubre lo que no entra por',
      'la API (un evento, una operación interna), y lo exige el gate check-domain-guards.sh.'
    );
  }
  if (component.resolvedIdentity) {
    notes.push(
      'Lo resuelve el servidor desde la credencial (security.authentication.callerIdentity): no llega del',
      'cuerpo, lo estampa el controlador.'
    );
    const resolution = callerResolution(model);
    if (resolution) {
      // Resuelto ya en la puerta: las dos (controlador y listener) pasan la clave natural, así que el handler
      // no vuelve a mirar credenciales. Lo único que decide es qué hacer con el null.
      notes.push(
        `Llega YA resuelto a la clave natural de ${resolution.entity.name} (${resolution.keyField}): por HTTP lo resuelve`,
        `CallerIdentityResolver con ${resolution.port}.${resolution.finder}(...), y por eventos el listener con el`,
        `mismo finder. null = la credencial no pertenece a ningún ${resolution.entity.name}: es la precondición de la`,
        'operación y responde con el error que el diseño declare para ella.'
      );
    }
  }
  return notes.length > 0 ? `${notes.map((line) => `  // ${line}`).join('\n')}\n` : '';
}

/**
 * El ÁMBITO de la clave de idempotencia, ya compuesto (DSL 2.17, `idempotency.partitionBy`): la
 * misma decisión que keel-spring. Lo usa el registro de idempotencia (request-idempotency.js).
 */
function idempotencyScope(operation) {
  const idempotency = operation.idempotency;
  if (!idempotency || idempotency.guard === 'natural-key') return '';
  const partition = idempotency.partitionBy ?? [];
  const value = [operation.name, ...partition.map((field) => `\${String(this.${field})}`)].join(':');
  return `

  /**
   * Ámbito de la clave de idempotencia: ${partition.length > 0 ? `la operación y ${partition.join(', ')} (idempotency.partitionBy)` : 'la operación (sin partitionBy la clave es GLOBAL entre llamantes: lo decidió el diseño)'}.
   * No lo compongas a mano.
   */
  idempotencyScope(): string {
    return \`${value}\`;
  }`;
}

function renderHandler(model, operation) {
  const file = handlerPath(operation);
  const returnType = returnTypeOf(operation);
  const contract = contracts(operation, returnType);
  const imports = [
    { symbol: 'ApplicationComponent', from: ANNOTATIONS_TS },
    { symbol: 'Handles', from: ANNOTATIONS_TS },
    { symbol: contract.handlerSymbol, from: HANDLERS_TS, type: true },
    { symbol: operation.messageClass, from: messagePath(operation) },
    ...returnImports(operation)
  ];

  const dependencies = [];
  // El puerto del repositorio del agregado de la operación (el de su raíz si opera sobre una hija),
  // como en keel-spring: lo que el handler necesita para cumplir su caso de uso, inyectado.
  const repository = repositoryOf(model, operation);
  if (repository) {
    imports.push({ symbol: portClass(repository), from: portPath(repository) });
    dependencies.push({ type: portClass(repository), name: decap(portClass(repository)) });
  }
  // El registro de la idempotencia de petición: el handler lo usa (la nota de abajo dice cómo).
  if (usesRegistry(model, operation)) {
    imports.push({ symbol: 'IdempotencyStore', from: IDEMPOTENCY_STORE_TS });
    dependencies.push({ type: 'IdempotencyStore', name: 'idempotencyStore' });
  }
  // El alcance por recurso: el puerto ya está generado con su adaptador; el handler lo usa donde lo digan
  // las reglas (la nota de abajo).
  if (scopedOperation(model, operation)) {
    imports.push({ symbol: 'CallerScope', from: CALLER_SCOPE_TS });
    dependencies.push({ type: 'CallerScope', name: 'callerScope' });
  }
  // El trabajo que el diseño le atribuye a esta operación en otro servidor (`dependencies.activations`, por
  // `triggeredBy`): el puerto del cliente se inyecta, o el camino de menor resistencia es no llamarlo. Solo
  // el canal síncrono: `via.publishes` lo emite el agregado.
  for (const { activation } of operation.dependencyActivations ?? []) {
    const client = (model.httpClients ?? []).find((candidate) => candidate.clientClass === activation.http?.clientClass);
    if (!client || dependencies.some((dep) => dep.type === client.clientClass)) continue;
    imports.push({ symbol: client.clientClass, from: clientPortPath(client) });
    dependencies.push({ type: client.clientClass, name: decap(client.clientClass) });
  }
  // La salida por correo, por el mismo criterio (mail.sentBy es el único enlace del DSL entre un caso de uso y el
  // correo): sin el puerto delante, el camino de menor resistencia es no mandarlo, y no lo detecta nada.
  if (sendsMail(model, operation)) {
    for (const port of mailPorts(model)) {
      imports.push(port);
      dependencies.push({ type: port.symbol, name: decap(port.symbol) });
    }
  }
  if (operation.responseDto?.entity && model.entities.some((e) => e.name === operation.responseDto.entity)) {
    const mapper = `${operation.responseDto.entity}ApplicationMapper`;
    imports.push({ symbol: mapper, from: classPath(DIRS.mappers, mapper) });
    dependencies.push({ type: mapper, name: mapper[0].toLowerCase() + mapper.slice(1) });
  }

  const notes = handlerNotes(model, operation);
  const param = operation.messageKind === 'query' ? 'query' : 'command';
  const result = returnType ?? 'void';
  const ctor = dependencies.length > 0
    ? `\n\n  constructor(${dependencies.map((dep) => `private readonly ${dep.name}: ${dep.type}`).join(', ')}) {}`
    : '';
  const body = `${tsdoc(operation.description)}@ApplicationComponent()
@Handles(${operation.messageClass})
export class ${operation.handlerClass} implements ${contract.handler} {
  /** Dependencias del constructor, en su orden: las inyecta UseCaseModule. */
  static readonly inject = [${dependencies.map((dep) => dep.type).join(', ')}] as const;${ctor}

  async handle(${param}: ${operation.messageClass}): Promise<${result}> {
    // TODO (agente): implementar la lógica de negocio de esta operación.
${notes.map((note) => `    // ${note}`).join('\n')}${notes.length > 0 ? '\n' : ''}    throw new Error('TODO: ${operation.name}');
  }
}`;
  return { path: file, content: tsModule(file, imports, body) };
}

/** La raíz persistida del grupo de la operación, o null. */
function repositoryOf(model, operation) {
  const service = (model.services ?? []).find((group) => (group.operations ?? []).includes(operation));
  if (!service) return null;
  const target = model.entities.find((entity) => entity.name === service.entity);
  const rootName = target?.rootEntity ?? service.entity;
  return repositoryRoots(model).find((entity) => entity.name === rootName) ?? null;
}

function decap(name) {
  return name[0].toLowerCase() + name.slice(1);
}

function handlerNotes(model, operation) {
  const notes = [];
  // El relevo en un índice único condicionado: la ÚNICA forma de escribirlo que funciona es en orden.
  for (const relieving of relievingOperations(model).filter((r) => r.operation.name === operation.name)) {
    const occupant = occupantFinders(model, repositoryRoots(model).find((root) => root.name === relieving.entity.rootEntity) ?? relieving.entity)
      .find((finder) => finder.state === relieving.state);
    notes.push(
      `ORDEN OBLIGATORIO (índice único condicionado sobre ${relieving.entity.name}.${relieving.state}): esta operación RELEVA — saca una fila ` +
        `de '${relieving.state}' y mete otra en el mismo acto—, y el índice se comprueba por FILA y no se puede diferir. Retira la que ` +
        `estaba${occupant ? ` (la encuentras con ${relieving.entity.name}Repository.${occupant.name}(...))` : ''} y GUÁRDALA con save(...) ANTES ` +
        'de guardar la nueva: cada save escribe en ese momento, así que el orden de los save es el orden en que el motor los comprueba. ' +
        'Al revés, la transición legítima muere con el error de unicidad del diseño — un 409 en el camino feliz. No lo arregles quitando ' +
        'el índice: es el invariante que el diseño declaró.'
    );
  }
  if (sendsMail(model, operation)) {
    const guard = operation.guardClaim;
    notes.push(
      'Correo: esta operación lo manda (mail.sentBy). Compón el MailMessage y llama a this.mailSender.send(...). ' +
        'Un correo que sale NO lo deshace ningún rollback, así que la guarda tiene que estar CONFIRMADA antes del envío — ' +
        'no basta con que haya ocurrido: ' +
        (guard
          ? `empieza por ${guard.method}(...) del puerto ${guard.entity}Repository, que pasa el agregado a ${guard.to} en su PROPIA ` +
            'transacción y devuelve null si otra ejecución llegó antes (esa es la carrera perdida: tradúcela al error que el diseño ' +
            'declara para «ya no está disponible»). Hacer esa transición solo en memoria la deja sin existir para nadie hasta el ' +
            `commit final, que llega DESPUÉS del envío: si el proceso cae en medio, el agregado vuelve a ${guard.from.join(' o ')} ` +
            'y el ciclo siguiente manda un SEGUNDO correo a una persona real'
          : `${operation.idempotency ? 'la clave de idempotencia' : 'la transición declarada'} tiene que estar persistida y ` +
            'confirmada antes de llamar a this.mailSender.send(...), no solo aplicada en memoria') +
        '. Un MailDeliveryException con partial() es un correo que SALIÓ para alguien: no lo trates como «no salió». ' +
        'El adaptador y el renderizador ya están escritos: no los toques — ver la skill keel-nest-mail'
    );
  }
  for (const note of scheduleNotes(model, operation)) notes.push(note);
  for (const note of idempotencyNotes(model, operation)) notes.push(note);
  for (const note of textFilterNotes(model, operation)) notes.push(note);
  for (const text of operation.preconditions ?? []) notes.push(`Precondición: ${text}`);
  for (const text of operation.rules ?? []) notes.push(`Regla (en orden): ${text}`);
  // Lo que hace el handler cuando la pasarela contesta que NO (DSL 2.20): nota neutral, la misma en los dos generadores.
  const rejection = followUpRejectionNote(model.payments, operation.name);
  if (rejection) notes.push(rejection);
  for (const code of operation.errors ?? []) {
    const error = model.errors.find((e) => e.code === code);
    notes.push(
      `Error: lanzar ${error?.exceptionClass ?? code} (${code}, HTTP ${error?.http ?? 400})${error?.when ? ` cuando: ${error.when}` : ''}` +
        (error ? ` — ${classPath(DIRS.errors, error.exceptionClass)}` : '')
    );
  }
  const scoping = model.security?.scoping;
  if (scopedOperation(model, operation)) {
    notes.push(
      `Alcance (security.authentication.scoping): this.callerScope ya está inyectado; comprueba ` +
        `this.callerScope.covers(<${scoping.over} del recurso>) donde lo digan las reglas; fuera del alcance, ${scoping.error}. ` +
        `Exentos: ${scoping.exemptRoles.join(', ') || 'ninguno'}. En un listado, filtra por this.callerScope.scopedValues() con un ` +
        'finder acotado que escribes tú'
    );
  }
  for (const transition of operation.transitions ?? []) {
    notes.push(
      `Transición: ${transition.entity} ${(transition.from ?? []).join('|')} → ${transition.to}. La aplica el método semántico ` +
        'del agregado (que llama a transitionTo), nunca el handler asignando el estado.'
    );
  }
  for (const note of reconciliationNotes(operation)) notes.push(note);
  const compensation = compensationNote(operation);
  if (compensation) notes.push(compensation);
  for (const note of activationNotes(operation)) notes.push(note);
  for (const eventName of operation.emits ?? []) {
    const event = (model.events ?? []).find((e) => e.name === eventName);
    const emisores = [
      ...new Set((event?.emittedBy ?? []).filter((e) => e.operation === operation.name && e.aggregate).map((e) => e.aggregate))
    ];
    notes.push(
      `Emite: ${eventName} — lo hace ${emisores.length > 0 ? emisores.join(' o ') : 'el agregado'} con this.raise(${event?.className ?? `${eventName}Event`}.of(...)) dentro del método de negocio; el handler no publica nada`
    );
  }
  return notes.flatMap((note) => wrap(note));
}

/**
 * La nota de una operación disparada por reloj: cómo la despacha su scheduler (keel-core/gen/scheduling.js,
 * la misma decisión que keel-spring) y lo que eso le cambia al handler.
 */
/**
 * La nota de un barrido de RECONCILIACIÓN (incremento 11c), la de keel-spring. Dos formas: con el reclamo
 * generado no se le dice CÓMO reclamar —sería pedirle que reescriba lo que existe, y el camino de menor
 * resistencia es un segundo mecanismo en paralelo—; sin él, sí. Lo que es suyo en las dos (el ORDEN de los
 * commits, la carrera con el camino feliz, qué hacer con cada candidato) va en las dos.
 */
function reconciliationNotes(operation) {
  return (operation.reconciles ?? []).map(({ dependency, activation, waiting, claim }) => {
    const head =
      `Reconciliación de ${dependency}.${activation.name}: barre los encargos que nunca recibieron desenlace — el evento que los cerraría puede no llegar nunca. `;
    const decide = `Decide qué hace con cada uno según el efecto declarado ("${activation.effect}"): reintentar el encargo o disparar la compensación. Si el diseño no lo dice, es designGap. `;
    const noTransaction =
      'SIN TRANSACCIÓN ABARCADORA: el scheduler lo despacha con dispatchWithoutTransaction, así que cada llamada al adaptador de repositorio abre y confirma la SUYA y la llamada al proveedor cae fuera de todas. ';
    const race =
      'CARRERA CON EL CAMINO FELIZ: mientras barres puede llegar el evento de desenlace. Si al mover el candidato lo encuentras ya fuera del estado de espera, ganó el otro camino: es la carrera resuelta, no un fallo — no lo registres como error ni lo reintentes. ';
    const republish =
      'Y si lo que haces es reencargar publicando un evento, no lo absorbe nada: cada réplica hace su propio raise y estampa un metadata.eventId distinto, así que para el consumidor son N hechos. ';
    if (claim) {
      return (
        head +
        `EL RECLAMO YA ESTÁ GENERADO: toma el lote con this.${decap(`${claim.entity}Repository`)}.${claim.method}(). Devuelve SOLO los candidatos que ESTA réplica se llevó —el barrido corre en todas a la vez— y ya trae dentro el umbral que declara el diseño, la cota del lote y la caducidad de la marca (config/parameters/<perfil>/reconciliation.yaml). NO escribas otro reclamo (ni un finder por estado, ni un lock, ni una marca propia en ${claim.entity}): un segundo mecanismo en paralelo al generado no reclama nada, solo reparte peor. ` +
        decide +
        noTransaction +
        reconciliationOrder(operation, activation, true) +
        'El reclamo no sustituye a la idempotencia saliente: lo que absorbe una llamada repetida al proveedor —tras una caducidad o un reintento— es solo esa. ' +
        republish +
        race +
        'Lo verifica infra/check-idempotency.sh, familia reconciliation'
      );
    }
    const key = `reconciliation.${activation.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
    return (
      head +
      (waiting.length > 0 ? `Los candidatos son ${waiting.join(', ')} que llevan demasiado tiempo ahí. ` : 'Los candidatos son las entidades que quedaron esperando el desenlace. ') +
      `build NO pudo generar el reclamo (su aviso dice por qué), así que lo escribes tú, en el adaptador del repositorio y no aquí. DESDE CUÁNDO: la marca temporal la declara el diseño en awaitingSince${activation.awaitingSince ? ` (${activation.awaitingSince})` : ''}; NO uses createdAt ni un updatedAt de auditoría. ` +
      `Los tres números —umbral (${key}.unanswered-after-seconds, del diseño), caducidad del reclamo y cota del lote— están en RECONCILIATION_SETTINGS[${JSON.stringify(activation.name)}] (infrastructure/persistence/reconciliation/reconciliation-settings.ts): léelos de ahí, no de una constante. ` +
      'CÓMO reclamar: con la MISMA tienda que build genera para los reclamos que sí puede (ReconciliationClaimStore.claim, una marca persistida que caduca), confirmada ANTES de llamar al proveedor; no con un lock, que solo aísla mientras dura su transacción. ' +
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
 * El ORDEN de un barrido de reconciliación, el de keel-spring: si reintenta la misma activación, proveedor
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
      `${first}; (2) transición al estado final y confirmar (save); (3) después, fuera de toda transacción, llamar a ${names}. ` +
      'Llamar antes y morir antes de confirmar dejaría deshecho el trabajo del proveedor y la entidad todavía en espera. Si una regla del diseño fija el orden, manda la regla. '
    );
  }
  return (
    `ORDEN: son DOS commits y no se confunden — ${first}; (2) llamar al proveedor, FUERA de toda transacción; (3) transición al estado final y confirmar (save). ` +
    'Si actúas y mueres antes de (3), la marca caduca y la pasada siguiente repite la llamada, que es lo que absorbe la idempotencia saliente. ' +
    'Al revés —confirmar el desenlace y luego actuar— si mueres en medio dejas la entidad resuelta y el trabajo vivo en el proveedor: un huérfano que no detecta nadie. Si una regla del diseño fija el orden, manda la regla. '
  );
}

/** La nota de una COMPENSACIÓN (incremento 11c), la de keel-spring. */
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

function activationNotes(operation) {
  const notes = [];
  const sweep = Boolean(operation.schedule);
  const reconciles = (operation.reconciles ?? []).length > 0;
  for (const { dependency, activation } of operation.dependencyActivations ?? []) notes.push(activationNote(dependency, activation, sweep));
  // El ORDEN de los efectos, el mismo que keel-spring. En un barrido de reconciliación el orden es otro y
  // lo dice su nota (incremento 11c), así que aquí no se da: dos órdenes opuestos en el mismo stub no son dos
  // consejos, son uno que el agente elegiría al azar.
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

/** La nota de una activación: el trabajo que esta operación delega en otro servidor (la de keel-spring). */
function activationNote(depId, activation, sweep) {
  if (activation.event) {
    return `Activación ${depId}.${activation.name}: ${activation.effect} — se delega publicando ${activation.event.name}, que emite el agregado con this.raise(${activation.event.className ?? '...'}.of(...)) dentro del método de negocio. El handler no publica nada, y no esperes respuesta: publicar un evento no devuelve resultado`;
  }
  if (!activation.http) {
    return `Activación ${depId}.${activation.name}: ${activation.effect} — el diseño no resuelve el canal (via.client/call no existe en http-clients). No inventes la llamada: dilo en el reporte`;
  }
  const awaits = {
    outcome: `awaits: outcome — el resultado que devuelve ${depId} condiciona el desenlace de esta operación: no basta con que la llamada no falle. Qué significa un desenlace negativo lo dice el diseño: si specs/decisions.yaml acepta OBL-OUTCOME-NEGATIVE-UNDECIDED, manda esa decisión (y puede que el cuerpo no importe).`,
    acknowledgement: `awaits: acknowledgement — basta con que ${depId} acuse recibo; no interpretes el cuerpo como parte del desenlace.`,
    nothing: sweep
      ? 'awaits: nothing — no se espera nada de vuelta, pero la llamada sigue siendo síncrona y su timeout bloquea la pasada del barrido.'
      : 'awaits: nothing — no se espera nada de vuelta, pero la llamada sigue siendo síncrona y ocurre DENTRO de la transacción que abrió el UseCaseMediator: su timeout la mantiene abierta.'
  }[activation.awaits];
  const onFailure = activation.onFailure;
  const failure = {
    ignore: `onFailure: ignore — que ${depId} no responda no interrumpe esta operación; el fallback del adaptador ya lo absorbe y lo registra. No lo reintentes aquí.`,
    fail: `onFailure: fail — si ${depId} no responde, esta operación falla con ${onFailure?.exceptionClass ?? onFailure?.error}; el fallback del adaptador ya la lanza. No la captures para convertirla en otra cosa.`,
    degrade: `onFailure: degrade — si ${depId} no responde, esta operación degrada y el resultado degradado lo escribes TÚ: ${onFailure?.degradedTo}`
  }[onFailure?.action];
  const port = activation.http.clientClass;
  return `Activación ${depId}.${activation.name}: ${activation.effect} — invoca this.${decap(port)}.${activation.http.call}(...) (con await). El retry y el circuito ya están en el adaptador: no los repitas. ${awaits ?? ''} ${failure ?? ''}`.trim();
}

function scheduleNotes(model, operation) {
  if (!operation.schedule) return [];
  const mode = scheduleDispatch(model, operation);
  const where = `${schedulerPath(model.services.find((service) => service.operations.includes(operation)))}`;
  const notes = [
    `Por reloj (cron ${operation.schedule.cron}): la dispara ${where} en TODAS las réplicas a la vez. Lo que ` +
      'actúa sobre lo que encuentra tiene que RECLAMARLO (marcar la fila y quedarse con las que esta réplica se llevó), no solo leerlo.'
  ];
  notes.push(
    mode.withoutTransaction
      ? 'SIN TRANSACCIÓN ABARCADORA: el scheduler la despacha con dispatchWithoutTransaction, así que cada llamada al adaptador de ' +
          'repositorio confirma la SUYA. El orden es el de los commits: reclamar y confirmar, actuar fuera de toda transacción, ' +
          'confirmar el desenlace. Un fallo en una fila no puede revertir las demás.'
      : 'Corre en UNA transacción, la del caso de uso: no llama a nadie en medio de su trabajo, así que todo o nada.'
  );
  const repository = (claim) => `${claim.entity}Repository`;
  for (const claim of operation.claim ?? []) {
    notes.push(
      claim.stalled
        ? `EL RESCATE YA ESTÁ GENERADO: this.${decap(repository(claim))}.${claim.method}() devuelve los ${claim.entity} que llevan atascados en ` +
            `${claim.stalled.state} más que su plazo y que ESTA réplica se llevó, SIGUIENDO en ${claim.stalled.state} con ${claim.stalled.stampField} ` +
            `renovado. La transición a ${claim.to} la haces TÚ con el método del agregado (fija los campos que ${claim.to} exige) y la guardas. ` +
            'No escribas otro rescate, ni un finder por estado, ni una cota propia.'
        : `EL RECLAMO YA ESTÁ GENERADO: toma el lote con this.${decap(repository(claim))}.${claim.method}(), que devuelve SOLO los ${claim.entity} ` +
            `que ESTA réplica se llevó, ya en ${claim.to}${claim.stamps ? ` y con ${claim.stamps.field} estampado` : ''}. El tamaño del lote no se pasa: ` +
            `lo acota el adaptador con sweep.${claim.sweepKey}.batch-size. No escribas otro reclamo (ni un finder por estado ni un lock): ` +
            'un segundo mecanismo en paralelo no reclama nada. Actúa sobre cada fila y guárdala: un fallo en una no revierte las demás.'
    );
  }
  return notes;
}

/** Notas de los filtros de TEXTO de una query que declaran `match` o `compare` (DSL 2.14). */
function textFilterNotes(model, operation) {
  if (operation.kind !== 'query') return [];
  const notes = [];
  for (const component of messageComponents(model, operation)) {
    const match = component.match ?? 'exact';
    const compare = component.compare ?? 'exact';
    if (match === 'exact' && compare === 'exact') continue;
    const how = match === 'exact' ? 'igualdad' : match === 'prefix' ? 'empieza por' : 'contiene';
    const cases = compare === 'exact' ? 'sensible a mayúsculas' : `ignorando ${compare === 'ignore-case-accents' ? 'mayúsculas y acentos' : 'mayúsculas'}`;
    notes.push(`Filtro ${component.name} (match: ${match}, compare: ${compare}): ${how}, ${cases}`);
  }
  return notes;
}

/** Parte una nota larga en líneas de comentario legibles. */
function wrap(text, width = 100) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
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

/** ¿La operación deduplica con el registro de claves? (no con la clave natural, y con persistencia) */
function usesRegistry(model, operation) {
  return usesRequestIdempotency(model) && Boolean(operation.idempotency && operation.idempotency.guard !== 'natural-key');
}

/**
 * Las notas de la idempotencia de petición: el algoritmo que el agente escribe con las piezas que build
 * ya generó. Las mismas reglas que keel-spring (services.js), con los nombres de este proyecto: sin
 * ellas el camino de menor resistencia es escribir otro registro, o guardar la clave AL FINAL, que deja
 * a la perdedora de una carrera con el code de la primera restricción de negocio que encuentre.
 */
function idempotencyNotes(model, operation) {
  const idempotency = operation.idempotency;
  if (!idempotency) return [];
  if (idempotency.guard === 'natural-key') {
    return [
      `Idempotencia: keySource=payload-field, keyField=${idempotency.keyField}. La guarda es la CLAVE NATURAL ` +
        `(${(idempotency.naturalKey ?? []).join(', ')}) del agregado, no un registro: build NO genera IdempotencyStore para ` +
        'esta operación y no debes escribir otro. Busca por la clave natural ANTES de insertar; si ya existe, devuelve ese mismo ' +
        'recurso sin re-ejecutar nada — una repetición devuelve la respuesta original, NO un error. La carrera la arbitra la ' +
        'constraint: no captures su violación para «arreglarla».'
    ];
  }
  if (!usesRequestIdempotency(model)) return [];
  const ttl = idempotency.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  const reuse = `${FRAMEWORK_ERRORS.idempotencyReuse.http} ${effectiveErrorCode(model, FRAMEWORK_ERRORS.idempotencyReuse)}`;
  const race = `${FRAMEWORK_ERRORS.idempotencyRace.http} ${effectiveErrorCode(model, FRAMEWORK_ERRORS.idempotencyRace)}`;
  const source =
    idempotency.keySource === 'payload-hash'
      ? 'La clave es CommandSignature.of(command), que también es la firma: NO hay cabecera ni IdempotencyContext, y por tanto tampoco caso «sin clave» — siempre se deduplica.'
      : idempotency.keySource === 'payload-field'
        ? `La clave es el campo ${idempotency.keyField} del comando; la firma, CommandSignature.of(command). No hay cabecera.`
        : 'La clave es IdempotencyContext.get() (application/support): null = el cliente no mandó la cabecera, y entonces se ejecuta SIN deduplicar (no se rechaza). La firma es CommandSignature.of(command).';
  return [
    `Idempotencia: keySource=${idempotency.keySource}, ttlSeconds=${ttl}. El puerto IdempotencyStore (inyectado), su adaptador, ` +
      'la tabla idempotency_record y CommandSignature ya están generados: NO escribas otro registro, otra tabla ni otra firma, y ' +
      'no toques el mediator ni el controlador para esto. ' +
      source,
    'Algoritmo, dentro de la transacción del comando (ya abierta por el mediator): scope = command.idempotencyScope() (build lo ' +
      'compone desde el diseño); previa = await this.idempotencyStore.find(scope, clave). Si hay previa con la MISMA firma, ' +
      'reconstruye la respuesta desde previa.resourceId sin re-ejecutar nada (ni escrituras ni eventos). Si la firma difiere, ' +
      `lanza IdempotencyReuseException (${reuse}). Si no hay previa, RECLAMA PRIMERO: decide el id del recurso (Uuids.v7()), ` +
      `await this.idempotencyStore.save(scope, clave, firma, id, ${ttl}) y SOLO DESPUÉS ejecuta el negocio con ese id.`,
    'La CARRERA (dos peticiones con la misma clave a la vez) no la ve find: la arbitra la clave primaria del registro, y el ' +
      `adaptador la traduce a IdempotencyConflictException (${race}). NO la captures. Y por eso el orden de arriba: con save ` +
      'al final, la perdedora choca antes contra la primera restricción de negocio y sale su code, no el de la clave en curso.'
  ];
}
