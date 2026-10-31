// El gate de idempotencia y compensación de keel-go (tramo 10d): `infra/check-idempotency.sh`.
//
// El mismo tramo que vigilan los de keel-spring, keel-nest y keel-dotnet: build genera los mecanismos (el registro de
// peticiones, el de mensajes procesados, el reclamo del barrido, el respaldo del dispatcher) y el USO lo escribe el
// agente. Ese uso falla en silencio —un listener sin guarda, un handler que ignora el registro, un barrido que lee en vez
// de reclamar compilan, arrancan y pasan el camino feliz— y solo se nota en la primera repetición.
//
// El MOTOR que ejecuta la matriz es el de keel-core (gen/idempotency-gate.js); aquí solo la MATRIZ, con patrones de Go.
// Las familias y los sujetos son los de keel-nest para el mismo diseño (lo compara test/idempotency-check.test.js), con
// lo que en Go es cada pieza:
//   · el archivo se localiza por su NOMBRE de Go (`send_payouts_command_handler.go`), no por el del tipo;
//   · los listeners viven todos en `cmd/server/broker.go`, así que se localizan por contenido y se recortan a la función
//     de primer nivel que nombra sus mensajes (`typesPerFile: 'many'`), y los métodos son funciones de primer nivel
//     (`blockDepth: 0`);
//   · la respuesta de la guarda es un `(bool, error)`: descartarla con `_` es no deduplicar;
//   · la escritura de los registros es SQL literal: un INSERT sin `ON CONFLICT` ni `INSERT IGNORE`.
// La compensación, la reconciliación y la idempotencia saliente llegaron con el incremento 11 (tramo 11c); el correo
// llega con el 13 y su familia no tiene todavía mecanismo que vigilar (la frontera lo rechaza).

import { renderIdempotencyGate } from '@keel-system/keel-core/gen/idempotency-gate';
import { kebabCase, relievingOperations } from '@keel-system/keel-core/gen';
import { usesRelational } from '@keel-system/keel-core/gen/features';
import { registryOperations } from '@keel-system/keel-core/gen/request-idempotency';
import { subscriptionsBySource as bySource } from '@keel-system/keel-core/gen/messaging-plan';
import { enumConstant, goExported } from '../lib/go-projection.js';
import { goFileName } from './render.js';
import { handlerType } from './services.js';
import { claimMethod } from './claim.js';
import { callMethod, clientParam, usesGoHttpClients } from './http-clients.js';
import { messageStruct, usesGoMessaging, usesGoOutbox, usesGoProcessedEvents } from './messaging.js';
import { naturalKeyFinder, occupantFinders } from './repositories.js';
import { usesRequestIdempotency } from './request-idempotency.js';

/**
 * Las fuentes de Go viven en `cmd/` e `internal/`, así que se busca desde la raíz, solo en `.go` y fuera de lo que no es
 * del servidor (el arnés de `tests/`, que nombra los mismos mensajes). Los mensajes del paquete messaging nombran a todos
 * los listeners y no son ninguno.
 */
export const GO_GATE = {
  srcDir: '.',
  rootMarker: 'go.mod',
  extension: 'go',
  messageFiles: 'internal/infrastructure/messaging/',
  excludeDirs: ['tests', 'build', 'infra', 'deploy', 'docs', 'config', 'vendor', '.git'],
  typesPerFile: 'many',
  blockDepth: 0
};

export const CHECK_IDEMPOTENCY_SH = 'infra/check-idempotency.sh';

export function usesIdempotencyCheck(model) {
  return checksOf(model).length > 0;
}

export function generate(model) {
  const checks = checksOf(model);
  if (checks.length === 0) return [];
  return [{ path: CHECK_IDEMPOTENCY_SH, content: renderIdempotencyGate({ serviceName: model.service.name, platform: GO_GATE }, checks) }];
}

