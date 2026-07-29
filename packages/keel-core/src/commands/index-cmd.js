import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { isKeelWorkspace } from '../lib/assets.js';
import {
  INDEX_FILE,
  README_FILE,
  applyMarkers,
  buildIndex,
  canonicalJson,
  detectEol,
  indexContract,
  renderIndexJson,
  renderTable
} from '../lib/design-index.js';

/**
 * Genera (o verifica) el índice de diseños del workspace: la tabla del README
 * entre sus marcadores y el index.json que consumen los clientes del registry.
 */
export function writeIndex({ check = false } = {}) {
  const cwd = process.cwd();
  if (!isKeelWorkspace(cwd)) {
    console.error(pc.red('Este directorio no es un workspace Keel. Ejecuta primero: keel init'));
    process.exitCode = 1;
    return;
  }

  const index = buildIndex(cwd);
  const readmePath = path.join(cwd, README_FILE);
  const indexPath = path.join(cwd, INDEX_FILE);

  if (!fs.existsSync(readmePath)) {
    console.error(pc.red(`No existe ${README_FILE} en la raíz del workspace: no hay dónde escribir el índice.`));
    process.exitCode = 1;
    return;
  }

  const currentReadme = fs.readFileSync(readmePath, 'utf8');
  const { text: nextReadme, error } = applyMarkers(currentReadme, renderTable(index));
  if (error) {
    console.error(pc.red(error));
    process.exitCode = 1;
    return;
  }

  // Se respeta el fin de línea del index.json que ya está en disco: con
  // core.autocrlf, git lo deja en CRLF en Windows y reescribirlo en LF cada vez
  // dejaría `--check` en rojo permanente y el árbol sucio en cada ejecución.
  const currentJson = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : null;
  const nextJson = renderIndexJson(index, { eol: currentJson === null ? '\n' : detectEol(currentJson) });

  const readmeChanged = nextReadme !== currentReadme;
  const jsonChanged = nextJson !== currentJson;

  if (check) {
    // Se compara el **contrato**, no el archivo: un `generatedBy` de otra versión
    // de keel-core no es motivo para poner en rojo el CI de un registry.
    const outdated = [];
    if (readmeChanged) outdated.push(README_FILE);
    if (contractChanged(index, currentJson)) outdated.push(INDEX_FILE);

    reportWarnings(index.warnings);
    if (outdated.length === 0) {
      console.log(pc.green(`✔ El índice está al día (${plural(index.designs.length, 'diseño', 'diseños')}).`));
      if (index.warnings.length > 0) process.exitCode = 1;
      return;
    }
    console.error(
      pc.red(`✘ El índice quedó atrás: ${outdated.join(' y ')} ${outdated.length === 1 ? 'no coincide' : 'no coinciden'} con specs/.`)
    );
    console.error(pc.dim('  Regenéralo con `keel index` y añade el resultado al commit.'));
    process.exitCode = 1;
    return;
  }

  const written = [];
  if (readmeChanged) {
    fs.writeFileSync(readmePath, nextReadme);
    written.push(README_FILE);
  }
  if (jsonChanged) {
    fs.writeFileSync(indexPath, nextJson);
    written.push(INDEX_FILE);
  }

  for (const file of written) console.log(`  ${pc.green('~')} ${file}`);
  if (written.length === 0) console.log(pc.dim('  Sin cambios: el índice ya estaba al día.'));

  console.log();
  console.log(
    pc.bold(pc.green(`✔ Índice generado`)) +
      pc.dim(` — ${plural(index.designs.length, 'diseño', 'diseños')} en ${plural(index.families.length, 'familia', 'familias')}`)
  );
  for (const family of index.families) {
    if (family.designs.length === 1) continue;
    console.log(pc.dim(`  ${family.name}: ${family.designs.join(', ')}`));
  }

  reportWarnings(index.warnings);
  if (index.warnings.length > 0) process.exitCode = 1;
}

/**
 * ¿Cambió el contenido del índice respecto al que hay en disco, ignorando la
 * procedencia? Un index.json ausente o ilegible cuenta como cambiado.
 */
function contractChanged(index, currentJson) {
  if (currentJson === null) return true;
  let parsed;
  try {
    parsed = JSON.parse(currentJson);
  } catch {
    return true;
  }
  return canonicalJson(indexContract(parsed)) !== canonicalJson(indexContract(index));
}

function reportWarnings(warnings) {
  if (warnings.length === 0) return;
  console.log();
  console.error(pc.bold(pc.yellow(`${plural(warnings.length, 'aviso', 'avisos')} al indexar:`)));
  for (const warning of warnings) console.error(`  ${pc.yellow('⚠')} ${warning}`);
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
