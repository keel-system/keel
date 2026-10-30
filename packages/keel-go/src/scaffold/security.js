// La seguridad del servicio (capa security del diseño): quién llama y qué puede pedir.
//
// El contrato es el de los servidores de keel-spring, keel-nest y keel-dotnet del mismo diseño, y la decisión la toma
// keel-core (gen/access-plan.js): qué exige cada regla, qué rutas comprueban la audiencia y en qué orden se evalúa todo.
// Aquí solo se escribe en Go, en dos sitios:
//
//   · `internal/platform/security`, el mecanismo: el principal de la petición en el contexto (con accesores tipados,
//     § 3.3), la validación del JWT con golang-jwt (MIT) contra el JWKS del proveedor —discovery del issuer-uri,
//     perezoso, como el resource server de Spring— y la política CORS con la semántica del DefaultCorsProcessor. El
//     JWKS lo lee el propio paquete con la biblioteca estándar y NO keyfunc: keyfunc refresca en una goroutine propia,
//     y aquí la carga es perezosa (el servicio arranca sin el proveedor) y no hay goroutine sin dueño (§ 3.5);
//   · `internal/httpapi/security.go`, la decisión: las reglas del plan como DATOS y el middleware que las aplica
//     ANTES de enrutar. Spring Security decide antes que el enrutador: sin credencial, un camino que no existe responde
//     401 y no 404. El ServeMux de Go dice qué patrón casaría (`mux.Handler(r)`) sin despachar, así que la regla
//     compara la FORMA de ese patrón —lo que vio el enrutador, que no se esquiva codificando un carácter—, y si no casa
//     ninguno, el camino.
//
// La identidad del llamante (`callerIdentity`) se resuelve en un único punto del borde y la estampa el lector de cada
// endpoint; los roles exentos de una regla de propiedad llegan a los handlers por un puerto de la aplicación
// (`CallerRoles`), porque la aplicación no ve el token.
//
// Lo que keel-go no genera todavía (la clave de API, el alcance por recurso y `resolvedBy`) lo rechaza la frontera con
// su motivo: ninguna fixture que keel-go genere lo declara, y no habría red que lo midiera.

import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { FRAMEWORK_RESPONSES as FW } from '@keel-system/keel-core/gen/api-errors';
import { audienceOf, fullAccessClaims, tokenClaims } from '@keel-system/keel-core/gen/access-plan';
import { securityPlan, usesHttpSecurity, usesJwt } from '@keel-system/keel-core/gen/features';
import { ownershipRulesOf, usesCallerRoles } from '@keel-system/keel-core/gen/ownership';
import { securityConfigFiles } from '@keel-system/keel-core/gen/security-config';
import { alignRows, goString, keyedLiteral } from '../lib/go-source.js';
import { applicationPath, layout, packageFile } from './render.js';

export { securityPlan, usesHttpSecurity, usesJwt };

/** ¿Resuelve el servidor la identidad del llamante desde la credencial? */
export function usesCallerIdentity(model) {
  const plan = securityPlan(model);
  return Boolean(plan && !plan.open && model.security?.callerIdentity);
}

/** ¿Emite el puerto CallerRoles? Con una regla de propiedad que declara exentos y un token que leer. */
export function usesRoleCheck(model) {
  return Boolean(usesJwt(model) && usesCallerRoles(model));
}

/** ¿Recibe el handler de la operación CallerRoles? Las de una regla de propiedad con exentos. */
export function roleCheckedOperation(model, operation) {
  return usesRoleCheck(model) && ownershipRulesOf(model, operation).some((rule) => rule.exemptRoles.length > 0);
}

/** El campo de `application.Dependencies` y el parámetro del handler que llevan los roles del llamante. */
export const CALLER_ROLES = { field: 'CallerRoles', param: 'callerRoles', port: 'CallerRoles' };

/** Los imports de lo que el arranque y las pruebas necesitan para construir la entrada HTTP con seguridad. */
export const SECURITY_IMPORT = 'internal/platform/security';

/** La expresión con la que el arranque lee la configuración de la seguridad. */
export function settingsFromConfig(model) {
  return usesHttpSecurity(model) ? 'security.SettingsFrom(cfg)' : null;
}

export function generate(model) {
  if (!usesHttpSecurity(model)) return [];
  const { httpapi } = layout(model);
  const platform = securityPackage(model);
  const file = (name, options) => ({ path: `${platform.dir}/${name}.go`, content: packageFile(model, platform, options) });
  const files = [
    file('principal', {
      doc:
        'Package security autentica las peticiones HTTP del servicio: quién llama (el principal, en el contexto de la\n' +
        'petición), cómo se valida su credencial y la política CORS. Qué puede pedir cada uno lo decide la entrada\n' +
        'HTTP (internal/httpapi) con las reglas del diseño.',
      imports: ['context', 'encoding/json/jsontext', 'encoding/json/v2', 'slices', 'strings', 'internal/platform/config'],
      body: principalGo(model)
    })
  ];
  if (usesJwt(model)) {
    files.push(
      file('jwt', {
        imports: [
          'context',
          'crypto',
          'crypto/ecdsa',
          'crypto/elliptic',
          'crypto/rsa',
          'encoding/base64',
          'encoding/json/jsontext',
          'encoding/json/v2',
          'errors',
          'fmt',
          'io',
          'math/big',
          'net/http',
          'regexp',
          'slices',
          'strings',
          'sync',
          'time',
          'github.com/golang-jwt/jwt/v5'
        ],
        body: jwtGo(model)
      })
    );
    files.push(...testIssuerFiles(model));
  }
  if (model.security?.cors) files.push(file('cors', { imports: ['net/http', 'regexp', 'slices', 'strconv', 'strings'], body: corsGo(model) }));
  if (usesRoleCheck(model)) {
    files.push({ path: applicationPath(model, 'CallerRoles'), content: packageFile(model, layout(model).application, { imports: ['context'], body: CALLER_ROLES_PORT }) });
  }
  files.push({
    path: `${httpapi.dir}/security.go`,
    content: packageFile(model, httpapi, {
      imports: ['context', 'errors', 'net/http', 'slices', 'strings', SECURITY_IMPORT],
      body: middlewareGo(model)
    })
  });
  files.push(...securityConfigFiles(model));
  return files;
}

