// `tokenAs` y `tokenWithScope` contra el EMULADOR del proveedor (incremento 4.3 de PLAN-PROVEEDOR-IDENTIDAD.md): se
// EJECUTA la sección de identidad emitida con `fetch` sustituido por uno que devuelve un token y guarda el formulario, y
// se compara la petición con la de referencia (`emulatorPersonaForm`, `emulatorScopedForm`) en los casos EMU-F-* de
// keel-core/test/helpers/emulator-form-cases.js, los mismos que ejecuta `emulator-harness-check` de keel-spring. Que el
// emulador dé el token pedido con esa petición lo mide `emulator-check` de keel-core.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IDENTITY_PROVIDERS } from '@keel-system/keel-core/gen/identity-providers';
import { personaTokenMechanism, scopedTokenMechanism } from '@keel-system/keel-core/gen/identity-realm';
import { identitySection } from '../src/scaffold/identity-harness.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { EMULATOR_FORM_SABOTAGES, emulatorFormCases, judgeEmulatorForms } from '../../keel-core/test/helpers/emulator-form-cases.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq', auth: 'cognito' };
const DESIGNS = ['shop-api', 'conduit', 'asset-vault'];

// Cada sabotaje rompe la sección emitida conservando su forma.
const BREAK = {
  'persona-shape': (source) => source.replace(`role != null ? 'role' : 'norole'`, `role != null ? 'role' : 'nobody'`),
  'scope-unsorted': (source) => source.replace('const wanted = [...new Set(values)].sort();', 'const wanted = [...new Set(values)];')
};

/** Con el emulador activado en el descriptor mientras dura `run` (Cognito lo trae apagado hasta que estén los cuatro). */
function withEmulator(run) {
  const cognito = IDENTITY_PROVIDERS.cognito;
  const saved = cognito.harness;
  cognito.harness = { personaTokens: 'emulator', scopedTokens: 'emulator' };
  try {
    return run();
  } finally {
    cognito.harness = saved;
  }
}

function plan(name) {
  return withEmulator(() => {
    const { model } = planFixture(name, { stack: STACK });
    const persona = personaTokenMechanism(model) === 'emulator';
    const role = scopedTokenMechanism(model) === 'emulator' ? model.security.roles.find((r) => !model.security.scoping.exemptRoles.includes(r)) : null;
    return { model, section: identitySection(model), cases: emulatorFormCases(model, { persona, scoped: role ? { role } : null }) };
  });
}

async function runCases(section, cases) {
  const source = `import fs from 'node:fs';\nimport path from 'node:path';\ntype Headers = Record<string, string>;\n${section}`;
  const { root } = transpileTree([{ path: 'src/identity.ts', content: source }]);
  // Un módulo nuevo por caso: con la caché del arnés, EMU-F-6 (el claim quitado) es el token de EMU-F-1 y no pediría nada.
  const fresh = (id) => import(`${pathToFileURL(path.join(root, 'src', 'identity.js')).href}?caso=${id}`);
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
  const realFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (_url, init) => {
    sent = String(init.body);
    return new Response(JSON.stringify({ access_token: `h.${payload}.${Math.random()}` }), { status: 200 });
  };
  const results = {};
  try {
    for (const c of cases) {
      sent = null;
      const identity = await fresh(c.id);
      try {
        if (c.kind === 'scoped') await identity.tokenWithScope(c.role, ...c.values);
        else await identity.tokenAs(c.sub, c.claims, c.role);
        results[c.id] = { form: sent };
      } catch (error) {
        results[c.id] = { error: error.message };
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return results;
}

for (const name of DESIGNS) {
  test(`${name}: la petición al emulador es la de referencia`, async () => {
    const { section, cases } = plan(name);
    assert.ok(cases.length > 0, `${name} no usa personas ni titulares del alcance`);
    assert.ok(!section.includes('personaAdmin'), 'con el emulador no hay API de administración del realm');
    const verdict = judgeEmulatorForms(name, cases, await runCases(section, cases));
    assert.ok(verdict.ok, verdict.lines.join('\n'));
  });
}

for (const sabotage of Object.keys(EMULATOR_FORM_SABOTAGES)) {
  test(`sabotaje ${sabotage}: cae en exactamente sus casos`, async () => {
    let hits = 0;
    for (const name of DESIGNS) {
      const { section, cases } = plan(name);
      const broken = BREAK[sabotage](section);
      const covers = EMULATOR_FORM_SABOTAGES[sabotage].filter((id) => cases.some((c) => c.id === id)).length;
      if (covers > 0) assert.notEqual(broken, section, `${name}: el sabotaje no se aplica al TypeScript de hoy`);
      hits += covers;
      const verdict = judgeEmulatorForms(name, cases, await runCases(broken, cases), sabotage);
      assert.ok(verdict.ok, verdict.lines.join('\n'));
    }
    assert.ok(hits > 0, 'ningún diseño cubre el sabotaje');
  });
}
