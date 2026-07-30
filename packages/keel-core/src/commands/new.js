import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { templatesDir, isKeelWorkspace } from '../lib/assets.js';
import { MANIFEST_FILE, KEBAB_NAME, resolveServiceRef, loadService } from '../lib/loader.js';
import { rewriteManifestForDerivation, rewriteScenariosForDerivation } from '../lib/derive.js';
import { copyTree } from '../lib/copy.js';
import {
  downloadDesign,
  dslMismatchMessage,
  dslSupport,
  findDesign,
  loadRegistryIndex,
  parseRegistryRef
} from '../lib/registry-source.js';

const SEED_FILES = ['service.keel.yaml', 'domain.keel.yaml', 'use-cases.keel.yaml'];

// Único derivado que vive en el directorio del servicio (ver derivatives.js).
const SCENARIOS_FILE = 'validation-scenarios.md';

export async function createService(name, options = {}) {
  if (!KEBAB_NAME.test(name)) {
    console.error(pc.red(`Nombre inválido: '${name}'. Usa kebab-case (ej. product-catalog).`));
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  if (!isKeelWorkspace(cwd)) {
    console.error(pc.red('Este directorio no es un workspace Keel. Ejecuta primero: keel init'));
    process.exitCode = 1;
    return;
  }

  const serviceDir = path.join(cwd, 'specs', name);
  if (fs.existsSync(serviceDir)) {
    console.error(pc.red(`Ya existe specs/${name}. Elige otro nombre o edita el servicio existente.`));
    process.exitCode = 1;
    return;
  }

  if (options.from) {
    const remote = parseRegistryRef(options.from);
    if (remote) {
      await deriveFromRegistry(name, remote, { cwd, serviceDir, options });
      return;
    }
    deriveService(name, options.from, { cwd, serviceDir });
    return;
  }

  fs.mkdirSync(serviceDir, { recursive: true });
  for (const file of SEED_FILES) {
    const content = fs.readFileSync(path.join(templatesDir, file), 'utf8').replaceAll('{{name}}', name);
    fs.writeFileSync(path.join(serviceDir, file), content);
  }

  console.log(pc.bold(pc.green(`✔ Servicio creado: specs/${name}/`)));
  for (const file of SEED_FILES) console.log(`  ${pc.dim('•')} specs/${name}/${file}`);
  console.log('\nPróximos pasos:');
  console.log(`  1. Diseña las capas con ${pc.cyan(`/keel-design specs/${name}`)} (Claude Code)`);
  console.log(`  2. Las capas opcionales (api, security, messaging...) se añaden al manifiesto cuando apliquen`);
  console.log(`     — plantillas en ${pc.cyan('templates/service/')}`);
  console.log(`  3. Valida con ${pc.cyan(`keel validate specs/${name}`)}`);
}

/**
 * Deriva de un diseño del registry (`--from registry:<slug>`): descarga sus
 * artefactos a un directorio temporal y sigue por el camino local, de modo que
 * el linaje `basedOn` y el resto de la derivación son exactamente los mismos.
 */
async function deriveFromRegistry(name, remote, { cwd, serviceDir, options }) {
  if (remote.error) {
    console.error(pc.red(remote.error));
    process.exitCode = 1;
    return;
  }

  // Materializar un diseño no es hojear el catálogo: el índice es **un** archivo
  // y revalidarlo cuesta un 304 (loadRegistryIndex ya manda el ETag), mientras
  // que derivar de un índice de ayer produce un workspace incompleto en silencio
  // — los derivados que ese índice aún no listaba no se descargan ni avisan. El
  // TTL de 24 h se queda para `keel registry list/search/show`, que sí es
  // navegación. Con --offline manda el usuario, y si la red falla ya se degrada
  // a la caché con un aviso.
  const loaded = await loadRegistryIndex({ ...options, refresh: options.offline ? false : true });
  if (loaded.error) {
    console.error(pc.red(loaded.error));
    process.exitCode = 1;
    return;
  }
  for (const warning of loaded.warnings) console.error(`${pc.yellow('⚠')} ${warning}`);

  const { design, error } = findDesign(loaded.index, remote.slug);
  if (error) {
    console.error(pc.red(error));
    process.exitCode = 1;
    return;
  }

  // Gate de compatibilidad **antes** de descargar: un diseño escrito con un DSL
  // que esta CLI no conoce produce un workspace que `keel validate` rechaza, así
  // que dejarlo a medias es peor que no traerlo.
  if (dslSupport(design) === 'nueva') {
    console.error(pc.red(`✘ ${dslMismatchMessage(design)}`));
    process.exitCode = 1;
    return;
  }

  console.log(
    pc.dim(`Descargando ${design.slug} v${design.service?.version ?? '?'} de ${loaded.url} (índice: ${loaded.from})…`)
  );
  const downloaded = await downloadDesign(design, { indexUrl: loaded.url, docs: options.docs !== false });
  if (downloaded.error) {
    console.error(pc.red(downloaded.error));
    process.exitCode = 1;
    return;
  }
  for (const warning of downloaded.warnings ?? []) console.error(`${pc.yellow('⚠')} ${warning}`);

  try {
    // El mensaje de éxito ya identifica el origen por su linaje (`<slug>@<versión>`).
    deriveService(name, downloaded.dir, { cwd, serviceDir });
    if (process.exitCode !== 1 && options.docs !== false) {
      writeOriginDocs(name, downloaded, { cwd, design, indexUrl: loaded.url });
    }
  } finally {
    fs.rmSync(downloaded.root, { recursive: true, force: true });
  }
}

/**
 * Deja los derivados del origen en `docs/<nuevo>/origin/` como material de
 * referencia. **No** van a `docs/<nuevo>/` porque ahí serían los derivados del
 * servicio nuevo: llevan estampada la versión del origen y `keel describe` los
 * reportaría `stale` desde el primer día. `listDerivatives()` trabaja con una
 * allowlist de rutas, así que la subcarpeta le es invisible.
 */
function writeOriginDocs(name, downloaded, { cwd, design, indexUrl }) {
  if ((downloaded.docsFiles ?? []).length === 0) {
    console.error(`\n${pc.yellow('⚠')} El índice del registry no publica ningún derivado de '${design.slug}'.`);
    console.error(`  ${pc.dim(`No hay docs/${name}/origin/: derivas del spec a ciegas, sin el porqué del diseño.`)}`);
    console.error(`  ${pc.dim('Pide al mantenedor del registry que genere los derivados y reindexe con `keel index`.')}`);
    return;
  }

  const originDir = path.join(cwd, 'docs', name, 'origin');
  fs.mkdirSync(originDir, { recursive: true });
  const { copied } = copyTree(downloaded.docsDir, originDir, { force: true });
  fs.writeFileSync(path.join(originDir, 'README.md'), originReadme({ design, indexUrl }));

  console.log(`\n${pc.bold(`Documentación del origen: docs/${name}/origin/`)} ${pc.dim('(referencia; no son derivados de este servicio)')}`);
  for (const file of [...copied].sort()) console.log(`  ${pc.dim('•')} docs/${name}/origin/${file}`);
  if (copied.includes('DESIGN.md')) {
    console.log(`  Empieza por ${pc.cyan(`docs/${name}/origin/DESIGN.md`)}: las decisiones del diseño y su porqué.`);
  }

  // El índice ya sabe cuántos derivados le faltaban al origen cuando se indexó.
  // Decirlo aquí es lo que separa «este diseño no tiene panel» de «el registry
  // está desactualizado», que sin este aviso se ven exactamente igual: un archivo
  // que no aparece.
  const missing = design.derivatives?.missing ?? 0;
  if (missing > 0) {
    const total = missing + (design.derivatives?.fresh ?? 0) + (design.derivatives?.stale ?? 0) + (design.derivatives?.unstamped ?? 0);
    console.error(
      `\n${pc.yellow('⚠')} El registry publica ${total - missing} de ${total} derivados de '${design.slug}': ${missing} no existía(n) al indexarlo.`
    );
    console.error(`  ${pc.dim('Pide al mantenedor del registry que los genere y reindexe con `keel index`.')}`);
  }
}

function originReadme({ design, indexUrl }) {
  const origin = `${design.service?.name ?? design.slug}@${design.service?.version ?? '?'}`;
  return [
    `# Documentación de origen — ${origin}`,
    '',
    `Derivados publicados del diseño \`${design.slug}\` del registry (\`${indexUrl}\`), descargados al`,
    'derivar este servicio. Son **material de referencia del origen**: explican por qué el diseño del que',
    'partes es como es, y no describen a este servicio.',
    '',
    '- **No se editan y no se regeneran.** Quedan congelados en la versión del origen.',
    '- Los derivados **propios** de este servicio se producen con `/keel-handoff` (DESIGN.md) y',
    '  `/keel-docs` (contratos formales y panel), y viven un nivel más arriba, en `docs/<servicio>/`.',
    '- Cuando ya no aporten, esta carpeta se borra: nada del método depende de ella.',
    ''
  ].join('\n');
}

// Deriva specs/<name> clonando un diseño existente: copia el manifiesto reescrito
// (nombre, versión 0.1.0, linaje basedOn, description pendiente), las capas
// declaradas tal cual y, si existe, validation-scenarios.md con su cabecera
// reapuntada al servicio nuevo. Los escenarios llegan con el sello del origen, o
// sea `stale`: el punto de partida está, y `keel describe` recuerda que hay que
// regenerarlos al cerrar el diseño derivado.
function deriveService(name, from, { cwd, serviceDir }) {
  const resolved = resolveServiceRef(from, cwd);
  if (resolved.error) {
    console.error(pc.red(resolved.error));
    process.exitCode = 1;
    return;
  }
  const originDir = resolved.dir;

  if (path.resolve(originDir) === path.resolve(serviceDir)) {
    console.error(pc.red('El servicio de origen y el nuevo son el mismo. Elige otro nombre.'));
    process.exitCode = 1;
    return;
  }

  const { manifest, files, errors } = loadService(originDir);
  if (errors.length > 0) {
    console.error(pc.red(`El diseño de origen no carga limpio; corrígelo antes de derivar:`));
    for (const error of errors) console.error(`  ${pc.dim('•')} ${error}`);
    process.exitCode = 1;
    return;
  }

  const originName = manifest?.service?.name;
  const originVersion = manifest?.service?.version;
  if (typeof originName !== 'string' || typeof originVersion !== 'string') {
    console.error(pc.red(`El manifiesto de origen no declara service.name y service.version — necesarios para el linaje basedOn.`));
    process.exitCode = 1;
    return;
  }

  const basedOn = `${originName}@${originVersion}`;
  const manifestText = fs.readFileSync(path.join(originDir, MANIFEST_FILE), 'utf8');

  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(path.join(serviceDir, MANIFEST_FILE), rewriteManifestForDerivation(manifestText, { name, basedOn }));
  const written = [MANIFEST_FILE];
  for (const layer of Object.keys(files)) {
    const fileName = `${layer}.keel.yaml`;
    fs.copyFileSync(files[layer], path.join(serviceDir, fileName));
    written.push(fileName);
  }

  const scenarios = path.join(originDir, SCENARIOS_FILE);
  const inherited = fs.existsSync(scenarios);
  if (inherited) {
    const text = fs.readFileSync(scenarios, 'utf8');
    fs.writeFileSync(path.join(serviceDir, SCENARIOS_FILE), rewriteScenariosForDerivation(text, { name }));
    written.push(SCENARIOS_FILE);
  }

  console.log(pc.bold(pc.green(`✔ Servicio derivado: specs/${name}/ (a partir de ${basedOn})`)));
  for (const file of written) {
    const note = file === SCENARIOS_FILE ? pc.dim(` (heredado de ${basedOn}: regenerarlo al cerrar)`) : '';
    console.log(`  ${pc.dim('•')} specs/${name}/${file}${note}`);
  }
  console.log('\nPróximos pasos:');
  console.log(`  1. Ajusta el diseño con ${pc.cyan(`/keel-design specs/${name}`)} (arrancará en modo derivación: solo lo que cambia)`);
  console.log(`  2. Redacta la description del manifiesto (quedó marcada como pendiente de revisar)`);
  console.log(`  3. Valida con ${pc.cyan(`keel validate --wip specs/${name}`)}`);
  if (inherited) {
    console.log(
      `  4. Regenera los escenarios al cerrar: los heredados llevan el sello de ${basedOn} y ${pc.cyan('keel describe')} los marca ${pc.yellow('stale')}`
    );
  }
}