/** El paquete del mecanismo de seguridad, en la plataforma. */
export function securityPackage(model) {
  const module = model.service.goModule;
  return { dir: 'internal/platform/security', importPath: `${module}/internal/platform/security`, name: 'security' };
}

/** El paquete de las pruebas que firman tokens. */
export function securityTestPackage(model) {
  const module = model.service.goModule;
  return { dir: 'internal/platform/security/securitytest', importPath: `${module}/internal/platform/security/securitytest`, name: 'securitytest' };
}

// ─── principal.go ───────────────────────────────────────────────────────────────────────────────

function principalGo(model) {
  const roles = usesRoleCheck(model)
    ? `

// CallerRoles lee los roles del llamante de las authorities del principal en curso: el rol x es ROLE_x, como en
// keel-spring. Satisface application.CallerRoles, el puerto de los handlers con exentos de una regla de propiedad.
type CallerRoles struct{}

// HasRole dice si el llamante de la petición en curso tiene el rol del diseño.
func (CallerRoles) HasRole(ctx context.Context, role string) bool {
	principal, ok := PrincipalFrom(ctx)
	return ok && principal.Has("ROLE_"+role)
}`
    : '';
  return `
// Kind es de dónde sale la credencial de un principal.
type Kind int

const (
	// TokenPrincipal es un principal autenticado por un token validado.
	TokenPrincipal Kind = iota + 1
	// KeyPrincipal es un principal autenticado por una clave de API.
	KeyPrincipal
)

// Principal es quién hace la petición en curso, ya autenticado: lo que en Spring es el SecurityContextHolder.
type Principal struct {
	// Kind dice si llegó con un token o con una clave de API.
	Kind Kind
	// Name es el nombre del principal: el claim del proveedor en un token, el cliente en una clave.
	Name string
	// Authorities son ROLE_<rol>, el permiso tal cual (recurso:accion) y SCOPE_<scope>, como en Spring.
	Authorities []string
	// Claims son los claims del token tal como llegaron (vacío con una clave de API).
	Claims map[string]jsontext.Value
}

// Has dice si el principal tiene la authority.
func (p *Principal) Has(authority string) bool {
	return slices.Contains(p.Authorities, authority)
}

// principalKey es la clave del principal en el contexto: de un tipo no exportado, nadie más la puede escribir.
type principalKey struct{}

// WithPrincipal devuelve un contexto que lleva el principal de la petición.
func WithPrincipal(ctx context.Context, principal *Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, principal)
}

// PrincipalFrom devuelve el principal de la petición en curso, si la petición está autenticada. Fuera de una
// petición (un consumidor, un barrido) no hay ninguno.
func PrincipalFrom(ctx context.Context) (*Principal, bool) {
	principal, ok := ctx.Value(principalKey{}).(*Principal)
	return principal, ok && principal != nil
}

// ClaimText lee un claim como texto, igual que el getClaimAsString del Jwt de Spring: un número o un booleano se
// convierten; un objeto o una lista, no.
func ClaimText(claims map[string]jsontext.Value, name string) (string, bool) {
	value, ok := claims[name]
	if !ok {
		return "", false
	}
	return claimText(value)
}

func claimText(value jsontext.Value) (string, bool) {
	switch value.Kind() {
	case '"':
		var text string
		if err := json.Unmarshal(value, &text); err != nil {
			return "", false
		}
		return text, true
	case '0':
		return string(value), true
	case 't':
		return "true", true
	case 'f':
		return "false", true
	}
	return "", false
}

// ClaimList lee un claim de lista; un texto suelto cuenta como lista de uno, como el getClaimAsStringList de Spring.
func ClaimList(claims map[string]jsontext.Value, name string) []string {
	value, ok := claims[name]
	if !ok {
		return nil
	}
	return claimList(value)
}

func claimList(value jsontext.Value) []string {
	switch value.Kind() {
	case '[':
		var items []jsontext.Value
		if err := json.Unmarshal(value, &items); err != nil {
			return nil
		}
		list := make([]string, 0, len(items))
		for _, item := range items {
			if text, ok := claimText(item); ok {
				list = append(list, text)
			} else {
				list = append(list, string(item))
			}
		}
		return list
	case '"':
		text, _ := claimText(value)
		return []string{text}
	}
	return nil
}

// Settings es la configuración de la seguridad del perfil (config/parameters/<perfil>/security.yaml).
type Settings struct {
	// IssuerURI es el emisor de los tokens: su discovery OIDC da el JWKS, y el claim iss tiene que ser exactamente él.
	IssuerURI string
	// JWKSetURI es el JWKS directamente, sin discovery y sin comprobar iss. Gana a IssuerURI.
	JWKSetURI string
	// JWKS es el JWKS en línea: solo lo usa el perfil test, con la clave con la que firman las pruebas. Gana a todo.
	JWKS string
	// Audience es la audiencia que tienen que traer los tokens de las rutas de máquinas.
	Audience string
	// AllowedOrigins son los orígenes del navegador que admite CORS (* es cualquiera).
	AllowedOrigins []string
}

// SettingsFrom lee la configuración de la seguridad.
func SettingsFrom(cfg *config.Config) Settings {
	value := func(key string) string {
		text, _ := cfg.Value(key)
		return strings.TrimSpace(text)
	}
	var origins []string
	for origin := range strings.SplitSeq(value("security.cors.allowed-origins"), ",") {
		if origin = strings.TrimRight(strings.TrimSpace(origin), "/"); origin != "" {
			origins = append(origins, origin)
		}
	}
	return Settings{
		IssuerURI:      value("security.oauth2.issuer-uri"),
		JWKSetURI:      value("security.oauth2.jwk-set-uri"),
		JWKS:           value("security.oauth2.jwks"),
		Audience:       value("security.audience"),
		AllowedOrigins: origins,
	}
}${roles}
`;
}

// ─── jwt.go ─────────────────────────────────────────────────────────────────────────────────────

