import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { HARNESSES } from 'keel-core';
import { build } from '../src/commands/build.js';
import { assetsDir, SUPPORTED_DSL } from '../src/lib/assets.js';

function makeWorkspace() {
  const dir = tmpDir('keel-spring-');
  // Marcador de workspace Keel (isKeelWorkspace)
  fs.mkdirSync(path.join(dir, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema', 'service.schema.json'), '{}');
  return dir;
}

function writeService(workspace, { keel = '2.0', persistenceModel = null, description = 'TODO: describir' } = {}) {
  const dir = path.join(workspace, 'specs', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'service.keel.yaml'),
    [
      `keel: "${keel}"`,
      'service:',
      '  name: demo',
      '  version: 0.1.0',
      `  description: ${JSON.stringify(description)}`,
      'layers:',
      '  domain: domain.keel.yaml',
      '  use-cases: use-cases.keel.yaml',
      ...(persistenceModel ? ['  persistence: persistence.keel.yaml'] : []),
      ''
    ].join('\n')
  );
  fs.writeFileSync(path.join(dir, 'domain.keel.yaml'), 'entities: {}\n');
  fs.writeFileSync(path.join(dir, 'use-cases.keel.yaml'), 'operations: {}\n');
  if (persistenceModel) {
    fs.writeFileSync(path.join(dir, 'persistence.keel.yaml'), `default:\n  model: ${persistenceModel}\n`);
  }
  return dir;
}

async function runBuild(workspace, inputPath, options) {
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const silenced = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  process.chdir(workspace);
  process.exitCode = undefined;
  try {
    await build(inputPath, options);
    return process.exitCode;
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    Object.assign(console, silenced);
  }
}

test('los assets del generador existen en el paquete', async () => {
  assert.ok(fs.existsSync(path.join(assetsDir, 'generators', 'spring', 'README.md')));
  // La skill del generador NO es un asset estático: la sintetiza generator-docs.js
  // en el proyecto generado, para que exista una sola definición del pipeline.
  assert.ok(
    !fs.existsSync(path.join(assetsDir, 'skills')),
    'los assets no deben traer skills de generación estáticas'
  );
  // Documentos de primer nivel que build copia a docs/keel/ del proyecto.
  for (const doc of ['architecture.md', 'constitution.md', 'orchestration.md']) {
    assert.ok(fs.existsSync(path.join(assetsDir, 'generators', 'spring', doc)), `falta generators/spring/${doc}`);
  }
  // Skills por tecnología del stack (build las instala condicionalmente en el
  // proyecto generado según keel-stack.json).
  assert.ok(fs.existsSync(path.join(assetsDir, 'generators', 'spring', 'skills', 'README.md')), 'falta skills/README.md');
  for (const tech of ['kafka', 'rabbitmq', 'snssqs', 's3', 'redis', 'keycloak', 'cognito', 'database', 'mongodb', 'httpclient']) {
    const skillDir = path.join(assetsDir, 'generators', 'spring', 'skills', `keel-spring-${tech}`);
    assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')), `falta skills/keel-spring-${tech}/SKILL.md`);
    // Progressive disclosure: cada skill trae al menos references/configuration.md.
    assert.ok(
      fs.existsSync(path.join(skillDir, 'references', 'configuration.md')),
      `falta skills/keel-spring-${tech}/references/configuration.md`
    );
  }
  // La skill de BD agrupa los seis dialectos del catálogo en references/dialects/.
  for (const dialect of ['postgresql', 'mysql', 'mariadb', 'sqlserver', 'oracle', 'h2']) {
    assert.ok(
      fs.existsSync(path.join(assetsDir, 'generators', 'spring', 'skills', 'keel-spring-database', 'references', 'dialects', `${dialect}.md`)),
      `falta dialects/${dialect}.md`
    );
  }
  const kafkaSkill = fs.readFileSync(
    path.join(assetsDir, 'generators', 'spring', 'skills', 'keel-spring-kafka', 'SKILL.md'),
    'utf8'
  );
  assert.ok(kafkaSkill.includes('name: keel-spring-kafka'));

  // Subagentes de la orquestación (fuente única y NEUTRAL: generator-docs los proyecta al
  // directorio de agentes de cada harness del proyecto generado).
  for (const agent of [
    'keel-spring-code.md',
    'keel-spring-infra.md',
    'keel-spring-tests.md',
    'keel-spring-validate.md',
    'keel-spring-quality.md'
  ]) {
    assert.ok(fs.existsSync(path.join(assetsDir, 'agents', agent)), `falta assets/agents/${agent}`);
  }
});

// El README del generador es su índice de contenido: si una pieza se añade a AGENTS o a
// CONVENTIONS (generator-docs.js) y nadie lo refleja ahí, queda instalada pero invisible.
// La comprobación se deriva del disco a propósito: mantener aquí otra lista sería repetir
// la omisión que este test existe para cazar.
test('el README del generador enumera todos los agentes y conventions instalados', () => {
  const generatorDir = path.join(assetsDir, 'generators', 'spring');
  const readme = fs.readFileSync(path.join(generatorDir, 'README.md'), 'utf8');

  const agents = fs.readdirSync(path.join(assetsDir, 'agents')).filter((f) => f.endsWith('.md'));
  assert.ok(agents.length >= 5);
  for (const agent of agents) {
    assert.ok(readme.includes(agent), `el README del generador no menciona el agente ${agent}`);
  }

  const conventions = fs.readdirSync(path.join(generatorDir, 'conventions')).filter((f) => f.endsWith('.md'));
  assert.ok(conventions.length >= 9);
  for (const convention of conventions) {
    assert.ok(readme.includes(`conventions/${convention}`), `el README del generador no menciona conventions/${convention}`);
  }
});

test('build rechaza una versión de DSL no soportada', async () => {
  const workspace = makeWorkspace();
  writeService(workspace, { keel: '9.0' });
  assert.ok(!SUPPORTED_DSL.includes('9.0'));

  const exitCode = await runBuild(workspace, 'specs/demo');
  assert.equal(exitCode, 1);
  assert.ok(!fs.existsSync(path.join(workspace, 'services')));
});

test('build rechaza un modelo de almacenamiento que no genera', async () => {
  // La frontera del generador se comprueba antes de generar nada y antes de
  // preguntar el stack. Se aísla de las otras puertas a propósito (versión de DSL
  // soportada y descripción real): si no, el exit 1 podría venir de cualquiera de
  // ellas y el test pasaría sin comprobar la frontera.
  const workspace = makeWorkspace();
  writeService(workspace, {
    keel: SUPPORTED_DSL[0],
    persistenceModel: 'key-value',
    description: 'Servicio de prueba de la frontera del generador.'
  });

  const exitCode = await runBuild(workspace, 'specs/demo');
  assert.equal(exitCode, 1);
  assert.ok(!fs.existsSync(path.join(workspace, 'services')));
});

test('build acepta el modelo documental y el diseño elige el motor', async () => {
  // El reverso del test anterior, y la razón de que exista: `document` sí se genera
  // (Spring Data MongoDB), así que ese gate no puede endurecerse por error sin que
  // alguien se entere. Va sobre la fixture real y no sobre un esqueleto porque el
  // build tiene una puerta anterior —la capa 0 de artefactos en plantilla— que un
  // diseño mínimo no pasa nunca.
  const workspace = makeWorkspace();
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'inspection-reports');
  const specDir = path.join(workspace, 'specs', 'inspection-reports');
  fs.mkdirSync(specDir, { recursive: true });
  fs.cpSync(fixture, specDir, { recursive: true });

  const exitCode = await runBuild(workspace, 'specs/inspection-reports');
  assert.equal(exitCode, undefined);

  const outDir = path.join(workspace, 'services', 'inspection-reports-spring');
  // El modelo lo declara el diseño y el cuestionario solo ofrece motores de ese
  // modelo: sin elegir nada, `document` solo puede caer en mongodb.
  const stack = JSON.parse(fs.readFileSync(path.join(outDir, 'keel-stack.json'), 'utf8'));
  assert.equal(stack.database, 'mongodb');

  // Y se instala la skill de ESE motor, no la relacional.
  for (const harness of HARNESSES) {
    const mongo = harness.skillPath('keel-spring-mongodb', 'SKILL.md');
    assert.ok(fs.existsSync(path.join(outDir, ...mongo.split('/'))), `falta ${mongo}`);
    const relational = harness.skillPath('keel-spring-database', 'SKILL.md');
    assert.ok(!fs.existsSync(path.join(outDir, ...relational.split('/'))), `sobra ${relational}`);
  }
});

