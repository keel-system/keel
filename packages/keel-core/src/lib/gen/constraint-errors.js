// Qué error del diseño significa violar cada constraint del esquema (keel-core/gen).
//
// Una violación de integridad llega al servidor como un error del motor con el NOMBRE de la
// constraint dentro del mensaje; traducirla al error que el diseño declara es lo que hace que dos
// peticiones simultáneas que compiten por el mismo valor único reciban el `409 SKU_ALREADY_EXISTS`
// del contrato y no un 409 anónimo. Qué error toca —el que el diseño nombra, el que se deduce de los
// campos o de la condición, el de concurrencia cuando solo una carrera puede romperla— y con qué
// MENSAJE sale son decisiones del diseño y respuesta observable de los dos servidores, así que viven
// aquí: keel-spring las escribe como un mapa de su ApiExceptionHandler y keel-nest como el de su
// filtro de errores.

import { FRAMEWORK_ERRORS, conditionalUniquenessToken } from '../framework-errors.js';
import { declaredErrorFor, declaredUniquenessErrorFor, declaredReferenceError, errorByCode } from './declared-errors.js';
import { uniqueConstraints, crossAggregateForeignKeys } from './relational.js';
import { screamingSnake } from './naming.js';

/** El mensaje del conflicto de concurrencia optimista: el mismo en los dos servidores. */
export const CONCURRENT_MODIFICATION_MESSAGE =
  'El recurso fue modificado por otra operación concurrente; reintenta con el estado actual';

/** El mensaje de una violación que no casa con ninguna constraint conocida. */
export const UNKNOWN_INTEGRITY_MESSAGE = 'Violación de integridad de datos: alguna restricción no se cumplió';

/** El mensaje de una transacción cancelada por su tope. */
export const TRANSACTION_TIMEOUT_MESSAGE = 'La operación no terminó a tiempo; reinténtala';

/** El error de conflicto por concurrencia que declara el diseño, si lo hay. */
export function declaredConcurrencyError(model) {
  return declaredErrorFor(model, FRAMEWORK_ERRORS.concurrency);
}

/**
 * Cada constraint con nombre que el servidor sabe traducir, en el orden del esquema, con:
 *   · `declared`  el error del diseño (con su `exceptionClass`), o null;
 *   · `code`      el que viaja si el diseño no declara ninguno (el de concurrencia en una carrera,
 *                 la convención `<ENTIDAD>_<CAMPOS>_ALREADY_EXISTS` si no);
 *   · `message`   el texto de la respuesta;
 *   · `raceOnly`  `'computed' | 'collection' | true | null`: por qué solo una carrera la rompe;
 *   · `conditional`, `named`, `reference` para quien explique el porqué junto al mapa.
 * Las FK entre agregados entran solo si el diseño DECLARA su error: aquí no se inventa ningún code.
 */
export function constraintErrors(model) {
  const constraints = uniqueConstraints(model);
  const resolved = constraints.map((constraint) => {
    // Si el diseño NOMBRA el error (DSL 2.16: `naturalKeyError`, `indexes[].error`), manda él sobre
    // toda deducción —por los campos, por la condición o por la colección—, y deja de ser una
    // carrera: decir qué significa el choque es justo decidir que es un error del cliente.
    const named = constraint.error ? errorByCode(model, constraint.error) : null;
    if (named) return { ...constraint, conditional: Boolean(constraint.when), raceOnly: null, declared: named, named: true };
    // Unicidad CONDICIONADA (`indexes[].when`): no dice «ya existe uno con esos campos» sino «ya
    // hay uno en ese estado», así que ni su familia ni su mensaje salen de los campos. El code se
    // busca por la CONDICIÓN y, si el diseño no lo nombró, el choque solo puede venir de una
    // carrera: la regla del caso de uso resuelve el caso normal y el índice es el respaldo.
    if (constraint.when) {
      const family = FRAMEWORK_ERRORS.uniqueness.conditionalFamilyFor(conditionalUniquenessToken(constraint.when));
      const declared = declaredErrorFor(model, FRAMEWORK_ERRORS.uniqueness, family);
      return { ...constraint, conditional: true, raceOnly: !declared, declared: declared ?? declaredConcurrencyError(model) };
    }
    const raceOnly = raceOnlyConstraint(model, constraint);
    const soleConstraint = constraints.filter((other) => other.entity === constraint.entity).length === 1;
    // Acotada a la colección, el diseño SÍ puede nombrarla (CHK-PERSIST-CHILD-UNIQUE-CODE), y si lo
    // hace manda él: dentro del padre ese choque puede ser de verdad un error del cliente.
    const nombrada =
      raceOnly === 'collection'
        ? declaredUniquenessErrorFor(model, FRAMEWORK_ERRORS.uniqueness, constraint.entity, constraint.fields, { soleConstraint })
        : null;
    if (nombrada) return { ...constraint, raceOnly: null, declared: nombrada };
    return {
      ...constraint,
      raceOnly,
      // Con `raceOnly` el conflicto no es «ya existe uno así» sino dos escrituras que se pisaron.
      declared: raceOnly
        ? declaredConcurrencyError(model)
        : declaredUniquenessErrorFor(model, FRAMEWORK_ERRORS.uniqueness, constraint.entity, constraint.fields, { soleConstraint })
    };
  });
  const references = crossAggregateForeignKeys(model)
    .map((fk) => ({ ...fk, declared: declaredReferenceError(model, fk.refEntity) }))
    .filter((fk) => fk.declared)
    .map((fk) => ({ constraint: fk.name, entity: fk.refEntity, fields: [fk.column], reference: fk, declared: fk.declared }));

  return [...resolved, ...references].map((entry) => ({ ...entry, message: messageOf(entry), code: codeOf(entry) }));
}

