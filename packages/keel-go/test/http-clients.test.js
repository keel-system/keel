// Los clientes HTTP salientes de keel-go (incremento 11b), sobre el texto emitido:
//
//   · http-clients.yaml es el MISMO texto que el de keel-dotnet (y por él, el de keel-nest) en los cuatro perfiles, y lo
//     que lee settings.go son claves que ese YAML declara;
//   · la política de cada llamada (intentos, esperas, qué reintenta, el circuito) y lo que atiende su fallback son los de
//     keel-core (outbound-resilience.js), los mismos que aplican los otros tres;
//   · la secuencia con la que la prueba emitida recorre el circuito es la de la referencia y pasa por los tres estados;
//   · el handler que activa otro servidor recibe el puerto del cliente, cableado en Dependencies y en el arranque; el que
//     la delega en un evento, no;
//   · lo del agente y lo de build: el adaptador lleva la cabecera de código generado y ningún TODO; la política del
//     fallback va en <cliente>_fallback.go, sin ella;
//   · lo que la frontera rechaza no emite nada: go-check genera todas las fixtures saltándosela.
// Lo que ejecuta el Go (el circuito contra la referencia, la clasificación de cada desenlace, el adaptador contra un
// proveedor falso) lo mide la prueba emitida clients_test.go en `npm run go-check`, falsada con sus sabotajes.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { circuitScript, fallbackFailures, resiliencePolicy } from '@keel-system/keel-core/gen/outbound-resilience';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { GENERATED_HEADER } from '../src/lib/go-source.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const SUBJECT = 'stock-reservation';

const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, planner = planService) => planner({ ...design(name), workspace: FIXTURES_DIR, stack: STACK });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const { files, model } = plan(SUBJECT);
const clients = 'internal/infrastructure/clients/';

