// Rasgos de lo que emite build para el diseño que keel-go genera hoy: el módulo, la configuración igual que la de
// los otros tres, el arranque con la configuración validada antes de nada, la cabecera de código generado y las docs
// sin rutas de harness. Lo que solo se ve compilando lo mide `npm run go-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { GENERATED_HEADER } from '../src/lib/go-source.js';
import { GO_MIN_VERSION, GO_TOOLCHAIN } from '../src/lib/assets.js';
import { MODULES } from '../src/lib/go-stack.js';
import { makeWorkspace, mountDesign, GO_READY_DESIGN } from './helpers/workspace.js';

const workspace = makeWorkspace();
const dir = mountDesign(workspace, GO_READY_DESIGN.name, GO_READY_DESIGN);
const { manifest, layers } = loadService(dir);
const { files } = planService({ manifest, layers, workspace });
const byPath = new Map(files.map((file) => [file.path, file.content]));

test('go.mod: módulo, versión mínima, toolchain, requisitos directos exactos y herramientas', () => {
  const goMod = byPath.get('go.mod');
  assert.match(goMod, /^module product-catalog$/m);
  assert.match(goMod, new RegExp(`^go ${GO_MIN_VERSION.replaceAll('.', '\\.')}$`, 'm'));
  assert.match(goMod, new RegExp(`^toolchain ${GO_TOOLCHAIN.replaceAll('.', '\\.')}$`, 'm'));
  assert.match(goMod, /^\tgo\.yaml\.in\/yaml\/v3 v3\.0\.5$/m);
  assert.match(goMod, /^\tgolang\.org\/x\/sync v0\.24\.0$/m);
  // Una herramienta va también en require, fijada: si no, tidy la resolvería a la última versión publicada.
  for (const [path, module] of Object.entries(MODULES).filter(([, m]) => m.kind === 'tool')) {
    assert.match(goMod, new RegExp(`^\\t${path.replaceAll('.', '\\.')} ${module.version.replaceAll('.', '\\.')} // indirect$`, 'm'), path);
    assert.match(goMod, new RegExp(`^\\t${module.tool.replaceAll('.', '\\.')}$`, 'm'), module.tool);
  }
  assert.doesNotMatch(goMod, /golangci/);
});

test('todo .go que escribe build lleva la cabecera de código generado y empieza por ella', () => {
  for (const [path, content] of byPath) {
    if (path.endsWith('.go')) assert.ok(content.startsWith(`${GENERATED_HEADER}\n\n`), path);
  }
});

test('config/application.yaml dice lo mismo que el de keel-nest y keel-dotnet para el mismo diseño', async () => {
  const keys = (yaml) => yaml.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  const { planService: nestPlan } = await import('../../keel-nest/src/scaffold/index.js');
  const { planService: dotnetPlan } = await import('../../keel-dotnet/src/scaffold/index.js');
  const of = (plan) => plan({ manifest, layers, workspace }).files.find((file) => file.path === 'config/application.yaml').content;
  assert.deepEqual(keys(byPath.get('config/application.yaml')), keys(of(nestPlan)));
  assert.deepEqual(keys(byPath.get('config/application.yaml')), keys(of(dotnetPlan)));
});

test('la configuración va embebida y el cargador busca los placeholders ${…}', () => {
  assert.match(byPath.get('config/embed.go'), /\/\/go:embed application\.yaml parameters\nvar Files embed\.FS/);
  const loader = byPath.get('internal/platform/config/config.go');
  assert.match(loader, /splitProfiles\(getenv\("PROFILE"\)\)/);
  assert.match(loader, /return \[\]string\{"local"\}/);
  assert.match(loader, /strings\.Index\(rest, "\$\{"\)/, 'el cargador busca los placeholders literales ${');
  assert.doesNotMatch(loader, /\$\[/, 'quedó un placeholder de plantilla sin traducir');
  assert.doesNotMatch(byPath.get('internal/platform/config/config_test.go'), /\$\[/);
});

test('el arranque carga y valida la configuración ANTES de escuchar, y apaga en orden', () => {
  const main = byPath.get('cmd/server/main.go');
  assert.match(main, /func run\(ctx context\.Context, args \[\]string, getenv func\(string\) string, stdout io\.Writer\) error/);
  assert.ok(main.indexOf('config.Load(') < main.indexOf('.Listen('));
  assert.ok(main.indexOf('probes.StartDraining()') < main.indexOf('srv.Shutdown('), '/readyz pasa a 503 antes de cerrar el servidor');
  assert.match(main, /context\.WithoutCancel\(groupCtx\)/);
  assert.match(main, /errgroup\.WithContext/);
});

test('el servidor HTTP lleva sus límites', () => {
  const server = byPath.get('internal/httpapi/server.go');
  for (const field of ['ReadHeaderTimeout', 'ReadTimeout', 'WriteTimeout', 'IdleTimeout', 'MaxHeaderBytes']) {
    assert.match(server, new RegExp(`\\t\\t${field}: +${field},`), field);
  }
});

test('las docs de apoyo no citan rutas de harness, y el contexto y la skill se proyectan a cada uno', () => {
  for (const [path, content] of byPath) {
    if (path.startsWith('docs/keel/')) assert.doesNotMatch(content, /\{\{keel:|\.claude\/|\.opencode\//, path);
  }
  for (const path of ['CLAUDE.md', 'AGENTS.md', '.claude/skills/keel-generate-go/SKILL.md', '.opencode/skills/keel-generate-go/SKILL.md']) {
    assert.ok(byPath.has(path), path);
    assert.doesNotMatch(byPath.get(path), /\{\{keel:/, path);
  }
  for (const name of ['naming', 'errors', 'context', 'concurrency', 'http', 'testing']) assert.ok(byPath.has(`docs/keel/conventions/${name}.md`), name);
});