function jwtGo(model) {
  const sec = model.security;
  const claims = tokenClaims(model.stack?.auth);
  const cognito = model.stack?.auth === 'cognito';
  // Sin roles, permisos ni scopes en ninguna regla, Spring usa su conversor por defecto, cuyo principal es el `sub`:
  // el nombre que ve la identidad del llamante tiene que ser el mismo.
  const principalClaim = sec.usesAuthorities ? claims.principalClaim : 'sub';
  const grants = (sec.roleGrants ?? []).map((grant) => [goString(grant.role), `{${grant.permissions.map(goString).join(', ')}}`]);
  const roleGrants = grants.length > 0 ? `map[string][]string{\n${keyedLiteral(grants).join('\n')}\n}` : 'map[string][]string{}';
  const roles =
    claims.type === 'nested'
      ? `	var parent map[string]jsontext.Value
	if value, ok := claims[${goString(claims.rolesParent)}]; !ok || value.Kind() != '{' || json.Unmarshal(value, &parent) != nil {
		return nil
	}
	nested, ok := parent[${goString(claims.rolesField)}]
	if !ok || nested.Kind() != '[' {
		return nil
	}
	var roles []string
	for _, role := range claimList(nested) {
		if strings.TrimSpace(role) != "" {
			roles = append(roles, role)
		}
	}
	return roles`
      : `	var roles []string
	for _, role := range ClaimList(claims, ${goString(claims.rolesClaim)}) {
		if strings.TrimSpace(role) != "" {
			roles = append(roles, role)
		}
	}
	return roles`;
  const issuedFor = cognito
    ? `// IssuedFor dice si el token está emitido para ESTE servicio. Cognito no pone aud en los tokens de
// client_credentials: dice a qué API vale cada permiso con el PREFIJO del scope (<audiencia>/<scope>), así que la
// audiencia es ese prefijo. Un token de usuario, sin scopes de máquina, tampoco pasa.
func IssuedFor(principal *Principal, audience string) bool {
	scope, _ := ClaimText(principal.Claims, "scope")
	for value := range strings.FieldsSeq(scope) {
		if strings.HasPrefix(value, audience+"/") {
			return true
		}
	}
	return false
}`
    : `// IssuedFor dice si el token está emitido para ESTE servicio: su claim aud tiene que incluir la audiencia.
func IssuedFor(principal *Principal, audience string) bool {
	return slices.Contains(ClaimList(principal.Claims, "aud"), audience)
}`;
  const scopes = cognito
    ? `	var scopes []string
	for value := range strings.FieldsSeq(scope) {
		// Cognito: <resource-server>/<scope>. Sin prefijo, se queda igual.
		_, after, found := strings.Cut(value, "/")
		if !found {
			after = value
		}
		scopes = append(scopes, after)
	}
	return scopes`
    : '	return strings.Fields(scope)';
  return `
// ErrInvalidCredential es una credencial que no vale: la entrada HTTP responde 401. Cualquier otro error al
// autenticar (el proveedor no responde) no es culpa de la credencial y acaba en el 500 del contrato.
var ErrInvalidCredential = errors.New("credencial no válida")

// errUnknownKey es un token firmado con una clave que el JWKS en memoria no tiene: puede ser una rotación.
var errUnknownKey = errors.New("el token está firmado con una clave que el JWKS no tiene")

const (
	// principalClaim es el claim del nombre del principal.
	principalClaim = ${goString(principalClaim)}
	// permissionsClaim es el claim de los permisos.
	permissionsClaim = ${goString(claims.permissionsClaim)}
	// clockTolerance es el margen de reloj al comprobar exp y nbf: el de Spring.
	clockTolerance = 60 * time.Second
	// refreshCooldown es lo mínimo entre dos lecturas del JWKS remoto cuando llega un token firmado con una clave
	// que no se conoce.
	refreshCooldown = 30 * time.Second
	// maxDocumentBytes es el tope de un documento del proveedor (discovery o JWKS).
	maxDocumentBytes = 1 << 20
)

// roleGrants son los permisos que otorga cada rol (security.roleGrants del diseño): ningún proveedor los emite.
var roleGrants = ${roleGrants}

// signingMethods son los algoritmos que se aceptan: los de clave pública. Un token sin firma o con un secreto
// compartido no vale, como en el resource server de Spring.
var signingMethods = []string{"RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"}

// tokenFormat es la forma de un bearer token (RFC 6750): Spring rechaza con 401 lo que no la tiene.
var tokenFormat = regexp.MustCompile(\`^[A-Za-z0-9\\-._~+/]+=*$\`)

// JWTAuthenticator valida el JWT de la petición y lo convierte en un Principal con las authorities de Spring:
// ROLE_<rol> (${claims.type === 'nested' ? `claim anidado ${claims.rolesParent}.${claims.rolesField}` : `claim ${claims.rolesClaim}`}), SCOPE_<scope> (claim scope${cognito ? ', sin el prefijo del resource server que pone Cognito' : ''}),
// los permisos del claim ${claims.permissionsClaim} y los que otorga cada rol según el diseño (security.roleGrants).
//
// Las claves se resuelven en la PRIMERA petición con token, no al arrancar: el servicio arranca aunque el proveedor
// aún no esté, igual que los de keel-spring, keel-nest y keel-dotnet. Una resolución fallida no se guarda: la
// siguiente petición lo vuelve a intentar.
type JWTAuthenticator struct {
	settings Settings
	client   *http.Client

	// mu protege keys: una sola carga a la vez, y las peticiones que llegan mientras tanto esperan su resultado.
	mu   sync.Mutex
	keys *keySet
}

// keySet son las claves vigentes y de dónde salieron.
type keySet struct {
	byID     map[string]crypto.PublicKey
	all      []crypto.PublicKey
	issuer   string
	remote   bool
	loadedAt time.Time
}

// NewJWTAuthenticator devuelve el autenticador de la configuración. No llama a nadie todavía.
func NewJWTAuthenticator(settings Settings) *JWTAuthenticator {
	return &JWTAuthenticator{settings: settings, client: &http.Client{Timeout: 5 * time.Second}}
}

// Authenticate devuelve el principal del token. Un token que no vale es un error que envuelve
// ErrInvalidCredential (401); cualquier otro error es del proveedor (500).
func (a *JWTAuthenticator) Authenticate(ctx context.Context, token string) (*Principal, error) {
	if !tokenFormat.MatchString(token) {
		return nil, fmt.Errorf("%w: el bearer token no tiene la forma de RFC 6750", ErrInvalidCredential)
	}
	keys, err := a.current(ctx, nil)
	if err != nil {
		return nil, err
	}
	if len(keys.all) == 0 {
		return nil, fmt.Errorf("%w: no hay ninguna clave configurada con la que validar el token", ErrInvalidCredential)
	}
	claims, err := verify(token, keys)
	// Una clave que no se conoce puede ser una rotación del proveedor: se relee el JWKS, como mucho cada 30 s.
	if errors.Is(err, errUnknownKey) && keys.remote && time.Since(keys.loadedAt) > refreshCooldown {
		if keys, err = a.current(ctx, keys); err != nil {
			return nil, err
		}
		claims, err = verify(token, keys)
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidCredential, err)
	}
	return toPrincipal(claims), nil
}

${issuedFor}

// current devuelve las claves vigentes; con stale, las relee si siguen siendo esas.
func (a *JWTAuthenticator) current(ctx context.Context, stale *keySet) (*keySet, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.keys != nil && a.keys != stale {
		return a.keys, nil
	}
	loaded, err := a.load(ctx)
	if err != nil {
		return nil, err
	}
	a.keys = loaded
	return loaded, nil
}

func (a *JWTAuthenticator) load(ctx context.Context) (*keySet, error) {
	switch {
	case a.settings.JWKS != "":
		return parseJWKS([]byte(a.settings.JWKS), "", false)
	case a.settings.JWKSetURI != "":
		data, err := a.fetch(ctx, a.settings.JWKSetURI)
		if err != nil {
			return nil, err
		}
		return parseJWKS(data, "", true)
	case a.settings.IssuerURI != "":
		discovery := strings.TrimRight(a.settings.IssuerURI, "/") + "/.well-known/openid-configuration"
		data, err := a.fetch(ctx, discovery)
		if err != nil {
			return nil, err
		}
		var document struct {
			JWKSURI string \`json:"jwks_uri"\`
		}
		if err := json.Unmarshal(data, &document); err != nil || document.JWKSURI == "" {
			return nil, fmt.Errorf("el discovery del emisor no trae jwks_uri: %s", discovery)
		}
		if data, err = a.fetch(ctx, document.JWKSURI); err != nil {
			return nil, err
		}
		return parseJWKS(data, a.settings.IssuerURI, true)
	}
	// Sin ninguna fuente (el perfil test sin SECURITY_TEST_JWKS): ningún token vale.
	return &keySet{byID: map[string]crypto.PublicKey{}, loadedAt: time.Now()}, nil
}

func (a *JWTAuthenticator) fetch(ctx context.Context, url string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("pedir %s: %w", url, err)
	}
	response, err := a.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("pedir %s: %w", url, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("el proveedor de identidad respondió %d: %s", response.StatusCode, url)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxDocumentBytes))
	if err != nil {
		return nil, fmt.Errorf("leer %s: %w", url, err)
	}
	return data, nil
}

// jsonWebKey es una clave de un JWKS (RFC 7517): solo lo que hace falta para las de RSA y curva elíptica.
type jsonWebKey struct {
	Kty string \`json:"kty"\`
	Kid string \`json:"kid"\`
	Use string \`json:"use"\`
	N   string \`json:"n"\`
	E   string \`json:"e"\`
	Crv string \`json:"crv"\`
	X   string \`json:"x"\`
	Y   string \`json:"y"\`
}

// parseJWKS lee las claves de firma de un JWKS. Las que no son de firma, o de un tipo que no se acepta, se saltan.
func parseJWKS(data []byte, issuer string, remote bool) (*keySet, error) {
	var document struct {
		Keys []jsonWebKey \`json:"keys"\`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, fmt.Errorf("leer el JWKS: %w", err)
	}
	set := &keySet{byID: map[string]crypto.PublicKey{}, issuer: issuer, remote: remote, loadedAt: time.Now()}
	for _, key := range document.Keys {
		if key.Use != "" && key.Use != "sig" {
			continue
		}
		public, ok := publicKey(key)
		if !ok {
			continue
		}
		set.all = append(set.all, public)
		if key.Kid != "" {
			set.byID[key.Kid] = public
		}
	}
	return set, nil
}

func publicKey(key jsonWebKey) (crypto.PublicKey, bool) {
	decode := base64.RawURLEncoding.DecodeString
	switch key.Kty {
	case "RSA":
		n, errN := decode(key.N)
		e, errE := decode(key.E)
		exponent := new(big.Int).SetBytes(e)
		if errN != nil || errE != nil || len(n) == 0 || !exponent.IsInt64() || exponent.Int64() < 3 || exponent.Int64() > 1<<31-1 {
			return nil, false
		}
		return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(exponent.Int64())}, true
	case "EC":
		curve := map[string]elliptic.Curve{"P-256": elliptic.P256(), "P-384": elliptic.P384(), "P-521": elliptic.P521()}[key.Crv]
		x, errX := decode(key.X)
		y, errY := decode(key.Y)
		if curve == nil || errX != nil || errY != nil {
			return nil, false
		}
		public, err := ecdsa.ParseUncompressedPublicKey(curve, append(append([]byte{4}, x...), y...))
		if err != nil {
			return nil, false
		}
		return public, true
	}
	return nil, false
}

// verify comprueba la firma, el algoritmo, exp y nbf con su margen y, con discovery, el emisor; exp se comprueba si
// viene, pero no se exige (el JwtTimestampValidator de Spring). La audiencia NO: es autorización, y la comprueba la
// entrada HTTP solo donde el plan la pide.
func verify(token string, keys *keySet) (map[string]jsontext.Value, error) {
	options := []jwt.ParserOption{jwt.WithValidMethods(signingMethods), jwt.WithLeeway(clockTolerance)}
	if keys.issuer != "" {
		options = append(options, jwt.WithIssuer(keys.issuer))
	}
	_, err := jwt.NewParser(options...).Parse(token, func(parsed *jwt.Token) (any, error) {
		if kid, ok := parsed.Header["kid"].(string); ok && kid != "" {
			key, found := keys.byID[kid]
			if !found {
				return nil, errUnknownKey
			}
			return key, nil
		}
		set := jwt.VerificationKeySet{Keys: make([]jwt.VerificationKey, 0, len(keys.all))}
		for _, key := range keys.all {
			set.Keys = append(set.Keys, key)
		}
		return set, nil
	})
	if err != nil {
		return nil, err
	}
	// Los claims tal como llegaron, ya con la firma comprobada: sin la conversión de tipos de MapClaims.
	_, rest, _ := strings.Cut(token, ".")
	payload, _, _ := strings.Cut(rest, ".")
	data, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil, fmt.Errorf("leer los claims: %w", err)
	}
	var claims map[string]jsontext.Value
	if err := json.Unmarshal(data, &claims); err != nil {
		return nil, fmt.Errorf("leer los claims: %w", err)
	}
	return claims, nil
}

func toPrincipal(claims map[string]jsontext.Value) *Principal {
	roles := rolesOf(claims)
	var authorities []string
	add := func(authority string) {
		if !slices.Contains(authorities, authority) {
			authorities = append(authorities, authority)
		}
	}
	for _, role := range roles {
		add("ROLE_" + role)
	}
	scope, _ := ClaimText(claims, "scope")
	for _, value := range scopesOf(scope) {
		add("SCOPE_" + value)
	}
	for _, permission := range ClaimList(claims, permissionsClaim) {
		if strings.TrimSpace(permission) != "" {
			add(permission)
		}
	}
	for _, role := range roles {
		for _, granted := range roleGrants[role] {
			add(granted)
		}
	}
	name, ok := ClaimText(claims, principalClaim)
	if !ok {
		name, _ = ClaimText(claims, "sub")
	}
	return &Principal{Kind: TokenPrincipal, Name: name, Authorities: authorities, Claims: claims}
}

func rolesOf(claims map[string]jsontext.Value) []string {
${roles}
}

func scopesOf(scope string) []string {
${scopes}
}
`;
}

