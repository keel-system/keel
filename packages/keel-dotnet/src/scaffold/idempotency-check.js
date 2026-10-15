// El gate de idempotencia y compensación de keel-dotnet (incremento 10d): `infra/check-idempotency.sh`.
//
// El mismo tramo que vigilan los de keel-spring y keel-nest: build genera los mecanismos (el registro de peticiones, el
// de mensajes procesados, el reclamo del barrido, el respaldo del dispatcher) y el USO lo escribe el agente. Ese uso
// falla en silencio —un listener sin guarda, un handler que ignora el registro, un barrido que lee en vez de reclamar
// compilan, arrancan y pasan el camino feliz— y solo se nota en la primera repetición.
//
// El MOTOR que ejecuta la matriz es el de keel-core (gen/idempotency-gate.js), el mismo que el de los otros dos; aquí
// solo la MATRIZ, con patrones de C#. Las familias y los sujetos son los de keel-nest para el mismo diseño (lo compara
// test/idempotency-check.test.js), con lo que en .NET es cada pieza:
//   · la escritura de los registros como INSERT: en EF Core, `Add` (un `Update` o un `Attach` dejaría a EF decidir, y la
//     repetición no chocaría con la clave);
//   · conditionalUniqueness: cada `Save` del adaptador confirma su `SaveChanges` en el acto, como en keel-nest, así que lo
//     afirmable es que el handler busque la fila ocupante con el finder que build generó.
// La compensación, la reconciliación y la idempotencia saliente llegaron con el incremento 11c; el correo llega con el 13.

import { renderIdempotencyGate } from 'keel-core/gen/idempotency-gate';
import { kebabCase, relievingOperations } from 'keel-core/gen';
import { enumMember } from '../lib/cs-projection.js';
import { clientPort } from './http-clients.js';
import { schedulerClass } from './scheduling.js';
import { registryOperations } from 'keel-core/gen/request-idempotency';
import { csMember } from './render.js';
import { usesPersistence, usesDocument } from './persistence.js';
import { naturalKeyFinder, occupantFinders, repositoryRoots } from './repositories.js';
import { usesDotnetOutbox, usesMessaging, usesProcessedEvents } from './messaging.js';
import { usesRequestIdempotency } from './request-idempotency.js';

/** Dónde están las fuentes y qué archivos son los de los mensajes (nombran a todos los listeners y no son ninguno). */
// `bin` y `obj` viven DENTRO de src/<Proyecto>/: sin podarlas, la búsqueda por contenido elegía una DLL. Y C# deja varios
// tipos en un archivo (tres listeners en un Listeners.cs): el archivo localizado por contenido se recorta a su tipo.
export const DOTNET_GATE = { srcDir: 'src', extension: 'cs', messageFiles: 'Messaging/Subscriptions/', excludeDirs: ['bin', 'obj'], typesPerFile: 'many' };

export const CHECK_IDEMPOTENCY_SH = 'infra/check-idempotency.sh';

export function usesIdempotencyCheck(model) {
  return checksOf(model).length > 0;
}

export function generate(model) {
  const checks = checksOf(model);
  if (checks.length === 0) return [];
  return [{ path: CHECK_IDEMPOTENCY_SH, content: renderIdempotencyGate({ serviceName: model.service.name, platform: DOTNET_GATE }, checks) }];
}

/** La matriz: { group, subject, why } más lo que cada clase de comprobación necesita (ver keel-core). */
export function checksOf(model) {
  if (!usesPersistence(model)) return [];
  return [
    ...dedupeChecks(model),
    ...payloadContractChecks(model),
    ...insertChecks(model),
    ...commandChecks(model),
    ...naturalKeyChecks(model),
    ...domainEventChecks(model),
    ...compensationChecks(model),
    ...sweepClaimChecks(model),
    ...reconciliationChecks(model),
    ...outboundIdempotencyChecks(model),
    ...outboxChecks(model),
    ...conditionalUniquenessChecks(model)
  ];
}

const allOperations = (model) => (model.services ?? []).flatMap((service) => service.operations ?? []);

/**
 * La lectura del estado de partida que el reclamo existe para evitar: un finder por el campo del lifecycle de la entidad
 * reclamada (FindByStatus…, FindAllByStatusAnd…) o un FindAll. NO un finder cualquiera: releer por id un candidato YA
 * reclamado es legítimo (el mismo criterio que keel-spring y keel-nest).
 */
