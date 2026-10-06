// La puerta que un diseño cruza antes de que un generador escriba nada (keel-core/gen).
//
// NEUTRAL: el workspace, la versión del DSL, la frontera declarada del generador, la validación
// estricta, las decisiones sin cerrar, la revisión y el cierre del diseño (`assessReadiness`) son
// las mismas preguntas para cualquier generador, y tienen que responderse igual. Si cada uno
// tuviera la suya, el mismo diseño podría generarse con uno y ser rechazado por otro —o peor,
// generarse con uno a medio cerrar sin que nada lo estampe—, y la equivalencia entre servidores
// dejaría de empezar en el mismo sitio.
//
// Cada generador pasa su identidad: el nombre de su CLI, las versiones del DSL que soporta y su
// frontera (`checkSupportedFeatures`). Escribe en consola y pone `process.exitCode`, como el
// comando que la llama.

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { isKeelWorkspace } from '../assets.js';
import { resolveServiceDir, loadService } from '../loader.js';
import { validateService } from '../validate-service.js';
import { assessReadiness } from '../readiness.js';
import { DECISIONS_FILE, classifyWarnings } from '../decisions.js';
import { REVIEW_FILE } from '../review-state.js';

function listSpecs(workspace) {
  const specsDir = path.join(workspace, 'specs');
  if (!fs.existsSync(specsDir)) return [];
  return fs
    .readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function printSchemaErrors(file, ajvErrors) {
  console.error(pc.bold(pc.red(`✘ ${file}`)));
  for (const error of ajvErrors) {
    const where = error.instancePath || '(raíz)';
    console.error(`  ${pc.red('•')} ${pc.cyan(where)} ${error.message}`);
  }
}

/**
 * Lleva el diseño de `inputPath` por la puerta. Devuelve null si no la cruza (ya informado y con
 * `process.exitCode = 1`), o `{ dir, spec, manifest, layers, validation, readiness }`.
 *
 * `generator` es `{ name, supportedDsl, checkSupportedFeatures }`. `mode === 'check'` no escribe y
 * por tanto no se niega por un diseño no listo: solo informa. `acceptUnready` genera a sabiendas
 * uno no listo (el generador lo estampa en su manifiesto).
 */
export function gateDesign({ inputPath, workspace, generator, mode = null, acceptUnready = false }) {
  const { name, supportedDsl, checkSupportedFeatures } = generator;

  if (!isKeelWorkspace(workspace)) {
    console.error(pc.red('Este directorio no es un workspace Keel (falta schema/service.schema.json).'));
    console.error(`Ejecuta primero ${pc.cyan('keel init')}.`);
    process.exitCode = 1;
    return null;
  }

  if (!inputPath) {
    console.error(pc.red(`Falta el servicio a preparar: ${name} build specs/<servicio>`));
    const services = listSpecs(workspace);
    if (services.length > 0) {
      console.error('Servicios en specs/:');
      for (const service of services) console.error(`  ${pc.cyan(`specs/${service}`)}`);
    }
    process.exitCode = 1;
    return null;
  }

  const { dir, error: resolveError } = resolveServiceDir(inputPath);
  if (resolveError) {
    console.error(pc.red(resolveError));
    process.exitCode = 1;
    return null;
  }

  // Compatibilidad DSL: el generador solo sabe mapear las versiones que declara.
  const { manifest, layers, errors: loadErrors } = loadService(dir);
  if (!manifest) {
    for (const message of loadErrors) console.error(pc.red(`✘ ${message}`));
    process.exitCode = 1;
    return null;
  }
  if (!supportedDsl.includes(manifest.keel)) {
    console.error(
      pc.red(`✘ DSL keel ${manifest.keel ?? '(sin declarar)'} no soportado por ${name} (soporta: ${supportedDsl.join(', ')}).`)
    );
    console.error(pc.dim(`  Actualiza ${name} o ajusta el diseño a una versión soportada.`));
    process.exitCode = 1;
    return null;
  }

  // Frontera del generador: lo que el DSL declara y el generador no sabe mapear se
  // rechaza o se avisa aquí, antes de sembrar nada y antes de preguntar el stack.
  const features = checkSupportedFeatures(manifest, layers);
  for (const message of features.warnings) console.warn(`${pc.yellow('⚠')} ${message}`);
  if (features.errors.length > 0) {
    console.error(pc.bold(pc.red(`✘ El diseño usa capacidades que ${name} no genera — ${features.errors.length}:`)));
    for (const message of features.errors) console.error(`  ${pc.red('•')} ${message}`);
    process.exitCode = 1;
    return null;
  }

  // Un diseño en progreso no es generable: validación estricta, sin --wip.
  const validation = validateService(dir, { wip: false });
  const {
    loadErrors: fullLoadErrors,
    schemaErrors,
    crossRefErrors,
    warnings,
    pending,
    obligations,
    undecided,
    incoherences,
    reviews,
    ok
  } = validation;

  for (const { file, errors } of schemaErrors) printSchemaErrors(file, errors);
  for (const message of fullLoadErrors) console.error(pc.red(`✘ ${message}`));
  if (pending.length > 0) {
    console.error(pc.bold(pc.red(`✘ Diseño incompleto — ${pending.length} pendiente(s):`)));
    for (const message of pending) console.error(`  ${pc.red('•')} ${message}`);
  }
  // Lo que decisions.yaml ya acepta no se repite: es lo mismo que enseña `keel validate`.
  const avisos = classifyWarnings(warnings, undecided, incoherences);
  for (const { message, hint } of avisos.shown) {
    console.warn(`${pc.yellow('⚠')} ${message}`);
    if (hint) console.warn(pc.dim(`    ${hint}`));
  }
  if (avisos.accepted > 0) {
    console.log(pc.dim(`  ${avisos.accepted} decisión(es) aceptada(s) en ${DECISIONS_FILE}: no se repiten como aviso.`));
  }
  if (crossRefErrors.length > 0) {
    console.error(pc.bold(pc.red(`✘ Referencias cruzadas — ${crossRefErrors.length} error(es):`)));
    for (const message of crossRefErrors) console.error(`  ${pc.red('•')} ${message}`);
  }

  // Las decisiones de diseño sin cerrar bloquean como un error, así que el
  // veredicto genérico de abajo tiene que decir cuáles: mientras esto no se
  // imprimía, un diseño rechazado por una obligación abierta era indistinguible
  // de uno roto, y la causa solo se veía ejecutando `keel validate` a mano.
  const sinCerrar = [...obligations.open, ...obligations.stale];
  if (obligations.errors.length > 0) {
    console.error(pc.bold(pc.red(`✘ ${DECISIONS_FILE} — ${obligations.errors.length} error(es):`)));
    for (const message of obligations.errors) console.error(`  ${pc.red('•')} ${message}`);
  }
  if (sinCerrar.length > 0) {
    console.error(pc.bold(pc.red(`✘ Decisiones de diseño sin cerrar — ${sinCerrar.length}:`)));
    for (const item of sinCerrar) {
      const caducada = item.since ? pc.dim(` (aceptada en v${item.since}: el diseño cambió, reafírmala)`) : '';
      console.error(`  ${pc.red('•')} ${pc.cyan(item.id)} ${item.scope}: ${item.message}${caducada}`);
    }
    console.error(
      pc.dim(`  Ciérralas en el diseño, o acéptalas por escrito en ${DECISIONS_FILE} con su motivo — ver docs/design-obligations.md`)
    );
  }

  // La revisión semántica bloquea a través del `ok` de validateService, así que sin este
  // bloque un diseño rechazado por un hallazgo abierto sería indistinguible de uno roto.
  if (reviews.errors.length > 0) {
    console.error(pc.bold(pc.red(`✘ ${REVIEW_FILE} — ${reviews.errors.length} error(es):`)));
    for (const message of reviews.errors) console.error(`  ${pc.red('•')} ${message}`);
  }
  if (reviews.open.length > 0) {
    console.error(pc.bold(pc.red(`✘ Revisión con hallazgos abiertos — ${reviews.open.length}:`)));
    for (const item of reviews.open) {
      console.error(`  ${pc.red('•')} ${pc.cyan(item.id)} ${item.title}`);
      if (item.note) console.error(pc.dim(`    ${item.note}`));
    }
    console.error(pc.dim(`  Ciérralos en el diseño y vuelve a ejecutar /keel-validate — ver docs/design-obligations.md`));
  }

  if (!ok || pending.length > 0) {
    console.error();
    console.error(pc.red('El diseño aún no es generable. Termina el diseño (/keel-design) y valida con keel validate.'));
    process.exitCode = 1;
    return null;
  }

  // Generable no es lo mismo que LISTO: el cierre del diseño también pide revisión completa,
  // escenarios, careo y DESIGN.md de esta versión. Un diseño no listo NO se genera, y la única
  // salida sin cerrarlo es decirlo a sabiendas con --accept-unready, que el generador estampa
  // en su manifiesto. Vale para todo lo que escribe —también --refresh, porque el snapshot que
  // refresca es el del diseño de ahora—; --check no escribe y solo informa. Se niega ANTES de
  // tocar nada: ni el stack, ni el snapshot, ni el proyecto.
  const readiness = assessReadiness(dir, { validation });
  const spec = path.relative(workspace, dir).split(path.sep).join('/');
  if (!readiness.ready && !acceptUnready && mode !== 'check') {
    reportReadiness(readiness, spec, 'refuse');
    process.exitCode = 1;
    return null;
  }
  reportReadiness(readiness, spec, mode === 'check' ? 'inform' : 'accepted');

  return { dir, spec, manifest, layers, validation, readiness };
}

/**
 * Los criterios del cierre que faltan. `refuse`: el build se niega. `accepted`: se genera
 * igualmente porque se pidió con --accept-unready, y queda estampado. `inform`: --check, que no
 * escribe y por tanto no tiene nada que negar.
 */
export function reportReadiness(readiness, spec, how) {
  if (readiness.ready) return;
  const missing = readiness.criteria.filter((entry) => !entry.ok);
  const refuse = how === 'refuse';
  const color = refuse ? pc.red : pc.yellow;
  const print = refuse ? console.error : console.warn;
  const headline = {
    refuse: `✘ Diseño no listo para generar — faltan ${missing.length} criterio(s) del cierre:`,
    accepted: `⚠ Diseño no listo para generar — faltan ${missing.length} criterio(s) del cierre; se genera igualmente (--accept-unready):`,
    inform: `⚠ Diseño no listo para generar — faltan ${missing.length} criterio(s) del cierre:`
  }[how];
  print();
  print(pc.bold(color(headline)));
  for (const entry of missing) {
    print(`  ${color('•')} ${entry.title} ${pc.dim(`[${entry.id}]`)}${entry.detail ? pc.dim(` — ${entry.detail}`) : ''}`);
  }
  const closing = {
    refuse:
      `  Cierra el diseño (detalle con keel validate --ready ${spec}), o genera a sabiendas con ` +
      `--accept-unready: quedará estampado en keel-generated.json.`,
    accepted:
      `  Queda estampado en keel-generated.json (design.acceptedUnready): lo que la generación reporte puede ser ` +
      `del diseño y no del método. Detalle con keel validate --ready ${spec}`,
    inform: `  Un build que escriba se negará salvo con --accept-unready. Detalle con keel validate --ready ${spec}`
  }[how];
  print(pc.dim(closing));
}
