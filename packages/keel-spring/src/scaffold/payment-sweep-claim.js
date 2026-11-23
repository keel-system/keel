// El reclamo del barrido de pagos (`payments.reconciliation.sweep`), generado por build (corrida payment de
// prueba-gelsa, G11).
//
// Lo escribía el agente: un `@Modifying` en el adaptador del registro, que lleva `@Transactional(readOnly = true)` de
// clase, así que heredaba la transacción de solo lectura y fallaba (`claimAwaiting` de payment). Es la forma de un
// RESCATE —renovar el reloj con una escritura condicional que solo casa si la fila sigue atascada, sin mover el estado—
// con dos diferencias: varios estados en espera con UN solo reloj (`record.awaitingSince`), y el plazo y el lote son
// del barrido de pagos (`PaymentReconciliation.staleBefore(now)` y `batchSize()`, que el handler pasa). Por eso no va en
// `operation.claim` del modelo neutral: los otros tres generadores lo emitirían como un rescate más, con las claves de
// `sweep.yaml`, y el umbral es del diseño.
//
// El cobro reclamado se consulta FUERA de esta llamada: el reclamo se confirma antes de volver (transacción propia), y
// la llamada a la pasarela no puede ir dentro de ninguna transacción.

import { scheduledByTimer } from '@keel-system/keel-core/gen/timer-plan';
import { screamingSnake } from '../lib/naming.js';
import { claimSelectionSnippet, claimTransaction } from '../lib/claim-sql.js';
import { jpqlLive } from './data-lifecycle.js';
import { sweepPassImport } from './timer.js';
import { subPackage } from './render.js';

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

const stateList = (claim, enumType) => claim.states.map((state) => `${enumType}.${screamingSnake(state)}`).join(', ');

function describe(entityName, claim) {
  return `Reclama hasta {@code batchSize} ${entityName} que esperan un desenlace de la pasarela (${claim.states.join(', ')}) con
     * {@code ${claim.stampField}} anterior a {@code staleBefore}, y los devuelve SIGUIENDO en su estado con
     * {@code ${claim.stampField}} renovado: es el reclamo del barrido de pagos (${claim.sweep}).
     *
     * <p><b>Reclama, no lee.</b> El barrido puede correr en varias réplicas a la vez; el reclamo es una escritura
     * condicional que solo casa si la fila sigue esperando y sigue rancia, y renueva el reloj en la misma escritura,
     * así que lo que otra réplica reclamó antes no aparece aquí. Se COMMITEA antes de volver (transacción propia):
     * consulta la pasarela con {@code paymentReconciliation.consult(...)} FUERA de esta llamada.
     *
     * <p>Los dos números son del barrido de pagos y los pasa el handler: {@code paymentReconciliation.staleBefore(now)}
     * (el umbral del diseño) y {@code paymentReconciliation.batchSize()}.`;
}

/** El método del puerto <E>Repository. */
export function portMethods(model, entity, imports) {
  const claim = paymentSweepClaim(model, entity);
  if (!claim) return [];
  imports.add('java.time.Instant');
  imports.add('java.util.List');
  return [
    `    /**
     * ${describe(entity.name, claim)}
     */
    List<${entity.name}> ${claim.method}(Instant staleBefore, int batchSize);`
  ];
}

/** Las consultas de la interfaz Spring Data <E>JpaRepository (modelo relacional). */
export function jpaRepositoryMethods(model, entity, imports) {
  const claim = paymentSweepClaim(model, entity);
  if (!claim) return [];
  const { enumType, field } = entity.lifecycle;
  const selection = claimSelectionSnippet({ database: model.stack?.database, subject: 'el reclamo del barrido de pagos' });
  for (const imported of [
    'java.time.Instant',
    'java.util.List',
    'java.util.UUID',
    'org.springframework.data.domain.Pageable',
    'org.springframework.data.jpa.repository.Modifying',
    'org.springframework.data.jpa.repository.Query',
    'org.springframework.data.repository.query.Param',
    `${subPackage(model, 'domain.enums')}.${enumType}`,
    ...selection.imports
  ]) imports.add(imported);
  const stale = `e.${field} in :states and e.${claim.stampField} < :staleBefore`;
  return [
    `${selection.annotations}
    @Query("select e.id from ${entity.name}Jpa e where ${stale}${jpqlLive(entity)} order by e.${claim.stampField} asc")
    List<UUID> candidatesForPaymentSweep(@Param("states") List<${enumType}> states, @Param("staleBefore") Instant staleBefore, Pageable pageable);`,
    `    /**
     * Renueva {@code ${claim.stampField}} SOLO si la fila sigue esperando y sigue rancia. Devuelve 1 si esta instancia
     * se la llevó y 0 si otra llegó antes: esa comparación en el WHERE es toda la exclusión mutua.
     */
    @Modifying
    @Query("update ${entity.name}Jpa e set e.${claim.stampField} = :leasedAt where e.id = :id and ${stale}")
    int ${claim.method}(@Param("id") UUID id, @Param("states") List<${enumType}> states, @Param("staleBefore") Instant staleBefore, @Param("leasedAt") Instant leasedAt);`
  ];
}

