import path from 'node:path';
import pc from 'picocolors';
import { copyTree } from '@keel-system/keel-core';
import { gateDesign } from '@keel-system/keel-core/gen/design-gate';
import { SKILL, SUPPORTED_DSL } from '../lib/assets.js';
import { checkSupportedFeatures } from '../lib/supported-features.js';
import { checkGatewaySupport } from '../lib/gateway-support.js';
import { scaffoldService } from '../scaffold/index.js';
import { writeFiles } from '../lib/writer.js';
import {
  STACK_FILE,
  readStackConfig,
  writeStackConfig,
  askStackConfig,
  describeStack,
  normalizeTelemetry
} from '../lib/stack-config.js';
import { REFRESH_DIR, readManifest } from '../lib/generated-manifest.js';
import { platformMismatch } from '../lib/platform.js';
import { writeSpecsSeal } from '../lib/specs-seal.js';
import {
  EVOLUTION_MD,
  checkFails,
  designDelta,
  evolveStack,
  persistEvolution,
  planEvolution,
  reportEvolution,
  reportGeneratorDrift
} from '@keel-system/keel-core/gen/evolution';
import { SPRING_EVOLUTION } from '../scaffold/evolution.js';

export async function build(
  inputPath,
  {
    force = false,
    defaults = false,
    check = false,
    refresh = false,
    prune = false,
    telemetry = null,
    acceptUnready = false
  } = {}
) {
  // Tres modos y no dos banderas sueltas: `check` gana porque no escribir es la promesa
  // más fuerte de las dos, y pedir las dos a la vez es una contradicción que vale más
  // resolver aquí que dejar a medias en el sistema de archivos.
  const mode = check ? 'check' : refresh ? 'refresh' : null;
  const workspace = process.cwd();

  // La telemetría se elige por flag o en el cuestionario; un valor desconocido se rechaza aquí,
  // antes de validar nada, porque no hay nada que el diseño pueda hacer para arreglarlo.
  if (telemetry != null) {
    try {
      normalizeTelemetry(telemetry);
    } catch (error) {
      console.error(pc.red(error.message));
      process.exitCode = 1;
      return;
    }
  }

  // Podar es refrescar en la otra dirección: solo tiene sentido donde build ya decide
  // archivo a archivo de quién es cada cosa.
  if (prune && mode !== 'refresh') {
    console.error(pc.red('--prune solo se admite junto a --refresh (y nunca con --check, que no escribe).'));
    process.exitCode = 1;
    return;
  }

  // La puerta del diseño es la misma para cualquier generador (keel-core/gen/design-gate.js):
  // workspace, DSL soportado, frontera de keel-spring, validación estricta, decisiones sin
  // cerrar, revisión y cierre del diseño. El workspace de diseño no recibe nada del generador:
  // la skill, los agentes, las conventions y las skills por tecnología se instalan solo en el
  // proyecto generado, y la generación se ejecuta con el cwd en services/<servicio>-spring/.
  const gate = gateDesign({
    inputPath,
    workspace,
    generator: { name: 'keel-spring', supportedDsl: SUPPORTED_DSL, checkSupportedFeatures },
    mode,
    acceptUnready
  });
  if (!gate) return;
  const { dir, manifest, layers, fixtures, readiness } = gate;

  // Stack tecnológico: keel-stack.json del proyecto generado manda; si no
  // existe, cuestionario condicionado por las capas del diseño (o defaults).
  const projectDir = path.join(workspace, 'services', `${manifest.service?.name}-spring`);

  // Un proyecto generado sobre otra línea de Spring Boot no se refresca ni se completa: se
  // regenera (src/lib/platform.js). Se mira ANTES de preguntar el stack o escribir nada, y
  // también con --check, que es justo el modo que tiene que decirlo.
  const mismatch = platformMismatch(readManifest(projectDir)?.generator);
  if (mismatch) {
    console.error(pc.red(`✘ ${mismatch}`));
    process.exitCode = 1;
    return;
  }

  let stack = readStackConfig(projectDir);
  let stackIsNew = false;
  let stackChanges = { added: [], removed: [] };
  if (stack) {
    // El stack persistido se reutiliza, pero el diseño pudo EVOLUCIONAR bajo él
    // (keel-core/gen/evolution.js): lo nuevo se pregunta (solo eso) y lo que dejó de aplicar se anula.
    const evolved = await evolveStack({
      stack,
      layers,
      mode,
      telemetry,
      ask: (only) => askStackConfig(manifest, layers, { defaults, only })
    });
    stack = evolved.stack;
    stackChanges = evolved.changes;
  } else {
    stack = await askStackConfig(manifest, layers, { defaults, telemetry });
    stackIsNew = true;
  }

  // El delta de diseño se calcula ANTES de refrescar el snapshot, contra la base congelada
  // si una evolución anterior sigue sin cerrar, o si no contra el snapshot: es el diseño
  // desde el que se completó el proyecto por última vez.
  const design = designDelta(projectDir, dir);

  // Scaffolding transversal al stack: todo lo derivable mecánicamente del
  // diseño cuyo código no depende de la infra puntual elegida (el resto lo
  // escribe el agente con las skills por tecnología). Regeneración segura: sin --force
  // solo se escriben archivos que no existen.
  // Solo cuenta como aceptado si de verdad faltaba algo: el flag sobre un diseño listo no dice nada.
  const acceptedUnready = acceptUnready && !readiness.ready;
  // La pasarela elegida contra lo que el diseño exige (gateway-support.js), antes de escribir
  // nada: una capacidad que no cubre no se genera, y una sin verificar se avisa.
  if (layers.payments) {
    const gateway = stack?.paymentGateway ?? null;
    const support = gateway ? checkGatewaySupport(layers, gateway) : { errors: [], warnings: [] };
    for (const message of support.warnings) console.warn(`${pc.yellow('⚠')} ${message}`);
    if (support.errors.length > 0) {
      console.error(pc.bold(pc.red(`✘ La pasarela '${gateway}' no cubre lo que el diseño exige — ${support.errors.length}:`)));
      for (const message of support.errors) console.error(`  ${pc.red('•')} ${message}`);
      console.error(pc.dim('  Elige otra pasarela (borra paymentGateway de keel-stack.json) o quita la capacidad del diseño.'));
      process.exitCode = 1;
      return;
    }
  }
  const scaffold = scaffoldService({ manifest, layers, fixtures, workspace, force, stack, mode, prune, readiness, acceptedUnready });
  const stackChanged = stackChanges.added.length + stackChanges.removed.length > 0;
  if (stackIsNew || (stackChanged && mode !== 'check')) {
    writeStackConfig(projectDir, scaffold.stack);
    console.log();
    console.log(pc.dim(`Stack elegido: ${describeStack(scaffold.stack)} → ${STACK_FILE}`));
  }
  console.log();
  console.log(pc.bold(`Scaffolding ${scaffold.outDir}/`));
  for (const file of scaffold.copied) console.log(`  ${pc.green('+')} ${file}`);
  for (const file of scaffold.skipped) console.log(`  ${pc.yellow('=')} ${file} ${pc.dim('(ya existía, omitido)')}`);
  for (const message of scaffold.warnings) console.warn(`${pc.yellow('⚠')} ${message}`);
  console.log(
    pc.dim(
      `${scaffold.copied.length} archivo(s) generado(s), ${scaffold.skipped.length} omitido(s)` +
        (scaffold.skipped.length > 0 ? ' (usa --force para sobrescribir)' : '')
    )
  );

  reportGeneratorDrift(scaffold, mode, { generator: 'keel-spring' });

  // El traspaso al pipeline cuando el proyecto ya existía y algo cambió. En la primera
  // generación no hay nada que evolucionar: todo es nuevo y el pipeline lo sabe.
  const evolution = planEvolution({ design, manifest, scaffold, stackChanges, mode, prune, projectDir });
  reportEvolution(evolution, scaffold.outDir, mode);

  if (mode === 'check') {
    if (checkFails(scaffold, evolution)) process.exitCode = 1;
    return;
  }

  // La base se congela la primera vez que el diseño cambia, ANTES de refrescar el
  // snapshot: si no, un segundo build compararía el diseño consigo mismo.
  persistEvolution(evolution, design, projectDir, SPRING_EVOLUTION);

  // Snapshot del diseño dentro del proyecto: junto con el conocimiento del agente hace el repo
  // autosuficiente (quien lo clone finaliza la generación sin el workspace).
  // Siempre se refresca: el canónico es specs/<servicio> del workspace.
  const snapshot = copyTree(dir, design.snapshotDir, { force: true });
  // Y su sello: infra/score-scenarios.sh se niega a puntuar contra un snapshot editado desde el
  // proyecto (lib/specs-seal.js).
  writeSpecsSeal(projectDir);
  console.log(
    pc.dim(
      `Snapshot del diseño → ${path.relative(workspace, design.snapshotDir).split(path.sep).join('/')}/ ` +
        `(${snapshot.copied.length} archivo(s), refrescado en cada build)`
    )
  );

  // Snapshot de los contratos formales (/keel-docs) junto al del diseño: quien
  // clone el proyecto tiene openapi/asyncapi, las colecciones Postman y el panel
  // sin el workspace. Solo lo que produce /keel-docs — DESIGN.md e INTEGRATION.md
  // viven en el mismo directorio pero son de otras skills. También se refresca
  // siempre: el canónico es docs/<servicio>/ del workspace.
  const docsDir = path.join(projectDir, 'docs');
  if (scaffold.docs.files.length > 0) {
    const docsSnapshot = writeFiles(scaffold.docs.files, docsDir, { force: true });
    console.log(
      pc.dim(
        `Snapshot de los contratos → ${path.relative(workspace, docsDir).split(path.sep).join('/')}/ ` +
          `(${docsSnapshot.copied.length} archivo(s), refrescado en cada build)`
      )
    );
  } else {
    console.warn(
      `${pc.yellow('⚠')} El servicio aún no tiene contratos generados (docs/${manifest.service?.name}/). ` +
        `Ejecuta ${pc.cyan(`/keel-docs ${path.relative(workspace, dir).split(path.sep).join('/')}`)} y vuelve a ` +
        'lanzar el build para incluirlos en el proyecto.'
    );
  }

  console.log();
  console.log(pc.bold(pc.green('✔ Scaffolding generado.')) + pc.dim(` — ${manifest.service?.name} v${manifest.service?.version}`));
  console.log(`
Siguiente paso — la generación se completa dentro del proyecto:
  1. ${pc.cyan(`cd ${scaffold.outDir}`)}
  2. abre tu agente ahí y ejecuta ${pc.cyan(`/${SKILL}`)} ${pc.dim('(sin argumentos)')}

Orquesta el completado: código + infraestructura en paralelo, validación funcional de los
escenarios contra el servidor real y pase de calidad al final.`);
  if (evolution?.pending) {
    console.log(
      pc.dim(
        `Como hay ${REFRESH_DIR}/${EVOLUTION_MD}, la skill entra en modo evolución: trabaja sobre lo que cambió y ` +
          'puntúa la suite completa como no-regresión.'
      )
    );
  }
}