/** La matriz: { group, subject, why } más lo que cada clase de comprobación necesita (ver keel-core). */
export function checksOf(model) {
  // La persistencia documental llega con el incremento 12.
  if (!usesRelational(model)) return [];
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
const handlerFile = (operation) => goFileName(handlerType(operation));

/**
 * La lectura del estado de partida que el reclamo existe para evitar: un finder por el campo del lifecycle de la entidad
 * reclamada (FindByStatus…, FindAllByStatusAnd…) o un FindAll. NO un finder cualquiera: releer por id un candidato YA
 * reclamado es legítimo (el mismo criterio que los otros tres).
 */
function stateReadingFinder(model, entityNames) {
  const fields = [...new Set(entityNames.map((name) => (model.entities ?? []).find((entity) => entity.name === name)?.lifecycle?.field).filter(Boolean))];
  const byState = fields.map((field) => '\\.Find(All)?By[A-Za-z]*' + goExported(field) + '[A-Za-z]*\\s*\\(');
  return [['\\.FindAll\\s*\\(', ...byState].join('|')];
}

const subjectOf = (subs) => (subs.length > 1 ? `${subs[0].topicDefault} (${subs.map((sub) => sub.name).join(', ')})` : subs[0].name);

/**
 * Los listeners los escribe el agente en cmd/server/broker.go, así que se localizan por CONTENIDO: la función que nombra
 * los mensajes de esas suscripciones y consulta la guarda.
 */
function listenerLocation(subs) {
  return {
    class: goFileName(`${messageStruct(subs[0])}Listener`),
    locate: subs.map((sub) => messageStruct(sub)).join('|'),
    confirm: '\\.(AlreadyProcessed|TryRecord)\\s*\\('
  };
}

// 1. Consumo: la guarda, actuar sobre lo que responde, y el orden que dicta el diseño.
function dedupeChecks(model) {
  if (!usesGoProcessedEvents(model)) return [];
  return bySource(model, model.subscriptions ?? []).map((subs) => {
    const guarded = subs.filter((sub) => sub.triggerHasDomainGuard);
    const unguarded = subs.filter((sub) => !sub.triggerHasDomainGuard);
    const shared = subs.length > 1;
    return {
      group: 'dedupe',
      subject: subjectOf(subs),
      ...listenerLocation(subs),
      require: [
        // Llamar a la guarda sin mirar su respuesta no deduplica nada: el bool gobierna una rama.
        '(if|return|&&|\\|\\||!)[^;]*\\.(AlreadyProcessed|TryRecord)\\s*\\(|[A-Za-z][A-Za-z0-9]*\\s*,\\s*[A-Za-z_][A-Za-z0-9_]*\\s*:?=\\s*[^=]*\\.(AlreadyProcessed|TryRecord)\\s*\\(',
        ...(guarded.length > 0 ? ['\\.Record\\s*\\('] : []),
        ...(unguarded.length > 0 ? ['\\.TryRecord\\s*\\('] : [])
      ],
      forbid: [
        // El bool descartado con `_`: compila, y la reentrega se procesa otra vez.
        '_\\s*,\\s*[A-Za-z_][A-Za-z0-9_]*\\s*:?=\\s*[^=]*\\.(AlreadyProcessed|TryRecord)\\s*\\(',
        // El cruce caro, solo atribuible con un listener por evento: TryRecord en un handler reintentable marca como
        // procesado lo que falló; AlreadyProcessed+Record sin guarda de dominio deja la ventana.
        ...(shared ? [] : [guarded.length > 0 ? '\\.TryRecord\\s*\\(' : '\\.AlreadyProcessed\\s*\\(']),
        // Una clave inventada compila, pasa el camino feliz y deduplica cero.
        'uuid\\.New'
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
  if (!usesGoMessaging(model)) return [];
  const subscriptions = (model.subscriptions ?? []).filter((sub) => (sub.fields ?? []).some((field) => field.required));
  return bySource(model, subscriptions).map((subs) => ({
    group: 'payloadContract',
    subject: subjectOf(subs),
    ...listenerLocation(subs),
    require: ['\\.RequireContract\\s*\\('],
    forbid: [],
    why:
      `${subs.map((sub) => `'${sub.name}'`).join(', ')} declara${subs.length > 1 ? 'n' : ''} campos obligatorios: el listener llama a ` +
      'RequireContract() del mensaje DESPUÉS del filtro por el tipo — devolver su error antes mandaría al descarte un mensaje ajeno'
  }));
}

// 1c. Que la escritura de los registros sea un INSERT de verdad. Vigila archivos de build, y hace falta: no son
//     intocables (una corrida de keel-spring vio al agente editar un mapper generado).
function insertChecks(model) {
  const write = (group, file, table, why) => ({
    group,
    subject: `${file}: la escritura es un INSERT`,
    class: file,
    require: [`INSERT INTO ${table} `],
    forbid: ['ON CONFLICT', 'ON DUPLICATE KEY', 'INSERT IGNORE', 'REPLACE INTO', 'UPDATE[[:space:]]'],
    why
  });
  const checks = [];
  if (usesGoProcessedEvents(model)) {
    checks.push(write('dedupe', 'processed_events', 'processed_event', 'un INSERT y NO un upsert ni un UPDATE: con la fila reescrita, una reentrega nunca chocaría con la clave'));
  }
  if (usesRequestIdempotency(model) && registryOperations(model).length > 0) {
    checks.push(
      write('commandIdempotency', 'idempotency_store', 'idempotency_record', 'un INSERT y NO un upsert ni un UPDATE: es la clave primaria la que arbitra la carrera de dos peticiones con la misma clave')
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
      class: handlerFile(operation),
      require: ['idempotencyStore\\.(Find|Save)\\s*\\(', '\\.IdempotencySignature\\s*\\(', '\\.IdempotencyScope\\s*\\('],
      forbid: [
        // Una firma escrita a mano no es la canónica: otra réplica o otro despliegue firman distinto.
        'sha256|sha1|md5',
        // Con payload-hash o payload-field la clave sale del comando: no hay cabecera ni rama «sin clave».
        ...(['payload-hash', 'payload-field'].includes(source) ? ['IdempotencyKeyFrom'] : [])
      ],
      why:
        source === 'payload-hash'
          ? 'keySource: payload-hash — la clave es cmd.IdempotencySignature(), sin IdempotencyKeyFrom ni rama «sin clave»'
          : source === 'payload-field'
            ? `keySource: payload-field — la clave es cmd.${goExported(operation.idempotency.keyField)}, sin IdempotencyKeyFrom; la firma por cmd.IdempotencySignature() y el ámbito por cmd.IdempotencyScope()`
            : 'keySource: client-key — la clave llega por IdempotencyKeyFrom(ctx), la firma por cmd.IdempotencySignature() y el ámbito por cmd.IdempotencyScope()'
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
        class: handlerFile(operation),
        // FindBy<…><Campo><…>( — admite la variante normalizada del MISMO campo, no cualquier consulta.
        require: ['FindBy[A-Za-z]*' + finder.params.map((param) => goExported(param.name)).join('[A-Za-z]*And') + '[A-Za-z]*\\s*\\('],
        forbid: ['IdempotencyStore'],
        why:
          `keySource: payload-field con guarda en la clave natural (${operation.idempotency.naturalKey.join(', ')}) — la repetición se resuelve ` +
          `consultando por ${finder.params.map((param) => param.name).join(' + ')} (${finder.name}(...) o la variante normalizada) y actuando sobre ` +
          'lo que exista. Nunca con un almacén de claves'
      };
    })
    .filter(Boolean);
}

// 3. El raise(...) de cada evento publicado, en el AGREGADO que lo acumula (su <entidad>_behavior.go): sin él no hay
//    evento que entregar.
function domainEventChecks(model) {
  if (!usesGoMessaging(model)) return [];
  return (model.events ?? [])
    .flatMap((event) => (event.aggregates ?? []).map((aggregate) => ({ event, aggregate })))
    .map(({ event, aggregate }) => ({
      group: 'domainEvent',
      subject: (event.aggregates ?? []).length > 1 ? `${event.name} · ${aggregate}` : event.name,
      class: `${goFileName(aggregate)}_behavior`,
      require: ['\\.raise\\s*\\(\\s*New' + goExported(event.className) + '\\s*\\('],
      forbid: ['TODO.*' + event.name],
      why:
        `${event.name} lo publica el diseño, pero quien lo crea es el agregado: el método de negocio de ` +
        `${(event.emittedBy ?? []).filter((e) => e.aggregate === aggregate).map((e) => e.operation).join(', ') || 'la operación que lo declara'} ` +
        `hace raise(New${goExported(event.className)}(...)). Sin eso el outbox queda vacío y solo lo ve un escenario que espera el mensaje`
    }));
}

// 4. El barrido RECLAMA su lote. Con reclamo generado, el handler lo llama y no lee con un finder; sin él (lo que build
//    no puede generar), tiene que existir una escritura condicional sobre la entidad barrida.
function sweepClaimChecks(model) {
  const sweeps = allOperations(model).filter((operation) => operation.sweep && (operation.reconciles ?? []).length === 0);
  if (sweeps.length === 0) return [];
  // Sin escapes que awk no entienda: con `scope: method` estos patrones viajan también por awk.
  const CLAIM_WRITE = 'UPDATE[[:space:]]|[Cc]laim|[Rr]eclam';
  // Los bloques de BUILD que también escriben con condición y no reclaman nada: los reclamos generados para otros
  // barridos, el Save y el write<Entidad> (su UPDATE condicional es el del bloqueo optimista) y el puerto, que nombra la
  // entidad y los reclamos sin implementar ninguno. Sin ellos, el barrido que build no puede reclamar saldría VERDE sobre
  // el árbol recién generado (lo midió keel-nest).
  const generated = [
    ...sweeps.flatMap((operation) => (operation.claim ?? []).map((claim) => claimMethod(claim))),
    '[)] Save[(]',
    'func write[A-Z]',
    'interface[[:space:]]*[{]'
  ];
  return sweeps.map((operation) => {
    const claims = operation.claim ?? [];
    if (claims.length > 0) {
      return {
        group: 'sweepClaim',
        subject: operation.name,
        class: handlerFile(operation),
        require: [claims.map((claim) => '\\.?' + claimMethod(claim) + '\\s*\\(').join('|')],
        // Leer el estado de partida con un finder es EXACTAMENTE el fallo: la misma página en todas las réplicas.
        forbid: stateReadingFinder(model, claims.map((claim) => claim.entity)),
        why:
          `el barrido corre en TODAS las réplicas: RECLAMA su lote con ${claims.map((claim) => `${claimMethod(claim)}()`).join(' / ')}, ` +
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

// 3b. Compensación (tramo 11c): el handler no puede quedar a medias; si la vuelta al proveedor es una llamada, tiene que
//     hacerla; y el estado que el encargo movió vuelve a su sitio EN EL AGREGADO (su <entidad>_behavior.go).
function compensationChecks(model) {
  const checks = [];
  for (const operation of allOperations(model)) {
    if (!operation.compensates) continue;
    const leg = returnLegOf(model, operation);
    checks.push({
      group: 'compensation',
      subject: operation.name,
      class: handlerFile(operation),
      // Más estricto que nombrar el puerto (ya está en el struct que genera build): que se LLAME.
      require: leg?.kind === 'client' ? ['\\.' + leg.field + '\\.' + leg.method + '\\s*\\('] : [],
      forbid: ['TODO', 'ErrNotImplemented'],
      why:
        leg?.kind === 'client'
          ? `compensa ${operation.compensates.dependency}: además de devolver el estado propio avisa al proveedor con h.${leg.field}.${leg.method}(...)`
          : leg?.kind === 'event'
            ? `compensa ${operation.compensates.dependency}: la vuelta va por el evento ${leg.event.name}, que emite el AGREGADO (familia domainEvent); aquí, que el handler no quede a medias`
            : `compensa ${operation.compensates.dependency}: el diseño no declara activación de vuelta, así que solo devuelve el estado propio`
    });
    const moved = new Set(operation.compensates.moves ?? []);
    for (const transition of operation.transitions ?? []) {
      if (!moved.has(transition.entity)) continue;
      const entity = (model.entities ?? []).find((candidate) => candidate.name === transition.entity);
      if (!entity?.lifecycle) continue;
      const constant = enumConstant(entity.lifecycle.enumType, transition.to);
      checks.push({
        group: 'compensation',
        subject: `${operation.name} · estado de ${transition.entity}`,
        class: `${goFileName(transition.entity)}_behavior`,
        require: ['transitionTo\\s*\\(\\s*' + constant + '\\s*\\)'],
        forbid: [],
        why:
          `el encargo que deshace movió el lifecycle de ${transition.entity}: devolverlo a ${transition.to} es parte de la compensación, ` +
          `y lo hace el método semántico del agregado con transitionTo(${constant})`
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
    const call = client?.calls.find((candidate) => candidate.name === called.http.call);
    return { kind: 'client', field: client ? clientParam(client) : called.http.clientClass, method: call ? callMethod(call) : goExported(called.http.call) };
  }
  const published = activations.find((activation) => activation.event?.name);
  return published ? { kind: 'event', event: published.event } : null;
}

// 4b. Reconciliación (tramo 11c). La pata del silencio, y la que ningún escenario FL-* ejercita entera: un cron no se
//     alcanza desde fuera. Las mismas reglas que los otros tres, con lo que en Go es cada pieza.
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
      generated.push(goExported(claim.method));
      checks.push({
        group: 'reconciliation',
        subject: `${operation.name} · reclamo de ${dependency}.${activation.name}`,
        class: handlerFile(operation),
        require: ['\\.?' + goExported(claim.method) + '\\s*\\('],
        // La lectura por estado es EXACTAMENTE el patrón que el reclamo evita.
        forbid: stateReadingFinder(model, [claim.entity]),
        why:
          `el barrido corre en TODAS las réplicas: toma su lote con ${goExported(claim.method)}(), que build generó en domain.${claim.entity}Repository ` +
          '—una marca persistida que caduca, y solo lo que esta réplica se llevó—, no con un finder ni con un reclamo aparte'
      });
    }
  }
  for (const operation of allOperations(model).filter((candidate) => (candidate.reconciles ?? []).length > 0)) {
    checks.push({
      group: 'reconciliation',
      subject: operation.name,
      class: handlerFile(operation),
      // Y sin tragarse los errores: descartar con `_` el error de una llamada al repositorio o al proveedor no distingue
      // la carrera con el camino feliz de un fallo propio (el `catch` sin tipo de los otros tres). Lo destapó la corrida
      // stock-reservation de keel-nest (2026-10-08).
      forbid: ['TODO', 'ErrNotImplemented', '_[[:space:]]*(,[[:space:]]*_[[:space:]]*)?=[[:space:]]*h[.][A-Za-z]+[.][A-Za-z]+[(]'],
      require: [],
      why: `barre ${operation.reconciles.map((r) => `${r.dependency}.${r.activation.name}`).join(', ')}: el barrido tiene que estar escrito, no dejado en un stub, y sin descartar errores con _ — la carrera con el camino feliz se reconoce con errors.Is y se devuelve lo demás`
    });
  }
  if (pending.length > 0) {
    // Los archivos que build genera con el patrón: encontrarlos probaría lo que build hizo.
    const exclude = '/(reconciliation|claims|sweep|outbox|processed_events|idempotency_store|purges)[.]go';
    const deny = [...generated, '[)] Save[(]', 'func write[A-Z]', 'interface[[:space:]]*[{]'].join('|');
    checks.push(
      {
        group: 'reconciliation',
        subject: 'reclamo del barrido',
        // Sin escapes que awk no entienda: con `scope: method` estos patrones viajan también por awk.
        claim: 'UPDATE[[:space:]]|claimReconciliation[(]|reconciliation_claim',
        scope: 'method',
        deny,
        bound: '[Cc]laim|[Rr]eclam',
        exclude,
        why:
          'ninguna escritura reclama candidatos con una MARCA PERSISTIDA (claimReconciliation sobre reconciliation_claim, o un UPDATE condicional): ' +
          'el barrido corre en TODAS las réplicas, y un lock solo aísla mientras dura su transacción, con la llamada al proveedor en medio'
      },
      {
        group: 'reconciliation',
        subject: 'lote del barrido',
        claim: 'BatchSize|LIMIT',
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
        claim: 'UnansweredAfter',
        bound: activation.name,
        exclude: '/reconciliation[.]go',
        why:
          `el umbral de espera de ${dependency}.${activation.name} no se lee en ninguna parte: build lo dejó en ` +
          `ReconciliationSettings.Windows["${activation.name}"] (reconciliation.${kebabCase(activation.name)}.unanswered-after-seconds), y el de OTRO barrido no vale`
      });
    }
  }
  // El disparador. En Go build lo escribe entero (un mensaje con campos lo rechaza la frontera), pero el sujeto es el
  // mismo que en los otros tres: que la tarea despache el mensaje del barrido.
  for (const service of model.services ?? []) {
    const operations = (service.operations ?? []).filter((operation) => (operation.reconciles ?? []).length > 0);
    if (operations.length === 0) continue;
    const owner = service.className.replace(/Service$/, '');
    checks.push({
      group: 'reconciliation',
      subject: `${owner}Scheduler`,
      class: goFileName(`${owner}Tasks`),
      require: [operations.map((operation) => goExported(operation.messageClass ?? `${operation.name}Command`)).join('|')],
      forbid: ['TODO'],
      why: `el disparador de ${operations.map((operation) => operation.name).join(', ')}: la tarea del reloj despacha su mensaje`
    });
  }
  return checks;
}

// 4c. La clave de idempotencia SALIENTE (tramo 11b): build la deja cableada en el intento de la llamada; si alguien la
//     quita, el retry le encarga al proveedor el mismo trabajo otra vez, y eso no falla: duplica.
function outboundIdempotencyChecks(model) {
  if (!usesGoHttpClients(model)) return [];
  return (model.httpClients ?? []).flatMap((client) =>
    (client.calls ?? [])
      .filter((call) => call.idempotency)
      .map((call) => {
        const factory = call.idempotency.keyFrom === 'correlation' ? 'correlatedKey\\(ctx, ' : 'outboundKey\\(';
        return {
          group: 'outboundIdempotency',
          subject: `${client.id}.${call.name}`,
          class: `${goFileName(client.id)}_adapter`,
          // Por LLAMADA: el nombre de la llamada va como argumento de la factoría.
          require: [factory + '"' + call.name + '"'],
          forbid: [],
          why:
            `la llamada declara idempotency.keyFrom: ${call.idempotency.keyFrom}: la cabecera ${call.idempotency.header} viaja con una clave ESTABLE ` +
            `entre reintentos — ${factory.replace(/\\/g, '')}"${call.name}", …), que build dejó en el intento de ${callMethod(call)}`
        };
      })
  );
}

// 5. La entrega del outbox: el respaldo del dispatcher no deja arrancar fuera de local/test, pero en local marca
//    publicadas filas que nunca salieron. Que el agente haya puesto el suyo en brokerAdapters (cmd/server/broker.go).
function outboxChecks(model) {
  if (!usesGoOutbox(model)) return [];
  return [
    {
      group: 'outboxDelivery',
      subject: 'OutboxDispatcher',
      class: 'broker',
      require: ['Dispatcher[[:space:]]*:[[:space:]]*[^[:space:]]|[.]Dispatcher[[:space:]]*=[^=]'],
      forbid: ['Dispatcher[[:space:]]*(:|=)[[:space:]]*nil([^A-Za-z0-9_]|$)'],
      why: 'con reliability: outbox el diseño prometió que ningún evento se pierde; con solo el respaldo de build no sale ninguno'
    }
  ];
}

// 6. El RELEVO en un índice único condicionado (el mismo sujeto que los otros tres). La operación saca una fila del
//    estado del índice y mete otra en el mismo acto, y el índice se comprueba por FILA: la que lo ocupaba se retira y se
//    GUARDA antes de guardar la nueva. Lo afirmable es que el handler busque la ocupante con el finder que build generó.
function conditionalUniquenessChecks(model) {
  return relievingOperations(model).map(({ operation, entity, state }) => {
    const root = (model.entities ?? []).find((candidate) => candidate.name === entity.rootEntity) ?? entity;
    const finder = occupantFinders(model, root).find((candidate) => candidate.state === state);
    return {
      group: 'conditionalUniqueness',
      subject: `${operation.name} (${entity.name}.${state})`,
      class: handlerFile(operation),
      require: [finder ? '[.]?' + finder.name + '[ ]*[(]' : 'Save[ ]*[(]'],
      forbid: ['ErrNotImplemented'],
      why:
        `releva sobre el índice único condicionado de ${entity.name}.${state}: retira la fila que lo ocupaba${finder ? ` (búscala con ${finder.name}(...))` : ''} ` +
        'y GUÁRDALA antes de guardar la nueva. El índice se comprueba por FILA y no se puede diferir: al revés, la transición ' +
        'legítima muere con el error de unicidad del diseño, un 409 en el camino feliz'
    };
  });
}
