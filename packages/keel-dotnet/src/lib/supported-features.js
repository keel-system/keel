// Frontera declarada del generador: qué del DSL sabe mapear keel-dotnet.
//
// El DSL es más ancho que cualquier generador, y keel-dotnet se construye por incrementos
// (PLAN-KEEL-DOTNET.md): su frontera AVANZA EN CÓDIGO. Cada capa que todavía no genera se rechaza aquí
// con el incremento que la trae, y cada incremento borra su entrada. Lo que no vale es recibir una
// construcción que no se sabe mapear y producir un proyecto como si nada: el diseñador creería que se
// generó y nadie se lo desmentiría.
//
// Dos niveles, como en keel-spring y keel-nest:
//   · `errors` impiden generar — la capa entera falta;
//   · `warnings` dejan seguir — la capa se acepta pero lo que el diseño declara en ella todavía no se
//     emite, y el aviso dice cuándo llega.

import { compositeUrlParamErrors } from 'keel-core/gen/outbound-params';

/** Capas que aún no se generan, con el incremento del plan que las trae. */
const PENDING_LAYERS = {};

/**
 * Los motores que keel-dotnet genera: PostgreSQL (incremento 6) y MongoDB (incremento 12). MySQL espera a que
 * `db-check` lo mida (con EF Core el uuid binario y el proveedor van por detrás: PLAN-KEEL-DOTNET.md § 5); los demás,
 * como en keel-nest.
 */
export const SUPPORTED_DATABASES = ['postgresql', 'mongodb'];

/** Los brokers que keel-dotnet genera: RabbitMQ (incremento 9), Kafka (9f) y SNS/SQS (9g), los tres de keel-nest. */
export const SUPPORTED_BROKERS = ['rabbitmq', 'kafka', 'snssqs'];

/** Capas aceptadas cuyo código todavía no se emite: el proyecto arranca, pero sin ellas. */
const ACCEPTED_NOT_EMITTED = {};

/**
 * Comprueba el diseño contra la frontera de keel-dotnet. Devuelve { errors, warnings } de strings ya
 * redactados para consola.
 */
export function checkSupportedFeatures(manifest, layers) {
  const errors = [];
  const warnings = [];
  const declared = Object.keys(manifest?.layers ?? {});

  for (const layer of declared) {
    if (PENDING_LAYERS[layer]) {
      errors.push(
        `capa ${layer}: keel-dotnet todavía no la genera (llega en el ${PENDING_LAYERS[layer]} de PLAN-KEEL-DOTNET.md). ` +
          'Genera este diseño con keel-spring o keel-nest, o espera a que keel-dotnet la cubra.'
      );
    }
  }
  for (const layer of declared) {
    if (ACCEPTED_NOT_EMITTED[layer] && layers?.[layer]) {
      warnings.push(
        `capa ${layer}: se acepta, pero keel-dotnet aún no emite su código (llega en el ${ACCEPTED_NOT_EMITTED[layer]}): ` +
          'el proyecto generado arranca y responde a sus sondas, sin nada de esta capa.'
      );
    }
  }
  // La persistencia DOCUMENTAL (incremento 12) se genera entera desde el 12c: documentos, índices, transacción y bloqueo
  // optimista (12b), y los almacenes del generador sobre colecciones —el outbox y los mensajes procesados, el registro de
  // idempotencia, los reclamos de barrido y de reconciliación, las purgas— (12c), con su arnés de flujos (12d): no queda
  // nada propio del modelo que rechazar ni que avisar. El mismo reparto que keel-nest.
  errors.push(...callerIdentityErrors(layers));
  errors.push(...messagingErrors(declared, layers));
  errors.push(...outboundErrors(layers));
  // Lo que una operación declara se genera entero: la idempotencia de petición desde el 7e, el reloj y los reclamos desde
  // el 10 y la caché desde el 13f. La idempotencia sin persistencia no es un pendiente: el registro de claves tiene que
  // confirmarse en la misma transacción que el efecto, así que no hay mecanismo posible, y se dice (como keel-nest).
  if (!layers?.persistence) {
    const operations = Object.entries(layers?.['use-cases']?.operations ?? {});
    const idempotent = operations.filter(([, operation]) => operation?.idempotency != null).map(([name]) => name);
    if (idempotent.length > 0) {
      warnings.push(
        `use-cases: ${idempotent.join(', ')} declara${idempotent.length === 1 ? '' : 'n'} idempotency, pero el diseño no tiene persistencia: ` +
          'el registro de claves tiene que confirmarse en la misma transacción que el efecto, así que no se genera ningún mecanismo.'
      );
    }
  }
  return { errors, warnings };
}

