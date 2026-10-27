// Los clientes HTTP salientes de keel-dotnet (incremento 11b), sobre el texto emitido:
//
//   · http-clients.yaml es el MISMO texto que el de keel-nest en los cuatro perfiles (keel-core/gen/http-clients-config.js),
//     y lo que HttpClientsSettings lee son claves que ese YAML declara;
//   · la política de cada llamada (intentos, esperas, qué reintenta, el circuito) y lo que atiende su fallback son los de
//     keel-core (outbound-resilience.js), los mismos que aplican keel-spring y keel-nest;
//   · la secuencia con la que la prueba emitida recorre el circuito pasa por los tres estados y por las cuatro transiciones:
//     una secuencia que no abriera nunca no mediría nada;
//   · el handler que activa otro servidor recibe el puerto del cliente y la nota de la llamada; el que la delega en un
//     evento, no;
//   · el reparto hexagonal: el puerto y sus resultados en Domain/Clients, sin nada de infraestructura.
// Lo que ejecuta el C# (el circuito contra la referencia, la clasificación de cada desenlace, el adaptador contra un
// proveedor falso) lo mide la prueba emitida OutboundClientsTests en `npm run cs-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { circuitBreakerReference, fallbackFailures, resiliencePolicy } from '@keel-system/keel-core/gen/outbound-resilience';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { circuitScript, clientPort } from '../src/scaffold/http-clients.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const WITH_CLIENTS = ['stock-reservation', 'catalog-extended', 'asset-vault'];

const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, planner = planService) => planner({ ...design(name), workspace: FIXTURES_DIR, stack: STACK });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const plans = new Map(WITH_CLIENTS.map((name) => [name, plan(name)]));

/** Las claves de un YAML, aplanadas con ':' como las lee ServiceConfiguration. */
function flatKeys(tree, prefix = '') {
  return Object.entries(tree ?? {}).flatMap(([key, value]) =>
    value && typeof value === 'object' ? flatKeys(value, `${prefix}${key}:`) : [`${prefix}${key}`]
  );
}

