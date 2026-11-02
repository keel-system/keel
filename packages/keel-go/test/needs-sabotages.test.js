// Los sabotajes de needs y OAuth2 se siguen aplicando al texto que emite hoy build, y nombran pruebas emitidas que existen. Los
// ejecuta `npm run go-check`: un sabotaje que ya no encuentra lo que buscaba no falsa nada.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { NEEDS_SABOTAGES, NEEDS_SUBJECT, applyNeedsSabotage } from './helpers/needs-sabotages.js';

const { manifest, layers } = loadService(path.join(FIXTURES_DIR, NEEDS_SUBJECT));
const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql', broker: 'kafka' } });
const emitted = [...files.find((file) => file.path.endsWith('clients/clients_test.go')).content.matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)].map((match) => match[1]);

for (const [id, sabotage] of Object.entries(NEEDS_SABOTAGES)) {
  test(`el sabotaje ${id} se aplica y nombra pruebas emitidas que existen`, () => {
    const changed = applyNeedsSabotage(sabotage, files);
    assert.notEqual(changed.find((file) => file.path === sabotage.file).content, files.find((file) => file.path === sabotage.file).content);
    assert.ok(emitted.some((name) => sabotage.expect.test(name)), id);
  });
}
