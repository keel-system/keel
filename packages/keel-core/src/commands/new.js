import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { templatesDir, isKeelWorkspace } from '../lib/assets.js';
import { MANIFEST_FILE, KEBAB_NAME, resolveServiceRef, loadService } from '../lib/loader.js';
import { rewriteManifestForDerivation } from '../lib/derive.js';

const SEED_FILES = ['service.keel.yaml', 'domain.keel.yaml', 'use-cases.keel.yaml'];

export function createService(name, options = {}) {
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

// Deriva specs/<name> clonando un diseño existente: copia el manifiesto reescrito
// (nombre, versión 0.1.0, linaje basedOn, description pendiente) y las capas
// declaradas tal cual. validation-scenarios.md no se clona: se regenera al cerrar.
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

  console.log(pc.bold(pc.green(`✔ Servicio derivado: specs/${name}/ (a partir de ${basedOn})`)));
  for (const file of written) console.log(`  ${pc.dim('•')} specs/${name}/${file}`);
  console.log('\nPróximos pasos:');
  console.log(`  1. Ajusta el diseño con ${pc.cyan(`/keel-design specs/${name}`)} (arrancará en modo derivación: solo lo que cambia)`);
  console.log(`  2. Redacta la description del manifiesto (quedó marcada como pendiente de revisar)`);
  console.log(`  3. Valida con ${pc.cyan(`keel validate --wip specs/${name}`)}`);
}
