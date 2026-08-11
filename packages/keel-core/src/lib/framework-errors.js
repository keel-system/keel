// Los códigos de error que pone el FRAMEWORK, no el diseño.
//
// Por qué existe este módulo. El DSL sostiene que «`errors` es el único sitio donde nace un
// `code` del contrato» (docs/dsl/use-cases.md) y las convenciones de los generadores le dicen
// al agente que nunca invente uno. Pero hay conflictos que **enciende un mecanismo** y que el
// diseño no describe operación por operación —la carrera de una clave de idempotencia, una
// escritura sobre una versión obsoleta, un archivo que pasa del tamaño del bucket—, y esos
// llegan al cliente con un `code` igualmente. Sin catálogo, cada generación elegía el suyo:
// tres corridas completas del pipeline produjeron tres contratos públicos distintos para el
// mismo hecho, cada una reportándolo como hueco de diseño que nadie podía cerrar.
//
// Esto es doctrina del MÉTODO, no de keel-spring: cualquier generador que implemente estos
// mecanismos emite estos códigos, igual que `building-a-generator.md` fija otras obligaciones.
// Por eso vive en core y se exporta en la API pública, y por eso un generador no debe escribir
// estos literales a mano — el mismo criterio que `broker-probes.js` aplica a los comandos de
// broker: una sola definición, o los dos lados divergen sin que nada lo diga.
//
// La prosa que acompaña a esta tabla está en `assets/core/docs/framework-errors.md`, y
// `test/framework-errors.test.js` comprueba que las dos digan lo mismo.

/**
 * Un `code` del diseño **sustituye** al canónico cuando pertenece a su familia.
 *
 * No es adivinar por el nombre: es la asimetría que ya aplicaban `declaredUniquenessError` y
 * `declaredConcurrencyError` en keel-spring. El diseño manda sobre el contrato público, así que
 * si nombra el conflicto, el generador usa ese nombre; si no lo nombra, usa el canónico en vez
 * de inventar. La familia se acota a propósito —un `code` cualquiera con el mismo status no
 * vale—: dos candidatos o ninguno significan que el diseño no lo dijo, y ahí no se adivina.
 */
