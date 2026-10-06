// `keel-spring check`: el generador viene al workspace a opinar sobre un diseño, y no
// escribe nada.
//
// Su razón de ser es una asimetría cara: todo lo que este generador sabe decir sobre un
// diseño lo decía solo `build`, o sea con el diseño ya dado por cerrado, el stack ya
// elegido y el proyecto ya sembrado. Las familias de aviso que aquí se comprueban han
// costado una corrida cada una.
//
// La aserción principal NO es la salida: es que el árbol del workspace quede byte a byte
// igual. Un comando de comprobación que escribe deja de poder ejecutarse por costumbre, y
// entonces no se ejecuta.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { FIXTURES_DIR, READY_FIXTURES, mountDesign } from './helpers/workspace.js';
import { validateService } from 'keel-core';
import { check } from '../src/commands/check.js';

const fixturesDir = path.join(FIXTURES_DIR);

function makeWorkspace(fixtures) {
  const dir = tmpDir('keel-spring-check-');
  fs.mkdirSync(path.join(dir, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema', 'service.schema.json'), '{}'); // isKeelWorkspace
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  // Con su DESIGN.md si lo tienen: el par del MVP solo está LISTO dentro de un workspace.
  for (const name of fixtures) mountDesign(dir, name);
  return dir;
}

/** Huella del árbol entero: rutas y contenido. Lo que detecta cualquier escritura. */
function fingerprint(dir) {
  const walk = (current) =>
    fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const full = path.join(current, entry.name);
        return entry.isDirectory() ? walk(full) : [`${path.relative(dir, full)}:${fs.readFileSync(full, 'utf8').length}`];
      });
  return walk(dir).join('\n');
}

function runCheck(workspace, inputPath, options = {}) {
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const previous = { log: console.log, warn: console.warn, error: console.error };
  const salida = [];
  const capture = (...args) => salida.push(args.map((arg) => String(arg)).join(' '));
  console.log = console.warn = console.error = capture;
  process.chdir(workspace);
  process.exitCode = undefined;
  try {
    check(inputPath, options);
    return { exitCode: process.exitCode, salida: salida.join('\n') };
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    Object.assign(console, previous);
  }
}

test('check no escribe nada en el workspace', () => {
  const workspace = makeWorkspace(['notification-mailer']);
  const antes = fingerprint(workspace);

  runCheck(workspace, path.join('specs', 'notification-mailer'));

  assert.equal(fingerprint(workspace), antes, 'check modificó el árbol del workspace');
  // Y en particular no sembró el proyecto, que es lo que sí hace build.
  assert.equal(fs.existsSync(path.join(workspace, 'services')), false);
});

test('un diseño generable sale en 0 y apunta al build', () => {
  const workspace = makeWorkspace(['notification-mailer']);

  const { exitCode, salida } = runCheck(workspace, path.join('specs', 'notification-mailer'));

  assert.equal(exitCode, undefined);
  assert.match(salida, /Factible/);
  assert.match(salida, /keel-spring build specs\/notification-mailer/);
});

test('check adelanta el aviso que hasta ahora solo aparecía al generar', () => {
  // payout-runs declara DOS estados en vuelo a la vez, así que build no puede generar el
  // reclamo de su barrido y lo dice. Ese aviso vive en model.js y hasta ahora exigía
  // ejecutar build entero —o sea sembrar el proyecto— para verlo.
  const workspace = makeWorkspace(['payout-runs']);

  const { exitCode, salida } = runCheck(workspace, path.join('specs', 'payout-runs'));

  assert.match(salida, /estado EN VUELO/);
  assert.match(salida, /build NO puede generarlo/);
  // Es un aviso, no un bloqueo: el diseño es legítimo y el reclamo lo escribe el agente. Sale
  // en rojo por OTRA razón —payout-runs no está cerrado—, y el veredicto lo distingue.
  assert.doesNotMatch(salida, /no es generable/);
  assert.match(salida, /Generable, pero no listo/);
  assert.equal(exitCode, 1);
});

