// El alcance por recurso (`security.authentication.scoping`, tramo 13h-b): el `CallerScope` y el `JwtCallerScope` de los
// otros tres. El puerto va en `internal/application` y lo satisface `security.CallerScope`, que lee el token del principal
// de la petición en curso. Lo reciben los handlers de las operaciones que declaran el error del alcance; qué recurso
// comprueban lo dice su nota, y un listado filtra por `ScopedValues` con una consulta que escribe el agente.
//
// Lo que Go obliga a decidir: `Covers` recibe un `string`, sin el nulo de los otros tres. El vacío es el valor ausente de
// Go, así que el claim no lo enumera nunca y un recurso sin valor queda fuera del alcance, como su null.

import { usesCallerScope } from '@keel-system/keel-core/gen/features';
import { goString } from '../lib/go-source.js';
import { applicationPath, layout, packageFile } from './render.js';

/** ¿Lleva la nota del 403? Las que declaran el error del alcance. El puerto lo reciben todas (use-cases.js). */
export function scopedOperation(model, operation) {
  const scoping = model.security?.scoping;
  return Boolean(usesCallerScope(model) && scoping && (operation.errors ?? []).includes(scoping.error));
}

/** El campo de `application.Dependencies` y el parámetro del handler que llevan el alcance del llamante. */
export const CALLER_SCOPE = { field: 'CallerScope', param: 'callerScope', port: 'CallerScope' };

/** La nota del handler: la misma que keel-spring, keel-nest y keel-dotnet, con los nombres de Go. */
export function callerScopeNote(model, operation) {
  if (!scopedOperation(model, operation)) return null;
  const { over, error, exemptRoles, exemptClients = [] } = model.security.scoping;
  const exempt = [...exemptRoles, ...exemptClients.map((client) => `cliente ${client}`)];
  return (
    `Alcance (security.authentication.scoping): h.${CALLER_SCOPE.param} ya está inyectado; comprueba ` +
    `h.${CALLER_SCOPE.param}.Covers(ctx, <${over} del recurso>) donde lo digan las reglas; fuera del alcance, ${error}. ` +
    `Exentos: ${exempt.join(', ') || 'ninguno'}. En un listado, filtra por h.${CALLER_SCOPE.param}.ScopedValues(ctx) con un finder acotado que escribes tú`
  );
}

/** El puerto, el adaptador y su prueba emitida. `platform` es el paquete de la seguridad. */
export function callerScopeFiles(model, platform) {
  if (!usesCallerScope(model)) return [];
  const file = (name, options) => ({ path: `${platform.dir}/${name}.go`, content: packageFile(model, platform, options) });
  return [
    { path: applicationPath(model, 'CallerScope'), content: packageFile(model, layout(model).application, { imports: ['context'], body: portGo(model) }) },
    file('caller_scope', { imports: ['context', 'encoding/json/jsontext', 'encoding/json/v2', 'slices', 'strings'], body: adapterGo(model) }),
    file('caller_scope_test', { test: true, imports: ['encoding/json/jsontext', 'slices', 'testing', platform.dir], body: testGo(model, platform) })
  ];
}

function portGo(model) {
  const { claim, over, exemptRoles, exemptClients = [] } = model.security.scoping;
  return `
// CallerScope es el alcance por recurso del llamante de la petición en curso (security.authentication.scoping: claim ${claim}
// sobre ${over}). Es un puerto para que los handlers no sepan de tokens; lo satisface security.CallerScope. Solo tiene sentido
// dentro de una petición HTTP: los listeners y los barridos no lo consultan.
type CallerScope interface {
	// IsExempt dice si el llamante está exento del alcance (roles exentos del diseño: ${exemptRoles.join(', ') || 'ninguno'};
	// clientes máquina exentos: ${exemptClients.join(', ') || 'ninguno'}).
	IsExempt(ctx context.Context) bool
	// ScopedValues son los valores de ${over} que enumera el claim del llamante (ninguno si no trae el claim).
	ScopedValues(ctx context.Context) []string
	// Covers dice si value está en el alcance: se evalúa contra el valor tal como llega, exista el recurso o no. El vacío, un
	// recurso sin valor, solo lo cubre la exención.
	Covers(ctx context.Context, value string) bool
}
`;
}

