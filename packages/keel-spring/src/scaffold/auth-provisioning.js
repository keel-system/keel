// Aprovisionamiento del proveedor de identidad de prueba.
//
// El realm como dato (`realmSpec()`, keel-core/gen/identity-realm.js) y sus artefactos de infra/
// —`init-keycloak.sh`, `test-credentials.env` y la configuración del emulador de Cognito— son
// NEUTRALES (keel-core/gen/identity-provisioning.js): el servicio de keel-spring y el de keel-nest
// del mismo diseño se prueban contra el mismo realm. Aquí solo está la plataforma de keel-spring:
// los textos que nombran su arnés (AbstractFlowIT) y su skill.

import { identityProvisioningFiles } from 'keel-core/gen/identity-provisioning';
import { SPRING_INFRA } from './devtools.js';

export { cognitoMockConfig } from 'keel-core/gen/identity-provisioning';
export {
  secondUserOf,
  serviceClientSecret,
  secretEnvKey,
  scopingClaimChecks,
  tokenUrl,
  userTestClient,
  usesPersonaTokens,
  keycloakAdminCredentials,
  realmSpec
} from 'keel-core/gen/identity-realm';

export function generate(model) {
  return identityProvisioningFiles(model, SPRING_INFRA);
}
