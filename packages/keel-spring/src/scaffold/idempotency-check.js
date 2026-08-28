// El tramo que no estaba garantizado por construcción.
//
// De los cinco mecanismos de repetición y compensación, `build` genera tres enteros
// (`idempotency_record` con su store, `processed_event` con su guard, la
// `OutboundIdempotency` ya cableada) y deja el USO de los dos primeros al agente de
// código: el listener que llama al guard, el handler que consulta el store. Los otros
// dos —compensación y reconciliación— no generan ninguna clase: son lógica de negocio
// y salen enteros de la mano del agente.
//
// Ese tramo falla en silencio. Un listener sin guard, un handler que ignora el store, un
// `@Scheduled` que sigue lanzando: todo compila, todo arranca, y el camino feliz pasa en
// verde. Solo se nota en la primera repetición — que es justo cuando algo ya iba mal.
//
// Hasta ahora la red era prosa que leía un LLM (la sección homónima de
// `keel-spring-quality.md`). Este script la convierte en un gate determinista: `build`
// sabe qué listener toca qué orden, qué handler tiene qué `keySource` y qué operación
// barre qué activación, así que la matriz de expectativas se precomputa aquí y el script
// solo la contrasta contra el árbol final.
//
// Alcance deliberado: son comprobaciones ESTRUCTURALES, no análisis semántico. Cazan la
// ausencia (no se llama al guard) y el cruce (se llama en el orden que pierde mensajes),
// que es donde esto falla de verdad. Si el algoritmo del barrido es el correcto sigue
// siendo juicio, y ese lo pone el agente de calidad — que ahora ejecuta esto en vez de
// leer el árbol a mano.

import { declaresIdempotency, idempotentOperations, naturalKeyGuardedOperations } from './http-idempotency.js';
import { naturalKeyFinder } from './repositories.js';
import { usesOutbox } from './outbox.js';

/**
 * ¿Hay algo de esta familia que comprobar? Sin suscripciones, sin idempotencia HTTP, sin
 * outbox y sin compensaciones ni reconciliaciones no hay tramo que vigilar y el script no
 * se genera: un gate que siempre sale verde no distingue «correcto» de «no mira».
 */
export function usesIdempotencyCheck(model) {
  return checksOf(model).length > 0;
}

export function generate(model) {
  const checks = checksOf(model);
  if (checks.length === 0) return [];
  return [{ path: 'infra/check-idempotency.sh', content: script(model, checks) }];
}

// ─── La matriz de expectativas ───────────────────────────────────────────────
//
// Cada entrada es { group, subject, class, require[], forbid[], why }. `class` es el
// nombre simple del archivo Java: el script lo localiza con `find`, no con una ruta
// hardcodeada, porque el agente escribe algunos de esos archivos y la ruta exacta es
// suya. `require`/`forbid` son expresiones regulares extendidas (grep -E).

function checksOf(model) {
  return [
    ...dedupeChecks(model),
    ...payloadContractChecks(model),
    ...insertChecks(model),
    ...commandChecks(model),
    ...naturalKeyChecks(model),
    ...compensationChecks(model),
    ...domainEventChecks(model),
    ...reconciliationChecks(model),
    ...sweepClaimChecks(model),
    ...outboxChecks(model),
    ...mailChecks(model)
  ];
}

/**
 * El reclamo de un barrido que NO está declarado como `reconciledBy`.
 *
 * La familia `reconciliation` ya cubre los que sí: los que reconcilian un desenlace de
 * una activación. Pero un barrido que despacha una cola —el que manda el correo, el que
 * reintenta— normalmente no está enlazado a ninguna activación, y quedaba sin nota y sin
 * gate. Es el mismo riesgo con menos ceremonia: `@Scheduled` corre en todas las réplicas,
 * y un finder normal se lleva las mismas filas en todas.
 *
 * Lo afirmable en estático es la forma del acceso, no si el algoritmo es correcto. Y
 * DÓNDE es afirmable depende de si build pudo generar el reclamo:
 *
 * - **Con reclamo generado** (el barrido saca filas de una COLA, un estado al que no llega
 *   ninguna transición) la exigencia es exacta y local: que el handler llame al método que
 *   build puso en el puerto, y que no se lleve el lote con un finder.
 * - **Sin él** —el barrido solo rescata filas EN VUELO, y build dijo en voz alta que no
 *   genera ese reclamo porque la cota temporal vive en la prosa de `rules`— no se puede
 *   exigir una forma que el propio generador no supo escribir, ni suponer que el reclamo
 *   vive en ESE archivo: cuando el diseño delega el trabajo por elemento en otra operación
 *   («el ciclo invoca sendQueuedMessage con su identificador»), el reclamo atómico vive en
 *   el handler de la otra, y es correcto que viva ahí. Se busca en todo el árbol, atado al
 *   agregado que se barre.
 *
 * La lección es la (a) de las corridas y ya costó una vez en otra familia: un check que
 * exige la implementación incorrecta es peor que no tenerlo, porque su camino de menor
 * resistencia es romper el código para callarlo.
 */
