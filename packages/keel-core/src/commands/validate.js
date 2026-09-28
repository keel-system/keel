import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import pc from 'picocolors';
import { MANIFEST_FILE, resolveServiceDir } from '../lib/loader.js';
import { validateService } from '../lib/validate-service.js';
import { REVIEW_FILE, GAPS_FILE } from '../lib/spec-files.js';
import { DECISIONS_FILE, classifyWarnings } from '../lib/decisions.js';
import { READINESS_CRITERIA, assessReadiness } from '../lib/readiness.js';

function printSchemaErrors(file, ajvErrors) {
  console.error(pc.bold(pc.red(`✘ ${file}`)));
  for (const error of ajvErrors) {
    const where = error.instancePath || '(raíz)';
    const detail =
      error.params && Object.keys(error.params).length > 0 ? pc.dim(` ${JSON.stringify(error.params)}`) : '';
    console.error(`  ${pc.red('•')} ${pc.cyan(where)} ${error.message}${detail}`);
  }
}

function legacySpecMessage(specPath, doc) {
  if (typeof doc?.keel === 'string' && doc.keel.startsWith('1.')) {
    console.error(pc.bold(pc.red(`✘ ${path.basename(specPath)} usa el DSL keel ${doc.keel} (formato monolítico)`)));
    console.error('  Desde keel 2.0 el diseño se divide en artefactos por capa: specs/<servicio>/*.keel.yaml');
    console.error('  Crea el servicio con `keel new <servicio>` y reparte las secciones.');
    console.error(pc.dim('  Mapa de migración 1.0 → 2.0: docs/methodology.md'));
    return true;
  }
  return false;
}