test('build falla la validación de un diseño en plantilla', async () => {
  const workspace = makeWorkspace();
  writeService(workspace);

  const exitCode = await runBuild(workspace, 'specs/demo');
  assert.equal(exitCode, 1); // diseño incompleto: no generable todavía
  assert.ok(!fs.existsSync(path.join(workspace, 'services')));
});

test('build con un diseño válido genera el scaffolding y sale con éxito', async () => {
  const workspace = makeWorkspace();
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'product-catalog');
  const specDir = path.join(workspace, 'specs', 'product-catalog');
  fs.mkdirSync(specDir, { recursive: true });
  fs.cpSync(fixture, specDir, { recursive: true });

  const exitCode = await runBuild(workspace, 'specs/product-catalog');
  assert.equal(exitCode, undefined); // éxito
  const outDir = path.join(workspace, 'services', 'product-catalog-spring');
  assert.ok(fs.existsSync(path.join(outDir, 'build.gradle')));
  assert.ok(fs.existsSync(path.join(outDir, 'gradlew')));
  assert.ok(fs.existsSync(path.join(outDir, 'src', 'main', 'java', 'com', 'commerce', 'productcatalog', 'domain', 'aggregate', 'Product.java')));

  // El cuestionario (sin TTY → defaults) queda persistido en keel-stack.json.
  const stackFile = path.join(outDir, 'keel-stack.json');
  assert.ok(fs.existsSync(stackFile));
  const stack = JSON.parse(fs.readFileSync(stackFile, 'utf8'));
  assert.equal(stack.database, 'postgresql');
  assert.equal(stack.broker, null); // la fixture no declara messaging

  // Segunda pasada: reutiliza el stack guardado (aunque se edite a mano).
  fs.writeFileSync(stackFile, JSON.stringify({ database: 'mysql', broker: null, auth: null, cache: null }, null, 2));
  await runBuild(workspace, 'specs/product-catalog');
  assert.equal(JSON.parse(fs.readFileSync(stackFile, 'utf8')).database, 'mysql');

  // Segunda pasada: el scaffolding no pisa lo existente.
  const marker = path.join(outDir, 'README.md');
  fs.writeFileSync(marker, 'editado');
  await runBuild(workspace, 'specs/product-catalog');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'editado');

  // Repo autosuficiente. Las docs de apoyo van a docs/keel/, en una sola copia
  // porque no cambian con la herramienta...
  for (const doc of ['architecture.md', 'constitution.md', 'orchestration.md', 'conventions/mapping.md']) {
    assert.ok(fs.existsSync(path.join(outDir, 'docs', 'keel', ...doc.split('/'))), `falta docs/keel/${doc}`);
  }
  // ...y lo que carga el harness, proyectado a la convención de cada uno.
  for (const harness of HARNESSES) {
    assert.ok(fs.existsSync(path.join(outDir, harness.contextFile)), `falta ${harness.contextFile}`);
    const skill = harness.skillPath('keel-generate-spring', 'SKILL.md');
    assert.ok(fs.existsSync(path.join(outDir, ...skill.split('/'))), `falta ${skill}`);
    const agent = harness.agentPath('keel-spring-code');
    assert.ok(fs.existsSync(path.join(outDir, ...agent.split('/'))), `falta ${agent}`);
  }
  assert.ok(fs.existsSync(path.join(outDir, 'specs', 'service.keel.yaml')));
  assert.ok(fs.existsSync(path.join(outDir, 'specs', 'domain.keel.yaml')));

  // Flujo normalizado: la generación se ejecuta DENTRO del proyecto, así que el
  // workspace de diseño no recibe ningún archivo del generador — de ningún harness.
  for (const harness of HARNESSES) {
    const dir = harness.tokens.skills.split('/')[0];
    assert.ok(!fs.existsSync(path.join(workspace, dir)), `build no debe sembrar ${dir}/ en el workspace`);
  }
  assert.ok(!fs.existsSync(path.join(workspace, 'generators')), 'build no debe sembrar generators/ en el workspace');

  // El snapshot de specs/ SIEMPRE se refresca (el canónico es el del workspace).
  const snapshotFile = path.join(outDir, 'specs', 'domain.keel.yaml');
  fs.writeFileSync(snapshotFile, 'desincronizado');
  await runBuild(workspace, 'specs/product-catalog');
  assert.notEqual(fs.readFileSync(snapshotFile, 'utf8'), 'desincronizado');
});

