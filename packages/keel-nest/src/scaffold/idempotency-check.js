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
import { kebabCase, screamingSnake } from 'keel-core/gen';
import { registryOperations } from 'keel-core/gen/request-idempotency';
import { capitalize, fileName } from './render.js';
import { usesPersistence, usesDocument } from './persistence-entities.js';
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
    ...outboxChecks(model)
  ];
}

// 4c. La clave de idempotencia SALIENTE (incremento 11b): build la deja cableada en el intento de la llamada;
//     si alguien la quita, el retry le encarga al proveedor el mismo trabajo otra vez, y eso no falla: duplica.
function outboundIdempotencyChecks(model) {
  return (model.httpClients ?? []).flatMap((client) =>
    (client.calls ?? [])
      .filter((call) => call.idempotency)
      .map((call) => {
        const factory = call.idempotency.keyFrom === 'correlation' ? 'correlated' : 'fromPayload';
        return {
          group: 'outboundIdempotency',
          subject: `${client.id}.${call.name}`,
          class: fileName(client.adapterClass),
          // Por LLAMADA: el nombre de la llamada va como primer argumento de la factoría.
          require: ['OutboundIdempotency\\.' + factory + "\\s*\\(\\s*'" + call.name + "'"],
          forbid: [],
          why:
            `la llamada declara idempotency.keyFrom: ${call.idempotency.keyFrom}: la cabecera ${call.idempotency.header} viaja con una clave ESTABLE ` +
            `entre reintentos — OutboundIdempotency.${factory}('${call.name}', …), que build dejó en ${call.name}Once`
        };
      })
  );
}

const decap = (name) => name[0].toLowerCase() + name.slice(1);

// 3b. Compensación (incremento 11c): el handler no puede quedar a medias; si la vuelta al proveedor es una
//     llamada, tiene que hacerla; y el estado que el encargo movió vuelve a su sitio EN EL AGREGADO.
function compensationChecks(model) {
  const checks = [];
  for (const operation of allOperations(model)) {
    if (!operation.compensates) continue;
    const leg = returnLegOf(operation);
    checks.push({
      group: 'compensation',
      subject: operation.name,
      class: fileName(operation.handlerClass),
      // Más estricto que nombrar el tipo (el puerto ya está en el `inject` que genera build): que se LLAME.
      require: leg?.kind === 'client' ? ['\\.' + decap(leg.clientClass) + '\\.' + leg.call + '\\s*\\('] : [],
      forbid: ['TODO'],
      why:
        leg?.kind === 'client'
          ? `compensa ${operation.compensates.dependency}: además de devolver el estado propio avisa al proveedor con this.${decap(leg.clientClass)}.${leg.call}(...)`
          : leg?.kind === 'event'
            ? `compensa ${operation.compensates.dependency}: la vuelta va por el evento ${leg.event.name}, que emite el AGREGADO (familia domainEvent); aquí, que el handler no quede a medias`
            : `compensa ${operation.compensates.dependency}: el diseño no declara activación de vuelta, así que solo devuelve el estado propio`
    });
    const moved = new Set(operation.compensates.moves ?? []);
    for (const transition of operation.transitions ?? []) {
      if (!moved.has(transition.entity)) continue;
      const entity = (model.entities ?? []).find((candidate) => candidate.name === transition.entity);
      if (!entity?.lifecycle) continue;
      const state = screamingSnake(transition.to);
      checks.push({
        group: 'compensation',
        subject: `${operation.name} · estado de ${transition.entity}`,
        class: fileName(transition.entity),
        require: ['transitionTo\\s*\\(\\s*(' + entity.lifecycle.enumType + '\\.)?' + state + '\\s*\\)'],
        forbid: [],
        why:
          `el encargo que deshace movió el lifecycle de ${transition.entity}: devolverlo a ${transition.to} es parte de la compensación, ` +
          `y lo hace el método semántico del agregado con this.transitionTo(${entity.lifecycle.enumType}.${state})`
      });
    }
  }
  return checks;
}

/** La vuelta al proveedor: una llamada (se exige en el handler) o un evento (lo emite el agregado). */
function returnLegOf(operation) {
  const activations = (operation.dependencyActivations ?? []).map((entry) => entry.activation);
  const called = activations.find((activation) => activation.http?.clientClass);
  if (called) return { kind: 'client', clientClass: called.http.clientClass, call: called.http.call };
  const published = activations.find((activation) => activation.event?.name);
  return published ? { kind: 'event', event: published.event } : null;
}