export function validate(inputPath, options = {}) {
  const wip = options.wip === true;
  const ready = options.ready === true;

  // Son las dos puntas opuestas del mismo camino: --wip rebaja la exigencia a mitad de
  // diseño, --ready la sube hasta el cierre. Pedir las dos es no pedir ninguna.
  if (wip && ready) {
    console.error(pc.red('--wip y --ready son contradictorios: uno es diseño en progreso y el otro, diseño cerrado.'));
    process.exitCode = 1;
    return;
  }
  const resolvedInput = path.resolve(process.cwd(), inputPath);

  // Ruta a un *.keel.yaml suelto: puede ser un spec 1.0 antiguo — mensaje de migración.
  if (
    fs.existsSync(resolvedInput) &&
    fs.statSync(resolvedInput).isFile() &&
    path.basename(resolvedInput) !== MANIFEST_FILE
  ) {
    let doc;
    try {
      doc = YAML.parse(fs.readFileSync(resolvedInput, 'utf8'));
    } catch {
      doc = undefined;
    }
    if (legacySpecMessage(resolvedInput, doc)) {
      process.exitCode = 1;
      return;
    }
    console.error(pc.red(`Las capas no se validan sueltas: pasa el directorio del servicio o su ${MANIFEST_FILE}.`));
    process.exitCode = 1;
    return;
  }

  const { dir, error: resolveError } = resolveServiceDir(inputPath);
  if (resolveError) {
    console.error(pc.red(resolveError));
    process.exitCode = 1;
    return;
  }

  if (ready) {
    printReadiness(dir);
    return;
  }

  const { manifest, layers, loadErrors, schemaErrors, crossRefErrors, warnings, pending, obligations, undecided, reviews, gaps } =
    validateService(dir, { wip });

  if (loadErrors.length > 0 && !manifest) {
    for (const message of loadErrors) console.error(pc.red(`✘ ${message}`));
    process.exitCode = 1;
    return;
  }

  for (const { file, errors } of schemaErrors) printSchemaErrors(file, errors);
  for (const message of loadErrors) console.error(pc.red(`✘ ${message}`));

  if (!wip && pending.length > 0) {
    console.error(pc.bold(pc.red(`✘ Diseño incompleto — ${pending.length} pendiente(s):`)));
    for (const message of pending) console.error(`  ${pc.red('•')} ${message}`);
    console.error(pc.dim('  Durante el diseño puedes validar el progreso con: keel validate --wip'));
  }

  if (schemaErrors.length > 0 || loadErrors.length > 0 || (!wip && pending.length > 0)) {
    console.error(pc.dim('\nReferencia del DSL: docs/dsl-reference.md — schemas: schema/*.schema.json'));
    process.exitCode = 1;
    return;
  }

  for (const message of pending) console.warn(`${pc.yellow('⚠')} ${message}`);
  printWarnings(warnings, undecided);

  if (crossRefErrors.length > 0) {
    console.error(pc.bold(pc.red(`✘ Referencias cruzadas — ${crossRefErrors.length} error(es):`)));
    for (const message of crossRefErrors) console.error(`  ${pc.red('•')} ${message}`);
    process.exitCode = 1;
    return;
  }

  for (const entry of [...obligations.orphans, ...undecided.orphans]) {
    console.warn(
      `${pc.yellow('⚠')} ${DECISIONS_FILE}: '${entry.id}' sobre '${entry.scope}' ya no la levanta el diseño — ` +
        'la decisión describe un hueco que no existe; bórrala'
    );
  }

  // Las obligaciones se reportan DESPUÉS de las referencias cruzadas y antes del veredicto: no
  // son un error del diseño sino una decisión que nadie tomó, y listarlas junto a las referencias
  // rotas confundiría las dos cosas. Bloquean igual, y esa es justo la diferencia con el aviso
  // que este comando lleva imprimiendo bajo un «✔ Servicio válido».
  if (!wip) {
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
        pc.dim(
          `  Ciérralas en el diseño, o acéptalas por escrito en ${DECISIONS_FILE} con su motivo — ver docs/design-obligations.md`
        )
      );
    }
    if (obligations.errors.length > 0 || sinCerrar.length > 0) {
      process.exitCode = 1;
      return;
    }
  }

  // La revisión semántica. Mismo reparto tipográfico que las decisiones, y por el mismo
  // motivo: tampoco es un error del diseño, es lo que alguien miró y lo que no.
  if (!wip) {
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
    }
    if (reviews.errors.length > 0 || reviews.open.length > 0) {
      process.exitCode = 1;
      return;
    }
    // Lo que falta por revisar NO bloquea todavía, pero se dice en voz alta y con el
    // número delante: un diseño revisado a medias y uno revisado entero se escriben
    // igual, y esta línea es lo único que los distingue.
    if (reviews.missing.length > 0) {
      const total = reviews.missing.length + reviews.covered.length;
      console.warn(
        `${pc.yellow('⚠')} Revisión semántica incompleta: ${reviews.covered.length}/${total} ids con veredicto en ${REVIEW_FILE}. ` +
          `Ejecuta /keel-validate para recorrer los ${reviews.missing.length} que faltan`
      );
      for (const item of reviews.missing.slice(0, 5)) {
        console.warn(pc.dim(`    ${item.id} — ${item.title}`));
      }
      if (reviews.missing.length > 5) console.warn(pc.dim(`    …y ${reviews.missing.length - 5} más`));
    }
    if (reviews.stale) {
      console.warn(
        `${pc.yellow('⚠')} ${REVIEW_FILE}: la revisión es de la v${reviews.reviewedAt} y el diseño va por ` +
          `v${manifest?.service?.version} — lo que se juzgó puede haber dejado de ser cierto; rehazla`
      );
    }
    for (const entry of reviews.orphans) {
      console.warn(
        `${pc.yellow('⚠')} ${REVIEW_FILE}: '${entry.id}' ya no aplica a este diseño — el veredicto describe una ` +
          'pregunta que este servicio no se hace; bórralo'
      );
    }
    // El análisis de huecos no bloquea: es un criterio de --ready. Sin gaps.yaml no se dice nada
    // aquí (--ready lo cuenta); con él, lo que esté mal escrito o caducado se dice ya, que es
    // cuando el diseñador lo tiene delante.
    if (gaps.reviewedAt || gaps.errors.length > 0) printGapProblems(gaps, manifest?.service?.version);
  }

  const name = manifest?.service?.name ?? '(sin nombre)';
  const version = manifest?.service?.version ?? '?';
  const layerList = Object.keys(layers).join(', ');
  const totalAceptadas = obligations.accepted.length + undecided.accepted.length;
  const aceptadas =
    totalAceptadas > 0 ? pc.dim(` — ${totalAceptadas} decisión(es) aceptada(s) en ${DECISIONS_FILE}`) : '';
  if (wip && pending.length > 0) {
    console.log(
      pc.bold(pc.yellow('✔ Diseño en progreso')) +
        pc.dim(` — ${name} v${version}: ${pending.length} pendiente(s) de diseño`)
    );
    console.log(pc.dim(`  Capas: ${layerList}`));
    const sinCerrar = obligations.open.length + obligations.stale.length;
    if (sinCerrar > 0) console.log(pc.dim(`  Decisiones de diseño sin cerrar: ${sinCerrar}`));
    console.log(pc.dim('  Antes de generar debe pasar en verde: keel validate (sin --wip).'));
    return;
  }
  console.log(
    pc.bold(pc.green('✔ Servicio válido')) + pc.dim(` — ${name} v${version} (DSL keel ${manifest?.keel})`) + aceptadas
  );
  console.log(pc.dim(`  Capas: ${layerList}`));
  const sinDecidir = undecided.open.length + undecided.stale.length;
  if (sinDecidir > 0) {
    console.log(
      pc.dim(`  ${sinDecidir} aviso(s) son decisiones sin tomar: no impiden generar, pero sí keel validate --ready.`)
    );
  }
  console.log(pc.dim('Recuerda la capa semántica: /keel-validate en tu agente revisa la calidad del diseño.'));
}