// ─── securitytest: el emisor de tokens de las pruebas ──────────────────────────────────────────

/** El paquete que firma los tokens de las pruebas emitidas: su clave nace en la prueba, nunca está en el repo. */
function testIssuerFiles(model) {
  const pkg = securityTestPackage(model);
  return [
    {
      path: `${pkg.dir}/securitytest.go`,
      content: packageFile(model, pkg, {
        doc:
          'Package securitytest firma los tokens con los que las pruebas del servicio llaman a su API: una clave RSA que\n' +
          'nace en la prueba (ninguna clave en el repo) y su JWKS, que el perfil test acepta. No lo importa nada que no\n' +
          'sea una prueba.',
        imports: ['crypto/rand', 'crypto/rsa', 'encoding/base64', 'encoding/json/v2', 'fmt', 'math/big', 'time', 'github.com/golang-jwt/jwt/v5'],
        body: `
// KeyID es el kid de las claves de prueba. Es el mismo para todas: un token de otro emisor llega con un kid que el
// servicio conoce y una firma que no casa.
const KeyID = "keel-test"

// Issuer firma tokens con su propia clave.
type Issuer struct {
	key *rsa.PrivateKey
}

// NewIssuer devuelve un emisor con una clave nueva.
func NewIssuer() (*Issuer, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("generar la clave de prueba: %w", err)
	}
	return &Issuer{key: key}, nil
}

// JWKS es el JWKS de la clave del emisor, para publicarlo en SECURITY_TEST_JWKS.
func (i *Issuer) JWKS() (string, error) {
	encode := base64.RawURLEncoding.EncodeToString
	document := map[string]any{"keys": []map[string]string{{
		"kty": "RSA",
		"kid": KeyID,
		"use": "sig",
		"alg": "RS256",
		"n":   encode(i.key.N.Bytes()),
		"e":   encode(big.NewInt(int64(i.key.E)).Bytes()),
	}}}
	data, err := json.Marshal(document)
	if err != nil {
		return "", fmt.Errorf("escribir el JWKS de prueba: %w", err)
	}
	return string(data), nil
}

// Token firma los claims. Sin exp, caduca en cinco minutos.
func (i *Issuer) Token(claims map[string]any) (string, error) {
	signed := jwt.MapClaims{"exp": time.Now().Add(5 * time.Minute).Unix()}
	for name, value := range claims {
		signed[name] = value
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, signed)
	token.Header["kid"] = KeyID
	text, err := token.SignedString(i.key)
	if err != nil {
		return "", fmt.Errorf("firmar el token de prueba: %w", err)
	}
	return text, nil
}
`
      })
    }
  ];
}