export const FRAMEWORK_ERRORS = {
  validation: {
    code: 'VALIDATION_ERROR',
    http: 400,
    overridable: false,
    mechanism: 'constraints de `input` (use-cases)',
    when: 'La petición no cumple las cotas declaradas en el input de la operación.'
  },

  invalidTransition: {
    code: 'INVALID_STATE_TRANSITION',
    http: 409,
    overridable: true,
    family: /(^|_)(INVALID_STATE_TRANSITION|INVALID_STATE|INVALID_TRANSITION|ILLEGAL_STATE_TRANSITION)$/,
    mechanism: 'domain: entities.<E>.lifecycle',
    when: 'Se pide una transición que el lifecycle de la entidad no declara desde su estado actual.'
  },

  uniqueness: {
    // No es un código fijo: se sintetiza por entidad y campos (`<ENTITY>_<FIELDS>_ALREADY_EXISTS`),
    // porque un servicio puede tener varias claves naturales y un solo `code` no las distinguiría.
    derived: true,
    http: 409,
    overridable: true,
    familyFor: (fields) => new RegExp(`(^|_)${fields}_ALREADY_EXISTS$`),
    mechanism: 'persistence: entities.<E>.naturalKey / campos `unique`',
    when: 'Una escritura choca con una clave natural o un campo único ya existente.'
  },

  concurrency: {
    code: 'CONCURRENT_MODIFICATION',
    http: 409,
    overridable: true,
    // El canónico nombra el HECHO —algo cambió mientras escribías—, no la técnica con la que se
    // detecta. `OPTIMISTIC_LOCK_CONFLICT` sigue en la familia porque fue el canónico anterior:
    // un proyecto que quiera conservarlo solo tiene que declararlo.
    family: /(^|_)(CONCURRENT_MODIFICATION|CONCURRENT_UPDATE|OPTIMISTIC_LOCK_CONFLICT|OPTIMISTIC_LOCKING_FAILURE|VERSION_CONFLICT)$/,
    mechanism: 'persistence: consistency.optimisticLocking (`all` o `declared`)',
    when: 'Dos escrituras concurrentes sobre la misma raíz: la segunda va contra una versión que ya cambió.'
  },

  idempotencyRace: {
    code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
    http: 409,
    overridable: true,
    // `KEY_IN_PROGRESS` a secas entra: lo que se compara es el sufijo, así que un
    // `ORDER_KEY_IN_PROGRESS` del dominio vale igual que el canónico con prefijo.
    family: /(^|_)(KEY_IN_PROGRESS|IDEMPOTENCY_IN_PROGRESS|REQUEST_IN_PROGRESS)$/,
    mechanism: 'use-cases: operations.<op>.idempotency',
    when:
      'Dos peticiones con la misma clave a la vez: la que pierde la carrera no tiene todavía una respuesta que reproducir, ' +
      'porque la ganadora no ha commiteado. Su transacción revierte entera, así que de las dos se ejecutó exactamente una.'
  },

  idempotencyReuse: {
    code: 'IDEMPOTENCY_KEY_REUSED',
    http: 409,
    overridable: true,
    family: /(^|_)(KEY_REUSED|KEY_MISMATCH|KEY_SIGNATURE_MISMATCH|KEY_CONFLICT)$/,
    mechanism: 'use-cases: operations.<op>.idempotency',
    when:
      'La misma clave con un contenido distinto. No es un reintento: reproducir la respuesta de la primera petición ' +
      'contestaría a una pregunta que el cliente no hizo, y ejecutar la segunda rompería la promesa de la clave.'
  },

  fileTooLarge: {
    code: 'FILE_TOO_LARGE',
    http: 413,
    overridable: true,
    family: /(^|_)(FILE_TOO_LARGE|PAYLOAD_TOO_LARGE|UPLOAD_TOO_LARGE)$/,
    mechanism: 'storage: buckets.<b>.maxSizeMb',
    when: 'La subida supera el tamaño máximo declarado para el bucket.'
  },

  fileUnreadable: {
    code: 'FILE_UNREADABLE',
    http: 400,
    overridable: false,
    mechanism: 'entrada multipart (input con un campo `type: file`)',
    when: 'La parte binaria de la petición no se puede leer: llega vacía o el cuerpo multipart está roto.'
  }
};

/** Las entradas con `code` fijo (todas menos la unicidad, que lo deriva por entidad). */
export function fixedFrameworkErrors() {
  return Object.entries(FRAMEWORK_ERRORS)
    .filter(([, entry]) => !entry.derived)
    .map(([name, entry]) => ({ name, ...entry }));
}

/**
 * El `code` del diseño que sustituye a un canónico, o `null` si no lo hay.
 *
 * Exige **exactamente un** candidato de la familia y con el status del mecanismo: con cero, el
 * diseño no lo dijo; con dos, dijo algo ambiguo y elegir uno sería inventar. En los dos casos
 * manda el canónico, que es lo que hace que el contrato exista siempre.
 *
 * @param {Array<{code: string, http: number, dynamicStatus?: boolean}>} declared errores del diseño
 * @param {object} entry entrada de FRAMEWORK_ERRORS
 * @param {RegExp} [family] familia explícita (la unicidad la deriva de sus campos)
 */
export function overrideFor(declared, entry, family = entry.family) {
  if (!family || !entry.overridable) return null;
  const candidates = (declared ?? []).filter(
    // `dynamicStatus` fuera: su status llega por constructor, y aquí no hay operación de la que
    // deducirlo. Un error que significa cosas distintas según quién lo lanza no es este contrato.
    (error) => error.http === entry.http && !error.dynamicStatus && family.test(String(error.code))
  );
  return candidates.length === 1 ? candidates[0] : null;
}
