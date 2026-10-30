// Las credenciales del arnés de integración: lo que en keel-spring da AbstractFlowIT (`tokenFor`, `serviceCredential`,
// `tokenAs`), en keel-nest `flow.ts` y en keel-dotnet `Support/Credentials.cs`, aquí como
// `tests/integration/credentials_test.go`: métodos de `*Scenario` (`TokenFor`, `SecondTokenFor`, `ServiceCredential`,
// `TokenAs`) y `Bearer`, la cabecera con la que viajan.
//
// Los valores salen de `infra/test-credentials.env`, que escribe build junto al script que siembra el proveedor
// (keel-core/gen/identity-provisioning.js): un solo productor, un solo consumidor, ningún literal inventado a los dos
// lados. Una variable de entorno del mismo nombre manda sobre el archivo.
//
// Se emite solo con capa security de token; y cada función, solo si el diseño la hace posible: sin roles no hay
// usuarios a los que pedir un token, sin `serviceAuth` no hay clientes máquina, y sin la identidad en un claim no hay
// personas (además, staticcheck rechaza lo que no se usa). Qué credencial satisface la regla de cierre (la del humo)
// lo decide keel-core (`closingCredentialOf`), la misma para los cuatro generadores.
//
// Lo que la frontera de keel-go aún rechaza (la clave de API y el alcance por recurso: `ApiKey`, `ScopedResource` y
// `TokenWithScope` de los otros tres) no se emite: llegará con la primera fixture que lo mida.

import { closingCredentialOf, usesTokenProtocol } from '@keel-system/keel-core/gen/access-plan';
import { usesIdentityHarness } from '@keel-system/keel-core/gen/features';
import { keycloakAdminCredentials, secondUserOf, tokenUrl, TEST_USER_PASSWORD, userTestClient, usesPersonaTokens } from '@keel-system/keel-core/gen/identity-realm';
import { goString } from '../lib/go-source.js';

export { usesIdentityHarness };

/** El archivo de las credenciales, dentro del paquete de las pruebas de flujo. */
export const CREDENTIALS_FILE = 'credentials_test.go';

const roles = (model) => model.security.roles ?? [];
const machineTokens = (model) => Boolean(model.security.serviceAuth) && model.security.serviceAuth.protocol !== 'api-key';
const userTokens = (model) => roles(model).length > 0 || usesPersonaTokens(model);

/** ¿Lleva el arnés tokens? Solo con un protocolo de token: la clave de API la rechaza la frontera. */
export function usesTokenHarness(model) {
  return usesIdentityHarness(model) && usesTokenProtocol(model.security);
}

/**
 * Las cabeceras de la credencial que satisface la regla de cierre, como expresión Go dentro de un escenario (`s`):
 * null si no hay ninguna con la que llamar o el cierre es público.
 */
export function closingCredentialExpression(model) {
  if (!usesTokenHarness(model)) return null;
  const credential = closingCredentialOf(model);
  switch (credential?.kind) {
    case 'role':
      return `Bearer(s.TokenFor(${goString(credential.name)}))`;
    case 'persona':
      return `Bearer(s.TokenAs(Persona{Sub: ${goString(credential.name)}}))`;
    case 'client':
      return `Bearer(s.ServiceCredential(${goString(credential.name)}))`;
    default:
      return null;
  }
}

/** SMOKE-5: el proveedor de identidad emite las credenciales con las que van a llamar los flujos. */
export function smokeCredentialsCase(model) {
  if (!usesTokenHarness(model)) return null;
  const checks = [];
  const role = roles(model)[0];
  const client = machineTokens(model) ? model.security.serviceClients?.[0]?.name : null;
  // TokenFor y ServiceCredential ya terminan el escenario si el proveedor no da el token; el humo solo los ejerce.
  if (role) checks.push(`\t\tif s.TokenFor(${goString(role)}) == "" {\n\t\t\ts.Error(${goString(`el proveedor no devolvió token para el rol '${role}'`)})\n\t\t}`);
  if (client) {
    checks.push(`\t\tif s.ServiceCredential(${goString(client)}) == "" {\n\t\t\ts.Error(${goString(`no hay credencial de máquina para '${client}': revisa infra/test-credentials.env`)})\n\t\t}`);
  }
  if (checks.length === 0) return null;
  return `\tf.Scenario("SMOKE-5: el proveedor de identidad emite credenciales", func(s *Scenario) {
\t\t// Sin ellas, cada flujo autenticado fallaría con un 401 que parece de negocio. ¿Se sembró el proveedor (infra/init-keycloak.sh)?
${checks.join('\n')}
\t})`;
}