function stateReadingFinder(model, entityNames) {
  const fields = [...new Set(entityNames.map((name) => (model.entities ?? []).find((entity) => entity.name === name)?.lifecycle?.field).filter(Boolean))];
  const byState = fields.map((field) => '\\.Find(All)?By[A-Za-z]*' + csMember(field) + '[A-Za-z]*\\s*\\(');
  return [['\\.FindAll\\s*\\(', ...byState].join('|')];
}

/**
 * Con RabbitMQ, las suscripciones de la misma fuente comparten cola: UN listener que enruta por el tipo (varios serían
 * consumidores compitiendo). El mismo agrupado que keel-spring y keel-nest.
 */
function bySource(model, subscriptions) {
  if (model.stack?.broker !== 'rabbitmq') return subscriptions.map((sub) => [sub]);
  const groups = new Map();
  for (const sub of subscriptions) {
    if (!groups.has(sub.topicDefault)) groups.set(sub.topicDefault, []);
    groups.get(sub.topicDefault).push(sub);
  }
  return [...groups.values()];
}

const subjectOf = (subs) => (subs.length > 1 ? `${subs[0].topicDefault} (${subs.map((sub) => sub.name).join(', ')})` : subs[0].name);

/**
 * El listener no tiene nombre fijo (lo escribe el agente y lo registra en BrokerBindings.cs), así que se localiza por
 * CONTENIDO: el archivo que nombra los mensajes de esas suscripciones y usa la guarda.
 */
function listenerLocation(subs) {
  return {
    class: subs[0].listenerClass ?? `${subs[0].messageRecord}Listener`,
    locate: subs.map((sub) => sub.messageRecord).join('|'),
    confirm: 'IdempotencyGuard'
  };
}

// 1. Consumo: la guarda, actuar sobre lo que responde, y el orden que dicta el diseño.
function dedupeChecks(model) {
  if (!usesProcessedEvents(model)) return [];
  return bySource(model, model.subscriptions ?? []).map((subs) => {
    const guarded = subs.filter((sub) => sub.triggerHasDomainGuard);
    const unguarded = subs.filter((sub) => !sub.triggerHasDomainGuard);
    const shared = subs.length > 1;
    return {
      group: 'dedupe',
      subject: subjectOf(subs),
      ...listenerLocation(subs),
      require: [
        'IdempotencyGuard',
        // Referenciar la guarda sin mirar su respuesta no deduplica nada: el retorno gobierna una rama.
        '(if|return|while|&&|\\|\\||!)[^;]*\\.?(AlreadyProcessed|TryRecord)\\s*\\(',
        ...(guarded.length > 0 ? ['\\.Record\\s*\\('] : []),
        ...(unguarded.length > 0 ? ['\\.TryRecord\\s*\\('] : [])
      ],
      forbid: [
        // El cruce caro, solo atribuible con un listener por evento: TryRecord en un handler reintentable marca como
        // procesado lo que falló; AlreadyProcessed+Record sin guarda de dominio deja la ventana.
        ...(shared ? [] : [guarded.length > 0 ? '\\.TryRecord\\s*\\(' : '\\.AlreadyProcessed\\s*\\(']),
        // Una clave inventada compila, pasa el camino feliz y deduplica cero.
        'Guid\\.NewGuid\\s*\\('
      ],
      why: shared
        ? `las ${subs.length} suscripciones leen de la cola de '${subs[0].topicDefault}': UN listener que enruta por el tipo, con los órdenes que el diseño pide — ` +
          [
            guarded.length > 0 ? `Record(...) tras despachar para ${guarded.map((sub) => sub.name).join(', ')}` : null,
            unguarded.length > 0 ? `TryRecord(...) antes de despachar para ${unguarded.map((sub) => sub.name).join(', ')}` : null
          ]
            .filter(Boolean)
            .join(' y ')
        : guarded.length > 0
          ? `'${subs[0].trigger}' tiene guarda de dominio: AlreadyProcessed(...) antes y Record(...) DESPUÉS de despachar bien`
          : `'${subs[0].trigger}' no tiene guarda de dominio: TryRecord(...) antes de despachar, que es lo único que cierra la ventana`
    };
  });
}

