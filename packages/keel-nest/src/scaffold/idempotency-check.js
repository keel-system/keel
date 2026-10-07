// El gate de idempotencia y compensación de keel-nest (incremento 10d): `infra/check-idempotency.sh`.
//
// El mismo tramo que vigila el de keel-spring: build genera los mecanismos (el registro de peticiones, el de
// mensajes procesados, el reclamo del barrido, el respaldo del dispatcher) y el USO lo escribe el agente. Ese
// uso falla en silencio —un listener sin guarda, un handler que ignora el registro, un barrido que lee en vez
// de reclamar compilan, arrancan y pasan el camino feliz— y solo se nota en la primera repetición.
//
// El MOTOR que ejecuta la matriz es el de keel-core (gen/idempotency-gate.js), el mismo que el de keel-spring;
// aquí solo la MATRIZ, con patrones de TypeScript. Las familias y los sujetos son los de keel-spring para el
// mismo diseño (lo compara test/idempotency-check.test.js), salvo lo que no tiene sentido aquí y se dice:
//   · conditionalUniqueness: en keel-spring JPA vuelca las escrituras al commit en el orden que elige, y el
//     handler tiene que forzar el volcado entre las dos; en keel-nest cada save escribe en ese momento, así
//     que no hay volcado diferido que ordenar (la nota del handler dice el orden de los save);
//   · la escritura de los registros como INSERT es la misma promesa con otra forma: en JPA hace falta
//     Persistable para que no sea un merge; en TypeORM, que se llame a insert y no a save (save es un upsert).
// Las familias de lo que keel-nest todavía no genera (compensación, reconciliación, idempotencia saliente,
// correo, contexto de telemetría) llegan con sus incrementos.

import { renderIdempotencyGate } from 'keel-core/gen/idempotency-gate';
import { registryOperations } from 'keel-core/gen/request-idempotency';
import { capitalize, fileName } from './render.js';
import { usesRelational } from './persistence-entities.js';
import { naturalKeyFinder } from './repositories.js';
import { usesNestOutbox, usesProcessedEvents, usesMessaging } from './messaging.js';
import { usesRequestIdempotency } from './request-idempotency.js';

/** Dónde están las fuentes y qué archivos son los de los mensajes (nombran a todos los listeners y no son ninguno). */
export const NEST_GATE = { srcDir: 'src', extension: 'ts', messageFiles: 'infrastructure/messaging/subscriptions/' };

export const CHECK_IDEMPOTENCY_SH = 'infra/check-idempotency.sh';

export function usesIdempotencyCheck(model) {
  return checksOf(model).length > 0;
}

export function generate(model) {
  const checks = checksOf(model);
  if (checks.length === 0) return [];
  return [{ path: CHECK_IDEMPOTENCY_SH, content: renderIdempotencyGate({ serviceName: model.service.name, platform: NEST_GATE }, checks) }];
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
    ...outboxChecks(model)
  ];
}

const allOperations = (model) => (model.services ?? []).flatMap((service) => service.operations ?? []);

/**
 * Con RabbitMQ, las suscripciones de la misma fuente comparten cola: UN listener que enruta por el tipo
 * (varios serían consumidores compitiendo). Mismo agrupado que keel-spring, y por lo mismo: ahí un check por
 * evento dejaría de ser atribuible.
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
 * El listener no tiene nombre fijo en keel-nest (lo escribe el agente y lo registra en broker-bindings.ts), así
 * que se localiza por CONTENIDO: el archivo que nombra los mensajes de esas suscripciones y usa la guarda.
 */