test('--strict convierte los avisos en bloqueo, para usarlo de puerta de CI', () => {
  // Sobre un diseño LISTO y con avisos del modelo, que es donde --strict decide algo: en uno
  // no listo, el rojo ya lo pone la puerta de «diseño listo».
  const workspace = makeWorkspace(['notification-mailer']);

  const normal = runCheck(workspace, path.join('specs', 'notification-mailer'));
  assert.equal(normal.exitCode, undefined, normal.salida);
  assert.match(normal.salida, /Factible con \d+ aviso/);

  const { exitCode, salida } = runCheck(workspace, path.join('specs', 'notification-mailer'), { strict: true });

  assert.equal(exitCode, 1);
  assert.match(salida, /--strict los trata como bloqueo/);
});

test('un motor fuera del catálogo se rechaza nombrando los que hay', () => {
  const workspace = makeWorkspace(['notification-mailer']);

  const { exitCode, salida } = runCheck(workspace, path.join('specs', 'notification-mailer'), { database: 'h2' });

  assert.equal(exitCode, 1);
  assert.match(salida, /no está en el catálogo/);
  assert.match(salida, /postgresql/);
});

test('fuera de un workspace Keel no intenta nada', () => {
  const dir = tmpDir('keel-spring-check-nows-');

  const { exitCode, salida } = runCheck(dir, path.join('specs', 'lo-que-sea'));

  assert.equal(exitCode, 1);
  assert.match(salida, /no es un workspace Keel/);
});

test('sin ruta, lo dice en vez de elegir un servicio por su cuenta', () => {
  const workspace = makeWorkspace(['notification-mailer']);

  const { exitCode, salida } = runCheck(workspace, undefined);

  assert.equal(exitCode, 1);
  assert.match(salida, /Falta el servicio a comprobar/);
});

