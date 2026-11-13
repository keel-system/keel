// Frontera declarada del generador: qué del DSL sabe mapear keel-go.
//
// El DSL es más ancho que cualquier generador, y keel-go se construyó por incrementos (PLAN-KEEL-GO.md): su
// frontera avanzó en código, y cerrado el plan (incremento 16) solo rechaza lo que tiene MOTIVO escrito. Lo que
// no vale es recibir una construcción que no se sabe mapear y producir un proyecto como si nada: el diseñador
// creería que se generó y nadie se lo desmentiría.
//
// Dos niveles, como en los otros tres generadores:
//   · `errors` impiden generar — la capa entera falta;
//   · `warnings` dejan seguir — la capa se acepta pero lo que el diseño declara en ella todavía no se
//     emite, y el aviso dice cuándo llega.

import { buildModel } from '@keel-system/keel-core/gen/model';
import { resolveStack } from '@keel-system/keel-core/gen/stack';
import { persistedMembers } from '@keel-system/keel-core/gen';
import { messagingWithoutPersistenceErrors } from '@keel-system/keel-core/gen/messaging-frontier';
import { conditionalWritesFrontierErrors } from '@keel-system/keel-core/gen/conditional-writes';
import { optionalAuthFrontierErrors } from '@keel-system/keel-core/gen/read-scope';
import { declaredDeadlines, modelDeadlines } from '@keel-system/keel-core/gen/deadlines';
import { repositoryRoots } from '@keel-system/keel-core/gen/features';
import { compositeUrlParamErrors } from '@keel-system/keel-core/gen/outbound-params';
import { GO_PROJECTION } from './go-projection.js';
import { messageComponents } from '../scaffold/services.js';
import { usesDependencies } from '../scaffold/use-cases.js';

/** Capas que aún no se generan, con el incremento del plan que las trae. */
const PENDING_LAYERS = {};

/**
 * Los motores sobre los que keel-go genera la persistencia: PostgreSQL y MySQL (tramo 6d) y MongoDB (incremento 12);
 * MariaDB, SQL Server y Oracle se quedan fuera hasta que una red los mida, como en keel-nest y keel-dotnet.
 */
export const SUPPORTED_DATABASES = ['postgresql', 'mysql', 'mongodb'];

/** Los brokers sobre los que keel-go genera la mensajería: RabbitMQ (tramo 9b-2), Kafka (9f) y SNS/SQS (9g). */
export const SUPPORTED_BROKERS = ['rabbitmq', 'kafka', 'snssqs'];
const PENDING_BROKERS = {};

/** ¿Declara el diseño persistencia DOCUMENTAL? (incremento 12) */
function documentPersistence(layers) {
  return layers?.persistence?.default?.model === 'document';
}

/** Las capas que keel-go todavía rechaza en ESTE diseño: las pruebas de paridad lo comparan sin ellas. */
export function pendingLayers(layers = null) {
  return Object.keys(PENDING_LAYERS);
}

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
  if (declared.includes('persistence') && !documentPersistence(layers)) errors.push(...unmeasuredShapes(manifest, layers));
  errors.push(...authorshipErrors(layers));
  errors.push(...scheduledWithArguments(manifest, layers));
  errors.push(...scheduledWithoutPersistence(manifest, layers));
  errors.push(...parameterErrors(manifest, layers));
  errors.push(...outboundErrors(layers));
  errors.push(...cacheErrors(layers));
  // La escritura condicional (DSL 2.25) se genera entera; lo que ningún generador genera todavía, con el motivo neutral (T3).
  errors.push(...conditionalWritesFrontierErrors(layers, 'keel-go'));
  // La lectura acotada (DSL 2.27, reads) se genera entera (scaffold/read-scope.js); lo que no se puede generar por
  // construcción (T7, T8) lo rechaza planService con la frontera neutral, que necesita el modelo. level: optional también
  // (permitAll y optionalCallerIdentity), salvo sobre una identidad que no es un token: la frontera neutral.
  errors.push(...optionalAuthFrontierErrors(layers, 'keel-go'));
  // El historial de cambios consultable (DSL 2.29: audit.history y output: { history }) se genera entero
  // (scaffold/history.js); lo que depende del motor elegido lo rechaza planService (historyStackErrors).
  // El ciclo de vida del dato (DSL 2.28: personal, deletion: logical, restorableFor, retention) se genera entero
  // (scaffold/data-lifecycle.js, incremento 4 de PLAN-DSL-228-CICLO-DE-VIDA.md); lo que no sabe anonimizar lo rechaza
  // planService (lifecycleStackErrors), que necesita el modelo.
  // Los plazos de negocio (DSL 2.26) los genera el cronómetro (scaffold/timer.js). Lo que depende del motor elegido —solo
  // hay sentencias medidas para PostgreSQL, MySQL y MongoDB— y del status del rechazo tardío lo rechaza planService, que
  // sí conoce el stack; aquí, las formas que el handler generado del plazo no sabe despachar.
  errors.push(...deadlineErrors(manifest, layers));
  if (declared.includes('storage')) errors.push(...storageErrors(layers));
  // La idempotencia sin persistencia no es un pendiente: el registro de claves tiene que confirmarse en la misma transacción
  // que el efecto, así que no hay mecanismo posible, y se dice (como los otros tres).
  if (!declared.includes('persistence')) {
    const idempotent = Object.entries(layers?.['use-cases']?.operations ?? {}).filter(([, operation]) => operation?.idempotency != null).map(([name]) => name);
    if (idempotent.length > 0) {
      warnings.push(
        `use-cases: ${idempotent.join(', ')} declara${idempotent.length === 1 ? '' : 'n'} idempotency, pero el diseño no tiene persistencia: ` +
          'el registro de claves tiene que confirmarse en la misma transacción que el efecto, así que no se genera ningún mecanismo.'
      );
    }
  }
  return { errors, warnings };
}

