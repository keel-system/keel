// Lo saliente que EMITE keel-spring es lo que declara keel-core, para que el servidor de keel-nest del
// mismo diseño haga lo mismo:
//
//   · la resiliencia (`keel-core/gen/outbound-resilience.js`): qué reintenta el retry, qué cuenta el
//     circuito, qué atiende el fallback y con qué números, en el YAML de resilience4j y en las
//     sobrecargas del adaptador;
//   · el almacén de la reconciliación (`keel-core/gen/reconciliation-stores.js`): la tabla
//     `reconciliation_claim` —nombre, columnas, cota, clave e índice— en las dos ramas, y los
//     parámetros del barrido y de su purga —clave, variable y default— en el YAML de cada perfil y en
//     el respaldo de los @Value.
//
// La tabla y el YAML siguen escritos a mano en keel-spring; esto es lo que impide que se separen de
// los datos que keel-nest emitirá.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { PROVIDER_FAILURES, fallbackFailures, recordedFailures, resiliencePolicy } from 'keel-core/gen/outbound-resilience';
import {
  RECONCILIATION_CLAIM,
  RECONCILIATION_PURGE,
  reconciledActivations,
  reconciliationClaimDocumentId,
  reconciliationParameters
} from 'keel-core/gen/reconciliation-stores';
import { buildModel } from '../src/lib/model.js';
import { exceptionFor, ignoredExceptions, providerFailures } from '../src/lib/outbound-failures.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

// La reconciliación en sus dos ramas: relacional (stock-reservation) y documental (asset-vault).
const RELATIONAL = 'stock-reservation';
const DOCUMENT = 'asset-vault';
const PROFILES = ['local', 'develop', 'production'];

function load(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return {
    files: planService({ manifest, layers, workspace: FIXTURES_DIR }).files,
    model: buildModel({ manifest, layers })
  };
}

function javaFile(files, className) {
  const file = files.find((f) => f.path.endsWith(`/${className}.java`));
  assert.ok(file, `keel-spring emite ${className}`);
  return file.content;
}

function yamlOf(files, profile, name) {
  const file = files.find((f) => f.path.endsWith(`parameters/${profile}/${name}.yaml`));
  assert.ok(file, `parameters/${profile}/${name}.yaml`);
  return parseYaml(file.content);
}

const at = (yaml, key) => key.split('.').reduce((node, segment) => node?.[segment], yaml);
const allJava = (files) => files.filter((f) => f.path.endsWith('.java')).map((f) => f.content).join('\n');

// ─── Resiliencia ─────────────────────────────────────────────────────────────

test('cada fallo neutral del proveedor tiene su excepción de Spring, y ninguna se repite', () => {
  const fqns = Object.values(PROVIDER_FAILURES).map((failure) => exceptionFor(failure.kind));
  assert.equal(new Set(fqns).size, fqns.length);
  assert.throws(() => exceptionFor('desconocido'), /sin excepción Java/);
  // Las sobrecargas del fallback son las de la tabla neutral, en su orden.
  for (const options of [{}, { circuitBreaker: true, oauth2: true }]) {
    assert.deepEqual(
      providerFailures(options).map((failure) => failure.fqn),
      fallbackFailures(options).map((failure) => exceptionFor(failure.kind))
    );
  }
});

for (const name of [RELATIONAL, DOCUMENT]) {
  test(`${name}: el retry y el circuito de resilience4j son la política de keel-core`, () => {
    const { files, model } = load(name);
    const calls = model.httpClients.flatMap((client) => client.calls).filter((call) => call.retry || call.circuitBreaker);
    assert.ok(calls.length > 0, 'la fixture declara resiliencia');
    for (const profile of PROFILES) {
      const yaml = yamlOf(files, profile, 'http-clients');
      for (const call of calls) {
        const policy = resiliencePolicy(call);
        if (policy.retry) {
          const retry = yaml.resilience4j.retry.instances[call.instanceName];
          assert.equal(retry['max-attempts'], policy.retry.maxAttempts);
          assert.equal(retry['wait-duration'], `${policy.retry.initialDelayMs}ms`);
          assert.equal(retry['exponential-backoff-multiplier'] ?? null, policy.retry.multiplier);
          assert.deepEqual(retry['retry-exceptions'], policy.retry.retries.map(exceptionFor));
          assert.deepEqual(retry['ignore-exceptions'], ignoredExceptions());
        }
        if (policy.circuitBreaker) {
          const cb = yaml.resilience4j.circuitbreaker.instances[call.instanceName];
          assert.equal(cb['failure-rate-threshold'], policy.circuitBreaker.failureRateThreshold);
          assert.equal(cb['sliding-window-size'], policy.circuitBreaker.slidingWindowSize);
          assert.equal(cb['wait-duration-in-open-state'], `${policy.circuitBreaker.waitDurationMs}ms`);
          assert.deepEqual(cb['record-exceptions'], recordedFailures().map((failure) => exceptionFor(failure.kind)));
          // El mínimo de llamadas y el muestreo del semiabierto de la política neutral son los defaults de
          // resilience4j (100 acotado a la ventana, y 10): si keel-spring los fijara, dejarían de coincidir.
          assert.equal(cb['minimum-number-of-calls'], undefined);
          assert.equal(cb['permitted-number-of-calls-in-half-open-state'], undefined);
          assert.equal(cb['sliding-window-type'], undefined, 'la ventana es por CONTEO, la de por defecto');
          assert.equal(policy.circuitBreaker.halfOpenCalls, 10);
          assert.equal(policy.circuitBreaker.minimumNumberOfCalls, Math.min(100, policy.circuitBreaker.slidingWindowSize));
        }
      }
    }
  });
}

