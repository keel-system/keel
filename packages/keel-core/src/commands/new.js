import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { templatesDir, isKeelWorkspace } from '../lib/assets.js';

const SEED_FILES = ['service.keel.yaml', 'domain.keel.yaml', 'use-cases.keel.yaml'];

export function createService(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
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