/** Los imports que puede usar `credentials_test.go`: el colector deja solo los que el cuerpo usa. */
export const CREDENTIALS_IMPORTS = [
  'context',
  'encoding/base64',
  'encoding/json',
  'errors',
  'fmt',
  'io',
  'maps',
  'net/http',
  'net/url',
  'os',
  'path/filepath',
  'slices',
  'strings',
  'sync',
  'time'
];

/** El cuerpo de `credentials_test.go`, o null sin tokens. */
export function credentialsBody(model) {
  if (!usesTokenHarness(model)) return null;
  const parts = [readerGo(), tokenCacheGo(model)];
  if (userTokens(model)) parts.push(passwordGrantGo(model));
  if (roles(model).length > 0) parts.push(tokenForGo());
  if (machineTokens(model)) parts.push(serviceCredentialGo());
  if (usesPersonaTokens(model)) parts.push(personaGo(model), adminGo(model));
  return parts.join('\n\n');
}

function readerGo() {
  return String.raw`// Las credenciales del proveedor de identidad de prueba para los flujos. Cada valor sale, por orden, de la variable de
// entorno, de infra/test-credentials.env —lo escribe build junto al script que siembra el proveedor: los nombres de
// cliente y los secretos tienen un ÚNICO productor— o del valor convencional.

// Bearer es la cabecera Authorization de un token: s.Get(ruta, Bearer(s.TokenFor("rol"))). Si el escenario necesita
// otra cabecera, se añade a la que devuelve (Set) o se pasa aparte: Get y compañía las juntan.
func Bearer(token string) http.Header {
	return http.Header{"Authorization": {"Bearer " + token}}
}

// credential es un valor de credencial: el entorno, después infra/test-credentials.env, después fallback.
func credential(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	if value, ok := provisioned()[name]; ok {
		return value
	}
	return fallback
}

// provisioned son las líneas NOMBRE=valor de infra/test-credentials.env; sin el archivo, ninguna.
var provisioned = sync.OnceValue(func() map[string]string {
	values := map[string]string{}
	root, err := projectRoot()
	if err != nil {
		return values
	}
	data, err := os.ReadFile(filepath.Join(root, "infra", "test-credentials.env"))
	if err != nil {
		return values
	}
	for line := range strings.Lines(string(data)) {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if name, value, ok := strings.Cut(line, "="); ok && strings.TrimSpace(name) != "" {
			values[strings.TrimSpace(name)] = strings.TrimSpace(value)
		}
	}
	return values
})`;
}

