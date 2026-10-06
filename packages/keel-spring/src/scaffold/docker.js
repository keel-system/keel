// Infraestructura de prueba del proyecto generado, agrupada bajo `infra/`: docker-compose.yaml con
// solo los contenedores que el diseño + stack elegido necesitan, el toolbox `devtools` y los scripts
// que la manejan. Es neutral y la escribe keel-core/gen/infra-scripts.js; keel-spring aporta su
// plataforma (devtools.js).

import { infraFiles } from 'keel-core/gen/infra-scripts';
import { SPRING_INFRA } from './devtools.js';

export function generate(model) {
  return infraFiles(model, SPRING_INFRA);
}
