// El módulo Go del servicio: `go.mod`, `.gitignore` y el comentario de cada paquete (`doc.go`).
//
// `go.mod` declara lo que build sabe con certeza: la ruta del módulo, la versión mínima de Go y el toolchain
// con el que se mide, los módulos de ejecución que importa el código emitido y las herramientas (directiva
// `tool`), todo con la versión exacta de go-stack.js. Lo que no declara son los requisitos INDIRECTOS ni
// `go.sum`: los calcula `go mod tidy` desde los directos con MVS, que es determinista (las mismas versiones
// directas dan siempre el mismo grafo), igual que `npm install` escribe el lockfile en keel-nest. Por eso la
// puerta de go-check no es «tidy no cambia nada» sino «tidy no cambia ningún requisito DIRECTO ni ninguna
// herramienta»: si build declarase uno de más, de menos o en otra versión, tidy lo movería.

import { GO_MIN_VERSION, GO_TOOLCHAIN } from '../lib/assets.js';
import { usesRelational } from '@keel-system/keel-core/gen/features';
import { MODULES, RELATIONAL_REQUIRES, SKELETON_REQUIRES, TEXT_FOLD_REQUIRES, TOOLS } from '../lib/go-stack.js';
import { foldKinds } from './persistence-runtime.js';
import { layout, packageFile } from './render.js';

/** Los módulos de ejecución que el proyecto importa, en el orden de go.mod. Crece con cada capa que se genera. */
export function requiresFor(model = null) {
  return [
    ...SKELETON_REQUIRES,
    ...(model && usesRelational(model) ? RELATIONAL_REQUIRES : []),
    ...(model && foldKinds(model).has('accents') ? TEXT_FOLD_REQUIRES : [])
  ].sort();
}

/** Las herramientas (`go tool <nombre>`): todas, siempre. */
export function toolsFor() {
  return TOOLS.map((path) => MODULES[path].tool).sort();
}

export function generate(model) {
  const pkgs = layout(model);
  return [
    { path: 'go.mod', content: goMod(model) },
    { path: '.gitignore', content: gitignore() },
    docFile(model, pkgs.domain, 'Package domain contiene el modelo del dominio del servicio: agregados, value objects, enums, eventos,\nerrores y los puertos que la aplicación necesita. Solo depende de la biblioteca estándar y de su lista\nblanca (ver internal/architecture). Lo que el diseño no puede decir (constructores, métodos de negocio)\nlo escribe el agente siguiendo los TODO de cada tipo.'),
    docFile(model, pkgs.application, 'Package application contiene los casos de uso del servicio: por cada operación su mensaje (lo escribe\nbuild) y su handler (lo completa el agente), los DTO de respuesta y los mapeos desde el dominio. UseCases\nes la única puerta de despacho. Solo ve el dominio.'),
    docFile(model, pkgs.architecture, 'Package architecture comprueba la frontera hexagonal del servicio: qué capa puede importar a cuál.\nNo tiene código de producción; su prueba falla si un import cruza una frontera.')
  ];
}

function docFile(model, target, text) {
  return { path: `${target.dir}/doc.go`, content: packageFile(model, target, { doc: text, body: '' }) };
}

// El módulo de una herramienta va también en `require`, marcado `// indirect` como lo deja `go get -tool`: sin
// él, `go mod tidy` lo resolvería a la ÚLTIMA versión publicada, no a la fijada en go-stack.js.
function goMod(model) {
  const requires = requiresFor(model).map((path) => `\t${path} ${MODULES[path].version}`);
  const toolModules = TOOLS.slice()
    .sort()
    .map((path) => `\t${path} ${MODULES[path].version} // indirect`);
  const tools = toolsFor().map((tool) => `\t${tool}`);
  return `module ${model.service.goModule}

go ${GO_MIN_VERSION}

toolchain ${GO_TOOLCHAIN}

require (
${requires.join('\n')}
)

require (
${toolModules.join('\n')}
)

tool (
${tools.join('\n')}
)
`;
}

function gitignore() {
  return `# Binarios y salidas de las pruebas
/bin/
/build/
*.test
*.out
coverage.*
`;
}