function tokenCacheGo(model) {
  return String.raw`// identityClient pide los tokens, con su plazo. No es el de los escenarios: pedir un token no es un intercambio que
// el escenario afirme, y no entra en su evidencia.
var identityClient = &http.Client{Timeout: 20 * time.Second}

// renewalMargin es el margen con el que se renueva un token antes de su exp.
const renewalMargin = 30 * time.Second

// tokens guarda cada token por su clave (el usuario, el cliente o la persona) durante la suite.
var tokens = struct {
	sync.Mutex
	byKey map[string]string
}{byKey: map[string]string{}}

// cachedToken es el token guardado con key, pedido de nuevo con mint si le queda poca vida. El realm de prueba
// emite tokens de CINCO minutos: un flujo con esperas reales se pasa de ahí, y un token guardado en una variable
// empieza a dar 401 a mitad del flujo, con un síntoma que no se parece a su causa.
func cachedToken(key string, mint func() (string, error)) (string, error) {
	tokens.Lock()
	cached, ok := tokens.byKey[key]
	tokens.Unlock()
	if ok && !expiresWithin(cached, renewalMargin) {
		return cached, nil
	}
	fresh, err := mint()
	if err != nil {
		return "", err
	}
	tokens.Lock()
	tokens.byKey[key] = fresh
	tokens.Unlock()
	return fresh, nil
}

// expiresWithin dice si a token le queda menos de margin. Uno cuyo exp no se lee se da por caducado.
func expiresWithin(token string, margin time.Duration) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return true
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return true
	}
	var claims struct {
		Exp *float64 ` + '`json:"exp"`' + String.raw`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Exp == nil {
		return true
	}
	return !time.Now().Add(margin).Before(time.Unix(int64(*claims.Exp), 0))
}

// tokenURL es el endpoint de token del proveedor (AUTH_TOKEN_URL).
func tokenURL() string {
	return credential("AUTH_TOKEN_URL", ${goString(tokenUrl(model))})
}

// requestToken pide un token al proveedor con el formulario form.
func requestToken(ctx context.Context, form url.Values) (string, error) {
	return postForm(ctx, tokenURL(), form, "¿Está la infraestructura arriba y sembrada (bash infra/up.sh)?")
}

// postForm manda form a endpoint y devuelve el access_token de la respuesta; si no llega, el error lleva hint.
func postForm(ctx context.Context, endpoint string, form url.Values, hint string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("armar la petición de token a %s: %w", endpoint, err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := identityClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("el proveedor de identidad (%s) no responde: %w. %s", endpoint, err, hint)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return "", fmt.Errorf("leer la respuesta del proveedor de identidad: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("el proveedor de identidad (%s) devolvió %d: %s. %s", endpoint, response.StatusCode, body, hint)
	}
	var granted struct {
		AccessToken string ` + '`json:"access_token"`' + String.raw`
	}
	if json.Unmarshal(body, &granted) != nil || granted.AccessToken == "" {
		return "", fmt.Errorf("el proveedor de identidad no devolvió access_token: %s", body)
	}
	return granted.AccessToken, nil
}`;
}

function passwordGrantGo(model) {
  return String.raw`// passwordGrant pide el token de un usuario del realm con el cliente público de prueba.
func passwordGrant(ctx context.Context, username string) (string, error) {
	return requestToken(ctx, url.Values{
		"grant_type": {"password"},
		"client_id":  {credential("AUTH_TEST_CLIENT", ${goString(userTestClient(model))})},
		"username":   {username},
		"password":   {credential("AUTH_TEST_PASSWORD", ${goString(TEST_USER_PASSWORD)})},
	})
}`;
}

function tokenForGo() {
  return String.raw`// TokenFor es el token de acceso del usuario de prueba con el rol role. El realm siembra DOS usuarios por rol
// (SecondTokenFor es el segundo, para los escenarios de titularidad) y uno autenticado sin roles: TokenFor("no-role").
// Se llama en CADA petición y no se guarda lo que devuelve: el token dura cinco minutos y se renueva aquí.
func (s *Scenario) TokenFor(role string) string {
	s.Helper()
	return s.userToken(role)
}

// SecondTokenFor es el token del SEGUNDO usuario del rol role (${secondUserOf('<rol>')}): otro titular con los mismos permisos.
func (s *Scenario) SecondTokenFor(role string) string {
	s.Helper()
	return s.userToken(${secondUserGo()})
}

// userToken es el token del usuario username, o el escenario termina aquí.
func (s *Scenario) userToken(username string) string {
	s.Helper()
	token, err := cachedToken("user:"+username, func() (string, error) { return passwordGrant(s.Context(), username) })
	if err != nil {
		s.Fatalf("token del usuario %q: %v", username, err)
	}
	return token
}`;
}

/** El nombre del segundo usuario de un rol, en Go, a partir de la misma convención que siembra el realm. */
function secondUserGo() {
  const suffix = secondUserOf('');
  return `role + ${goString(suffix)}`;
}

