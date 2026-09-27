// El catálogo de las comprobaciones MECÁNICAS de la puerta de diseño: las que decide la
// CLI leyendo los YAML, con id estable.
//
// Por qué hace falta el id. `crossrefs.js` emitía sus 200+ hallazgos como cadenas sueltas
// en español, y eso impedía tres cosas a la vez:
//
//   1. Que la skill `/keel-validate` pueda DECIR qué ya comprueba la CLI sin repetirlo en
//      prosa. Mientras el acoplamiento fue por frases («keel validate ya avisa de X»), las
//      dos mitades divergieron: la skill pedía juzgar el `circuitBreaker` sin `fallback`
//      que la CLI llevaba mecanizado, y trece más como esa.
//   2. Medir la puerta por mutación. Un corpus de diseños rotos a propósito tiene que
//      afirmar «esta mutación dispara ESTE hallazgo y ningún otro», y con cadenas eso
//      significa afirmar sobre substrings que se rompen al retocar una coma. El corpus
//      existe: `test/design-mutations/` (un diseño base en silencio y una mutación por id),
//      y un id nuevo no entra sin la suya — lo exige `test/design-mutations.test.js`.
//   3. Contar. Sin id no hay inventario, y sin inventario no se sabe qué falta.
//
// La frontera con los otros dos catálogos del método:
//
//   - `obligations.js` — lo que el diseño NO decidió. Se cierra en el DSL o se acepta por
//     escrito en `decisions.yaml`. Un hallazgo de aquí se corrige; una obligación se cierra.
//   - el catálogo de revisión (pendiente) — lo que solo un lector puede juzgar, porque el
//     sujeto es prosa y ningún YAML lo contesta.
//
// La prueba para saber si algo pertenece AQUÍ y no allí son cuatro preguntas, y se
// mecaniza solo si las cuatro son sí: ¿la respuesta sale de los YAML sin leer prosa?
// ¿existe un diseño legítimo en el que el hallazgo sea falso (si no, `error`; si sí,
// `warning`)? ¿se puede escribir una mutación que dispare este id y solo este? ¿puede el
// mensaje nombrar el campo concreto que lo cierra?
//
// Migración deliberadamente parcial. Aquí están las comprobaciones que la checklist
// semántica citaba y las que se mecanizaron al podarla; las heredadas entran por
// oportunidad, y lo que impide que su número crezca es `test/checks-ratchet.test.js`.

/**
 * `CHK-<ÁMBITO>-<NOMBRE>`. El ámbito es la capa del DSL a la que mira la comprobación
 * (`MODEL` para lo transversal).
 *
 * - `severity` — `error` bloquea la generación; `warning` no. No es una etiqueta libre:
 *   la decide la segunda pregunta de arriba.
 * - `layer` — dónde se corrige, en lenguaje del diseñador.
 * - `title` — el hallazgo en una línea, para inventarios y tablas.
 * - `closes` — qué hay que escribir para que deje de emitirse.
 * - `nature` — `incoherence` o `undecided`, y la decide una pregunta: ¿el diseño se arregla
 *   CORRIGIENDO algo, o RESPONDIENDO a una pregunta? Una incoherencia se corrige y nada
 *   más. Una decisión no tomada es otra cosa: si nadie la toma, la toma el generador —con
 *   un default que cambia de un stack a otro—, así que se cierra en el DSL o se acepta por
 *   escrito en `decisions.yaml` con su motivo y su `scope`, igual que una obligación. No
 *   bloquea la generación (`validateService().ok` no la mira); cuenta en `keel validate
 *   --ready`. Todo `error` es `incoherence`: lo que bloquea no se acepta.
 * - `waivable` — solo en `undecided`, y solo para decir `false`: no admite aceptación
 *   porque ahí no existe default seguro y «aceptado» significaría «que lo decida el
 *   generador». Las clases que la doctrina ya fija (gap-analysis.md § severidades: el
 *   orden de las colecciones, la autorización) y aquellas en las que el default del
 *   generador depende del stack o de una heurística sobre un nombre.
 */