// ─── Reconciliación ──────────────────────────────────────────────────────────

test(`${RELATIONAL}: reconciliation_claim es la de keel-core`, () => {
  const { files } = load(RELATIONAL);
  const content = javaFile(files, 'ReconciliationClaimJpa');
  assert.match(content, new RegExp(`@Table\\(name = "${RECONCILIATION_CLAIM.table}"`));
  const columns = new Map();
  for (const m of content.matchAll(/@Column\(name = "([^"]+)"([^)]*)\)\s+private (\w+) \w+;/g)) {
    const length = /length = (\d+)/.exec(m[2])?.[1];
    columns.set(m[1], { nullable: !/nullable = false/.test(m[2]), length: length ? Number(length) : null, type: m[3] });
  }
  assert.deepEqual([...columns.keys()].sort(), RECONCILIATION_CLAIM.columns.map((c) => c.name).sort());
  for (const column of RECONCILIATION_CLAIM.columns) {
    const have = columns.get(column.name);
    assert.equal(have.nullable, column.nullable, `${column.name}: nulabilidad`);
    if (column.base === 'string') assert.equal(have.length, column.length, `${column.name}: cota`);
    if (column.base === 'uuid') assert.equal(have.type, 'UUID', `${column.name}: uuid`);
  }
  // La clave compuesta es la del @Embeddable que hace de @EmbeddedId.
  const embeddable = content.slice(content.indexOf('@Embeddable'));
  assert.deepEqual(
    [...embeddable.matchAll(/@Column\(name = "([^"]+)"/g)].map((m) => m[1]),
    RECONCILIATION_CLAIM.columns.filter((c) => c.primary).map((c) => c.name)
  );
  assert.deepEqual(
    [...content.matchAll(/@Index\(name = "([^"]+)", columnList = "([^"]+)"\)/g)].map((m) => ({ name: m[1], columns: m[2].split(',').map((c) => c.trim()) })),
    RECONCILIATION_CLAIM.indexes
  );
});

test(`${DOCUMENT}: la colección del reclamo lleva los campos de keel-core y el _id aplanado igual`, () => {
  const { files } = load(DOCUMENT);
  const content = javaFile(files, 'ReconciliationClaimDocument');
  assert.match(content, new RegExp(`@Document\\(collection = "${RECONCILIATION_CLAIM.table}"\\)`));
  assert.deepEqual(
    [...content.matchAll(/@Field\(name = "([^"]+)"\)/g)].map((m) => m[1]).sort(),
    RECONCILIATION_CLAIM.columns.map((c) => c.name).sort()
  );
  // El separador del _id compuesto: el mismo que el de keel-core, o los dos servidores no se verían las marcas.
  const separator = /return activation \+ "([^"]*)" \+ entityId;/.exec(content)?.[1];
  assert.equal(`a${separator}b`, reconciliationClaimDocumentId('a', 'b'));
});

for (const name of [RELATIONAL, DOCUMENT]) {
  test(`${name}: los parámetros del barrido están en el YAML de cada perfil, con su variable, y en los @Value`, () => {
    const { files, model } = load(name);
    const reconciled = reconciledActivations(model);
    assert.ok(reconciled.length > 0, 'la fixture declara reconciledBy');
    const java = allJava(files);
    for (const { activation, sweeper } of reconciled) {
      const parameters = reconciliationParameters(activation, sweeper);
      for (const profile of PROFILES) {
        const yaml = yamlOf(files, profile, 'reconciliation');
        for (const parameter of Object.values(parameters)) {
          const want = profile === 'local' ? parameter.default : `\${${parameter.env}:${parameter.default}}`;
          assert.equal(String(at(yaml, parameter.key)), String(want), `${profile}: ${parameter.key}`);
        }
      }
      // El reclamo generado (si build pudo) lee las mismas claves con los mismos defaults.
      const claim = model.services.flatMap((s) => s.operations).flatMap((op) => op.reconciles ?? []).find((r) => r.claim?.activation === activation.name)?.claim;
      if (claim) {
        assert.deepEqual(claim.parameters, parameters);
        for (const parameter of Object.values(parameters)) {
          assert.ok(java.includes(`\${${parameter.key}:${parameter.default}}`), `@Value ${parameter.key}`);
        }
      }
    }
    for (const parameter of Object.values(RECONCILIATION_PURGE)) {
      assert.ok(javaFile(files, 'ReconciliationClaimPurge').includes(`\${${parameter.key}:${parameter.default}}`), parameter.key);
    }
  });
}
