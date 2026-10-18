// El traspaso entre `keel-dotnet build` y `/keel-generate-dotnet` cuando el proyecto YA estaba
// generado y algo cambió: el diseño, el stack o el generador.
//
// La lógica es neutral y vive en keel-core/gen/evolution.js, la misma que usan keel-spring y keel-nest:
// aquí solo están los textos de la plataforma .NET que el documento cita.

import { SKILL } from '../lib/assets.js';

export const DOTNET_EVOLUTION = {
  generator: 'keel-dotnet',
  skill: SKILL,
  keepBuild: '**No borres `build/` hasta cerrar la evolución**',
  scenarioWork:
    'crear las clases de los añadidos, reescribir las de las familias cambiadas y borrar las de los quitados. ' +
    'La clase de un flujo se localiza buscando su id en `tests/`.',
  duplicateStub: 'dos registros del mismo puerto en el contenedor, y el que resuelve es el último sin avisar'
};