/** Las claves de un YAML, aplanadas con puntos como las lee config.Config. */
function flatKeys(tree, prefix = '') {
  return Object.entries(tree ?? {}).flatMap(([key, value]) => (value && typeof value === 'object' ? flatKeys(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
}

test('http-clients.yaml es el de keel-dotnet en los cuatro perfiles, y settings.go solo lee claves que declara', () => {
  const dotnet = plan(SUBJECT, planDotnet).files;
  for (const profile of ['local', 'develop', 'production', 'test']) {
    const suffix = `config/parameters/${profile}/http-clients.yaml`;
    assert.ok(content(files, suffix), profile);
    assert.equal(content(files, suffix), content(dotnet, suffix), profile);
  }
  const declared = new Set(flatKeys(parseYaml(content(files, 'config/parameters/local/http-clients.yaml'))));
  const settings = content(files, `${clients}settings.go`);
  const read = [
    ...[...settings.matchAll(/text\(value, "([^"]+)"\)/g)].map((match) => match[1]),
    ...model.httpClients.map((client) => (settings.includes(`clientOf(value, "${client.id}"`) ? `http-clients.${client.id}.base-url` : null))
  ];
  assert.ok(read.length > 0);
  for (const key of read) assert.ok(key && declared.has(key), `settings.go lee ${key}, que http-clients.yaml no declara`);
});

test('la política de cada llamada y lo que atiende su fallback son los de keel-core', () => {
  for (const client of model.httpClients) {
    const adapter = content(files, `${clients}${client.id}_adapter.go`);
    for (const call of client.calls) {
      const policy = resiliencePolicy(call);
      const literal = adapter.match(new RegExp(`var \\w+${call.pascal}Policy = Policy\\{([\\s\\S]*?)\\n\\}`))?.[1];
      assert.ok(literal, `${client.id}.${call.name}: sin política`);
      assert.match(literal, new RegExp(`Instance: +"${policy.instance}"`));
      if (policy.retry) {
        assert.match(literal, new RegExp(`MaxAttempts: ${policy.retry.maxAttempts}, InitialDelay: ${policy.retry.initialDelayMs} \\* time\\.Millisecond`));
        const retries = policy.retry.retries.map((kind) => `Kind${kind.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`).join(', ');
        assert.match(literal, new RegExp(`Retries: \\[\\]FailureKind\\{${retries}\\}`));
      }
      const cb = policy.circuitBreaker;
      if (cb) {
        assert.match(
          literal,
          new RegExp(`FailureRateThreshold: ${cb.failureRateThreshold}, SlidingWindowSize: ${cb.slidingWindowSize}, MinimumNumberOfCalls: ${cb.minimumNumberOfCalls}, WaitDuration: ${cb.waitDurationMs} \\* time\\.Millisecond, HalfOpenCalls: ${cb.halfOpenCalls}`)
        );
      }
      const fallback = adapter.match(new RegExp(`var \\w+${call.pascal}Fallback = \\[\\]FailureKind\\{([^}]*)\\}`))?.[1];
      const expected = fallbackFailures({ circuitBreaker: Boolean(call.circuitBreaker) }).map((failure) => `Kind${failure.kind.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`);
      assert.deepEqual(fallback?.split(', '), expected, `${client.id}.${call.name}`);
    }
  }
});

test('la prueba emitida recorre el circuito con la secuencia de la referencia, que pasa por los tres estados', () => {
  const emitted = content(files, `${clients}clients_test.go`);
  const cb = resiliencePolicy(model.httpClients[0].calls[0]).circuitBreaker;
  const script = circuitScript(cb, 7);
  assert.ok(emitted.includes(JSON.stringify(script)), 'la secuencia no es la de circuitScript');
  for (const state of [':C', ':O', ':H']) assert.ok(script.includes(state), state);
  // Una secuencia que no cerrara después de abrir no mediría la vuelta.
  assert.match(script, /:O[\s\S]*:H[\s\S]*:C/);
});

test('el handler que activa otro servidor por HTTP recibe el puerto, cableado en Dependencies y en el arranque; el del evento, no', () => {
  const handler = content(files, 'internal/application/reconcile_reservations_command_handler.go');
  assert.match(handler, /inventoryClient domain\.InventoryClient/);
  assert.match(handler, /invoca h\.inventoryClient\.CancelStock\(ctx, \.\.\.\)/);
  const viaEvent = content(files, 'internal/application/confirm_reservation_command_handler.go');
  assert.doesNotMatch(viaEvent, /InventoryClient/);
  assert.match(viaEvent, /se delega publicando StockReservationRequested/);
  const useCases = content(files, 'internal/application/use_cases.go');
  assert.match(useCases, /InventoryClient domain\.InventoryClient/);
  assert.match(useCases, /NewReconcileReservationsCommandHandler\(deps\.ReservationRepository, deps\.InventoryClient\)/);
  const main = content(files, 'cmd/server/main.go');
  assert.match(main, /clients\.SettingsFrom\(cfg\)/);
  assert.match(main, /inventoryClient, err := clients\.NewInventoryHTTPAdapter\(clientSettings, exchange, logger\)/);
  assert.match(main, /InventoryClient: +inventoryClient,/);
});

test('el puerto y sus resultados viven en el dominio, sin nada de infraestructura', () => {
  const port = content(files, 'internal/domain/inventory_client.go');
  assert.match(port, /type InventoryClient interface \{/);
  assert.match(port, /CancelStock\(ctx context\.Context, orderID uuid\.UUID\) \(CancelStockResult, error\)/);
  assert.match(port, /type CancelStockResult struct \{\n\tCancelled \*bool\n\}/);
  const imports = port.match(/^import \(([\s\S]*?)\)/m)?.[1] ?? '';
  assert.doesNotMatch(imports, /net\/http|infrastructure/);
});

test('el adaptador es de build y no lleva un TODO; la política del fallback es del agente y nace escrita si el diseño la decide', () => {
  const adapter = content(files, `${clients}inventory_adapter.go`);
  assert.ok(adapter.startsWith(GENERATED_HEADER));
  assert.doesNotMatch(adapter, /TODO/);
  const fallback = content(files, `${clients}inventory_fallback.go`);
  assert.ok(!fallback.includes(GENERATED_HEADER), 'el fallback es del agente');
  // onFailure: ignore — el llamante sigue adelante con el resultado vacío y sin error.
  assert.match(fallback, /onFailure: ignore/);
  assert.match(fallback, /return domain\.CancelStockResult\{\}, nil/);
  assert.doesNotMatch(fallback, /TODO/);
  for (const file of files.filter((candidate) => candidate.path.startsWith(clients) && candidate.content.startsWith(GENERATED_HEADER))) {
    assert.doesNotMatch(file.content, /TODO \(agente\)/, file.path);
  }
});

test('lo que la frontera rechaza no emite clientes: go-check genera todas las fixtures saltándosela', () => {
  for (const name of ['catalog-extended', 'asset-vault']) {
    const { files: rejected } = plan(name);
    assert.ok(!rejected.some((file) => file.path.startsWith(clients)), name);
    assert.ok(!rejected.some((file) => file.path.endsWith('http-clients.yaml')), name);
  }
});