function sweepClaimChecks(model) {
  const sweeps = (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .filter((operation) => operation.sweep && (operation.reconciles ?? []).length === 0);
  if (sweeps.length === 0) return [];

  const CLAIM_WRITE = String.raw`@Modifying|@Query\s*\(\s*"\s*update|findAndModify|findOneAndUpdate|[Cc]laim|[Rr]eclam`;

  return sweeps.map((operation) => {
    const claims = operation.claim ?? [];
    if (claims.length > 0) {
      return {
        group: 'sweepClaim',
        subject: operation.name,
        class: operation.handlerClass,
        require: [claims.map((claim) => String.raw`\.?` + claim.method + String.raw`\s*\(`).join('|')],
        // La lectura simple del estado de partida es EXACTAMENTE el patrón que produjo el
        // fallo: findByStatusOrderBy…(QUEUED, PageRequest…) devuelve la misma página en
        // todas las réplicas. Un finder derivado en el handler de un barrido que TIENE su
        // reclamo generado no tiene ningún uso legítimo que el reclamo no cubra mejor.
        forbid: [String.raw`\.find(All)?By[A-Za-z]*\s*\(`],
        why:
          `el barrido corre en TODAS las réplicas: tiene que RECLAMAR su lote llamando a ` +
          `${claims.map((claim) => `${claim.method}()`).join(' / ')}, que build generó en el puerto, ` +
          `no leerlo con un finder — entre la lectura y la marca las N réplicas ya se llevaron las mismas filas`
      };
    }
    // El agregado que se barre: es lo que ata el reclamo encontrado a ESTE barrido y no a
    // cualquier escritura condicional del proyecto.
    const entities = [...new Set((operation.transitions ?? []).map((transition) => transition.entity))];
    return {
      group: 'sweepClaim',
      subject: operation.name,
      claim: CLAIM_WRITE,
      bound: entities.join('|'),
      exclude: '(^$)',
      why:
        `el barrido corre en TODAS las réplicas, así que el trabajo que toma tiene que RECLAMARSE con una ` +
        `escritura condicional sobre ${entities.join(', ')} —no leerse con un finder—, y no aparece ninguna en el ` +
        `proyecto. build NO pudo generarla y su aviso dice por qué (un rescate de un estado EN VUELO necesita el ` +
        `campo que dice CUÁNDO se entró en él, y sobre dos estados a la vez no hay un solo reloj que medir), así ` +
        `que la escribes tú CON SU COTA TEMPORAL: puede estar en ${operation.handlerClass} o en el handler de la ` +
        `operación a la que el diseño le delega el trabajo por elemento, pero tiene que existir`
    };
  });
}

// 1. Consumo de mensajes. Las dos mitades —llamar al guard y ACTUAR sobre lo que
//    responde— más el orden, que no es intercambiable ni es cosa del agente: lo
//    prescribe el javadoc del <Evento>Message y lo decide `triggerHasDomainGuard`.
/**
 * ¿Comparten cola las suscripciones que leen del mismo destino?
 *
 * Solo en RabbitMQ. Ahí varios `@RabbitListener` sobre la misma cola son consumidores
 * COMPITIENDO: el broker reparte, cada mensaje llega a uno solo y los otros no lo ven
 * nunca — así que la forma correcta es un único listener que enruta por `eventType`. En
 * Kafka cada listener tiene su propio grupo y recibe el topic entero, y en SNS/SQS cada
 * suscripción tiene cola propia colgada del topic: en los dos, un listener por evento es
 * lo correcto. La diferencia no es de estilo, y decide qué puede afirmar este gate.
 */
function sharesQueue(model) {
  return model.stack?.broker === 'rabbitmq';
}

// 1b. Contrato del payload entrante. Es la otra mitad de «no te fíes de lo que llega
//     por el broker»: `dedupe` vigila que el mensaje no se procese dos veces, y esto
//     que lo que se procese traiga lo que el diseño prometió.
//
//     Existe como check y no como constructor compacto del record por una razón
//     concreta: en un listener, lanzar manda el mensaje al descarte, y un canal
//     compartido trae mensajes AJENOS que hay que descartar sin lanzar. Por eso la
//     guarda es un método (`requireContract()`) que se llama DESPUÉS de enrutar por
//     `eventType` — y por eso hace falta comprobar que alguien lo llama: un método que
//     nadie invoca no comprueba nada, y el camino de menor resistencia es no llamarlo.
function payloadContractChecks(model) {
  if (!model.layersPresent.messaging) return [];
  // Solo las que tienen algo que exigir: sin campos `required` el record no lleva
  // `requireContract()`, y pedir su llamada sería exigir lo imposible.
  const subscriptions = (model.subscriptions ?? []).filter((sub) =>
    (sub.fields ?? []).some((field) => field.required)
  );
  if (subscriptions.length === 0) return [];

  // Mismo agrupado que `dedupe`, y por lo mismo: con RabbitMQ varias suscripciones
  // comparten UN listener, así que un check por evento no sería atribuible.
  if (sharesQueue(model)) {
    const byDestination = new Map();
    for (const sub of subscriptions) {
      const destination = sub.topicDefault;
      if (!byDestination.has(destination)) byDestination.set(destination, []);
      byDestination.get(destination).push(sub);
    }
    return [...byDestination.entries()].map(([destination, subs]) =>
      // Una sola suscripción en su cola no es un listener compartido, aunque el broker
      // sea RabbitMQ: ahí no hay ramas de las que hablar. Mismo reparto que `dedupe`.
      subs.length > 1 ? sharedContractCheck(destination, subs) : singleContractCheck(subs[0])
    );
  }

  return subscriptions.map(singleContractCheck);
}

function singleContractCheck(sub) {
  const required = (sub.fields ?? []).filter((field) => field.required).map((field) => field.name);
  return {
    group: 'payloadContract',
    subject: sub.name,
    class: sub.listenerClass,
    require: ['\\.requireContract\\s*\\('],
    forbid: [],
    why:
      `'${sub.name}' declara campos obligatorios (${required.join(', ')}): el payload los trae o el mensaje incumple ` +
      `el contrato. La llamada va DESPUÉS del filtro por eventType — lanzar antes mandaría al descarte un mensaje ajeno`
  };
}

function sharedContractCheck(destination, subs) {
  return {
    group: 'payloadContract',
    subject: `${destination} (${subs.map((sub) => sub.name).join(', ')})`,
    class: subs[0].listenerClass,
    locate: subs.map((sub) => sub.messageRecord).join('|'),
    // El confirmador: el host alternativo legítimo es el que usa el guard.
    confirm: 'IdempotencyGuard',
    require: ['\\.requireContract\\s*\\('],
    forbid: [],
    why:
      `el listener de '${destination}' tiene que llamar a requireContract() del payload DESPUÉS de enrutar por eventType, ` +
      `para ${subs.map((sub) => sub.name).join(', ')}. Lo que este check NO puede distinguir es si lo llama en TODAS las ` +
      `ramas o solo en una: ve la llamada, no a cuántos eventos cubre`
  };
}

function dedupeChecks(model) {
  if (!model.layersPresent.messaging || !model.layersPresent.persistence) return [];
  const subscriptions = model.subscriptions ?? [];

  // Agrupadas por destino físico cuando el broker las hace compartir cola: ahí el
  // listener es uno y las comprobaciones por evento dejan de ser atribuibles.
  if (sharesQueue(model)) {
    const byDestination = new Map();
    for (const sub of subscriptions) {
      const destination = sub.topicDefault;
      if (!byDestination.has(destination)) byDestination.set(destination, []);
      byDestination.get(destination).push(sub);
    }
    return [...byDestination.entries()].flatMap(([destination, subs]) =>
      subs.length > 1 ? [sharedListenerCheck(destination, subs)] : [listenerCheck(subs[0])]
    );
  }

  return subscriptions.map(listenerCheck);
}

/**
 * Varias suscripciones, una cola, un listener: lo que el gate puede seguir afirmando.
 *
 * Se comprueba que el guard esté y que aparezcan los ÓRDENES que el diseño exige —
 * `record` si alguna suscripción tiene guarda de dominio, `tryRecord` si alguna no la
 * tiene—, pero no se prohíbe el contrario: en un archivo con las dos ramas, el cruce no
 * es atribuible a un evento concreto por presencia. Se pierde precisión y se dice; lo que
 * no se puede hacer es dar KO a la única implementación correcta, que es lo que hacía
 * antes — y el camino de menor resistencia para apagar ese KO es partir el listener en
 * uno por evento, o sea romper el consumo.
 */
function sharedListenerCheck(destination, subs) {
  const guarded = subs.filter((sub) => sub.triggerHasDomainGuard);
  const unguarded = subs.filter((sub) => !sub.triggerHasDomainGuard);
  return {
    group: 'dedupe',
    subject: `${destination} (${subs.map((sub) => sub.name).join(', ')})`,
    // El nombre canónico si el agente lo usó; si no, el archivo se busca por contenido.
    class: subs[0].listenerClass,
    locate: subs.map((sub) => sub.messageRecord).join('|'),
    // El confirmador: el host alternativo legítimo es el que usa el guard.
    confirm: 'IdempotencyGuard',
    require: [
      'IdempotencyGuard',
      `(if|return|while|&&|\\|\\||!)[^;]*\\.?(alreadyProcessed|tryRecord)\\s*\\(`,
      ...(guarded.length > 0 ? ['\\.record\\s*\\('] : []),
      ...(unguarded.length > 0 ? ['\\.tryRecord\\s*\\('] : [])
    ],
    forbid: ['UUID\\.randomUUID\\(\\)'],
    why:
      `las ${subs.length} suscripciones leen de la cola '${destination}': en RabbitMQ eso es UN listener que enruta por eventType ` +
      `(varios serían consumidores compitiendo y cada mensaje llegaría a uno solo). Tienen que estar los dos órdenes que el diseño pide — ` +
      (guarded.length > 0 ? `record(...) tras despachar para ${guarded.map((s) => s.name).join(', ')}` : '') +
      (guarded.length > 0 && unguarded.length > 0 ? ' y ' : '') +
      (unguarded.length > 0 ? `tryRecord(...) antes de despachar para ${unguarded.map((s) => s.name).join(', ')}` : '') +
      ' — y cuál va con cuál lo dice el javadoc de cada <Evento>Message'
  };
}

function listenerCheck(sub) {
  {
    const guarded = sub.triggerHasDomainGuard;
    return {
      group: 'dedupe',
      subject: sub.name,
      class: sub.listenerClass,
      require: [
        'IdempotencyGuard',
        // Referenciar el guard sin mirar su respuesta no deduplica nada: el retorno
        // tiene que gobernar una rama o salir por un return.
        `(if|return|while|&&|\\|\\||!)[^;]*\\.?(alreadyProcessed|tryRecord)\\s*\\(`,
        guarded ? '\\.record\\s*\\(' : '\\.tryRecord\\s*\\('
      ],
      forbid: [
        // El cruce caro. `tryRecord` en un handler reintentable marca como procesado
        // un mensaje que falló y lo pierde; `alreadyProcessed`+`record` sin guarda de
        // dominio deja abierta la ventana entera entre las dos llamadas.
        guarded ? '\\.tryRecord\\s*\\(' : '\\.alreadyProcessed\\s*\\(',
        // Una clave inventada compila, pasa el camino feliz y deduplica cero.
        'UUID\\.randomUUID\\(\\)'
      ],
      why: guarded
        ? `'${sub.trigger}' tiene guarda de dominio (${sub.triggerGuardKind === 'natural-key' ? 'su clave de idempotencia participa en la clave natural del agregado' : 'declara transitions'}): alreadyProcessed(...) antes y record(...) DESPUÉS de despachar bien`
        : `'${sub.trigger}' no tiene guarda de dominio (ni transitions, ni clave de idempotencia sobre la clave natural): tryRecord(...) antes de despachar, que es lo único que cierra la ventana`
    };
  }
}

// 1b. Que la escritura del registro sea un INSERT DE VERDAD.
//
// Las otras familias vigilan el trabajo del AGENTE, porque es el tramo que no está
// garantizado por construcción. Esta vigila el de `build`, y hace falta por una razón
// que una corrida demostró: los archivos build-owned NO son intocables. En la corrida
// del fallback, el agente de código editó `ComplianceMapper.java`, que genera `build`.
// «build lo generó bien» y «está bien en el árbol donde corre el gate» son cosas
// distintas, y esta familia mide la segunda.
//
// El motivo de fondo es peor. La familia `dedupe` de arriba comprueba el ORDEN y el USO
// del guard —que era correcto— y salió `OK` con la deduplicación COMPLETAMENTE ROTA:
// `saveAndFlush` sobre una entidad de clave asignada sin `Persistable` hace que Spring
// Data concluya que la fila ya existe y ejecute un `merge()` —SELECT + UPDATE— que no
// viola la clave primaria y no lanza nada. `record()` y `tryRecord()` devolvían `true`
// siempre. Un gate que aprueba eso no distingue «deduplica» de «llama a quien debe».
//
// Tres piezas, y ninguna sobra (las tres salieron de defectos reales):
//   - `Persistable` en la entidad, para que sea INSERT y no merge.
//   - `isNew()` NO constante: un flag que `@PostLoad` pone a true. Con `true` fijo,
//     `SimpleJpaRepository.delete()` —que empieza con `if (isNew(entity)) return;`—
//     se convierte en un no-op silencioso y la retirada de la clave caducada no borra
//     nada. Arreglar el INSERT desactivó el DELETE, y nada lo delataba.
//   - `saveAndFlush` del REPOSITORIO, no `entityManager.persist`: la traducción de
//     excepciones de Spring solo actúa al salir de un método proxeado, y el proxy del
//     EntityManager no traduce. Sin ella sale un `ConstraintViolationException` crudo
//     que ningún `catch` de `DataIntegrityViolationException` reconoce, y el catch-all
//     lo convierte en 500 — el desenlace que los escenarios de carrera prohíben.
//
// En la rama documental el reparto es otro: `insert()` ya fuerza la inserción y
// `DuplicateKeyException` ya es una `DataIntegrityViolationException`, así que lo único
// que hay que impedir es que alguien lo cambie por `save()`, que hace upsert y nunca
// choca.
function insertChecks(model) {
  const document = model.persistenceKind === 'document';
  const checks = [];

  const writeCheck = (group, writerClass, why) => ({
    group,
    subject: `${writerClass}: la escritura es un INSERT`,
    class: writerClass,
    require: [document ? '\\.insert\\s*\\(' : '\\.saveAndFlush\\s*\\('],
    forbid: document
      ? // `save()` hace upsert: sobrescribe el registro y no choca nunca.
        ['\\.save\\s*\\(']
      : // `persist` a mano deja la excepción sin traducir y acaba en 500.
        ['entityManager\\.persist\\s*\\(', 'getEntityManager\\(\\)'],
    why
  });

  const entityCheck = (group, entityClass, why) => ({
    group,
    subject: `${entityClass}: la clave asignada fuerza INSERT y sigue siendo borrable`,
    class: entityClass,
    require: [
      'implements\\s+Persistable',
      // El marcador que pone el flag. `\b` al final para que un `@PostLoadLoQueSea`
      // no lo satisfaga por prefijo.
      '@PostLoad\\b',
      // Y que `isNew()` CONSULTE el flag en vez de devolver una constante. Se exige
      // la forma —el retorno negado de un campo— y no se prohíbe `return true`,
      // porque `equals()` lleva uno legítimo y prohibirlo daría un KO falso.
      //
      // Tiene que ser un patrón de UNA LÍNEA: el script usa `grep -E`, que es línea
      // a línea, así que un patrón que cruce el `{` de la firma y su `return` no
      // dispara nunca. Ese error deja el check en verde permanente, que es peor que
      // no tenerlo — se comprobó reintroduciendo el defecto y viendo si salta.
      'return\\s+![A-Za-z_]'
    ],
    why
  });

  if (model.layersPresent.messaging && model.layersPresent.persistence && (model.subscriptions ?? []).length > 0) {
    checks.push(
      writeCheck(
        'dedupe',
        'ProcessedEventWriter',
        document
          ? 'insert() y NO save(): save hace upsert y una reentrega nunca chocaría'
          : 'saveAndFlush del repositorio: su proxy traduce la violación de clave; entityManager.persist la deja cruda y acaba en 500'
      )
    );
    if (!document) {
      checks.push(
        entityCheck(
          'dedupe',
          'ProcessedEventJpa',
          'Persistable con isNew() por @PostLoad: sin él la clave asignada hace merge() y no deduplica; con `true` constante, delete() es un no-op'
        )
      );
    }
  }

  if (declaresIdempotency(model) && model.layersPresent.persistence && !document) {
    checks.push(
      entityCheck(
        'commandIdempotency',
        'IdempotencyRecordJpa',
        'Persistable con isNew() por @PostLoad: es lo que hace que la carrera de la clave la arbitre la base, y lo que permite retirar la clave caducada'
      )
    );
  }

  return checks;
}

// 2. Idempotencia de petición. El mecanismo está generado entero: lo que se comprueba
//    es que el handler lo USE, y que no se haya escrito otro al lado.
function commandChecks(model) {
  if (!declaresIdempotency(model) || !model.layersPresent.persistence) return [];
  return idempotentOperations(model).map((operation) => ({
    group: 'commandIdempotency',
    subject: operation.name,
    class: operation.handlerClass,
    require: ['IdempotencyStore', 'CommandSignature\\.of\\s*\\('],
    forbid: [
      // Una firma escrita a mano se compara contra firmas guardadas en otro
      // despliegue, y hashCode() ni siquiera es estable entre arranques.
      '\\.hashCode\\(\\)',
      // Con payload-hash la clave ES la firma: no hay cabecera, no hay contexto y no
      // hay caso «sin clave». Ese `if` es el defecto que hace que no deduplique nunca.
      ...(operation.idempotency.keySource === 'payload-hash' ? ['IdempotencyContext'] : [])
    ],
    why:
      operation.idempotency.keySource === 'payload-hash'
        ? 'keySource: payload-hash — la clave es CommandSignature.of(command), sin IdempotencyContext ni rama «sin clave»'
        : 'keySource: client-key — la clave llega por IdempotencyContext.get() y la firma por CommandSignature.of(command)'
  }));
}

// 2.b Idempotencia guardada por la CLAVE NATURAL. Aquí build no genera ningún mecanismo —la
//     constraint del agregado ya es la guarda—, así que exigir `IdempotencyStore` sería pedir una
//     clase que no existe: el camino de menor resistencia para callar ese check sería escribir un
//     registro paralelo, que es exactamente lo que no queremos. Lo afirmable es lo otro: que el
//     handler BUSQUE por la clave natural antes de insertar, porque el contrato de la idempotencia
//     no es rechazar la repetición sino devolver la respuesta original. Sin esa búsqueda el
//     servidor contesta un 409 donde prometía el recurso, y eso solo lo delata un escenario.
function naturalKeyChecks(model) {
  return naturalKeyGuardedOperations(model)
    .map((operation) => {
      const entity = (model.entities ?? []).find((candidate) => candidate.name === operation.idempotency.entity);
      const finder = entity ? naturalKeyFinder(model, entity) : null;
      if (!finder) return null;
      return {
        group: 'commandIdempotency',
        subject: operation.name,
        class: operation.handlerClass,
        require: [`${finder.name}\\s*\\(`],
        forbid: [
          // Un registro paralelo al que la constraint ya cubre: dos verdades sobre lo mismo, y la
          // del almacén además caduca.
          'IdempotencyStore'
        ],
        why:
          `keySource: payload-field con guarda en la clave natural (${operation.idempotency.naturalKey.join(', ')}) — ` +
          `la repetición se resuelve buscando con ${finder.name}(...) y devolviendo el recurso existente, no con un almacén`
      };
    })
    .filter(Boolean);
}

// Las operaciones cuelgan de su servicio (un agregado, un servicio de aplicación), no
// del modelo: aplanarlas aquí evita repetir el doble bucle en cada familia.
const allOperations = (model) => (model.services ?? []).flatMap((service) => service.operations ?? []);

// 3. Compensación. No hay clase que comprobar porque build no genera ninguna: lo que se
//    comprueba es que el handler que la ejecuta esté escrito y llegue al proveedor.
/**
 * El `raise(...)` de cada evento publicado, que vive en el AGREGADO.
 *
 * Es el hueco que llevó cinco corridas anotado como «el gate de compensación no ve una
 * activación publicada», y resultó ser más ancho de lo que decía esa nota: no es solo de la
 * compensación, es de CUALQUIER evento que el diseño publique.
 *
 * `build` genera el buffer de eventos del agregado y deja un TODO por evento
 * (scaffold/entities.js § renderDomainEvents) para que el agente escriba el `raise` en el
 * método de negocio que provoca el cambio. Ese TODO está en el agregado; el `forbid` de la
 * familia `compensation` mira el HANDLER, que es otra clase. Así que un handler impecable
 * con el `raise` olvidado sale VERDE, y el evento no existe: el outbox no tiene qué
 * entregar, ninguna suscripción recibe nada, y el único síntoma es un escenario que espera
 * un mensaje que nunca sale.
 *
 * Lo afirmable es exacto porque todo lo pone build: el nombre de la clase del evento, el
 * agregado que lo acumula y el texto del TODO. No se supone dónde va el `raise` —solo que
 * esté—, que es la misma regla que el resto de familias.
 */
function domainEventChecks(model) {
  return (model.events ?? [])
    .filter((event) => event.aggregate)
    .map((event) => ({
      group: 'domainEvent',
      subject: event.name,
      class: event.aggregate,
      require: [String.raw`raise\s*\(\s*` + event.className + String.raw`\.of\s*\(`],
      // El TODO que build dejó con el nombre de ESTE evento: si sigue ahí, nadie lo escribió.
      // Sin salto de línea en la clase de caracteres: el patrón viaja dentro de una cadena de
      // bash y ahí parte el comando. grep ya es línea a línea, así que el punto basta.
      forbid: [String.raw`TODO.*` + event.name],
      why:
        `${event.name} lo publica el diseño, pero quien lo crea es el agregado: el método de negocio de ` +
        `${(event.emittedBy ?? []).map((e) => e.operation).join(', ') || 'la operación que lo declara'} tiene que hacer ` +
        `raise(${event.className}.of(...)). Sin eso no hay evento que entregar — el handler puede estar perfecto y ` +
        `el outbox queda vacío, que es un fallo que solo se ve desde un escenario que espera el mensaje`
    }));
}

function compensationChecks(model) {
  const checks = [];
  for (const operation of allOperations(model)) {
    if (!operation.compensates) continue;
    const client = returnClientOf(model, operation);
    checks.push({
      group: 'compensation',
      subject: operation.name,
      class: operation.handlerClass,
      require: client ? [client] : [],
      // Deshacer a medias es peor que no deshacer: deja el proveedor y el estado
      // propio contando historias distintas. Un solo patrón, no dos: el stub de build
      // trae las dos marcas a la vez y separarlas contaría dos veces el mismo hecho.
      forbid: ['TODO|UnsupportedOperationException'],
      why: client
        ? `compensa ${operation.compensates.dependency}: además de devolver el estado propio tiene que avisar al proveedor por ${client}, que se le inyecta para eso`
        : `compensa ${operation.compensates.dependency}: el diseño no declara activación de vuelta, así que solo devuelve el estado propio`
    });
  }
  return checks;
}

// El cliente de la activación de vuelta: se inyecta en el handler por el mismo criterio
// que el resto (`triggeredBy` es el único enlace del DSL), así que si está inyectado y no
// aparece en el cuerpo, la mitad de la compensación que vive fuera no se hizo.
function returnClientOf(model, operation) {
  for (const { activation } of operation.dependencyActivations ?? []) {
    if (activation.http?.clientClass) return activation.http.clientClass;
  }
  return null;
}

// 4. Reconciliación. La pata del silencio, y la única que ningún escenario FL-* puede
//    ejercitar: el arnés es caja negra y un cron no se alcanza desde fuera. Sin esto no
//    la mira nadie.
// La salida por correo. Pertenece a esta matriz por la misma razón que las demás
// familias: build genera el mecanismo entero —el puerto, el adaptador, el
// renderizador, y lo INYECTA en el handler de cada operación de `mail.sentBy`— y el
// USO lo escribe el agente. Ese tramo no está garantizado por construcción.
//
// Y es especialmente barato de perder. Una operación que no manda el correo compila,
// responde su 2xx y pasa todos sus escenarios menos el que mire el buzón: si el
// diseño no llegó a escribir ese escenario, no falla nada en ninguna parte. Aquí sí.
function mailChecks(model) {
  const checks = [];
  const senders = new Set(model.mail?.sentBy ?? []);
  for (const operation of allOperations(model)) {
    if (!senders.has(operation.name)) continue;
    checks.push({
      group: 'mailDelivery',
      subject: operation.name,
      class: operation.handlerClass,
      // El puerto está inyectado: si no aparece en el cuerpo, el correo no sale.
      require: ['mailSender\.send'],
      forbid: ['TODO|UnsupportedOperationException'],
      why: `el diseño le atribuye la salida por correo (mail.sentBy): tiene que componer el MailMessage y llamar a mailSender.send(...)`
    });

    // Y la guarda, que es la otra mitad y la que no se ve fallar. Que el correo salga lo
    // nota el escenario que mire el buzón; que salga DOS VECES tras una caída del proceso
    // no lo nota nadie: ningún FL-* puede matar la aplicación entre el envío y el commit.
    //
    // Lo afirmable es exacto porque el reclamo lo genera build: que el handler lo llame. Sin
    // esto, el camino de menor resistencia es la transición en memoria y el save() final —que
    // ocurre DESPUÉS del envío—, y ahí una caída revierte la marca y el ciclo siguiente manda
    // un segundo correo real. Pasó en una corrida, y el pase de calidad solo pudo reportarlo.
    if (operation.guardClaim) {
      const { guardClaim } = operation;
      checks.push({
        group: 'mailDelivery',
        subject: `${operation.name} · guarda confirmada antes del envío`,
        class: operation.handlerClass,
        require: [String.raw`\.?` + guardClaim.method + String.raw`\s*\(`],
        forbid: [],
        why:
          `la guarda contra el doble envío (${guardClaim.from.join(' o ')} → ${guardClaim.to}) tiene que estar ` +
          `CONFIRMADA antes de mandar el correo, y hacerla en memoria no la confirma: el handler corre dentro de ` +
          `la transacción del mediator, así que la marca no existe para nadie hasta el commit final —que llega ` +
          `después del envío—. Llama a ${guardClaim.method}(...), que build generó en ${guardClaim.entity}Repository ` +
          `con transacción propia, y trata su vacío como la carrera perdida`
      });
    }
  }
  return checks;
}

function reconciliationChecks(model) {
  const checks = [];
  const schedulers = new Map();
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      if (!(operation.reconciles ?? []).length) continue;
      // El @Scheduled que la dispara vive en el scheduler de SU servicio, no en uno
      // global: dos agregados con barrido son dos clases distintas. Pero el NOMBRE del
      // archivo es organización, no comportamiento — se guarda también qué operación
      // dispara, que es lo afirmable si el agente reorganizó las clases.
      const name = service.className.replace(/Service$/, 'Scheduler');
      schedulers.set(name, [...(schedulers.get(name) ?? []), operation.name]);
    }
  }
  // El reclamo GENERADO. Cuando build lo produce, lo afirmable es exacto —que el handler
  // lo llame— y los tres checks de abajo dejan de aplicar a esta operación: exigirle al
  // agente que escriba el @Modifying, el Pageable y el @Value de algo que ya existe tiene
  // como camino de menor resistencia un segundo mecanismo en paralelo al generado, que no
  // reclama nada y reparte peor. Es la misma forma que la familia sweepClaim.
  let pendingClaim = false;
  for (const operation of allOperations(model)) {
    for (const { dependency, activation, claim } of operation.reconciles ?? []) {
      if (!claim) {
        pendingClaim = true;
        continue;
      }
      checks.push({
        group: 'reconciliation',
        subject: `${operation.name} · reclamo de ${dependency}.${activation.name}`,
        class: operation.handlerClass,
        require: [`\\.?${claim.method}\\s*\\(`],
        // La lectura por estado es EXACTAMENTE el patrón que el reclamo evita: devuelve la
        // misma página en todas las réplicas, y aquí actuar es llamar a otro servidor.
        forbid: ['\\.find(All)?By[A-Za-z]*\\s*\\('],
        why:
          `el barrido corre en TODAS las réplicas: tiene que tomar su lote con ${claim.method}(), que build generó en ` +
          `${claim.entity}Repository —reclama con una marca persistida que caduca, y devuelve solo lo que esta ` +
          `instancia se llevó—, no leerlo con un finder ni con un reclamo escrito aparte`
      });
    }
  }

  for (const operation of allOperations(model)) {
    if (!(operation.reconciles ?? []).length) continue;
    checks.push({
      group: 'reconciliation',
      subject: operation.name,
      class: operation.handlerClass,
      // Aquí NO se exige `@Value`, y no es un olvido. El handler vive en `application`,
      // que por constitución no importa Spring: exigirle la anotación obligaba a elegir
      // entre pasar el gate y respetar la frontera hexagonal, y un agente que la ponga
      // ahí para salir en verde deja el diseño peor de lo que estaba. El umbral se
      // comprueba donde de verdad puede estar —el adaptador que ejecuta el reclamo—, en
      // el check de abajo y sobre el MISMO archivo que reclama.
      forbid: ['TODO|UnsupportedOperationException'],
      why: `barre ${operation.reconciles.map((r) => `${r.dependency}.${r.activation.name}`).join(', ')}: el barrido tiene que estar escrito, no dejado en un stub`
    });
  }
  // Y lo único que decide si el barrido es correcto con varias réplicas: que la
  // consulta RECLAME sus candidatos en vez de leerlos. @Scheduled es «cada N minutos
  // en cada instancia», no «en el clúster», así que un findAllByStatus deja que las N
  // se lleven las mismas filas y todas actúen — y actuar aquí es llamar a otro
  // servidor. Se comprueba una vez por diseño, no por operación: basta con que el
  // patrón exista en alguna parte del árbol que el agente escribió.
  //
  // El patrón exige un cambio de estado PERSISTIDO, y antes aceptaba también un lock
  // pesimista a secas. Aceptarlo era un hueco: un lock solo aísla mientras dura su
  // transacción, y en el barrido la llamada al proveedor va EN MEDIO. De ahí salen dos
  // caminos que el lock deja pasar y ninguno sirve — sostener la transacción durante la
  // llamada (una conexión del pool retenida por la latencia de un tercero) o soltarla
  // antes (el lock se va, la fila no queda marcada y las N réplicas vuelven a verla).
  // El gate tiene que exigir la forma que la convención prescribe, no cualquiera que se
  // le parezca. Lo que sigue sin poder ver es DÓNDE cae el commit; eso queda en la
  // revisión, y conventions/dependencies.md lo dice con ese nombre.
  if (schedulers.size > 0 && pendingClaim) {
    checks.push({
      group: 'reconciliation',
      subject: 'reclamo del barrido',
      claim: '@Modifying|@Update|findAndModify|findOneAndUpdate',
      // Se busca en el CUERPO DEL MÉTODO, no en el archivo, y lo que tiene que acompañar
      // a la escritura es el VOCABULARIO del reclamo. Con el archivo entero bastaba un
      // `@Modifying` cualquiera del adaptador; con el método, hay que estar marcando algo
      // que se llame reclamo. Un `@Modifying` que ajusta un contador no lo satisface.
      scope: 'method',
      bound: '[Cc]laim|[Rr]eclam',
      // Las clases del mecanismo que build YA genera con el patrón: encontrarlas
      // probaría lo que build hizo, no lo que el agente tenía que escribir.
      exclude:
        '/(OutboxEventJpaRepository|OutboxEventMongoRepository|OutboxRelay|OutboxEventJpa|OutboxEventDocument|ProcessedEventJpaRepository|ProcessedEventMongoRepository|IdempotencyRecordJpaRepository|IdempotencyRecordMongoRepository|ReconciliationClaim[A-Za-z]*)\\.java',
      why: 'ninguna consulta reclama candidatos con una MARCA PERSISTIDA (UPDATE ... SET <marca> vía @Modifying, o findAndModify en Mongo): el barrido corre en TODAS las réplicas, y un lock pesimista no sirve aquí porque solo aísla mientras dura su transacción y la llamada al proveedor va en medio — ver conventions/dependencies.md § El barrido corre en todas las réplicas'
    });
    // La cota del lote, APARTE del reclamo. Sin cota, el barrido se lleva la tabla entera
    // y deja de ser un lote: 50.000 atascados son 50.000 llamadas al proveedor en una
    // sola pasada.
    //
    // Va en su propio check por la tercera aplicación de la misma lección —la que ya
    // separó el umbral—: no supongas dónde vive una pieza. Exigir la cota DENTRO del
    // método del reclamo daba por incorrecta la forma que la propia convención prescribe,
    // y en la rama relacional pedía algo que Spring Data no puede expresar: un
    // `@Modifying` de JPQL no acepta `Pageable`, así que seleccionar los candidatos
    // acotados y reclamarlos con un UPDATE condicional son dos consultas por obligación,
    // no por gusto. El check salía rojo sobre un barrido correcto de una corrida real, y
    // su camino de menor resistencia era fusionar las dos en una nativa para callarlo.
    //
    // Lo afirmable sin suponer arquitectura: que en ALGÚN sitio la cota exista Y hable de
    // los candidatos de este barrido. Eso también cierra el falso positivo que motivó
    // acotar el alcance —el `Pageable` del listado paginado de al lado—, porque ese
    // listado no menciona candidatos ni reconciliación: antes pasaba por vecindad, ahora
    // tiene que pasar por lo que dice.
    checks.push({
      group: 'reconciliation',
      subject: 'lote del barrido',
      // Las DOS formas de acotar, que dependen del modelo de persistencia: `Pageable` /
      // `limit` en Spring Data, y un contador de lote en el bucle de `findAndModify` en
      // Mongo, que no casa con ninguna de las otras.
      claim: 'Pageable|PageRequest|[Ll]imit|first[0-9]|[Tt]op[0-9]|[Bb]atch[Ss]ize|batch-size',
      bound: '[Cc]andidat|[Rr]econcil|[Cc]laim|[Rr]eclam|[Ss]tale',
      scope: 'method',
      exclude:
        '/(OutboxEventJpaRepository|OutboxEventMongoRepository|OutboxRelay|OutboxEventJpa|OutboxEventDocument|ProcessedEventJpaRepository|ProcessedEventMongoRepository|IdempotencyRecordJpaRepository|IdempotencyRecordMongoRepository|ReconciliationClaim[A-Za-z]*)\\.java',
      why: 'el reclamo del barrido no acota su lote: ninguna consulta que limite el número de filas (Pageable/limit, o un contador de lote en Mongo) habla de los candidatos que se reconcilian. Puede ir en la misma consulta que reclama o en la que selecciona candidatos —en JPQL un @Modifying no acepta Pageable, así que ahí son dos por obligación—, pero tiene que existir: sin cota, una pasada con 50.000 atascados son 50.000 llamadas al proveedor'
    });
    // Y el umbral de «demasiado tiempo», que no lo declara el diseño: sale de
    // `parameters/`, nunca de una constante.
    //
    // Aparte del reclamo, y no en su mismo archivo. Dos intentos anteriores fallaron por
    // suponer dónde vive: exigirlo en el handler de `application` pedía importar Spring
    // donde la constitución lo prohíbe, y exigirlo junto al reclamo contradice el mismo
    // reparto —puerto sin framework, adaptador con `@Value`, repositorio con la consulta—
    // que el scaffold impone. Lo que sí se puede afirmar sin suponer arquitectura es que
    // en ALGÚN archivo el umbral esté parametrizado Y hable de esperar: un `@Value`
    // suelto en cualquier configuración no es el umbral de este barrido.
    checks.push({
      group: 'reconciliation',
      subject: 'umbral del barrido',
      claim: '@Value|@ConfigurationProperties',
      bound: '[Ss]tale|[Aa]waiting|[Tt]hreshold|[Rr]econcil|[Uu]mbral',
      // Lo que build ya parametriza por su cuenta: encontrarlo probaría lo que build
      // hizo. El relay del outbox es el caso claro — tiene `@Value` y habla de reclamos.
      exclude: '/(OutboxRelay|OutboxDispatcher[A-Za-z]*|ProcessedEventPurge[A-Za-z]*|IdempotencyRecordPurge[A-Za-z]*|ReconciliationClaim[A-Za-z]*)\\.java',
      why: 'el umbral de espera del barrido no está parametrizado en ninguna parte (@Value/@ConfigurationProperties sobre un valor que hable de la espera): build ya lo dejó escrito en parameters/<perfil>/reconciliation.yaml con el valor que declara el diseño (unansweredAfterSeconds), así que lo que falta es LEERLO — quemado en el código no se ajusta por entorno sin recompilar, y además deja de ser el número que el diseñador decidió. Ver conventions/dependencies.md'
    });
  }
  // Lo afirmable es que el barrido TENGA disparador y que no siga siendo un stub, no en qué
  // archivo vive. build emite un scheduler por servicio, y un diseño puede producir dos
  // clases que se distinguen por una sola «s» (DispatchOrderScheduler /
  // DispatchOrdersScheduler): eso se lee como duplicado y se fusiona. Pasó en la quinta
  // corrida, y el check —que solo miraba el nombre canónico— dio ROJO sobre código
  // correcto. Su camino de menor resistencia para apagarlo era recrear la segunda clase:
  // DOS beans disparando el mismo barrido, o sea el doble de pasadas. Es la lección (a)
  // otra vez: no supongas dónde vive una pieza.
  for (const [scheduler, operations] of schedulers) {
    checks.push({
      group: 'reconciliation',
      subject: scheduler,
      class: scheduler,
      // Si el nombre canónico no está, se busca el archivo que dispara ESTAS operaciones...
      locate: operations.map((name) => `\\b${name}\\s*\\(`).join('|'),
      // ...y que además es un disparador: el handler y el mediador también las nombran.
      confirm: '@Scheduled',
      require: ['@Scheduled'],
      // build lo deja lanzando cuando el mensaje necesita argumentos. Si sigue ahí, el
      // barrido no corre nunca y nada más lo delata.
      forbid: ['UnsupportedOperationException'],
      why: `el disparador de ${operations.join(', ')}: build lo deja lanzando cuando el mensaje lleva argumentos`
    });
  }
  return checks;
}

