// El catálogo de la REVISIÓN: lo que solo un lector puede juzgar, con id.
//
// `obligations.js:29-32` lo describía hace tiempo y lo dejaba sin hacer: «lo que solo un
// lector puede juzgar. NO se mecaniza: la fila existe para que /keel-validate la recorra
// y dé veredicto por id, que es lo que hoy no hace». Esto es eso.
//
// El problema que resuelve. La checklist semántica de `/keel-validate` era prosa por
// capa: sin ids, sin artefacto de salida y sin forma de saber si el agente la recorrió
// entera. Un diseño «revisado» y uno del que nadie miró la mitad se escriben igual — no
// queda rastro —, y como la revisión se hace dentro de una conversación, se pierde con la
// compactación de contexto y con el diseño heredado. Es el mismo argumento que ya llevó a
// escribir `decisions.yaml` para las obligaciones (`design-obligations.md:18`): el mismo
// hueco reportado cuatro corridas seguidas.
//
// Por qué un módulo aparte y no `kind: 'review'` dentro de OBLIGATIONS. Tres razones, y
// ninguna es de gusto:
//
//   1. La forma es distinta. Una obligación la LEVANTA `crossrefs.js` al ver un dato; una
//      revisión la levanta su APLICABILIDAD sobre las capas, que es una función pura del
//      diseño. Es el patrón que `derivatives.js` ya usa con su `applies(layers)`.
//   2. El cierre es distinto: obligación → `decisions.yaml` con `reason` + `since`;
//      revisión → `review.yaml` con VEREDICTO. Campos distintos, validaciones distintas.
//   3. Y hay un fallo latente si se mezclan: `decisions.js` acepta cualquier id del
//      catálogo dentro de `decisions.yaml`. Con las revisiones ahí dentro, un `REV-*`
//      escrito en `decisions.yaml` pasaría la validación y cerraría una revisión por la
//      puerta equivocada.
//
// La frontera con `checks.js` es comprobable, no declarativa: para cada id de aquí tiene
// que existir un diseño que lo viole y sobre el que `keel validate` salga en VERDE. Si
// sale en rojo, esa comprobación era mecanizable y su sitio es `crossrefs.js`.

/**
 * `REV-<ÁMBITO>-<NOMBRE>`.
 *
 * - `appliesTo(layers)` — si esta revisión le toca a este diseño. Lo decide la MÁQUINA,
 *   que es lo que permite exigir cobertura: un id aplicable sin veredicto es un hueco.
 * - `severity` — `error` bloquea; `warning` no; `strong` es el «aviso fuerte» de la
 *   checklist: no bloquea, pero su hallazgo casi siempre es real.
 * - `asks` — la pregunta que el lector tiene que contestar, en una línea.
 * - `gapClass` — la clase de `gap-analysis.md` (1..17) a la que pertenece, para que el
 *   barrido de `/keel-design` y la revisión de `/keel-validate` nombren el mismo hueco.
 */
