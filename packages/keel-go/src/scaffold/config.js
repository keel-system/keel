// Configuración multi-ambiente del servicio generado.
//
// La MISMA que la de los otros tres generadores, que es lo que hace que los servidores del mismo diseño se
// desplieguen igual: el perfil activo sale de `PROFILE` (default `local`, admite varios separados por coma),
// el puerto de `SERVER_PORT` (8080), la dirección de `SERVER_ADDRESS` (0.0.0.0), el margen del apagado
// ordenado de `SHUTDOWN_TIMEOUT` (30s), y cada valor sigue el gradiente de keel-core (gen/profile-values.js):
// literal (local) → `${VAR:default}` (develop) → `${VAR}` sin default (production). Un `${VAR}` sin valor no
// deja arrancar: se listan TODAS las que faltan.
//
// Forma en disco, la de keel-nest y keel-dotnet: `config/application.yaml` (lo común) +
// `config/parameters/<perfil>/*.yaml` (los fragmentos de cada perfil, que llegan con las capas que los
// necesitan). En Go los archivos van EMBEBIDOS en el binario (paquete `config` de la raíz, con embed.FS): el
// ejecutable no depende del directorio desde el que se lance, y el cargador recibe un fs.FS, así que sus
// pruebas le pasan uno en memoria. Las variables de entorno siempre ganan al YAML.

import { layout, packageFile } from './render.js';

export function generate(model) {
  const pkgs = layout(model);
  return [
    { path: 'config/application.yaml', content: baseYaml(model) },
    { path: 'config/parameters/README.md', content: parametersReadme() },
    { path: `${pkgs.configFiles.dir}/embed.go`, content: embedGo(model) },
    { path: `${pkgs.config.dir}/config.go`, content: configGo(model) },
    { path: `${pkgs.config.dir}/config_test.go`, content: configTestGo(model) }
  ];
}

function baseYaml(model) {
  return `# Configuración común a todos los perfiles. Los valores de cada perfil van en
# config/parameters/<perfil>/*.yaml. Placeholders: \${VAR} obligatoria, \${VAR:default} opcional.
application:
  name: ${model.service.name}
server:
  # Puerto por variable de entorno; 8080 es el que asumen los escenarios de validación.
  port: \${SERVER_PORT:8080}
  # Todas las interfaces, como los servidores de keel-spring, keel-nest y keel-dotnet (también
  # SERVER_ADDRESS): dentro de un contenedor, escuchar solo en localhost dejaría el servicio inalcanzable.
  address: \${SERVER_ADDRESS:0.0.0.0}
  # Apagado ordenado: al recibir SIGTERM /readyz pasa a OUT_OF_SERVICE, el servidor deja de aceptar
  # conexiones y espera como máximo este margen a que terminen las peticiones en vuelo.
  shutdown-timeout: \${SHUTDOWN_TIMEOUT:30s}
`;
}

function parametersReadme() {
  return `# Fragmentos por perfil

Cada perfil (\`local\`, \`develop\`, \`production\`, \`test\`) puede tener aquí su directorio con fragmentos
\`*.yaml\`, que se aplican sobre \`../application.yaml\` en orden alfabético. Los escribe \`keel-go build\` con las
capas que los necesitan; el gradiente de valores es el de los otros generadores: literal en \`local\`,
\`\${VAR:default}\` en \`develop\`, \`\${VAR}\` obligatoria en \`production\`.

Van embebidos en el binario: un cambio aquí exige volver a compilar.
`;
}

function embedGo(model) {
  const { configFiles } = layout(model);
  return packageFile(model, configFiles, {
    doc: 'Package config embebe los archivos de configuración del servicio: application.yaml y los fragmentos\nde cada perfil en parameters/. Los lee internal/platform/config.',
    imports: ['embed'],
    body: `
// Files son los archivos de configuración, embebidos al compilar.
//
//go:embed application.yaml parameters
var Files embed.FS
`
  });
}