/** La señal de lote lleno, si el barrido lo dispara el cronómetro (que repite la pasada). */
function passSignal(model, claim, imports, size) {
  if (!scheduledByTimer(model, claim.sweep)) return '';
  imports.add(sweepPassImport(model));
  return `        // Lote lleno: puede que queden candidatos, y el tick del cronómetro repite la pasada (drenaje).
        SweepPass.claimed(${size}, batchSize);
`;
}

/** El método del adaptador <E>RepositoryImpl (modelo relacional). */
export function adapterMethods(model, entity, imports, jpaField) {
  const claim = paymentSweepClaim(model, entity);
  if (!claim) return [];
  const { enumType } = entity.lifecycle;
  // La transacción PROPIA del reclamo (REQUIRES_NEW, y READ_COMMITTED donde el motor lo pide): anotada en el método,
  // que es lo que le faltaba al del agente bajo el @Transactional(readOnly = true) de la clase.
  const claimTx = claimTransaction(model.stack?.database);
  for (const imported of [
    'java.time.Instant',
    'java.util.ArrayList',
    'java.util.List',
    'java.util.UUID',
    'org.springframework.data.domain.PageRequest',
    `${subPackage(model, 'domain.enums')}.${enumType}`,
    ...claimTx.imports
  ]) imports.add(imported);
  return [
    `    /**
     * ${describe(entity.name, claim)}
     */
    @Override
${claimTx.annotation}
    public List<${entity.name}> ${claim.method}(Instant staleBefore, int batchSize) {
        // El reloj renovado, uno por tanda: el reclamo ARRIENDA la fila, no la mueve de estado.
        Instant leasedAt = Instant.now();
        List<${enumType}> states = List.of(${stateList(claim, enumType)});
        List<UUID> candidates = ${jpaField}.candidatesForPaymentSweep(states, staleBefore, PageRequest.of(0, batchSize));
        List<${entity.name}> claimed = new ArrayList<>();
        for (UUID id : candidates) {
            // 1 = la fila era mía; 0 = otra réplica la reclamó entre el select y el update.
            if (${jpaField}.${claim.method}(id, states, staleBefore, leasedAt) == 1) {
                ${jpaField}.findById(id).map(this::toDomain).ifPresent(claimed::add);
            }
        }
${passSignal(model, claim, imports, 'candidates.size()')}        return claimed;
    }`
  ];
}

/**
 * El método del adaptador documental: un findAndModify por candidato, que filtra por esperando y rancio y renueva el
 * reloj en la MISMA operación atómica.
 */
export function documentAdapterMethods(model, entity, imports) {
  const claim = paymentSweepClaim(model, entity);
  if (!claim) return [];
  const { enumType, field } = entity.lifecycle;
  for (const imported of [
    'java.time.Instant',
    'java.util.ArrayList',
    'java.util.List',
    'org.springframework.data.domain.Sort',
    'org.springframework.data.mongodb.core.FindAndModifyOptions',
    'org.springframework.data.mongodb.core.query.Criteria',
    'org.springframework.data.mongodb.core.query.Query',
    'org.springframework.data.mongodb.core.query.Update',
    `${subPackage(model, 'domain.enums')}.${enumType}`
  ]) imports.add(imported);
  return [
    `    /**
     * ${describe(entity.name, claim)}
     */
    @Override
    public List<${entity.name}> ${claim.method}(Instant staleBefore, int batchSize) {
        Instant leasedAt = Instant.now();
        List<${entity.name}> claimed = new ArrayList<>();
        FindAndModifyOptions options = FindAndModifyOptions.options().returnNew(true);
        for (int i = 0; i < batchSize; i++) {
            Query query = Query.query(Criteria.where("${field}").in(List.of(${stateList(claim, enumType)}))
                    .and("${claim.stampField}").lt(staleBefore))
                    .with(Sort.by(Sort.Direction.ASC, "${claim.stampField}"));
            ${entity.name}Document document = mongoTemplate.findAndModify(query, new Update().set("${claim.stampField}", leasedAt), options, ${entity.name}Document.class);
            if (document == null) {
                break;
            }
            claimed.add(toDomain(document));
        }
${passSignal(model, claim, imports, 'claimed.size()')}        return claimed;
    }`
  ];
}
