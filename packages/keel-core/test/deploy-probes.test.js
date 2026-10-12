// Las preguntas al backend de deploy/ que comparten los deploy-check de los dos generadores
// (keel-core/gen/deploy-probes.js), EJECUTADAS contra un Grafana falso de node:http: lo que responde un backend sano y
// lo que responde cuando el contacto se provisionó con la variable sin resolver, que es el fallo sin ningún síntoma.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ALERTING } from '../src/lib/gen/infra-catalog.js';
import { DEPLOY_CASES, probeDeployBackend, trafficPath } from '../src/lib/gen/deploy-probes.js';

function fakeGrafana({ contactUrl }) {
  let delivered = 0;
  const json = (response, body, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    const route = url.pathname;
    if (route === '/api/datasources') return json(response, [{ type: 'prometheus', uid: 'prom' }, { type: 'tempo', uid: 'tempo' }, { type: 'loki', uid: 'loki' }]);
    if (route === '/api/datasources/proxy/uid/prom/api/v1/query') {
      return json(response, { data: { result: [{ metric: { service_name: 'job-dispatch', keel_outcome: 'error' }, value: [0, '5'] }] } });
    }
    if (route === '/api/datasources/proxy/uid/prom/api/v1/query_exemplars') {
      return json(response, { data: [{ exemplars: [{ labels: { trace_id: 'abc123' } }] }] });
    }
    if (route === '/api/datasources/proxy/uid/tempo/api/traces/abc123') return json(response, { batches: [{}] });
    if (route === '/api/datasources/proxy/uid/loki/loki/api/v1/query_range') return json(response, { data: { result: [{ values: [['1', 'línea']] }] } });
    if (route === '/api/dashboards/uid/keel-job-dispatch') return json(response, { dashboard: {} });
    if (route === '/api/v1/provisioning/alert-rules' && request.method === 'GET') {
      return json(response, [{ uid: 'keel-job-dispatch-errors', ruleGroup: 'job-dispatch', folderUID: 'f' }]);
    }
    if (route === '/api/v1/provisioning/alert-rules' && request.method === 'POST') {
      // La alerta dispara y, si el contacto tiene una url de verdad, llega al sumidero.
      if (!contactUrl.includes('$__env')) delivered += 1;
      return json(response, { uid: 'probe' }, 201);
    }
    if (route.startsWith('/api/v1/provisioning/alert-rules/')) return json(response, {});
    if (route === '/api/v1/provisioning/policies') return json(response, { receiver: ALERTING.contactPoint });
    if (route === '/api/v1/provisioning/contact-points') return json(response, [{ name: ALERTING.contactPoint, settings: { url: contactUrl } }]);
    if (route === '/__admin/requests') return json(response, { requests: Array.from({ length: delivered }, () => ({ url: ALERTING.sink.path })) });
    return json(response, { message: 'no existe' }, 404);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

async function probe(contactUrl) {
  const grafana = await fakeGrafana({ contactUrl });
  const results = {};
  try {
    await probeDeployBackend({ grafanaUrl: grafana.url, sinkUrl: grafana.url, serviceName: 'job-dispatch', record: (id, ok, detail) => (results[id] = { ok, detail }) });
  } finally {
    grafana.close();
  }
  return results;
}

test('un backend sano: DEP-2 a DEP-8 en verde', async () => {
  const results = await probe('http://alert-sink:8080/alerts');
  assert.deepEqual(Object.keys(results).sort(), DEPLOY_CASES.map((item) => item.id).filter((id) => id !== 'DEP-1').sort());
  for (const [id, { ok, detail }] of Object.entries(results)) assert.ok(ok, `${id}: ${detail}`);
});

test('el contacto con la variable sin resolver es un rojo de DEP-8, aunque las alertas estén cargadas', async () => {
  const results = await probe(`$__env{${ALERTING.webhookVar}}`);
  assert.equal(results['DEP-7'].ok, true);
  assert.equal(results['DEP-8'].ok, false);
  assert.match(results['DEP-8'].detail, /sin resolver/);
});

test('el tráfico: el primer GET del diseño, con sus segmentos sustituidos', () => {
  const model = {
    api: { routeBase: '/api/v1' },
    services: [{ operations: [{ route: { method: 'POST', path: '/jobs' } }, { route: { method: 'GET', path: '/jobs/{id}' } }] }]
  };
  assert.equal(trafficPath(model), '/api/v1/jobs/11111111-1111-1111-1111-111111111111');
  assert.equal(trafficPath({ api: { routeBase: '/x' }, services: [{ operations: [{ route: { method: 'POST', path: '/a' } }] }] }), null);
});