export const CHECKS = {
  // ─── domain ────────────────────────────────────────────────────────────────
  'CHK-DOMAIN-SINGLE-ID': {
    layer: 'domain',
    severity: 'error',
    nature: 'incoherence',
    title: 'la entidad no declara exactamente un campo con id: true',
    closes: 'marcar un único campo identificador; para una clave compuesta, persistence.naturalKey'
  },
  'CHK-DOMAIN-COLLECTION-CROSSES-AGGREGATE': {
    layer: 'domain',
    severity: 'warning',
    nature: 'incoherence',
    title: 'colección hacia la raíz de otro agregado: composición encubierta',
    closes: 'referenciar por id y proyectar la lectura conjunta, o unir los dos agregados si de verdad son uno'
  },
  'CHK-DOMAIN-INNER-LIFECYCLE': {
    layer: 'domain',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una entidad interna declara máquina de estados propia, compitiendo con su raíz',
    closes: 'gobernar el estado desde las transiciones de la raíz, o sacar la entidad a su propio agregado'
  },

  'CHK-DOMAIN-STATE-NO-TRANSITIONS': {
    layer: 'domain',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un estado del enum del lifecycle no aparece en transitions',
    closes: 'declararlo en lifecycle.transitions: con sus destinos, o con [] si es terminal'
  },
  'CHK-DOMAIN-ENTITY-NO-AGGREGATE': {
    layer: 'domain',
    severity: 'warning',
    nature: 'incoherence',
    title: 'habiendo agregados, una entidad no pertenece a ninguno',
    closes: 'declararla en el agregado al que pertenece, o como agregado propio con ella de raíz'
  },
  'CHK-DOMAIN-RELATION-TO-INNER': {
    layer: 'domain',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una relación apunta a una entidad interna de otro agregado',
    closes: 'referenciar la raíz de ese agregado por id'
  },
  'CHK-DOMAIN-TRANSITION-UNEXECUTED': {
    layer: 'domain',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una transición del lifecycle que ninguna operación ejecuta',
    closes: 'declararla en el transitions de la operación que la ejecuta, o quitarla del lifecycle si nadie la recorre'
  },

  // ─── service ───────────────────────────────────────────────────────────────
  'CHK-SERVICE-PARAM-UNBACKED': {
    layer: 'service',
    severity: 'warning',
    nature: 'incoherence',
    title: 'la prosa nombra un parámetro de despliegue que el manifiesto no declara',
    closes: 'declararlo en service.parameters (con su testValue), o reescribir la regla si el valor no es configuración'
  },

  // ─── use-cases ─────────────────────────────────────────────────────────────
  'CHK-USECASES-QUERY-EMITS': {
    layer: 'use-cases',
    severity: 'error',
    nature: 'incoherence',
    title: 'una operación kind: query publica eventos',
    closes: 'quitar el emits, o declararla kind: command si de verdad produce un hecho'
  },
  'CHK-USECASES-INPUT-GENERATED': {
    layer: 'use-cases',
    severity: 'error',
    nature: 'incoherence',
    title: 'un campo generated/computed aparece en el input de una operación',
    closes: 'sacarlo del input, o quitarle la marca si de verdad es un dato de entrada'
  },
  'CHK-USECASES-COMMAND-NO-ERRORS': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'undecided',
    title: 'un command expuesto no declara ningún error',
    closes: 'declarar qué contesta el servicio cuando la operación no se puede aplicar'
  },
  'CHK-USECASES-MULTI-AGGREGATE': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una operación mueve el estado de varios agregados a la vez',
    closes: 'dejar que uno se entere por un evento, o revisar la frontera de los agregados'
  },
  // Transversal: la tabla de campos vive en `structural-defaults.js` y el scope nombra el campo,
  // así que se acepta por unidad (`persistence.audit.authorship`, `storage.buckets.<b>.visibility`).
  // Aceptable porque el default está documentado en el schema y es seguro; lo que se pierde sin
  // escribirlo es el rastro de que alguien lo decidió.
  'CHK-MODEL-IMPLICIT-DEFAULT': {
    layer: 'persistence / messaging / storage',
    severity: 'warning',
    nature: 'undecided',
    title: 'un campo del catálogo estructural con default no está escrito: nadie consta que lo decidiera',
    closes: 'escribir el campo explícitamente, aunque sea con el valor por defecto'
  },
  'CHK-MODEL-SENSITIVE-PROJECTED': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'undecided',
    title: 'una salida proyecta un campo que domain marca sensitive',
    closes: 'exclude del campo, o decir en la descripción por qué ese consumidor sí debe verlo'
  },

  'CHK-USECASES-REPEATABLE-ESCAPES': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'undecided',
    title: 'un command repetible por HTTP cuyo efecto sale del proceso no declara guarda',
    closes: 'idempotency en la operación, o una transición de lifecycle que la haga irrepetible'
  },
  'CHK-DEPS-COMPENSATION-DEAD-END': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'una compensación devuelve la entidad a un estado terminal del lifecycle',
    closes: 'elegir el estado del que sí se pueda volver a encargar el trabajo, si eso es lo que el negocio quiere'
  },

  'CHK-API-POST-NO-STATUS': {
    layer: 'api',
    severity: 'warning',
    nature: 'undecided',
    waivable: false,
    title: 'un endpoint POST no declara successStatus',
    closes: 'declarar 201 si crea un recurso, 200 si devuelve un resultado, 202 si responde antes de terminar'
  },
  'CHK-API-NO-SECURITY': {
    layer: 'api',
    severity: 'warning',
    nature: 'undecided',
    // Clase 9 de gap-analysis.md (autorización): no admite «aceptado». Un servicio abierto
    // a propósito lo declara con `access.default: public`, que sigue siendo una línea.
    waivable: false,
    title: 'hay capa api y no hay capa security: ningún endpoint tiene regla de acceso',
    closes: 'declarar la capa security, aunque sea con access.default: public si el servicio es abierto a propósito'
  },
  'CHK-USECASES-COLLECTION-NO-SORT': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'undecided',
    // Clase 5 de gap-analysis.md: el orden de una colección no admite «aceptado». Quien
    // quiere el orden por id lo escribe (`sort: [id]`), y con eso ya está decidido.
    waivable: false,
    title: 'una salida de varios elementos no declara sort',
    closes: "declarar 'sort' en la salida, aunque sea el orden por id"
  },
  'CHK-USECASES-CHILD-NOT-IN-INPUT': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'undecided',
    title: 'el input deriva de una entidad con hijas, y las hijas no viajan en él',
    closes: 'declarar el input con `fields` si la operación recibe las hijas anidadas, o decir que no las recibe'
  },
  'CHK-USECASES-CODE-MULTI-STATUS': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'undecided',
    title: 'el mismo code se declara con status HTTP distintos según la operación',
    closes: 'un status por code, o dejar escrito que el mismo nombre cubre dos situaciones distintas a propósito'
  },
  'CHK-FIELD-COMPARE-NOT-TEXT': {
    layer: 'domain',
    severity: 'error',
    nature: 'incoherence',
    title: '`compare` o `match` sobre un campo que no es texto',
    closes: 'quitarlo: plegar mayúsculas o casar por partes solo tiene sentido en un string o text'
  },
  'CHK-USECASES-MATCH-OUTSIDE-QUERY': {
    layer: 'use-cases',
    severity: 'error',
    nature: 'incoherence',
    title: '`match` fuera del input de una query',
    closes: 'moverlo al filtro de la query: es cómo casa un filtro, y un campo del dominio o de un comando no filtra nada'
  },
  'CHK-DOMAIN-SCALE-POLICY-WITHOUT-SCALE': {
    layer: 'domain',
    severity: 'error',
    nature: 'incoherence',
    title: '`scalePolicy` sin `scale` al lado',
    closes: 'declarar la escala a la que se rechaza o se redondea, o quitar la política'
  },
  'CHK-PERSIST-AUDIT-NESTED': {
    layer: 'persistence',
    severity: 'warning',
    nature: 'undecided',
    title: 'audit: all sobre un modelo documental, donde las entidades anidadas no lo reciben',
    closes: 'declarar los campos de auditoría de la hija en domain (audit: declared), o aceptar que solo se audita la raíz'
  },

  // Migradas de los avisos sin id (R5 de recomendaciones-diseno.md): el mensaje no cambió,
  // solo ganó id, naturaleza y la forma de cerrarse.
  'CHK-USECASES-EXCLUDE-CROSSES-AGGREGATE': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un exclude con dot-path entra en otro agregado, que se serializa por id',
    closes: 'quitar el dot-path: de otro agregado solo viaja el id, no hay campos anidados que excluir'
  },
  'CHK-USECASES-PAGINATED-NO-POLICY': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'undecided',
    title: 'una salida paginated sin política de paginación en api',
    closes: 'api.pagination con style, defaultSize y maxSize'
  },
  'CHK-USECASES-INPUT-UNBOUNDED': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un campo del input con fields no lleva la cota que el dominio le pone',
    closes: 'declarar la cota en el input (constraints o el value type que ya la lleva)'
  },
  'CHK-USECASES-CACHE-ON-COMMAND': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una operación con cache que no es kind: query',
    closes: 'quitar cache, o declararla query si de verdad es una lectura'
  },
  'CHK-USECASES-CACHE-STALE-OWN': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'undecided',
    title: 'la caché de una lectura no se invalida con los eventos que cambian su entidad',
    closes: 'añadir esos eventos a cache.invalidatedBy, o aceptar por escrito el dato viejo hasta el TTL'
  },
  'CHK-USECASES-EMBED-ASYMMETRY': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'undecided',
    title: 'unas salidas de la entidad embeben una relación y otras la devuelven como id plano',
    closes: 'embed en las que falten, o aceptar por escrito que ese listado es más liviano a propósito'
  },
  'CHK-USECASES-FILE-NO-NOT-FOUND': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'undecided',
    title: 'una operación que devuelve un archivo no declara error para la clave que ya no está',
    closes: 'un error 404 (p. ej. FILE_NOT_FOUND) en la operación'
  },
  'CHK-USECASES-ORPHAN-OP': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una operación sin endpoint, suscripción, schedule ni internal: true',
    closes: 'darle su puerta (endpoint, suscripción o schedule), marcarla internal: true, o quitarla'
  },
  'CHK-USECASES-SCHEDULE-NO-EFFECT': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'undecided',
    title: 'un barrido programado sin transitions ni emits: nada que un escenario pueda afirmar',
    closes: 'declarar el efecto (la transición o el evento), o aceptar por escrito que no tiene escenario'
  },
  'CHK-USECASES-IDEMPOTENT-LIST': {
    layer: 'use-cases',
    severity: 'warning',
    nature: 'undecided',
    title: 'una operación idempotente cuya respuesta es una lista o una página',
    closes: 'que devuelva el recurso creado, o aceptar por escrito que la repetición devuelve el estado actual'
  },
  'CHK-API-QUERY-NOT-GET': {
    layer: 'api',
    severity: 'warning',
    nature: 'undecided',
    title: 'una query expuesta con un método distinto de GET',
    closes: 'exponerla con GET, o aceptar por escrito que la entrada no cabe en la URL'
  },
  'CHK-API-COMMAND-GET': {
    layer: 'api',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un command expuesto con GET',
    closes: 'exponerlo con POST, PUT, PATCH o DELETE'
  },
  'CHK-API-BODY-STATUS-ON-VOID': {
    layer: 'api',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un successStatus con cuerpo sobre una operación con output: "void"',
    closes: 'successStatus: 204, o declarar el output'
  },
  'CHK-API-DELETE-NO-STATUS': {
    layer: 'api',
    severity: 'warning',
    nature: 'undecided',
    waivable: false,
    title: 'un DELETE con output sin successStatus: el generador lo daría como 204 y perdería el cuerpo',
    closes: 'declarar el successStatus, o poner output: "void"'
  },

  // ─── security ──────────────────────────────────────────────────────────────
  'CHK-SEC-UNUSED-ROLE': {
    layer: 'security',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un rol declarado que ninguna regla de acceso exige',
    closes: 'quitarlo, o decir qué operación debería pedirlo'
  },
  'CHK-SEC-ORPHAN-PERMISSION': {
    layer: 'security',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un permiso que nadie concede, pide ni exige',
    closes: 'quitarlo, o concederlo a un rol / pedirlo en una regla'
  },
  'CHK-SEC-PUBLIC-COMMAND': {
    layer: 'security',
    severity: 'warning',
    nature: 'undecided',
    title: 'una escritura expuesta con level: public',
    closes: 'subir el nivel de acceso, o dejar escrito por qué es pública a propósito'
  },

  'CHK-SEC-SERVICE-NO-SCOPES': {
    layer: 'security',
    severity: 'warning',
    nature: 'undecided',
    title: "una regla level: service sin scopes: cualquier cliente máquina autenticado la pasa",
    closes: 'los scopes que la regla exige, o aceptar por escrito que vale cualquier cliente'
  },
  'CHK-SEC-SERVICES-PUBLIC': {
    layer: 'security',
    severity: 'warning',
    nature: 'undecided',
    title: "un endpoint audience: services con una regla level: public",
    closes: 'level: service con sus scopes, o aceptar por escrito que no pide credencial de máquina'
  },
  'CHK-SEC-CLIENTS-NO-MACHINE-ENDPOINT': {
    layer: 'security',
    severity: 'warning',
    nature: 'incoherence',
    title: "serviceClients declarados sin ningún endpoint audience: services o both",
    closes: 'exponer a máquinas los endpoints que esos clientes llaman, o quitar los serviceClients'
  },
  'CHK-SEC-CLIENT-SCOPE-UNUSED': {
    layer: 'security',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un serviceClient recibe un scope que ninguna regla exige',
    closes: 'quitárselo (mínimo privilegio), o exigirlo en la regla que lo necesita'
  },
  'CHK-SEC-SCOPE-UNGRANTED': {
    layer: 'security',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un scope que exigen las reglas y no tiene ningún serviceClient',
    closes: 'concedérselo al cliente que llama a esas operaciones'
  },

  // ─── messaging ─────────────────────────────────────────────────────────────
  'CHK-MSG-SUB-NO-ONFAILURE': {
    layer: 'messaging',
    severity: 'warning',
    nature: 'undecided',
    waivable: false,
    title: 'una suscripción no declara onFailure',
    closes: 'declarar reintentos y destino de descarte en vez de heredar el default del broker'
  },
  'CHK-MSG-NO-SCHEMAREF': {
    layer: 'messaging',
    severity: 'warning',
    nature: 'undecided',
    waivable: false,
    title: 'un formato con schema registrado (avro/protobuf) sin schemaRef',
    closes: 'declarar dónde se resuelve el schema'
  },
  'CHK-MSG-KEEL-ENVELOPE-EXTERNAL': {
    layer: 'messaging',
    severity: 'warning',
    nature: 'incoherence',
    title: 'envelope: keel sobre un canal que posee otro sistema',
    closes: 'declarar la envoltura real de la fuente, salvo que también sea un servicio Keel'
  },
  'CHK-MSG-CHANNEL-TECH-NAME': {
    layer: 'messaging',
    severity: 'warning',
    nature: 'incoherence',
    title: 'el nombre de un canal filtra la tecnología del broker',
    closes: 'nombrarlo por lo que transporta: es el contrato que conoce quien escucha'
  },

  'CHK-MSG-PUBLISH-EXTERNAL': {
    layer: 'messaging',
    severity: 'warning',
    nature: 'undecided',
    title: 'se publica en un canal external, que posee otro sistema',
    closes: 'publicar en un canal propio, o aceptar por escrito el acuerdo con su dueño'
  },
  'CHK-MSG-SHARED-CHANNEL-NO-DISCRIMINATOR': {
    layer: 'messaging',
    severity: 'warning',
    nature: 'undecided',
    waivable: false,
    title: 'varias suscripciones comparten canal sin envoltura Keel y esta no declara discriminator',
    closes: 'contract.discriminator con el dato que distingue sus mensajes'
  },
  'CHK-MSG-EXTERNAL-NO-CONTRACT': {
    layer: 'messaging',
    severity: 'warning',
    nature: 'undecided',
    waivable: false,
    title: 'una suscripción a un canal external sin contract: la forma del mensaje la supondría el generador',
    closes: 'contract con envelope, formato, discriminador e id de deduplicación de la fuente'
  },
  'CHK-MSG-KEEL-MESSAGEID': {
    layer: 'messaging',
    severity: 'warning',
    nature: 'incoherence',
    title: 'contract.messageId con envoltura keel, cuya identidad ya es metadata.eventId',
    closes: 'quitar contract.messageId: con envelope keel sobra'
  },
  'CHK-MSG-CONTRACT-FIELD-ASSUMED': {
    layer: 'messaging',
    severity: 'warning',
    nature: 'undecided',
    title: 'un discriminator o messageId de campo que no está en el payload: se asume que va en la envoltura',
    closes: 'declarar el campo en el payload, o aceptar por escrito que vive en la envoltura de la fuente'
  },
  'CHK-MSG-PAYLOAD-FIELD-UNUSED': {
    layer: 'messaging',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un campo del payload de una suscripción que no alimenta el input de la operación',
    closes: 'mapearlo en input, o quitarlo del payload'
  },
  'CHK-MSG-EVENT-NOT-EMITTED': {
    layer: 'messaging',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un evento publicado que ninguna operación emite',
    closes: 'emits en la operación que causa el hecho, o quitar el evento'
  },
  'CHK-MSG-SOURCE-UNDECLARED': {
    layer: 'messaging',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una suscripción fact cuyo source no está declarado en dependencies',
    closes: 'declarar la dependencia, o nature: request si es una petición dirigida a este servicio'
  },
  'CHK-MSG-CHANNEL-UNUSED': {
    layer: 'messaging',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un canal que ningún evento ni suscripción referencia',
    closes: 'referenciarlo desde su evento o suscripción, o quitarlo'
  },

  // ─── http-clients ──────────────────────────────────────────────────────────
  'CHK-HTTP-NO-TIMEOUT': {
    layer: 'http-clients',
    severity: 'warning',
    nature: 'undecided',
    waivable: false,
    title: 'una llamada saliente no declara timeoutMs',
    closes: 'declarar cuánto puede esperar quien llama; de ahí cuelgan el retry y el breaker'
  },
  'CHK-HTTP-PATH-NO-PARAMS': {
    layer: 'http-clients',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un path con variables {…} sin request.pathParams',
    closes: 'declarar request.pathParams con cada variable del path'
  },
  'CHK-HTTP-TYPED-NO-ROUTE': {
    layer: 'http-clients',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una llamada con request/response tipados pero sin method y path',
    closes: 'declarar method y path, para que el generador no tenga que leer la prosa del contract'
  },
  'CHK-HTTP-BREAKER-NO-FALLBACK': {
    layer: 'http-clients',
    severity: 'warning',
    nature: 'undecided',
    title: 'un circuitBreaker sin fallback: no está dicho qué hace el servicio con el circuito abierto',
    closes: 'declarar fallback, o aceptar por escrito que con el circuito abierto se falla'
  },
  'CHK-HTTP-RETRY-UNSAFE': {
    layer: 'http-clients',
    severity: 'warning',
    nature: 'undecided',
    title: 'se reintenta una escritura ajena sin idempotency: cada reintento repite el trabajo',
    closes: 'idempotency.keyFrom en la llamada, o aceptar por escrito (y en el contract) que reintentar duplica'
  },
  'CHK-HTTP-IDEMPOTENCY-ON-GET': {
    layer: 'http-clients',
    severity: 'warning',
    nature: 'incoherence',
    title: 'idempotency en una llamada GET, que no duplica nada',
    closes: 'quitar idempotency de la llamada'
  },
  'CHK-HTTP-CLIENT-UNUSED': {
    layer: 'http-clients',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un cliente HTTP que ningún need ni activación de dependencies usa',
    closes: 'citarlo desde la dependencia a la que pertenece, o quitarlo'
  },

  // ─── persistence ───────────────────────────────────────────────────────────
  'CHK-PERSIST-ROOT-UNMAPPED': {
    layer: 'persistence',
    severity: 'warning',
    nature: 'undecided',
    title: 'una raíz de agregado del dominio no aparece en persistence.entities',
    closes: 'declararla, o dejar escrito por qué no se persiste'
  },
  'CHK-PERSIST-BOUNDARY-DEFAULT': {
    layer: 'persistence',
    severity: 'warning',
    nature: 'undecided',
    title: 'per-operation habiendo agregados declarados',
    closes: 'elegir per-aggregate, o dejar escrito que la transacción abarca varios a propósito'
  },
  'CHK-PERSIST-CONDITIONAL-UNIQUE-CODE': {
    layer: 'persistence',
    severity: 'warning',
    nature: 'undecided',
    title: 'un índice único condicionado sin un `code` que diga qué significa violarlo',
    closes: 'declarar en la operación que escribe esa entidad un error 409 cuyo code nombre la condición (su familia la da el estado o el campo de `when`)'
  },
  'CHK-PERSIST-CHILD-UNIQUE-CODE': {
    layer: 'persistence',
    severity: 'warning',
    nature: 'undecided',
    title: 'un índice único acotado a la colección de una raíz sin un `code` que diga qué significa violarlo',
    closes: 'declarar en la operación que escribe esa entidad un error 409 que nombre el conflicto dentro del padre, o dejarlo y asumir que el choque se trata como carrera'
  },

  'CHK-PERSIST-COMPUTED-NATURAL-KEY': {
    layer: 'persistence',
    severity: 'warning',
    nature: 'undecided',
    title: 'la naturalKey de una entidad interna incluye un campo computed que se recalcula en masa',
    closes: 'quitar el campo de la naturalKey, o aceptar por escrito que el recálculo no pasa por un estado intermedio duplicado'
  },
  'CHK-PERSIST-DECLARED-NO-LOCKVERSION': {
    layer: 'persistence',
    severity: 'warning',
    nature: 'incoherence',
    title: "optimisticLocking: declared sin ninguna raíz con lockVersion: equivale a none",
    closes: "declarar lockVersion en las raíces donde el conflicto deba verse, o usar 'all' / 'none' explícitamente"
  },
  'CHK-DEPS-CLOCK-NOT-OBSERVABLE': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'la marca de la espera que el barrido lee no la proyecta ninguna salida',
    closes: 'sacarla de `output.exclude` en alguna operación, o aceptar que su único gate es estático'
  },
  'CHK-DEPS-NEED-NO-ONUNAVAILABLE': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: "una necesidad servida por un cliente HTTP no declara 'onUnavailable'",
    closes: 'decidir qué ve el cliente con el proveedor caído: fallar con un error propio, degradar o servir el último valor conocido con su edad máxima'
  },
  'CHK-DEPS-EXPOSED-ON-DEMAND-LIST': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'un dato on-demand expuesto en un listado: una llamada al proveedor por elemento',
    closes: "strategy: replicated, o aceptar por escrito el coste por elemento"
  },
  'CHK-DEPS-REPLICA-KEY-NOT-UNIQUE': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'incoherence',
    title: 'el keyField de una réplica no es unique en su entidad',
    closes: 'unique: true en el campo que correlaciona la copia con el proveedor'
  },
  'CHK-DEPS-REPLICA-UNPERSISTED': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'incoherence',
    title: 'la entidad de una réplica no aparece en persistence',
    closes: 'declararla en persistence.entities'
  },
  'CHK-DEPS-REPLICA-DUPLICATED': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'incoherence',
    title: 'dos needs replican la misma entidad',
    closes: 'una sola réplica por entidad, que sirva a los dos usos'
  },
  'CHK-DEPS-ERROR-NOT-IN-OPS': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'incoherence',
    title: 'el error de un need o de una activación no lo declara ninguna de las operaciones que la usan',
    closes: 'declarar ese code en las operaciones de usedBy / triggeredBy'
  },
  'CHK-DEPS-SOURCE-MISMATCH': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una réplica se alimenta de un evento cuyo source no es la dependencia',
    closes: 'que la suscripción declare como source a ese proveedor, o mover la réplica a la dependencia correcta'
  },
  'CHK-DEPS-PUBLISH-WITHOUT-OUTBOX': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'un encargo que viaja publicando con reliability best-effort: con el broker caído se pierde',
    closes: 'publishing.reliability: outbox, o aceptar por escrito que el encargo puede perderse'
  },
  'CHK-DEPS-NO-UNANSWERED-AFTER': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'una reconciliación sin unansweredAfterSeconds: el umbral de silencio no está decidido',
    closes: 'declarar unansweredAfterSeconds'
  },
  'CHK-DEPS-RECONCILE-NO-WAIT-STATE': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una reconciliación sin estado de espera: ninguna operación que encarga mueve un lifecycle',
    closes: 'la transición que deja la entidad esperando, o quitar reconciledBy si el desenlace se conoce en el acto'
  },
  'CHK-DEPS-AWAITING-CREATEDAT': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'la marca de espera es createdAt: mide desde que nació la entidad, no desde el encargo',
    closes: 'un campo propio que estampe la operación que encarga, o aceptar por escrito que las dos cosas ocurren a la vez'
  },
  'CHK-DEPS-RECONCILE-UNLINKED': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'incoherence',
    title: 'el barrido de reconciliación no toca lo que reconcilia',
    closes: 'la transición de salida sobre la entidad que espera, o el reintento o la compensación del encargo'
  },
  'CHK-DEPS-RECONCILE-NO-INDEX': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'el barrido busca por el estado de espera y ningún índice empieza por ese campo',
    closes: 'un índice [estado, marca de espera] en persistence, o aceptar por escrito el recorrido completo'
  },
  'CHK-DEPS-COMPENSATION-EXTERNAL-NO-MESSAGEID': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'una compensación sobre canal externo que solo frena la reentrega con el guard de lifecycle',
    closes: 'contract.messageId en la suscripción, o aceptar por escrito que cada reentrega acaba en la DLQ'
  },
  'CHK-DEPS-COMPENSATION-NO-RETRY': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'la suscripción de una compensación no reintenta: una llegada fuera de orden va a la DLQ',
    closes: 'onFailure.retry con backoff, o aceptar por escrito la intervención manual'
  },
  'CHK-DEPS-COMPENSATION-SILENCE': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'el encargo compensado no tiene reconciliación: si el evento de fallo no llega, nadie lo deshace',
    closes: 'reconciledBy en la activación que se deshace, o aceptar por escrito esa deuda'
  },
  'CHK-DEPS-COMPENSATION-DLQ-NO-RERUN': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'lo que la compensación manda a la DLQ no tiene forma declarada de reejecutarse',
    closes: 'exponer la operación por HTTP o declarar una reconciliación que lo barra, o aceptar por escrito la vía manual'
  },
  'CHK-DEPS-COMPENSATION-NO-RESTORE': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'la compensación no devuelve el estado que movió el encargo que deshace',
    closes: 'la transición de vuelta en la operación compensadora'
  },
  'CHK-DEPS-COMPENSATION-PROVIDER-UNTOLD': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'el fallo lo publica un tercero y nada en el diseño se lo dice al proveedor del encargo',
    closes: 'la activación de vuelta con triggeredBy de la operación compensadora, o aceptar por escrito esa deuda'
  },
  'CHK-DEPS-SAGA-INCOMPLETE': {
    layer: 'dependencies',
    severity: 'warning',
    nature: 'undecided',
    title: 'una operación encarga a varios proveedores y solo declara cómo deshacer parte',
    closes: 'la compensación de los encargos que faltan, o aceptar por escrito esa deuda'
  },

  // ─── escenarios de validación ──────────────────────────────────────────────
  // Todas AVISO, sin excepción. El sujeto es un documento en prosa: lo que se busca es
  // una señal, y no encontrarla nunca demuestra que no está. Es la misma regla que
  // gobierna las nueve comprobaciones que ya leían este archivo, razonada en
  // `docs/validation-scenarios.md § Lo que se comprueba solo`. La matriz de cobertura es
  // markdown estructurado y tienta a subirla a error; no se hace, porque un documento con
  // otro formato dejaría de poder generarse por una tabla.
  'CHK-SCEN-MATRIX-MISSING-OP': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una operación del diseño no aparece en la matriz de cobertura',
    closes: 'añadir su fila con los flujos que la ejercitan, o escribir el flujo que falta'
  },
  'CHK-SCEN-MATRIX-UNKNOWN-OP': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'la matriz nombra una operación que el diseño no declara',
    closes: 'corregir el nombre, o quitar la fila si la operación desapareció del diseño'
  },
  'CHK-SCEN-MATRIX-DANGLING-FL': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'la matriz cita un flujo que ningún escenario define',
    closes: 'escribir el escenario, o corregir el id en la matriz'
  },
  'CHK-SCEN-ERROR-UNCOVERED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un `error` declarado no aparece en ningún escenario',
    closes: 'un caso borde que lo provoque, con su code y su status'
  },
  'CHK-SCEN-UNOBSERVABLE-RETRY': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un `Then` afirma que NO hubo reintentos, que desde fuera no se ve',
    closes: 'dejar la mitad observable (que no hay descarte) y quitar la que no lo es'
  },
  'CHK-SCEN-STATE-UNREACHED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un estado del lifecycle que ningún escenario alcanza',
    closes: 'el escenario que lleva la entidad a ese estado, o revisar si el estado sobra'
  },
  'CHK-SCEN-OP-COUNT': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un `Then` cuenta las operaciones bajo una ruta y la cuenta no casa con `api`',
    closes: 'corregir el número, o nombrar las operaciones en vez de contarlas'
  },
  'CHK-SCEN-EVENT-PAYLOAD-PARTIAL': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un `Then` enumera el payload de un evento y se deja campos que `messaging` declara',
    closes: 'nombrar los que faltan con su valor, o decir expresamente que no viajan'
  },
  'CHK-SCEN-ORDER-BY-MUTATED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un `Then` afirma una posición en un listado ordenado por un campo que cambia con cada escritura',
    closes: 'que el Given diga en qué orden ocurre la ÚLTIMA escritura de cada fila, no solo en qué orden se crearon'
  },
  'CHK-SCEN-CONVENTION-UNBACKED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una convención de determinación dicha en prosa que el YAML no declara (o contradice)',
    closes: 'declararla en la propiedad del DSL que la sostiene, para que el generador la vea'
  },

  // Las señales de MECANISMO: cada una busca en el texto el escenario que distingue la garantía
  // de su ausencia (el canal caído, la carrera, la segunda réplica…). Todas son aviso, como
  // todo lo que lee este documento, e incoherencia: se cierran escribiendo el escenario.
  'CHK-SCEN-OUTBOX-UNAVAILABLE': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: "reliability: outbox sin escenario con el canal indisponible",
    closes: 'un escenario que, con el canal caído, afirme que la mutación responde igual y el evento llega una vez al volver'
  },
  'CHK-SCEN-OUTBOX-EXHAUSTED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: "reliability: outbox sin escenario del evento que el relay abandona",
    closes: 'un escenario que agote los reintentos del relay y afirme que el servidor lo dice y el evento no sale'
  },
  'CHK-SCEN-RESCUE-UNCOVERED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un barrido que saca filas de un estado en vuelo sin escenario de rescate',
    closes: 'los dos escenarios: el que rescata la fila atascada y el que deja en paz la recién entrada'
  },
  'CHK-SCEN-RECONCILE-EXPIRED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una reconciliación sin escenario de espera agotada',
    closes: 'un escenario que fabrique el silencio del proveedor y afirme las dos mitades de rendirse'
  },
  'CHK-SCEN-IDEM-RACE': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una operación idempotente sin escenario de dos peticiones a la vez con la misma clave',
    closes: 'un escenario de carrera: disyunción cerrada de resultados más un conteo que afirme un solo recurso'
  },
  'CHK-SCEN-CLUSTER-UNCOVERED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un barrido cuyo duplicado es observable sin escenario con dos instancias',
    closes: 'un escenario con varias filas, dos réplicas vivas y un Then que cuente el efecto una vez por fila'
  },
  'CHK-SCEN-REDELIVERY-UNCOVERED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una suscripción con guarda contra la reentrega sin escenario que reentregue',
    closes: 'un escenario que entregue el mismo messageId otra vez y afirme que no hay segundo efecto'
  },
  'CHK-SCEN-COMPENSATION-UNCOVERED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'una compensación cuyo evento no nombra ningún escenario',
    closes: 'los tres escenarios: el efecto completo, la reentrega sin segundo efecto y la doble entrega simultánea'
  },
  'CHK-SCEN-COMPENSATION-NO-REDELIVERY': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'los escenarios de una compensación no cubren la reentrega',
    closes: 'un escenario que entregue el mismo mensaje otra vez y afirme que no hay segundo efecto'
  },
  'CHK-SCEN-COMPENSATION-NO-CONCURRENT': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'los escenarios de una compensación no cubren la doble entrega simultánea',
    closes: 'un escenario que entregue el mismo mensaje dos veces a la vez y afirme el mismo efecto único'
  },
  'CHK-SCEN-UNDECLARED-CLIENT': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un escenario nombra un cliente máquina que serviceClients no declara',
    closes: 'declarar ese serviceClient con su mínimo privilegio, o corregir la prosa para que nombre uno declarado'
  },
  'CHK-SCEN-UNDECLARED-ROLE': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un escenario nombra un rol que security.roles no declara',
    closes: 'declarar el rol, o corregir la prosa para que nombre uno declarado'
  },

  'CHK-SCEN-FLOW-REVIEW-EXHAUSTED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'el careo agotó su presupuesto de pasadas y sigue habiendo hallazgos abiertos',
    closes: 'decidir cada hallazgo (scenario, design o accepted con su motivo) — no lanzar otra pasada: si siguen saliendo clases nuevas, el diseño no está listo para cerrarse'
  },
  'CHK-SCEN-FLOW-REVIEW-STALE': {
    layer: 'validation-scenarios',
    severity: 'warning',
    nature: 'incoherence',
    title: 'el careo de flujos falta, se hizo sobre otros escenarios o tiene hallazgos sin resolver',
    closes: 'lanzar el agente keel-flow-review y decidir cada hallazgo en flow-review.yaml (scenario, design o accepted con su motivo)'
  },

  // ─── contratos derivados (/keel-docs) ──────────────────────────────────────
  // AVISO: un derivado desviado se regenera, no bloquea el diseño del que salió.
  'CHK-DOCS-OPENAPI-DRIFT': {
    layer: 'docs',
    severity: 'warning',
    nature: 'incoherence',
    title: 'openapi.yaml no dice lo mismo que api y use-cases (rutas, métodos, status)',
    closes: 'regenerarlo con /keel-docs; si la desviación es deliberada, el que cambia es el diseño'
  },
  'CHK-DOCS-ASYNCAPI-DRIFT': {
    layer: 'docs',
    severity: 'warning',
    nature: 'incoherence',
    title: 'asyncapi.yaml no dice lo mismo que messaging (canales, eventos, campos del payload)',
    closes: 'regenerarlo con /keel-docs'
  },
  'CHK-DOCS-POSTMAN-DRIFT': {
    layer: 'docs',
    severity: 'warning',
    nature: 'incoherence',
    title: 'la colección Postman no casa con los flujos o afirma un status que el endpoint no puede dar',
    closes: 'regenerarla con /keel-docs: una carpeta por flujo, y cada request con el status de SU paso'
  },

  // ─── storage ───────────────────────────────────────────────────────────────
  'CHK-STORAGE-NO-MAXSIZE': {
    layer: 'storage',
    severity: 'warning',
    nature: 'undecided',
    waivable: false,
    title: 'un bucket no declara maxSizeMb',
    closes: 'declarar el tope: es la otra mitad del contrato de subida que ya declara allowedContentTypes'
  },
  'CHK-STORAGE-BUCKET-UNUSED': {
    layer: 'storage',
    severity: 'warning',
    nature: 'incoherence',
    title: 'un bucket que ningún campo file referencia',
    closes: 'referenciarlo desde el campo file que lo usa, o quitarlo'
  },
  'CHK-STORAGE-NO-SIGNED-TTL': {
    layer: 'storage',
    severity: 'warning',
    nature: 'undecided',
    title: 'un bucket private sin signedUrlTtlSeconds: la caducidad del enlace firmado no está decidida',
    closes: 'declarar signedUrlTtlSeconds'
  },

  // ─── mail ──────────────────────────────────────────────────────────────────
  'CHK-MAIL-OP-UNGUARDED': {
    layer: 'mail',
    severity: 'warning',
    nature: 'undecided',
    title: 'una operación que manda correo sin idempotency ni transición: repetirla manda dos',
    closes: 'idempotency en la operación o una transición que la haga irrepetible, o aceptar por escrito el duplicado'
  },
  'CHK-MAIL-SENDER-NO-FALLBACK': {
    layer: 'mail',
    severity: 'warning',
    nature: 'undecided',
    title: "sender: data sin fallback: si el dato no resuelve, el correo no sale",
    closes: 'declarar sender.fallback, o aceptar por escrito que se falla cerrado'
  },
  'CHK-MAIL-HTML-NO-TEXT': {
    layer: 'mail',
    severity: 'warning',
    nature: 'undecided',
    title: "delivery.parts con html y sin text: los filtros antispam lo penalizan",
    closes: "añadir 'text' a delivery.parts, o aceptar por escrito el riesgo"
  },
  'CHK-MAIL-NO-DECLARED-VARIABLES': {
    layer: 'mail',
    severity: 'warning',
    nature: 'undecided',
    title: "templating: data sin declaredVariables: una variable que falte sale como hueco",
    closes: 'templating.declaredVariables: true, o aceptar por escrito que no se valida'
  }
};

export const checkIds = () => Object.keys(CHECKS);

export function checkFor(id) {
  return CHECKS[id];
}
