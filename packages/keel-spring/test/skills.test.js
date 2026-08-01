// Coherencia de las skills por tecnología (estilo crossrefs): toda ruta
// references/*.md citada en un SKILL.md existe en disco, y ningún reference
// queda sin enlazar desde su SKILL.md (huérfano). Más la topología de la
// orquestación: los agentes son hojas, y su frontmatter es lo que lo garantiza.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HARNESSES, emitHarnessFiles, splitFrontmatter } from 'keel-core';
import { assetsDir } from '../src/lib/assets.js';
import { AGENTS } from '../src/scaffold/generator-docs.js';

const skillsDir = path.join(assetsDir, 'generators', 'spring', 'skills');

// Nombres con los que el harness expone la capacidad de lanzar agentes.
const SPAWNING_TOOLS = ['Agent', 'Task'];

function walkFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

test('skills por tecnología: references citados existen y ninguno queda huérfano', () => {
  const skillNames = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(skillNames.length >= 8);

  for (const name of skillNames) {
    const skillDir = path.join(skillsDir, name);
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');

    // Citas references/... del SKILL.md → el archivo existe.
    const cited = new Set([...skillMd.matchAll(/references\/[\w.<>/-]+\.md/g)].map((m) => m[0]));
    assert.ok(cited.size > 0, `${name}: el SKILL.md no cita ningún reference`);
    for (const ref of cited) {
      // Las citas con placeholder (dialects/<database>.md) se comprueban por directorio.
      if (ref.includes('<')) {
        const dir = path.join(skillDir, path.dirname(ref));
        assert.ok(fs.existsSync(dir), `${name}: cita ${ref} pero no existe ${path.dirname(ref)}/`);
        continue;
      }
      assert.ok(fs.existsSync(path.join(skillDir, ref)), `${name}: cita ${ref} pero no existe`);
    }

    // Todo reference en disco está enlazado desde el SKILL.md (por ruta exacta
    // o, para dialects/, por el placeholder del directorio).
    const onDisk = walkFiles(path.join(skillDir, 'references'), 'references');
    for (const ref of onDisk) {
      const dirCited = [...cited].some((c) => c.includes('<') && path.dirname(c) === path.dirname(ref));
      assert.ok(cited.has(ref) || dirCited, `${name}: ${ref} no está enlazado desde el SKILL.md`);
    }
  }
});

test('agentes de la orquestación: son hojas, no pueden lanzar subagentes', () => {
  // La propiedad se comprueba dos veces, y hacen falta las dos: en la fuente
  // neutral (que nadie olvide declararla) y en cada proyección (que el descriptor
  // del harness la traduzca de verdad a su mecanismo, que no es el mismo).
  const agentsDir = path.join(assetsDir, 'agents');
  const agents = fs.readdirSync(agentsDir).filter((name) => name.endsWith('.md'));
  assert.equal(agents.length, AGENTS.length, 'la lista AGENTS de generator-docs.js y assets/agents/ divergen');

  for (const file of agents) {
    assert.ok(AGENTS.includes(file), `${file} no está en la lista AGENTS de generator-docs.js: no se instalaría`);
    const content = fs.readFileSync(path.join(agentsDir, file), 'utf8');
    const { meta } = splitFrontmatter(content);

    // Sin `tools:` el agente hereda el juego completo, incluida la herramienta de
    // lanzar subagentes: es lo que permitía que un agente se invocase a sí mismo,
    // fuera del conteo de ciclos y del gating del orquestador.
    assert.ok(Array.isArray(meta.tools), `${file}: sin \`tools:\` hereda todas las herramientas`);
    assert.equal(meta.spawns, false, `${file}: debe declarar \`spawns: false\`; el único orquestador es la skill`);
    // El porqué, escrito donde se lee (orchestration.md § Los cinco agentes).
    assert.ok(content.includes('No lanzas subagentes'), `${file}: falta la regla explícita de agente hoja`);
  }

  // Y ahora la traducción: cada harness cierra la puerta a su manera.
  const emitted = emitHarnessFiles({ agents: agents.map((file) => path.join(agentsDir, file)) });

  for (const harness of HARNESSES) {
    for (const file of agents) {
      const name = path.basename(file, '.md');
      const projected = emitted.find((entry) => entry.path === harness.agentPath(name));
      assert.ok(projected, `${harness.id}: falta la proyección de ${name}`);
      const meta = splitFrontmatter(projected.content).meta;

      if (typeof meta.tools === 'string') {
        // Claude Code: `tools` es la lista completa, así que basta con no nombrarlas.
        for (const tool of meta.tools.split(',').map((t) => t.trim())) {
          assert.ok(!SPAWNING_TOOLS.includes(tool), `${harness.id}/${name}: declara ${tool}`);
        }
      } else {
        // opencode: `tools` se mezcla con los defaults, así que omitir no basta —
        // lanzar agentes es un permiso, y tiene que estar denegado explícitamente.
        for (const tool of SPAWNING_TOOLS) {
          assert.notEqual(meta.tools?.[tool.toLowerCase()], true, `${harness.id}/${name}: concede ${tool}`);
        }
        assert.equal(
          meta.permission?.task?.['*'],
          'deny',
          `${harness.id}/${name}: sin denegar el permiso task, hereda la capacidad de lanzar agentes`
        );
      }
    }
  }
});

test('skills por tecnología: frontmatter con name coherente y tabla de referencias', () => {
  const skillNames = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const name of skillNames) {
    const skillMd = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.ok(skillMd.includes(`name: ${name}`), `${name}: frontmatter name incoherente`);
    assert.ok(skillMd.includes('## Referencias'), `${name}: falta la sección ## Referencias`);
    assert.ok(skillMd.includes('## Validación'), `${name}: falta la sección ## Validación`);
  }
});