/** La telemetría todavía no se genera: se rechaza en el build en vez de estamparla sin efecto. */
export function checkSupportedStack(stack) {
  const errors = [];
  // El motor solo importa con persistencia: sin ella, el cuestionario no lo pregunta y no se estampa.
  if (stack?.database && !SUPPORTED_DATABASES.includes(stack.database)) {
    errors.push(
      `database: ${stack.database} — keel-dotnet genera la persistencia sobre ${SUPPORTED_DATABASES.join(', ')} (incrementos 6 y 12 de PLAN-KEEL-DOTNET.md): ` +
        'ninguna red de keel-dotnet ha medido otro motor todavía. Elige uno de ellos, o genera este diseño con keel-spring o keel-nest.'
    );
  }
  if (stack?.broker && !SUPPORTED_BROKERS.includes(stack.broker)) {
    errors.push(
      `broker: ${stack.broker} — keel-dotnet genera la mensajería sobre ${SUPPORTED_BROKERS.join(', ')} (incremento 9 de PLAN-KEEL-DOTNET.md). ` +
        'Elige uno de ellos, o genera este diseño con keel-spring o keel-nest.'
    );
  }
  if (stack?.telemetry && !['none', 'otel'].includes(stack.telemetry)) {
    errors.push(`telemetry: ${stack.telemetry} — keel-dotnet genera la telemetría con OpenTelemetry (otel) o sin ella (none).`);
  }
  return { errors };
}

/**
 * Lo que keel-dotnet todavía no sabe hacer con la identidad del llamante (security.authentication.callerIdentity). La
 * credencial resuelta contra las de un recurso (`from.resolvedBy`) se genera desde el 12e (el finder de credenciales y
 * CallerIdentityResolver, como en keel-nest); queda:
 *   · un campo de identidad que no sea texto: el valor sale de un claim, que es texto, y los servidores de keel-spring y
 *     keel-nest lo pasan tal cual. En C# el mensaje es tipado: un value type o un uuid no compilaría.
 */
function callerIdentityErrors(layers) {
  const identity = layers?.security?.authentication?.callerIdentity;
  if (!identity) return [];
  const errors = [];
  const typed = Object.entries(layers?.['use-cases']?.operations ?? {})
    .map(([name, operation]) => [name, operation?.input?.fields?.[identity.field]?.type])
    .filter(([, type]) => type != null && !['string', 'text'].includes(type));
  for (const [name, type] of typed) {
    errors.push(
      `use-cases.${name}.input.${identity.field}: ${type} — la identidad del llamante sale de la credencial como TEXTO, igual que en keel-spring y keel-nest; ` +
        'keel-dotnet solo la estampa en un campo string o text. Declara el campo como string.'
    );
  }
  return errors;
}

/**
 * Lo que keel-dotnet todavía no sabe hacer con la mensajería: sin persistencia, porque el puente sale del adaptador de
 * repositorio y el registro de procesados vive en la base (en keel-nest se cerró en su incremento 16). La identidad del
 * emisor resuelta contra las credenciales de un recurso (`identity.resolvedBy`) se genera desde el 12e: el finder.
 */
function messagingErrors(declared, layers) {
  if (!declared.includes('messaging')) return [];
  const errors = [];
  if (!layers?.persistence) {
    errors.push(
      'capa messaging sin persistence — keel-dotnet genera la mensajería sobre la persistencia, relacional o documental (incrementos 9 y 12c de PLAN-KEEL-DOTNET.md): ' +
        'el puente de eventos sale del adaptador de repositorio y el registro de mensajes procesados vive en la base. Genera este diseño con keel-spring o keel-nest.'
    );
  }
  return errors;
}

/** ¿Es `field` un value object compuesto del dominio (o una lista de ellos)? */
function isComposite(layers, field) {
  const types = layers?.domain?.types ?? {};
  const type = field?.type ?? field?.items?.type;
  return Boolean(type && types[type] && (types[type].fields || types[type].kind === 'composite'));
}

/**
 * Lo que keel-dotnet todavía no sabe hacer con los clientes salientes y las dependencias: los clientes, las activaciones,
 * los needs y OAuth2 se generan (incrementos 11 y 13 de PLAN-KEEL-DOTNET.md); esto, no.
 *   · un value object compuesto en una llamada: en la URL no tiene forma (el rechazo neutral, el mismo que en keel-spring y
 *     keel-nest); en el cuerpo o en la respuesta sí, pero ninguna red de keel-dotnet lo ha medido todavía.
 */
function outboundErrors(layers) {
  const errors = [...compositeUrlParamErrors(layers, 'keel-dotnet')];
  // Los `needs` se generan enteros: bajo demanda desde el 13i (el cliente en el handler del usedBy y onUnavailable en el
  // fallback), el último valor conocido y la réplica (proyector, lector y su transacción propia) desde el 13j.
  for (const [client, definition] of Object.entries(layers?.['http-clients']?.clients ?? {})) {
    // `auth: oauth2-client-credentials` se genera desde el 13j (ClientCredentials, con la semántica de Spring Security).
    for (const [call, spec] of Object.entries(definition?.calls ?? {})) {
      const fields = [...Object.entries(spec?.request?.body ?? {}), ...Object.entries(spec?.response?.fields ?? {})]
        .filter(([, field]) => isComposite(layers, field))
        .map(([name]) => name);
      if (fields.length > 0) {
        errors.push(
          `http-clients.${client}.calls.${call}: ${fields.join(', ')} es un value object compuesto en el cuerpo o en la respuesta — keel-dotnet ` +
            'todavía no lo genera (ninguna de sus redes lo ha medido; llega en el incremento 16 de PLAN-KEEL-DOTNET.md, como en keel-nest). Genera este diseño con keel-spring o keel-nest.'
        );
      }
    }
  }
  return errors;
}
