#!/usr/bin/env node
// Métricas de corrida (R8 de recomendaciones-diseno.md). Puro: ni red ni contenedores.
//
//   node packages/keel-spring/scripts/corrida-metrics.js footprint <services/<servicio>-spring>
//       la huella del agente sobre un proyecto terminado: registrados, adoptados, intactos,
//       reescritos y borrados de lo que escribió build, más el estampado de «diseño listo».
//   node packages/keel-spring/scripts/corrida-metrics.js series [docs/corridas]
//       una fila por corrida registrada, cuántas se generaron con --accept-unready y los
//       designGap que se repiten entre corridas (candidatos obligatorios a id).
//
// La lógica vive en src/lib/corrida-metrics.js; esto solo imprime. Salida determinista.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { footprint, byDirectory, series } from '../src/lib/corrida-metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const [command, target] = process.argv.slice(2);

function printFootprint(dir) {
  const result = footprint(dir);
  const design = result.design;
  console.log(`Huella del agente — ${dir}`);
  console.log(`  generador: ${result.generator ?? '(desconocido)'}`);
  console.log(
    `  diseño al generar: ${
      design == null
        ? 'sin estampar (anterior a la puerta)'
        : design.ready
          ? `listo (v${design.version})`
          : `NO listo (v${design.version}${design.acceptedUnready ? ', con --accept-unready' : ''}; faltaban: ${design.missing.join(', ')})`
    }`
  );
  console.log(
    `  ${result.registered} registrados por build, ${result.adopted} adoptados, ${result.intact} intactos, ` +
      `${result.rewritten.length} reescritos, ${result.deleted.length} borrados`
  );
  if (result.pendingMerge.length > 0) console.log(`  fusiones pendientes: ${result.pendingMerge.length}`);
  if (result.rewritten.length > 0) {
    console.log('\nReescritos, por directorio:');
    for (const [dir, files] of byDirectory(result.rewritten)) console.log(`  ${dir}/  ${files.join(', ')}`);
  }
  if (result.deleted.length > 0) {
    console.log('\nBorrados:');
    for (const file of result.deleted) console.log(`  ${file}`);
  }
  console.log(
    `\nFila para docs/corridas: | Huella del agente | ${result.registered} archivos registrados por \`build\`, ` +
      `${result.adopted} adoptados, **${result.rewritten.length} reescritos**, ${result.deleted.length} borrados |`
  );
}

function printSeries(dir) {
  const { corridas, repeated, acceptedUnready, verdict } = series(dir);
  const cell = (value) => (value == null ? '—' : String(value));
  // Las columnas del plan de validación solo salen cuando alguna corrida las midió: la serie
  // anterior se sigue leyendo exactamente igual.
  const extended = corridas.some((corrida) => corrida.gateHoles != null || corrida.generatorGaps != null);
  console.log(`Serie de corridas — ${dir}\n`);
  console.log(
    `| corrida | listo al generar | reescritos | borrados | registrados | huecos del diseño |${extended ? ' huecos del generador | agujeros de la puerta | careo |' : ''}`
  );
  console.log(`|---|---|---|---|---|---|${extended ? '---|---|---|' : ''}`);
  for (const corrida of corridas) {
    const listo =
      corrida.ready === true ? 'sí' : corrida.ready === false ? `no${corrida.acceptedUnready ? ' (--accept-unready)' : ''}` : '—';
    const extra = extended
      ? ` ${cell(corrida.generatorGaps)} | ${cell(corrida.gateHoles)} | ${corrida.careoPasses ? corrida.careoPasses.join('→') : '—'} |`
      : '';
    console.log(
      `| ${corrida.name}${corrida.role === 'control' ? ' (control)' : ''} | ${listo} | ${cell(corrida.rewritten)} | ${cell(corrida.deleted)} | ${cell(corrida.registered)} | ${cell(corrida.designGaps)} |${extra}`
    );
  }
  console.log(`\nGeneradas con --accept-unready: ${acceptedUnready} de ${corridas.length}`);
  if (repeated.length === 0) console.log('designGap repetidos entre corridas: ninguno');
  else {
    console.log('designGap repetidos entre corridas (candidatos obligatorios a id):');
    for (const [key, names] of repeated) console.log(`  ${key}: ${names.join(', ')}`);
  }
  console.log(`\nVeredicto H1 (plan de validación de R8): ${verdict.status.toUpperCase()} — ${verdict.measured} corrida(s) de medición`);
  for (const reason of verdict.reasons) console.log(`  - ${reason}`);
}

try {
  if (command === 'footprint' && target) printFootprint(path.resolve(target));
  else if (command === 'series') printSeries(path.resolve(target ?? path.join(here, '..', '..', '..', 'docs', 'corridas')));
  else {
    console.error('Uso: corrida-metrics.js footprint <proyecto> | series [docs/corridas]');
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