function configGo(model) {
  const { config } = layout(model);
  return packageFile(model, config, {
    doc: 'Package config carga y valida la configuración del perfil activo antes de arrancar el servicio.\n\nLa convención es la de los otros servidores del mismo diseño: perfil por PROFILE (default local, varios\nseparados por coma), application.yaml más los fragmentos de parameters/<perfil>/, y placeholders ${VAR}\n(obligatoria) y ${VAR:default}, con defaults que pueden llevar otro placeholder. Una variable obligatoria\nsin valor no deja arrancar: se listan todas las que faltan, no la primera. Una variable vacía cuenta como\nausente.',
    imports: ['errors', 'fmt', 'io/fs', 'path', 'regexp', 'slices', 'strconv', 'strings', 'time', 'go.yaml.in/yaml/v3'],
    body: placeholders(String.raw`
// Server es lo que el arranque necesita del servidor HTTP.
type Server struct {
	// Port es el puerto TCP; 0 deja que el sistema elija uno libre (lo usan las pruebas).
	Port int
	// Address es la interfaz en la que escucha.
	Address string
	// ShutdownTimeout es el margen del apagado ordenado para las peticiones en vuelo.
	ShutdownTimeout time.Duration
}

// Config es la configuración del perfil activo, ya resuelta y validada.
type Config struct {
	// Profiles son los perfiles activos, en el orden en que se aplican sus fragmentos.
	Profiles []string
	// ApplicationName es el nombre del servicio.
	ApplicationName string
	// Server es la configuración del servidor HTTP.
	Server Server

	values map[string]string
}

// Value devuelve un valor por su clave con puntos (server.port) y si existe.
func (c *Config) Value(key string) (string, bool) {
	value, ok := c.values[key]
	return value, ok
}

// MissingError dice qué variables de entorno obligatorias faltan, todas a la vez.
type MissingError struct {
	// Profiles son los perfiles activos.
	Profiles []string
	// Missing son las variables que faltan, con la clave que las pide: "DB_URL (database.url)".
	Missing []string
}

// Error lista las variables que faltan con la clave que pide cada una.
func (e *MissingError) Error() string {
	return fmt.Sprintf("configuración incompleta para el perfil %s: faltan %d variable(s) de entorno — %s",
		strings.Join(e.Profiles, ","), len(e.Missing), strings.Join(e.Missing, "; "))
}

// Load carga la configuración desde files (application.yaml y parameters/<perfil>/*.yaml) con las variables
// de entorno que devuelve getenv.
func Load(files fs.FS, getenv func(string) string) (*Config, error) {
	profiles := splitProfiles(getenv("PROFILE"))
	tree, err := readYAML(files, "application.yaml")
	if err != nil {
		return nil, err
	}
	for _, profile := range profiles {
		fragments, err := fs.Glob(files, path.Join("parameters", profile, "*.yaml"))
		if err != nil {
			return nil, fmt.Errorf("buscar los fragmentos del perfil %s: %w", profile, err)
		}
		slices.Sort(fragments)
		for _, fragment := range fragments {
			overrides, err := readYAML(files, fragment)
			if err != nil {
				return nil, err
			}
			tree = merge(tree, overrides)
		}
	}

	values := map[string]string{}
	var missing []string
	flatten(tree, nil, getenv, values, &missing)
	if len(missing) > 0 {
		slices.Sort(missing)
		return nil, &MissingError{Profiles: profiles, Missing: missing}
	}

	cfg := &Config{Profiles: profiles, ApplicationName: values["application.name"], values: values}
	if cfg.Server, err = serverOf(values); err != nil {
		return nil, err
	}
	return cfg, nil
}

func splitProfiles(value string) []string {
	var profiles []string
	for profile := range strings.SplitSeq(value, ",") {
		if profile = strings.TrimSpace(profile); profile != "" {
			profiles = append(profiles, profile)
		}
	}
	if len(profiles) == 0 {
		return []string{"local"}
	}
	return profiles
}

func serverOf(values map[string]string) (Server, error) {
	port, err := ToPort(values["server.port"])
	if err != nil {
		return Server{}, err
	}
	address := values["server.address"]
	if address == "" {
		address = "0.0.0.0"
	}
	timeout := values["server.shutdown-timeout"]
	if timeout == "" {
		timeout = "30s"
	}
	shutdown, err := ToDuration(timeout)
	if err != nil {
		return Server{}, fmt.Errorf("server.shutdown-timeout: %w", err)
	}
	return Server{Port: port, Address: address, ShutdownTimeout: shutdown}, nil
}

// ToPort lee un puerto TCP: un entero entre 0 y 65535.
func ToPort(value string) (int, error) {
	port, err := strconv.Atoi(value)
	if err != nil || port < 0 || port > 65535 {
		return 0, fmt.Errorf("server.port inválido: %q", value)
	}
	return port, nil
}

var durationPattern = regexp.MustCompile(` + "`" + String.raw`^(\d+)(ms|s|m|h)?$` + "`" + String.raw`)

// ToDuration lee una duración: 30s, 500ms, 2m, 1h; un número a secas son milisegundos.
func ToDuration(value string) (time.Duration, error) {
	match := durationPattern.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return 0, fmt.Errorf("duración inválida: %q (usa 500ms, 30s, 2m o 1h)", value)
	}
	amount, err := strconv.ParseInt(match[1], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("duración inválida: %q: %w", value, err)
	}
	unit := map[string]time.Duration{"": time.Millisecond, "ms": time.Millisecond, "s": time.Second, "m": time.Minute, "h": time.Hour}[match[2]]
	return time.Duration(amount) * unit, nil
}

// readYAML lee un archivo YAML como árbol de mapas, listas y textos: los escalares se conservan tal como
// están escritos, porque un placeholder se resuelve antes de convertir nada.
func readYAML(files fs.FS, name string) (map[string]any, error) {
	data, err := fs.ReadFile(files, name)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("leer %s: %w", name, err)
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return nil, fmt.Errorf("leer %s: %w", name, err)
	}
	if len(document.Content) == 0 {
		return map[string]any{}, nil
	}
	tree, ok := convert(document.Content[0]).(map[string]any)
	if !ok {
		return nil, fmt.Errorf("leer %s: la raíz no es un mapa", name)
	}
	return tree, nil
}

func convert(node *yaml.Node) any {
	switch node.Kind {
	case yaml.MappingNode:
		tree := make(map[string]any, len(node.Content)/2)
		for i := 0; i+1 < len(node.Content); i += 2 {
			tree[node.Content[i].Value] = convert(node.Content[i+1])
		}
		return tree
	case yaml.SequenceNode:
		list := make([]any, 0, len(node.Content))
		for _, item := range node.Content {
			list = append(list, convert(item))
		}
		return list
	case yaml.AliasNode:
		return convert(node.Alias)
	case yaml.ScalarNode:
		if node.Tag == "!!null" {
			return nil
		}
		return node.Value
	default:
		return nil
	}
}

func merge(current, overrides map[string]any) map[string]any {
	merged := make(map[string]any, len(current))
	for key, value := range current {
		merged[key] = value
	}
	for key, value := range overrides {
		left, leftIsMap := merged[key].(map[string]any)
		right, rightIsMap := value.(map[string]any)
		if leftIsMap && rightIsMap {
			merged[key] = merge(left, right)
		} else {
			merged[key] = value
		}
	}
	return merged
}

// flatten aplana el árbol a claves con puntos (server.port), resolviendo cada valor.
func flatten(node any, keys []string, getenv func(string) string, into map[string]string, missing *[]string) {
	switch value := node.(type) {
	case map[string]any:
		for key, child := range value {
			flatten(child, append(slices.Clone(keys), key), getenv, into, missing)
		}
	case []any:
		for index, child := range value {
			flatten(child, append(slices.Clone(keys), strconv.Itoa(index)), getenv, into, missing)
		}
	case string:
		key := strings.Join(keys, ".")
		into[key] = resolve(value, getenv, key, missing)
	default:
		into[strings.Join(keys, ".")] = ""
	}
}

var variableName = regexp.MustCompile(` + "`^[A-Za-z0-9_]+$`" + String.raw`)

// resolve sustituye los placeholders de un valor. El default puede llevar otro placeholder
// ($[SERVICE_INSTANCE_ID:$[HOSTNAME:unknown]]); lo que llega de una variable de entorno se usa tal cual, sin
// volver a resolverlo.
func resolve(value string, getenv func(string) string, key string, missing *[]string) string {
	var out strings.Builder
	rest := value
	for {
		start := strings.Index(rest, "$[[")
		if start < 0 {
			out.WriteString(rest)
			return out.String()
		}
		end := closingBrace(rest, start+2)
		if end < 0 {
			out.WriteString(rest)
			return out.String()
		}
		out.WriteString(rest[:start])
		inner := rest[start+2 : end]
		name, fallback, hasDefault := strings.Cut(inner, ":")
		rest = rest[end+1:]
		if !variableName.MatchString(name) {
			out.WriteString("$[[" + inner + "}")
			continue
		}
		switch fromEnvironment := getenv(name); {
		case fromEnvironment != "":
			out.WriteString(fromEnvironment)
		case hasDefault:
			out.WriteString(resolve(fallback, getenv, key, missing))
		default:
			*missing = append(*missing, name+" ("+key+")")
		}
	}
}

// closingBrace es la llave que cierra el placeholder que empieza en from, saltando los anidados.
func closingBrace(text string, from int) int {
	depth := 0
	for i := from; i < len(text); i++ {
		switch {
		case strings.HasPrefix(text[i:], "$[["):
			depth++
			i++
		case text[i] == '}':
			if depth == 0 {
				return i
			}
			depth--
		}
	}
	return -1
}
`)
  });
}