export const REVIEWS = {
  // ─── domain ────────────────────────────────────────────────────────────────
  'REV-DOMAIN-VAGUE-INVARIANT': {
    scope: 'domain',
    gapClass: 2,
    severity: 'warning',
    appliesTo: (layers) => hasAny(layers.domain?.entities, (entity) => (entity.invariants ?? []).length > 0),
    title: 'invariantes ambiguas o no verificables',
    asks: 'por cada invariante, ¿se puede decidir si se cumple mirando solo los campos declarados?'
  },
  'REV-DOMAIN-ENUM-NO-LIFECYCLE': {
    scope: 'domain',
    gapClass: 1,
    severity: 'warning',
    appliesTo: (layers) => hasAny(layers.domain?.entities, (entity) => !entity.lifecycle && hasEnumField(entity, layers)),
    title: 'entidad con campo de estado enum y sin lifecycle',
    asks: '¿las transiciones son de verdad libres, o falta declarar la máquina de estados?'
  },
  'REV-DOMAIN-INVARIANT-IS-TRANSITION': {
    scope: 'domain',
    gapClass: 1,
    severity: 'warning',
    appliesTo: (layers) => hasAny(layers.domain?.entities, (entity) => (entity.invariants ?? []).length > 0),
    title: 'invariante en prosa que en realidad describe una transición',
    asks: '¿alguna invariante habla de «pasar de X a Y»? Eso es lifecycle, y ahí sí se comprueba'
  },
  'REV-DOMAIN-COMPUTED-NOT-DERIVABLE': {
    scope: 'domain',
    gapClass: 3,
    severity: 'warning',
    appliesTo: (layers) => hasAny(layers.domain?.entities, (entity) => hasField(entity, (field) => field?.computed !== undefined)),
    title: 'regla `computed` que no se deriva de los campos existentes',
    asks: '¿la fórmula de cada computed usa solo campos que la entidad tiene?'
  },
  'REV-DOMAIN-WIDE-AGGREGATE': {
    scope: 'domain',
    gapClass: 6,
    severity: 'warning',
    appliesTo: (layers) => hasAny(layers.domain?.aggregates, (agg) => (agg.entities ?? []).length >= 3),
    title: 'agregado con muchas entidades internas',
    asks: '¿todas tienen que cambiar en la misma transacción, o la frontera es demasiado grande?'
  },
  'REV-DOMAIN-PROMISED-STATE': {
    scope: 'domain',
    gapClass: 14,
    severity: 'strong',
    appliesTo: (layers) => Boolean(layers.domain),
    title: 'la prosa promete un estado que la entidad no puede representar',
    asks:
      'por cada verbo de conservación, ocultación o marcado en una description o una rule («no borra el rastro», ' +
      '«queda marcada como retirada»), señala el campo o la transición que lo sostiene; si no existe, falta'
  },

  // ─── use-cases ─────────────────────────────────────────────────────────────
  'REV-USECASES-INTERNAL-REPEAT': {
    scope: 'use-cases',
    gapClass: 4,
    severity: 'warning',
    appliesTo: (layers) => hasAny(layers['use-cases']?.operations, (op) => op.kind === 'command' && !op.idempotency),
    title: 'command reintentable cuyo efecto NO sale del proceso y no declara guarda',
    asks:
      'CHK-USECASES-REPEATABLE-ESCAPES cubre el que publica o encarga trabajo fuera. Lo que queda: un alta que cobra ' +
      'por dentro, un contador que suma. ¿Hay una clave natural en persistence que frene el segundo insert, o nadie lo decidió?'
  },
  'REV-USECASES-CACHE-NON-EVENT-PATHS': {
    scope: 'use-cases',
    gapClass: 5,
    severity: 'warning',
    appliesTo: (layers) => hasAny(layers['use-cases']?.operations, (op) => Boolean(op.cache)),
    title: 'vías de invalidación que no son eventos',
    asks: '¿qué más muta lo cacheado? Una operación de otro servicio, un cambio de configuración: eso no cabe en invalidatedBy'
  },
  'REV-USECASES-GUARD-ORDER': {
    scope: 'use-cases',
    gapClass: 2,
    severity: 'strong',
    appliesTo: (layers) => hasAny(layers['use-cases']?.operations, (op) => (op.rules ?? []).length > 0),
    title: 'el orden de guardas que fijan las rules no es implementable',
    asks:
      '¿cada guarda depende solo de datos disponibles cuando le toca? Una que busca un duplicado «dentro de la ' +
      'aplicación» no puede ir antes de la que resuelve esa aplicación'
  },

  // ─── api ───────────────────────────────────────────────────────────────────
  'REV-API-DELETE-BODY': {
    scope: 'api',
    gapClass: 15,
    severity: 'warning',
    appliesTo: (layers) => hasAny(layers.api?.endpoints, (endpoint) => endpoint.method === 'DELETE'),
    title: 'un DELETE declara cuerpo de respuesta',
    asks: '¿el cliente necesita ese cuerpo —la operación deja algo vecino en un estado que él no puede predecir— o es un 204 que nadie declaró?'
  },

  // ─── security ──────────────────────────────────────────────────────────────
  'REV-SEC-M2M-AUDIENCE': {
    scope: 'security',
    gapClass: 11,
    severity: 'warning',
    appliesTo: (layers) => Boolean(layers.security?.authentication?.serviceAuth),
    title: 'superficie M2M sin validateAudience',
    asks: '¿este servicio convive con otros que comparten servidor de autenticación? Entonces un token emitido para otro valdría aquí'
  },
  'REV-SEC-RESOURCE-SCOPE': {
    scope: 'security',
    gapClass: 9,
    severity: 'strong',
    appliesTo: (layers) => Object.keys(layers.security?.roles ?? {}).length > 0,
    title: 'alcance por recurso que la prosa da por hecho',
    asks:
      'roles, permissions y scopes son GLOBALES: quien tiene el rol lo tiene sobre todo. Si el diseño habla de que ' +
      'alguien «solo opera sobre lo suyo», ¿de dónde sale ese alcance? (del caso del 403 declarado se encarga OBL-RESOURCE-SCOPE)'
  },

  // ─── messaging ─────────────────────────────────────────────────────────────
  'REV-MSG-MISSING-CHANNEL': {
    scope: 'messaging',
    gapClass: 7,
    severity: 'warning',
    appliesTo: (layers) => Boolean(layers.messaging),
    title: 'eventos o suscripciones sin `channel` en un servicio que se integra',
    asks: '¿alguien de fuera escucha esto? El canal es el contrato de integración y su nombre lógico tiene que ser estable'
  },
  'REV-MSG-IDENTITY-FROM-FIELD': {
    scope: 'messaging',
    gapClass: 9,
    severity: 'strong',
    appliesTo: (layers) =>
      hasAny(layers.messaging?.subscriptions, (sub) => sub.identity?.from?.location === 'field'),
    title: 'la identidad de quien pide el trabajo sale del cuerpo del mensaje',
    asks:
      'relee la asunción de trustedPublishers, no la des por vigente: se sostiene sobre que todos los emisores sean ' +
      'sistemas propios. ¿Hay ya alguno fuera del perímetro, o consecuencias que no se pueden retirar?'
  },
  'REV-MSG-DEDUPE-WINDOW': {
    scope: 'messaging',
    gapClass: 4,
    severity: 'warning',
    appliesTo: (layers) =>
      hasAny(layers.messaging?.subscriptions, (sub) => {
        const handler = layers['use-cases']?.operations?.[sub.triggers];
        if (!handler) return false;
        return (handler.transitions ?? []).length === 0 && !handler.idempotency;
      }),
    title: 'la ventana de deduplicación de una suscripción la fija un parámetro operativo',
    asks:
      '¿el efecto del handler es ACUMULABLE? Sin `transitions` ni `idempotency` no hay guarda de dominio detrás, y lo ' +
      'único que frena la reentrega es la tabla de procesados, cuya retención no está en el diseño: pasada, una ' +
      'reentrega vuelve a sumar. Si el efecto se puede repetir sin daño, no hay hallazgo'
  },

  // ─── dependencies ──────────────────────────────────────────────────────────
  'REV-DEPS-REPLICA-NO-RETIREMENT': {
    scope: 'dependencies',
    gapClass: 8,
    severity: 'strong',
    appliesTo: (layers) => hasNeed(layers, (need) => Boolean(need.replica)),
    title: 'el `fedBy` de una réplica no cubre la baja o retirada del recurso',
    asks: '¿qué evento cuenta que el recurso se dio de baja? Sin él la copia se queda rancia para siempre y nadie se entera'
  },
  'REV-DEPS-DEGRADED-PLAUSIBLE': {
    scope: 'dependencies',
    gapClass: 8,
    severity: 'warning',
    appliesTo: (layers) => hasNeed(layers, (need) => need.onMiss?.action === 'degrade'),
    title: '`degradedTo` produce datos plausibles pero falsos',
    asks: '¿el cliente puede distinguir esa respuesta de una normal? Si no, está tomando decisiones sobre un dato inventado'
  },
  'REV-DEPS-ONDEMAND-IN-COMMAND': {
    scope: 'dependencies',
    gapClass: 8,
    severity: 'warning',
    appliesTo: (layers) => hasNeed(layers, (need) => need.strategy === 'on-demand'),
    title: 'un `need` on-demand usado por un command transaccional',
    asks: '¿la llamada cae dentro de la transacción de escritura? Un timeout la deja abierta'
  },
  'REV-DEPS-REPLICA-AS-TRUTH': {
    scope: 'dependencies',
    gapClass: 8,
    severity: 'strong',
    appliesTo: (layers) => hasNeed(layers, (need) => Boolean(need.replica)),
    title: 'la réplica se expone tal cual o se le atribuyen invariantes de negocio',
    asks: 'una copia no es fuente de verdad: ¿sale en la salida de alguna operación, o alguna regla la trata como si mandara?'
  },
  'REV-DEPS-NEED-IS-ACTIVATION': {
    scope: 'dependencies',
    gapClass: 8,
    severity: 'strong',
    appliesTo: (layers) => hasNeed(layers, (need) => need.strategy === 'on-demand'),
    title: 'un `need` que en realidad es una activación',
    asks:
      '¿la llamada que resuelve el dato MUTA estado en el proveedor y su respuesta no decide nada? Entonces el ' +
      'acoplamiento va al revés de como está declarado, y queda fuera del mapa del sistema'
  },
  'REV-DEPS-IGNORED-FAILURE': {
    scope: 'dependencies',
    gapClass: 8,
    severity: 'strong',
    appliesTo: (layers) =>
      hasActivation(layers, (act) => act.onFailure?.action === 'ignore' || act.awaits === 'nothing'),
    title: 'trabajo encargado cuyo fallo se ignora, o que no se espera en absoluto',
    asks: '¿quién lo echaría de menos y cuándo se enteraría? La operación responde éxito y el trabajo puede no haberse hecho nunca'
  },
  'REV-DEPS-NO-COMPENSATION': {
    scope: 'dependencies',
    gapClass: 8,
    severity: 'strong',
    appliesTo: (layers) => hasActivation(layers, () => true),
    title: 'la operación puede fallar DESPUÉS de haber encargado el trabajo, y nadie lo deshace',
    asks: '¿qué pasa si la operación propia falla una vez encargado? Sin compensación queda trabajo hecho que nadie retira'
  },
  'REV-DEPS-AWAITING-CLOCK': {
    scope: 'dependencies',
    gapClass: 13,
    severity: 'strong',
    appliesTo: (layers) => hasActivation(layers, (act) => Boolean(act.reconciledBy)),
    title: 'la marca temporal del estado de espera no es la correcta',
    asks:
      '¿quién la estampa y cuándo? Tiene que escribirla la operación que encarga, justo al encargar, y no tocarla ' +
      'nadie más. Una que otra escritura refresca deja la fila invisible al barrido para siempre'
  },
  'REV-DEPS-MESSAGEID-UNSTABLE': {
    scope: 'dependencies',
    gapClass: 8,
    severity: 'error',
    appliesTo: (layers) => hasAny(layers.messaging?.subscriptions, (sub) => Boolean(sub.contract?.messageId)),
    title: '`messageId` que el emisor no mantiene estable entre reentregas',
    asks:
      'la CLI comprueba que el campo existe, no que el emisor mande el mismo valor al reentregar. Contrástalo con su ' +
      'INTEGRATION.md: un uuid nuevo por publicación deduplica cero, con el diseño en verde'
  },
  'REV-DEPS-IDEMPOTENT-BY-DECLARATION': {
    scope: 'dependencies',
    gapClass: 4,
    severity: 'error',
    appliesTo: (layers) => hasAny(layers.messaging?.subscriptions, (sub) => Boolean(sub.contract?.messageId)),
    title: 'idempotente por declaración pero no por comportamiento',
    asks:
      '`contract.messageId` deduplica el MENSAJE, no el efecto. ¿El cuerpo emite un evento incondicionalmente, suma ' +
      'en vez de fijar, llama a un tercero? El mecanismo tiene que cortar el efecto real'
  },
  'REV-DEPS-COMPENSATION-WRONG-STATE': {
    scope: 'dependencies',
    gapClass: 8,
    severity: 'strong',
    appliesTo: (layers) => hasCompensation(layers),
    title: 'la transición de vuelta existe pero no es la que el negocio quiere',
    asks:
      'la CLI comprueba que la arista está en lifecycle, no que sea el estado correcto. Un pedido cuya reserva se ' +
      'revierte no siempre vuelve a pending: a veces va a cancelled, y devolverlo mal lo hace reintentable'
  },

  // ─── persistence ───────────────────────────────────────────────────────────
  'REV-PERSIST-MISSING-INDEX': {
    scope: 'persistence',
    gapClass: 5,
    severity: 'warning',
    appliesTo: (layers) => Boolean(layers.persistence),
    title: 'campos de queries frecuentes sin índice',
    asks: '¿por qué campos filtran y ordenan las queries declaradas? Esos son los índices que faltan'
  },

  // ─── storage ───────────────────────────────────────────────────────────────
  'REV-STORAGE-PUBLIC-SENSITIVE': {
    scope: 'storage',
    gapClass: 10,
    severity: 'strong',
    appliesTo: (layers) => hasAny(layers.storage?.buckets, (bucket) => bucket.visibility === 'public'),
    title: 'un bucket público guarda datos personales o documentos privados',
    asks: '¿qué se sube ahí? Público significa que cualquiera con la URL lo lee, para siempre'
  },
  'REV-STORAGE-UPLOAD-ERRORS': {
    scope: 'storage',
    gapClass: 10,
    severity: 'warning',
    appliesTo: (layers) => Boolean(layers.storage),
    title: 'la operación que sube no declara los errores de subida esperados',
    asks: '¿dónde están FILE_TOO_LARGE y UNSUPPORTED_CONTENT_TYPE en los errors de use-cases?'
  },

  // ─── mail ──────────────────────────────────────────────────────────────────
  'REV-MAIL-SENTBY-NO-GUARD': {
    scope: 'mail',
    gapClass: 17,
    severity: 'warning',
    appliesTo: (layers) => Boolean(layers.mail),
    title: 'una operación de `sentBy` sin idempotency ni transición',
    asks: 'un correo que sale no lo deshace ninguna transacción, y un reintento lo manda dos veces a una persona real'
  },
  'REV-MAIL-TEMPLATE-ERRORS': {
    scope: 'mail',
    gapClass: 17,
    severity: 'warning',
    appliesTo: (layers) => Boolean(layers.mail),
    title: 'no hay error declarado para «no hay plantilla» ni «falta una variable obligatoria»',
    asks: '¿qué contesta el servicio cuando la plantilla no existe o falta una variable?'
  },
  'REV-MAIL-ASYNC-OUTCOME': {
    scope: 'mail',
    gapClass: 17,
    severity: 'warning',
    appliesTo: (layers) => Boolean(layers.mail),
    title: 'la operación responde antes de enviar y el envío que falla no tiene desenlace',
    asks: 'si contesta un 202, ¿qué se hace con el envío que falla después? Sin desenlace declarado el correo se pierde y nadie se entera'
  },
  'REV-MAIL-BOUNCE-CHANNEL': {
    scope: 'mail',
    gapClass: 17,
    severity: 'warning',
    appliesTo: (layers) => Boolean(layers.mail),
    title: 'una regla depende de un fallo posterior a la aceptación del relay y no hay canal de vuelta',
    asks:
      '¿hay reglas sobre rebotes, supresión de direcciones o quejas? El relay acepta y responde OK; el rebote vuelve ' +
      'horas después por un webhook o un buzón. Sin canal declarado, esa regla no es implementable ni verificable'
  }
};