// 4b. Reconciliación (incremento 11c). La pata del silencio, y la que ningún escenario FL-* ejercita entera:
//     un cron no se alcanza desde fuera. Mismas reglas que keel-spring, con lo que en TypeScript es cada pieza.
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
      generated.push(claim.method);
      checks.push({
        group: 'reconciliation',
        subject: `${operation.name} · reclamo de ${dependency}.${activation.name}`,
        class: fileName(operation.handlerClass),
        require: ['\\.?' + claim.method + '\\s*\\('],
        // La lectura por estado es EXACTAMENTE el patrón que el reclamo evita.
        forbid: stateReadingFinder(model, [claim.entity]),
        why:
          `el barrido corre en TODAS las réplicas: toma su lote con ${claim.method}(), que build generó en ${claim.entity}Repository ` +
          '—una marca persistida que caduca, y solo lo que esta réplica se llevó—, no con un finder ni con un reclamo aparte'
      });
    }
  }
  const sweeps = allOperations(model).filter((operation) => (operation.reconciles ?? []).length > 0);
  for (const operation of sweeps) {
    checks.push({
      group: 'reconciliation',
      subject: operation.name,
      class: fileName(operation.handlerClass),
      // Y sin tragarse los errores: un catch SIN variable no puede distinguir la carrera con el camino feliz (la
      // transición rechazada, el conflicto de versión) de un bug propio, y la llamada ya no lanza por el proveedor
      // (su fallback lo absorbe). Lo destapó la corrida stock-reservation (2026-10-08): dos catch {} en el barrido.
      forbid: ['TODO', 'catch\\s*\\{'],
      require: [],
      why: `barre ${operation.reconciles.map((r) => `${r.dependency}.${r.activation.name}`).join(', ')}: el barrido tiene que estar escrito, no dejado en un stub, y sin catch que se lo trague todo — la carrera con el camino feliz se captura por su excepción concreta y se relanza lo demás`
    });
  }
  if (pending.length > 0) {
    // Los archivos que build genera con el patrón: encontrarlos probaría lo que build hizo.
    const exclude = '/(reconciliation-claim-store|outbox-relay-store|outbox-relay|idempotency-guard|idempotency-store-impl|table-purges|batched-purge)[.]ts';
    const deny = [...generated, 'async save[(]'].join('|');
    checks.push(
      {
        group: 'reconciliation',
        subject: 'reclamo del barrido',
        // Sin escapes que awk no entienda: con `scope: method` estos patrones viajan también por awk.
        claim: '[.]update[(]|reconciliationClaims[.]claim[(]|ReconciliationClaimStore',
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
        claim: '[.]limit[(]|[.]take[(]|[Bb]atch[Ss]ize|LIMIT',
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
        claim: 'unansweredAfterSeconds',
        bound: activation.name,
        exclude: '/(reconciliation-settings|reconciliation-claim-store)[.]ts',
        why:
          `el umbral de espera de ${dependency}.${activation.name} no se lee en ninguna parte: build lo dejó en ` +
          `RECONCILIATION_SETTINGS (reconciliation.${kebabCase(activation.name)}.unanswered-after-seconds), y el de OTRO barrido no vale`
      });
    }
  }
  // El disparador: build lo deja rechazando cuando el mensaje necesita argumentos.
  for (const service of model.services ?? []) {
    const operations = (service.operations ?? []).filter((operation) => (operation.reconciles ?? []).length > 0);
    if (operations.length === 0) continue;
    const scheduler = service.className.replace(/Service$/, 'Scheduler');
    checks.push({
      group: 'reconciliation',
      subject: scheduler,
      class: fileName(scheduler),
      require: [operations.map((operation) => operation.messageClass).join('|')],
      forbid: ['TODO: despachar'],
      why: `el disparador de ${operations.map((operation) => operation.name).join(', ')}: build lo deja rechazando cuando el mensaje lleva argumentos`
    });
  }
  return checks;
}

const allOperations = (model) => (model.services ?? []).flatMap((service) => service.operations ?? []);

/**
 * La lectura del estado de partida que el reclamo existe para evitar: un finder por el campo del lifecycle de la
 * entidad reclamada (findByStatus…, findAllByStatusAnd…) o un findAll. NO un finder cualquiera: releer por id un
 * candidato YA reclamado, para ver si el camino feliz ganó entre el reclamo y la transición, es legítimo, y
 * prohibirlo empujó a la corrida stock-reservation de keel-spring (2026-10-08) a esconder ese findById detrás de
 * un método con otro nombre para callar el gate.
 */
function stateReadingFinder(model, entityNames) {
  const fields = [...new Set(entityNames.map((name) => (model.entities ?? []).find((entity) => entity.name === name)?.lifecycle?.field).filter(Boolean))];
  const byState = fields.map((field) => '\\.find(All)?By[A-Za-z]*' + capitalize(field) + '[A-Za-z]*\\s*\\(');
  return [['\\.findAll\\s*\\(', ...byState].join('|')];
}

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
  // La misma promesa en los dos almacenes: que el registro choque con su clave en vez de pisarla. En TypeORM,
  // insert() y no save() (save es un upsert); en MongoDB, insertOne() y no un reemplazo ni un upsert.
  const document = usesDocument(model);
  const write = (group, file, why) => ({
    group,
    subject: `${file}: la escritura es un INSERT`,
    class: file,
    require: document ? ['\\.insertOne\\s*\\('] : ['\\.insert\\s*\\('],
    forbid: document ? ['\\.replaceOne\\s*\\(', 'upsert\\s*:\\s*true'] : ['\\.save\\s*\\('],
    why: document ? why.replace('insert() y NO save(): save hace upsert', 'insertOne() y NO un reemplazo ni un upsert').replace('insert() y NO save()', 'insertOne() y NO un reemplazo ni un upsert') : why
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
        forbid: stateReadingFinder(model, claims.map((claim) => claim.entity)),
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
