// La FRONTERA HEXAGONAL del proyecto generado, como regla ejecutable: `.dependency-cruiser.json` y
// el script `npm run check:architecture`.
//
// En keel-spring la frontera la sostiene la constitución y la revisa un agente; aquí además la
// comprueba una herramienta, porque en TypeScript un import es una línea que el compilador acepta
// venga de donde venga. Las reglas son las de la arquitectura (PLAN-KEEL-NEST.md § 2):
//   · el dominio no importa ni la aplicación ni la infraestructura, y ningún paquete salvo los que
//     son parte del modelo (decimal.js, que sostiene el Decimal con escala);
//   · la aplicación no importa la infraestructura ni ningún framework;
//   · nada de dominio o aplicación puede importar algo que no se resuelve: un import roto que la
//     herramienta no sabe seguir sería la forma de saltarse las otras dos sin que se note.
// Los módulos de Node (`node:crypto`) no son framework y se admiten: el dominio genera UUIDs con él.
//
// Se cuentan también los imports de solo tipo (`tsPreCompilationDeps`): un `import type` de
// @nestjs/common en el dominio es acoplamiento aunque desaparezca al compilar.

/** Paquetes que el dominio y la aplicación pueden importar: son parte del modelo, no framework. */
export const MODEL_PACKAGES = ['decimal.js'];

export function generate() {
  return [{ path: '.dependency-cruiser.json', content: `${JSON.stringify(config(), null, 2)}\n` }];
}

function packagesPattern() {
  return `^node_modules/(${MODEL_PACKAGES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/`;
}

function config() {
  const npm = ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg', 'npm-unknown'];
  return {
    forbidden: [
      {
        name: 'dominio-sin-capas-externas',
        comment: 'El dominio no conoce la aplicación ni la infraestructura: son ellas las que dependen de él.',
        severity: 'error',
        from: { path: '^src/domain/' },
        to: { path: '^src/(application|infrastructure)/' }
      },
      {
        name: 'aplicacion-sin-infraestructura',
        comment: 'La aplicación habla con la infraestructura por puertos (clases abstractas en domain o application/port), nunca importándola.',
        severity: 'error',
        from: { path: '^src/application/' },
        to: { path: '^src/infrastructure/' }
      },
      {
        name: 'dominio-y-aplicacion-sin-framework',
        comment: `Dominio y aplicación no importan paquetes (Nest, un ORM, un cliente de broker) salvo los del modelo: ${MODEL_PACKAGES.join(', ')}.`,
        severity: 'error',
        from: { path: '^src/(domain|application)/' },
        to: { dependencyTypes: npm, pathNot: packagesPattern() }
      },
      {
        name: 'dominio-y-aplicacion-sin-imports-rotos',
        comment: 'Un import que no se resuelve no se puede juzgar: sería la forma de saltarse las otras reglas sin que se note.',
        severity: 'error',
        from: { path: '^src/(domain|application)/' },
        to: { couldNotResolve: true }
      }
    ],
    options: {
      doNotFollow: { path: 'node_modules' },
      tsPreCompilationDeps: true,
      // Con el tsconfig del proyecto (module: nodenext) resuelve los imports relativos con `.js` que
      // apuntan a un `.ts`.
      tsConfig: { fileName: 'tsconfig.json' }
    }
  };
}