/**
 * Los claims del token de acceso total de las pruebas emitidas (keel-core), como literal Go: una clave por línea con
 * su valor en una sola, para que la alineación sea la de go/printer (keyedLiteral).
 */
export function fullAccessLiteral(model) {
  const pairs = Object.entries(fullAccessClaims(model, securityPlan(model))).map(([key, value]) => [goString(key), goLiteral(value)]);
  return `map[string]any{\n${keyedLiteral(pairs).join('\n')}\n}`;
}

/** Un valor JSON como literal Go de una línea: objetos como map[string]any, listas de texto como []string. */
export function goLiteral(value) {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) return `[]string{${value.map(goString).join(', ')}}`;
    return `[]any{${value.map(goLiteral).join(', ')}}`;
  }
  if (value && typeof value === 'object') {
    return `map[string]any{${Object.entries(value).map(([key, item]) => `${goString(key)}: ${goLiteral(item)}`).join(', ')}}`;
  }
  return typeof value === 'string' ? goString(value) : String(value);
}

// ─── cors.go ────────────────────────────────────────────────────────────────────────────────────

function corsGo(model) {
  const cors = model.security.cors;
  const list = (values) => `[]string{${values.map(goString).join(', ')}}`;
  return `
// CORSOutcome es lo que decide la política CORS para una petición.
type CORSOutcome int

const (
	// NotCORS es una petición que no es CORS: sin Origin, o del mismo origen.
	NotCORS CORSOutcome = iota
	// CORSAllowed es una petición CORS permitida: sigue, con sus cabeceras.
	CORSAllowed
	// CORSPreflight es un preflight permitido: se contesta 200 sin seguir.
	CORSPreflight
	// CORSRejected es una petición CORS no permitida: 403 «Invalid CORS request».
	CORSRejected
)

// La política CORS del diseño (security.cors).
var (
	corsMethods          = ${list(cors.methods)}
	corsAllowedHeaders   = ${list(cors.allowedHeaders)}
	corsExposedHeaders   = ${list(cors.exposedHeaders)}
	corsAllowCredentials = ${cors.allowCredentials}
	corsMaxAgeSeconds    = ${cors.maxAgeSeconds}
)

// CORSPolicy es la política CORS del diseño con la semántica del DefaultCorsProcessor de Spring que aplica el
// servidor de keel-spring. Una petición es CORS si trae Origin y no es del mismo origen. Un origen no permitido, o
// un método o unas cabeceras que la política no admite, se rechaza con 403, también la petición real y no solo el
// preflight. Los métodos salen de los endpoints del diseño (más OPTIONS); los orígenes, de la configuración
// (security.cors.allowed-origins). Sin ninguno, el servicio no acepta peticiones cross-origin.
type CORSPolicy struct {
	origins []*regexp.Regexp
}

// NewCORSPolicy devuelve la política con los orígenes de la configuración: * es cualquier cosa y :[*] cualquier
// puerto (o ninguno), como los patrones de origen de Spring.
func NewCORSPolicy(origins []string) *CORSPolicy {
	policy := &CORSPolicy{}
	for _, origin := range origins {
		if origin == "*" {
			policy.origins = append(policy.origins, regexp.MustCompile(\`(?s)^.*$\`))
			continue
		}
		parts := strings.Split(origin, ":[*]")
		for i, part := range parts {
			parts[i] = strings.ReplaceAll(regexp.QuoteMeta(part), \`\\*\`, ".*")
		}
		policy.origins = append(policy.origins, regexp.MustCompile(\`(?i)^\`+strings.Join(parts, \`(:\\d+)?\`)+\`$\`))
	}
	return policy
}

// Apply decide y escribe las cabeceras; con CORSRejected o CORSPreflight la respuesta la da quien llama.
func (p *CORSPolicy) Apply(w http.ResponseWriter, r *http.Request) CORSOutcome {
	headers := w.Header()
	headers.Set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")
	origin := r.Header.Get("Origin")
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if origin == "" || strings.EqualFold(origin, scheme+"://"+r.Host) {
		return NotCORS
	}
	requestedMethod := r.Header.Get("Access-Control-Request-Method")
	preflight := r.Method == http.MethodOptions && requestedMethod != ""
	if !slices.ContainsFunc(p.origins, func(pattern *regexp.Regexp) bool { return pattern.MatchString(origin) }) {
		return CORSRejected
	}
	method := r.Method
	if preflight {
		method = requestedMethod
	}
	if !slices.Contains(corsMethods, strings.ToUpper(method)) {
		return CORSRejected
	}
	var requestedHeaders, allowedHeaders []string
	if preflight {
		for name := range strings.SplitSeq(r.Header.Get("Access-Control-Request-Headers"), ",") {
			if name = strings.TrimSpace(name); name != "" {
				requestedHeaders = append(requestedHeaders, name)
			}
		}
	}
	for _, name := range requestedHeaders {
		if slices.Contains(corsAllowedHeaders, "*") || slices.ContainsFunc(corsAllowedHeaders, func(allowed string) bool { return strings.EqualFold(allowed, name) }) {
			allowedHeaders = append(allowedHeaders, name)
		}
	}
	if len(requestedHeaders) > 0 && len(allowedHeaders) == 0 {
		return CORSRejected
	}

	headers.Set("Access-Control-Allow-Origin", origin)
	if preflight {
		headers.Set("Access-Control-Allow-Methods", strings.Join(corsMethods, ","))
		if len(allowedHeaders) > 0 {
			headers.Set("Access-Control-Allow-Headers", strings.Join(allowedHeaders, ", "))
		}
	} else if len(corsExposedHeaders) > 0 {
		headers.Set("Access-Control-Expose-Headers", strings.Join(corsExposedHeaders, ", "))
	}
	if corsAllowCredentials {
		headers.Set("Access-Control-Allow-Credentials", "true")
	}
	if preflight {
		headers.Set("Access-Control-Max-Age", strconv.Itoa(corsMaxAgeSeconds))
		return CORSPreflight
	}
	return CORSAllowed
}
`;
}

