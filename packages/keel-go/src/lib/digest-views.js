// Las vistas con las que se comparan los archivos que una herramienta de Go reescribe por
// prescripción del propio flujo (`viewOf` de keel-core/src/lib/write.js).
//
// El caso es `go.mod`. build no escribe los requisitos indirectos ni `go.sum` a propósito: los
// calcula `go mod tidy` con MVS, que es determinista, y la puerta es que tidy no mueva ningún
// directo. Pero el mismo build le dice a quien lo usa que ejecute tidy, y desde ese momento el
// `go.mod` ya no casaba con el manifiesto: la huella de la corrida 7d se lo atribuyó al agente,
// y un `--refresh` lo veía TOCADO para siempre. La vista quita lo que añade tidy y nada de lo
// que decide build:
//   · un `// indirect` se queda si es el módulo de una herramienta del bloque `tool` (build fija
//     ahí su versión: quitarlo haría invisible un cambio de versión de staticcheck) y se va si no;
//   · un bloque `require` que se queda vacío desaparece, y con él la línea en blanco que deja.
// Sobre lo que emite build es la identidad (test/digest-views.test.js, en todas las fixtures):
// los manifiestos ya escritos siguen valiendo.
//
// Lo carga también la huella de una corrida (`corrida-metrics.js footprint`), por el nombre del
// generador que firma el manifiesto: por eso el módulo exporta `DIGEST_VIEWS` y nada más.

const INDIRECT = /^\s*(\S+)\s+\S+\s*\/\/ indirect\s*$/;

/** Los paquetes del bloque `tool` (o de una directiva `tool` de una línea). */
function toolPaths(lines) {
  const tools = [];
  let inTool = false;
  for (const line of lines) {
    const text = line.trim();
    if (inTool) {
      if (text === ')') inTool = false;
      else if (text && !text.startsWith('//')) tools.push(text.split(/\s+/)[0]);
    } else if (text === 'tool (') inTool = true;
    else if (text.startsWith('tool ')) tools.push(text.slice(5).trim().split(/\s+/)[0]);
  }
  return tools;
}

/** El módulo requerido que contiene un paquete: el de ruta más larga que lo prefija, como en Go. */
function moduleOf(pkg, modules) {
  let best = null;
  for (const mod of modules) {
    if ((pkg === mod || pkg.startsWith(`${mod}/`)) && (best === null || mod.length > best.length)) best = mod;
  }
  return best;
}

/** El `go.mod` sin lo que añade `go mod tidy`. */
export function goModView(text) {
  const lines = text.split('\n');
  const required = [];
  let inRequire = false;
  for (const line of lines) {
    const text = line.trim();
    if (inRequire) {
      if (text === ')') inRequire = false;
      else if (text && !text.startsWith('//')) required.push(text.split(/\s+/)[0]);
    } else if (text === 'require (') inRequire = true;
    else if (text.startsWith('require ')) required.push(text.slice(8).trim().split(/\s+/)[0]);
  }
  const toolModules = new Set(toolPaths(lines).map((pkg) => moduleOf(pkg, required)).filter(Boolean));

  const kept = [];
  inRequire = false;
  for (const line of lines) {
    const text = line.trim();
    const indirect = INDIRECT.exec(text.startsWith('require ') ? text.slice(8) : line);
    if (indirect && (inRequire || text.startsWith('require ')) && !toolModules.has(indirect[1])) continue;
    if (text === 'require (') inRequire = true;
    else if (inRequire && text === ')') inRequire = false;
    kept.push(line);
  }
  return kept
    .join('\n')
    .replace(/^require \(\n\)\n(\n)?/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

export const DIGEST_VIEWS = Object.freeze({ 'go.mod': goModView });
