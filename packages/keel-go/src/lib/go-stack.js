// Los módulos Go que puede emitir keel-go en el `go.mod` del proyecto generado, cada uno con su versión
// EXACTA y su licencia (SPDX), y la regla que los vigila: solo licencias permisivas. Es una restricción del
// proyecto (PLAN-KEEL-GO.md § 1.6), escrita en código para que no dependa de que alguien se acuerde:
// `test/licenses.test.js` la comprueba sobre esta tabla, e `infra/check-licenses.sh` (go-licenses) sobre lo
// que Go resuelve de verdad, transitivos incluidos.
//
// Las HERRAMIENTAS cuentan igual que lo que se ejecuta: con la directiva `tool`, el módulo de la herramienta
// queda registrado en el `go.mod` del servicio y sus dependencias entran en su grafo. Por eso golangci-lint
// (GPL-3.0) no se emite, y el lint es `go vet` + staticcheck.
//
// Cada versión se leyó de proxy.golang.org (`go list -m -json <módulo>@<versión>`) el día que se fijó, con
// al menos dos semanas desde su publicación, y su licencia del LICENSE del módulo en esa versión; subir una
// versión obliga a volver a leerla.

/** Licencias admitidas: permisivas, sin obligación de publicar el código del servicio. */
export const ALLOWED_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'];

/**
 * Licencias que no se admiten nunca, por nombre: copyleft fuerte o licencias de fuente disponible. Una que no
 * esté ni aquí ni en la lista blanca también se rechaza; esta lista existe para que el motivo sea explícito.
 */
export const FORBIDDEN_LICENSES = [/^GPL-/, /^AGPL-/, /^LGPL-/, /^BUSL-/, /^SSPL-/];

/** Lo que no se emite aunque se pida, con su motivo. */
export const VETOED_MODULES = {
  'github.com/golangci/golangci-lint': 'GPL-3.0: con la directiva tool quedaría registrado en el go.mod del servicio (el lint es go vet + staticcheck)',
  'github.com/golangci/golangci-lint/v2': 'GPL-3.0: con la directiva tool quedaría registrado en el go.mod del servicio (el lint es go vet + staticcheck)'
};

/**
 * Los módulos, por su ruta. `kind` dice si es de ejecución (`require`) o una herramienta (`tool`, con el
 * paquete que se ejecuta en `tool`); `use`, para qué está. Verificado el 2026-10-29.
 */
export const MODULES = {
  // La configuración por perfiles (config/application.yaml + config/parameters/<perfil>/), el mismo formato en
  // disco que los otros tres generadores. go.yaml.in/yaml/v3 es la continuación mantenida por la organización
  // YAML de gopkg.in/yaml.v3 (archivado), con la misma API. Su LICENSE trae las dos: el port de libyaml es MIT y
  // el resto Apache-2.0. La v3.0.5 es de 2026-07-26. Se prefirió a goccy/go-yaml (MIT, también mantenido) por
  // ser la API que conoce cualquiera que haya leído YAML en Go.
  'go.yaml.in/yaml/v3': { version: 'v3.0.5', license: 'MIT AND Apache-2.0', kind: 'require', use: 'lectura de la configuración YAML' },
  // El ciclo de vida: errgroup para que ninguna goroutine quede sin dueño (§ 3.5). La v0.24.0 es de 2026-09-23.
  'golang.org/x/sync': { version: 'v0.24.0', license: 'BSD-3-Clause', kind: 'require', use: 'errgroup: servidores y trabajos con dueño' },

  // Herramientas, por la directiva `tool` de go.mod (`go tool <nombre>`): el proyecto no exige nada instalado
  // aparte de Go.
  // El JUnit de las pruebas, que lee keel-core/gen/junit-scoring.js (su XML real se capturó en el inc. 1).
  'gotest.tools/gotestsum': { version: 'v1.13.0', license: 'Apache-2.0', kind: 'tool', tool: 'gotest.tools/gotestsum', use: 'JUnit de go test' },
  // El lint con SA, S, ST y QF. La v0.8.2 (2026.1.2) es de 2026-10-12.
  'honnef.co/go/tools': { version: 'v0.8.2', license: 'MIT', kind: 'tool', tool: 'honnef.co/go/tools/cmd/staticcheck', use: 'lint (staticcheck)' },
  // El equivalente del NuGet Audit: vulnerabilidades conocidas en lo que el servicio llama de verdad. La v1.9.0 es
  // de 2026-10-11.
  'golang.org/x/vuln': { version: 'v1.9.0', license: 'BSD-3-Clause', kind: 'tool', tool: 'golang.org/x/vuln/cmd/govulncheck', use: 'vulnerabilidades (govulncheck)' },
  // Las licencias de todo lo que Go resuelve, transitivos incluidos (infra/check-licenses.sh).
  'github.com/google/go-licenses/v2': { version: 'v2.0.1', license: 'Apache-2.0', kind: 'tool', tool: 'github.com/google/go-licenses/v2', use: 'licencias de los transitivos' }
};

/** Los módulos de ejecución que emite el esqueleto (inc. 2): los que importa el código de `build`. */
export const SKELETON_REQUIRES = ['go.yaml.in/yaml/v3', 'golang.org/x/sync'];

/** Las herramientas: todas, siempre. */
export const TOOLS = Object.entries(MODULES)
  .filter(([, module]) => module.kind === 'tool')
  .map(([path]) => path);

/**
 * Los problemas de licencia de un módulo y versión. Vacío si se puede emitir. `license` es la expresión SPDX
 * de su LICENSE (null si no se pudo leer: entonces no se sabe, y se rechaza).
 */
export function licenseProblems({ path, version, license }) {
  const problems = [];
  if (VETOED_MODULES[path]) problems.push(`${path} ${version}: ${VETOED_MODULES[path]}`);
  if (!license) {
    problems.push(`${path} ${version}: no declara licencia SPDX: no se puede comprobar`);
    return problems;
  }
  const forbidden = spdxIds(license).filter((id) => FORBIDDEN_LICENSES.some((pattern) => pattern.test(id)));
  if (forbidden.length > 0 && !licenseAllowed(license)) problems.push(`${path} ${version}: licencia ${license}, prohibida (${forbidden.join(', ')})`);
  else if (!licenseAllowed(license)) problems.push(`${path} ${version}: licencia ${license}, fuera de ${ALLOWED_LICENSES.join(', ')}`);
  return problems;
}

/**
 * ¿Admite la expresión SPDX alguna combinación de la lista? Una disyunción (`MIT OR Apache-2.0`) deja elegir;
 * una conjunción (`MIT AND GPL-3.0`) obliga a todas, y se rechaza salvo que todas estén admitidas.
 */
export function licenseAllowed(expression) {
  const text = String(expression).replace(/[()]/g, ' ').trim();
  return text.split(/\s+OR\s+/).some((alternative) => alternative.split(/\s+AND\s+/).every((part) => ALLOWED_LICENSES.includes(part.trim())));
}

function spdxIds(expression) {
  return String(expression)
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
