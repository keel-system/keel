// Frontera declarada del generador: qué del DSL sabe mapear keel-go.
//
// El DSL es más ancho que cualquier generador, y keel-go se construye por incrementos (PLAN-KEEL-GO.md):
// su frontera AVANZA EN CÓDIGO. Cada capa que todavía no genera se rechaza aquí con el incremento que la
// trae, y cada incremento borra su entrada. Lo que no vale es recibir una construcción que no se sabe
// mapear y producir un proyecto como si nada: el diseñador creería que se generó y nadie se lo desmentiría.
//
// Dos niveles, como en los otros tres generadores:
//   · `errors` impiden generar — la capa entera falta;
//   · `warnings` dejan seguir — la capa se acepta pero lo que el diseño declara en ella todavía no se
//     emite, y el aviso dice cuándo llega.

import { buildModel } from '@keel-system/keel-core/gen/model';
import { resolveStack } from '@keel-system/keel-core/gen/stack';
import { persistedMembers } from '@keel-system/keel-core/gen';
import { messagingWithoutPersistenceErrors } from '@keel-system/keel-core/gen/messaging-frontier';
import { GO_PROJECTION } from './go-projection.js';
import { messageComponents } from '../scaffold/services.js';

/** Capas que aún no se generan, con el incremento del plan que las trae. */
const PENDING_LAYERS = {
  'http-clients': 'incremento 11',
  dependencies: 'incremento 11',
  storage: 'incremento 13',
  mail: 'incremento 13',
  payments: 'incremento 13'
};

/**
 * Los motores sobre los que keel-go genera la persistencia: PostgreSQL y MySQL (tramo 6d). MongoDB llega en el incremento 12;
 * MariaDB, SQL Server y Oracle se quedan fuera hasta que una red los mida, como en keel-nest y keel-dotnet.
 */
export const SUPPORTED_DATABASES = ['postgresql', 'mysql'];

/** Los brokers sobre los que keel-go genera la mensajería: RabbitMQ (tramo 9b-2), Kafka (9f) y SNS/SQS (9g). */
export const SUPPORTED_BROKERS = ['rabbitmq', 'kafka', 'snssqs'];
const PENDING_BROKERS = {};

/** ¿Declara el diseño persistencia DOCUMENTAL? Llega en el incremento 12. */
function documentPersistence(layers) {
  return layers?.persistence?.default?.model === 'document';
}

/**
 * Las capas que keel-go todavía rechaza en ESTE diseño: las pruebas de paridad lo comparan sin ellas. La persistencia
 * solo cuando es documental: la relacional se genera desde el incremento 6.
 */
export function pendingLayers(layers = null) {
  return [...Object.keys(PENDING_LAYERS), ...(documentPersistence(layers) ? ['persistence'] : [])];
}

/**
 * Lo que una operación puede declarar y keel-go todavía no genera: el mensaje y el handler salen, pero no el
 * mecanismo. Se avisa por operación, nombrándolas, como keel-dotnet en su incremento 4.
 */
const PENDING_OPERATION_FEATURES = [
  { key: 'idempotency', what: 'idempotency (el almacén, la firma del comando y el gate check-idempotency.sh)', increment: 'incremento 10' },
  { key: 'cache', what: 'cache (la caché de la consulta)', increment: 'incremento 13' }
];

/**
 * Comprueba el diseño contra la frontera de keel-go. Devuelve { errors, warnings } de strings ya redactados
 * para consola.
 */
