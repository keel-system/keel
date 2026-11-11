// La prueba que demuestra el contrato entre el servidor y el TOKEN (casos IDT-* de keel-core/gen/token-cases.js), escrita
// en cada proyecto con la forma de token del proveedor elegido: `TokenContractTests.cs`. Firma sus tokens con la clave de
// TestCredential y los pasa por el JwtAuthenticator real, construido con la configuración del perfil test (la audiencia y
// el mapa de ids de security.yaml incluidos), sin red ni proveedor. Un método por caso, con el id del caso en su nombre:
// cs-check lee de ahí qué casos cae cada sabotaje.

import { checksAudience } from '@keel-system/keel-core/gen/access-plan';
import { tokenCases } from '@keel-system/keel-core/gen/token-cases';
import { csFile, csString, namespaceOf, solution } from './render.js';
import { TEST_JWKS_VARIABLE, audienceOf, usesJwt } from './security.js';
import { configNamespace } from './config.js';
import { usesTestCredential } from './test-credential.js';

/** El nombre del método de un caso: su id, que es lo que cs-check compara. */
export function tokenCaseMethod(id) {
  return id.replace(/-/g, '_');
}

/** Las líneas que afirman un caso, o [] si ninguna pieza de este diseño lo lee. */
function assertions(entry, { audienceChecked }) {
  const { expect } = entry;
  if (expect.authenticated === false) return ['await Assert.ThrowsAsync<InvalidCredentialException>(() => PrincipalOf(Claims));'];
  const lines = [];
  if (expect.principal !== undefined) lines.push(`Assert.Equal(${csString(expect.principal)}, principal.Name);`);
  for (const authority of expect.authorities?.includes ?? []) lines.push(`Assert.Contains(${csString(authority)}, principal.Authorities);`);
  for (const authority of expect.authorities?.excludes ?? []) lines.push(`Assert.DoesNotContain(${csString(authority)}, principal.Authorities);`);
  if (expect.identity !== undefined) lines.push(`Assert.Equal(${csString(expect.identity)}, Within(principal, CallerIdentity.Resolve));`);
  if (expect.exempt !== undefined) lines.push(`Assert.${expect.exempt ? 'True' : 'False'}(Within(principal, () => new JwtCallerScope().IsExempt()));`);
  if (expect.scope !== undefined) {
    lines.push(`Assert.True(Within(principal, () => new JwtCallerScope().ScopedValues()).SetEquals(new string[] { ${expect.scope.map(csString).join(', ')} }));`);
  }
  if (expect.issuedForService !== undefined && audienceChecked) lines.push(`Assert.${expect.issuedForService ? 'True' : 'False'}(JwtAuthenticator.IssuedFor(principal, Audience));`);
  if (lines.length === 0) return [];
  return ['var principal = await PrincipalOf(Claims);', ...lines];
}

export function generate(model) {
  if (!usesJwt(model) || !usesTestCredential(model)) return [];
  const audienceChecked = checksAudience(model.security);
  const tests = tokenCases(model).flatMap((entry) => {
    const lines = assertions(entry, { audienceChecked });
    if (lines.length === 0) return [];
    return [`    /// <summary>${entry.id}: ${entry.rule}.</summary>
    [Fact]
    public async Task ${tokenCaseMethod(entry.id)}()
    {
        const string Claims = """${JSON.stringify(entry.token)}""";
${lines.map((line) => `        ${line}`).join('\n')}
    }`];
  });
  if (tests.length === 0) return [];

  const sln = solution(model);
  const uses = (name) => tests.some((text) => text.includes(name));
  const body = `/// <summary>
/// El contrato entre este servidor y el token del proveedor de identidad (${model.stack.auth}): dado un token con la forma
/// que emite el proveedor, qué principal, qué authorities, qué identidad y qué exención ve el servidor. Los casos los
/// deriva el generador del diseño y del descriptor del proveedor (keel-core/gen/token-cases.js). Lo generó keel-dotnet
/// build: no se edita.
/// </summary>
public sealed class TokenContractTests
{
    /// <summary>El perfil test con la clave de TestCredential: la audiencia y los ids de los clientes, los de security.yaml.</summary>
    private static readonly ServiceConfiguration Configuration = ServiceConfiguration.Load(name => name switch
    {
        "PROFILE" => "test",
        ${csString(TEST_JWKS_VARIABLE)} => TestCredential.Jwks,
        _ => null
    });

${uses('Audience') ? `    private static readonly string Audience = Configuration.Get("security:audience") ?? ${csString(audienceOf(model))};

` : ''}${tests.join('\n\n')}

    private static Task<Principal> PrincipalOf(string claims) =>
        new JwtAuthenticator(Configuration).Authenticate(TestCredential.TokenWith(claims), TestContext.Current.CancellationToken);${uses('Within(') ? `

    private static T Within<T>(Principal principal, Func<T> read)
    {
        using var _ = SecurityContext.Open(principal);
        return read();
    }` : ''}
}`;
  return [
    {
      path: `${sln.unitTests.dir}/TokenContractTests.cs`,
      content: csFile({ namespace: sln.unitTests.name, usings: ['Xunit', configNamespace(model), namespaceOf(model, 'security')], body })
    }
  ];
}