/**
 * La autoría declarada (tramo 13g) la estampa el adaptador sobre un campo de texto obligatorio o generado: el dominio de Go
 * lo guarda como `string` y vacío es ausente. Declarada opcional o de otro tipo no tiene esa forma, y ninguna fixture la
 * declara: sin red que mida lo emitido.
 */
function authorshipErrors(layers) {
  if (layers?.persistence?.audit?.authorship !== 'declared') return [];
  const errors = [];
  for (const [name, entity] of Object.entries(layers?.domain?.entities ?? {})) {
    for (const member of ['createdBy', 'updatedBy']) {
      const field = entity?.fields?.[member];
      if (field && (!['string', 'text'].includes(field.type) || !(field.required || field.generated))) {
        errors.push(
          `domain.entities.${name}.fields.${member}: keel-go estampa la autoría declarada sobre un texto obligatorio o generado (ninguna fixture que genere lo declara de otra forma: ` +
            'sin red que mida lo emitido). Decláralo string con generated: true, o genera este diseño con keel-spring, keel-nest o keel-dotnet.'
        );
      }
    }
  }
  return errors;
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
    } else if (!linked.has(name) && !layers?.persistence) {
      // Los handlers los reciben en las Dependencies de los casos de uso, que solo existen con persistencia.
      errors.push(
        `service.parameters.${name}: keel-go entrega los parámetros a los handlers en las Dependencies de los casos de uso, que solo existen con persistencia ` +
          `(${why}). Genera este diseño con keel-spring, keel-nest o keel-dotnet.`
      );
    }
  }
  return errors;
}

/**
 * Una operación por reloj cuyo mensaje lleva campos: la tarea la despacha sin argumentos, y no hay de dónde sacarlos. En
 * keel-dotnet sale un TODO en el scheduler; en Go la tarea es código generado, sin TODO posible. Ninguna fixture la declara.
 */
/**
 * Los plazos de negocio (DSL 2.26) que el handler GENERADO del plazo (`<Entidad><Estado>Deadline`, con la cabecera de
 * código generado) no sabe despachar: keel-spring deja ahí un TODO del agente, y aquí un adaptador con cabecera no lo
 * admite. Son la entidad que no es una raíz con repositorio y uuid por id (el temporizador lleva el uuid de la entidad y
 * el handler la carga por su repositorio) y la operación `by` cuyo mensaje lleva algo más que el id. Ninguna fixture los
 * declara: sin red que mida lo emitido.
 */