export function checkSupportedFeatures(manifest, layers) {
  const errors = [];
  const warnings = [];
  const declared = Object.keys(manifest?.layers ?? {});

  for (const layer of declared) {
    if (PENDING_LAYERS[layer]) {
      errors.push(
        `capa ${layer}: keel-go todavía no la genera (llega en el ${PENDING_LAYERS[layer]} de PLAN-KEEL-GO.md). ` +
          'Genera este diseño con keel-spring, keel-nest o keel-dotnet, o espera a que keel-go la cubra.'
      );
    }
  }
  if (declared.includes('security')) errors.push(...securityErrors(layers));
  if (declared.includes('messaging')) errors.push(...messagingErrors(manifest, layers));
  if (declared.includes('persistence') && documentPersistence(layers)) {
    errors.push(
      'capa persistence: keel-go todavía no genera la persistencia documental (llega en el incremento 12 de PLAN-KEEL-GO.md). ' +
        'Genera este diseño con keel-spring, keel-nest o keel-dotnet, o espera a que keel-go la cubra.'
    );
  } else if (declared.includes('persistence')) {
    errors.push(...unmeasuredShapes(manifest, layers));
  }
  errors.push(...scheduledWithArguments(manifest, layers));
  errors.push(...parameterErrors(manifest, layers));
  const operations = Object.entries(layers?.['use-cases']?.operations ?? {});
  for (const feature of PENDING_OPERATION_FEATURES) {
    const names = operations
      .filter(([, operation]) => operation?.[feature.key] != null && (feature.applies?.(operation) ?? true))
      .map(([name]) => name);
    if (names.length === 0) continue;
    // La idempotencia de petición se adelantó al incremento 7 sobre la persistencia relacional (el registro, la firma y
    // la cabecera), su purga llegó con el reloj (10b) y el gate check-idempotency.sh con el 10d: ya no queda nada.
    if (feature.key === 'idempotency' && declared.includes('persistence') && !documentPersistence(layers)) continue;
    warnings.push(
      `use-cases: ${names.join(', ')} declara${names.length === 1 ? '' : 'n'} ${feature.what}; keel-go genera el mensaje y el handler, ` +
        `pero no el mecanismo (llega en el ${feature.increment} de PLAN-KEEL-GO.md).`
    );
  }
  return { errors, warnings };
}

/**
 * Las formas del dominio que el adaptador relacional no persiste, con su motivo: ninguna fixture con persistencia las
 * declara, así que su mapeo no lo mediría ninguna red (keel-dotnet las deja como TODO del agente; aquí no compilaría).
 * Son la relación interna a-uno SIN vuelta (la FK la pondría la dueña sobre la hija), la many-to-many dentro del
 * agregado y el value object persistido con otro value object dentro o con un campo opcional. Se leen del MODELO, que
 * es quien sabe qué relación es interna.
 */
function unmeasuredShapes(manifest, layers) {
  let model;
  try {
    model = buildModel({ manifest, layers, stack: resolveStack(null, layers), projection: GO_PROJECTION });
  } catch {
    // Un diseño que no da modelo lo rechazan las otras puertas, con su mensaje.
    return [];
  }
  const why = 'ninguna fixture con persistencia la declara: sin red que mida su mapeo';
  const errors = [];
  for (const entity of model.entities.filter((candidate) => candidate.persisted)) {
    for (const member of persistedMembers(model, entity)) {
      if (member.kind === 'relationOne' && !member.relation.backReference) {
        errors.push(`persistence: ${entity.name}.${member.name} es una relación interna a-uno sin vuelta; keel-go no la persiste (${why}).`);
      } else if (member.kind === 'relationMany' && member.relation.cardinality === 'many-to-many') {
        errors.push(`persistence: ${entity.name}.${member.name} es una many-to-many dentro del agregado; keel-go no la persiste (${why}).`);
      } else if (member.kind === 'vo' || (member.kind === 'elementCollection' && member.element.kind === 'vo')) {
        const vo = model.valueObjects.find((candidate) => candidate.name === member.field.namedType);
        for (const sub of vo?.fields ?? []) {
          if (sub.kind === 'composite' || !sub.required) {
            errors.push(`persistence: ${entity.name}.${member.name} guarda ${vo.name}, que lleva ${sub.kind === 'composite' ? 'otro value object' : 'un campo opcional'} (${sub.name}); keel-go no lo aplana (${why}).`);
          }
        }
      }
    }
  }
  return errors;
}

