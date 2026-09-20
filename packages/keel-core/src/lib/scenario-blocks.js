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

/**
 * La tabla de `## Matriz de cobertura` como datos: `[{ operation, flows, surface }]`.
 *
 * Existe porque esa matriz es lo ÚNICO estructurado del documento —el resto es prosa
 * Given/When/Then— y hasta ahora no la cruzaba nadie con el diseño. La primera regla de
 * cobertura de `docs/validation-scenarios.md` dice que toda operación tiene que estar en
 * ella, y quien lo comprobaba era el mismo agente que la había escrito.
 *
 * Solo se reconocen como fila de operación las que nombran un identificador del DSL
 * (`createReservation`). Las filas transversales que el formato admite —`**clúster (2
 * réplicas)**`, que agrupa escenarios por mecanismo y no por operación— se ignoran a
 * propósito: tratarlas como operaciones inexistentes convertiría una tabla bien escrita
 * en una lista de falsos hallazgos.
 */
export function parseCoverageMatrix(text) {
  const lines = (text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{2,3}\s+Matriz de cobertura/i.test(line));
  if (start === -1) return [];

  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line)) break; // la sección siguiente
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    if (/^-{3,}/.test(cells[0])) continue; // separador
    const operation = cells[0].replace(/\*\*/g, '').trim();
    if (!/^[a-z][A-Za-z0-9]*$/.test(operation)) continue; // cabecera o fila transversal
    rows.push({
      operation,
      flows: [...cells[1].matchAll(/FL-[A-Za-z0-9-]+/g)].map((match) => match[0]),
      surface: cells[2] ?? ''
    });
  }
  return rows;
}
