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

// La de Kafka (incremento 9f), con las mismas dos comprobaciones: lo que cita existe y sus firmas son las de verdad.
const kafka = byPath(planFixture('stock-reservation', { stack: { broker: 'kafka', database: 'postgresql' } }).files);
const kafkaSkillDir = path.join(assets, 'generators', 'nest', 'skills', 'keel-nest-kafka');
const kafkaSkillSources = [
  path.join(kafkaSkillDir, 'SKILL.md'),
  ...fs.readdirSync(path.join(kafkaSkillDir, 'references')).map((name) => path.join(kafkaSkillDir, 'references', name))
];

test('la skill de Kafka se instala en cada harness con el broker, y la de RabbitMQ no', () => {
  for (const harness of HARNESSES) {
    assert.ok(harness.skillPath('keel-nest-kafka', 'SKILL.md') in kafka, `${harness.id}: keel-nest-kafka`);
    assert.ok(harness.skillPath('keel-nest-kafka', 'references/listeners.md') in kafka, `${harness.id}: sus referencias`);
  }
  assert.ok(!Object.keys(kafka).some((file) => file.includes('keel-nest-rabbitmq')), 'con Kafka no se instala la de RabbitMQ');
  assert.ok(!Object.keys(rabbit).some((file) => file.includes('keel-nest-kafka')), 'con RabbitMQ no se instala la de Kafka');
});

test('cada ruta src/… que cita la skill de Kafka existe en lo que emite build', () => {
  const emitted = new Set(Object.keys(kafka));
  for (const source of kafkaSkillSources) {
    const text = fs.readFileSync(source, 'utf8');
    for (const [cited] of text.matchAll(/src\/[\w/.-]+\.ts/g)) {
      assert.ok(emitted.has(cited), `${path.basename(source)} cita ${cited}, que build no emite`);
    }
  }
});

test('las firmas que enseña la skill de Kafka son las del código emitido', () => {
  const connection = kafka['src/infrastructure/messaging/kafka/kafka-connection.ts'];
  assert.match(connection, /async publish\(topic: string, key: string \| null, payload: string \| Buffer/);
  assert.match(connection, /consume\(subscription: string, handler: MessageHandler\): void/);
  assert.match(connection, /export interface InboundMessage \{[\s\S]*readonly value: string;/);
  const settings = kafka['src/infrastructure/messaging/messaging-settings.ts'];
  assert.match(settings, /readonly groupId: string \| null;/);
  for (const source of kafkaSkillSources) assert.doesNotMatch(fs.readFileSync(source, 'utf8'), /\.claude\/|\.opencode\//, path.basename(source));
});

// La de SNS/SQS (incremento 9g), con las mismas dos comprobaciones.
const snssqs = byPath(planFixture('stock-reservation', { stack: { broker: 'snssqs', database: 'postgresql' } }).files);
const snssqsSkillDir = path.join(assets, 'generators', 'nest', 'skills', 'keel-nest-snssqs');
const snssqsSkillSources = [
  path.join(snssqsSkillDir, 'SKILL.md'),
  ...fs.readdirSync(path.join(snssqsSkillDir, 'references')).map((name) => path.join(snssqsSkillDir, 'references', name))
];

test('la skill de SNS/SQS se instala en cada harness con el broker, y ninguna de las otras dos', () => {
  for (const harness of HARNESSES) {
    assert.ok(harness.skillPath('keel-nest-snssqs', 'SKILL.md') in snssqs, `${harness.id}: keel-nest-snssqs`);
    assert.ok(harness.skillPath('keel-nest-snssqs', 'references/listeners.md') in snssqs, `${harness.id}: sus referencias`);
  }
  assert.ok(!Object.keys(snssqs).some((file) => file.includes('keel-nest-rabbitmq') || file.includes('keel-nest-kafka')));
});

test('cada ruta src/… que cita la skill de SNS/SQS existe en lo que emite build', () => {
  const emitted = new Set(Object.keys(snssqs));
  for (const source of snssqsSkillSources) {
    const text = fs.readFileSync(source, 'utf8');
    for (const [cited] of text.matchAll(/src\/[\w/.-]+\.ts/g)) {
      assert.ok(emitted.has(cited), `${path.basename(source)} cita ${cited}, que build no emite`);
    }
  }
  assert.ok('infra/init-messaging.sh' in snssqs, 'la skill cita infra/init-messaging.sh');
});

test('las firmas que enseña la skill de SNS/SQS son las del código emitido', () => {
  const connection = snssqs['src/infrastructure/messaging/snssqs/snssqs-connection.ts'];
  assert.match(connection, /async publish\(topic: string, payload: string, attributes: Readonly<Record<string, string>>\)/);
  assert.match(connection, /consume\(subscription: string, handler: MessageHandler\): void/);
  assert.match(connection, /export interface InboundMessage \{[\s\S]*readonly body: string;/);
  for (const source of snssqsSkillSources) assert.doesNotMatch(fs.readFileSync(source, 'utf8'), /\.claude\/|\.opencode\//, path.basename(source));
});