/**
 * Los parámetros de despliegue (DSL 2.15) que keel-go todavía no genera. Los lee el dominio validados y los cablea el
 * arranque, pero solo hasta el adaptador que los usa: el rescate de un barrido (`stalledAfter`, DSL 2.18). Un handler no
 * los recibe —los argumentos de su constructor los fija build—, así que un parámetro que solo lee una regla saldría sin
 * nadie que lo leyera; lo declaran catalog-extended y payment-checkout, que keel-go aún rechaza por otras capas, y entra
 * con ellas. Y un tipo que keel-go no sabe leer (decimal, boolean): ninguna fixture que genere lo declara.
 */
function parameterErrors(manifest, layers) {
  const declared = Object.entries(manifest?.parameters ?? {});
  if (declared.length === 0) return [];
  const linked = new Set(
    Object.values(layers?.['use-cases']?.operations ?? {}).flatMap((operation) => (operation?.transitions ?? []).map((transition) => transition?.stalledAfter?.parameter).filter(Boolean))
  );
  const why = 'ninguna fixture que keel-go genere lo declara: sin red que mida lo emitido';
  const errors = [];
  for (const [name, spec] of declared) {
    if (!['int', 'long', 'string'].includes(spec?.type)) {
      errors.push(`service.parameters.${name}: ${spec?.type} — keel-go solo lee parámetros int, long o string (${why}). Genera este diseño con keel-spring, keel-nest o keel-dotnet.`);
    } else if (!linked.has(name)) {
      errors.push(
        `service.parameters.${name}: keel-go solo cablea un parámetro hasta el rescate de un barrido que lee su plazo de él (stalledAfter); ` +
          `todavía no se lo da a un handler (${why}; llega con catalog-extended y payment-checkout, incremento 13). Genera este diseño con keel-spring, keel-nest o keel-dotnet.`
      );
    }
  }
  return errors;
}

/**
 * Una operación por reloj cuyo mensaje lleva campos: la tarea la despacha sin argumentos, y no hay de dónde sacarlos. En
 * keel-dotnet sale un TODO en el scheduler; en Go la tarea es código generado, sin TODO posible. Ninguna fixture la declara.
 */
function scheduledWithArguments(manifest, layers) {
  const operations = Object.entries(layers?.['use-cases']?.operations ?? {}).filter(([, operation]) => operation?.schedule);
  if (operations.length === 0) return [];
  let model;
  try {
    model = buildModel({ manifest, layers, stack: resolveStack(null, layers), projection: GO_PROJECTION });
  } catch {
    return [];
  }
  return model.services
    .flatMap((service) => service.operations)
    .filter((operation) => operation.schedule && messageComponents(operation, model).length > 0)
    .map(
      (operation) =>
        `use-cases: ${operation.name} declara schedule y su mensaje lleva campos (${messageComponents(operation, model).map((c) => c.name).join(', ')}); ` +
        'el reloj la despacha sin argumentos y keel-go no tiene de dónde sacarlos (ninguna fixture lo declara: sin red que lo mida).'
    );
}

/**
 * Lo que keel-go todavía no genera de la capa messaging. La mensajería sin persistencia la rechazan los cuatro generadores
 * con el mismo motivo (keel-core/gen/messaging-frontier.js); la documental cae con la persistencia documental. Sin la
 * capa api entra (metering-digest, tramo 10c): el arranque cablea la persistencia, el puente, los listeners y el reloj
 * sin la entrada HTTP, que solo sirve las sondas.
 */
function messagingErrors(manifest, layers) {
  return messagingWithoutPersistenceErrors(manifest, layers, 'keel-go');
}