// 1b. Que lo que se procese traiga lo que el diseño prometió: RequireContract() DESPUÉS de filtrar por tipo.
function payloadContractChecks(model) {
  if (!usesMessaging(model)) return [];
  const subscriptions = (model.subscriptions ?? []).filter((sub) => (sub.fields ?? []).some((field) => field.required));
  return bySource(model, subscriptions).map((subs) => ({
    group: 'payloadContract',
    subject: subjectOf(subs),
    ...listenerLocation(subs),
    require: ['\\.RequireContract\\s*\\('],
    forbid: [],
    why:
      `${subs.map((sub) => `'${sub.name}'`).join(', ')} declara${subs.length > 1 ? 'n' : ''} campos obligatorios: el listener llama a ` +
      'RequireContract() del mensaje DESPUÉS del filtro por el tipo — lanzar antes mandaría al descarte un mensaje ajeno'
  }));
}

// 1c. Que la escritura de los registros sea un INSERT de verdad. Vigila archivos de build, y hace falta: no son
//     intocables (una corrida de keel-spring vio al agente editar un mapper generado).
function insertChecks(model) {
  // Sobre documentos (incremento 12c), el INSERT es InsertOneAsync, y lo prohibido es el reemplazo y el upsert: sobre un
  // `_id` presente no chocarían nunca. El mismo criterio que el gate de keel-nest documental.
  const document = usesDocument(model);
  const write = (group, file, why) => ({
    group,
    subject: `${file}: la escritura es un INSERT`,
    class: file,
    require: document ? ['InsertOneAsync\\s*\\('] : ['\\.Add\\s*\\('],
    forbid: document ? ['ReplaceOne', 'IsUpsert', 'UpdateOne', 'FindOneAndReplace'] : ['\\.Update\\s*\\(', '\\.Attach\\s*\\(', 'ExecuteUpdate'],
    why
  });
  const checks = [];
  if (usesProcessedEvents(model)) {
    checks.push(
      write(
        'dedupe',
        'IdempotencyGuard',
        document
          ? 'InsertOneAsync y NO un reemplazo ni un upsert: sobre un _id presente, una reentrega nunca chocaría con la clave'
          : 'Add() y NO Update() ni Attach(): con EF decidiendo, una reentrega nunca chocaría con la clave'
      )
    );
  }
  if (usesRequestIdempotency(model) && registryOperations(model).length > 0) {
    checks.push(
      write(
        'commandIdempotency',
        'IdempotencyStore',
        document
          ? 'InsertOneAsync y NO un reemplazo ni un upsert: es el _id el que arbitra la carrera de dos peticiones con la misma clave'
          : 'Add() y NO Update() ni Attach(): es la clave primaria la que arbitra la carrera de dos peticiones con la misma clave'
      )
    );
  }
  return checks;
}

// 2. Idempotencia de petición: el mecanismo está generado; se comprueba que el handler lo USE.
function commandChecks(model) {
  if (!usesRequestIdempotency(model)) return [];
  return registryOperations(model).map((operation) => {
    const source = operation.idempotency.keySource;
    return {
      group: 'commandIdempotency',
      subject: operation.name,
      class: operation.handlerClass,
      require: ['idempotencyStore\\.(Find|Save)\\s*\\(', 'CommandSignature\\.Of\\s*\\(', 'IdempotencyScope\\s*\\('],
      forbid: [
        // Una firma escrita a mano no es la canónica: otra réplica o otro despliegue firman distinto.
        'SHA256|HashData\\s*\\(',
        // Con payload-hash o payload-field la clave sale del comando: no hay cabecera ni rama «sin clave».
        ...(['payload-hash', 'payload-field'].includes(source) ? ['IdempotencyContext'] : [])
      ],
      why:
        source === 'payload-hash'
          ? 'keySource: payload-hash — la clave es CommandSignature.Of(command), sin IdempotencyContext ni rama «sin clave»'
          : source === 'payload-field'
            ? `keySource: payload-field — la clave es command.${csMember(operation.idempotency.keyField)}, sin IdempotencyContext; la firma por CommandSignature.Of(command) y el ámbito por command.IdempotencyScope()`
            : 'keySource: client-key — la clave llega por IdempotencyContext.Get(), la firma por CommandSignature.Of(command) y el ámbito por command.IdempotencyScope()'
    };
  });
}