test('las 11 fixtures del generador son factibles', () => {
  // Regresión barata y con dueño: las fixtures son el sujeto de compile-check,
  // claim-check y el resto de redes en vivo. Si una deja de ser generable, esas redes
  // dejan de poder correr, y hasta ahora eso solo se veía ejecutando build sobre ella.
  //
  // Factible es «sin bloqueos». Solo el par del MVP está además LISTO; las demás son sujetos
  // parciales a propósito y salen en rojo por la puerta de «diseño listo», no por un bloqueo.
  const names = fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(names.length >= 11, `esperaba al menos 11 fixtures, hay ${names.length}`);

  const workspace = makeWorkspace(names);
  for (const name of names) {
    const { exitCode, salida } = runCheck(workspace, path.join('specs', name));
    assert.doesNotMatch(salida, /no es generable/, `${name} no es factible:\n${salida}`);
    if (READY_FIXTURES.includes(name)) assert.equal(exitCode, undefined, `${name} está listo:\n${salida}`);
    else assert.match(salida, /Generable, pero no listo/, name);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// El bucle de vuelta: lo que la generación encontró sobre el diseño.
//
// Los `designGaps` de los cinco agentes se consolidaban en un informe en prosa DENTRO del
// proyecto generado, y volvían al diseñador a mano — o no volvían. El mismo hueco
// reportado cuatro corridas seguidas es lo que motivó el catálogo de obligaciones.
//
// No hace falta ningún comando nuevo: `check` ya corre desde el workspace, y el proyecto
// vive en services/<servicio>-spring/.

function writeGaps(workspace, service, contenido) {
  const dir = path.join(workspace, 'services', `${service}-spring`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'design-gaps.yaml'), contenido);
}

test('check trae de vuelta los huecos que reportó la generación', () => {
  const workspace = makeWorkspace(['notification-mailer']);
  writeGaps(
    workspace,
    'notification-mailer',
    [
      'service: notification-mailer',
      'version: 1.0.0',
      'gaps:',
      '  - layer: use-cases',
      '    unit: requestNotification',
      '    kind: undeclared',
      '    proposal: Declara el code del conflicto de plantilla ausente, con su status 422.',
      ''
    ].join('\n')
  );

  const { salida } = runCheck(workspace, path.join('specs', 'notification-mailer'));

  assert.match(salida, /Huecos que reportó la generación/);
  assert.match(salida, /use-cases\.requestNotification/);
  assert.match(salida, /plantilla ausente/);
});

test('un hueco de otra versión del diseño se marca, no se da por vigente', () => {
  const workspace = makeWorkspace(['notification-mailer']);
  writeGaps(
    workspace,
    'notification-mailer',
    ['service: notification-mailer', 'version: 0.9.0', 'gaps:', '  - layer: domain', '    kind: missing', '    proposal: Algo que se dijo de un diseño anterior.', ''].join('\n')
  );

  const { salida } = runCheck(workspace, path.join('specs', 'notification-mailer'));

  assert.match(salida, /Son de la v0\.9\.0/);
});

test('un design-gaps.yaml roto se dice en voz alta y no tumba la comprobación', () => {
  // Callarlo dejaría al diseñador creyendo que la generación no encontró nada, que es el
  // peor de los dos desenlaces: lo que aporta el archivo es contexto, no veredicto.
  const workspace = makeWorkspace(['notification-mailer']);
  writeGaps(workspace, 'notification-mailer', 'gaps: [{{{');

  const { exitCode, salida } = runCheck(workspace, path.join('specs', 'notification-mailer'));

  assert.match(salida, /YAML inválido/);
  assert.equal(exitCode, undefined, 'un archivo roto del proyecto no puede bloquear la comprobación del diseño');
});

test('sin proyecto generado, check no habla de huecos', () => {
  const workspace = makeWorkspace(['notification-mailer']);
  const { salida } = runCheck(workspace, path.join('specs', 'notification-mailer'));
  assert.ok(!salida.includes('Huecos que reportó la generación'));
});

// «Diseño listo para generar», fase 2: la misma checklist que `keel validate --ready`, y ahora
// build se niega sin --accept-unready. check predice lo que hará build, así que sale en ROJO
// con o sin --strict — y no por sus avisos, que no cambian de naturaleza.
test('un diseño no listo sale en rojo aunque no tenga un solo aviso, y dice la salida', () => {
  const workspace = makeWorkspace(['metering-digest']);
  const antes = fingerprint(workspace);

  // metering-digest es la fixture sin un solo aviso: lo único que la pone en rojo es la puerta.
  const normal = runCheck(workspace, path.join('specs', 'metering-digest'));
  assert.equal(normal.exitCode, 1, normal.salida);
  assert.match(normal.salida, /Diseño listo para generar/);
  assert.match(normal.salida, /\[flow-review\]/);
  assert.match(normal.salida, /build se negará a generarlo salvo con --accept-unready/);
  assert.match(normal.salida, /Generable, pero no listo: faltan \d+ criterio\(s\) del cierre y 0 aviso\(s\)/);

  const estricto = runCheck(workspace, path.join('specs', 'metering-digest'), { strict: true });
  assert.equal(estricto.exitCode, 1, estricto.salida);

  assert.equal(fingerprint(workspace), antes, 'check escribió en el workspace');
});

test('los huecos de un build sobre un diseño no listo lo dicen', () => {
  const workspace = makeWorkspace(['notification-mailer']);
  writeGaps(
    workspace,
    'notification-mailer',
    ['service: notification-mailer', 'version: 1.0.0', 'gaps:', '  - layer: domain', '    kind: missing', '    proposal: Algo que la generación tuvo que decidir.', ''].join('\n')
  );
  const manifest = { generator: 'keel-spring@0.0.0', design: { version: '1.0.0', ready: false, missing: ['flow-review', 'review'] }, files: {}, adopted: [] };
  fs.writeFileSync(path.join(workspace, 'services', 'notification-mailer-spring', 'keel-generated.json'), JSON.stringify(manifest));

  const { salida } = runCheck(workspace, path.join('specs', 'notification-mailer'));

  assert.match(salida, /diseño no listo \(v1\.0\.0, faltaban: flow-review, review\)/);
  assert.match(salida, /pueden ser del diseño y no del método/);
});

test('check no cuenta como aviso lo que decisions.yaml ya acepta', () => {
  // Hallazgo 6 de R9: la misma vara que keel validate y build (classifyWarnings de keel-core).
  const workspace = makeWorkspace(['notification-mailer']);
  const { undecided } = validateService(path.join(workspace, 'specs', 'notification-mailer'), { wip: false });
  assert.ok(undecided.accepted.length > 0, 'la fixture tiene que aceptar alguna decisión para medir esto');

  const { salida } = runCheck(workspace, path.join('specs', 'notification-mailer'));

  for (const { message } of undecided.accepted) assert.ok(!salida.includes(message), `repite una aceptada: ${message}`);
});
