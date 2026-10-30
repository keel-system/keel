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

/**
 * Las EXCEPCIONES a la lista blanca, una por módulo y con su motivo: la licencia admitida solo para ese módulo, nunca
 * en general (PLAN-KEEL-GO.md § 1.6: «MPL-2.0 solo si es inevitable y queda escrito»). go-check la pasa a go-licenses
 * como el único paquete que se le perdona.
 */
export const LICENSE_EXCEPTIONS = {
  // El único driver de MySQL para Go mantenido y sin cgo. La MPL-2.0 es copyleft por ARCHIVO: obliga a publicar los
  // cambios a los archivos del driver, y keel-go lo usa sin modificar; el código del servicio no queda afectado.
  // Aprobada por el usuario el 2026-10-29 (incremento 6d).
  'github.com/go-sql-driver/mysql': { license: 'MPL-2.0', why: 'el único driver de MySQL para Go mantenido y sin cgo; copyleft por archivo, usado sin modificar' }
};

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
  // Los uuid: `NewV7()` para los ids que genera el servidor y la forma canónica en minúsculas del cable. Es un
  // [16]byte en big-endian, así que el binary(16) de MySQL sale igual que en keel-spring. La v1.6.0 es de
  // 2024-01-23 y sigue siendo la última.
  'github.com/google/uuid': { version: 'v1.6.0', license: 'BSD-3-Clause', kind: 'require', use: 'uuid (v7 y forma del cable)' },
  // El ciclo de vida: errgroup para que ninguna goroutine quede sin dueño (§ 3.5). La v0.24.0 es de 2026-09-23.
  'golang.org/x/sync': { version: 'v0.24.0', license: 'BSD-3-Clause', kind: 'require', use: 'errgroup: servidores y trabajos con dueño' },
  // El driver de PostgreSQL, por su adaptador de database/sql (`pgx/v5/stdlib`): los repositorios escriben SQL sobre
  // la interfaz estándar y el error del motor llega como `*pgconn.PgError`, con el NOMBRE de la constraint aparte. La
  // v5.11.0 es de 2026-09-07.
  'github.com/jackc/pgx/v5': { version: 'v5.11.0', license: 'MIT', kind: 'require', use: 'driver de PostgreSQL (database/sql)' },
  // El driver de MySQL, sobre database/sql: el error del motor llega como `*mysql.MySQLError`, con el número y el
  // mensaje (el nombre de la constraint va en el texto). MPL-2.0, con su excepción escrita en LICENSE_EXCEPTIONS. Trae
  // filippo.io/edwards25519 (BSD-3-Clause). La v1.10.1 es de 2026-09-02.
  'github.com/go-sql-driver/mysql': { version: 'v1.10.1', license: 'MPL-2.0', kind: 'require', use: 'driver de MySQL (database/sql)' },
  // Las migraciones al arrancar, embebidas en el binario (Provider sobre un fs.FS, sin el registro global). Su
  // paquete raíz no importa los dialectos de otros motores: los módulos que su go.mod nombra (ClickHouse, MSSQL…)
  // no entran en el binario. La v3.29.0 es de 2026-10-11.
  'github.com/pressly/goose/v3': { version: 'v3.29.0', license: 'MIT', kind: 'require', use: 'migraciones del esquema al arrancar' },
  // La descomposición de Unicode (NFD) para plegar los acentos de una sombra (`compare: ignore-case-accents`). Es la
  // misma versión que piden pgx y goose en el grafo, así que tidy no la mueve. La v0.43.0 es de 2026-10-09.
  'golang.org/x/text': { version: 'v0.43.0', license: 'BSD-3-Clause', kind: 'require', use: 'pliegue de acentos (NFD)' },

  // La validación de los JWT de la entrada HTTP (incremento 8): firma, algoritmo, exp y nbf con su margen, e iss. El JWKS
  // lo lee el servicio con la biblioteca estándar (sin keyfunc, que refresca en una goroutine propia). La v5.3.1 es de
  // 2026-01-28.
  'github.com/golang-jwt/jwt/v5': { version: 'v5.3.1', license: 'MIT', kind: 'require', use: 'validación de JWT' },

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

/**
 * Los módulos de ejecución que emite el esqueleto: los que importa el código de `build`. uuid entra con el
 * contrato del cable (inc. 3), que lo prueba aunque el diseño no declare ningún uuid.
 */
export const SKELETON_REQUIRES = ['github.com/google/uuid', 'go.yaml.in/yaml/v3', 'golang.org/x/sync'];

/** El pliegue sin acentos (`compare: ignore-case-accents`) necesita la descomposición de Unicode (NFD). */
export const TEXT_FOLD_REQUIRES = ['golang.org/x/text'];

/** Los módulos de la persistencia relacional (incremento 6), por motor: el driver y las migraciones. */
export const RELATIONAL_REQUIRES = {
  postgresql: ['github.com/jackc/pgx/v5', 'github.com/pressly/goose/v3'],
  mysql: ['github.com/go-sql-driver/mysql', 'github.com/pressly/goose/v3']
};

/** La validación de tokens de la capa security (incremento 8). */
export const JWT_REQUIRES = ['github.com/golang-jwt/jwt/v5'];

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
  // La excepción vale para ESE módulo y esa licencia: si el módulo cambiase de licencia, se vuelve a decidir.
  if (LICENSE_EXCEPTIONS[path]?.license === license) return problems;
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