function messageOf({ entity, fields, declared, raceOnly, conditional, when, description, reference, named }) {
  if (reference) {
    return String(declared.when ?? `No se puede borrar: hay ${reference.table} que lo referencian`).replace(/\.\s*$/, '');
  }
  const label = fields.join(', ');
  const condition = conditional ? `${when.field} = ${JSON.stringify(when.equals)}` : null;
  // Nombrada, habla el diseño: el `when` del error es lo que el cliente tiene que leer.
  if (named && declared?.when) return String(declared.when).replace(/\.\s*$/, '');
  if (conditional) {
    return (
      (description ?? `Solo puede haber un ${entity} por ${label} con ${condition}`).replace(/\.\s*$/, '') +
      (raceOnly ? '; otra operación lo cambió a la vez, reintenta' : '')
    );
  }
  if (raceOnly === 'collection') return `Otra operación cambió ${label} de ${entity} a la vez; reintenta con el estado actual`;
  if (raceOnly) return `Otra operación registró ${entity}.${label} a la vez; reintenta`;
  return `Ya existe un ${entity} con ese ${label}`;
}

function codeOf({ entity, fields, declared, raceOnly }) {
  if (declared) return declared.code;
  if (raceOnly) return FRAMEWORK_ERRORS.concurrency.code;
  return `${screamingSnake(entity)}_${screamingSnake(fields.join('_'))}_ALREADY_EXISTS`;
}

/**
 * ¿Esta constraint solo puede romperla una carrera? Y si sí, POR QUÉ (`'computed'` |
 * `'collection'`), o `null` si el conflicto sí es «ya existe uno así».
 *
 * Un campo `computed` no lo manda nunca el cliente: si además el agregado lleva bloqueo optimista,
 * violar su unicidad son dos escrituras concurrentes que calcularon el mismo valor, y lo que toca es
 * reintentar, no corregir una entrada que no envió.
 */
export function raceOnlyConstraint(model, constraint) {
  const entity = model.entities.find((e) => e.name === constraint.entity);
  if (!entity) return null;

  // El bloqueo se mira en la RAÍZ del agregado: una entidad interna nunca lleva versión propia y
  // está protegida por la de su raíz.
  const root = model.entities.find((e) => e.name === entity.rootEntity) ?? entity;
  if (!root.usesOptimisticLocking) return null;

  // Unicidad ACOTADA A LA COLECCIÓN: el índice de una hija que incluye la relación a su raíz no
  // dice «ya existe un X con ese Y»; el padre es implícito en la petición y el resto lo reparte el
  // servicio, así que solo lo rompe el estado intermedio del reparto o una carrera.
  if (!entity.isAggregateRoot && collectionScopedConstraint(entity, constraint)) return 'collection';

  return constraint.fields.some((name) => entity.fields.find((f) => f.name === name)?.computed) ? 'computed' : null;
}

/**
 * ¿La constraint acota la unicidad a la COLECCIÓN de una raíz? Lo dice la back-reference: si entre
 * los miembros del índice está la relación de la hija hacia su raíz (con cualquiera de sus dos
 * nombres, `product` o `productId`), «único» significa «único dentro de ese padre».
 */
function collectionScopedConstraint(entity, constraint) {
  const toRoot = (entity.relations ?? []).filter((relation) => relation.backReference);
  if (toRoot.length === 0) return false;
  return (constraint.fields ?? []).some((member) => {
    const head = String(member).split('.')[0];
    return toRoot.some((relation) => head === relation.name || head === `${relation.name}Id`);
  });
}