function serviceCredentialGo() {
  return String.raw`// ServiceCredential es el token de máquina (client_credentials) del cliente client: uno de security.serviceClients o de
// la matriz de prueba (test-m2m-*). El secreto sale de infra/test-credentials.env. Se llama en cada petición.
func (s *Scenario) ServiceCredential(client string) string {
	s.Helper()
	secret := credential(clientSecretVariable(client), "")
	if secret == "" {
		secret = credential("AUTH_CLIENT_SECRET", client+"-secret")
	}
	token, err := cachedToken("client:"+client, func() (string, error) {
		return requestToken(s.Context(), url.Values{"grant_type": {"client_credentials"}, "client_id": {client}, "client_secret": {secret}})
	})
	if err != nil {
		s.Fatalf("credencial de máquina de %q: %v", client, err)
	}
	return token
}

// clientSecretVariable es la variable del secreto propio de un cliente: AUTH_CLIENT_SECRET_<CLIENTE>.
func clientSecretVariable(client string) string {
	return "AUTH_CLIENT_SECRET_" + strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return '_'
	}, strings.ToUpper(client))
}`;
}

function personaGo(model) {
  return String.raw`// Persona es el llamante de un escenario que el diseño identifica por un claim: «el perfil de sub-ana-001», «el mismo
// token sin email». TokenFor no puede darlo (su sub lo asigna el realm y no lleva más claims), y TokenAs sí.
type Persona struct {
	// Sub es el claim sub exacto del token.
	Sub string
	// Claims son los claims que lleva el token además del sub (nunca el sub).
	Claims map[string]string
	// Without son los claims que el token NO lleva: «el mismo token sin email».
	Without []string
	// Role es el rol de realm de la persona; vacío, ninguno.
	Role string
}

// TokenAs es el token de la persona p: la da de alta (o la deja como la pide el escenario) por la API de
// administración del realm y pide su token. Se llama en cada petición, como TokenFor.
func (s *Scenario) TokenAs(p Persona) string {
	s.Helper()
	if _, ok := p.Claims["sub"]; ok || slices.Contains(p.Without, "sub") {
		s.Fatal("el sub de la persona va en Persona.Sub, no entre sus claims")
	}
	claims, err := json.Marshal(p.Claims)
	if err != nil {
		s.Fatalf("los claims de la persona %q: %v", p.Sub, err)
	}
	// Los claims QUITADOS también entran en la clave: «sin email» es otro token que «con email».
	key := "persona|" + p.Sub + "|" + p.Role + "|" + string(claims) + "|" + strings.Join(personaClaims(p), ",")
	token, err := cachedToken(key, func() (string, error) {
		if err := ensurePersona(s.Context(), p); err != nil {
			return "", err
		}
		return passwordGrant(s.Context(), p.Sub)
	})
	if err != nil {
		s.Fatalf("token de la persona %q: %v", p.Sub, err)
	}
	return token
}

// personaClaims son los claims que la persona nombra, los que lleva y los que no, ordenados.
func personaClaims(p Persona) []string {
	names := slices.Concat(slices.Collect(maps.Keys(p.Claims)), p.Without)
	slices.Sort(names)
	return slices.Compact(names)
}

// personas es lo que esta suite ya dejó en el realm: el User Profile preparado, los mappers de claim y cada persona
// como quedó. Un mutex para todo: dar de alta a una persona son varias llamadas que no se pueden cruzar.
var personas = struct {
	sync.Mutex
	realmReady bool
	mappers    map[string]bool
	applied    map[string]string
}{mappers: map[string]bool{}, applied: map[string]string{}}

// ensurePersona deja a la persona como la pide el escenario. Tres cosas que no son evidentes y costaron una pasada
// cada una en keel-spring: el alta va por partialImport (Keycloak 26 ignora el id de POST /users, y el sub es el id),
// los claims salen de atributos propios (kp_<claim>) con un mapper por claim, y el User Profile deja de exigir email
// y nombre.
func ensurePersona(ctx context.Context, p Persona) error {
	personas.Lock()
	defer personas.Unlock()
	admin, err := adminToken(ctx)
	if err != nil {
		return err
	}
	if !personas.realmReady {
		if err := preparePersonaRealm(ctx, admin); err != nil {
			return err
		}
		personas.realmReady = true
	}
	for _, claim := range personaClaims(p) {
		if personas.mappers[claim] {
			continue
		}
		if err := ensurePersonaMapper(ctx, admin, claim); err != nil {
			return err
		}
		personas.mappers[claim] = true
	}
	claims, err := json.Marshal(p.Claims)
	if err != nil {
		return fmt.Errorf("los claims de la persona %s: %w", p.Sub, err)
	}
	applied := p.Role + "|" + string(claims)
	if personas.applied[p.Sub] == applied {
		return nil
	}
	attributes := map[string]any{}
	for name, value := range p.Claims {
		attributes["kp_"+name] = []string{value}
	}
	user := map[string]any{
		"username":        p.Sub,
		"enabled":         true,
		"emailVerified":   true,
		"requiredActions": []string{},
		"attributes":      attributes,
	}
	id, err := userID(ctx, admin, p.Sub)
	if err != nil {
		return err
	}
	if id != "" && id != p.Sub {
		// Resto de otra ejecución creado con un id aleatorio: con él, el sub no sería el pedido.
		if _, err := adminCall[any](ctx, admin, http.MethodDelete, "/users/"+url.PathEscape(id), nil); err != nil {
			return err
		}
		id = ""
	}
	if id == "" {
		created := maps.Clone(user)
		created["id"] = p.Sub
		created["credentials"] = []map[string]any{{"type": "password", "value": credential("AUTH_TEST_PASSWORD", ${goString(TEST_USER_PASSWORD)}), "temporary": false}}
		if _, err := adminCall[any](ctx, admin, http.MethodPost, "/partialImport", map[string]any{"ifResourceExists": "SKIP", "users": []any{created}}); err != nil {
			return err
		}
		if id, err = userID(ctx, admin, p.Sub); err != nil {
			return err
		}
		if id != p.Sub {
			return fmt.Errorf("el realm no respetó el id pedido para la persona %s (asignó %q): el claim sub del token no sería el del escenario", p.Sub, id)
		}
		if p.Role != "" {
			role, err := adminCall[map[string]any](ctx, admin, http.MethodGet, "/roles/"+url.PathEscape(p.Role), nil)
			if err != nil {
				return err
			}
			if _, err := adminCall[any](ctx, admin, http.MethodPost, "/users/"+url.PathEscape(id)+"/role-mappings/realm", []any{role}); err != nil {
				return err
			}
		}
	} else if _, err := adminCall[any](ctx, admin, http.MethodPut, "/users/"+url.PathEscape(id), user); err != nil {
		return err
	}
	personas.applied[p.Sub] = applied
	return nil
}

// preparePersonaRealm deja el User Profile del realm con email y nombre opcionales y admite atributos no declarados.
func preparePersonaRealm(ctx context.Context, admin string) error {
	profile, err := adminCall[map[string]any](ctx, admin, http.MethodGet, "/users/profile", nil)
	if err != nil {
		return err
	}
	attributes, _ := profile["attributes"].([]any)
	for _, attribute := range attributes {
		if entry, ok := attribute.(map[string]any); ok && slices.Contains([]any{"email", "firstName", "lastName"}, entry["name"]) {
			delete(entry, "required")
		}
	}
	profile["unmanagedAttributePolicy"] = "ENABLED"
	_, err = adminCall[any](ctx, admin, http.MethodPut, "/users/profile", profile)
	return err
}

// ensurePersonaMapper pone en el cliente de prueba un mapper que saca el claim claim del atributo kp_<claim>.
func ensurePersonaMapper(ctx context.Context, admin, claim string) error {
	clientID := credential("AUTH_TEST_CLIENT", ${goString(userTestClient(model))})
	clients, err := adminCall[[]map[string]any](ctx, admin, http.MethodGet, "/clients?clientId="+url.QueryEscape(clientID), nil)
	if err != nil {
		return err
	}
	if len(clients) == 0 {
		return fmt.Errorf("no existe el cliente de prueba %q (¿se ejecutó infra/init-keycloak.sh?)", clientID)
	}
	internalID, _ := clients[0]["id"].(string)
	route := "/clients/" + url.PathEscape(internalID) + "/protocol-mappers/models"
	existing, err := adminCall[[]map[string]any](ctx, admin, http.MethodGet, route, nil)
	if err != nil {
		return err
	}
	name := "persona-" + claim
	if slices.ContainsFunc(existing, func(mapper map[string]any) bool { return mapper["name"] == name }) {
		return nil
	}
	_, err = adminCall[any](ctx, admin, http.MethodPost, route, map[string]any{
		"name":           name,
		"protocol":       "openid-connect",
		"protocolMapper": "oidc-usermodel-attribute-mapper",
		"config": map[string]string{
			"user.attribute":       "kp_" + claim,
			"claim.name":           claim,
			"jsonType.label":       "String",
			"access.token.claim":   "true",
			"id.token.claim":       "true",
			"userinfo.token.claim": "true",
		},
	})
	return err
}`;
}

