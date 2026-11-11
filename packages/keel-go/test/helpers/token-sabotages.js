// El contrato del token (fase 2 de PLAN-PROVEEDOR-IDENTIDAD.md): los diseños con los que `go-check --token` ejecuta la
// prueba emitida token_contract_test.go, y los sabotajes que la falsan. Cada sabotaje rompe UNA garantía en el Go emitido
// conservando que compile, y tiene que caer en EXACTAMENTE los casos IDT-* marcados con su defecto, y solo ellos. Los mismos
// ids que en keel-spring, keel-nest y keel-dotnet. test/token-contract.test.js comprueba sin Go que se siguen aplicando.

import { IDENTITY_DESIGNS } from '../../../keel-core/test/helpers/identity-designs.js';

/**
 * Los sujetos: asset-vault (scopes prefijados, exentos y alcance) con los dos proveedores, shop-api (identidad desde
 * `email`), notification-mailer (identidad del cliente con `resolvedBy`) y su silueta 1:1 de identity-designs.js.
 */
export const TOKEN_SUBJECTS = [
  { name: 'asset-vault-cognito', from: 'asset-vault', auth: 'cognito' },
  { name: 'asset-vault-keycloak', from: 'asset-vault', auth: 'keycloak' },
  { name: 'shop-api-cognito', from: 'shop-api', auth: 'cognito' },
  { name: 'notification-mailer-cognito', from: 'notification-mailer', auth: 'cognito' },
  // Las personas contra el emulador con la identidad en el sub (incremento 4.3): su rama de credentials_test.go, con vet y staticcheck.
  { name: 'conduit-cognito', from: 'conduit', auth: 'cognito' },
  ...IDENTITY_DESIGNS.map((design) => ({ name: `${design.name}-cognito`, from: design.from, auth: 'cognito', mutate: design.mutate }))
];

/** Los paquetes que ejecutan lo que el proveedor toca: la entrada HTTP y el mecanismo de seguridad. */
export const TOKEN_PACKAGES = ['./internal/httpapi/', './internal/platform/security/...'];

const JWT = 'internal/platform/security/jwt.go';

export const TOKEN_SABOTAGES = [
  {
    id: 'token-use',
    what: 'se acepta un token que no es un access token',
    defects: ['D1'],
    edits: [{ subject: 'asset-vault-cognito', file: JWT, find: '; kind != "access" {', replace: '; kind == "never" {' }]
  },
  {
    id: 'scope-prefix',
    what: 'el scope se corta por la primera barra, sea de este resource server o de otro',
    defects: ['D2'],
    edits: [
      {
        subject: 'asset-vault-cognito',
        file: JWT,
        find: 'if after, found := strings.CutPrefix(value, resourceServer+"/"); found && after != "" {',
        replace: 'if _, after, found := strings.Cut(value, "/"); found && after != "" && resourceServer != "" {'
      }
    ]
  },
  {
    id: 'client-translation',
    what: 'el cliente exento y la identidad 1:1 se comparan con el nombre declarado, no con su id',
    defects: ['D3', 'D4'],
    edits: ['asset-vault-cognito', 'mailer-one-to-one-cognito'].map((subject) => ({
      subject,
      file: JWT,
      find: 'if configured == id {',
      replace: 'if configured == id && name == id {'
    }))
  }
];

/** El texto con la edición aplicada, o null si ya no contiene lo que busca. */
export function applyTokenEdit(edit, text) {
  return text.includes(edit.find) ? text.replace(edit.find, () => edit.replace) : null;
}