function deadlineErrors(manifest, layers) {
  if (declaredDeadlines(layers).length === 0) return [];
  let model;
  try {
    model = buildModel({ manifest, layers, stack: resolveStack(null, layers), projection: GO_PROJECTION });
  } catch {
    return [];
  }
  const roots = new Set(repositoryRoots(model).map((root) => root.name));
  const errors = [];
  for (const { entity, deadline } of modelDeadlines(model)) {
    const where = `domain: ${entity.name}.lifecycle.deadlines.${deadline.stateName}`;
    if (!roots.has(entity.name) || entity.idField?.goType !== 'uuid.UUID') {
      errors.push(
        `${where} (plazo de negocio, DSL 2.26): keel-go lo arma y lo dispara sobre una raíz de agregado persistida con un uuid por id, y ${entity.name} no lo es ` +
          '(ninguna fixture lo declara: sin red que lo mida). Genera este diseño con keel-spring, keel-nest o keel-dotnet.'
      );
      continue;
    }
    const by = model.services.flatMap((service) => service.operations).find((operation) => operation.name === deadline.by);
    const components = by ? messageComponents(by, model).filter((component) => !component.entryGate) : [];
    if (by && (components.length !== 1 || components[0].goType !== 'uuid.UUID')) {
      errors.push(
        `${where} (plazo de negocio, DSL 2.26): el mensaje de ${by.name} lleva ${components.map((component) => component.name).join(', ')}, y el cronómetro solo tiene el id ` +
          'de la entidad para despacharla (keel-spring deja ahí un TODO del agente, y el handler del plazo es código generado). Deja en su entrada solo el id, ' +
          'o genera este diseño con keel-spring, keel-nest o keel-dotnet.'
      );
    }
  }
  return errors;
}

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
 * Una operación por reloj en un diseño sin persistencia relacional con raíces: el reloj de keel-go se cablea con los casos
 * de uso, que solo existen sobre las Dependencies (persistencia). Hasta el incremento 0b de PLAN-DSL-226-PLAZOS.md el
 * `schedule` se DESCARTABA en silencio: ni tarea ni nota en el handler, y el servicio salía sin su barrido. Los otros
 * tres lo emiten y corre en cada réplica sin nada que arbitre.
 */
