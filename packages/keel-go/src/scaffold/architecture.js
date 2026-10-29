// La frontera hexagonal, EJECUTADA (PLAN-KEEL-GO.md § 2).
//
// En keel-dotnet la impone el compilador con las referencias entre proyectos y en keel-nest la comprueba
// dependency-cruiser. En Go, `internal/` solo protege frente a OTROS módulos, no entre las capas del mismo, así
// que la frontera es una prueba: pregunta a `go list` qué importa cada paquete del módulo y falla si una capa
// importa a otra que no debe, o si el dominio o la aplicación importan un módulo de terceros fuera de su lista
// blanca. Las reglas salen del mismo mapa que los paquetes (`boundaries()` de render.js), y la prueba se
// comprueba a sí misma con imports plantados, porque una regla que nunca dispara no se distingue de una que
// no mira.

import { goString } from '../lib/go-source.js';
import { boundaries, layout, packageFile } from './render.js';

export function generate(model) {
  const { architecture } = layout(model);
  return [{ path: `${architecture.dir}/architecture_test.go`, content: architectureTestGo(model) }];
}

function goList(values) {
  return values === null ? 'nil' : `[]string{${values.map(goString).join(', ')}}`;
}

function architectureTestGo(model) {
  const { architecture, module } = layout(model);
  const rules = boundaries()
    .map(
      (rule) =>
        `\t{layer: ${goString(rule.layer)}, prefix: ${goString(rule.prefix)}, allows: ${goList(rule.allows)}, thirdParty: ${goList(rule.thirdParty)}},`
    )
    .join('\n');
  return packageFile(model, architecture, {
    test: true,
    imports: ['bytes', 'encoding/json', 'errors', 'io', 'os/exec', 'slices', 'strings', 'testing'],
    body: `
// module es la ruta del módulo del servicio.
const module = ${goString(module)}

// boundary es una capa: los paquetes cuyo directorio empieza por prefix, a qué otros paquetes propios
// pueden importar y qué módulos de terceros (nil: cualquiera).
type boundary struct {
	layer      string
	prefix     string
	allows     []string
	thirdParty []string
}

// boundaries son las capas del servicio. Un prefijo acabado en / abarca todos sus paquetes. Un paquete que no
// es de ninguna capa (cmd/server, config) no tiene frontera: es el que lo cablea todo.
var boundaries = []boundary{
${rules}
}

// pkg es lo que la prueba necesita de un paquete de go list.
type pkg struct {
	ImportPath string
	Imports    []string
}

func within(path, prefix string) bool {
	if strings.HasSuffix(prefix, "/") {
		return strings.HasPrefix(path, prefix)
	}
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

func layerOf(path string) (boundary, bool) {
	for _, b := range boundaries {
		if within(path, b.prefix) {
			return b, true
		}
	}
	return boundary{}, false
}

// violations dice qué imports de los paquetes cruzan una frontera.
func violations(packages []pkg) []string {
	var found []string
	for _, p := range packages {
		own := strings.TrimPrefix(p.ImportPath, module+"/")
		b, ok := layerOf(own)
		if !ok {
			continue
		}
		for _, imported := range p.Imports {
			switch {
			case strings.HasPrefix(imported, module+"/"):
				target := strings.TrimPrefix(imported, module+"/")
				if within(target, b.prefix) || slices.ContainsFunc(b.allows, func(allowed string) bool { return within(target, allowed) }) {
					continue
				}
				found = append(found, own+" ("+b.layer+") importa "+target)
			case !strings.Contains(strings.Split(imported, "/")[0], "."):
				// La biblioteca estándar.
			case b.thirdParty != nil && !slices.ContainsFunc(b.thirdParty, func(allowed string) bool { return within(imported, allowed) }):
				found = append(found, own+" ("+b.layer+") importa el módulo de terceros "+imported)
			}
		}
	}
	return found
}

func TestHexagonalBoundary(t *testing.T) {
	out, err := exec.CommandContext(t.Context(), "go", "list", "-json", module+"/...").Output()
	if err != nil {
		t.Fatalf("go list: %v", err)
	}
	var packages []pkg
	decoder := json.NewDecoder(bytes.NewReader(out))
	for {
		var p pkg
		if err := decoder.Decode(&p); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			t.Fatalf("leer go list: %v", err)
		}
		packages = append(packages, p)
	}
	if len(packages) == 0 {
		t.Fatal("go list no devolvió ningún paquete")
	}
	for _, violation := range violations(packages) {
		t.Error(violation)
	}
}

// La regla se comprueba a sí misma: un import plantado en cada dirección prohibida tiene que salir.
func TestBoundaryCatchesPlantedImports(t *testing.T) {
	tests := []struct {
		name    string
		planted pkg
	}{
		{name: "el dominio importa la aplicación", planted: pkg{ImportPath: module + "/internal/domain", Imports: []string{module + "/internal/application"}}},
		{name: "el dominio importa la entrada HTTP", planted: pkg{ImportPath: module + "/internal/domain", Imports: []string{module + "/internal/httpapi"}}},
		{name: "el dominio importa un módulo de terceros", planted: pkg{ImportPath: module + "/internal/domain", Imports: []string{"github.com/jackc/pgx/v5"}}},
		{name: "la aplicación importa la plataforma", planted: pkg{ImportPath: module + "/internal/application", Imports: []string{module + "/internal/platform/config"}}},
		{name: "la plataforma importa el dominio", planted: pkg{ImportPath: module + "/internal/platform/health", Imports: []string{module + "/internal/domain"}}},
		{name: "un adaptador importa la entrada HTTP", planted: pkg{ImportPath: module + "/internal/infrastructure/postgres", Imports: []string{module + "/internal/httpapi"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := violations([]pkg{tt.planted}); len(got) != 1 {
				t.Errorf("violations = %v, quiero exactamente una", got)
			}
		})
	}
	allowed := []pkg{
		{ImportPath: module + "/internal/domain", Imports: []string{"time", "github.com/google/uuid"}},
		{ImportPath: module + "/internal/application", Imports: []string{module + "/internal/domain"}},
		{ImportPath: module + "/internal/httpapi", Imports: []string{module + "/internal/application", module + "/internal/platform/health"}},
		{ImportPath: module + "/cmd/server", Imports: []string{module + "/internal/httpapi", module + "/config"}},
	}
	if got := violations(allowed); len(got) != 0 {
		t.Errorf("violations = %v sobre imports permitidos", got)
	}
}
`
  });
}
