// Coherencia de las skills por tecnología (estilo crossrefs): toda ruta
// references/*.md citada en un SKILL.md existe en disco, y ningún reference
// queda sin enlazar desde su SKILL.md (huérfano). Más la topología de la
// orquestación: los agentes son hojas, y su frontmatter es lo que lo garantiza.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  const agentsDir = path.join(assetsDir, '.claude', 'agents');
  const agents = fs.readdirSync(agentsDir).filter((name) => name.endsWith('.md'));
  assert.equal(agents.length, AGENTS.length, 'la lista AGENTS de generator-docs.js y assets/.claude/agents/ divergen');

  for (const file of agents) {
    assert.ok(AGENTS.includes(file), `${file} no está en la lista AGENTS de generator-docs.js: no se instalaría`);
    const content = fs.readFileSync(path.join(agentsDir, file), 'utf8');
    const frontmatter = content.split('---')[1] ?? '';
    const tools = /^tools:\s*(.+)$/m.exec(frontmatter);

    // Sin `tools:` el agente hereda el juego completo, incluida la herramienta de
    // lanzar subagentes: es lo que permitía que un agente se invocase a sí mismo,
    // fuera del conteo de ciclos y del gating del orquestador.
    assert.ok(tools, `${file}: sin \`tools:\` hereda todas las herramientas, incluida la de lanzar agentes`);
    const declared = tools[1].split(',').map((name) => name.trim());
    for (const name of declared) {
      assert.ok(
        !SPAWNING_TOOLS.includes(name),
        `${file}: declara ${name}; el único orquestador es la skill, los agentes son hojas`
      );
    }
    // El porqué, escrito donde se lee (orchestration.md § Los cinco agentes).
    assert.ok(content.includes('No lanzas subagentes'), `${file}: falta la regla explícita de agente hoja`);
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
