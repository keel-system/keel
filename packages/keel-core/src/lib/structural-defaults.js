// Los campos del catálogo de decisiones estructurales que tienen VALOR POR DEFECTO, y por
// tanto se pueden quedar sin decidir sin que nada lo note (R4.1 de recomendaciones-diseno.md).
//
// El problema. `assets/skills/keel-design/references/structural-decisions.md` exige «nunca un
// default tácito»: cada entrada §3.x se pregunta al diseñador con su consecuencia observable.
// Pero cuando el campo falta del YAML, la validación no lo rellena (Ajv sin `useDefaults`) y el
// generador aplica el default con un `??` sin decir nada. El diseño no guarda rastro de si
// alguien preguntó: «nadie lo decidió» y «se decidió el default» son indistinguibles para
// cualquier puerta. Medido al crearlo sobre las 11 fixtures de keel-spring: `audit.authorship`
// faltaba en 10, `optimisticLocking` en 6 y `audit.timestamps` en 3.
//
// La regla. `CHK-MODEL-IMPLICIT-DEFAULT` (undecided, aceptable) salta por cada unidad donde el
// campo está AUSENTE, y se cierra escribiéndolo, aunque sea con el mismo valor. Ojo con lo que
// NO garantiza: obliga a que el campo esté escrito, no a que alguien lo haya preguntado. El
// porqué de cada elección es la otra mitad (R4.2, `structural:` en decisions.yaml).
//
// Esta tabla es la fuente única de la regla, y `test/structural-defaults.test.js` la ata a las
// dos piezas que describe: cada `section` tiene que existir en structural-decisions.md y cada
// `default` tiene que ser el `default` del schema en `schemaPointer`.

/**
 * - `section` — la entrada §3.x de structural-decisions.md que hace la pregunta.
 * - `path` — el campo, como lo nombra el diseñador.
 * - `schema` + `schemaPointer` — dónde declara el schema el default (JSON Pointer).
 * - `default` — el valor que se aplica si falta.
 * - `question` — la pregunta de la entrada, en una frase: es lo que el aviso le pone delante.
 * - `units(layers)` — las unidades donde aplica: `{ scope, present }`. `scope` es la clave con
 *   la que se acepta en decisions.yaml; `present` si el campo está escrito.
 */
export const STRUCTURAL_DEFAULTS = [
  {
    section: '3.1',
    path: 'messaging.publishing.reliability',
    schema: 'messaging',
    schemaPointer: '/properties/publishing/properties/reliability',
    default: 'best-effort',
    question: 'si el broker está caído cuando la operación confirma, ¿es aceptable que el evento no llegue nunca?',
    // Sin eventos publicados no hay nada que pueda perderse.
    units: (layers) => {
      const publishing = layers.messaging?.publishing;
      if (Object.keys(publishing?.events ?? {}).length === 0) return [];
      return [{ scope: 'messaging.publishing.reliability', present: publishing.reliability !== undefined }];
    }
  },
  {
    section: '3.9',
    path: 'persistence.consistency.optimisticLocking',
    schema: 'persistence',
    schemaPointer: '/properties/consistency/properties/optimisticLocking',
    default: 'all',
    question: 'si dos peticiones modifican la misma entidad a la vez, ¿la segunda recibe un 409 o pisa a la primera?',
    units: (layers) => {
      const persistence = layers.persistence;
      if (Object.keys(persistence?.entities ?? {}).length === 0) return [];
      return [
        {
          scope: 'persistence.consistency.optimisticLocking',
          present: persistence.consistency?.optimisticLocking !== undefined
        }
      ];
    }
  },
  {
    section: '3.9b',
    path: 'persistence.audit.timestamps',
    schema: 'persistence',
    schemaPointer: '/properties/audit/properties/timestamps',
    default: 'all',
    question: '¿hace falta saber cuándo se creó y modificó cada registro, y lo lee algún cliente o solo quien opera la base?',
    units: (layers) =>
      layers.persistence
        ? [{ scope: 'persistence.audit.timestamps', present: layers.persistence.audit?.timestamps !== undefined }]
        : []
  },
  {
    section: '3.9b',
    path: 'persistence.audit.authorship',
    schema: 'persistence',
    schemaPointer: '/properties/audit/properties/authorship',
    default: 'none',
    question: '¿hay que poder responder quién hizo cada cambio (cumplimiento, disputas, soporte)?',
    units: (layers) =>
      layers.persistence
        ? [{ scope: 'persistence.audit.authorship', present: layers.persistence.audit?.authorship !== undefined }]
        : []
  },
  {
    section: '3.10',
    path: 'storage.buckets.<bucket>.visibility',
    schema: 'storage',
    schemaPointer: '/properties/buckets/additionalProperties/properties/visibility',
    default: 'private',
    question: '¿lo que hay dentro puede verlo cualquiera con la URL, o solo quien reciba un acceso firmado?',
    units: (layers) =>
      Object.entries(layers.storage?.buckets ?? {}).map(([name, bucket]) => ({
        scope: `storage.buckets.${name}.visibility`,
        present: bucket?.visibility !== undefined
      }))
  }
];

/**
 * Las entradas del catálogo estructural cuyo default tácito ya vigila OTRA comprobación. No se
 * duplican: el mismo campo ausente daría dos ids a la vez, y el corpus de mutaciones exige que
 * cada una dispare el suyo y solo ese.
 */
export const COVERED_ELSEWHERE = [
  {
    section: '3.5',
    path: 'messaging.subscriptions.<evento>.onFailure',
    by: 'CHK-MSG-SUB-NO-ONFAILURE',
    why: 'sin default en el schema: lo decidiría el broker, y por eso ni siquiera admite aceptación'
  },
  {
    section: '3.7',
    path: 'persistence.consistency.transactionalBoundary',
    by: 'CHK-PERSIST-BOUNDARY-DEFAULT',
    why: 'sin default en el schema, pero se asume per-operation; solo es pregunta habiendo agregados, que es cuando salta aquella'
  }
];

/**
 * Entradas del catálogo con un campo con default que se descartan a propósito. Fuera del
 * catálogo §3 hay más defaults (`onFailure.retry.backoff`, `contract.format`,
 * `contract.unknownFields`, `nature`…), pero son de forma, no decisiones estructurales.
 */
export const DISCARDED = [
  {
    section: '3.4',
    path: 'api.endpoints.<op>.audience',
    why: 'saldría en cada endpoint y `users` es el default seguro: lo que pregunta §3.4 es si hace falta una operación M2M propia, no la audiencia de cada una'
  }
];

/**
 * Las unidades donde falta un campo del catálogo estructural con default: una por aviso.
 * @returns {Array<{ scope: string, entry: object }>}
 */
export function implicitDefaults(layers) {
  const found = [];
  for (const entry of STRUCTURAL_DEFAULTS) {
    for (const unit of entry.units(layers)) {
      if (!unit.present) found.push({ scope: unit.scope, entry });
    }
  }
  return found;
}
