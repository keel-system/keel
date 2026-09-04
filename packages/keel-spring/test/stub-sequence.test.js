// El stubbing con ESTADO del arnés: respuestas distintas en llamadas sucesivas a la misma ruta.
//
// Sin él, un escenario de REINTENTO no se puede escribir. Y no es teórico: en la corrida
// `refunds-rabbit` el escenario del reintento contra el libro mayor —falla la primera, responde
// bien la segunda, y la segunda petición repite la misma cabecera de idempotencia— se reportó
// `NO_EJERCITADO`, y con él la idempotencia SALIENTE se quedó sin medir en toda la corrida. El
// arnés tenía cuatro primitivas y las cuatro fijan UNA respuesta por mapping.
//
// Lo que este archivo ata no es que las respuestas sean correctas —eso solo lo dice ejecutar
// contra WireMock— sino las dos propiedades de las que depende que el escenario mida algo:
// que la última respuesta se quede PEGADA, y que las cuatro formas salgan de un solo sitio.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

function harness(fixture) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-stub-seq-');
  const result = scaffoldService({
    manifest,
    layers,
    workspace,
    force: true,
    stack: { broker: 'rabbitmq', database: 'postgresql' }
  });
  const file = walk(path.join(workspace, result.outDir)).find((f) => f.endsWith('AbstractFlowIT.java'));
  assert.ok(file, 'no se generó el arnés');
  return fs.readFileSync(file, 'utf8');
}

/** El cuerpo de un método del arnés, para mirar dentro y no solo que exista. */
function bodyOf(source, signature) {
  const from = source.indexOf(signature);
  assert.ok(from > 0, `no se generó ${signature}`);
  return source.slice(from, source.indexOf('\n    }', from));
}

test('con capa http-clients el arnés puede programar una SECUENCIA de respuestas', () => {
  const source = harness('catalog-extended');

  assert.match(source, /protected static void stubSequence\(String method, String pathPattern, StubResponse\.\.\. responses\)/);
  // Las cuatro formas que ya existían de un disparo, disponibles también en secuencia: sin
  // `timeout` no se puede escribir «falla la primera y responde la segunda», que es el caso.
  for (const forma of ['ok', 'failure', 'timeout', 'connectionFault']) {
    assert.match(source, new RegExp(`public static StubResponse ${forma}\\(`), `StubResponse no ofrece ${forma}`);
  }
});

test('la ÚLTIMA respuesta se queda pegada, que es lo que evita un 404 del stub', () => {
  // Si el estado avanzara más allá del último mapping, una tercera llamada no casaría con nada y
  // el proveedor devolvería 404: el escenario fallaría por el stub y no por lo que mide, y eso es
  // indistinguible de un defecto del servicio hasta que alguien lee el log de WireMock.
  const cuerpo = bodyOf(harness('catalog-extended'), 'protected static void stubSequence(');

  assert.match(
    cuerpo,
    /String next = i == responses\.length - 1 \? null : /,
    'el último mapping deja estado siguiente: la respuesta final dejaría de casar'
  );
  assert.match(cuerpo, /stubMapping\(method, pathPattern, responses\[i\]\.json\(\), scenario, state, next\)/);
});

test('programar dos veces la misma ruta falla en el sitio, no en silencio', () => {
  // La segunda secuencia encadenaría desde "Started", un estado que la primera ya dejó atrás: sus
  // mappings no responderían nunca y el escenario mediría los de la otra. Es el tipo de defecto
  // que sale como un Then que no se cumple, sin nada que apunte al stub.
  const cuerpo = bodyOf(harness('catalog-extended'), 'protected static void stubSequence(');

  assert.match(cuerpo, /if \(!SEQUENCED\.add\(key\)\)/);
  assert.match(cuerpo, /throw new IllegalStateException/);
  // Y una "secuencia" de una sola respuesta no es una secuencia: es un stubFor con más ceremonia,
  // y aceptarla invita a escribir escenarios de reintento que no reintentan nada.
  assert.match(cuerpo, /responses\.length < 2/);
});

test('y el registro se limpia con los mappings, o la clase siguiente no podría programar', () => {
  const cuerpo = bodyOf(harness('catalog-extended'), 'protected static void resetStubs()');
  assert.match(cuerpo, /SEQUENCED\.clear\(\)/, 'el guard sobreviviría al reset y fallaría la clase siguiente');
});

test('las cuatro respuestas se renderizan en UN solo sitio', () => {
  // La razón de extraerlas: con dos copias —la del helper de un disparo y la de la secuencia— la
  // primera que cambie deja a la otra emitiendo la forma anterior, y el síntoma es un escenario
  // que mide otra cosa. Los helpers de un disparo tienen que pasar por el mismo renderizador.
  const source = harness('catalog-extended');

  assert.match(bodyOf(source, 'protected static void stubFor('), /stubMapping\(method, pathPattern, stubOkBody\(/);
  assert.match(bodyOf(source, 'protected static void stubTimeout('), /stubMapping\(method, pathPattern, stubSlowBody\(/);
  assert.match(
    bodyOf(source, 'protected static void stubConnectionFault('),
    /stubMapping\(method, pathPattern, stubFaultBody\(\)/
  );
  // Y una sola definición de cada forma, no dos.
  for (const render of ['stubOkBody', 'stubSlowBody', 'stubFaultBody']) {
    assert.equal(
      (source.match(new RegExp(`private static String ${render}\\(`, 'g')) ?? []).length,
      1,
      `${render} está definido más de una vez`
    );
  }
});

test('el mapping compone su JSON escapando, no interpolando en crudo', () => {
  // El patrón de ruta es una REGEX: puede traer comillas o barras, y el mapping antiguo las
  // metía tal cual en el JSON con %s. El stub responde 400 y el mensaje no dice de qué escenario
  // venía. Se arregló al extraer el renderizador, y esto lo fija.
  const cuerpo = bodyOf(harness('catalog-extended'), 'private static void stubMapping(');

  assert.match(cuerpo, /quote\("urlPathPattern"\)\)\.append\(": "\)\.append\(quote\(pathPattern\)\)/);
  assert.ok(!/urlPathPattern": "%s/.test(cuerpo), 'sigue interpolando el patrón en crudo');
});

test('sin capa http-clients no se emite nada de esto', () => {
  // Mismo criterio que el resto de la sección: un helper sin proveedor al que hablar es código
  // muerto que además arrastra imports.
  const source = harness('notification-mailer');

  assert.ok(!source.includes('stubSequence'), 'emite el helper sin proveedor de prueba');
  assert.ok(!source.includes('SEQUENCED'), 'emite el registro sin secuencias posibles');
});
