import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import pc from 'picocolors';
import { MANIFEST_FILE, resolveServiceDir } from '../lib/loader.js';
import { validateService } from '../lib/validate-service.js';
import { DECISIONS_FILE } from '../lib/decisions.js';

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

  const { manifest, layers, loadErrors, schemaErrors, crossRefErrors, warnings, pending, obligations } =
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
  for (const message of warnings) console.warn(`${pc.yellow('⚠')} ${message}`);

  if (crossRefErrors.length > 0) {
    console.error(pc.bold(pc.red(`✘ Referencias cruzadas — ${crossRefErrors.length} error(es):`)));
    for (const message of crossRefErrors) console.error(`  ${pc.red('•')} ${message}`);
    process.exitCode = 1;
    return;
  }

  for (const entry of obligations.orphans) {
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

  const name = manifest?.service?.name ?? '(sin nombre)';
  const version = manifest?.service?.version ?? '?';
  const layerList = Object.keys(layers).join(', ');
  const aceptadas =
    obligations.accepted.length > 0
      ? pc.dim(` — ${obligations.accepted.length} decisión(es) aceptada(s) en ${DECISIONS_FILE}`)
      : '';
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
  console.log(pc.dim('Recuerda la capa semántica: /keel-validate en tu agente revisa la calidad del diseño.'));
}
