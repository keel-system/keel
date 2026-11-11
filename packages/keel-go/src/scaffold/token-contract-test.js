// La prueba que demuestra el contrato entre el servidor y el TOKEN (casos IDT-* de keel-core/gen/token-cases.js), escrita
// en cada proyecto con la forma de token del proveedor elegido: `internal/httpapi/token_contract_test.go`. Firma sus tokens
// con securitytest y los pasa por el JWTAuthenticator real, construido con la configuración del perfil test cargada de
// verdad (la audiencia y los ids de los clientes de security.yaml), sin red ni proveedor. Va en el paquete httpapi y no en
// httpapi_test porque la identidad del llamante (callerIdentity) no se exporta. Una prueba por caso, con el id del caso en
// su nombre: go-check lee de ahí qué casos cae cada sabotaje.

import { audienceOf, checksAudience } from '@keel-system/keel-core/gen/access-plan';
import { securityPlan } from '@keel-system/keel-core/gen/features';
import { tokenCases } from '@keel-system/keel-core/gen/token-cases';
import { TEST_JWKS_VARIABLE } from '@keel-system/keel-core/gen/security-config';
import { goString } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';
import { goLiteral, securityPackage, securityTestPackage, usesJwt } from './security.js';

export const TOKEN_CONTRACT_TEST = 'token_contract_test.go';

/** El nombre de la prueba de un caso: `IDT-NOT-ACCESS-TOKEN` → `TestIDTNotAccessToken`. */
export function tokenCaseTest(id) {
  const [, ...words] = id.split('-');
  return `TestIDT${words.map((word) => word[0] + word.slice(1).toLowerCase()).join('')}`;
}

/** Las líneas que afirman un caso, o [] si ninguna pieza de este diseño lo lee. */
function assertions(entry, { audienceChecked, audience }) {
  const { expect } = entry;
  const claims = goLiteral(entry.token);
  if (expect.authenticated === false) {
    return [
      `if _, err := idtPrincipal(t, ${claims}); !errors.Is(err, security.ErrInvalidCredential) {`,
      '\tt.Errorf("err = %v, quiero ErrInvalidCredential (401)", err)',
      '}'
    ];
  }
  const lines = [];
  if (expect.principal !== undefined) {
    lines.push(`if principal.Name != ${goString(expect.principal)} {`, `\tt.Errorf("principal = %q, quiero %q", principal.Name, ${goString(expect.principal)})`, '}');
  }
  const list = (values) => `[]string{${values.map(goString).join(', ')}}`;
  if (expect.authorities?.includes?.length) {
    lines.push(`for _, authority := range ${list(expect.authorities.includes)} {`, '\tif !principal.Has(authority) {', '\t\tt.Errorf("falta la authority %s", authority)', '\t}', '}');
  }
  if (expect.authorities?.excludes?.length) {
    lines.push(`for _, authority := range ${list(expect.authorities.excludes)} {`, '\tif principal.Has(authority) {', '\t\tt.Errorf("sobra la authority %s", authority)', '\t}', '}');
  }
  const inContext = [];
  if (expect.identity !== undefined) {
    inContext.push(
      `if got, err := callerIdentity(ctx); err != nil || got != ${goString(expect.identity)} {`,
      `\tt.Errorf("identidad = %q (%v), quiero %q", got, err, ${goString(expect.identity)})`,
      '}'
    );
  }
  if (expect.exempt !== undefined) {
    inContext.push(`if ${expect.exempt ? '!' : ''}(security.CallerScope{}).IsExempt(ctx) {`, `\tt.Error(${goString(expect.exempt ? 'no está exento del alcance' : 'está exento del alcance')})`, '}');
  }
  if (expect.scope !== undefined) {
    inContext.push(
      `if got := (security.CallerScope{}).ScopedValues(ctx); !slices.Equal(got, ${list(expect.scope)}) {`,
      `\tt.Errorf("alcance = %v, quiero %v", got, ${list(expect.scope)})`,
      '}'
    );
  }
  if (inContext.length > 0) lines.push('ctx := security.WithPrincipal(t.Context(), principal)', ...inContext);
  if (expect.issuedForService !== undefined && audienceChecked) {
    lines.push(`if ${expect.issuedForService ? '!' : ''}security.IssuedFor(principal, ${goString(audience)}) {`, `\tt.Error(${goString(expect.issuedForService ? 'el token no está emitido para este servicio' : 'el token de otro servicio pasa por de este')})`, '}');
  }
  if (lines.length === 0) return [];
  return [`principal, err := idtPrincipal(t, ${claims})`, 'if err != nil {', '\tt.Fatal(err)', '}', ...lines];
}

export function generate(model) {
  const plan = securityPlan(model);
  if (!usesJwt(model) || !plan || plan.open) return [];
  const context = { audienceChecked: checksAudience(model.security), audience: audienceOf(model) };
  const tests = tokenCases(model).flatMap((entry) => {
    const lines = assertions(entry, context);
    if (lines.length === 0) return [];
    return [`// ${tokenCaseTest(entry.id)}: ${entry.id}, ${entry.rule}.
func ${tokenCaseTest(entry.id)}(t *testing.T) {
${lines.map((line) => `\t${line}`).join('\n')}
}`];
  });
  if (tests.length === 0) return [];

  const { httpapi, configFiles } = layout(model);
  const body = `
// El contrato entre este servidor y el token del proveedor de identidad (${model.stack.auth}): dado un token con la forma que
// emite el proveedor, qué principal, qué authorities, qué identidad y qué exención ve el servidor. Los casos los deriva el
// generador del diseño y del descriptor del proveedor (keel-core/gen/token-cases.js).

// idtIssuer firma los tokens de los casos; su JWKS es el que acepta el perfil test.
var idtIssuer = sync.OnceValues(securitytest.NewIssuer)

// idtPrincipal pasa un token con esos claims por el autenticador del perfil test, cargado de verdad: la audiencia y los
// ids de los clientes son los de security.yaml.
func idtPrincipal(t *testing.T, claims map[string]any) (*security.Principal, error) {
	t.Helper()
	issuer, err := idtIssuer()
	if err != nil {
		t.Fatal(err)
	}
	jwks, err := issuer.JWKS()
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(configfiles.Files, func(name string) string {
		switch name {
		case "PROFILE":
			return "test"
		case ${goString(TEST_JWKS_VARIABLE)}:
			return jwks
		}
		return ""
	})
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	token, err := issuer.Token(claims)
	if err != nil {
		t.Fatal(err)
	}
	return security.NewJWTAuthenticator(security.SettingsFrom(cfg)).Authenticate(t.Context(), token)
}

${tests.join('\n\n')}
`;
  return [
    {
      path: `${httpapi.dir}/${TOKEN_CONTRACT_TEST}`,
      content: packageFile(model, httpapi, {
        imports: [
          'errors',
          'slices',
          'sync',
          'testing',
          { path: configFiles.importPath, name: 'configfiles' },
          'internal/platform/config',
          securityPackage(model).dir,
          securityTestPackage(model).dir
        ],
        body
      })
    }
  ];
}
