// La puerta y la escritura de `keel-dotnet build`. La puerta es la de keel-core/gen (la misma que la de
// keel-spring y keel-nest) y aquí se afirma que keel-dotnet la usa de verdad: un diseño no listo no se
// genera sin --accept-unready, una capa fuera de la frontera no se genera nunca, y una segunda pasada no
// pisa nada.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorkspace, mountDesign, planFixture, runCommand, DOTNET_READY_DESIGN } from './helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { packageVersion } from '../src/lib/assets.js';

const SPEC = `specs/${DOTNET_READY_DESIGN.name}`;
const projectOf = (workspace) => path.join(workspace, 'services', `${DOTNET_READY_DESIGN.name}-dotnet`);

async function generated(options = {}) {
  const workspace = makeWorkspace();
  mountDesign(workspace, DOTNET_READY_DESIGN.name, DOTNET_READY_DESIGN);
  const result = await runCommand(workspace, build, SPEC, { defaults: true, acceptUnready: true, ...options });
  return { workspace, project: projectOf(workspace), ...result };
}

test('genera el proyecto en services/<servicio>-dotnet con su manifiesto, su stack y el snapshot sellado', async () => {
  const { project, exitCode } = await generated();
  assert.equal(exitCode, undefined);
  for (const file of [
    'global.json',
    'Directory.Build.props',
    'Directory.Packages.props',
    'ProductCatalog.slnx',
    'src/ProductCatalog.Api/Program.cs',
    'src/ProductCatalog.Infrastructure/Config/ServiceConfiguration.cs',
    'tests/ProductCatalog.UnitTests/HealthTests.cs',
    'config/application.yaml',
    'keel-stack.json',
    'keel-generated.json',
    'specs.sha256',
    'specs/service.keel.yaml',
    'CLAUDE.md',
    'AGENTS.md',
    '.claude/skills/keel-generate-dotnet/SKILL.md',
    '.opencode/skills/keel-generate-dotnet/SKILL.md'
  ]) {
    assert.ok(fs.existsSync(path.join(project, file)), `falta ${file}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'keel-generated.json'), 'utf8'));
  assert.equal(manifest.generator, `keel-dotnet@${packageVersion()}`);
  // El diseño no está listo y se generó a sabiendas: queda estampado, como en los otros dos.
  assert.equal(manifest.design.acceptedUnready, true);
  assert.ok(Object.keys(manifest.files).includes('src/ProductCatalog.Api/Program.cs'));
});

test('un diseño no listo NO se genera sin --accept-unready, y no se escribe nada', async () => {
  const { workspace, exitCode, output } = await generated({ acceptUnready: false });
  assert.equal(exitCode, 1);
  assert.match(output, /Diseño no listo para generar/);
  assert.ok(!fs.existsSync(path.join(workspace, 'services')));
});

test('lo que está fuera de la frontera (needs, hasta el 13i) se rechaza nombrando keel-dotnet, antes de escribir nada', async () => {
  const workspace = makeWorkspace();
  mountDesign(workspace, 'asset-vault');
  const { exitCode, output } = await runCommand(workspace, build, 'specs/asset-vault', { defaults: true, acceptUnready: true });
  assert.equal(exitCode, 1);
  assert.match(output, /capacidades que keel-dotnet no genera/);
  assert.match(output, /dependencies\.\w+\.needs .*keel-dotnet todavía no genera/);
  assert.ok(!fs.existsSync(path.join(workspace, 'services')));
});

test('payments: build genera con la pasarela del stack, avisa de lo que la matriz no ha verificado e instala solo su skill', async () => {
  const workspace = makeWorkspace();
  mountDesign(workspace, 'payment-checkout');
  const project = path.join(workspace, 'services', 'payment-checkout-dotnet');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'keel-stack.json'), JSON.stringify({ database: 'postgresql', broker: 'rabbitmq', auth: 'keycloak', paymentGateway: 'mercadopago', telemetry: 'none' }));
  const { exitCode, output } = await runCommand(workspace, build, 'specs/payment-checkout', { defaults: true, acceptUnready: true });
  assert.equal(exitCode ?? 0, 0, output);
  assert.match(output, /la pasarela 'mercadopago' lo cubre SIN verificar/);
  assert.ok(fs.existsSync(path.join(project, 'src/PaymentCheckout.Infrastructure/Payment/Mercadopago/MercadopagoPaymentGateway.cs')));
  assert.ok(fs.existsSync(path.join(project, '.claude/skills/keel-dotnet-payments/SKILL.md')));
  assert.ok(fs.existsSync(path.join(project, '.claude/skills/keel-dotnet-mercadopago/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(project, '.claude/skills/keel-dotnet-stripe')), 'la skill de la otra pasarela no');
});

test('payments: una pasarela que no cubre lo que el diseño exige no se genera por ningún camino (planService)', async () => {
  // La captura parcial: MercadoPago no la cubre (la matriz neutral de keel-core); Stripe sí.
  const partialCapture = (manifest, layers) => {
    layers.payments.capabilities = ['partial-capture', ...layers.payments.capabilities];
  };
  const stack = (paymentGateway) => ({ database: 'postgresql', broker: 'rabbitmq', paymentGateway });
  await assert.rejects(planFixture('payment-checkout', { mutate: partialCapture, stack: stack('mercadopago') }), /la pasarela 'mercadopago' no lo cubre/);
  const { files } = await planFixture('payment-checkout', { mutate: partialCapture, stack: stack('stripe') });
  assert.ok(files.some((file) => file.path.endsWith('StripePaymentGateway.cs')));
});

test('la telemetría pedida por flag se rechaza antes de escribir', async () => {
  const { workspace, exitCode, output } = await generated({ telemetry: 'otel' });
  assert.equal(exitCode, 1);
  assert.match(output, /keel-dotnet todavía no genera telemetría/);
  assert.ok(!fs.existsSync(path.join(workspace, 'services')));
});

test('una segunda pasada no pisa lo que ya existe, y --check dice que está al día', async () => {
  const { workspace, project } = await generated();
  const program = path.join(project, 'src', 'ProductCatalog.Api', 'Program.cs');
  fs.appendFileSync(program, '// tocado por el agente\n');
  const again = await runCommand(workspace, build, SPEC, { defaults: true, acceptUnready: true });
  assert.equal(again.exitCode, undefined);
  assert.match(fs.readFileSync(program, 'utf8'), /tocado por el agente/);
  const checked = await runCommand(workspace, build, SPEC, { defaults: true, acceptUnready: true, check: true });
  assert.equal(checked.exitCode, undefined, checked.output);
  assert.match(checked.output, /al día con el generador instalado/);
});

test('un archivo del generador que se quedó atrás: --check en rojo, --refresh lo pone al día', async () => {
  const { workspace, project } = await generated();
  // Simula que el generador cambió: el registro dice que build escribió OTRA versión de ese archivo.
  const manifestFile = path.join(project, 'keel-generated.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const readme = path.join(project, 'README.md');
  fs.writeFileSync(readme, 'versión anterior del generador\n');
  const { digestOf } = await import('keel-core');
  manifest.files['README.md'] = digestOf({ content: 'versión anterior del generador\n' });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const checked = await runCommand(workspace, build, SPEC, { defaults: true, acceptUnready: true, check: true });
  assert.equal(checked.exitCode, 1);
  assert.match(checked.output, /README\.md/);
  const refreshed = await runCommand(workspace, build, SPEC, { defaults: true, acceptUnready: true, refresh: true });
  assert.equal(refreshed.exitCode, undefined);
  assert.notEqual(fs.readFileSync(readme, 'utf8'), 'versión anterior del generador\n');
});

test('un DSL que keel-dotnet no soporta se rechaza', async () => {
  const workspace = makeWorkspace();
  const spec = mountDesign(workspace, DOTNET_READY_DESIGN.name, DOTNET_READY_DESIGN);
  const manifestFile = path.join(spec, 'service.keel.yaml');
  fs.writeFileSync(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace(/^keel: .*$/m, 'keel: "2.18"'));
  const { exitCode, output } = await runCommand(workspace, build, SPEC, { defaults: true, acceptUnready: true });
  assert.equal(exitCode, 1);
  assert.match(output, /no soportado por keel-dotnet/);
});
