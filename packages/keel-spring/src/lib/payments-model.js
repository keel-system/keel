// El modelo de la capa payments para keel-spring.
//
// La interpretación del diseño es NEUTRAL y vive en keel-core/gen: la comparte cualquier generador,
// y es lo que hace que dos servidores del mismo diseño nazcan del mismo modelo. Aquí solo se le
// pasa la proyección Java (java-projection.js) y se reexporta lo que el scaffolding ya importaba
// de este módulo.

export { GATEWAY_STATUSES, OUTCOME_STATUS, collectPayments, callsPaymentGateway } from 'keel-core/gen/payments-model';