test('http-clients.yaml es el de keel-nest en los cuatro perfiles, y HttpClientsSettings solo lee claves que declara', () => {
  for (const name of WITH_CLIENTS) {
    const { files } = plans.get(name);
    const nest = plan(name, planNest).files;
    for (const profile of ['local', 'develop', 'production', 'test']) {
      const suffix = `config/parameters/${profile}/http-clients.yaml`;
      assert.equal(content(files, suffix), content(nest, suffix), `${name}: ${profile}`);
    }
    const declared = new Set(flatKeys(parseYaml(content(files, 'config/parameters/local/http-clients.yaml'))));
    const settings = content(files, '/Clients/HttpClientsSettings.cs');
    const read = [...settings.matchAll(/(?:Text|BaseUrl)\(get, "([^"]+)"\)/g)].map((match) => match[1]);
    assert.ok(read.length > 0, name);
    for (const key of read) assert.ok(declared.has(key), `${name}: HttpClientsSettings lee ${key}, que http-clients.yaml no declara`);
  }
});

test('la política de cada llamada y lo que atiende su fallback son los de keel-core', () => {
  for (const [name, { files, model }] of plans) {
    for (const client of model.httpClients) {
      const adapter = content(files, `/Clients/${client.adapterClass}.cs`);
      for (const call of client.calls.filter((c) => c.method && (c.retry || c.circuitBreaker))) {
        const policy = resiliencePolicy(call);
        const literal = new RegExp(`private static readonly OutboundPolicy ${call.pascal}Policy = new OutboundPolicy\\("([^"]+)", (null|new RetrySpec\\(([^)]*)\\)), (null|new CircuitBreakerSpec\\(([^)]*)\\))\\);`).exec(adapter);
        assert.ok(literal, `${name}: ${client.id}.${call.name} sin política`);
        assert.equal(literal[1], policy.instance);
        if (policy.retry) {
          const [attempts, initial, multiplier, max, kinds] = literal[3].split(/, (?![^[]*\])/);
          assert.equal(Number(attempts), policy.retry.maxAttempts);
          assert.equal(Number(initial), policy.retry.initialDelayMs);
          assert.equal(multiplier === 'null' ? null : Number(multiplier), policy.retry.multiplier);
          assert.equal(max === 'null' ? null : Number(max), policy.retry.maxDelayMs);
          assert.deepEqual(kindsOf(kinds), policy.retry.retries);
        } else {
          assert.equal(literal[2], 'null');
        }
        if (policy.circuitBreaker) {
          const cb = policy.circuitBreaker;
          assert.deepEqual(literal[5].split(', ').map(Number), [cb.failureRateThreshold, cb.slidingWindowSize, cb.minimumNumberOfCalls, cb.waitDurationMs, cb.halfOpenCalls]);
        } else {
          assert.equal(literal[4], 'null');
        }
        const fallback = new RegExp(`ProviderFailureKind\\[\\] ${call.pascal}Fallback = (\\[[^\\]]*\\]);`).exec(adapter);
        if (fallback) {
          const expected = fallbackFailures({ circuitBreaker: Boolean(call.circuitBreaker), oauth2: client.auth?.type === 'oauth2-client-credentials' }).map((f) => f.kind);
          assert.deepEqual(kindsOf(fallback[1]), expected, `${name}: ${client.id}.${call.name}`);
        }
      }
    }
  }
});

/** `[ProviderFailureKind.Transport, ProviderFailureKind.ServerError]` → `['transport', 'server-error']`. */
function kindsOf(list) {
  return [...list.matchAll(/ProviderFailureKind\.(\w+)/g)].map((match) => match[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
}

test('la secuencia del circuito pasa por los tres estados y por sus cuatro transiciones, y es la de la referencia', () => {
  const spec = resiliencePolicy(design('stock-reservation') && plans.get('stock-reservation').model.httpClients[0].calls[0]).circuitBreaker;
  const script = circuitScript(spec, 7);
  const states = script.split(' ').map((step) => step.at(-1));
  const transitions = new Set(states.slice(1).map((state, index) => `${states[index]}${state}`).filter((pair) => pair[0] !== pair[1]));
  for (const transition of ['CO', 'OH', 'HC', 'HO']) assert.ok(transitions.has(transition), `la secuencia no recorre ${transition}: ${[...transitions]}`);
  assert.ok(script.split(' ').some((step) => step.startsWith('a0')), 'ninguna petición de paso se deniega');
  // Determinista: el mismo texto en cada build.
  assert.equal(circuitScript(spec, 7), script);
  // Y es la referencia: un circuito que abre al primer fallo diría otra cosa.
  let clock = 0;
  const strict = circuitBreakerReference({ ...spec, failureRateThreshold: 1 }, () => clock);
  const diverges = script.split(' ').some((step) => {
    const action = step.slice(0, step.indexOf(':'));
    if (action[0] === 't') clock += Number(action.slice(1));
    else if (action[0] === 'a') return strict.tryAcquire() !== (action[1] === '1');
    else strict.record(action[0] === 'f');
    return false;
  });
  assert.ok(diverges, 'la secuencia no distingue un umbral distinto');
});

test('la prueba emitida lleva cada circuito y cada reintento del diseño, y ejecuta cada llamada resiliente', () => {
  const { files, model } = plans.get('stock-reservation');
  const tests = content(files, '/OutboundClientsTests.cs');
  assert.match(tests, /ElCircuitoDiceLoMismoQueLaReferencia/);
  assert.match(tests, /\[InlineData\(200L, 2\.0, null, 1, 200L\)\]/);
  assert.match(tests, /\[InlineData\(200L, 2\.0, null, 2, 400L\)\]/);
  const client = model.httpClients[0];
  assert.match(tests, new RegExp(`${client.adapterClass}CancelStockReintentaElTransporteComoDiceSuPolitica`));
  assert.match(tests, /Assert\.Equal\(3, provider\.Requests\.Count\);/);
  assert.match(tests, /GetValues\("Idempotency-Key"\)/);
  assert.match(tests, new RegExp(`${client.adapterClass}CancelStockAbreElCircuitoYLaSiguienteNiSale`));
  assert.match(tests, /while \(provider\.Requests\.Count < 10\)/);
});

test('el puerto y sus resultados viven en Domain/Clients sin infraestructura; el adaptador, en Infrastructure/Clients', () => {
  for (const [name, { files, model }] of plans) {
    for (const client of model.httpClients) {
      const port = files.find((file) => file.path.endsWith(`.Domain/Clients/${clientPort(client)}.cs`));
      assert.ok(port, `${name}: ${clientPort(client)}`);
      assert.ok(files.some((file) => file.path.endsWith(`.Infrastructure/Clients/${client.adapterClass}.cs`)), `${name}: ${client.adapterClass}`);
    }
    for (const file of files.filter((f) => /\.Domain\/Clients\//.test(f.path))) {
      assert.doesNotMatch(file.content, /^using .*(Infrastructure|Microsoft\.|System\.Net)/m, `${name}: ${file.path}`);
      assert.doesNotMatch(file.content, /\b(JsonElement|HttpClient|ProviderFailureException)\b/, `${name}: ${file.path}`);
    }
  }
});

test('el handler que activa otro servidor por HTTP recibe su puerto y la nota de la llamada; el que lo delega en un evento, no', () => {
  const { files } = plans.get('stock-reservation');
  const sweep = content(files, '/UseCases/ReconcileReservationsCommandHandler.cs');
  assert.match(sweep, /IInventoryClient inventoryClient/);
  assert.match(sweep, /invoca await inventoryClient\.CancelStock\(\.\.\., cancellationToken\)/);
  assert.match(sweep, /onFailure: ignore/);
  const confirm = content(files, '/UseCases/ConfirmReservationCommandHandler.cs');
  assert.doesNotMatch(confirm, /IInventoryClient/);
  assert.match(confirm, /Activación inventory\.reserveStock: .*se delega publicando StockReservationRequested/s);
});

test('Program.cs registra los clientes con la configuración del perfil, y la prueba del contenedor con un proveedor que no responde', () => {
  const { files } = plans.get('stock-reservation');
  assert.match(content(files, '/Program.cs'), /builder\.Services\.AddOutboundClients\(HttpClientsSettings\.From\(configuration\)\);/);
  assert.match(content(files, '/UseCasesTests.cs'), /services\.AddOutboundClients\(HttpClientsSettings\.Unreachable\);/);
  const bare = plan('product-catalog').files;
  assert.doesNotMatch(content(bare, '/Program.cs'), /AddOutboundClients/);
  assert.ok(!bare.some((file) => /\/Clients\//.test(file.path)));
});

test('la clave saliente usa CommandSignature, que se emite aunque el diseño no tenga registro de idempotencia de entrada', () => {
  const { files } = planService({
    ...(() => {
      const { manifest, layers } = design('stock-reservation');
      for (const operation of Object.values(layers['use-cases'].operations)) delete operation.idempotency;
      return { manifest, layers };
    })(),
    workspace: FIXTURES_DIR,
    stack: STACK
  });
  assert.ok(files.some((file) => file.path.endsWith('/Support/CommandSignature.cs')));
  assert.ok(!files.some((file) => file.path.endsWith('/Idempotency/IIdempotencyStore.cs')));
  assert.match(content(files, '/Clients/OutboundIdempotency.cs'), /CommandSignature\.Of\(new object\?\[\] \{ call, payload \}\)/);
});
