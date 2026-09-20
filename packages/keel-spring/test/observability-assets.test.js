// El panel y las alertas que emite `build` con `telemetry: otel`.
//
// Lo que se fija aquí es lo que no se ve leyendo un archivo suelto, y todo sale del mismo defecto:
// una consulta puede nombrar una serie que nadie publica. Eso no falla —una alerta así **no
// dispara nunca**—, así que el test más valioso del archivo es el que cruza cada nombre de métrica
// de cada consulta contra el vocabulario del que sale el código.
//
// Lo segundo: las rutas de provisioning aparecen en dos sitios (el montaje del compose y el
// archivo del proveedor). Con dos copias, la que se quede atrás deja a Grafana arrancando sin
// decir nada y con el panel ausente — el fallo se ve en la interfaz, no en ningún log.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { GRAFANA_PROVISIONING, OBSERVABILITY_DIR } from '../src/lib/stack-catalog.js';
import { ATTRIBUTES, OBSERVATIONS, promGauge, promMetric, promTag } from '../src/lib/telemetry-probes.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function generate(fixture, stack) {
  const { manifest, layers } = loadService(path.join(fixturesDir, fixture));
  const workspace = tmpDir('keel-observability-');
  const result = scaffoldService({ manifest, layers, workspace, force: true, stack });
  const root = path.join(workspace, result.outDir);
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const has = (rel) => fs.existsSync(path.join(root, rel));
  return { root, read, has };
}

const DASHBOARD = (slug) => `deploy/${OBSERVABILITY_DIR}/dashboards/${slug}.json`;
const ALERTS = `deploy/${OBSERVABILITY_DIR}/alerting/keel-alerts.yaml`;
const PROVIDER = `deploy/${OBSERVABILITY_DIR}/dashboards-provisioning.yaml`;

test('panel y alertas: no existen sin telemetría', () => {
  const sin = generate('asset-vault', {});
  assert.equal(sin.has(DASHBOARD('asset-vault')), false);
  assert.equal(sin.has(ALERTS), false);
  assert.equal(sin.has(PROVIDER), false);
  assert.equal(sin.has('deploy/otel/out/.gitkeep'), false);
});

test('panel: parsea, su uid es estable y dos builds del mismo diseño dan el mismo byte', () => {
  const uno = generate('asset-vault', { telemetry: 'otel' });
  const otro = generate('asset-vault', { telemetry: 'otel' });
  const json = uno.read(DASHBOARD('asset-vault'));
  assert.equal(json, otro.read(DASHBOARD('asset-vault')), 'el panel no es determinista');
  const panel = JSON.parse(json);
  assert.equal(panel.uid, 'keel-asset-vault');
  // Sin timestamps: build se ejecuta muchas veces sobre el mismo diseño.
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(json), 'el panel lleva una marca de tiempo');
});

test('panel: solo trae las filas de los subsistemas que el diseño declara', () => {
  const conStorage = generate('asset-vault', { telemetry: 'otel' });
  const filas = (proyecto, slug) =>
    JSON.parse(proyecto.read(DASHBOARD(slug)))
      .panels.filter((panel) => panel.type === 'row')
      .map((panel) => panel.title);

  const deAssetVault = filas(conStorage, 'asset-vault');
  assert.ok(deAssetVault.includes('Almacenamiento'), 'asset-vault declara storage');
  assert.ok(deAssetVault.includes('Caché'), 'asset-vault usa caché');
  assert.ok(!deAssetVault.includes('Correo'), 'asset-vault no declara mail');

  const conCorreo = generate('notification-mailer', { telemetry: 'otel' });
  const deMailer = filas(conCorreo, 'notification-mailer');
  assert.ok(deMailer.includes('Correo'), 'notification-mailer declara mail');
  assert.ok(!deMailer.includes('Almacenamiento'), 'notification-mailer no declara storage');
  assert.ok(!deMailer.includes('Caché'), 'notification-mailer no usa caché');
});