/**
 * Los avisos, separando los que son decisiones no tomadas.
 *
 * Una decisión ACEPTADA en decisions.yaml ya no se imprime como aviso: se contestó, y
 * repetirla en amarillo enseñaría a no leer los avisos. Una ABIERTA lleva debajo lo que hay
 * que escribir para cerrarla —su id y su scope, que es la clave de la aceptación— o, si no
 * admite aceptación, que se decide en el DSL. Sin eso, el scope que exige decisions.yaml
 * habría que adivinarlo.
 */
function printWarnings(warnings, undecided) {
  for (const { message, hint } of classifyWarnings(warnings, undecided).shown) {
    console.warn(`${pc.yellow('⚠')} ${message}`);
    if (hint) console.warn(pc.dim(`    ${hint}`));
  }
}

/**
 * `keel validate --ready`: la checklist del cierre, criterio a criterio y con el comando que
 * cierra cada uno. Es lo que permite retomar una sesión de diseño sin depender de la memoria
 * del agente, y la misma respuesta que `keel-<tech> build` estampa en el proyecto generado.
 */
function printReadiness(dir) {
  const validation = validateService(dir, { wip: false });
  const { service, ready, criteria } = assessReadiness(dir, { validation });
  if (!service) {
    for (const message of validation.loadErrors) console.error(pc.red(`✘ ${message}`));
    process.exitCode = 1;
    return;
  }

  console.log(pc.bold(`Diseño listo para generar — ${service.name} v${service.version}`));
  for (const entry of criteria) {
    if (entry.ok) {
      console.log(`  ${pc.green('✔')} ${entry.title} ${pc.dim(`[${entry.id}]`)}`);
      continue;
    }
    console.log(`  ${pc.red('✘')} ${entry.title} ${pc.dim(`[${entry.id}]`)}`);
    if (entry.detail) console.log(`      ${entry.detail}`);
    if (entry.fix) console.log(pc.dim(`      → ${entry.fix}`));
    if (entry.id === 'gaps') printGapInventory(validation.gaps);
    if (entry.id === 'structural') printStructuralPending(validation.structural);
  }

  console.log();
  const missing = criteria.filter((entry) => !entry.ok).length;
  if (ready) {
    console.log(pc.bold(pc.green('✔ Diseño listo para generar.')));
    return;
  }
  console.log(pc.bold(pc.red(`✘ ${missing} de ${READINESS_CRITERIA.length} criterio(s) sin cumplir.`)));
  process.exitCode = 1;
}

/**
 * Los problemas de un gaps.yaml que existe: formato, caducidad y hallazgos abiertos. Avisos, no
 * errores — el análisis de huecos cuenta en --ready, no en la puerta de build.
 */
function printGapProblems(gaps, version) {
  for (const message of gaps.errors) console.warn(`${pc.yellow('⚠')} ${message}`);
  if (gaps.stale) {
    console.warn(
      `${pc.yellow('⚠')} ${GAPS_FILE}: el análisis de huecos es de la v${gaps.reviewedAt} y el diseño va por ` +
        `v${version} — recorre lo que cambió y vuelve a sellarlo`
    );
  }
  if (gaps.open.length > 0) {
    console.warn(`${pc.yellow('⚠')} ${GAPS_FILE}: ${gaps.open.length} hallazgo(s) abierto(s) — el análisis no está cerrado`);
  }
  for (const entry of gaps.orphans) {
    console.warn(
      `${pc.yellow('⚠')} ${GAPS_FILE}: clase ${entry.class}: [${entry.units.join(', ')}] ya no existe en el diseño; bórralo`
    );
  }
}

/**
 * Lo que falta por recorrer, ENTERO: es el inventario con el que el agente retoma el barrido tras
 * un /clear, y recortarlo como la lista de la revisión lo dejaría a medias justo donde se usa.
 */
function printGapInventory(gaps) {
  const pending = new Map();
  for (const entry of gaps.missingClasses) pending.set(entry.class, { title: entry.title, units: [...entry.units] });
  for (const entry of gaps.missingUnits) {
    if (!pending.has(entry.class)) pending.set(entry.class, { title: entry.title, units: [] });
    pending.get(entry.class).units.push(entry.unit);
  }
  for (const [number, entry] of [...pending].sort(([a], [b]) => a - b)) {
    console.log(pc.dim(`        ${number}. ${entry.title}: ${entry.units.join(', ')}`));
  }
  for (const finding of gaps.open) {
    console.log(pc.dim(`        abierto — clase ${finding.class}, ${finding.unit}: ${finding.what}`));
  }
}

/**
 * Lo que falta del registro estructural, con el título de cada sección: es la lista con la que se
 * retoma tras un /clear sin reconstruir de memoria qué capas cerraron con su bloque y cuáles no.
 */
function printStructuralPending(structural) {
  for (const item of structural.missing) console.log(pc.dim(`        §${item.section} ${item.title}: sin registrar`));
  for (const entry of structural.stale) {
    console.log(pc.dim(`        §${entry.section}${entry.scope ? ` ${entry.scope}` : ''}: de la v${entry.since}, reafírmala`));
  }
  for (const message of structural.errors) console.log(pc.dim(`        ${message}`));
}