// ─── application/caller_roles.go ────────────────────────────────────────────────────────────────

const CALLER_ROLES_PORT = `
// CallerRoles dice qué roles tiene el llamante de la petición en curso, para las exenciones de una regla de propiedad
// (security.ownership): quien tiene un rol exento opera sobre cualquier recurso. Es un puerto para que los handlers
// no sepan de tokens; lo satisface security.CallerRoles. Solo tiene sentido dentro de una petición HTTP.
type CallerRoles interface {
	// HasRole dice si el llamante tiene el rol del diseño (employee).
	HasRole(ctx context.Context, role string) bool
}
`;

// ─── httpapi/security.go ────────────────────────────────────────────────────────────────────────

/** Una exigencia del plan como expresión Go. */
export function requirementLiteral(requirement) {
  if (requirement.kind === 'anyOf') return `anyOf(${requirement.authorities.map(goString).join(', ')})`;
  return requirement.kind === 'public' ? 'permitAll' : 'authenticated';
}

/**
 * Las exigencias que el plan nombra, y solo esas: staticcheck (U1000) rechaza una variable o una función sin usar, y un
 * diseño sin reglas por permiso no usa `anyOf`.
 */
function requirementConstructors(plan) {
  const kinds = new Set(plan.chains.flatMap((chain) => [...chain.rules.map((rule) => rule.requirement.kind), chain.fallback.kind]));
  const vars = [
    ...(kinds.has('public') ? [['permitAll', 'requirement{kind: permitAllKind}']] : []),
    ...(kinds.has('authenticated') ? [['authenticated', 'requirement{kind: authenticatedKind}']] : [])
  ];
  const parts = [];
  if (vars.length === 1) parts.push(`var ${vars[0][0]} = ${vars[0][1]}`);
  if (vars.length > 1) parts.push(`var (\n${alignRows(vars.map(([name, value]) => ({ indent: '\t', cells: [name, `= ${value}`] }))).join('\n')}\n)`);
  if (kinds.has('anyOf')) parts.push('func anyOf(authorities ...string) requirement {\n\treturn requirement{kind: anyOfKind, authorities: authorities}\n}');
  return parts.join('\n\n');
}