function adapterGo(model) {
  const { claim, exemptRoles, exemptClients = [] } = model.security.scoping;
  const list = (values) => `[]string{${values.map(goString).join(', ')}}`;
  return `
// scopingClaim es el claim que enumera el alcance del llamante.
const scopingClaim = ${goString(claim)}

var (
	// exemptAuthorities son las authorities de los roles exentos del alcance.
	exemptAuthorities = ${list(exemptRoles.map((role) => `ROLE_${role}`))}
	// exemptClients son los clientes máquina exentos del alcance.
	exemptClients = ${list(exemptClients)}
)

// CallerScope lee el alcance por recurso del token de la petición en curso: el claim como lista o como texto separado por
// comas o espacios. Exentos, los roles del diseño y los clientes máquina, reconocidos por el cliente de la credencial (azp,
// client_id o el nombre del principal, el mismo criterio que la identidad del llamante). La exención es solo del alcance:
// las reglas de acceso ya se aplicaron. Satisface application.CallerScope.
type CallerScope struct{}

// IsExempt dice si el llamante de la petición en curso está exento del alcance.
func (CallerScope) IsExempt(ctx context.Context) bool {
	principal, ok := PrincipalFrom(ctx)
	if !ok {
		return false
	}
	return slices.ContainsFunc(exemptAuthorities, principal.Has) || slices.Contains(exemptClients, credentialClient(principal))
}

// ScopedValues son los valores que enumera el claim del llamante: ninguno sin token o sin el claim.
func (CallerScope) ScopedValues(ctx context.Context) []string {
	principal, ok := PrincipalFrom(ctx)
	if !ok || principal.Kind != TokenPrincipal {
		return nil
	}
	claim, ok := principal.Claims[scopingClaim]
	if !ok {
		return nil
	}
	return scopedValuesOf(claim)
}

// Covers dice si value está en el alcance del llamante, o si este está exento.
func (scope CallerScope) Covers(ctx context.Context, value string) bool {
	return scope.IsExempt(ctx) || slices.Contains(scope.ScopedValues(ctx), value)
}

// credentialClient es el cliente de la credencial: azp, client_id o, a falta de los dos, el nombre del principal.
func credentialClient(principal *Principal) string {
	for _, name := range []string{"azp", "client_id"} {
		if client, ok := ClaimText(principal.Claims, name); ok && client != "" {
			return client
		}
	}
	return principal.Name
}

// scopedValuesOf lee el claim como lista de textos o como texto separado por comas o espacios; otra forma no enumera nada.
// Un valor vacío tampoco: es el de un recurso sin valor.
func scopedValuesOf(claim jsontext.Value) []string {
	var values []string
	if json.Unmarshal(claim, &values) == nil {
		return slices.DeleteFunc(values, func(value string) bool { return value == "" })
	}
	var text string
	if json.Unmarshal(claim, &text) != nil {
		return nil
	}
	return strings.FieldsFunc(text, func(r rune) bool { return strings.ContainsRune(", \\t\\n\\r", r) })
}
`;
}

