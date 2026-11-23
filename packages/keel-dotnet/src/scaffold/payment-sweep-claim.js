// El reclamo del barrido de pagos (`payments.reconciliation.sweep`), generado por build (corrida payment de
// prueba-gelsa, G11): el gemelo de `payment-sweep-claim.js` de keel-spring y keel-nest.
//
// Lo escribía el agente, y un mecanismo de concurrencia que escribe el agente no lo mide nadie. Es la forma de un RESCATE
// —renovar el reloj con una escritura condicional que solo casa si la fila sigue atascada, sin mover el estado— con dos
// diferencias: varios estados en espera con UN solo reloj (`record.awaitingSince`), y el plazo y el lote son del barrido
// de pagos (`PaymentReconciliation.StaleBefore(now)` y `BatchSize()`, que el handler pasa). Por eso no va en
// `operation.claim` del modelo neutral.
//
// El cobro reclamado se consulta FUERA de esta llamada: el reclamo confirma antes de volver (transacción propia), y la
// llamada a la pasarela no puede ir dentro de ninguna transacción.

import { scheduledByTimer } from '@keel-system/keel-core/gen/timer-plan';
import { claimsForEntity } from '@keel-system/keel-core/gen';
import { reconciliationClaims } from '@keel-system/keel-core/gen/reconciliation-stores';
import { snakeCase } from '@keel-system/keel-core/gen';
import { DELETED_AT, isLogicallyDeleted } from '@keel-system/keel-core/gen/relational';

import { csMember, csString } from './render.js';
import { valueAlias } from './relational-engine.js';

/** El reclamo del barrido de pagos sobre esta entidad, o null si no es el registro de cobros. */
export function paymentSweepClaim(model, entity) {
  const payments = model.payments;
  if (!payments?.reconciliation?.sweep || payments.record?.entity !== entity.name || !entity.lifecycle) return null;
  return {
    sweep: payments.reconciliation.sweep,
    states: payments.awaitingStates,
    stampField: payments.record.awaitingSince,
    method: 'ClaimForPaymentSweep'
  };
}

function describe(entityName, claim) {
  return [
    `Reclama hasta <paramref name="batchSize"/> ${entityName} que esperan un desenlace de la pasarela (${claim.states.join(', ')})`,
    `con ${claim.stampField} anterior a <paramref name="staleBefore"/>, y los devuelve SIGUIENDO en su estado con`,
    `${claim.stampField} renovado: es el reclamo del barrido de pagos (${claim.sweep}).`,
    '',
    'Reclama, no lee: el barrido puede correr en varias réplicas a la vez; el reclamo es una escritura condicional que solo',
    'casa si la fila sigue esperando y sigue rancia, y renueva el reloj en la misma escritura, así que lo que otra réplica',
    'reclamó antes no aparece aquí. Confirma en su propia transacción antes de volver: consulta la pasarela con',
    '<c>paymentReconciliation.Consult(...)</c> FUERA de esta llamada.',
    '',
    'Los dos números son del barrido de pagos y los pasa el handler: <c>paymentReconciliation.StaleBefore(now)</c> (el umbral',
    'del diseño) y <c>paymentReconciliation.BatchSize()</c>.'
  ];
}

const xml = (lines, indent = '    ') => `${indent}/// <summary>\n${lines.map((line) => `${indent}/// ${line}`.trimEnd()).join('\n')}\n${indent}/// </summary>\n`;

/** ¿Ya emite otro reclamo de la raíz el ayudante RequireOwnTransaction? (claim.js, reconciliation-claim.js, document-stores.js) */
const hasOwnTransactionHelper = (model, entity) =>
  claimsForEntity(model, entity.name).length > 0 || reconciliationClaims(model).some((claim) => claim.entity === entity.name);

/** La señal de lote lleno, si el barrido lo dispara el cronómetro (que repite la pasada). */
function passSignal(model, claim, size, indent) {
  if (!scheduledByTimer(model, claim.sweep)) return '';
  return `${indent}// Lote lleno: puede que queden candidatos, y el tick del cronómetro repite la pasada (drenaje).
${indent}SweepPass.Claimed(${size}, batchSize);
`;
}

/** El método del puerto I<E>Repository. */
export function portMethods(model, entity) {
  const claim = paymentSweepClaim(model, entity);
  if (!claim) return [];
  return [`${xml(describe(entity.name, claim))}    Task<IReadOnlyList<${entity.name}>> ${claim.method}(DateTimeOffset staleBefore, int batchSize, CancellationToken cancellationToken = default);`];
}

/**
 * El método del adaptador EF Core: SKIP LOCKED + UPDATE condicional por fila, en su propia transacción (la forma del
 * rescate de claim.js). `stored(state)` es la constante guardada de un estado.
 */
