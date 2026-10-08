// La matriz de paridad de las pasarelas de pago es NEUTRAL: lo que una pasarela cubre no depende
// del lenguaje del servidor. Vive en keel-core/gen/payment-gateways.js (la consume también
// keel-nest) y aquí solo se reexporta para los imports de siempre.

export {
  GATEWAY_STATES,
  GATEWAY_REQUIREMENTS,
  gatewayRequirements,
  checkGatewaySupport,
  gatewayCoverage
} from 'keel-core/gen/payment-gateways';
