// La unicidad GLOBAL de una entidad INTERNA de un agregado, como datos para los cuatro generadores.
//
// `uniqueFieldFinders` de cada generador da a la raíz un finder por cada campo `unique` suyo, para comprobar la
// unicidad ANTES de un efecto que no se deshace con la transacción (subir un binario, llamar a un proveedor). Una hija
// con una clave única GLOBAL —la devolución con su `refundRequestId`, única en todos los cobros— necesita lo mismo, y el
// puerto de la raíz no traía cómo preguntarlo: el agente lo escribió a mano en el puerto y en el adaptador generados
// (`ExistsByRefundRequestId`, corrida payment-dotnet del 2026-11-27, para el REFUND_REQUEST_CONFLICT «sobre otro cobro»
// antes de llamar a la pasarela).
//
// Solo lo GLOBAL: la clave natural de un solo campo de la hija (que no sea la relación a su padre) y sus campos `unique`.
// Una clave que incluye la relación al padre está acotada a la colección (`CHK-PERSIST-CHILD-UNIQUE-CODE`): la responde
// el propio agregado cargado, sin consulta.

import { collectInternalEntities, keyShadow, uniqueFields } from './relational.js';
import { documentShape } from './document.js';

/**
 * Las claves únicas globales de las hijas de `root`, cada una con lo que necesita su consulta: la hija, el campo, la
 * sombra plegada si la unicidad la lleva ella, y la ruta del campo dentro del documento de la raíz (las hijas van
 * embebidas: `refunds.refund_request_id`). Una por campo y nombre de método: `existsBy<Campo>`.
 */
export function internalUniqueKeys(model, root) {
  const keys = [];
  const seen = new Set();
  for (const child of collectInternalEntities(model, root)) {
    if (child === root) continue;
    const candidates = [];
    const natural = child.naturalKey ?? [];
    if (natural.length === 1) {
      const field = child.fields.find((candidate) => candidate.name === natural[0]);
      if (field && !field.isId && field.kind !== 'composite' && !field.list) candidates.push(field);
    }
    for (const field of uniqueFields(child)) {
      if (!field.list && !candidates.includes(field)) candidates.push(field);
    }
    for (const field of candidates) {
      if (seen.has(field.name)) continue;
      seen.add(field.name);
      const shadow = keyShadow(field);
      keys.push({ entity: child, field, shadow, documentPath: documentPathOf(model, root, child, shadow?.name ?? field.name) });
    }
  }
  return keys;
}

// La ruta del campo de una hija dentro del documento de su raíz, bajando por los subdocumentos y arrays de hijas. Mongo
// la recorre también a través de los arrays: `{ "refunds.refund_request_id": v }` casa con cualquier elemento.
function documentPathOf(model, root, child, memberName) {
  const walk = (entity, prefix, visited) => {
    for (const entry of documentShape(model, entity)) {
      const target = entry.element?.entity ?? entry.entity;
      if (!target || visited.has(target)) continue;
      const next = model.entities.find((candidate) => candidate.name === target);
      if (!next) continue;
      const path = [...prefix, entry.name];
      if (next === child) {
        const own = documentShape(model, child).find((candidate) => candidate.member === memberName);
        return own ? [...path, own.name].join('.') : null;
      }
      const found = walk(next, path, new Set([...visited, target]));
      if (found) return found;
    }
    return null;
  };
  return walk(root, [], new Set([root.name]));
}