export function adapterMethods(model, entity, stored) {
  const claim = paymentSweepClaim(model, entity);
  if (!claim) return [];
  const table = entity.tableName;
  const stateColumn = snakeCase(entity.lifecycle.field);
  const stamp = snakeCase(claim.stampField);
  const idField = entity.idField?.name ?? 'id';
  const idColumn = snakeCase(idField);
  const idType = entity.idField?.csType ?? 'Guid';
  const idProp = csMember(idField);
  const states = claim.states.map((state) => `'${stored(state)}'`).join(', ');
  const where = [`${stateColumn} IN (${states})`, `${stamp} < {staleBefore}`, ...(isLogicallyDeleted(entity) ? [`${DELETED_AT.column} IS NULL`] : [])].join(' AND ');
  const methods = [
    `    /// <summary>El reclamo del barrido de pagos: ver I${entity.name}Repository.${claim.method}.</summary>
    public Task<IReadOnlyList<${entity.name}>> ${claim.method}(DateTimeOffset staleBefore, int batchSize, CancellationToken cancellationToken = default)
    {
        RequireOwnTransaction(${csString(claim.method)});
        // El reloj renovado, uno por tanda: el reclamo ARRIENDA la fila, no la mueve de estado.
        var leasedAt = DateTimeOffset.UtcNow;
        return transactions.InTransaction<IReadOnlyList<${entity.name}>>(
            async () =>
            {
                // Los candidatos, el que más lleva esperando primero. SKIP LOCKED: cada réplica recibe candidatos DISTINTOS.
                var candidates = await db.Database
                    .SqlQuery<${idType}>($"SELECT ${idColumn} ${valueAlias(model)} FROM ${table} WHERE ${where} ORDER BY ${stamp} LIMIT {batchSize} FOR UPDATE SKIP LOCKED")
                    .ToListAsync(cancellationToken);
                var claimed = new List<${entity.name}>();
                foreach (var id in candidates)
                {
                    // Renueva ${claim.stampField} SOLO si la fila sigue esperando y sigue rancia. 1 = es mía; 0 = otra réplica la
                    // reclamó entre la lectura y esta escritura: esa comparación es toda la exclusión mutua.
                    var won = await db.Database.ExecuteSqlAsync($"UPDATE ${table} SET ${stamp} = {leasedAt} WHERE ${idColumn} = {id} AND ${where}", cancellationToken);
                    if (won != 1)
                    {
                        continue;
                    }
                    var found = await Graph().AsNoTracking().SingleOrDefaultAsync(r => r.${idProp} == id, cancellationToken);
                    if (found is not null)
                    {
                        claimed.Add(ToDomain(found));
                    }
                }
${passSignal(model, claim, 'candidates.Count', '                ')}                return claimed;
            },
            readOnly: false,
            cancellationToken,
            PersistenceTransactions.ClaimIsolation);
    }`
  ];
  if (!hasOwnTransactionHelper(model, entity)) {
    methods.push(`    /// <summary>
    /// Un reclamo confirma en SU transacción antes de devolver las filas: dentro de otra se uniría a ella y el reclamo no
    /// existiría para ninguna otra réplica hasta el commit final, así que todas actuarían sobre los mismos candidatos.
    /// </summary>
    private void RequireOwnTransaction(string method)
    {
        if (db.Database.CurrentTransaction is not null)
        {
            throw new InvalidOperationException(
                $"{method} confirma en su propia transacción y hay una abierta: despacha la operación con DispatchWithoutTransaction (el scheduler ya lo hace).");
        }
    }`);
  }
  return methods;
}

/**
 * El método del adaptador documental: un FindOneAndUpdate por candidato, que filtra por esperando y rancio y renueva el
 * reloj en la MISMA operación atómica. `keyOf(member)` es la clave del documento y `stored(state)` la constante guardada.
 */
export function documentAdapterMethods(model, entity, { keyOf, stored, ownTransactionHelper }) {
  const claim = paymentSweepClaim(model, entity);
  if (!claim) return [];
  const field = keyOf(entity.lifecycle.field);
  const stamp = keyOf(claim.stampField);
  const states = claim.states.map((state) => csString(stored(state))).join(', ');
  const filter = [
    `{ ${csString(field)}, new BsonDocument("$in", new BsonArray { ${states} }) }`,
    `{ ${csString(stamp)}, new BsonDocument("$lt", BsonValues.Of(staleBefore)) }`,
    ...(isLogicallyDeleted(entity) ? [`{ ${csString(DELETED_AT.field)}, BsonNull.Value }`] : [])
  ];
  const methods = [
    `    /// <summary>El reclamo del barrido de pagos: ver I${entity.name}Repository.${claim.method}.</summary>
    public async Task<IReadOnlyList<${entity.name}>> ${claim.method}(DateTimeOffset staleBefore, int batchSize, CancellationToken cancellationToken = default)
    {
        RequireOwnTransaction(${csString(claim.method)});
        var leasedAt = BsonValues.Of(DateTimeOffset.UtcNow);
        var claimed = new List<${entity.name}>();
        for (var i = 0; i < batchSize; i++)
        {
            // Renueva el reloj SOLO si sigue esperando y sigue rancio: null = no quedan candidatos (o los demás se los llevó
            // otra réplica). Sin sesión: el reclamo confirma al volver.
            var document = await Collection.FindOneAndUpdateAsync<BsonDocument>(
                new BsonDocument { ${filter.join(', ')} },
                new BsonDocument("$set", new BsonDocument(${csString(stamp)}, leasedAt)),
                new FindOneAndUpdateOptions<BsonDocument> { Sort = new BsonDocument(${csString(stamp)}, 1), ReturnDocument = ReturnDocument.After },
                cancellationToken);
            if (document is null)
            {
                break;
            }
            claimed.Add(ToDomain${entity.name}(document));
        }
${passSignal(model, claim, 'claimed.Count', '        ')}        return claimed;
    }`
  ];
  if (!hasOwnTransactionHelper(model, entity)) methods.push(ownTransactionHelper);
  return methods;
}
