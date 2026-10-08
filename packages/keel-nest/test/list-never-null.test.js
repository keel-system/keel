// Contrato del cable, `list-never-null` (keel-core/gen/wire.js): una lista que la entrada no informa se lee como
// `[]`, salvo la opcional del cuerpo de un PATCH. La corrida notification-mailer-mongo (2026-10-08) lo destapó: los
// dos servidores respondían `[]`, pero en keel-spring dependía de que el agente lo recordara al construir el
// agregado. Ahora lo emiten los dos: el lector de keel-nest (`x ?? []`) y el constructor compacto del mensaje de
// keel-spring (`x = x == null ? List.of() : x;`). Se comprueba en TODAS las fixtures, sobre lo que emite cada uno.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };

for (const name of fs.readdirSync(FIXTURES_DIR).filter((entry) => fs.existsSync(path.join(FIXTURES_DIR, entry, 'service.keel.yaml')))) {
  test(`${name}: toda lista de la entrada se normaliza a [] en los dos generadores`, (t) => {
    let nest;
    try {
      nest = planFixture(name, { stack: STACK });
    } catch {
      return t.skip('fuera de la frontera de keel-nest');
    }
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files;
    const nestText = nest.files.filter((file) => file.path.includes('/rest/controllers/')).map((file) => file.content).join('\n');
    let checked = 0;
    for (const service of nest.model.services ?? []) {
      for (const operation of service.operations ?? []) {
        if (!operation.route) continue;
        const partial = operation.route.method === 'PATCH';
        const fromPath = new Set((operation.pathParams ?? []).map((param) => param.name));
        const lists = (operation.bodyFields ?? []).concat(operation.queryParams ?? []).filter((field) => field.list && !fromPath.has(field.name));
        const record = spring.find((file) => file.path.endsWith(`/${operation.messageClass}.java`))?.content;
        for (const field of lists) {
          // La opcional del cuerpo de un PATCH es de tres estados en keel-spring: ausente es «no tocar».
          if (partial && !field.required) continue;
          checked += 1;
          assert.ok(nestText.includes(`${field.name}: ${field.name} ?? []`), `keel-nest ${operation.name}.${field.name}`);
          assert.ok(record?.includes(`${field.name} = ${field.name} == null ? List.of() : ${field.name};`), `keel-spring ${operation.messageClass}.${field.name}`);
        }
      }
    }
    if (checked === 0) t.diagnostic('sin listas en la entrada');
  });
}
