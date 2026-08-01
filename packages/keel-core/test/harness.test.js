// Proyección de los assets neutrales a cada harness soportado. Lo que se fija
// aquí es que la fuente es única y que ninguna proyección sale a medias: un
// frontmatter que no parsea o un token sin sustituir son artefactos que el
// harness carga mal en silencio, y no hay ejecución que los delate.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { skillsSourceDir } from '../src/lib/assets.js';
import { HARNESSES, applyTokens, emitHarnessFiles, harnessById, splitFrontmatter } from '../src/lib/harness.js';
import { diffGenerated, writeFiles } from '../src/lib/write.js';

const skillDirs = fs
  .readdirSync(skillsSourceDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(skillsSourceDir, entry.name));

const skillNames = skillDirs.map((dir) => path.basename(dir));

function emitAll(overrides = {}) {
  return emitHarnessFiles({ skills: skillDirs, extraTokens: { docs: 'docs' }, ...overrides });
}

test('cada harness recibe todas las skills, en su propia convención', () => {
  const files = emitAll();

  for (const harness of HARNESSES) {
    for (const name of skillNames) {
      const expected = harness.skillPath(name, 'SKILL.md');
      assert.ok(
        files.some((file) => file.path === expected),
        `${harness.id}: falta ${expected}`
      );
    }
  }

  // Y las convenciones no se pisan entre sí.
  assert.equal(new Set(files.map((f) => f.path)).size, files.length, 'hay rutas duplicadas entre harnesses');
});

test('los references/ de una skill viajan con ella', () => {
  const files = emitAll();
  const design = harnessById('claude').skillPath('keel-design', 'references/structural-decisions.md');

  assert.ok(files.some((file) => file.path === design));
  // Y también en el otro harness: una skill sin sus references es una skill rota.
  assert.ok(files.some((file) => file.path === harnessById('opencode').skillPath('keel-design', 'references/structural-decisions.md')));
});

test('todo frontmatter emitido es YAML válido y trae las claves de su harness', () => {
  const files = emitAll();

  for (const harness of HARNESSES) {
    const skillFile = files.find((f) => f.path === harness.skillPath('keel-design', 'SKILL.md'));
    const { meta } = splitFrontmatter(skillFile.content);
    assert.ok(meta, `${harness.id}: SKILL.md sin frontmatter`);
    assert.equal(meta.name, 'keel-design');
    assert.ok(meta.description);
  }

  // Claude Code conserva el argument-hint; en opencode los argumentos son del comando.
  const claudeSkill = files.find((f) => f.path === harnessById('claude').skillPath('keel-design', 'SKILL.md'));
  assert.ok(splitFrontmatter(claudeSkill.content).meta['argument-hint']);
  const opencodeSkill = files.find((f) => f.path === harnessById('opencode').skillPath('keel-design', 'SKILL.md'));
  assert.equal(splitFrontmatter(opencodeSkill.content).meta['argument-hint'], undefined);
});

test('el frontmatter de los assets fuente parsea: si no, ningún harness lo carga', () => {
  for (const dir of skillDirs) {
    const source = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const raw = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(raw, `${path.basename(dir)}: SKILL.md sin frontmatter`);
    assert.doesNotThrow(() => YAML.parse(raw[1]), `${path.basename(dir)}: frontmatter no es YAML válido`);
  }
});

test('ningún archivo emitido conserva un token sin sustituir', () => {
  for (const file of emitAll()) {
    assert.equal(file.content.match(/\{\{keel:\w+\}\}/), null, `${file.path} conserva tokens sin sustituir`);
  }
});

test('los assets neutrales no citan rutas de harness: para eso están los tokens', () => {
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else out.push(full);
    }
    return out;
  };

  for (const file of walk(skillsSourceDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const harness of HARNESSES) {
      const dir = harness.tokens.skills.split('/')[0];
      assert.equal(text.includes(dir), false, `${path.relative(skillsSourceDir, file)} cita ${dir} en vez de un token`);
      // El archivo de contexto se llama distinto en cada harness, así que nombrarlo
      // en literal es la misma mentira que citar `.claude/`, y se cuela por debajo
      // de la comprobación de rutas porque no lleva barra. Va `{{keel:context}}`.
      assert.equal(
        text.includes(harness.contextFile),
        false,
        `${path.relative(skillsSourceDir, file)} nombra ${harness.contextFile} en vez de {{keel:context}}`
      );
    }
  }
});

test('un comando por skill, solo en los harnesses que separan comando y skill', () => {
  const withCommands = emitAll();
  const withoutCommands = emitAll({ commands: false });

  for (const harness of HARNESSES) {
    if (!harness.commandPath) continue;
    for (const name of skillNames) {
      const command = harness.commandPath(name);
      assert.ok(withCommands.some((f) => f.path === command), `falta el comando ${command}`);
      assert.ok(!withoutCommands.some((f) => f.path === command), `${command} no debería existir con commands: false`);
    }
  }

  // El stub invoca la skill por su nombre: es un disparador, no una copia del contenido.
  const stub = withCommands.find((f) => f.path === harnessById('opencode').commandPath('keel-design'));
  assert.match(stub.content, /keel-design/);
  assert.match(stub.content, /\$ARGUMENTS/);
});

