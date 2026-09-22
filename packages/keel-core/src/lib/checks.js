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
//      significa afirmar sobre substrings que se rompen al retocar una coma.
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
 */
export const CHECKS = {
  // ─── domain ────────────────────────────────────────────────────────────────
  'CHK-DOMAIN-SINGLE-ID': {
    layer: 'domain',
    severity: 'error',
    title: 'la entidad no declara exactamente un campo con id: true',
    closes: 'marcar un único campo identificador; para una clave compuesta, persistence.naturalKey'
  },
  'CHK-DOMAIN-COLLECTION-CROSSES-AGGREGATE': {
    layer: 'domain',
    severity: 'warning',
    title: 'colección hacia la raíz de otro agregado: composición encubierta',
    closes: 'referenciar por id y proyectar la lectura conjunta, o unir los dos agregados si de verdad son uno'
  },
  'CHK-DOMAIN-INNER-LIFECYCLE': {
    layer: 'domain',
    severity: 'warning',
    title: 'una entidad interna declara máquina de estados propia, compitiendo con su raíz',
    closes: 'gobernar el estado desde las transiciones de la raíz, o sacar la entidad a su propio agregado'
  },

  // ─── service ───────────────────────────────────────────────────────────────
  'CHK-SERVICE-PARAM-UNBACKED': {
    layer: 'service',
    severity: 'warning',
    title: 'la prosa nombra un parámetro de despliegue que el manifiesto no declara',
    closes: 'declararlo en service.parameters (con su testValue), o reescribir la regla si el valor no es configuración'
  },

  // ─── use-cases ─────────────────────────────────────────────────────────────
  'CHK-USECASES-QUERY-EMITS': {
    layer: 'use-cases',
    severity: 'error',
    title: 'una operación kind: query publica eventos',
    closes: 'quitar el emits, o declararla kind: command si de verdad produce un hecho'
  },
  'CHK-USECASES-INPUT-GENERATED': {
    layer: 'use-cases',
    severity: 'error',
    title: 'un campo generated/computed aparece en el input de una operación',
    closes: 'sacarlo del input, o quitarle la marca si de verdad es un dato de entrada'
  },
  'CHK-USECASES-COMMAND-NO-ERRORS': {
    layer: 'use-cases',
    severity: 'warning',
    title: 'un command expuesto no declara ningún error',
    closes: 'declarar qué contesta el servicio cuando la operación no se puede aplicar'
  },
  'CHK-USECASES-MULTI-AGGREGATE': {
    layer: 'use-cases',
    severity: 'warning',
    title: 'una operación mueve el estado de varios agregados a la vez',
    closes: 'dejar que uno se entere por un evento, o revisar la frontera de los agregados'
  },
  'CHK-MODEL-SENSITIVE-PROJECTED': {
    layer: 'use-cases',
    severity: 'warning',
    title: 'una salida proyecta un campo que domain marca sensitive',
    closes: 'exclude del campo, o decir en la descripción por qué ese consumidor sí debe verlo'
  },

  'CHK-USECASES-REPEATABLE-ESCAPES': {
    layer: 'use-cases',
    severity: 'warning',
    title: 'un command repetible por HTTP cuyo efecto sale del proceso no declara guarda',
    closes: 'idempotency en la operación, o una transición de lifecycle que la haga irrepetible'
  },
  'CHK-DEPS-COMPENSATION-DEAD-END': {
    layer: 'dependencies',
    severity: 'warning',
    title: 'una compensación devuelve la entidad a un estado terminal del lifecycle',
    closes: 'elegir el estado del que sí se pueda volver a encargar el trabajo, si eso es lo que el negocio quiere'
  },

  'CHK-API-POST-NO-STATUS': {
    layer: 'api',
    severity: 'warning',
    title: 'un endpoint POST no declara successStatus',
    closes: 'declarar 201 si crea un recurso, 200 si devuelve un resultado, 202 si responde antes de terminar'
  },
  'CHK-USECASES-CHILD-NOT-IN-INPUT': {
    layer: 'use-cases',
    severity: 'warning',
    title: 'el input deriva de una entidad con hijas, y las hijas no viajan en él',
    closes: 'declarar el input con `fields` si la operación recibe las hijas anidadas, o decir que no las recibe'
  },
  'CHK-USECASES-CODE-MULTI-STATUS': {
    layer: 'use-cases',
    severity: 'warning',
    title: 'el mismo code se declara con status HTTP distintos según la operación',
    closes: 'un status por code, o dejar escrito que el mismo nombre cubre dos situaciones distintas a propósito'
  },
  'CHK-FIELD-COMPARE-NOT-TEXT': {
    layer: 'domain',
    severity: 'error',
    title: '`compare` o `match` sobre un campo que no es texto',
    closes: 'quitarlo: plegar mayúsculas o casar por partes solo tiene sentido en un string o text'
  },
  'CHK-USECASES-MATCH-OUTSIDE-QUERY': {
    layer: 'use-cases',
    severity: 'error',
    title: '`match` fuera del input de una query',
    closes: 'moverlo al filtro de la query: es cómo casa un filtro, y un campo del dominio o de un comando no filtra nada'
  },
  'CHK-DOMAIN-SCALE-POLICY-WITHOUT-SCALE': {
    layer: 'domain',
    severity: 'error',
    title: '`scalePolicy` sin `scale` al lado',
    closes: 'declarar la escala a la que se rechaza o se redondea, o quitar la política'
  },
  'CHK-PERSIST-AUDIT-NESTED': {
    layer: 'persistence',
    severity: 'warning',
    title: 'audit: all sobre un modelo documental, donde las entidades anidadas no lo reciben',
    closes: 'declarar los campos de auditoría de la hija en domain (audit: declared), o aceptar que solo se audita la raíz'
  },

  // ─── security ──────────────────────────────────────────────────────────────
  'CHK-SEC-UNUSED-ROLE': {
    layer: 'security',
    severity: 'warning',
    title: 'un rol declarado que ninguna regla de acceso exige',
    closes: 'quitarlo, o decir qué operación debería pedirlo'
  },
  'CHK-SEC-ORPHAN-PERMISSION': {
    layer: 'security',
    severity: 'warning',
    title: 'un permiso que nadie concede, pide ni exige',
    closes: 'quitarlo, o concederlo a un rol / pedirlo en una regla'
  },
  'CHK-SEC-PUBLIC-COMMAND': {
    layer: 'security',
    severity: 'warning',
    title: 'una escritura expuesta con level: public',
    closes: 'subir el nivel de acceso, o dejar escrito por qué es pública a propósito'
  },

  // ─── messaging ─────────────────────────────────────────────────────────────
  'CHK-MSG-SUB-NO-ONFAILURE': {
    layer: 'messaging',
    severity: 'warning',
    title: 'una suscripción no declara onFailure',
    closes: 'declarar reintentos y destino de descarte en vez de heredar el default del broker'
  },
  'CHK-MSG-NO-SCHEMAREF': {
    layer: 'messaging',
    severity: 'warning',
    title: 'un formato con schema registrado (avro/protobuf) sin schemaRef',
    closes: 'declarar dónde se resuelve el schema'
  },
  'CHK-MSG-KEEL-ENVELOPE-EXTERNAL': {
    layer: 'messaging',
    severity: 'warning',
    title: 'envelope: keel sobre un canal que posee otro sistema',
    closes: 'declarar la envoltura real de la fuente, salvo que también sea un servicio Keel'
  },
  'CHK-MSG-CHANNEL-TECH-NAME': {
    layer: 'messaging',
    severity: 'warning',
    title: 'el nombre de un canal filtra la tecnología del broker',
    closes: 'nombrarlo por lo que transporta: es el contrato que conoce quien escucha'
  },

  // ─── http-clients ──────────────────────────────────────────────────────────
  'CHK-HTTP-NO-TIMEOUT': {
    layer: 'http-clients',
    severity: 'warning',
    title: 'una llamada saliente no declara timeoutMs',
    closes: 'declarar cuánto puede esperar quien llama; de ahí cuelgan el retry y el breaker'
  },

  // ─── persistence ───────────────────────────────────────────────────────────
  'CHK-PERSIST-ROOT-UNMAPPED': {
    layer: 'persistence',
    severity: 'warning',
    title: 'una raíz de agregado del dominio no aparece en persistence.entities',
    closes: 'declararla, o dejar escrito por qué no se persiste'
  },
  'CHK-PERSIST-BOUNDARY-DEFAULT': {
    layer: 'persistence',
    severity: 'warning',
    title: 'per-operation habiendo agregados declarados',
    closes: 'elegir per-aggregate, o dejar escrito que la transacción abarca varios a propósito'
  },
  'CHK-PERSIST-CONDITIONAL-UNIQUE-CODE': {
    layer: 'persistence',
    severity: 'warning',
    title: 'un índice único condicionado sin un `code` que diga qué significa violarlo',
    closes: 'declarar en la operación que escribe esa entidad un error 409 cuyo code nombre la condición (su familia la da el estado o el campo de `when`)'
  },
  'CHK-PERSIST-CHILD-UNIQUE-CODE': {
    layer: 'persistence',
    severity: 'warning',
    title: 'un índice único acotado a la colección de una raíz sin un `code` que diga qué significa violarlo',
    closes: 'declarar en la operación que escribe esa entidad un error 409 que nombre el conflicto dentro del padre, o dejarlo y asumir que el choque se trata como carrera'
  },

  'CHK-DEPS-CLOCK-NOT-OBSERVABLE': {
    layer: 'dependencies',
    severity: 'warning',
    title: 'la marca de la espera que el barrido lee no la proyecta ninguna salida',
    closes: 'sacarla de `output.exclude` en alguna operación, o aceptar que su único gate es estático'
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
    title: 'una operación del diseño no aparece en la matriz de cobertura',
    closes: 'añadir su fila con los flujos que la ejercitan, o escribir el flujo que falta'
  },
  'CHK-SCEN-MATRIX-UNKNOWN-OP': {
    layer: 'validation-scenarios',
    severity: 'warning',
    title: 'la matriz nombra una operación que el diseño no declara',
    closes: 'corregir el nombre, o quitar la fila si la operación desapareció del diseño'
  },
  'CHK-SCEN-MATRIX-DANGLING-FL': {
    layer: 'validation-scenarios',
    severity: 'warning',
    title: 'la matriz cita un flujo que ningún escenario define',
    closes: 'escribir el escenario, o corregir el id en la matriz'
  },
  'CHK-SCEN-ERROR-UNCOVERED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    title: 'un `error` declarado no aparece en ningún escenario',
    closes: 'un caso borde que lo provoque, con su code y su status'
  },
  'CHK-SCEN-UNOBSERVABLE-RETRY': {
    layer: 'validation-scenarios',
    severity: 'warning',
    title: 'un `Then` afirma que NO hubo reintentos, que desde fuera no se ve',
    closes: 'dejar la mitad observable (que no hay descarte) y quitar la que no lo es'
  },
  'CHK-SCEN-STATE-UNREACHED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    title: 'un estado del lifecycle que ningún escenario alcanza',
    closes: 'el escenario que lleva la entidad a ese estado, o revisar si el estado sobra'
  },
  'CHK-SCEN-OP-COUNT': {
    layer: 'validation-scenarios',
    severity: 'warning',
    title: 'un `Then` cuenta las operaciones bajo una ruta y la cuenta no casa con `api`',
    closes: 'corregir el número, o nombrar las operaciones en vez de contarlas'
  },
  'CHK-SCEN-EVENT-PAYLOAD-PARTIAL': {
    layer: 'validation-scenarios',
    severity: 'warning',
    title: 'un `Then` enumera el payload de un evento y se deja campos que `messaging` declara',
    closes: 'nombrar los que faltan con su valor, o decir expresamente que no viajan'
  },
  'CHK-SCEN-ORDER-BY-MUTATED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    title: 'un `Then` afirma una posición en un listado ordenado por un campo que cambia con cada escritura',
    closes: 'que el Given diga en qué orden ocurre la ÚLTIMA escritura de cada fila, no solo en qué orden se crearon'
  },
  'CHK-SCEN-CONVENTION-UNBACKED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    title: 'una convención de determinación dicha en prosa que el YAML no declara (o contradice)',
    closes: 'declararla en la propiedad del DSL que la sostiene, para que el generador la vea'
  },

  'CHK-SCEN-FLOW-REVIEW-EXHAUSTED': {
    layer: 'validation-scenarios',
    severity: 'warning',
    title: 'el careo agotó su presupuesto de pasadas y sigue habiendo hallazgos abiertos',
    closes: 'decidir cada hallazgo (scenario, design o accepted con su motivo) — no lanzar otra pasada: si siguen saliendo clases nuevas, el diseño no está listo para cerrarse'
  },
  'CHK-SCEN-FLOW-REVIEW-STALE': {
    layer: 'validation-scenarios',
    severity: 'warning',
    title: 'el careo de flujos falta, se hizo sobre otros escenarios o tiene hallazgos sin resolver',
    closes: 'lanzar el agente keel-flow-review y decidir cada hallazgo en flow-review.yaml (scenario, design o accepted con su motivo)'
  },

  // ─── contratos derivados (/keel-docs) ──────────────────────────────────────
  // AVISO: un derivado desviado se regenera, no bloquea el diseño del que salió.
  'CHK-DOCS-OPENAPI-DRIFT': {
    layer: 'docs',
    severity: 'warning',
    title: 'openapi.yaml no dice lo mismo que api y use-cases (rutas, métodos, status)',
    closes: 'regenerarlo con /keel-docs; si la desviación es deliberada, el que cambia es el diseño'
  },
  'CHK-DOCS-ASYNCAPI-DRIFT': {
    layer: 'docs',
    severity: 'warning',
    title: 'asyncapi.yaml no dice lo mismo que messaging (canales, eventos, campos del payload)',
    closes: 'regenerarlo con /keel-docs'
  },
  'CHK-DOCS-POSTMAN-DRIFT': {
    layer: 'docs',
    severity: 'warning',
    title: 'la colección Postman no casa con los flujos o afirma un status que el endpoint no puede dar',
    closes: 'regenerarla con /keel-docs: una carpeta por flujo, y cada request con el status de SU paso'
  },

  // ─── storage ───────────────────────────────────────────────────────────────
  'CHK-STORAGE-NO-MAXSIZE': {
    layer: 'storage',
    severity: 'warning',
    title: 'un bucket no declara maxSizeMb',
    closes: 'declarar el tope: es la otra mitad del contrato de subida que ya declara allowedContentTypes'
  }
};

export const checkIds = () => Object.keys(CHECKS);

export function checkFor(id) {
  return CHECKS[id];
}
