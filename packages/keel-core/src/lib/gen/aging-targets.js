// Lo que el arnés tiene que «envejecer» para que un barrido lo vea: la marca de espera de cada objetivo de un
// `reconciledBy` y la del cobro de la capa payments. Un flujo de caja negra no puede esperar el umbral real,
// así que retrasa la marca; qué tabla (o colección) y qué columna (o clave) es una pregunta al diseño, no al
// lenguaje. Vivía copiada en keel-nest y keel-dotnet, la rama relacional en su arnés del proveedor de prueba
// y la documental en el documental (auditoría del inc. 1 de PLAN-KEEL-GO.md).

import { documentShape } from './document.js';

/** Envejecibles con persistencia relacional, por nombre del barrido: `[{ table, awaitingField }]`. */
export function relationalAgingTargets(model) {
  const targets = new Map();
  for (const operation of (model.services ?? []).flatMap((service) => service.operations ?? [])) {
    for (const { activation, waitingTargets } of operation.reconciles ?? []) {
      for (const target of waitingTargets ?? []) {
        if (!target.table || !target.awaitingField) continue;
        if (!targets.has(activation.name)) targets.set(activation.name, []);
        targets.get(activation.name).push(target);
      }
    }
  }
  // El barrido de la capa payments no es un `reconciledBy` de activations, pero su condición de entrada es la misma —la
  // marca de espera del cobro, rancia— y tampoco se alcanza de otra forma. La clave es el nombre del barrido.
  const payments = model.payments;
  if (payments?.reconciliation?.sweep && payments.record?.awaitingSince) {
    const entity = (model.entities ?? []).find((candidate) => candidate.name === payments.record.entity);
    if (entity?.tableName) {
      if (!targets.has(payments.reconciliation.sweep)) targets.set(payments.reconciliation.sweep, []);
      targets.get(payments.reconciliation.sweep).push({ table: entity.tableName, awaitingField: payments.record.awaitingSince });
    }
  }
  return targets;
}

/**
 * Las operaciones con `schedule` que recogen lo envejecido de cada clave (la de `relationalAgingTargets` y
 * `documentAgingTargets`): las que reconcilian esa activación, o el propio barrido de pagos. Es lo que el arnés adelanta
 * en el cronómetro tras envejecer (`fireTimer`, inc. 8 del plan 2.26), para no esperar al cron.
 */
export function agingSweeps(model) {
  const sweeps = new Map();
  const add = (key, operation) => {
    if (!sweeps.has(key)) sweeps.set(key, []);
    if (!sweeps.get(key).includes(operation)) sweeps.get(key).push(operation);
  };
  for (const operation of (model.services ?? []).flatMap((service) => service.operations ?? [])) {
    if (!operation.schedule) continue;
    for (const { activation } of operation.reconciles ?? []) add(activation.name, operation.name);
  }
  const sweep = model.payments?.reconciliation?.sweep;
  if (sweep) add(sweep, sweep);
  return sweeps;
}

/** Envejecibles con persistencia documental, por nombre del barrido: `[{ collection, clockField }]`. */
export function documentAgingTargets(model) {
  const targets = new Map();
  for (const operation of (model.services ?? []).flatMap((service) => service.operations ?? [])) {
    for (const { activation, waitingTargets } of operation.reconciles ?? []) {
      for (const target of waitingTargets ?? []) {
        const entity = (model.entities ?? []).find((candidate) => candidate.name === target.entity);
        if (!entity?.collectionName || !target.awaitingField) continue;
        const clockField = documentShape(model, entity).find((entry) => entry.member === target.awaitingField)?.name;
        if (!clockField) continue;
        if (!targets.has(activation.name)) targets.set(activation.name, []);
        targets.get(activation.name).push({ collection: entity.collectionName, clockField });
      }
    }
  }
  // El barrido de la capa payments: su condición de entrada es la marca de espera del cobro, rancia, y la clave es el
  // nombre del barrido, como en la rama relacional.
  const payments = model.payments;
  if (payments?.reconciliation?.sweep && payments.record?.awaitingSince) {
    const entity = (model.entities ?? []).find((candidate) => candidate.name === payments.record.entity);
    const clockField = entity?.collectionName ? documentShape(model, entity).find((entry) => entry.member === payments.record.awaitingSince)?.name : null;
    if (clockField) {
      if (!targets.has(payments.reconciliation.sweep)) targets.set(payments.reconciliation.sweep, []);
      targets.get(payments.reconciliation.sweep).push({ collection: entity.collectionName, clockField });
    }
  }
  return targets;
}