// Prepara un workspace con la fixture product-catalog lista para generar.
function withFixture(name = 'product-catalog') {
  const workspace = makeWorkspace();
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name);
  const specDir = path.join(workspace, 'specs', name);
  fs.mkdirSync(specDir, { recursive: true });
  fs.cpSync(fixture, specDir, { recursive: true });
  return workspace;
}

test('build copia a docs/ solo la documentación de /keel-docs y la enlaza en el README', async () => {
  const workspace = withFixture();
  const docsDir = path.join(workspace, 'docs', 'product-catalog');
  fs.mkdirSync(path.join(docsDir, 'postman'), { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'openapi.yaml'), 'openapi: 3.1.0\n');
  fs.writeFileSync(path.join(docsDir, 'openapi.html'), '<html>redoc</html>');
  fs.writeFileSync(path.join(docsDir, 'overview.html'), '<html>panel</html>');
  fs.writeFileSync(path.join(docsDir, 'postman', 'product-catalog-collection.json'), '{}');
  fs.writeFileSync(path.join(docsDir, 'postman', 'auth-collection.json'), '{}');
  // Del mismo directorio, pero de otras skills: no viajan al proyecto.
  fs.writeFileSync(path.join(docsDir, 'DESIGN.md'), '# diseño');
  fs.writeFileSync(path.join(docsDir, 'INTEGRATION.md'), '# integración');

  const exitCode = await runBuild(workspace, 'specs/product-catalog');
  assert.equal(exitCode, undefined);

  const outDocs = path.join(workspace, 'services', 'product-catalog-spring', 'docs');
  for (const file of ['openapi.yaml', 'openapi.html', 'overview.html', 'postman/product-catalog-collection.json', 'postman/auth-collection.json']) {
    assert.ok(fs.existsSync(path.join(outDocs, ...file.split('/'))), `falta docs/${file}`);
  }
  assert.ok(!fs.existsSync(path.join(outDocs, 'DESIGN.md')), 'DESIGN.md no es salida de /keel-docs');
  assert.ok(!fs.existsSync(path.join(outDocs, 'INTEGRATION.md')), 'INTEGRATION.md no es salida de /keel-docs');
  // La fixture no declara messaging: /keel-docs no generó asyncapi y no se inventa.
  assert.ok(!fs.existsSync(path.join(outDocs, 'asyncapi.yaml')));

  const readme = fs.readFileSync(path.join(workspace, 'services', 'product-catalog-spring', 'README.md'), 'utf8');
  assert.match(readme, /## Contratos y documentación/);
  assert.match(readme, /\(docs\/openapi\.yaml\)/);
  assert.match(readme, /\(docs\/postman\/auth-collection\.json\)/);
  assert.ok(!readme.includes('docs/asyncapi.yaml'), 'no debe enlazar contratos inexistentes');

  // El snapshot de docs/ SIEMPRE se refresca (el canónico es el del workspace).
  const copied = path.join(outDocs, 'openapi.yaml');
  fs.writeFileSync(copied, 'desincronizado');
  await runBuild(workspace, 'specs/product-catalog');
  assert.equal(fs.readFileSync(copied, 'utf8'), 'openapi: 3.1.0\n');
});

test('build sin docs/<servicio> avisa pero termina en verde y el README omite la sección', async () => {
  const workspace = withFixture();

  const exitCode = await runBuild(workspace, 'specs/product-catalog');
  assert.equal(exitCode, undefined);

  const outDir = path.join(workspace, 'services', 'product-catalog-spring');
  // `docs/` existe siempre (ahí viven las conventions del generador), pero sin
  // haber pasado por /keel-docs no trae ningún contrato: solo docs/keel/.
  assert.deepEqual(fs.readdirSync(path.join(outDir, 'docs')), ['keel']);
  assert.ok(!fs.readFileSync(path.join(outDir, 'README.md'), 'utf8').includes('## Contratos y documentación'));
});

test('build es idempotente: la segunda pasada no reescribe el conocimiento del proyecto', async () => {
  const workspace = withFixture();
  await runBuild(workspace, 'specs/product-catalog');

  const skillPath = path.join(
    workspace, 'services', 'product-catalog-spring', '.claude', 'skills', 'keel-generate-spring', 'SKILL.md'
  );
  fs.writeFileSync(skillPath, 'modificado localmente');
  await runBuild(workspace, 'specs/product-catalog');
  assert.equal(fs.readFileSync(skillPath, 'utf8'), 'modificado localmente');

  await runBuild(workspace, 'specs/product-catalog', { force: true });
  assert.notEqual(fs.readFileSync(skillPath, 'utf8'), 'modificado localmente');
});
