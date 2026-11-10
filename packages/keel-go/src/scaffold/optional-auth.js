// La identidad opcional (DSL 2.27, `level: optional`) en la prueba emitida `internal/httpapi/optional_auth_test.go`: OA-1 a
// OA-3 de keel-core/gen/read-scope.js. La seguridad emitida (`a.secure`, con el JWTAuthenticator real y un emisor de la
// prueba) delante de rutas que llaman al LECTOR emitido de cada operación optional y responden con la identidad que
// estampó. La regla (`permitAll`), el estampado (`optionalCallerIdentity`) y la nota del handler los escriben security.js,
// endpoints.js y services.js.
//
// La misma pieza que mide keel-spring con read-scope-check, keel-nest ejecutando su hook y keel-dotnet con
// OptionalAuthTests; aquí la ejecuta `go-check --read-scope`, y los sabotajes oa-* (test/helpers/read-scope-sabotages.js)
// la falsan.

import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { FRAMEWORK_RESPONSES as FW } from '@keel-system/keel-core/gen/api-errors';
import { goExported } from '../lib/go-projection.js';
import { goString } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';
import { componentType, messageComponents } from './services.js';
import { securityPackage, securityPlan, securityTestPackage, usesJwt } from './security.js';

const SUBJECT = 'oa-user';

/** Las operaciones con `level: optional` que reciben la identidad del llamante por HTTP: las que pide la prueba. */
export function optionalAuthOperations(model) {
  return (model.services ?? [])
    .flatMap((group) => group.operations)
    .filter((operation) => operation.optionalAuth && operation.route && messageComponents(operation, model).some((component) => component.resolvedIdentity));
}

