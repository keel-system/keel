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
// Las familias de lo que keel-dotnet todavía no genera (compensación, reconciliación, idempotencia saliente, correo)
// llegan con sus incrementos (11 y 13).

import { renderIdempotencyGate } from 'keel-core/gen/idempotency-gate';
import { relievingOperations } from 'keel-core/gen';
import { registryOperations } from 'keel-core/gen/request-idempotency';
import { csMember } from './render.js';
import { usesRelational } from './persistence.js';
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
  if (!usesRelational(model)) return [];
  return [
    ...dedupeChecks(model),
    ...payloadContractChecks(model),
    ...insertChecks(model),
    ...commandChecks(model),
    ...naturalKeyChecks(model),
    ...domainEventChecks(model),
    ...sweepClaimChecks(model),
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
  const write = (group, file, why) => ({
    group,
    subject: `${file}: la escritura es un INSERT`,
    class: file,
    require: ['\\.Add\\s*\\('],
    forbid: ['\\.Update\\s*\\(', '\\.Attach\\s*\\(', 'ExecuteUpdate'],
    why
  });
  const checks = [];
  if (usesProcessedEvents(model)) {
    checks.push(write('dedupe', 'IdempotencyGuard', 'Add() y NO Update() ni Attach(): con EF decidiendo, una reentrega nunca chocaría con la clave'));
  }
  if (usesRequestIdempotency(model) && registryOperations(model).length > 0) {
    checks.push(write('commandIdempotency', 'IdempotencyStore', 'Add() y NO Update() ni Attach(): es la clave primaria la que arbitra la carrera de dos peticiones con la misma clave'));
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
