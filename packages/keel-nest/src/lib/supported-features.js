// Frontera declarada del generador: qué del DSL sabe mapear keel-nest.
//
// El DSL es más ancho que cualquier generador, y keel-nest se construye por incrementos
// (PLAN-KEEL-NEST.md): su frontera AVANZA EN CÓDIGO. Cada capa que todavía no genera se rechaza
// aquí con el incremento que la trae, y cada incremento borra su entrada. Lo que no vale es
// recibir una construcción que no se sabe mapear y producir un proyecto como si nada: el
// diseñador creería que se generó y nadie se lo desmentiría.
//
// Hay dos niveles, como en keel-spring:
//   · `errors` impiden generar — la capa entera falta;
//   · `warnings` dejan seguir — la capa se acepta pero lo que el diseño declara en ella todavía
//     no se emite, y el aviso dice cuándo llega.

/** Capas que aún no se generan, con el incremento del plan que las trae. */
const PENDING_LAYERS = {
  storage: 'incremento 13',
  mail: 'incremento 13',
  payments: 'incremento 13'
};

/** Capas aceptadas cuyo código todavía no se emite: el proyecto arranca, pero sin ellas. Hoy, ninguna. */
const ACCEPTED_NOT_EMITTED = {};

/**
 * Los motores relacionales que keel-nest genera (incremento 6): la matriz de TypeORM medida. Los
 * demás del catálogo los genera keel-spring y llegan aquí cuando se midan.
 */
export const SUPPORTED_DATABASES = ['postgresql', 'mysql'];

/** Los brokers que keel-nest genera: los tres del catálogo (incremento 9: RabbitMQ, Kafka en el 9f y SNS/SQS en el 9g). */
export const SUPPORTED_BROKERS = ['rabbitmq', 'kafka', 'snssqs'];

/**
 * Lo que una operación de `use-cases` puede declarar y keel-nest todavía no genera. El dominio y la
 * aplicación se emiten (incremento 4), pero estos mecanismos cuelgan de piezas que llegan después:
 * el mensaje y el handler existen, y el aviso dice qué les falta y cuándo llega. Sin él, un handler
 * sin almacén de idempotencia parecería un handler completo.
 */
const PENDING_OPERATION_FEATURES = [{ key: 'cache', what: 'cache (la caché de la consulta)', increment: 'incremento 13' }];

/**
 * Comprueba el diseño contra la frontera de keel-nest. Devuelve { errors, warnings } de strings
 * ya redactados para consola.
 */
