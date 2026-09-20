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
import { check } from '../src/commands/check.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function makeWorkspace(fixtures) {
  const dir = tmpDir('keel-spring-check-');
  fs.mkdirSync(path.join(dir, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema', 'service.schema.json'), '{}'); // isKeelWorkspace
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  for (const name of fixtures) {
    fs.cpSync(path.join(fixturesDir, name), path.join(dir, 'specs', name), { recursive: true });
  }
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
  // Es un aviso, no un bloqueo: el diseño es legítimo y el reclamo lo escribe el agente.
  assert.equal(exitCode, undefined);
});

test('--strict convierte los avisos en bloqueo, para usarlo de puerta de CI', () => {
  const workspace = makeWorkspace(['payout-runs']);

  const { exitCode, salida } = runCheck(workspace, path.join('specs', 'payout-runs'), { strict: true });

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
  const names = fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(names.length >= 11, `esperaba al menos 11 fixtures, hay ${names.length}`);

  const workspace = makeWorkspace(names);
  for (const name of names) {
    const { exitCode, salida } = runCheck(workspace, path.join('specs', name));
    assert.equal(exitCode, undefined, `${name} no es factible:\n${salida}`);
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
