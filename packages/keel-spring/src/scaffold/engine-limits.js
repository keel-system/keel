// Lo que el motor elegido NO sostiene, dicho en voz alta y por escrito.
//
// El DSL declara garantías; un motor concreto puede no tener con qué sostener alguna. Eso no es un
// error del diseño ni un defecto del generador — es una consecuencia de una elección de stack—,
// pero **callarlo sí es un defecto**: el diseñador cree que su invariante está sostenido, nada le
// desmiente, y el hueco no aparece hasta que dos peticiones simultáneas dejan dos filas donde el
// diseño decía que solo podía haber una.
//
// Hasta ahora esto lo hacía UNA degradación, con su aviso escrito a mano dentro de
// `migrations.js`. Aquí se deriva de la matriz de paridad (`src/lib/engine-support.js`), que es
// donde vive el dato, y se emite por dos caminos a propósito:
//
//   · un aviso en `build`, que es cuando el diseñador acaba de elegir el motor y todavía puede
//     cambiarlo;
//   · `docs/keel/engine-limits.md` en el proyecto generado, que es donde sigue estando dentro de
//     seis meses, cuando el aviso de consola ya no lo recuerde nadie y el que lea el repo no
//     estuviera delante.
//
// El documento se emite SIEMPRE, también cuando no hay ninguna degradación. Un archivo ausente es
// ambiguo —¿no hay límites, o nadie los miró?— y «este motor sostiene todo lo que el diseño
// declara» es una afirmación que vale la pena poder leer.

import { MECHANISMS } from '../lib/engine-support.js';
import { partialIndexSpecs } from './migrations.js';

const DOC = 'docs/keel/engine-limits.md';

/**
 * Los predicados que deciden si una degradación LE TOCA a este diseño.
 *
 * Viven aquí y no en la matriz porque evaluarlos necesita el modelo ya construido, y la matriz es
 * dato. Una garantía que el diseño no pidió no se degrada: anunciarla sería ruido, y el ruido es
 * lo que hace que se dejen de leer los avisos que sí importan.
 */
const APPLIES = {
  partialUniqueIndexes: (model) => partialIndexSpecs(model).length > 0
};

/**
 * Las degradaciones que aplican a ESTE diseño sobre ESTE motor.
 *
 * Solo el eje de motor: una degradación es siempre «este motor no puede», nunca «este modelo no
 * puede» —lo segundo sería una asimetría de ramas, y de eso se ocupa el test de paridad—.
 */
export function degradations(model) {
  const engine = model.stack?.database;
  if (!engine) return [];

  const out = [];
  for (const [id, mechanism] of Object.entries(MECHANISMS)) {
    if (mechanism.axis !== 'engine') continue;
    const cell = mechanism.coverage[engine];
    if (cell?.state !== 'degradado' || !cell.degraded) continue;

    // Sin predicado declarado, la degradación aplica siempre que el motor la tenga. Es el default
    // conservador: es peor callar una que sobra que perder una que hacía falta.
    const applies = mechanism.appliesWhen ? APPLIES[mechanism.appliesWhen] : () => true;
    if (!applies) {
      throw new Error(
        `engine-limits: '${mechanism.appliesWhen}' no tiene predicado en APPLIES. Una degradación cuyo ` +
          'disparador nadie sabe evaluar se emitiría siempre o nunca, y las dos cosas son mentira.'
      );
    }
    if (!applies(model)) continue;

    out.push({ id, engine, title: mechanism.title, ...cell.degraded });
  }
  return out;
}

/**
 * El aviso de consola. Se empuja a `model.warnings` desde el scaffolding, junto al resto, para que
 * `build` lo imprima donde el diseñador ya mira.
 */
export function warnings(model) {
  return degradations(model).map(
    (d) =>
      `${d.id}: ${model.stack.database} no sostiene «${d.guarantee}»: ${d.consequence}. ` +
      `Salidas: ${d.ways.join('; ')}. Queda escrito en ${DOC}`
  );
}

export function generate(model) {
  // El aviso se empuja aquí, dentro de la pasada de generación: es donde el modelo ya está
  // completo y de donde `scaffoldService` recoge `model.warnings` al terminar. Es el mismo sitio
  // del que lo empujaba `migrations.js` antes de que el dato tuviera dueño.
  for (const aviso of warnings(model)) model.warnings.push(aviso);

  if (!model.stack?.database) return [];
  return [{ path: DOC, content: doc(model) }];
}

function doc(model) {
  const engine = model.stack.database;
  const found = degradations(model);

  const cabecera = `# Lo que ${engine} no sostiene de este diseño

> Generado por \`keel-spring build\` desde la matriz de paridad del generador. **No se edita a
> mano**: se regenera en cada build.

El diseño declara garantías de forma agnóstica; el motor las sostiene o no. Este documento dice
cuáles de las que **este diseño pidió** no las sostiene **este motor**, qué pasa en su lugar y
cuáles son las salidas. Existe porque el modo de fallo de una garantía ausente es silencioso: nada
lanza, nada se registra, y el hueco aparece el día que dos peticiones simultáneas hacen lo que el
diseño decía que no podía pasar.
`;

  if (found.length === 0) {
    return `${cabecera}
## Ninguna

Sobre \`${engine}\`, todas las garantías que este diseño declara tienen con qué sostenerse. Esto no
es una ausencia de comprobación: es el resultado de contrastar el diseño contra la matriz del
generador, y se vuelve a comprobar en cada \`build\`.
`;
  }

  const bloques = found.map(
    (d) => `## ${d.title}

- **Lo que el diseño pide**: ${d.guarantee}.
- **Lo que pasa sobre \`${d.engine}\`**: ${d.consequence}.
- **Salidas**, ninguna de las cuales elige el generador —todas tienen coste y se toman a la vista:
${d.ways.map((way) => `  - ${way}`).join('\n')}

`
  );

  return `${cabecera}
${bloques.join('')}---

Cambiar de motor cambia esta lista. Si alguna de estas garantías es innegociable para el servicio,
la decisión es de stack y se toma antes de generar, no después.
`;
}