// 2b. Idempotencia guardada por la CLAVE NATURAL: no hay registro; el handler consulta por esa clave.
function naturalKeyChecks(model) {
  return allOperations(model)
    .filter((operation) => operation.idempotency?.guard === 'natural-key')
    .map((operation) => {
      const entity = (model.entities ?? []).find((candidate) => candidate.name === operation.idempotency.entity);
      const finder = entity ? naturalKeyFinder(model, entity) : null;
      if (!finder) return null;
      return {
        group: 'commandIdempotency',
        subject: operation.name,
        class: operation.handlerClass,
        // FindBy<…><Campo><…>( — admite la variante normalizada del MISMO campo, no cualquier consulta.
        require: ['FindBy[A-Za-z]*' + finder.params.map((param) => csMember(param.name)).join('[A-Za-z]*And') + '[A-Za-z]*\\s*\\('],
        forbid: ['IdempotencyStore'],
        why:
          `keySource: payload-field con guarda en la clave natural (${operation.idempotency.naturalKey.join(', ')}) — la repetición se resuelve ` +
          `consultando por ${finder.params.map((param) => param.name).join(' + ')} (${finder.name}(...) o la variante normalizada) y actuando sobre ` +
          'lo que exista. Nunca con un almacén de claves'
      };
    })
    .filter(Boolean);
}

// 3. El Raise(...) de cada evento publicado, en el AGREGADO que lo acumula: sin él no hay evento que entregar.
function domainEventChecks(model) {
  if (!usesMessaging(model)) return [];
  return (model.events ?? [])
    .flatMap((event) => (event.aggregates ?? []).map((aggregate) => ({ event, aggregate })))
    .map(({ event, aggregate }) => ({
      group: 'domainEvent',
      subject: (event.aggregates ?? []).length > 1 ? `${event.name} · ${aggregate}` : event.name,
      class: aggregate,
      require: ['Raise\\s*\\(\\s*' + event.className + '\\.Of\\s*\\('],
      forbid: ['TODO.*' + event.name],
      why:
        `${event.name} lo publica el diseño, pero quien lo crea es el agregado: el método de negocio de ` +
        `${(event.emittedBy ?? []).filter((e) => e.aggregate === aggregate).map((e) => e.operation).join(', ') || 'la operación que lo declara'} ` +
        `hace Raise(${event.className}.Of(...)). Sin eso el outbox queda vacío y solo lo ve un escenario que espera el mensaje`
    }));
}

// 4. El barrido RECLAMA su lote. Con reclamo generado, el handler lo llama y no lee con un finder; sin él (lo que build
//    no puede generar), tiene que existir una escritura condicional sobre la entidad barrida.
function sweepClaimChecks(model) {
  const sweeps = allOperations(model).filter((operation) => operation.sweep && (operation.reconciles ?? []).length === 0);
  if (sweeps.length === 0) return [];
  // Sin escapes que awk no entienda: con `scope: method` estos patrones viajan también por awk.
  const CLAIM_WRITE = 'ExecuteUpdate|UPDATE[[:space:]]|[Cc]laim|[Rr]eclam';
  // Los bloques de BUILD que también escriben con condición y no reclaman nada: los reclamos generados para otros
  // barridos y el Save, cuyo UPDATE condicional es el del bloqueo optimista. Sin el Save, el barrido que build no puede
  // reclamar saldría VERDE sobre el árbol recién generado (lo midió keel-nest).
  const generated = [...sweeps.flatMap((operation) => (operation.claim ?? []).map((claim) => csMember(claim.method))), 'Task<[A-Za-z]+> Save[(]'];
  return sweeps.map((operation) => {
    const claims = operation.claim ?? [];
    if (claims.length > 0) {
      return {
        group: 'sweepClaim',
        subject: operation.name,
        class: operation.handlerClass,
        require: [claims.map((claim) => '\\.?' + csMember(claim.method) + '\\s*\\(').join('|')],
        // Leer el estado de partida con un finder es EXACTAMENTE el fallo: la misma página en todas las réplicas.
        forbid: stateReadingFinder(model, claims.map((claim) => claim.entity)),
        why:
          `el barrido corre en TODAS las réplicas: RECLAMA su lote con ${claims.map((claim) => `${csMember(claim.method)}()`).join(' / ')}, ` +
          'que build generó en el puerto, no lo lee con un finder'
      };
    }
    const entities = [...new Set((operation.transitions ?? []).map((transition) => transition.entity))];
    return {
      group: 'sweepClaim',
      subject: operation.name,
      claim: CLAIM_WRITE,
      bound: entities.join('|'),
      scope: 'method',
      // El bloque que build generó para OTRO barrido no cuenta: el del agente cabe en el mismo adaptador.
      deny: generated.join('|'),
      exclude: '(^$)',
      why:
        `el barrido corre en TODAS las réplicas, así que su trabajo se RECLAMA con una escritura condicional sobre ` +
        `${entities.join(', ')} —no se lee con un finder—, y no aparece ninguna. build NO pudo generarla (su aviso dice por qué), ` +
        `así que la escribes tú CON SU COTA TEMPORAL, en el adaptador de ${entities.join(', ')}`
    };
  });
}

