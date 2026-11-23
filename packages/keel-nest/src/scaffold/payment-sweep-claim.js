// El reclamo del barrido de pagos (`payments.reconciliation.sweep`), generado por build (corrida payment de
// prueba-gelsa, G11): el gemelo de `payment-sweep-claim.js` de keel-spring.
//
// Lo escribía el agente. En keel-spring, un `@Modifying` bajo el `@Transactional(readOnly = true)` de la clase fallaba;
// aquí no hay esa trampa, pero el reclamo sigue siendo un mecanismo de concurrencia que nadie mide si lo escribe el
// agente. Es la forma de un RESCATE —renovar el reloj con una escritura condicional que solo casa si la fila sigue
// atascada, sin mover el estado— con dos diferencias: varios estados en espera con UN solo reloj
// (`record.awaitingSince`), y el plazo y el lote son del barrido de pagos (`PaymentReconciliation.staleBefore(now)` y
// `batchSize()`, que el handler pasa). Por eso no va en `operation.claim` del modelo neutral.
//
// El cobro reclamado se consulta FUERA de esta llamada: el reclamo confirma antes de volver (transacción propia), y la
// llamada a la pasarela no puede ir dentro de ninguna transacción.

import { scheduledByTimer } from '@keel-system/keel-core/gen/timer-plan';
import { screamingSnake } from '@keel-system/keel-core/gen';
import { needsReadCommitted } from '@keel-system/keel-core/gen/infra-catalog';
import { DELETED_AT, isLogicallyDeleted } from '@keel-system/keel-core/gen/relational';
import { DIRS, classPath } from './render.js';
import { engineOf, ormClass } from './persistence-entities.js';
import { sweepPassImport } from './timer.js';

/** El reclamo del barrido de pagos sobre esta entidad, o null si no es el registro de cobros. */
export function paymentSweepClaim(model, entity) {
  const payments = model.payments;
  if (!payments?.reconciliation?.sweep || payments.record?.entity !== entity.name || !entity.lifecycle) return null;
  return {
    sweep: payments.reconciliation.sweep,
    states: payments.awaitingStates,
    stampField: payments.record.awaitingSince,
    method: 'claimForPaymentSweep'
  };
}

function describe(entityName, claim) {
  return `Reclama hasta \`batchSize\` ${entityName} que esperan un desenlace de la pasarela (${claim.states.join(', ')}) con
${claim.stampField} anterior a \`staleBefore\`, y los devuelve SIGUIENDO en su estado con ${claim.stampField} renovado:
es el reclamo del barrido de pagos (${claim.sweep}).

Reclama, no lee: el barrido puede correr en varias réplicas a la vez; el reclamo es una escritura condicional que
solo casa si la fila sigue esperando y sigue rancia, y renueva el reloj en la misma escritura, así que lo que otra
réplica reclamó antes no aparece aquí. Confirma en su propia transacción antes de volver: consulta la pasarela con
\`paymentReconciliation.consult(...)\` FUERA de esta llamada.

Los dos números son del barrido de pagos y los pasa el handler: \`paymentReconciliation.staleBefore(now)\` (el umbral
del diseño) y \`paymentReconciliation.batchSize()\`.`;
}

const doc = (text, indent = '  ') => `${indent}/**\n${text.split('\n').map((line) => `${indent} * ${line}`.trimEnd()).join('\n')}\n${indent} */`;

/** El método del puerto <E>Repository. */
export function portMethods(model, entity) {
  const claim = paymentSweepClaim(model, entity);
  if (!claim) return [];
  return [`${doc(describe(entity.name, claim))}\n  abstract ${claim.method}(staleBefore: Date, batchSize: number): Promise<${entity.name}[]>;`];
}

/** La señal de lote lleno, si el barrido lo dispara el cronómetro (que repite la pasada). */
function passSignal(model, claim, imports, size, indent) {
  if (!scheduledByTimer(model, claim.sweep)) return '';
  if (!imports.some((entry) => entry.symbol === 'SweepPass')) imports.push(sweepPassImport());
  return `${indent}// Lote lleno: puede que queden candidatos, y el tick del cronómetro repite la pasada (drenaje).
${indent}SweepPass.claimed(${size}, batchSize);
`;
}

