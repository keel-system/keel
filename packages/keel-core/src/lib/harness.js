// Harnesses de agente soportados. Un harness es la herramienta que carga las
// skills y lanza los subagentes (Claude Code, opencode): cambia DÓNDE viven los
// artefactos y CÓMO se escribe su frontmatter, no qué dicen. De ahí la forma de
// este módulo: los assets son la fuente **neutral** (un SKILL.md, un agente, un
// texto de contexto) y cada descriptor sabe traducirlos a su convención.
//
// Se emiten TODOS los harnesses siempre: un workspace o un proyecto generado
// sirve para cualquiera de los dos sin decidir nada al sembrarlo. Como la fuente
// es única, no hay dos copias que puedan divergir — solo dos proyecciones.
//
// Añadir un tercer harness es añadir una entrada a HARNESSES.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/**
 * Tokens que la prosa de los assets usa en lugar de rutas literales:
 * `{{keel:skills}}/keel-design/SKILL.md`, `{{keel:agents}}/keel-spring-code.md`, `{{keel:context}}`.
 * Un literal `.claude/…` en un asset saldría mal en la proyección de opencode, así
 * que la ausencia de literales se comprueba en test (harness.test.js).
 *
 * Van con el prefijo `keel:` porque `{{…}}` a secas ya significa otra cosa dentro
 * del payload: las guías de colecciones Postman lo usan para *sus* variables
 * (`{{baseUrl}}`, `{{token_admin}}`), y sustituirlas aquí las rompería.
 */
const TOKEN = /\{\{keel:(\w+)\}\}/g;

export function applyTokens(text, tokens) {
  return text.replace(TOKEN, (match, name) => (name in tokens ? tokens[name] : match));
}

// Nombre de cada herramienta en Claude Code. La fuente neutral las escribe en
// minúscula (`read`, `bash`); opencode las usa así tal cual.
const CLAUDE_TOOL = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  webfetch: 'WebFetch'
};

// Herramientas que hay que denegar explícitamente en opencode cuando el agente no
// las declara: su `tools` es un mapa que se MEZCLA con los valores por defecto, así
// que omitir `write` no lo desactiva — al contrario que el `tools:` de Claude Code,
// que es la lista completa. Sin esto, un agente de solo lectura podría escribir.
const OPENCODE_DENYABLE = ['write', 'edit', 'patch', 'webfetch'];

const claude = {
  id: 'claude',
  label: 'Claude Code',
  contextFile: 'CLAUDE.md',
  skillPath: (name, rel) => `.claude/skills/${name}/${rel}`,
  agentPath: (name) => `.claude/agents/${name}.md`,
  // En Claude Code una skill ya es invocable con `/`: no hace falta un comando aparte.
  commandPath: null,
  tokens: {
    skills: '.claude/skills',
    agents: '.claude/agents',
    commands: '.claude/skills',
    context: 'CLAUDE.md'
  },

  skillFrontmatter(meta) {
    const out = { name: meta.name, description: meta.description };
    if (meta['argument-hint']) out['argument-hint'] = meta['argument-hint'];
    return out;
  },

  agentFrontmatter(meta) {
    return {
      name: meta.name,
      description: meta.description,
      // `tools` es la lista completa: lo que no está, no se puede usar. Que ningún
      // agente incluya Task/Agent es lo que los hace hojas de la orquestación.
      tools: (meta.tools ?? []).map((t) => CLAUDE_TOOL[t] ?? t).join(', '),
      model: 'inherit'
    };
  }
};

