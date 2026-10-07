// El conocimiento del generador dentro del proyecto (incremento 7c): la skill orquestadora, los cinco
// agentes, las convenciones y la skill de la base, proyectados a cada harness. Lo que se mide es lo que
// se rompe en silencio: un asset que existe y nadie instala, un token sin resolver que el agente lee
// literal, o una doc compartida que cita la ruta de UN harness y miente al que usa el otro.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESSES } from 'keel-core';
import { AGENTS, CONVENTIONS, GUIDES, DOCS_DIR } from '../src/scaffold/generator-docs.js';
import { planFixture } from './helpers/emitted.js';
import { NEST_READY_DESIGN } from './helpers/workspace.js';

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));
const files = byPath(planFixture(NEST_READY_DESIGN.name).files);

test('todo agente y toda convención de assets/ se instala (las listas son el único punto de instalación)', () => {
  assert.deepEqual([...AGENTS].sort(), fs.readdirSync(path.join(assets, 'agents')).sort());
  assert.deepEqual([...CONVENTIONS].sort(), fs.readdirSync(path.join(assets, 'generators', 'nest', 'conventions')).sort());
  for (const name of [...GUIDES, ...CONVENTIONS.map((c) => `conventions/${c}`)]) {
    assert.ok(`${DOCS_DIR}/${name}` in files, `${name} se emite en ${DOCS_DIR}/`);
  }
});

test('cada harness recibe su contexto, la skill orquestadora, los cinco agentes y la skill de la base', () => {
  for (const harness of HARNESSES) {
    assert.ok(harness.contextFile in files, `${harness.id}: ${harness.contextFile}`);
    assert.ok(harness.skillPath('keel-generate-nest', 'SKILL.md') in files, `${harness.id}: skill orquestadora`);
    assert.ok(harness.skillPath('keel-nest-database', 'SKILL.md') in files, `${harness.id}: skill de la base`);
    for (const agent of AGENTS) {
      const name = agent.replace(/\.md$/, '');
      assert.ok(Object.keys(files).some((file) => file.includes(name) && !file.startsWith(DOCS_DIR)), `${harness.id}: agente ${name}`);
    }
  }
});

test('ningún archivo emitido deja un token {{keel:…}} sin resolver', () => {
  const leftovers = Object.entries(files).filter(([, content]) => /\{\{keel:\w+\}\}/.test(content)).map(([file]) => file);
  assert.deepEqual(leftovers, []);
});

test('las docs compartidas no citan la ruta ni el archivo de contexto de un harness concreto', () => {
  const harnessPaths = /\.claude\/|\.opencode\/|CLAUDE\.md|AGENTS\.md/;
  for (const [file, content] of Object.entries(files)) {
    if (!file.startsWith(`${DOCS_DIR}/`)) continue;
    assert.doesNotMatch(content, harnessPaths, file);
  }
});

test('los agentes son hojas: ninguno puede lanzar subagentes', () => {
  for (const agent of AGENTS) {
    const source = fs.readFileSync(path.join(assets, 'agents', agent), 'utf8');
    assert.match(source, /^spawns: false$/m, agent);
  }
});

test('la skill de la base solo se instala con persistencia relacional', () => {
  const bare = byPath(planFixture(NEST_READY_DESIGN.name, { withoutLayers: ['persistence'] }).files);
  assert.ok(!Object.keys(bare).some((file) => file.includes('keel-nest-database')));
});

// La skill del broker enseña código que tiene que casar con el que emite build: una ruta citada que no
// existe, o una firma que no es la de verdad, manda al agente a escribir contra algo inventado.
const rabbit = byPath(planFixture('stock-reservation', { stack: { broker: 'rabbitmq', database: 'postgresql' } }).files);
const skillDir = path.join(assets, 'generators', 'nest', 'skills', 'keel-nest-rabbitmq');
const skillSources = [path.join(skillDir, 'SKILL.md'), ...fs.readdirSync(path.join(skillDir, 'references')).map((name) => path.join(skillDir, 'references', name))];

test('la skill de RabbitMQ se instala en cada harness con el broker, y solo con él', () => {
  for (const harness of HARNESSES) {
    assert.ok(harness.skillPath('keel-nest-rabbitmq', 'SKILL.md') in rabbit, `${harness.id}: keel-nest-rabbitmq`);
    assert.ok(harness.skillPath('keel-nest-rabbitmq', 'references/listeners.md') in rabbit, `${harness.id}: sus referencias`);
  }
  assert.ok(!Object.keys(files).some((file) => file.includes('keel-nest-rabbitmq')), 'un diseño sin mensajería no la recibe');
});

test('cada ruta src/… que cita la skill de RabbitMQ existe en lo que emite build', () => {
  const emitted = new Set(Object.keys(rabbit));
  for (const source of skillSources) {
    const text = fs.readFileSync(source, 'utf8');
    for (const [cited] of text.matchAll(/src\/[\w/.-]+\.ts/g)) {
      assert.ok(emitted.has(cited), `${path.basename(source)} cita ${cited}, que build no emite`);
    }
  }
});

test('las firmas que enseña la skill de RabbitMQ son las del código emitido', () => {
  const connection = rabbit['src/infrastructure/messaging/rabbitmq/rabbit-connection.ts'];
  assert.match(connection, /async publish\(exchange: string, routingKey: string, payload: string, type: string/);
  assert.match(connection, /consume\(queue: string, handler: MessageHandler\): void/);
  assert.match(rabbit['src/infrastructure/messaging/event-envelope.ts'], /static parse\(text: string\): EventEnvelope<unknown>/);
  assert.match(rabbit['src/infrastructure/messaging/broker-bindings.ts'], /export const BROKER_ADAPTERS: Provider\[\]/);
  assert.match(rabbit['src/infrastructure/messaging/broker-bindings.ts'], /export const MESSAGE_LISTENERS: Provider\[\]/);
  const guard = rabbit['src/infrastructure/messaging/idempotency/idempotency-guard.ts'];
  for (const method of ['alreadyProcessed', 'record', 'tryRecord']) assert.ok(guard.includes(`${method}(handlerId: string, eventId: string)`), method);
  for (const source of skillSources) assert.doesNotMatch(fs.readFileSync(source, 'utf8'), /\.claude\/|\.opencode\//, path.basename(source));
});