/** Lo que el stack pide y keel-go no genera (un motor sin medir, la telemetría): se rechaza en el build en vez de estamparlo sin efecto. */
export function checkSupportedStack(stack) {
  const errors = [];
  // El motor solo importa con persistencia: sin ella, el cuestionario no lo pregunta y no se estampa.
  if (stack?.database && !SUPPORTED_DATABASES.includes(stack.database)) {
    errors.push(
      `database: ${stack.database} — keel-go genera la persistencia sobre ${SUPPORTED_DATABASES.join(', ')} (MongoDB llega en el ` +
        'incremento 12 de PLAN-KEEL-GO.md; MariaDB, SQL Server y Oracle, sin medir en ninguna red). Elige uno de ellos, o genera este diseño con keel-spring, keel-nest o keel-dotnet.'
    );
  }
  if (stack?.broker && !SUPPORTED_BROKERS.includes(stack.broker)) {
    errors.push(
      `broker: ${stack.broker} — keel-go genera la mensajería sobre ${SUPPORTED_BROKERS.join(', ')}` +
        `${PENDING_BROKERS[stack.broker] ? ` (${stack.broker} llega en el ${PENDING_BROKERS[stack.broker]} de PLAN-KEEL-GO.md)` : ''}. ` +
        'Elige otro, o genera este diseño con keel-spring, keel-nest o keel-dotnet.'
    );
  }
  if (stack?.telemetry && stack.telemetry !== 'none') {
    errors.push(
      `telemetry: ${stack.telemetry} — keel-go todavía no genera telemetría (llega en el incremento 14 de PLAN-KEEL-GO.md). ` +
        'Genera sin ella (--telemetry none).'
    );
  }
  return { errors };
}

/**
 * Lo que keel-go todavía no genera de la capa security (incremento 8). Las tres cosas las declara, como mucho, una
 * fixture que keel-go aún rechaza por otras capas, así que ninguna red mediría lo emitido; entran con ella:
 *   · la clave de API (`protocol: api-key` o `serviceAuth.protocol: api-key`): ninguna fixture la declara;
 *   · el alcance por recurso (`scoping`): asset-vault, que trae mensajería, clientes salientes y storage;
 *   · la identidad resuelta contra las credenciales de un recurso (`callerIdentity.from.resolvedBy`):
 *     notification-mailer, que trae mensajería y correo.
 * Y un campo de identidad que no es texto: el valor sale de un claim, que es texto, y los otros tres servidores lo
 * pasan tal cual; en Go el mensaje es tipado y no compilaría.
 */
function securityErrors(layers) {
  const authentication = layers?.security?.authentication ?? {};
  const errors = [];
  const why = 'ninguna fixture que keel-go genere lo declara: sin red que mida lo emitido';
  const elsewhere = 'Genera este diseño con keel-spring, keel-nest o keel-dotnet.';
  if (authentication.protocol === 'api-key' || authentication.serviceAuth?.protocol === 'api-key') {
    errors.push(`security: la clave de API (protocol: api-key) — keel-go todavía no la genera (${why}). ${elsewhere}`);
  }
  if (authentication.scoping) {
    errors.push(`security: el alcance por recurso (authentication.scoping) — keel-go todavía no lo genera (${why}; llega con asset-vault). ${elsewhere}`);
  }
  const identity = authentication.callerIdentity;
  if (identity?.from?.resolvedBy) {
    errors.push(
      'security: la identidad del llamante resuelta contra las credenciales de un recurso (callerIdentity.from.resolvedBy) — ' +
        `keel-go todavía no la genera (${why}; llega con el correo, incremento 13). ${elsewhere}`
    );
  }
  if (identity) {
    for (const [name, operation] of Object.entries(layers?.['use-cases']?.operations ?? {})) {
      const type = operation?.input?.fields?.[identity.field]?.type;
      if (type != null && !['string', 'text'].includes(type)) {
        errors.push(
          `use-cases.${name}.input.${identity.field}: ${type} — la identidad del llamante sale de la credencial como TEXTO, igual que en keel-spring, ` +
            'keel-nest y keel-dotnet; keel-go solo la estampa en un campo string o text. Declara el campo como string.'
        );
      }
    }
  }
  return errors;
}