function testGo(model, platform) {
  const { claim, exemptRoles, exemptClients = [] } = model.security.scoping;
  const pkg = platform.name;
  const claimKey = goString(claim);
  const role = exemptRoles[0];
  const client = exemptClients[0];
  const roleTest = role
    ? `
func TestUnRolExentoAlcanzaCualquierRecurso(t *testing.T) {
	ctx := ${pkg}.WithPrincipal(t.Context(), caller([]string{${goString(`ROLE_${role}`)}}, "ana", nil))
	scope := ${pkg}.CallerScope{}
	if !scope.IsExempt(ctx) || !scope.Covers(ctx, "CUALQUIERA") {
		t.Error("el rol exento no alcanza cualquier recurso")
	}
}
`
    : '';
  const clientJson = goString(JSON.stringify(client ?? ''));
  const clientTest = client
    ? `
func TestUnClienteExentoSeReconocePorLaCredencial(t *testing.T) {
	scope := ${pkg}.CallerScope{}
	for _, claims := range []map[string]string{{"azp": ${clientJson}}, {"client_id": ${clientJson}}} {
		if !scope.IsExempt(${pkg}.WithPrincipal(t.Context(), caller(nil, "service-account", claims))) {
			t.Errorf("con los claims %v el cliente no está exento", claims)
		}
	}
	if !scope.IsExempt(${pkg}.WithPrincipal(t.Context(), caller(nil, ${goString(client)}, nil))) {
		t.Error("por el nombre del principal, el cliente no está exento")
	}
	// azp manda sobre el nombre: un usuario que se llame como el cliente no se exime por llamarse así.
	if scope.IsExempt(${pkg}.WithPrincipal(t.Context(), caller(nil, ${goString(client)}, map[string]string{"azp": "\\"otro\\""}))) {
		t.Error("el cliente de la credencial es otro, y aun así está exento")
	}
}
`
    : '';
  return `
// caller es un llamante con los claims del token, cada uno como su JSON.
func caller(authorities []string, name string, claims map[string]string) *${pkg}.Principal {
	values := map[string]jsontext.Value{}
	for claim, value := range claims {
		values[claim] = jsontext.Value(value)
	}
	return &${pkg}.Principal{Kind: ${pkg}.TokenPrincipal, Name: name, Authorities: authorities, Claims: values}
}

func TestElClaimDelAlcanceSeLeeComoListaOComoTexto(t *testing.T) {
	for _, c := range []struct {
		raw  string
		want []string
	}{
		{"[\\"A\\", \\"B\\"]", []string{"A", "B"}},
		{"\\"A\\"", []string{"A"}},
		{"\\"A,B C\\\\tD\\"", []string{"A", "B", "C", "D"}},
		{"[\\"A\\", \\"\\"]", []string{"A"}},
		{"\\"\\"", nil},
		{"12", nil},
		{"{\\"a\\": \\"b\\"}", nil},
	} {
		ctx := ${pkg}.WithPrincipal(t.Context(), caller(nil, "ana", map[string]string{${claimKey}: c.raw}))
		if got := (${pkg}.CallerScope{}).ScopedValues(ctx); !slices.Equal(got, c.want) {
			t.Errorf("claim %s = %v, quiero %v", c.raw, got, c.want)
		}
	}
}

func TestElAlcanceCubreSoloLoQueEnumeraYDistingueMayusculas(t *testing.T) {
	ctx := ${pkg}.WithPrincipal(t.Context(), caller(nil, "ana", map[string]string{${claimKey}: "[\\"ACME\\", \\"\\"]"}))
	scope := ${pkg}.CallerScope{}
	if !scope.Covers(ctx, "ACME") {
		t.Error("el valor del claim no está en el alcance")
	}
	for _, value := range []string{"OTRO", "acme", ""} {
		if scope.Covers(ctx, value) {
			t.Errorf("%q está en el alcance de quien solo enumera ACME", value)
		}
	}
}

func TestSinPrincipalOSinClaimNoHayAlcance(t *testing.T) {
	scope := ${pkg}.CallerScope{}
	if scope.Covers(t.Context(), "ACME") || scope.IsExempt(t.Context()) {
		t.Error("sin petición autenticada no hay alcance ni exención")
	}
	ctx := ${pkg}.WithPrincipal(t.Context(), caller(nil, "ana", nil))
	if scope.Covers(ctx, "ACME") || scope.IsExempt(ctx) {
		t.Error("sin el claim no hay alcance ni exención")
	}
}
${roleTest}${clientTest}`;
}