// ── helpers de aplicabilidad ────────────────────────────────────────────────
// Puros y tolerantes: un diseño a medias no puede hacerlos lanzar, porque se evalúan
// también en `--wip`, cuando la mitad de las capas aún no existe.

function hasAny(collection, predicate) {
  return Object.values(collection ?? {}).some((value) => {
    try {
      return predicate(value ?? {});
    } catch {
      return false;
    }
  });
}

function hasField(entity, predicate) {
  return Object.values(entity?.fields ?? {}).some((field) => predicate(field));
}

function hasEnumField(entity, layers) {
  return hasField(entity, (field) => {
    if (field?.type === 'enum') return true;
    const named = layers.domain?.types?.[field?.type];
    return Array.isArray(named?.values);
  });
}

function hasNeed(layers, predicate) {
  return hasAny(layers.dependencies?.dependencies, (dep) => hasAny(dep.needs, predicate));
}

function hasActivation(layers, predicate) {
  return hasAny(layers.dependencies?.dependencies, (dep) => hasAny(dep.activations, predicate));
}

function hasCompensation(layers) {
  return hasAny(layers.dependencies?.dependencies, (dep) => (dep.compensations ?? []).length > 0);
}

export const reviewIds = () => Object.keys(REVIEWS);

export function reviewFor(id) {
  return REVIEWS[id];
}

/**
 * Los ids que le TOCAN a este diseño, en el orden del catálogo. Es lo que convierte la
 * revisión en algo con cobertura exigible: sin aplicabilidad derivada, «no aplica» sería
 * la salida barata de cualquier id incómodo.
 */
export function applicableReviews(layers) {
  return Object.entries(REVIEWS)
    .filter(([, entry]) => {
      try {
        return entry.appliesTo(layers ?? {});
      } catch {
        return false;
      }
    })
    .map(([id]) => id);
}
