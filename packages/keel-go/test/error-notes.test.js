// La nota del handler dice lo que ESTA operación declara de un error. Un mismo code puede llevar otro `http` y otro `when` en otra
// operación, y la nota llevaba los de la primera que lo declaró: en notification-mailer, TEMPLATE_NOT_FOUND salía como 404 en
// requestNotification, donde el diseño dice 422 (las dos corridas de control de keel-go, 2026-11-03). Los cuatro generadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planGo } from '../src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const GENERATORS = { 'keel-go': planGo, 'keel-dotnet': planDotnet, 'keel-nest': planNest, 'keel-spring': planSpring };

/** Lo que cada operación del diseño declara de sus errores, leído del YAML. */
function declared(fixture) {
  const { layers } = loadService(path.join(FIXTURES_DIR, fixture));
  return Object.entries(layers['use-cases'].operations).flatMap(([operation, spec]) => (spec.errors ?? []).map((error) => ({ operation, ...error })));
}

const compact = (text) => text.replace(/\/\/\s?|\*\s?|\s+/g, ' ').replace(/\s+/g, ' ');

for (const [generator, plan] of Object.entries(GENERATORS)) {
  for (const fixture of ['notification-mailer', 'catalog-extended', 'shop-api']) {
    test(`${generator}, ${fixture}: la nota de cada handler lleva el http y el when que declara SU operación`, () => {
      const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
      const { files } = plan({ manifest, layers, workspace: FIXTURES_DIR });
      for (const { operation, code, http, when } of declared(fixture)) {
        const flat = operation.toLowerCase();
        const handler = files.find((file) => /handler/i.test(path.basename(file.path)) && path.basename(file.path).replace(/[-_]/g, '').toLowerCase().startsWith(flat));
        assert.ok(handler, `${operation}: no se encuentra su handler`);
        const text = compact(handler.content);
        assert.ok(text.includes(`(${code}, HTTP ${http ?? 400})`), `${operation}: la nota de ${code} no dice HTTP ${http ?? 400}`);
        if (when) assert.ok(text.includes(compact(when)), `${operation}: la nota de ${code} no lleva su when: ${when}`);
      }
    });
  }
}

test('keel-go: con el status por operación, la nota le pasa a StatusErrorf el de esa operación', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'notification-mailer'));
  const { files } = planGo({ manifest, layers, workspace: FIXTURES_DIR });
  const handler = (name) => files.find((file) => file.path.endsWith(`/${name}_handler.go`)).content;
  assert.ok(handler('request_notification_command').includes('domain.StatusErrorf(domain.ErrTemplateNotFound, 422, "…")'));
  assert.ok(handler('publish_template_command').includes('domain.StatusErrorf(domain.ErrTemplateNotFound, 404, "…")'));
});