export function generate(model) {
  const operations = optionalAuthOperations(model);
  if (operations.length === 0 || !usesJwt(model)) return [];
  const { httpapi } = layout(model);
  const identity = model.security.callerIdentity;
  const claim = identity.source === 'claim' ? identity.claim : 'azp';
  // El sujeto y el claim de la identidad (que puede ser el propio sub), sin repetir clave: Go no admite una duplicada.
  const identityClaims = [...new Set(['sub', claim])].map((name) => `${goString(name)}: oaSubject`).join(', ');
  const field = goExported(identity.field);
  const plan = securityPlan(model);
  const init = [
    'logger: slog.New(slog.DiscardHandler)',
    'tokens: security.NewJWTAuthenticator(security.Settings{JWKS: jwks})',
    ...(model.security?.cors ? ['cors: security.NewCORSPolicy(nil)'] : []),
    ...(plan.audience ? [`audience: ${goString(plan.audience)}`] : [])
  ];
  let pointers = false;
  const routes = operations.map((operation) => {
    const component = messageComponents(operation, model).find((candidate) => candidate.resolvedIdentity);
    const pointer = componentType(operation, component).startsWith('*');
    pointers ||= pointer;
    const pattern = `${operation.route.method} ${model.api.routeBase}${operation.route.path}`;
    return `	mux.Handle(${goString(pattern)}, a.endpoint(func(_ *api, w http.ResponseWriter, r *http.Request) error {
		msg, err := read${goExported(operation.name)}(r)
		if err != nil {
			return err
		}
		return oaWrite(w, ${pointer ? `oaDeref(msg.${field})` : `msg.${field}`})
	}))`;
  });
  const requests = operations.map(
    (operation) => `	{${goString(operation.route.method)}, ${goString(`${model.api.routeBase}${operation.route.path}`.replace(/\{[^}]+\}/g, 'oa1'))}},`
  );
  const unauthenticated = FW.unauthenticated;
  const body = `
// La identidad opcional (DSL 2.27, level: optional) en el borde: OA-1 a OA-3 de keel-core/gen/read-scope.js, los mismos que
// ejecutan los otros tres generadores. La seguridad emitida delante de rutas que llaman al LECTOR emitido de cada operación
// optional y responden con la identidad que estampó: lo que se mide es lo que responde el servidor y lo que llega al caso
// de uso.

const oaSubject = ${goString(SUBJECT)}

// oaAnonymous es lo que responden las rutas de la prueba cuando el lector no estampó ninguna identidad.
const oaAnonymous = "<anónimo>"

// oaRequests son las operaciones optional del diseño, con un valor de ruta que cumple cualquier patrón.
var oaRequests = []struct{ method, url string }{
${requests.join('\n')}
}

// oaHandler es la seguridad emitida, con el JWKS de un emisor de la prueba, delante de una ruta por operación optional.
func oaHandler(t *testing.T) (http.Handler, *securitytest.Issuer) {
	t.Helper()
	issuer, err := securitytest.NewIssuer()
	if err != nil {
		t.Fatal(err)
	}
	jwks, err := issuer.JWKS()
	if err != nil {
		t.Fatal(err)
	}
	a := &api{${init.join(', ')}}
	mux := http.NewServeMux()
${routes.join('\n')}
	return a.edge(a.secure(mux)), issuer
}

func oaWrite(w http.ResponseWriter, identity string) error {
	if identity == "" {
		identity = oaAnonymous
	}
	_, err := io.WriteString(w, identity)
	return err
}
${pointers ? `
func oaDeref(identity *string) string {
	if identity == nil {
		return ""
	}
	return *identity
}
` : ''}
func oaToken(t *testing.T, issuer *securitytest.Issuer, claims map[string]any) string {
	t.Helper()
	token, err := issuer.Token(claims)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func oaSend(handler http.Handler, method, url, token string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, url, nil)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestOA1SinTokenLaOperacionOptionalEntraAnonima(t *testing.T) {
	handler, _ := oaHandler(t)
	for _, request := range oaRequests {
		if got := oaSend(handler, request.method, request.url, ""); got.Code != http.StatusOK || got.Body.String() != oaAnonymous {
			t.Errorf("%s %s sin token = %d %q; quiero 200 y la identidad vacía", request.method, request.url, got.Code, got.Body.String())
		}
	}
}

func TestOA2ConUnTokenValidoLlegaLaIdentidad(t *testing.T) {
	handler, issuer := oaHandler(t)
	token := oaToken(t, issuer, map[string]any{${identityClaims}})
	for _, request := range oaRequests {
		if got := oaSend(handler, request.method, request.url, token); got.Code != http.StatusOK || got.Body.String() != oaSubject {
			t.Errorf("%s %s con un token válido = %d %q; quiero 200 y %s", request.method, request.url, got.Code, got.Body.String(), oaSubject)
		}
	}
}

func TestOA3ConUnTokenInvalidoOCaducadoEs401(t *testing.T) {
	handler, issuer := oaHandler(t)
	other, err := securitytest.NewIssuer()
	if err != nil {
		t.Fatal(err)
	}
	claims := map[string]any{${identityClaims}}
	expired := map[string]any{${identityClaims}, "exp": time.Now().Add(-10 * time.Minute).Unix()}
	for name, token := range map[string]string{
		"mal formado":   "no-es-un-jwt",
		"caducado":      oaToken(t, issuer, expired),
		"de otra clave": oaToken(t, other, claims),
	} {
		for _, request := range oaRequests {
			got := oaSend(handler, request.method, request.url, token)
			var body struct {
				Status  int    \`json:"status"\`
				Error   string \`json:"error"\`
				Code    string \`json:"code"\`
				Message string \`json:"message"\`
			}
			if got.Code != ${unauthenticated.status} || json.Unmarshal(got.Body.Bytes(), &body) != nil ||
				body.Status != ${unauthenticated.status} || body.Error != ${goString(unauthenticated.error)} ||
				body.Code != ${goString(FRAMEWORK_ERRORS.unauthenticated.code)} || body.Message != ${goString(unauthenticated.message)} {
				t.Errorf("%s %s con un token %s = %d %q; quiero el 401 del cable, sin llegar al caso de uso", request.method, request.url, name, got.Code, got.Body.String())
			}
		}
	}
}
`;
  return [
    {
      path: `${httpapi.dir}/optional_auth_test.go`,
      content: packageFile(model, httpapi, {
        imports: [
          'encoding/json',
          'io',
          'log/slog',
          'net/http',
          'net/http/httptest',
          'testing',
          'time',
          securityPackage(model).dir,
          securityTestPackage(model).dir
        ],
        body
      })
    }
  ];
}