const opencode = {
  id: 'opencode',
  label: 'opencode',
  contextFile: 'AGENTS.md',
  skillPath: (name, rel) => `.opencode/skills/${name}/${rel}`,
  agentPath: (name) => `.opencode/agent/${name}.md`,
  // Las skills de opencode las invoca el modelo por su descripción; el `/` son los
  // comandos, que son archivos planos y no admiten references/. De ahí las dos
  // piezas: la skill lleva el contenido, el comando es el disparador del usuario.
  commandPath: (name) => `.opencode/command/${name}.md`,
  tokens: {
    skills: '.opencode/skills',
    agents: '.opencode/agent',
    commands: '.opencode/command',
    context: 'AGENTS.md'
  },

  skillFrontmatter(meta) {
    // `argument-hint` no es campo de opencode: vive en el comando, que es quien
    // recibe los argumentos del usuario.
    return { name: meta.name, description: meta.description };
  },

  agentFrontmatter(meta) {
    const granted = new Set(meta.tools ?? []);
    const tools = {};
    for (const tool of granted) tools[tool] = true;
    for (const tool of OPENCODE_DENYABLE) if (!granted.has(tool)) tools[tool] = false;

    const out = {
      // El nombre del agente en opencode sale del nombre de archivo.
      description: meta.description,
      mode: 'subagent',
      tools
    };
    // El candado de hoja: en opencode lanzar subagentes no es una herramienta que se
    // omita de una lista, es un permiso que hay que denegar.
    if (meta.spawns === false) out.permission = { task: { '*': 'deny' } };
    return out;
  },

  commandFrontmatter(meta) {
    return { description: meta.description };
  },

  commandBody(meta) {
    const hint = meta['argument-hint'] ? ` Argumentos esperados: \`${meta['argument-hint']}\`.` : '';
    return `Usa la skill \`${meta.name}\` y sigue sus instrucciones al pie de la letra.${hint}\n\nArgumentos recibidos: $ARGUMENTS\n`;
  }
};

export const HARNESSES = [claude, opencode];

export function harnessById(id) {
  const found = HARNESSES.find((h) => h.id === id);
  if (!found) throw new Error(`Harness desconocido: ${id}. Conocidos: ${HARNESSES.map((h) => h.id).join(', ')}.`);
  return found;
}

