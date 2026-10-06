// `infra/` es neutral: lo escribe keel-core/gen/infra-scripts.js para los dos generadores, y lo único
// que cambia entre ellos son los textos de la PLATAFORMA. Aquí se mide con una plataforma que no es
// la de ninguno: que cada texto suyo llegue a donde tiene que llegar, que no se cuele ningún texto
// de otro generador y que la tabla de historial de migraciones sustituya a su placeholder en TODOS
// los motores del catálogo —un `{history}` que sobreviviera haría que el reset truncara también el
// historial, y el siguiente arranque reaplicaría el baseline sobre tablas ya existentes—.

import test from 'node:test';
import assert from 'node:assert/strict';
import { infraFiles, concreteCmd } from '../src/lib/gen/infra-scripts.js';
import { DATABASES } from '../src/lib/gen/infra-catalog.js';

const PROBE = {
  generator: 'keel-probe',
  historyTable: 'probe_history',
  strayProcess: { comment: '# PROBE-STRAY-COMMENT', hint: 'PROBE-HINT', close: 'PROBE-CLOSE' },
  schemaRebuiltBy: { relational: 'PROBE-REBUILT-RELATIONAL', document: 'PROBE-REBUILT-DOCUMENT' },
  schemaHelp: { relational: '# PROBE-HELP-RELATIONAL', document: '# PROBE-HELP-DOCUMENT' },
  httpStubsReadme: (service) => `PROBE-STUBS ${service.name}`,
  extraChecks: () => [{ label: 'PROBE-CHECK', cmd: 'true' }],
  extraFiles: () => [{ path: 'infra/probe.sh', content: 'PROBE-FILE' }]
};

function modelFor(database, extra = {}) {
  const kind = DATABASES[database].kind;
  return {
    service: { name: 'ticket-desk', projectName: 'ticket-desk-probe', artifactId: 'ticket-desk' },
    layersPresent: { persistence: true, ...(extra.layersPresent ?? {}) },
    stack: { database, auth: 'none', cache: null, ...(extra.stack ?? {}) },
    persistenceKind: kind
  };
}

const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));
const engines = Object.keys(DATABASES).filter((id) => DATABASES[id].composeService);

test('la tabla de historial de la plataforma sustituye a su placeholder en el reset de todos los motores', () => {
  for (const database of engines) {
    const entry = DATABASES[database];
    if (!entry.cliResetCmd) continue;
    const reset = concreteCmd(entry, 'ticket_desk', entry.cliResetCmd, PROBE);
    assert.doesNotMatch(reset, /\{history\}|\{HISTORY\}/, database);
    if (entry.kind === 'relational') assert.match(reset, /probe_history|PROBE_HISTORY/, database);
  }
});

test('ningún comando del catálogo nombra la tabla de historial de un generador concreto', () => {
  for (const database of Object.keys(DATABASES)) {
    for (const key of ['cliResetCmd', 'cliDropSchemaCmd', 'cliValidateCmd']) {
      assert.doesNotMatch(DATABASES[database][key] ?? '', /flyway|typeorm|migrations\b/i, `${database}.${key}`);
    }
  }
});

test('cada texto de la plataforma llega a su archivo, y el de ningún otro generador', () => {
  for (const database of engines) {
    const files = byPath(infraFiles(modelFor(database), PROBE));
    const kind = DATABASES[database].kind;
    assert.match(files['infra/docker-compose.yaml'], /generada por keel-probe/, database);
    assert.match(files['infra/validate-infra.sh'], /# PROBE-STRAY-COMMENT[\s\S]*PROBE-HINT[\s\S]*PROBE-CLOSE/, database);
    assert.match(files['infra/validate-infra.sh'], /check 'PROBE-CHECK'/, database);
    assert.match(files['infra/reset-db.sh'], new RegExp(`PROBE-REBUILT-${kind.toUpperCase()}`), database);
    assert.match(files['infra/reset-db.sh'], new RegExp(`# PROBE-HELP-${kind.toUpperCase()}`), database);
    assert.equal(files['infra/probe.sh'], 'PROBE-FILE', database);
    for (const content of Object.values(files)) {
      assert.doesNotMatch(content, /flyway|hibernate|gradlew|integrationTest|AbstractFlowIT|MongoIndexConfig|typeorm|vitest/i, database);
    }
  }
});

test('el README del stub HTTP es de la plataforma y solo existe con integraciones salientes', () => {
  const without = byPath(infraFiles(modelFor('postgresql'), PROBE));
  assert.equal(without['infra/http-stubs/README.md'], undefined);
  const withStub = byPath(infraFiles(modelFor('postgresql', { layersPresent: { httpClients: true } }), PROBE));
  assert.equal(withStub['infra/http-stubs/README.md'], 'PROBE-STUBS ticket-desk');
});

test('sin contenedores que levantar, infra/ no existe', () => {
  const model = { ...modelFor('postgresql'), layersPresent: {} };
  assert.deepEqual(infraFiles(model, PROBE), []);
});