function listenerLocation(subs) {
  return {
    class: fileName(subs[0].listenerClass ?? `${subs[0].messageRecord}Listener`),
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
        '(if|return|while|&&|\\|\\||!)[^;]*\\.?(alreadyProcessed|tryRecord)\\s*\\(',
        ...(guarded.length > 0 ? ['\\.record\\s*\\('] : []),
        ...(unguarded.length > 0 ? ['\\.tryRecord\\s*\\('] : [])
      ],
      forbid: [
        // El cruce caro, solo atribuible con un listener por evento: tryRecord en un handler reintentable
        // marca como procesado lo que falló; alreadyProcessed+record sin guarda de dominio deja la ventana.
        ...(shared ? [] : [guarded.length > 0 ? '\\.tryRecord\\s*\\(' : '\\.alreadyProcessed\\s*\\(']),
        // Una clave inventada compila, pasa el camino feliz y deduplica cero.
        'randomUUID\\s*\\('
      ],
      why: shared
        ? `las ${subs.length} suscripciones leen de la cola de '${subs[0].topicDefault}': UN listener que enruta por el tipo, con los órdenes que el diseño pide — ` +
          [
            guarded.length > 0 ? `record(...) tras despachar para ${guarded.map((sub) => sub.name).join(', ')}` : null,
            unguarded.length > 0 ? `tryRecord(...) antes de despachar para ${unguarded.map((sub) => sub.name).join(', ')}` : null
          ]
            .filter(Boolean)
            .join(' y ')
        : guarded.length > 0
          ? `'${subs[0].trigger}' tiene guarda de dominio: alreadyProcessed(...) antes y record(...) DESPUÉS de despachar bien`
          : `'${subs[0].trigger}' no tiene guarda de dominio: tryRecord(...) antes de despachar, que es lo único que cierra la ventana`
    };
  });
}

// 1b. Que lo que se procese traiga lo que el diseño prometió: requireContract() DESPUÉS de filtrar por tipo.
function payloadContractChecks(model) {
  if (!usesMessaging(model)) return [];
  const subscriptions = (model.subscriptions ?? []).filter((sub) => (sub.fields ?? []).some((field) => field.required));
  return bySource(model, subscriptions).map((subs) => ({
    group: 'payloadContract',
    subject: subjectOf(subs),
    ...listenerLocation(subs),
    require: ['\\.requireContract\\s*\\('],
    forbid: [],
    why:
      `${subs.map((sub) => `'${sub.name}'`).join(', ')} declara${subs.length > 1 ? 'n' : ''} campos obligatorios: el listener llama a ` +
      'requireContract() del mensaje DESPUÉS del filtro por el tipo — lanzar antes mandaría al descarte un mensaje ajeno'
  }));
}

// 1c. Que la escritura de los registros sea un INSERT de verdad. Vigila archivos de build, y hace falta: no son
//     intocables (una corrida de keel-spring vio al agente editar un mapper generado). En TypeORM, save() hace
//     un upsert: la repetición no choca, y el registro dice «procesado» a todo.
function insertChecks(model) {
  const checks = [];
  const write = (group, file, why) => ({
    group,
    subject: `${file}: la escritura es un INSERT`,
    class: file,
    require: ['\\.insert\\s*\\('],
    forbid: ['\\.save\\s*\\('],
    why
  });
  if (usesProcessedEvents(model)) {
    checks.push(write('dedupe', 'idempotency-guard', 'insert() y NO save(): save hace upsert y una reentrega nunca chocaría con la clave'));
  }
  if (usesRequestIdempotency(model) && registryOperations(model).length > 0) {
    checks.push(write('commandIdempotency', 'idempotency-store-impl', 'insert() y NO save(): es la clave primaria la que arbitra la carrera de dos peticiones con la misma clave'));
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
      class: fileName(operation.handlerClass),
      require: ['IdempotencyStore', 'CommandSignature\\.of\\s*\\(', 'idempotencyScope\\s*\\('],
      forbid: [
        // Una firma escrita a mano no es la canónica: otra réplica o otro despliegue firman distinto.
        'createHash\\s*\\(',
        // Con payload-hash o payload-field la clave sale del comando: no hay cabecera ni rama «sin clave».
        ...(['payload-hash', 'payload-field'].includes(source) ? ['IdempotencyContext'] : [])
      ],
      why:
        source === 'payload-hash'
          ? 'keySource: payload-hash — la clave es CommandSignature.of(command), sin IdempotencyContext ni rama «sin clave»'
          : source === 'payload-field'
            ? `keySource: payload-field — la clave es command.${operation.idempotency.keyField}, sin IdempotencyContext; la firma por CommandSignature.of(command) y el ámbito por command.idempotencyScope()`
            : 'keySource: client-key — la clave llega por IdempotencyContext.get(), la firma por CommandSignature.of(command) y el ámbito por command.idempotencyScope()'
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
        class: fileName(operation.handlerClass),
        // findBy<…><Campo><…>( — admite la variante normalizada del MISMO campo, no cualquier consulta.
        require: ['findBy[A-Za-z]*' + finder.params.map((param) => capitalize(param.name)).join('[A-Za-z]*And') + '[A-Za-z]*\\s*\\('],
        forbid: ['IdempotencyStore'],
        why:
          `keySource: payload-field con guarda en la clave natural (${operation.idempotency.naturalKey.join(', ')}) — la repetición se resuelve ` +
          `consultando por ${finder.params.map((param) => param.name).join(' + ')} (${finder.name}(...) o la variante normalizada) y actuando sobre ` +
          'lo que exista. Nunca con un almacén de claves'
      };
    })
    .filter(Boolean);
}