function accessRulesGo(model) {
  const plan = securityPlan(model);
  const chains = plan.chains.map((chain) => {
    const rules = chain.rules.map((rule) => `\t\t\t{${goString(rule.method ?? '')}, ${goString(rule.path)}, ${requirementLiteral(rule.requirement)}},`);
    return `\t{
		paths:          ${chain.paths ? `[]string{${chain.paths.map(goString).join(', ')}}` : 'nil'},
		checksAudience: ${chain.checksAudience},
		rules: []accessRule{
${rules.join('\n')}
		},
		fallback: ${requirementLiteral(chain.fallback)},
	},`;
  });
  return `
// requirement es lo que exige una regla: nada, una credencial cualquiera, o alguna de unas authorities.
type requirement struct {
	kind        requirementKind
	authorities []string
}

// requirementKind es la clase de exigencia.
type requirementKind int

const (
	permitAllKind requirementKind = iota
	authenticatedKind
	anyOfKind
)

${requirementConstructors(plan)}

// accessRule es una regla: el método ("" es cualquiera), la ruta del diseño y lo que exige.
type accessRule struct {
	method      string
	path        string
	requirement requirement
}

// accessChain es una cadena: las rutas que cubre (nil: todas), si exige que el token esté emitido para este servicio
// (audiencia), sus reglas en orden y el cierre.
type accessChain struct {
	paths          []string
	checksAudience bool
	rules          []accessRule
	fallback       requirement
}

// accessChains es la autorización de la entrada HTTP como DATOS, derivada del diseño (security.access) por el plan
// neutral de keel-core: el mismo que el servidor de keel-spring escribe como su SecurityFilterChain, el de keel-nest
// como su hook de entrada y el de keel-dotnet como su AccessRules. Se evalúa como una cadena de filtros: la petición
// cae en la PRIMERA cadena cuyo patrón de rutas casa (sin mirar el método) y, dentro, en la PRIMERA regla que casa
// por método y ruta; si ninguna casa, en el cierre de esa cadena. Un camino que no existe también cae ahí.
var accessChains = []accessChain{
${chains.join('\n')}
}

// decide devuelve lo que exige la petición y si comprueba la audiencia. pattern es la ruta del patrón que casó en el
// enrutador ("" si ninguno).
func decide(method, path, pattern string) (requirement, bool) {
	chain := accessChains[len(accessChains)-1]
	for _, candidate := range accessChains {
		if candidate.paths == nil || slices.ContainsFunc(candidate.paths, func(rulePath string) bool { return matches(rulePath, path, pattern) }) {
			chain = candidate
			break
		}
	}
	for _, rule := range chain.rules {
		if (rule.method == "" || rule.method == method) && matches(rule.path, path, pattern) {
			return rule.requirement, chain.checksAudience
		}
	}
	return chain.fallback, chain.checksAudience
}

// verdict es lo que se decide para una petición: concedida, falta credencial (401) o la credencial no basta (403).
type verdict int

const (
	granted verdict = iota
	unauthenticated
	denied
)

// judge da el veredicto de una exigencia para un principal (nil: anónimo).
func judge(required requirement, principal *security.Principal) verdict {
	switch {
	case required.kind == permitAllKind:
		return granted
	case principal == nil:
		return unauthenticated
	case required.kind == authenticatedKind || slices.ContainsFunc(required.authorities, principal.Has):
		return granted
	}
	return denied
}

// matches dice si la ruta de una regla casa con la petición. Con patrón, se compara la FORMA (los parámetros sin
// su nombre): es lo que vio el enrutador. Sin él, el camino, segmento a segmento, con un parámetro como un segmento
// cualquiera no vacío.
func matches(rulePath, path, pattern string) bool {
	if pattern != "" {
		return shapeOf(rulePath) == shapeOf(pattern)
	}
	want := strings.Split(rulePath, "/")
	got := strings.Split(path, "/")
	if len(want) != len(got) {
		return false
	}
	for i, segment := range want {
		if isParameter(segment) {
			if got[i] == "" {
				return false
			}
		} else if segment != got[i] {
			return false
		}
	}
	return true
}

func isParameter(segment string) bool {
	return strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}")
}

// shapeOf es la ruta con cada parámetro sin su nombre: /products/{id} y /products/{productId} son la misma.
func shapeOf(path string) string {
	segments := strings.Split(path, "/")
	for i, segment := range segments {
		if isParameter(segment) {
			segments[i] = "{}"
		}
	}
	return strings.Join(segments, "/")
}

// routePattern es la ruta del patrón que casó en el enrutador, sin el método; "" si solo casó el de lo no enrutado.
func routePattern(pattern string) string {
	if _, path, found := strings.Cut(pattern, " "); found {
		pattern = path
	}
	if pattern == "/" {
		return ""
	}
	return pattern
}`;
}