function scheduledWithoutPersistence(manifest, layers) {
  const operations = Object.entries(layers?.['use-cases']?.operations ?? {}).filter(([, operation]) => operation?.schedule);
  if (operations.length === 0) return [];
  let model;
  try {
    model = buildModel({ manifest, layers, stack: resolveStack(null, layers), projection: GO_PROJECTION });
  } catch {
    return [];
  }
  if (usesDependencies(model)) return [];
  return operations.map(
    ([name]) =>
      `use-cases: ${name} declara schedule, y keel-go cablea el reloj con los casos de uso, que solo existen con persistencia: ` +
      'sin ella la operación se quedaría sin disparar. Genera este diseño con keel-spring, keel-nest o keel-dotnet, o declara la persistencia.'
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

/** Lo que el stack pide y keel-go no genera (un motor sin medir): se rechaza en el build en vez de estamparlo sin efecto. */
export function checkSupportedStack(stack) {
  const errors = [];
  // El motor solo importa con persistencia: sin ella, el cuestionario no lo pregunta y no se estampa.
  if (stack?.database && !SUPPORTED_DATABASES.includes(stack.database)) {
    errors.push(
      `database: ${stack.database} — keel-go genera la persistencia sobre ${SUPPORTED_DATABASES.join(', ')} ` +
        '(MariaDB, SQL Server y Oracle, sin medir en ninguna red). Elige uno de ellos, o genera este diseño con keel-spring, keel-nest o keel-dotnet.'
    );
  }
  if (stack?.broker && !SUPPORTED_BROKERS.includes(stack.broker)) {
    errors.push(
      `broker: ${stack.broker} — keel-go genera la mensajería sobre ${SUPPORTED_BROKERS.join(', ')}` +
        `${PENDING_BROKERS[stack.broker] ? ` (${stack.broker} llega en el ${PENDING_BROKERS[stack.broker]} de PLAN-KEEL-GO.md)` : ''}. ` +
        'Elige otro, o genera este diseño con keel-spring, keel-nest o keel-dotnet.'
    );
  }
  return { errors };
}

/**
 * Lo que keel-go todavía no genera de la capa security (incremento 8): la clave de API (`protocol: api-key` o
 * `serviceAuth.protocol: api-key`), que ninguna fixture declara, así que ninguna red mediría lo emitido.
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
  const identity = authentication.callerIdentity;
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


/**
 * La caché de lectura (tramo 13e) sin persistencia: el handler recibe la caché en las Dependencies de los casos de uso,
 * que solo existen con ella (y NewUseCases es quien cablea su invalidación). Ninguna fixture la declara sin persistencia:
 * sin red que mida lo emitido.
 */
function cacheErrors(layers) {
  const cached = Object.entries(layers?.['use-cases']?.operations ?? {})
    .filter(([, operation]) => operation?.cache != null)
    .map(([name]) => name);
  if (cached.length === 0 || layers?.persistence) return [];
  return [
    `use-cases: ${cached.join(', ')} declara${cached.length === 1 ? '' : 'n'} cache sin persistencia — keel-go entrega la caché a los handlers en las ` +
      'Dependencies de los casos de uso, que solo existen con persistencia (ninguna fixture que keel-go genere lo declara: sin red que mida lo ' +
      'emitido). Genera este diseño con keel-spring, keel-nest o keel-dotnet.'
  ];
}

/**
 * El almacenamiento sin persistencia (tramo 13f): la política y el puerto llegan a los handlers en las Dependencies de los
 * casos de uso, que solo existen con persistencia, como la caché.
 */
function storageErrors(layers) {
  if (layers?.persistence) return [];
  return [
    'capa storage sin persistencia — keel-go entrega la política de cada bucket y el puerto de almacenamiento a los handlers en ' +
      'las Dependencies de los casos de uso, que solo existen con persistencia (ninguna fixture que keel-go genere lo declara: ' +
      'sin red que mida lo emitido). Genera este diseño con keel-spring, keel-nest o keel-dotnet.'
  ];
}

/**
 * Lo que keel-go todavía no sabe hacer con los clientes salientes y las dependencias (incremento 11 de PLAN-KEEL-GO.md):
 * los clientes, su resiliencia, las activaciones, `needs` y OAuth2 (tramo 13h) se generan; esto, no, cada cosa con su motivo.
 *   · la réplica sobre documentos: ninguna fixture documental la declara;
 *   · un value object compuesto en la URL o en una cabecera: no tiene forma (el rechazo neutral de los cuatro); en el cuerpo
 *     y en la respuesta se genera desde el 16, con su lector de la entrada (la prueba emitida clients_test.go);
 *   · un campo json en una llamada: su conversor del cable lee también una cadena, y ninguna fixture lo declara;
 *   · una llamada sin method/path o sin contrato tipado, o con una respuesta sin campos: el adaptador lleva la cabecera de
 *     código generado y no puede llevar el TODO que esa llamada necesitaría (keel-dotnet lo deja al agente); ninguna
 *     fixture en alcance lo declara;
 *   · los clientes sin persistencia: se cablean en las Dependencies de los casos de uso, que solo existen con ella.
 */
function outboundErrors(layers) {
  const clients = Object.entries(layers?.['http-clients']?.clients ?? {});
  const errors = [...compositeUrlParamErrors(layers, 'keel-go')];
  const unmeasured = 'ninguna fixture que keel-go genere lo declara: sin red que mida lo emitido';
  for (const [dependency, definition] of Object.entries(layers?.dependencies?.dependencies ?? {})) {
    const replicated = Object.entries(definition?.needs ?? {}).filter(([, need]) => need?.strategy === 'replicated').map(([name]) => name);
    if (replicated.length > 0 && documentPersistence(layers)) {
      errors.push(`dependencies.${dependency}.needs (${replicated.join(', ')}): la réplica sobre documentos — keel-go todavía no la genera (${unmeasured}). Genera este diseño con keel-spring, keel-nest o keel-dotnet.`);
    }
  }
  for (const [client, definition] of clients) {
    for (const [call, spec] of Object.entries(definition?.calls ?? {})) {
      const json = [...Object.entries(spec?.request?.body ?? {}), ...Object.entries(spec?.response?.fields ?? {})]
        .filter(([, field]) => (field?.type ?? field?.items?.type) === 'json')
        .map(([name]) => name);
      if (json.length > 0) {
        errors.push(`http-clients.${client}.calls.${call}: ${json.join(', ')} es un campo json — keel-go todavía no lo genera en una llamada (${unmeasured}). Genera este diseño con keel-spring, keel-nest o keel-dotnet.`);
      }
      const typed = Boolean(spec?.request || spec?.response);
      const method = spec?.method ?? /^\s*([A-Z]+)\s+\S+/.exec(spec?.contract ?? '')?.[1];
      if (!method || !typed) {
        errors.push(
          `http-clients.${client}.calls.${call}: sin method/path o sin request/response tipados — keel-go escribe el adaptador entero y no deja ` +
            `un TODO en un archivo de código generado (${unmeasured}). Declara method, path y el contrato tipado.`
        );
      } else if (spec?.response && Object.keys(spec.response.fields ?? {}).length === 0) {
        errors.push(`http-clients.${client}.calls.${call}: la respuesta no declara campos — keel-go no deja un TODO en el adaptador generado (${unmeasured}). Declara sus campos.`);
      }
    }
  }
  if (clients.length > 0 && !layers?.persistence) {
    errors.push(
      'http-clients: keel-go cablea los clientes en las Dependencies de los casos de uso, que solo existen con persistencia ' +
        `(${unmeasured}). Genera este diseño con keel-spring, keel-nest o keel-dotnet.`
    );
  }
  return errors;
}