// 3b. Compensación (incremento 11c): el handler no puede quedar a medias; si la vuelta al proveedor es una llamada, tiene
//     que hacerla; y el estado que el encargo movió vuelve a su sitio EN EL AGREGADO.
function compensationChecks(model) {
  const checks = [];
  for (const operation of allOperations(model)) {
    if (!operation.compensates) continue;
    const leg = returnLegOf(model, operation);
    checks.push({
      group: 'compensation',
      subject: operation.name,
      class: operation.handlerClass,
      // Más estricto que nombrar el puerto (ya está en el constructor que genera build): que se LLAME.
      require: leg?.kind === 'client' ? ['\\.?' + leg.local + '\\.' + leg.method + '\\s*\\('] : [],
      forbid: ['TODO'],
      why:
        leg?.kind === 'client'
          ? `compensa ${operation.compensates.dependency}: además de devolver el estado propio avisa al proveedor con ${leg.local}.${leg.method}(...)`
          : leg?.kind === 'event'
            ? `compensa ${operation.compensates.dependency}: la vuelta va por el evento ${leg.event.name}, que emite el AGREGADO (familia domainEvent); aquí, que el handler no quede a medias`
            : `compensa ${operation.compensates.dependency}: el diseño no declara activación de vuelta, así que solo devuelve el estado propio`
    });
    const moved = new Set(operation.compensates.moves ?? []);
    for (const transition of operation.transitions ?? []) {
      if (!moved.has(transition.entity)) continue;
      const entity = (model.entities ?? []).find((candidate) => candidate.name === transition.entity);
      if (!entity?.lifecycle) continue;
      const member = enumMember(transition.to);
      checks.push({
        group: 'compensation',
        subject: `${operation.name} · estado de ${transition.entity}`,
        class: transition.entity,
        require: ['TransitionTo\\s*\\(\\s*(' + entity.lifecycle.enumType + '\\.)?' + member + '\\s*\\)'],
        forbid: [],
        why:
          `el encargo que deshace movió el lifecycle de ${transition.entity}: devolverlo a ${transition.to} es parte de la compensación, ` +
          `y lo hace el método semántico del agregado con TransitionTo(${entity.lifecycle.enumType}.${member})`
      });
    }
  }
  return checks;
}

/** La vuelta al proveedor: una llamada (se exige en el handler) o un evento (lo emite el agregado). */
function returnLegOf(model, operation) {
  const activations = (operation.dependencyActivations ?? []).map((entry) => entry.activation);
  const called = activations.find((activation) => activation.http?.clientClass);
  if (called) {
    const client = (model.httpClients ?? []).find((candidate) => candidate.clientClass === called.http.clientClass);
    const port = client ? clientPort(client) : `I${called.http.clientClass}`;
    return { kind: 'client', local: `${port[1].toLowerCase()}${port.slice(2)}`, method: csMember(called.http.call) };
  }
  const published = activations.find((activation) => activation.event?.name);
  return published ? { kind: 'event', event: published.event } : null;
}

