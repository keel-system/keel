// El traspaso entre `keel-spring build` y `/keel-generate-spring` cuando el proyecto YA
// estaba generado y algo cambió: el diseño, el stack o el generador.
//
// La lógica es neutral y vive en keel-core/gen/evolution.js, la misma que usa keel-nest: aquí
// solo están los textos de la plataforma Spring que el documento cita.

import { SKILL } from '../lib/assets.js';

export const SPRING_EVOLUTION = {
  generator: 'keel-spring',
  skill: SKILL,
  keepBuild: '**No ejecutes `./gradlew clean` hasta cerrar la evolución**',
  scenarioWork:
    'crear las clases de los añadidos, reescribir las de las familias cambiadas y borrar las de los quitados. ' +
    'La clase de un flujo se localiza buscando su id en `src/integrationTest/`.',
  duplicateStub: 'dos `@Component` del mismo puerto tumban el arranque'
};
