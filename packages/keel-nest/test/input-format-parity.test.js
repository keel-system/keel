// El formato que un campo HEREDA de su value type se valida en la ENTRADA, en los dos generadores (desde la corrida
// notification-mailer-mongo, 2026-10-08). Antes la entrada lo dejaba caer «por si el diseño normalizaba», y el orden
// 400/422 lo decidía cada agente: con un destinatario mal formado y una plantilla inexistente, keel-spring respondía
// 400 y keel-nest 422. Aquí se exige sobre lo que EMITEN los dos, en todas las fixtures: el lector de keel-nest
// comprueba el patrón y el mensaje (o el parámetro del controller) de keel-spring lleva su @Pattern.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tsString } from '../src/scaffold/render.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const javaString = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

let total = 0;
for (const name of fs.readdirSync(FIXTURES_DIR).filter((entry) => fs.existsSync(path.join(FIXTURES_DIR, entry, 'service.keel.yaml')))) {
  test(`${name}: el formato heredado se valida en la entrada de los dos generadores`, (t) => {
    let nest;
    try {
      nest = planFixture(name, { stack: STACK });
    } catch {
      return t.skip('fuera de la frontera de keel-nest');
    }
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files.map((file) => file.content).join('\n');
    const nestReaders = nest.files.filter((file) => file.path.includes('/rest/controllers/')).map((file) => file.content).join('\n');
    for (const service of nest.model.services ?? []) {
      for (const operation of service.operations ?? []) {
        if (!operation.route) continue;
        const fields = [...(operation.bodyFields ?? []), ...(operation.queryParams ?? []), ...(operation.pathParams ?? [])];
        for (const field of fields) {
          if (field.list || !field.inheritedPattern || field.resolvedIdentity) continue;
          total += 1;
          assert.ok(
            nestReaders.includes(`{ rule: 'pattern', regexp: ${tsString(field.inheritedPattern)} }`),
            `keel-nest ${operation.name}.${field.name} no valida ${field.inheritedPattern} en la entrada`
          );
          assert.ok(
            spring.includes(`@Pattern(regexp = ${javaString(field.inheritedPattern)})`),
            `keel-spring ${operation.name}.${field.name} no valida ${field.inheritedPattern} en la entrada`
          );
        }
      }
    }
  });
}

test('alguna fixture tiene campos de entrada con formato heredado (si no, lo de arriba no mide nada)', () => {
  assert.ok(total > 0, `${total} campos comprobados`);
});
