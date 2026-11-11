// La guarda del `sub` de una persona, EJECUTANDO la sección de identidad que emite keel-nest: un `sub` que no cabe en el id del
// usuario de Keycloak se rechaza con su motivo antes de llamar a nadie. Y la comparación con los otros tres: la guarda y la
// forma de `design-gaps.yaml` en la skill salen de keel-core en los cuatro generadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { DESIGN_GAPS_FORM } from '@keel-system/keel-core/gen/design-gaps';
import { PERSONA_SUB_MAX, PERSONA_SUB_TOO_LONG } from '@keel-system/keel-core/gen/identity-realm';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService as planGo } from '../../keel-go/src/scaffold/index.js';
import { planService as planNest } from '../src/scaffold/index.js';
import { identitySection } from '../src/scaffold/identity-harness.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'mongodb', auth: 'keycloak' };

async function loadIdentity() {
  const { model } = planFixture('conduit', { stack: STACK });
  const source = `import fs from 'node:fs';\nimport path from 'node:path';\ntype Headers = Record<string, string>;\n${identitySection(model)}`;
  const { load } = transpileTree([{ path: 'src/identity.ts', content: source }]);
  return load('src/identity.ts');
}

test('tokenAs: un sub que no cabe en el id del usuario se rechaza con su motivo; uno que cabe sigue adelante', async (t) => {
  // Un puerto sin nadie: lo que pase la guarda falla al conectar, con otro error.
  process.env.AUTH_TOKEN_URL = 'http://127.0.0.1:9/realms/conduit/protocol/openid-connect/token';
  t.after(() => delete process.env.AUTH_TOKEN_URL);
  const { tokenAs } = await loadIdentity();
  await assert.rejects(tokenAs('x'.repeat(PERSONA_SUB_MAX + 1)), (error) => error.message.includes(PERSONA_SUB_TOO_LONG));
  await assert.rejects(tokenAs('x'.repeat(PERSONA_SUB_MAX)), (error) => !error.message.includes(PERSONA_SUB_TOO_LONG));
});

const GENERATORS = {
  'keel-spring': [planSpring, '/AbstractFlowIT.java'],
  'keel-nest': [planNest, 'test/integration/support/flow.ts'],
  'keel-dotnet': [planDotnet, '/Support/Credentials.cs'],
  'keel-go': [planGo, 'tests/integration/credentials_test.go']
};

for (const [generator, [plan, harness]] of Object.entries(GENERATORS)) {
  test(`${generator}: el arnés rechaza el sub largo y la skill da la forma de design-gaps.yaml`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'conduit'));
    const { files } = plan({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK });
    const emitted = files.find((file) => file.path.endsWith(harness));
    assert.ok(emitted, harness);
    assert.ok(emitted.content.includes(PERSONA_SUB_TOO_LONG), generator);
    assert.match(emitted.content, new RegExp(`> ${PERSONA_SUB_MAX}\\b`), generator);
    const skill = files.find((file) => file.path === `.claude/skills/keel-generate-${generator.replace('keel-', '')}/SKILL.md`);
    assert.ok(skill, 'la skill');
    assert.ok(skill.content.includes(DESIGN_GAPS_FORM), generator);
  });
}
