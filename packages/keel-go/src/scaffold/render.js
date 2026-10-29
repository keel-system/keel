// DÓNDE vive cada cosa generada: el único mapa de paquetes del proyecto (PLAN-KEEL-GO.md § 2).
//
// Un paquete Go es un directorio y una unidad de compilación; su ruta de importación es la del módulo más
// el directorio. Un emisor que escribiera en `internal/platform/conf/` mientras otro importa
// `internal/platform/config` no compilaría, así que la ruta de cada paquete sale de aquí y de ningún otro
// sitio. Lo que en Spring son subpaquetes (`commands/`, `dtos/`, `mappers/`) aquí son ARCHIVOS del mismo
// paquete: `domain` y `application` son un paquete cada uno a propósito, porque partirlos por agregado abre
// ciclos de importación en cuanto dos agregados se refieren.

import { goFile } from '../lib/go-source.js';

/** Un paquete del proyecto: su directorio, su ruta de importación y su nombre. */
function pkg(module, dir, name = dir.split('/').at(-1)) {
  return { dir, importPath: `${module}/${dir}`, name };
}

/** Los paquetes del proyecto generado, con la capa a la que pertenece cada uno. */
export function layout(model) {
  const module = model.service.goModule;
  return {
    module,
    // El arranque: solo `main` y `run`, con el cableado explícito (sin contenedor de inyección).
    server: pkg(module, 'cmd/server', 'main'),
    // Los archivos de configuración por perfil, embebidos en el binario (embed.FS): el ejecutable no depende
    // de con qué directorio de trabajo se lance, y la imagen distroless no tiene nada más que él.
    configFiles: pkg(module, 'config'),
    domain: pkg(module, 'internal/domain'),
    application: pkg(module, 'internal/application'),
    httpapi: pkg(module, 'internal/httpapi'),
    config: pkg(module, 'internal/platform/config'),
    health: pkg(module, 'internal/platform/health'),
    // La prueba de la frontera hexagonal: `internal/` solo protege frente a otros módulos, no entre capas.
    architecture: pkg(module, 'internal/architecture')
  };
}

/**
 * Las capas y a qué paquetes PROPIOS puede importar cada una: la frontera hexagonal que ejecuta
 * `internal/architecture/architecture_test.go`. Un prefijo `internal/platform/` admite cualquiera de sus
 * paquetes. `thirdParty` es la lista blanca de módulos de terceros; null, cualquiera.
 */
export function boundaries() {
  return [
    { layer: 'domain', prefix: 'internal/domain', allows: [], thirdParty: ['github.com/google/uuid'] },
    { layer: 'application', prefix: 'internal/application', allows: ['internal/domain'], thirdParty: ['github.com/google/uuid'] },
    { layer: 'platform', prefix: 'internal/platform/', allows: ['internal/platform/'], thirdParty: null },
    {
      layer: 'httpapi',
      prefix: 'internal/httpapi',
      allows: ['internal/application', 'internal/domain', 'internal/platform/'],
      thirdParty: null
    },
    {
      layer: 'infrastructure',
      prefix: 'internal/infrastructure/',
      allows: ['internal/application', 'internal/domain', 'internal/platform/'],
      thirdParty: null
    }
  ];
}

/**
 * Un archivo Go de un paquete del mapa: la cabecera de código generado y los imports que el cuerpo usa. Con
 * `test`, la prueba de caja negra del paquete.
 */
export function packageFile(model, target, { doc = null, imports = [], body, generated = true, test = false }) {
  // Una prueba de caja negra va en el paquete `<nombre>_test`: solo ve lo exportado, como cualquier llamante.
  const pkg = test ? `${target.name}_test` : target.name;
  return goFile({ pkg, doc, imports, body, module: model.service.goModule, generated });
}