// 3. El raise(...) de cada evento publicado, en el AGREGADO que lo acumula: sin él no hay evento que entregar.
function domainEventChecks(model) {
  if (!usesMessaging(model)) return [];
  return (model.events ?? [])
    .flatMap((event) => (event.aggregates ?? []).map((aggregate) => ({ event, aggregate })))
    .map(({ event, aggregate }) => ({
      group: 'domainEvent',
      subject: (event.aggregates ?? []).length > 1 ? `${event.name} · ${aggregate}` : event.name,
      class: fileName(aggregate),
      require: ['raise\\s*\\(\\s*' + event.className + '\\.of\\s*\\('],
      forbid: ['TODO.*' + event.name],
      why:
        `${event.name} lo publica el diseño, pero quien lo crea es el agregado: el método de negocio de ` +
        `${(event.emittedBy ?? []).filter((e) => e.aggregate === aggregate).map((e) => e.operation).join(', ') || 'la operación que lo declara'} ` +
        `hace this.raise(${event.className}.of(...)). Sin eso el outbox queda vacío y solo lo ve un escenario que espera el mensaje`
    }));
}

// 4. El barrido RECLAMA su lote. Con reclamo generado, el handler lo llama y no lee con un finder; sin él (lo
//    que build no puede generar), tiene que existir una escritura condicional sobre la entidad barrida.
function sweepClaimChecks(model) {
  const sweeps = allOperations(model).filter((operation) => operation.sweep && (operation.reconciles ?? []).length === 0);
  if (sweeps.length === 0) return [];
  // Sin escapes que awk no entienda: con `scope: method` estos patrones viajan también por awk.
  const CLAIM_WRITE = '[.]update[(]|[Cc]laim|[Rr]eclam';
  // Los bloques de BUILD que también escriben con condición y no reclaman nada: los reclamos generados para
  // otros barridos y el save, cuyo UPDATE condicional es el del bloqueo optimista. Sin el save, el barrido que
  // build no puede reclamar salía VERDE sobre el árbol recién generado.
  const generated = [...sweeps.flatMap((operation) => (operation.claim ?? []).map((claim) => claim.method)), 'async save[(]'];
  return sweeps.map((operation) => {
    const claims = operation.claim ?? [];
    if (claims.length > 0) {
      return {
        group: 'sweepClaim',
        subject: operation.name,
        class: fileName(operation.handlerClass),
        require: [claims.map((claim) => '\\.?' + claim.method + '\\s*\\(').join('|')],
        // Leer el estado de partida con un finder es EXACTAMENTE el fallo: la misma página en todas las réplicas.
        forbid: ['\\.find(All)?By[A-Za-z]*\\s*\\('],
        why:
          `el barrido corre en TODAS las réplicas: RECLAMA su lote con ${claims.map((claim) => `${claim.method}()`).join(' / ')}, ` +
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
      deny: generated.length > 0 ? generated.join('|') : null,
      exclude: '(^$)',
      why:
        `el barrido corre en TODAS las réplicas, así que su trabajo se RECLAMA con una escritura condicional sobre ` +
        `${entities.join(', ')} —no se lee con un finder—, y no aparece ninguna. build NO pudo generarla (su aviso dice por qué), ` +
        `así que la escribes tú CON SU COTA TEMPORAL, en el adaptador de ${entities.join(', ')}`
    };
  });
}

// 5. La entrega del outbox: el respaldo del dispatcher no deja arrancar fuera de local/test, pero en local
//    marca publicadas filas que nunca salieron. Que el agente haya registrado el suyo en broker-bindings.ts.
function outboxChecks(model) {
  if (!usesNestOutbox(model)) return [];
  return [
    {
      group: 'outboxDelivery',
      subject: 'OutboxDispatcher',
      class: 'broker-bindings',
      require: ['provide[[:space:]]*:[[:space:]]*OutboxDispatcher'],
      forbid: [],
      why: 'con reliability: outbox el diseño prometió que ningún evento se pierde; con solo el respaldo de build no sale ninguno'
    }
  ];
}