function configTestGo(model) {
  const { config } = layout(model);
  return packageFile(model, config, {
    test: true,
    imports: ['errors', 'slices', 'testing', 'testing/fstest', 'time', 'internal/platform/config'],
    body: placeholders(String.raw`
// La misma configuración que los servidores de keel-spring, keel-nest y keel-dotnet del mismo diseño:
// application.yaml más los fragmentos del perfil, el gradiente de valores y la lista entera de lo que falta.

const application = ` + '`' + `application:
  name: demo
server:
  port: $[SERVER_PORT:8080]
  address: $[SERVER_ADDRESS:0.0.0.0]
  shutdown-timeout: $[SHUTDOWN_TIMEOUT:30s]
` + '`' + String.raw`

func files(extra map[string]string) fstest.MapFS {
	fsys := fstest.MapFS{"application.yaml": {Data: []byte(application)}}
	for name, content := range extra {
		fsys[name] = &fstest.MapFile{Data: []byte(content)}
	}
	return fsys
}

func env(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := config.Load(files(nil), env(nil))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !slices.Equal(cfg.Profiles, []string{"local"}) {
		t.Errorf("Profiles = %v, quiero [local]", cfg.Profiles)
	}
	want := config.Server{Port: 8080, Address: "0.0.0.0", ShutdownTimeout: 30 * time.Second}
	if cfg.Server != want {
		t.Errorf("Server = %+v, quiero %+v", cfg.Server, want)
	}
	if cfg.ApplicationName != "demo" {
		t.Errorf("ApplicationName = %q, quiero demo", cfg.ApplicationName)
	}
}

func TestLoadEnvironmentWins(t *testing.T) {
	cfg, err := config.Load(files(nil), env(map[string]string{"SERVER_PORT": "9090", "SHUTDOWN_TIMEOUT": "500ms"}))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Server.Port != 9090 || cfg.Server.ShutdownTimeout != 500*time.Millisecond {
		t.Errorf("Server = %+v, quiero el puerto 9090 y 500ms", cfg.Server)
	}
}

func TestLoadProfileFragments(t *testing.T) {
	fsys := files(map[string]string{
		"parameters/develop/a.yaml": "server:\n  address: $[BIND:127.0.0.1]\n",
		"parameters/develop/b.yaml": "server:\n  address: 10.0.0.1\n",
		"parameters/local/a.yaml":   "server:\n  address: 192.168.0.1\n",
	})
	cfg, err := config.Load(fsys, env(map[string]string{"PROFILE": " develop "}))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	// Los fragmentos se aplican en orden alfabético, y solo los del perfil activo.
	if cfg.Server.Address != "10.0.0.1" {
		t.Errorf("Address = %q, quiero 10.0.0.1 (el último fragmento de develop)", cfg.Server.Address)
	}
}

func TestLoadListsEveryMissingVariable(t *testing.T) {
	fsys := files(map[string]string{
		"parameters/production/db.yaml": "database:\n  url: $[DB_URL]\n  user: $[DB_USER]\n",
	})
	// Una variable vacía cuenta como ausente.
	_, err := config.Load(fsys, env(map[string]string{"PROFILE": "production", "DB_USER": ""}))
	var missing *config.MissingError
	if !errors.As(err, &missing) {
		t.Fatalf("Load: %v, quiero un *config.MissingError", err)
	}
	want := []string{"DB_URL (database.url)", "DB_USER (database.user)"}
	if !slices.Equal(missing.Missing, want) {
		t.Errorf("Missing = %v, quiero %v", missing.Missing, want)
	}
}

func TestLoadNestedDefault(t *testing.T) {
	fsys := files(map[string]string{
		"parameters/local/id.yaml": "service:\n  instance: $[SERVICE_INSTANCE_ID:$[HOSTNAME:unknown]]\n",
	})
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{name: "sin ninguna", env: nil, want: "unknown"},
		{name: "con el default anidado", env: map[string]string{"HOSTNAME": "pod-1"}, want: "pod-1"},
		{name: "con la variable", env: map[string]string{"SERVICE_INSTANCE_ID": "a", "HOSTNAME": "pod-1"}, want: "a"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := config.Load(fsys, env(tt.env))
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if got, _ := cfg.Value("service.instance"); got != tt.want {
				t.Errorf("service.instance = %q, quiero %q", got, tt.want)
			}
		})
	}
}

func TestLoadRejectsInvalidValues(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{name: "puerto no numérico", env: map[string]string{"SERVER_PORT": "http"}},
		{name: "puerto fuera de rango", env: map[string]string{"SERVER_PORT": "70000"}},
		{name: "duración sin unidad conocida", env: map[string]string{"SHUTDOWN_TIMEOUT": "30 segundos"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := config.Load(files(nil), env(tt.env)); err == nil {
				t.Error("Load aceptó un valor inválido")
			}
		})
	}
}

func TestToDuration(t *testing.T) {
	tests := map[string]time.Duration{"500ms": 500 * time.Millisecond, "30s": 30 * time.Second, "2m": 2 * time.Minute, "1h": time.Hour, "250": 250 * time.Millisecond}
	for text, want := range tests {
		got, err := config.ToDuration(text)
		if err != nil || got != want {
			t.Errorf("ToDuration(%q) = %v, %v; quiero %v", text, got, err, want)
		}
	}
}
`)
  });
}

/**
 * El Go de este archivo habla de placeholders `${VAR}`, que en una plantilla de JS se evaluarían. Se escriben
 * `$[VAR:default]` —emparejados, también anidados— y `$[[` para una llave abierta suelta (la que busca el
 * cargador), y se traducen aquí sobre la plantilla ENTERA.
 */
function placeholders(text) {
  let out = '';
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('$[[', i)) {
      out += '${';
      i += 2;
    } else if (text.startsWith('$[', i)) {
      out += '${';
      open++;
      i += 1;
    } else if (text[i] === ']' && open > 0) {
      out += '}';
      open--;
    } else out += text[i];
  }
  if (open !== 0) throw new Error('config.js: un placeholder $[ sin cerrar en una plantilla');
  return out;
}
