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

import { compositeUrlParamErrors } from '@keel-system/keel-core/gen/outbound-params';
import { messagingWithoutPersistenceErrors } from '@keel-system/keel-core/gen/messaging-frontier';

/** Capas que aún no se generan, con el incremento del plan que las trae. Hoy, ninguna: storage llegó en el 13g. */
const PENDING_LAYERS = {};

/** Capas aceptadas cuyo código todavía no se emite: el proyecto arranca, pero sin ellas. Hoy, ninguna. */
const ACCEPTED_NOT_EMITTED = {};

/**
 * Los motores que keel-nest genera: los relacionales de la matriz de TypeORM medida (incremento 6) y
 * MongoDB (incremento 12).
 *
 * Los otros tres del catálogo (MariaDB, SQL Server, Oracle) se rechazan con su MOTIVO, que no es de keel-nest:
 * keel-spring los genera, pero ninguna red de este repo los ha arrancado nunca (su matriz los tiene `sin ejecutar`
 * o `degradado`: el baseline, la collation, los literales del arnés). Generarlos aquí sería emitir sin medir lo
 * mismo que allí está sin medir, y llamarlo paridad. Entran cuando una red arranque el motor, para los dos.
 */
export const SUPPORTED_DATABASES = ['postgresql', 'mysql', 'mongodb'];

/** Los motores del catálogo que keel-nest rechaza a propósito, y por qué. */
export const UNMEASURED_DATABASES = ['mariadb', 'sqlserver', 'oracle'];

/** Los brokers que keel-nest genera: los tres del catálogo (incremento 9: RabbitMQ, Kafka en el 9f y SNS/SQS en el 9g). */
export const SUPPORTED_BROKERS = ['rabbitmq', 'kafka', 'snssqs'];

/**
 * Lo que una operación de `use-cases` puede declarar y keel-nest todavía no genera. El dominio y la
 * aplicación se emiten (incremento 4), pero estos mecanismos cuelgan de piezas que llegan después:
 * el mensaje y el handler existen, y el aviso dice qué les falta y cuándo llega. Sin él, un handler
 * sin almacén de idempotencia parecería un handler completo. Hoy, ninguno: la caché (`cache`) se genera desde el
 * incremento 13f.
 */
const PENDING_OPERATION_FEATURES = [];

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
  // La persistencia (relacional y documental) se genera entera, también la auditoría de autoría por política o
  // declarada (incremento 13h). La mensajería, solo con persistencia: sin ella no se emitía ni
  // puente ni publisher ni el registro de la conexión, y el servicio no publicaba sin decirlo (lo midió el incremento 16 de
  // keel-dotnet). El rechazo neutral, el mismo en los tres.
  // Lo saliente se genera entero (11b-13j, y el value object compuesto en el cuerpo y en la respuesta desde el
  // 16); lo único que se rechaza es lo que tampoco genera keel-spring: un compuesto en la URL o en una cabecera.
  for (const message of compositeUrlParamErrors(layers, 'keel-nest')) errors.push(message);
  errors.push(...messagingWithoutPersistenceErrors(manifest, layers, 'keel-nest'));
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

/** Lo que el stack pide y keel-nest todavía no genera: se rechaza en el build en vez de estamparlo sin efecto. */
export function checkSupportedStack(stack) {
  const errors = [];
  if (stack?.database && !SUPPORTED_DATABASES.includes(stack.database)) {
    errors.push(
      `database: ${stack.database} — keel-nest genera la persistencia sobre ${SUPPORTED_DATABASES.join(', ')}, los motores que sus redes arrancan. ` +
        (UNMEASURED_DATABASES.includes(stack.database)
          ? `${stack.database} no lo ha arrancado ninguna red de este repo (en keel-spring está sin ejecutar): entra cuando se mida. `
          : '') +
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
  // La telemetría (incremento 14c): OpenTelemetry. Una opción que el catálogo añada se rechaza hasta que keel-nest
  // la genere, en vez de estamparse sin efecto.
  if (stack?.telemetry && !['none', 'otel'].includes(stack.telemetry)) {
    errors.push(`telemetry: ${stack.telemetry} — keel-nest genera la telemetría con OpenTelemetry (otel) o sin ella (none).`);
  }
  return { errors };
}
