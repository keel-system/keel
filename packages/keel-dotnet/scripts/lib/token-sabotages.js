// El contrato del token (fase 2 de PLAN-PROVEEDOR-IDENTIDAD.md), en la prueba emitida TokenContractTests de las variantes
// con Cognito: cada uno tiene que caer en EXACTAMENTE los casos IDT-* marcados con su defecto, y lo dice un paso propio.
//   token-use           se acepta un token que no es un access token (D1)
//   scope-prefix        se corta el scope por la primera barra, sea de este resource server o de otro (D2)
//   client-translation  el cliente exento y la identidad 1:1 se comparan con el nombre declarado, no con su id (D3, D4)
export const TOKEN_SABOTAGES = {
  'token-use': {
    defects: ['D1'],
    edits: [['asset-vault-cognito/src/AssetVaultCognito.Infrastructure/Security/JwtAuthenticator.cs', 'if (!string.Equals(ClaimValues.Text(principal.Claims, "token_use"), "access", StringComparison.Ordinal))', 'if (string.Equals(ClaimValues.Text(principal.Claims, "token_use"), "never", StringComparison.Ordinal))']]
  },
  'scope-prefix': {
    defects: ['D2'],
    edits: [[
      'asset-vault-cognito/src/AssetVaultCognito.Infrastructure/Security/JwtAuthenticator.cs',
      '.Where(value => value.StartsWith(resourceServer + "/", StringComparison.Ordinal) && value.Length > resourceServer.Length + 1)\n            .Select(value => value[(resourceServer.Length + 1)..])',
      ".Where(value => resourceServer.Length >= 0)\n            .Select(value => value[(value.IndexOf('/', StringComparison.Ordinal) + 1)..])"
    ]]
  },
  'client-translation': {
    defects: ['D3', 'D4'],
    edits: [
      ['asset-vault-cognito/src/AssetVaultCognito.Infrastructure/Security/ServiceClientIds.cs', '=> Volatile.Read(ref ids).GetValueOrDefault(declaredName);', '=> declaredName;'],
      [
        'mailer-one-to-one-cognito/src/MailerOneToOneCognito.Infrastructure/Security/ServiceClientIds.cs',
        'if (string.Equals(id, clientId, StringComparison.Ordinal))',
        'if (string.Equals(id, clientId, StringComparison.Ordinal) && name.Length < 0)'
      ]
    ]
  }
};