// 5. Entrega del outbox. El stub NO lanza a propósito (el relay contaría el intento como
//    fallo), así que su precio es que marca como publicadas filas que nunca salieron. El
//    fail-fast del arranque cubre los perfiles de verdad; esto lo cubre antes de arrancar.
//    A diferencia de la reconciliación, esta familia SÍ tiene un escenario detrás desde que
//    el arnés puede detener el broker (`FL-*` de canal indisponible), pero ese escenario
//    llega tarde: corre con la aplicación arrancada, y si el dispatcher es el fallback la
//    suite entera se ha ejecutado ya contra un servidor que descartaba eventos en silencio.
//    Este check es el que lo dice antes.
function outboxChecks(model) {
  if (!usesOutbox(model)) return [];
  return [
    {
      group: 'outboxDelivery',
      subject: 'OutboxDispatcher',
      implementors: 'OutboxDispatcher',
      exclude: 'OutboxDispatcherFallbackConfig',
      why: 'con reliability: outbox el diseño prometió que ningún evento se pierde; con solo el fallback se pierden todos sin un solo error'
    }
  ];
}

// ─── El script ───────────────────────────────────────────────────────────────

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

function script(model, checks) {
  const rows = checks.map((check) => {
    if (check.implementors) {
      return `impl ${shellQuote(check.group)} ${shellQuote(check.subject)} ${shellQuote(check.implementors)} ${shellQuote(check.exclude)} ${shellQuote(check.why)}`;
    }
    if (check.claim) {
      return `claim ${shellQuote(check.group)} ${shellQuote(check.subject)} ${shellQuote(check.claim)} ${shellQuote(check.bound)} ${shellQuote(check.exclude)} ${shellQuote(check.why)} ${shellQuote(check.scope ?? '')}`;
    }
    const require = (check.require ?? []).join('\u0001');
    const forbid = (check.forbid ?? []).join('\u0001');
    return `unit ${shellQuote(check.group)} ${shellQuote(check.subject)} ${shellQuote(check.class)} ${shellQuote(require)} ${shellQuote(forbid)} ${shellQuote(check.locate ?? '')} ${shellQuote(check.why)} ${shellQuote(check.confirm ?? '')}`;
  });

  const groups = [...new Set(checks.map((check) => check.group))];

  return `#!/usr/bin/env bash
# check-idempotency.sh — comprueba que el código escrito por el agente USE los
# mecanismos de repetición y compensación que build generó para ${model.service.name}.
#
# Build genera los mecanismos; quien los usa es el agente. Ese es el único tramo de la
# cadena que no está garantizado por construcción, y falla en silencio: un listener sin
# guard o un handler que ignora el IdempotencyStore funcionan perfectamente hasta la
# primera repetición. La matriz de abajo la precomputó build desde el diseño.
#
# Son comprobaciones ESTRUCTURALES (presencia, ausencia y orden), no análisis semántico:
# cazan el hueco y el cruce, no si el algoritmo es correcto. Eso último lo juzga el
# agente de calidad, que ejecuta este script en vez de leer el árbol a mano.
#
# Uso (desde la raíz del proyecto; no necesita infraestructura ni compilar):
#   bash infra/check-idempotency.sh
#
# Salida: un veredicto por familia (${groups.join(', ')}) y el detalle de lo que falta.
# Código de salida:
#   0  todas las familias en OK
#   1  hay hallazgos → van a 'remaining' del reporte y vuelven al agente de código
set -u

SRC="src/main/java"

if [ ! -d "$SRC" ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró $SRC)." >&2
  exit 1
fi

findings=0
detail=""
${groups.map((group) => `${group}_ko=0`).join('\n')}

note() {  # familia, texto
  detail="$detail  [$1] $2\\n"
  findings=$((findings + 1))
  case "$1" in
${groups.map((group) => `    ${group}) ${group}_ko=1 ;;`).join('\n')}
  esac
}

# El archivo se busca por nombre, no por ruta: algunos los escribe el agente y dónde
# los ponga es suyo (la frontera hexagonal la vigila conventions/project-layout.md).
locate() {
  find "$SRC" -name "$1.java" -type f 2>/dev/null | head -n 1
}

# Una unidad de comprobación: un archivo, lo que tiene que aparecer y lo que no.
unit() {  # familia, sujeto, clase, requeridos (\\001), prohibidos (\\001), localizador, porqué, confirmador
  local group="$1" subject="$2" class="$3" required="$4" forbidden="$5" locator="$6" why="$7" confirm="\${8:-}"
  local file
  file="$(locate "$class")"
  # Cuando el nombre canónico no existe pero el diseño admite otra forma —un listener
  # único para varias suscripciones de la misma cola, o dos schedulers que el agente
  # fusionó en uno—, el archivo se busca por CONTENIDO: el que maneja esos mensajes y
  # además pasa el CONFIRMADOR, que es lo que distingue al host legítimo del handler o
  # del mediador, que también nombran la operación. Sin esto, la implementación correcta
  # se reporta como ausente y el camino de menor resistencia para apagar el hallazgo es
  # partirla en la incorrecta — que aquí serían DOS beans disparando el mismo barrido.
  if [ -z "$file" ] && [ -n "$locator" ] && [ -n "$confirm" ]; then
    local candidate
    while IFS= read -r candidate; do
      [ -n "$candidate" ] || continue
      if grep -qE -- "$confirm" "$candidate" 2>/dev/null; then
        file="$candidate"
        break
      fi
    done <<EOF
$(grep -rlE -- "$locator" "$SRC" 2>/dev/null | grep -v 'Message\\.java$')
EOF
  fi
  if [ -z "$file" ]; then
    note "$group" "$subject: no existe $class.java — $why"
    return
  fi
  # Los comentarios no cuentan: un TODO tachado dentro de un bloque de javadoc que
  # explica lo que HAY que hacer no es lo mismo que un TODO vivo en el cuerpo. Se
  # miran las líneas de código, no la prosa que build dejó de guía.
  local code
  code="$(sed -e 's://.*::' -e '/^[[:space:]]*\\*/d' -e '/^[[:space:]]*\\/\\*/d' "$file")"
  local pattern
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    printf '%s' "$code" | grep -qE -- "$pattern" \\
      || note "$group" "$subject ($class): falta '$pattern' — $why"
  done <<EOF
$(printf '%s' "$required" | tr '\\001' '\\n')
EOF
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    printf '%s' "$code" | grep -qE -- "$pattern" \\
      && note "$group" "$subject ($class): NO debe aparecer '$pattern' — $why"
  done <<EOF
$(printf '%s' "$forbidden" | tr '\\001' '\\n')
EOF
}

# Que exista una implementación de un puerto distinta del fallback que generó build.
impl() {  # familia, sujeto, interfaz, clase excluida, porqué
  local group="$1" subject="$2" iface="$3" excluded="$4" why="$5"
  local found
  found="$(grep -rlE "implements[^{]*\\\\b$iface\\\\b|$iface[[:space:]]*\\\\(" "$SRC" 2>/dev/null \\
           | grep -v "/$excluded.java" | head -n 1)"
  [ -n "$found" ] || note "$group" "$subject: solo está el fallback $excluded — $why"
}

# Dos patrones que tienen que darse juntos, buscados en todo el árbol y no en una ruta
# fija: dónde ponga el agente cada pieza es asunto suyo mientras respete la frontera
# hexagonal. La pareja es lo que da sentido a cada uno por separado — un reclamo aquí y un
# Pageable en otro listado cualquiera no es un lote acotado, y un @Value en una
# configuración cualquiera no es el umbral de un barrido.
#
# Y sobre el CÓDIGO, no sobre la prosa: la nota que build deja en el stub del barrido
# nombra el patrón para explicarlo, así que mirando el archivo entero este check saldría
# verde por el propio comentario que dice lo que falta hacer.
#
# CUÁNTO se acerca el segundo patrón lo decide el 7º argumento, y no es un detalle:
#
#   (vacío) el archivo entero. Es lo correcto cuando las dos piezas viven en sitios
#           distintos de la clase por construcción — el umbral es un @Value de CAMPO, y
#           un campo no está dentro de ningún método.
#   method  solo el cuerpo del método donde cayó el primer patrón. Hace falta para la
#           cota del barrido: su reclamo vive en el adaptador del repositorio, que es por
#           definición donde están TODAS las consultas del agregado — incluido el listado
#           paginado de algún endpoint. Con el archivo entero, ese Pageable ajeno daba el
#           check por bueno pasara lo que pasara en el barrido, así que la comprobación no
#           podía fallar nunca.
#
# El recorte tiene dos formas porque el reclamo tiene dos, y la primera no sirve para la
# segunda:
#
#   1. Cuerpo entre llaves — el adaptador que implementa la consulta a mano (Mongo con
#      MongoTemplate). Se aísla contando llaves.
#   2. Miembro de una interfaz — el repositorio Spring Data, donde el reclamo es
#      @Modifying + @Query + la firma, y NO hay cuerpo: contar llaves no encuentra nada.
#      Se aísla por párrafo (líneas contiguas entre blancos), que es como quedan
#      separados los miembros.
#
# Las dos son heurísticas, y las dos recorren TODOS sus bloques buscando uno que traiga las
# dos cosas — no el primero que traiga la primera—. Quedarse con el primero hacía que un
# \`import …Pageable;\` (que es un bloque, y casa con el patrón de la cota) decidiera por el
# archivo entero y tapara la consulta de más abajo, que sí la traía.
methodBody() {  # patrón que localiza el reclamo, patrón que lo acompaña
  awk -v pat="$1" -v bound="$2" '
    { line = $0
      t = line; o = gsub(/\\{/, "", t)
      t = line; c = gsub(/\\}/, "", t)
      if (depth >= 1 && (buf != "" || o > 0)) buf = buf line "\\n"
      depth += o - c
      if (buf != "" && depth <= 1) {
        if (buf ~ pat && buf ~ bound) { printf "%s", buf; exit }
        buf = ""
      }
    }'
}

memberBlock() {  # patrón que localiza el reclamo, patrón que lo acompaña
  awk -v pat="$1" -v bound="$2" '
    /^[[:space:]]*$/ { if (buf ~ pat && buf ~ bound) { printf "%s", buf; exit } buf = ""; next }
    { buf = buf $0 "\\n" }
    END { if (buf ~ pat && buf ~ bound) printf "%s", buf }'
}

claim() {  # familia, sujeto, patrón principal, patrón que lo acompaña, rutas excluidas, porqué, alcance
  local group="$1" subject="$2" pattern="$3" bound="$4" excluded="$5" why="$6" scope="\${7:-}"
  local file found="" code window
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    # Los imports fuera: un \`import …Pageable;\` es la declaración de una herramienta, no
    # su uso, y aceptarlo daba por acotado un barrido que no acotaba nada.
    code="$(sed -e 's://.*::' -e '/^[[:space:]]*\\*/d' -e '/^[[:space:]]*\\/\\*/d' -e '/^[[:space:]]*import /d' "$file")"
    printf '%s' "$code" | grep -qE -- "$pattern" || continue
    if [ "$scope" = "method" ]; then
      # Sin degradar al archivo entero cuando ningún bloque trae las dos: ese era el
      # camino por el que la cota de un listado paginado vecino valía por la del barrido.
      window="$(printf '%s' "$code" | methodBody "$pattern" "$bound")"
      [ -n "$window" ] || window="$(printf '%s' "$code" | memberBlock "$pattern" "$bound")"
      [ -n "$window" ] || continue
    else
      window="$code"
    fi
    if printf '%s' "$window" | grep -qE -- "$bound"; then
      found="$file"
      break
    fi
  done <<EOF
$(grep -rlE -- "$pattern" "$SRC" 2>/dev/null | grep -vE "$excluded")
EOF
  [ -n "$found" ] || note "$group" "$subject: $why"
}

${rows.join('\n')}

echo ""
echo "IDEMPOTENCIA Y COMPENSACIÓN"
${groups
  .map(
    (group) =>
      `if [ "$${group}_ko" -eq 0 ]; then echo "  ${group.padEnd(20)} OK"; else echo "  ${group.padEnd(20)} KO"; fi`
  )
  .join('\n')}

if [ "$findings" -gt 0 ]; then
  echo ""
  echo "HALLAZGOS ($findings)"
  printf '%b' "$detail"
  exit 1
fi

exit 0
`;
}