// 4b. Reconciliación (incremento 11c). La pata del silencio, y la que ningún escenario FL-* ejercita entera: un cron no
//     se alcanza desde fuera. Las mismas reglas que keel-spring y keel-nest, con lo que en C# es cada pieza.
function reconciliationChecks(model) {
  const checks = [];
  const pending = [];
  const generated = [];
  for (const operation of allOperations(model)) {
    for (const { dependency, activation, claim } of operation.reconciles ?? []) {
      if (!claim) {
        if (!pending.some((entry) => entry.activation.name === activation.name)) pending.push({ dependency, activation });
        continue;
      }
      generated.push(csMember(claim.method));
      checks.push({
        group: 'reconciliation',
        subject: `${operation.name} · reclamo de ${dependency}.${activation.name}`,
        class: operation.handlerClass,
        require: ['\\.?' + csMember(claim.method) + '\\s*\\('],
        // La lectura por estado es EXACTAMENTE el patrón que el reclamo evita.
        forbid: stateReadingFinder(model, [claim.entity]),
        why:
          `el barrido corre en TODAS las réplicas: toma su lote con ${csMember(claim.method)}(), que build generó en I${claim.entity}Repository ` +
          '—una marca persistida que caduca, y solo lo que esta réplica se llevó—, no con un finder ni con un reclamo aparte'
      });
    }
  }
  const sweeps = allOperations(model).filter((operation) => (operation.reconciles ?? []).length > 0);
  for (const operation of sweeps) {
    checks.push({
      group: 'reconciliation',
      subject: operation.name,
      class: operation.handlerClass,
      // Y sin tragarse los errores: un catch sin tipo (o de Exception a secas, sin variable que mirar) no distingue la
      // carrera con el camino feliz de un bug propio, y la llamada ya no lanza por el proveedor (su fallback lo absorbe).
      // Lo destapó la corrida stock-reservation de keel-nest (2026-10-08).
      forbid: ['TODO', 'catch\\s*\\{', 'catch\\s*\\(\\s*(System\\.)?Exception\\s*\\)'],
      require: [],
      why: `barre ${operation.reconciles.map((r) => `${r.dependency}.${r.activation.name}`).join(', ')}: el barrido tiene que estar escrito, no dejado en un stub, y sin catch que se lo trague todo — la carrera con el camino feliz se captura por su excepción concreta y se relanza lo demás`
    });
  }
  if (pending.length > 0) {
    // Los archivos que build genera con el patrón: encontrarlos probaría lo que build hizo.
    const exclude = '/(ReconciliationClaimStore|OutboxRelayStore|OutboxRelay|IdempotencyGuard|IdempotencyStore|TablePurges|BatchedPurge)[.]cs';
    const deny = [...generated, 'Task<[A-Za-z]+> Save[(]'].join('|');
    checks.push(
      {
        group: 'reconciliation',
        subject: 'reclamo del barrido',
        // Sin escapes que awk no entienda: con `scope: method` estos patrones viajan también por awk.
        claim: 'ExecuteUpdate|UPDATE[[:space:]]|reconciliationClaims[.]Claim[(]|ReconciliationClaimStore',
        scope: 'method',
        deny,
        bound: '[Cc]laim|[Rr]eclam',
        exclude,
        why:
          'ninguna escritura reclama candidatos con una MARCA PERSISTIDA (la tienda de reconciliation_claim, o un UPDATE condicional): ' +
          'el barrido corre en TODAS las réplicas, y un lock solo aísla mientras dura su transacción, con la llamada al proveedor en medio'
      },
      {
        group: 'reconciliation',
        subject: 'lote del barrido',
        claim: '[.]Take[(]|BatchSize|LIMIT',
        bound: '[Cc]andidat|[Rr]econcil|[Cc]laim|[Rr]eclam|[Ss]tale',
        scope: 'method',
        deny,
        exclude,
        why: 'el reclamo del barrido no acota su lote: sin cota, una pasada con 50.000 atascados son 50.000 llamadas al proveedor'
      }
    );
    for (const { dependency, activation } of pending) {
      checks.push({
        group: 'reconciliation',
        subject: `umbral de ${dependency}.${activation.name}`,
        claim: 'UnansweredAfterSeconds',
        bound: activation.name,
        exclude: '/(ReconciliationSettings|ReconciliationClaimStore)[.]cs',
        why:
          `el umbral de espera de ${dependency}.${activation.name} no se lee en ninguna parte: build lo dejó en ` +
          `ReconciliationSettings.Windows["${activation.name}"] (reconciliation.${kebabCase(activation.name)}.unanswered-after-seconds), y el de OTRO barrido no vale`
      });
    }
  }
  // El disparador: build lo deja rechazando cuando el mensaje necesita argumentos.
  for (const service of model.services ?? []) {
    const operations = (service.operations ?? []).filter((operation) => (operation.reconciles ?? []).length > 0);
    if (operations.length === 0) continue;
    checks.push({
      group: 'reconciliation',
      subject: schedulerClass(service),
      class: schedulerClass(service),
      require: [operations.map((operation) => operation.messageClass).join('|')],
      forbid: ['TODO: despachar'],
      why: `el disparador de ${operations.map((operation) => operation.name).join(', ')}: build lo deja rechazando cuando el mensaje lleva argumentos`
    });
  }
  return checks;
}