function adminGo(model) {
  const admin = keycloakAdminCredentials();
  return String.raw`// userID es el id del usuario username (Keycloak lo guarda en minúsculas), o "" si no existe.
func userID(ctx context.Context, admin, username string) (string, error) {
	users, err := adminCall[[]map[string]any](ctx, admin, http.MethodGet, "/users?exact=true&username="+url.QueryEscape(username), nil)
	if err != nil {
		return "", err
	}
	for _, user := range users {
		if name, _ := user["username"].(string); strings.EqualFold(name, username) {
			id, _ := user["id"].(string)
			return id, nil
		}
	}
	return "", nil
}

// adminToken es un token de administración del realm master, con las credenciales de infra/test-credentials.env.
func adminToken(ctx context.Context) (string, error) {
	base, _, err := keycloakRealm()
	if err != nil {
		return "", err
	}
	return postForm(ctx, base+"/realms/master/protocol/openid-connect/token", url.Values{
		"grant_type": {"password"},
		"client_id":  {"admin-cli"},
		"username":   {credential("AUTH_ADMIN_USER", ${goString(admin.user)})},
		"password":   {credential("AUTH_ADMIN_PASSWORD", ${goString(admin.password)})},
	}, "Revisa AUTH_ADMIN_USER y AUTH_ADMIN_PASSWORD en infra/test-credentials.env.")
}

// adminCall llama a la API de administración del realm de prueba y lee la respuesta como T (sin cuerpo, su cero).
func adminCall[T any](ctx context.Context, admin, method, route string, body any) (T, error) {
	var result T
	base, realm, err := keycloakRealm()
	if err != nil {
		return result, err
	}
	var payload io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return result, fmt.Errorf("serializar la petición de administración %s %s: %w", method, route, err)
		}
		payload = strings.NewReader(string(data))
	}
	request, err := http.NewRequestWithContext(ctx, method, base+"/admin/realms/"+url.PathEscape(realm)+route, payload)
	if err != nil {
		return result, fmt.Errorf("armar la petición de administración %s %s: %w", method, route, err)
	}
	request.Header.Set("Authorization", "Bearer "+admin)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := identityClient.Do(request)
	if err != nil {
		return result, fmt.Errorf("administración del realm %s %s: %w", method, route, err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return result, fmt.Errorf("leer la respuesta de administración %s %s: %w", method, route, err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return result, fmt.Errorf("administración del realm %s %s devolvió %d: %s", method, route, response.StatusCode, data)
	}
	if len(data) == 0 {
		return result, nil
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return result, fmt.Errorf("leer la respuesta de administración %s %s: %w", method, route, err)
	}
	return result, nil
}

// keycloakRealm son la base del servidor y el nombre del realm, sacados de AUTH_TOKEN_URL: una sola fuente de los dos.
func keycloakRealm() (base, realm string, err error) {
	endpoint := tokenURL()
	base, rest, ok := strings.Cut(endpoint, "/realms/")
	if !ok {
		return "", "", errors.New("la variable AUTH_TOKEN_URL no es el endpoint de token de un realm de Keycloak: " + endpoint)
	}
	realm, _, _ = strings.Cut(rest, "/")
	return base, realm, nil
}`;
}