function middlewareGo(model) {
  const plan = securityPlan(model);
  const jwt = usesJwt(model);
  const cors = Boolean(model.security?.cors);
  const audience = jwt && plan.audience ? plan.audience : null;
  const corsBlock = cors
    ? `		// CORS antes que nada: el preflight no lleva credencial, y un rechazo tiene que salir con sus cabeceras o el
		// navegador no deja leerlo.
		switch a.cors.Apply(w, r) {
		case security.CORSRejected:
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusForbidden)
			// Un fallo al escribir es que el cliente se fue.
			_, _ = w.Write([]byte("Invalid CORS request"))
			return
		case security.CORSPreflight:
			w.WriteHeader(http.StatusOK)
			return
		}
`
    : '';
  const decision = plan.open
    ? `		// El diseño declara la capa security sin autenticación (protocol: none): todo abierto.
		next.ServeHTTP(w, r)`
    : `		principal, err := a.authenticate(r)
		if errors.Is(err, security.ErrInvalidCredential) {
			reject(w, r, http.StatusUnauthorized)
			return
		}
		if err != nil {
			// El proveedor no responde: el 500 del contrato, nunca un 401 que culpe a la credencial.
			a.writeError(w, r, err)
			return
		}
		_, pattern := next.Handler(r)
		required, ${audience ? 'checksAudience' : '_'} := decide(strings.ToUpper(r.Method), r.URL.Path, routePattern(pattern))${
          audience
            ? `
		// La audiencia es AUTORIZACIÓN, no autenticación: un token legítimo emitido para otro servicio está autenticado
		// y no autorizado (403), no es un token inválido (401).
		if checksAudience && principal != nil && principal.Kind == security.TokenPrincipal && !security.IssuedFor(principal, a.audience) {
			reject(w, r, http.StatusForbidden)
			return
		}`
            : ''
        }
		switch judge(required, principal) {
		case unauthenticated:
			reject(w, r, http.StatusUnauthorized)
			return
		case denied:
			reject(w, r, http.StatusForbidden)
			return
		}
		if principal != nil {
			r = r.WithContext(security.WithPrincipal(r.Context(), principal))
		}
		next.ServeHTTP(w, r)`;
  const authenticate = plan.open
    ? ''
    : `

// authenticate dice quién llama. Un bearer token se valida, y si no vale es un 401 aunque la ruta sea pública (como el
// resource server de Spring); si no hay, la petición es anónima (nil, nil).
func (a *api) authenticate(r *http.Request) (*security.Principal, error) {
	authorization := r.Header.Get("Authorization")
	if len(authorization) < len("bearer") || !strings.EqualFold(authorization[:len("bearer")], "bearer") {
		return nil, nil
	}
	token := ""
	if len(authorization) > len("bearer ") && authorization[len("bearer")] == ' ' {
		token = strings.TrimSpace(authorization[len("bearer "):])
	}
	return a.tokens.Authenticate(r.Context(), token)
}

// Los code del catálogo de un rechazo de la seguridad (FRAMEWORK_ERRORS).
const (
	unauthenticatedCode = ${goString(FRAMEWORK_ERRORS.unauthenticated.code)}
	accessDeniedCode    = ${goString(FRAMEWORK_ERRORS.accessDenied.code)}
)

// reject responde 401 o 403 con el ErrorResponse del contrato y su code del catálogo, como SecurityErrorHandlers de
// keel-spring.
func reject(w http.ResponseWriter, r *http.Request, status int) {
	if status == http.StatusUnauthorized {
		writeErrorResponse(w, newErrorResponse(r, ${FW.unauthenticated.status}, ${goString(FW.unauthenticated.error)}, new(unauthenticatedCode), ${goString(FW.unauthenticated.message)}, nil))
		return
	}
	writeErrorResponse(w, newErrorResponse(r, ${FW.accessDenied.status}, ${goString(FW.accessDenied.error)}, new(accessDeniedCode), ${goString(FW.accessDenied.message)}, nil))
}`;
  const identity = usesCallerIdentity(model) ? callerIdentityGo(model) : '';
  return `${plan.open ? '' : accessRulesGo(model)}

// secure es la seguridad de la entrada HTTP: va DETRÁS del borde (un 401 o un 403 llevan su correlationId, y un
// proveedor caído sale como el 500 del contrato) y DELANTE del enrutador, porque decide antes de enrutar como Spring
// Security. Deja el principal en el contexto de la petición: la identidad del llamante lo lee de ahí.
func (a *api) secure(next *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
${corsBlock}${decision}
	})
}${authenticate}${identity}
`;
}

/** El nombre del error que resuelve la identidad del llamante a un 401. */
export const UNIDENTIFIED_ERROR = 'errUnidentifiedCaller';

function callerIdentityGo(model) {
  const identity = model.security.callerIdentity;
  const extract =
    identity.source === 'claim'
      ? `	value, ok := security.ClaimText(principal.Claims, ${goString(identity.claim ?? 'sub')})`
      : `	// El cliente máquina de la credencial: Keycloak lo pone en azp y otros proveedores en client_id; con
	// client_credentials, el nombre del principal también es el cliente.
	value, ok := security.ClaimText(principal.Claims, "azp")
	if !ok {
		value, ok = security.ClaimText(principal.Claims, "client_id")
	}
	if !ok {
		value, ok = principal.Name, true
	}`;
  return `

// ${UNIDENTIFIED_ERROR} es un token válido sin la identidad del llamante: no identifica a nadie, y es un 401, no un
// fallo del servidor.
var ${UNIDENTIFIED_ERROR} = errors.New("la credencial no identifica al llamante")

// callerIdentity es de dónde sale, por HTTP, la identidad de QUIÉN pide el trabajo
// (security.authentication.callerIdentity): ${identity.source === 'claim' ? `el claim ${identity.claim ?? 'sub'} del token` : 'el cliente máquina de la credencial'}, que llega al campo
// ${identity.field} del mensaje. Es el único punto de resolución, y el campo NO se acepta de la petición: quien la
// hace es justamente quien no debería poder elegir en nombre de quién actúa.
func callerIdentity(ctx context.Context) (string, error) {
	principal, found := security.PrincipalFrom(ctx)
	if !found || principal.Kind != security.TokenPrincipal {
		// La regla de acceso ya rechaza al anónimo: llegar aquí sin token es un fallo de configuración.
		return "", errors.New(${goString(`no hay credencial en el contexto: '${identity.field}' se resuelve de la identidad del llamante`)})
	}
${extract}
	if !ok || strings.TrimSpace(value) == "" {
		return "", ${UNIDENTIFIED_ERROR}
	}
	return value, nil
}`;
}

/** La línea del errorResponse que responde 401 a una credencial que no identifica al llamante. */
export function unidentifiedCase(model) {
  if (!usesCallerIdentity(model)) return null;
  return `	// Un token válido que no identifica al llamante (security.authentication.callerIdentity).
	case errors.Is(err, ${UNIDENTIFIED_ERROR}):
		return newErrorResponse(r, ${FW.unauthenticated.status}, ${goString(FW.unauthenticated.error)}, new(unauthenticatedCode), ${goString(FW.unauthenticated.message)}, nil)
`;
}

export { audienceOf };