/** Nombres de los harnesses tal como se muestran al usuario: "Claude Code u opencode". */
export function harnessLabels() {
  const labels = HARNESSES.map((h) => h.label);
  return `${labels.slice(0, -1).join(', ')} u ${labels[labels.length - 1]}`;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parte un markdown con frontmatter YAML en { meta, body }. Sin frontmatter,
 * `meta` es null y `body` es el texto entero.
 */
export function splitFrontmatter(text) {
  const match = text.match(FRONTMATTER);
  if (!match) return { meta: null, body: text };
  return { meta: YAML.parse(match[1]) ?? {}, body: text.slice(match[0].length) };
}

function withFrontmatter(meta, body) {
  // lineWidth: 0 desactiva el plegado: una `description` larga plegada sigue
  // siendo YAML válido, pero el frontmatter se lee y se diffea a mano.
  const front = YAML.stringify(meta, { lineWidth: 0 }).trimEnd();
  return `---\n${front}\n---\n${body.startsWith('\n') ? '' : '\n'}${body}`;
}

/** Archivos de un directorio de skill, en POSIX y relativos a él. Node >=18 no tiene readdirSync recursivo. */
function skillEntries(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...skillEntries(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

// Los references/ pueden ser plantillas HTML: sustituir tokens ahí es inocuo
// (no llevan `{{…}}` propios) pero re-renderizar frontmatter no tendría sentido.
const MARKDOWN = /\.md$/;

/**
 * Proyecta una skill (directorio con SKILL.md + references/) sobre un harness.
 * El SKILL.md se re-escribe con el frontmatter del harness; el resto solo recibe
 * la sustitución de tokens. Con `commandPath`, añade además el stub de comando.
 */
function emitSkill(skillDir, harness, tokens, withCommand) {
  const name = path.basename(skillDir);
  const files = [];
  let meta = null;

  for (const rel of skillEntries(skillDir)) {
    const source = fs.readFileSync(path.join(skillDir, rel), 'utf8');
    if (rel === 'SKILL.md') {
      const split = splitFrontmatter(source);
      if (!split.meta) throw new Error(`${skillDir}/SKILL.md no tiene frontmatter.`);
      meta = split.meta;
      files.push({
        path: harness.skillPath(name, rel),
        content: applyTokens(withFrontmatter(harness.skillFrontmatter(meta), split.body), tokens)
      });
    } else {
      files.push({ path: harness.skillPath(name, rel), content: applyTokens(source, tokens) });
    }
  }

  if (withCommand && harness.commandPath && meta) {
    files.push({
      path: harness.commandPath(name),
      content: withFrontmatter(harness.commandFrontmatter(meta), harness.commandBody(meta))
    });
  }
  return files;
}

/** Proyecta un agente (un .md con frontmatter neutral) sobre un harness. */
function emitAgent(file, harness, tokens) {
  const name = path.basename(file, '.md');
  const { meta, body } = splitFrontmatter(fs.readFileSync(file, 'utf8'));
  if (!meta) throw new Error(`${file} no tiene frontmatter.`);
  return {
    path: harness.agentPath(name),
    content: applyTokens(withFrontmatter(harness.agentFrontmatter({ ...meta, name }), body), tokens)
  };
}

/**
 * Emite los artefactos de agente de todos los harnesses (o de los indicados).
 *
 * - `skills`: rutas a directorios de skill (SKILL.md + references/).
 * - `commands`: si esas skills se exponen además como comando `/` en los
 *   harnesses que los separan. Las del flujo de diseño sí (el usuario escribe
 *   `/keel-design`); las de tecnología no — son conocimiento que el agente
 *   consulta cuando toca el broker, no algo que nadie invoque a mano.
 * - `agents`: rutas a archivos .md de subagente con frontmatter neutral.
 * - `context`: `{ content, shared }` del texto de contexto del repo.
 *   Con `shared: true` el texto no cita rutas de harness y se emite **una sola
 *   vez** (AGENTS.md) más un import de una línea por cada otro harness: así el
 *   equipo edita un único archivo, que es lo que pide un payload personalizable.
 *   Con `shared: false` el texto sí cita rutas y se proyecta entero por harness.
 * - `extraTokens`: tokens adicionales del llamante (p. ej. `docs`), iguales en
 *   todos los harnesses.
 *
 * Devuelve `[{ path, content }]` en rutas POSIX relativas a la raíz de destino:
 * el mismo contrato que consumen `writeFiles()` y `diffGenerated()`.
 */
export function emitHarnessFiles({
  skills = [],
  agents = [],
  context = null,
  commands = true,
  extraTokens = {},
  harnesses = HARNESSES
} = {}) {
  const files = [];

  for (const harness of harnesses) {
    const tokens = { ...harness.tokens, ...extraTokens };
    for (const skillDir of skills) files.push(...emitSkill(skillDir, harness, tokens, commands));
    for (const agentFile of agents) files.push(emitAgent(agentFile, harness, tokens));
  }

  if (context) files.push(...emitContext(context, harnesses, extraTokens));
  return files;
}

/**
 * Cada harness busca el contexto del repo con otro nombre (CLAUDE.md, AGENTS.md).
 *
 * Un contexto `shared` no cita ninguna ruta de harness, así que puede ser un solo
 * archivo —AGENTS.md, el nombre que más herramientas entienden— más un import de
 * una línea que Claude Code resuelve con `@`. Es lo que necesita el workspace de
 * diseño: su CLAUDE.md es payload personalizable y duplicarlo sería pedirle al
 * equipo que edite lo mismo dos veces.
 *
 * Un contexto no compartido sí cita rutas (las skills por tecnología del proyecto
 * generado, p. ej.) y se proyecta entero por harness. Ahí duplicar no cuesta nada:
 * lo regenera `build` en cada ejecución, nadie lo edita a mano.
 */
function emitContext({ content = null, shared = false, canonical = 'AGENTS.md' }, harnesses, extraTokens) {
  if (content !== null && !shared) {
    return harnesses.map((harness) => ({
      path: harness.contextFile,
      content: applyTokens(content, { ...harness.tokens, ...extraTokens })
    }));
  }

  const files = [];
  if (content !== null) {
    const resolved = applyTokens(content, extraTokens);
    const leftover = resolved.match(TOKEN);
    if (leftover) {
      throw new Error(
        `El contexto compartido cita rutas de harness (${[...new Set(leftover)].join(', ')}): ` +
          'o se reescribe sin ellas, o se emite con shared: false.'
      );
    }
    files.push({ path: canonical, content: resolved });
  }

  // Sin `content`, el canónico ya forma parte del payload copiado y aquí solo
  // faltan los alias: es el caso del workspace, cuyo AGENTS.md es una plantilla
  // que el equipo edita y que copyTree siembra tal cual.
  const seen = new Set([canonical]);
  for (const harness of harnesses) {
    if (seen.has(harness.contextFile)) continue;
    seen.add(harness.contextFile);
    files.push({ path: harness.contextFile, content: `@${canonical}\n` });
  }
  return files;
}
