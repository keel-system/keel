// El traspaso entre `keel-nest build` y `/keel-generate-nest` cuando el proyecto YA estaba
// generado y algo cambió: el diseño, el stack o el generador.
//
// La lógica es neutral y vive en keel-core/gen/evolution.js, la misma que usa keel-spring: aquí
// solo están los textos de la plataforma Nest que el documento cita.

import { SKILL } from '../lib/assets.js';

export const NEST_EVOLUTION = {
  generator: 'keel-nest',
  skill: SKILL,
  keepBuild: '**No borres `build/` hasta cerrar la evolución**',
  scenarioWork:
    'crear las pruebas de los añadidos, reescribir las de las familias cambiadas y borrar las de los quitados. ' +
    'La prueba de un flujo se localiza buscando su id en `test/integration/`.',
  duplicateStub: 'dos proveedores del mismo token de puerto, y el módulo se queda con uno sin avisar'
};