export function checkSupportedFeatures(manifest, layers) {
  const errors = [];
  const warnings = [];
  const declared = Object.keys(manifest?.layers ?? {});

  for (const layer of declared) {
    if (PENDING_LAYERS[layer]) {
      errors.push(
        `capa ${layer}: keel-nest todavía no la genera (llega en el ${PENDING_LAYERS[layer]} de PLAN-KEEL-NEST.md). ` +
          'Genera este diseño con keel-spring, o espera a que keel-nest la cubra.'
      );
    }
  }
  for (const layer of declared) {
    if (ACCEPTED_NOT_EMITTED[layer] && layers?.[layer]) {
      warnings.push(
        `capa ${layer}: se acepta, pero keel-nest aún no emite su código (llega en el ${ACCEPTED_NOT_EMITTED[layer]}): ` +
          'el proyecto generado arranca y responde a sus sondas, sin nada de esta capa.'
      );
    }
  }
  // La persistencia DOCUMENTAL es otra rama entera (driver de MongoDB, índices en clase, reclamo con
  // findOneAndUpdate): llega en el incremento 12. La relacional se genera desde el 6.
  if (declared.includes('persistence') && layers?.persistence?.default?.model === 'document') {
    errors.push(
      'persistence.default.model: document — keel-nest todavía no genera la persistencia documental (llega en el incremento 12 de PLAN-KEEL-NEST.md). ' +
        'Genera este diseño con keel-spring, o espera a que keel-nest la cubra.'
    );
  }
  // La identidad del llamante con VARIAS credenciales por recurso (`from.resolvedBy`) necesita el finder
  // por elemento de una colección en el repositorio, que keel-nest aún no emite. Sin él, el valor del
  // token llegaría en crudo al campo que el diseño define como la clave natural: 403 en el camino feliz.
  if (layers?.security?.authentication?.callerIdentity?.from?.resolvedBy) {
    errors.push(
      `security.authentication.callerIdentity.from.resolvedBy: keel-nest todavía no genera la resolución de una credencial a su recurso ` +
        '(el finder por elemento de la colección). Genera este diseño con keel-spring, o declara la correspondencia 1:1.'
    );
  }
  // La mensajería (incremento 9) se genera sobre la persistencia RELACIONAL: el outbox y el registro de
  // mensajes procesados se confirman en la misma transacción que el efecto, y los listeners se cablean
  // con ella. Un servicio de solo mensajería no tendría dónde.
  if (declared.includes('messaging') && !declared.includes('persistence')) {
    errors.push(
      'messaging sin persistence: keel-nest genera la mensajería sobre la persistencia relacional (el outbox y el registro de mensajes procesados). ' +
        'Genera este diseño con keel-spring, o declara la persistencia.'
    );
  }
  // La identidad del emisor resuelta contra VARIAS credenciales (`identity.from.resolvedBy`) necesita el
  // finder por elemento de colección, que keel-nest aún no emite (como la de la puerta HTTP).
  for (const [name, subscription] of Object.entries(layers?.messaging?.subscriptions ?? {})) {
    if (subscription?.identity?.from?.resolvedBy || subscription?.identity?.resolvedBy) {
      errors.push(
        `messaging.subscriptions.${name}.identity: keel-nest todavía no genera la resolución de una credencial a su recurso ` +
          '(resolvedBy, el finder por elemento de la colección). Genera este diseño con keel-spring, o declara la correspondencia 1:1.'
      );
    }
  }
  for (const message of outboundFrontier(layers)) errors.push(message);
  for (const message of dependenciesPending(layers)) warnings.push(message);
  const operations = Object.entries(layers?.['use-cases']?.operations ?? {});
  // La idempotencia de petición se genera (el registro idempotency_record, como keel-spring) cuando hay
  // persistencia donde registrar la clave en la misma transacción que el efecto. Sin persistencia no hay
  // mecanismo posible, y se dice.
  if (!declared.includes('persistence')) {
    const idempotent = operations.filter(([, operation]) => operation?.idempotency != null).map(([name]) => name);
    if (idempotent.length > 0) {
      warnings.push(
        `use-cases: ${idempotent.join(', ')} declara${idempotent.length === 1 ? '' : 'n'} idempotency, pero el diseño no tiene persistencia: ` +
          'el registro de claves tiene que confirmarse en la misma transacción que el efecto, así que no se genera ningún mecanismo.'
      );
    }
  }
  for (const feature of PENDING_OPERATION_FEATURES) {
    const names = operations.filter(([, operation]) => operation?.[feature.key] != null).map(([name]) => name);
    if (names.length === 0) continue;
    warnings.push(
      `use-cases: ${names.join(', ')} declara${names.length === 1 ? '' : 'n'} ${feature.what}; keel-nest genera el mensaje y el handler, ` +
        `pero no el mecanismo (llega en el ${feature.increment} de PLAN-KEEL-NEST.md).`
    );
  }
  return { errors, warnings };
}

/**
 * Lo saliente que keel-nest todavía no genera (incremento 11b): se rechaza nombrando por qué.
 *
 *   · `needs` (el dato que se PIDE a otro servidor, con réplica o bajo demanda, y su `onUnavailable`):
 *     solo lo declaran asset-vault (persistencia documental, incremento 12) y catalog-extended (storage,
 *     incremento 13); se generará cuando haya una fixture en la frontera que lo mida;
 *   · un campo COMPUESTO (un value object) en la petición o la respuesta de una llamada: el adaptador
 *     lee y escribe escalares, enums y listas de ellos;
 *   · `auth: oauth2-client-credentials`: la concesión del token, por el mismo motivo que `needs`
 *     (solo catalog-extended la declara).
 */