/** El método del adaptador TypeORM: SKIP LOCKED + UPDATE condicional por fila, en su propia transacción. */
export function adapterMethods(model, entity, imports, findOptions) {
  const claim = paymentSweepClaim(model, entity);
  if (!claim) return [];
  const { enumType, field } = entity.lifecycle;
  const orm = ormClass(entity.name);
  if (!imports.some((entry) => entry.symbol === enumType)) imports.push({ symbol: enumType, from: classPath(DIRS.enums, enumType) });
  for (const operator of ['LessThan', ...(isLogicallyDeleted(entity) ? ['IsNull'] : [])]) {
    if (!imports.some((entry) => entry.symbol === operator && entry.from === 'typeorm')) imports.push({ symbol: operator, from: 'typeorm' });
  }
  const states = claim.states.map((state) => `${enumType}.${screamingSnake(state)}`).join(', ');
  const extra = [`${claim.stampField}: LessThan(staleBefore)`, ...(isLogicallyDeleted(entity) ? [`${DELETED_AT.field}: IsNull()`] : [])];
  const condition = (head) => `states.map((state) => ({ ${[...head, `${field}: state`, ...extra].join(', ')} }))`;
  // READ COMMITTED en MySQL: en REPEATABLE READ la lectura con bloqueo toma también los HUECOS (lo mismo que los demás reclamos).
  const isolation = needsReadCommitted(engineOf(model)) ? ", { isolation: 'READ COMMITTED' }" : '';
  return [
    `${doc(`El reclamo del barrido de pagos: ver ${entity.name}Repository.${claim.method}.`)}
  async ${claim.method}(staleBefore: Date, batchSize: number): Promise<${entity.name}[]> {
    // El reloj renovado, uno por tanda: el reclamo ARRIENDA la fila, no la mueve de estado.
    const leasedAt = new Date();
    const states = [${states}];
    return this.transactions.inNewTransaction(async (manager) => {
      // Los candidatos, el que más lleva esperando primero. SKIP LOCKED: cada réplica recibe candidatos DISTINTOS.
      const candidates = await manager
        .createQueryBuilder(${orm}, 'e')
        .select(['e.id'])
        .where(${condition([])})
        .orderBy('e.${claim.stampField}', 'ASC')
        .limit(batchSize)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();
      const claimed: ${entity.name}[] = [];
      for (const { id } of candidates) {
        // Renueva ${claim.stampField} SOLO si la fila sigue esperando y sigue rancia. 1 = es mía; 0 = otra réplica la
        // reclamó entre la lectura y esta escritura: esa comparación es toda la exclusión mutua.
        const result = await manager
          .createQueryBuilder()
          .update(${orm})
          .set({ ${claim.stampField}: leasedAt })
          .where(${condition(['id'])})
          .execute();
        if (!result.affected) continue;
        const found = await manager.findOne(${orm}, ${findOptions('{ id }')});
        if (found != null) claimed.push(toDomain${entity.name}(found));
      }
${passSignal(model, claim, imports, 'candidates.length', '      ')}      return claimed;
    }${isolation});
  }`
  ];
}

/**
 * El método del adaptador documental: un findOneAndUpdate por candidato, que filtra por esperando y rancio y renueva el
 * reloj en la MISMA operación atómica. `keyOf(member)` y `storedState(state)` son los del adaptador documental.
 */
export function documentAdapterMethods(model, entity, imports, { keyOf, storedState }) {
  const claim = paymentSweepClaim(model, entity);
  if (!claim) return [];
  const field = keyOf(entity.lifecycle.field);
  const stamp = keyOf(claim.stampField);
  const states = claim.states.map((state) => JSON.stringify(storedState(state))).join(', ');
  const filter = [`'${field}': { $in: [${states}] }`, `'${stamp}': { $lt: staleBefore }`, ...(isLogicallyDeleted(entity) ? [`${DELETED_AT.field}: null`] : [])];
  return [
    `${doc(`El reclamo del barrido de pagos: ver ${entity.name}Repository.${claim.method}.`)}
  async ${claim.method}(staleBefore: Date, batchSize: number): Promise<${entity.name}[]> {
    const leasedAt = new Date();
    const claimed: ${entity.name}[] = [];
    for (let i = 0; i < batchSize; i++) {
      // Renueva el reloj SOLO si sigue esperando y sigue rancio: null = no quedan candidatos (o los demás se los
      // llevó otra réplica). Sin sesión: el reclamo confirma al volver.
      const document = await this.collection.findOneAndUpdate(
        { ${filter.join(', ')} },
        { $set: { '${stamp}': leasedAt } },
        { sort: { '${stamp}': 1 }, returnDocument: 'after' }
      );
      if (document == null) break;
      claimed.push(toDomain${entity.name}(document));
    }
${passSignal(model, claim, imports, 'claimed.length', '    ')}    return claimed;
  }`
  ];
}