// El test que caza la alerta que consulta lo que nadie publica. Cada nombre de serie de cada
// consulta tiene que derivarse de una observación o del gauge del outbox, que son los nombres con
// los que el CÓDIGO las registra: el panel y el servidor no pueden tener dos vocabularios.
test('panel y alertas: cada serie consultada la publica el servidor', () => {
  const proyecto = generate('asset-vault', { telemetry: 'otel' });
  const publicadas = new Set([
    ...Object.values(OBSERVATIONS).flatMap((observation) => Object.values(promMetric(observation))),
    promGauge('keel.outbox.dead_lettered'),
    // De Spring Boot, no nuestras.
    ...Object.values(promMetric('http.server.requests')),
    'cache_gets_total'
  ]);

  const consultas = [];
  for (const panel of JSON.parse(proyecto.read(DASHBOARD('asset-vault'))).panels) {
    for (const target of panel.targets ?? []) consultas.push(target.expr);
  }
  for (const grupo of YAML.parse(proyecto.read(ALERTS)).groups) {
    for (const regla of grupo.rules) {
      for (const dato of regla.data) if (dato.model?.expr) consultas.push(dato.model.expr);
    }
  }
  assert.ok(consultas.length >= 8, `pocas consultas para ser un panel: ${consultas.length}`);

  // Las ETIQUETAS comparten el prefijo `keel_` con las series y no son series: salen del mismo
  // vocabulario, así que se descartan desde ahí y no con una lista escrita a mano.
  const etiquetas = new Set([...Object.values(ATTRIBUTES).map(promTag), 'status', 'uri', 'cache', 'le', 'result']);

  for (const expr of consultas) {
    for (const nombre of expr.match(/\b[a-z][a-z0-9_]*\b/g) ?? []) {
      // Solo se juzgan los nombres que PARECEN una serie nuestra o de Boot; las funciones de
      // PromQL caen fuera por el prefijo, y las etiquetas por el vocabulario.
      if (!nombre.startsWith('keel_') && !nombre.startsWith('http_') && !nombre.startsWith('cache_')) continue;
      if (etiquetas.has(nombre)) continue;
      assert.ok(publicadas.has(nombre), `la consulta cita '${nombre}', que nadie publica:\n  ${expr}`);
    }
  }
});

test('alertas: la del outbox solo se emite si el diseño lo declara', () => {
  const conOutbox = generate('asset-vault', { telemetry: 'otel' });
  const titulos = (proyecto) => YAML.parse(proyecto.read(ALERTS)).groups[0].rules.map((regla) => regla.title);
  assert.equal(titulos(conOutbox).length, 3);
  assert.ok(titulos(conOutbox).some((titulo) => titulo.includes('outbox')));

  // product-catalog no declara messaging, así que no hay outbox del que hablar.
  const sinOutbox = generate('product-catalog', { telemetry: 'otel' });
  assert.equal(titulos(sinOutbox).length, 2);
  assert.ok(!titulos(sinOutbox).some((titulo) => titulo.includes('outbox')));
});

test('provisioning: las rutas del montaje, del proveedor y de los archivos dicen lo mismo', () => {
  const proyecto = generate('asset-vault', { telemetry: 'otel' });
  const compose = YAML.parse(proyecto.read('deploy/docker-compose.yaml'));
  const volumenes = compose.services.lgtm.volumes;

  // El proveedor apunta al directorio de DENTRO del contenedor donde el compose monta los paneles.
  const provider = YAML.parse(proyecto.read(PROVIDER));
  assert.equal(provider.providers[0].options.path, GRAFANA_PROVISIONING.dashboardsDir);
  assert.ok(
    volumenes.some((volumen) => volumen.endsWith(`:${GRAFANA_PROVISIONING.dashboardsDir}:ro`)),
    `el compose no monta ${GRAFANA_PROVISIONING.dashboardsDir}: ${volumenes.join(' | ')}`
  );
  assert.ok(volumenes.some((volumen) => volumen.endsWith(`:${GRAFANA_PROVISIONING.provider}:ro`)));
  assert.ok(volumenes.some((volumen) => volumen.endsWith(`:${GRAFANA_PROVISIONING.alerting}:ro`)));

  // Y el lado del host: cada montaje sale de un archivo que build acaba de escribir.
  for (const volumen of volumenes) {
    const origen = volumen.split(':')[0].replace(/^\.\//, '');
    assert.ok(proyecto.has(`deploy/${origen}`), `el compose monta deploy/${origen}, que no se generó`);
  }
});

test('backend de prueba: el Prometheus de la imagen guarda los exemplars', () => {
  const proyecto = generate('asset-vault', { telemetry: 'otel' });
  const compose = YAML.parse(proyecto.read('deploy/docker-compose.yaml'));
  // Sin el flag, el Prometheus de la imagen ACEPTA los exemplars y los tira: no hay error, no hay
  // log, y el panel sale con los puntos de latencia y sin el salto a la traza.
  assert.match(compose.services.lgtm.environment.PROMETHEUS_EXTRA_ARGS, /exemplar-storage/);
});