// 4c. La clave de idempotencia SALIENTE (incremento 11b): build la deja cableada en el intento de la llamada; si alguien la
//     quita, el retry le encarga al proveedor el mismo trabajo otra vez, y eso no falla: duplica.
function outboundIdempotencyChecks(model) {
  return (model.httpClients ?? []).flatMap((client) =>
    (client.calls ?? [])
      .filter((call) => call.idempotency)
      .map((call) => {
        const factory = call.idempotency.keyFrom === 'correlation' ? 'Correlated' : 'FromPayload';
        return {
          group: 'outboundIdempotency',
          subject: `${client.id}.${call.name}`,
          class: client.adapterClass,
          // Por LLAMADA: el nombre de la llamada va como primer argumento de la factoría.
          require: ['OutboundIdempotency\\.' + factory + '\\s*\\(\\s*"' + call.name + '"'],
          forbid: [],
          why:
            `la llamada declara idempotency.keyFrom: ${call.idempotency.keyFrom}: la cabecera ${call.idempotency.header} viaja con una clave ESTABLE ` +
            `entre reintentos — OutboundIdempotency.${factory}("${call.name}", …), que build dejó en ${csMember(call.name)}Once`
        };
      })
  );
}

// 5. La entrega del outbox: el respaldo del dispatcher no deja arrancar fuera de local/test, pero en local marca
//    publicadas filas que nunca salieron. Que el agente haya registrado el suyo en BrokerBindings.cs.
function outboxChecks(model) {
  if (!usesDotnetOutbox(model)) return [];
  return [
    {
      group: 'outboxDelivery',
      subject: 'OutboxDispatcher',
      class: 'BrokerBindings',
      require: ['Add(Singleton|Scoped|Transient)[[:space:]]*<[[:space:]]*IOutboxDispatcher[[:space:]]*,'],
      forbid: [],
      why: 'con reliability: outbox el diseño prometió que ningún evento se pierde; con solo el respaldo de build no sale ninguno'
    }
  ];
}

// 6. El RELEVO en un índice único condicionado (el mismo sujeto que keel-spring y keel-nest). La operación saca una fila
//    del estado del índice y mete otra en el mismo acto, y el índice se comprueba por FILA: la que lo ocupaba se retira y
//    se GUARDA antes de guardar la nueva. Cada Save del adaptador confirma su SaveChanges en el acto, así que lo
//    afirmable es que el handler busque la ocupante con el finder que build generó.
function conditionalUniquenessChecks(model) {
  // Solo relacional, como keel-spring y keel-nest: en documental sus gates no la emiten y aquí tampoco (la nota del stub sí).
  if (usesDocument(model)) return [];
  return relievingOperations(model).map(({ operation, entity, state }) => {
    const root = repositoryRoots(model).find((candidate) => candidate.name === entity.rootEntity) ?? entity;
    const finder = occupantFinders(model, root).find((candidate) => candidate.state === state);
    return {
      group: 'conditionalUniqueness',
      subject: `${operation.name} (${entity.name}.${state})`,
      class: operation.handlerClass,
      require: [finder ? '[.]?' + finder.name + '[ ]*[(]' : 'Save[ ]*[(]'],
      forbid: ['NotImplementedException'],
      why:
        `releva sobre el índice único condicionado de ${entity.name}.${state}: retira la fila que lo ocupaba${finder ? ` (búscala con ${finder.name}(...))` : ''} ` +
        'y GUÁRDALA antes de guardar la nueva. El índice se comprueba por FILA y no se puede diferir: al revés, la transición ' +
        'legítima muere con el error de unicidad del diseño, un 409 en el camino feliz'
    };
  });
}
