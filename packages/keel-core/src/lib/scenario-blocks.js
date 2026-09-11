// Trocear `validation-scenarios.md` en sus escenarios `FL-*`.
//
// Fuente única porque hay dos lectores con preguntas distintas: `crossrefs.js`, que busca
// en el TEXTO de cada escenario la señal de que cubre algo (una reentrega, un canal
// caído), y `design-delta.js`, que compara escenarios entre dos versiones de un diseño.
// Con una copia cada uno, el primero que cambiara el formato del encabezado dejaría al
// otro contando mal en silencio.

/**
 * Los bloques de escenario, en orden: cada uno empieza por su id (`FL-XXX-NNN: título…`)
 * y llega hasta el siguiente encabezado `FL-`. El formato es jerárquico —`### FL-SUB-001`
 * es el flujo y `#### FL-SUB-001-B` uno de sus pasos— y cada nivel es un bloque propio.
 *
 * Lo que va tras el último escenario de una sección (el `## Sección siguiente` y su
 * prosa) queda DENTRO del bloque: es lo que siempre ha leído `crossrefs.js`, y cambiarlo
 * de paso podría silenciar avisos de cobertura. Quien necesite el bloque limpio usa
 * `scenarioBody`.
 */
export function splitScenarioBlocks(text) {
  return (text ?? '')
    .split(/^#{2,4}\s+(?=FL-)/m)
    .slice(1)
    .filter((block) => /^FL-[A-Za-z0-9-]+/.test(block));
}

/** El id de un bloque: `FL-AST-001-B`. */
export function scenarioIdOf(block) {
  return block.split(/[:\s]/)[0];
}

/** La familia de un bloque: el flujo del que es paso (`FL-AST-001-B` → `FL-AST-001`). */
export function scenarioFamilyOf(block) {
  const id = scenarioIdOf(block);
  return (/^(FL-[A-Za-z0-9]+-\d+)/.exec(id) ?? [null, id])[1];
}

/**
 * El bloque sin lo que no es suyo: se corta en el primer encabezado que no es de
 * escenario (el título de la sección siguiente), y se normalizan los espacios finales.
 * Es lo que se compara entre versiones: sin el corte, retocar el título de la sección
 * de después daría por cambiado el último escenario de la anterior.
 */
export function scenarioBody(block) {
  const lines = block.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && /^#{1,4}\s+(?!FL-)/.test(line));
  return (end === -1 ? lines : lines.slice(0, end))
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}