test('un agente hoja no puede lanzar agentes en ningún harness', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-agent-'));
  const agent = path.join(dir, 'demo-agent.md');
  fs.writeFileSync(agent, '---\nname: demo-agent\ndescription: Demo.\ntools: [read, bash]\nspawns: false\n---\n\nCuerpo.\n');

  const files = emitHarnessFiles({ agents: [agent] });

  const claude = files.find((f) => f.path === harnessById('claude').agentPath('demo-agent'));
  const claudeMeta = splitFrontmatter(claude.content).meta;
  // En Claude Code `tools` es la lista completa: lo que no está, no existe.
  assert.equal(claudeMeta.tools, 'Read, Bash');
  assert.equal(claudeMeta.model, 'inherit');

  const opencode = files.find((f) => f.path === harnessById('opencode').agentPath('demo-agent'));
  const opencodeMeta = splitFrontmatter(opencode.content).meta;
  assert.equal(opencodeMeta.mode, 'subagent');
  assert.equal(opencodeMeta.tools.read, true);
  assert.equal(opencodeMeta.tools.bash, true);
  // Su `tools` se MEZCLA con los defaults, así que lo no concedido hay que negarlo.
  assert.equal(opencodeMeta.tools.write, false);
  assert.equal(opencodeMeta.tools.edit, false);
  // Y lanzar agentes no es una herramienta que se omita, sino un permiso que se deniega.
  assert.equal(opencodeMeta.permission.task['*'], 'deny');

  // El cuerpo es el mismo: la fuente es única.
  assert.equal(splitFrontmatter(claude.content).body, splitFrontmatter(opencode.content).body);
});

test('el contexto compartido se emite una vez, y los demás harnesses lo importan', () => {
  const files = emitHarnessFiles({ context: { content: '# Reglas\n', shared: true } });

  const canonical = files.find((f) => f.path === 'AGENTS.md');
  assert.equal(canonical.content, '# Reglas\n');
  assert.equal(files.find((f) => f.path === 'CLAUDE.md').content, '@AGENTS.md\n');
});

test('un contexto compartido que cita rutas de harness no se emite: mentiría a la mitad', () => {
  assert.throws(
    () => emitHarnessFiles({ context: { content: 'Lee {{keel:skills}}/keel-design/SKILL.md\n', shared: true } }),
    /cita rutas de harness/
  );
});

test('un contexto no compartido se proyecta entero por harness, con sus rutas resueltas', () => {
  const files = emitHarnessFiles({ context: { content: 'Agentes en {{keel:agents}}/.\n' } });

  assert.equal(files.length, HARNESSES.length);
  for (const harness of HARNESSES) {
    const file = files.find((f) => f.path === harness.contextFile);
    assert.equal(file.content, `Agentes en ${harness.tokens.agents}/.\n`);
  }
});

test('applyTokens deja intacto lo que no conoce: un token nuevo no se traga en silencio', () => {
  assert.equal(applyTokens('a {{keel:skills}} b {{keel:desconocido}}', { skills: 'X' }), 'a X b {{keel:desconocido}}');
});

test('la proyección es determinista: emitir dos veces da lo mismo', () => {
  assert.deepEqual(emitAll(), emitAll());
});

test('writeFiles y diffGenerated cierran el ciclo: lo escrito no tiene deriva', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-emit-'));
  const files = emitAll();
  writeFiles(files, dir);

  assert.deepEqual(diffGenerated(files, dir), { stale: [], missing: [] });

  // Y un archivo editado a mano sí se reporta.
  const target = path.join(dir, harnessById('opencode').skillPath('keel-validate', 'SKILL.md'));
  fs.writeFileSync(target, `${fs.readFileSync(target, 'utf8')}\n`);
  assert.deepEqual(diffGenerated(files, dir).stale, [harnessById('opencode').skillPath('keel-validate', 'SKILL.md')]);
});

test('writeFiles respeta lo existente sin force, y preserve ni con force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-write-'));
  writeFiles([{ path: 'a.md', content: 'uno' }], dir);
  fs.writeFileSync(path.join(dir, 'a.md'), 'editado');

  const sinForce = writeFiles([{ path: 'a.md', content: 'dos' }], dir);
  assert.deepEqual(sinForce.skipped, ['a.md']);
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'editado');

  const conPreserve = writeFiles([{ path: 'a.md', content: 'dos' }], dir, { force: true, preserve: ['a.md'] });
  assert.deepEqual(conPreserve.preserved, ['a.md']);
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'editado');

  writeFiles([{ path: 'a.md', content: 'dos' }], dir, { force: true });
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'dos');
});