function outboundFrontier(layers) {
  const errors = [];
  for (const [id, dependency] of Object.entries(layers?.dependencies?.dependencies ?? {})) {
    const needs = Object.keys(dependency?.needs ?? {});
    if (needs.length > 0) {
      errors.push(
        `dependencies.${id}.needs (${needs.join(', ')}): keel-nest todavía no genera el dato que se pide a otro servidor —réplica, ` +
          'onMiss, onUnavailable y lastKnown— (incremento 11 de PLAN-KEEL-NEST.md: llega cuando una fixture de la frontera lo mida). ' +
          'Genera este diseño con keel-spring.'
      );
    }
  }
  const types = layers?.domain?.types ?? {};
  const composite = (field) => {
    const type = field?.type ?? field?.items?.type;
    return Boolean(type && types[type] && (types[type].fields || types[type].kind === 'composite'));
  };
  for (const [id, client] of Object.entries(layers?.['http-clients']?.clients ?? {})) {
    if (client?.auth?.type === 'oauth2-client-credentials') {
      errors.push(
        `http-clients.${id}.auth: oauth2-client-credentials — keel-nest todavía no genera la concesión del token (incremento 11 de ` +
          'PLAN-KEEL-NEST.md: llega cuando una fixture de la frontera lo mida). Genera este diseño con keel-spring.'
      );
    }
    for (const [name, call] of Object.entries(client?.calls ?? {})) {
      const fields = [
        ...Object.entries(call?.request?.body ?? {}),
        ...Object.entries(call?.request?.queryParams ?? {}),
        ...Object.entries(call?.request?.headers ?? {}),
        ...Object.entries(call?.response?.fields ?? {})
      ];
      const nested = fields.filter(([, field]) => composite(field)).map(([field]) => field);
      if (nested.length > 0) {
        errors.push(
          `http-clients.${id}.calls.${name}: ${nested.join(', ')} es un value object compuesto — keel-nest todavía lee y escribe solo ` +
            'escalares, enums y listas de ellos en una llamada saliente. Genera este diseño con keel-spring.'
        );
      }
    }
  }
  return errors;
}

/**
 * Lo que `dependencies` declara y keel-nest acepta sin generar todavía su mecanismo (incremento 11c): el
 * barrido de reconciliación (`reconciledBy`, con la tabla `reconciliation_claim`) y las compensaciones.
 * Las operaciones y sus handlers existen; el aviso dice qué les falta.
 */
function dependenciesPending(layers) {
  const warnings = [];
  for (const [id, dependency] of Object.entries(layers?.dependencies?.dependencies ?? {})) {
    for (const [name, activation] of Object.entries(dependency?.activations ?? {})) {
      if (activation?.reconciledBy) {
        warnings.push(
          `dependencies.${id}.activations.${name}.reconciledBy: ${activation.reconciledBy} se genera como operación, pero sin el reclamo ` +
            'de reconciliación (reconciliation_claim) ni sus notas: llega en el incremento 11c de PLAN-KEEL-NEST.md.'
        );
      }
    }
    if ((dependency?.compensations ?? []).length > 0) {
      warnings.push(
        `dependencies.${id}.compensations: keel-nest todavía no genera las notas de la compensación en el handler que la ejecuta ` +
          '(llega en el incremento 11c de PLAN-KEEL-NEST.md).'
      );
    }
  }
  return warnings;
}

/** Lo que el stack pide y keel-nest todavía no genera: se rechaza en el build en vez de estamparlo sin efecto. */
export function checkSupportedStack(stack) {
  const errors = [];
  if (stack?.database && !SUPPORTED_DATABASES.includes(stack.database)) {
    errors.push(
      `database: ${stack.database} — keel-nest genera la persistencia relacional sobre ${SUPPORTED_DATABASES.join(' y ')} (incremento 6 de PLAN-KEEL-NEST.md). ` +
        'Elige uno de ellos, o genera este diseño con keel-spring.'
    );
  }
  // Los tres brokers del catálogo (incremento 9): uno nuevo se rechaza hasta que keel-nest lo genere, en vez de
  // generar un proyecto cuyo broker nadie conecta.
  if (stack?.broker && !SUPPORTED_BROKERS.includes(stack.broker)) {
    errors.push(
      `broker: ${stack.broker} — keel-nest genera la mensajería sobre ${SUPPORTED_BROKERS.join(', ')} (incremento 9 de PLAN-KEEL-NEST.md). ` +
        'Elige uno de ellos, o genera este diseño con keel-spring.'
    );
  }
  if (stack?.telemetry && stack.telemetry !== 'none') {
    errors.push(
      `telemetry: ${stack.telemetry} — keel-nest todavía no genera telemetría (llega en el incremento 14 de PLAN-KEEL-NEST.md). ` +
        'Genera sin ella (--telemetry none).'
    );
  }
  return { errors };
}
