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
import { ALERTING, GRAFANA_PROVISIONING, OBSERVABILITY_DIR } from '../src/lib/stack-catalog.js';
import {
  ATTRIBUTES,
  CONSUMER_LAG,
  OBSERVATIONS,
  promGauge,
  promMetric,
  promTag,
  runtimePool,
  runtimeSeries
} from '../src/lib/telemetry-probes.js';

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
    'cache_gets_total',
    // Runtime: las dos ramas, porque este mismo cruce corre sobre proyectos de los dos modelos.
    ...runtimeSeries('relational'),
    ...runtimeSeries('document'),
    // Y el retraso del consumidor, que solo publica un broker.
    ...Object.values(CONSUMER_LAG).map((entry) => entry.series).filter(Boolean)
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
      // Los prefijos del runtime entran aquí o las series nuevas no las juzga NADIE: el filtro
      // deja pasar lo que no reconoce, así que un `jvm_memory_used_byte` sin la ese final se
      // colaría igual que se colaba antes de que existieran estas filas.
      const prefijos = ['keel_', 'http_', 'cache_', 'jvm_', 'process_', 'hikaricp_', 'mongodb_', 'kafka_'];
      if (!prefijos.some((prefijo) => nombre.startsWith(prefijo))) continue;
      if (etiquetas.has(nombre)) continue;
      assert.ok(publicadas.has(nombre), `la consulta cita '${nombre}', que nadie publica:\n  ${expr}`);
    }
  }
});

const titulos = (proyecto) => YAML.parse(proyecto.read(ALERTS)).groups[0].rules.map((regla) => regla.title);

test('alertas: cada una se emite solo si su sujeto existe en el diseño', () => {
  const conOutbox = generate('asset-vault', { telemetry: 'otel' });
  assert.ok(titulos(conOutbox).some((titulo) => titulo.includes('outbox')));

  // product-catalog no declara messaging, así que no hay outbox del que hablar.
  const sinOutbox = generate('product-catalog', { telemetry: 'otel' });
  assert.ok(!titulos(sinOutbox).some((titulo) => titulo.includes('outbox')));

  // Las del runtime van en los dos: el heap siempre, el pool mientras haya persistencia.
  for (const proyecto of [conOutbox, sinOutbox]) {
    assert.ok(titulos(proyecto).some((titulo) => titulo.includes('heap')), 'falta la alerta de heap');
    assert.ok(titulos(proyecto).some((titulo) => titulo.includes('pool')), 'falta la alerta del pool');
  }
});

// El runtime es la fila a la que se baja cuando algo va lento, y su pool BIFURCA por modelo de
// persistencia. Las celdas de Hikari en un proyecto documental no fallan: se quedan vacías justo
// ahí, que es la forma que tenían las ocho asimetrías silenciosas de la matriz.
test('panel: la fila de runtime enseña el pool del modelo de persistencia de cada rama', () => {
  const consultasDeLaFila = (proyecto, slug, fila) => {
    const panel = JSON.parse(proyecto.read(DASHBOARD(slug)));
    const indice = panel.panels.findIndex((item) => item.type === 'row' && item.title === fila);
    assert.ok(indice >= 0, `no hay fila '${fila}'`);
    const siguiente = panel.panels.findIndex((item, posicion) => posicion > indice && item.type === 'row');
    return panel.panels
      .slice(indice + 1, siguiente === -1 ? undefined : siguiente)
      .flatMap((item) => (item.targets ?? []).map((target) => target.expr));
  };

  const documental = consultasDeLaFila(generate('asset-vault', { telemetry: 'otel' }), 'asset-vault', 'Runtime');
  const relacional = consultasDeLaFila(
    generate('notification-mailer', { telemetry: 'otel' }),
    'notification-mailer',
    'Runtime'
  );

  for (const consultas of [documental, relacional]) {
    assert.ok(consultas.some((expr) => expr.includes('jvm_memory_used_bytes')), 'la fila no enseña el heap');
  }
  assert.ok(
    relacional.some((expr) => expr.includes(runtimePool('relational').saturation)),
    'la rama relacional no enseña el pool de Hikari'
  );
  assert.ok(
    documental.some((expr) => expr.includes(runtimePool('document').saturation)),
    'la rama documental no enseña el pool del driver de Mongo'
  );
  // Y ninguna enseña el de la otra, que es la mitad que de verdad caza la asimetría.
  assert.ok(!documental.some((expr) => expr.includes('hikaricp')), 'un proyecto documental no tiene Hikari');
  assert.ok(!relacional.some((expr) => expr.includes('mongodb_driver')), 'un proyecto relacional no tiene driver de Mongo');
});

// El retraso solo lo publica Kafka desde la aplicación. Con los otros dos brokers, una fila aquí
// no fallaría: se quedaría vacía, y la alerta no dispararía nunca.
test('panel y alertas: el retraso del consumidor solo existe con el broker que lo publica', () => {
  const conLag = generate('asset-vault', { telemetry: 'otel', broker: 'kafka' });
  const panelDe = (proyecto) =>
    JSON.parse(proyecto.read(DASHBOARD('asset-vault')))
      .panels.flatMap((item) => (item.targets ?? []).map((target) => target.expr))
      .join('\n');

  assert.ok(panelDe(conLag).includes(CONSUMER_LAG.kafka.series), 'con Kafka falta el panel de retraso');
  assert.ok(titulos(conLag).some((titulo) => titulo.includes('Retraso')), 'con Kafka falta la alerta de retraso');

  for (const broker of ['rabbitmq', 'snssqs']) {
    const sinLag = generate('asset-vault', { telemetry: 'otel', broker });
    assert.ok(!panelDe(sinLag).includes('_lag'), `con ${broker} se emite una consulta de retraso que nadie publica`);
    assert.ok(
      !titulos(sinLag).some((titulo) => titulo.includes('Retraso')),
      `con ${broker} se emite una alerta de retraso que no puede disparar`
    );
  }
});

// «Tres alertas generadas» no es «te avisan»: sin contacto se ven en la interfaz y no salen a
// ninguna parte, y sin política el contacto no recibe nada aunque exista.
// Medido en vivo: sin esto, un servicio sin tráfico deja TODAS sus reglas en `Pending (NoData)`
// camino de disparar, porque el default de Grafana para «sin datos» es notificar. Cuatro avisos
// la primera noche de un servicio nuevo es lo que enseña a un equipo a ignorar sus alertas.
test('alertas: sin datos no es un incidente, y un error de consulta no se disfraza de negocio', () => {
  const proyecto = generate('asset-vault', { telemetry: 'otel' });
  const reglas = YAML.parse(proyecto.read(ALERTS)).groups[0].rules;
  assert.ok(reglas.length > 0);
  for (const regla of reglas) {
    assert.equal(regla.noDataState, 'OK', `${regla.title}: sin tráfico no hay nada que medir`);
    assert.equal(regla.execErrState, 'Error', `${regla.title}: un error de consulta merece nombre propio`);
  }
});

test('alertas: hay contacto y una política que enruta a él', () => {
  const proyecto = generate('asset-vault', { telemetry: 'otel' });
  const provisioning = YAML.parse(proyecto.read(ALERTS));
  const contacto = provisioning.contactPoints[0];
  assert.equal(contacto.name, ALERTING.contactPoint);
  assert.equal(contacto.receivers[0].type, 'webhook');
  // La URL no se escribe: la resuelve Grafana desde su ENTORNO al leer el archivo.
  assert.equal(contacto.receivers[0].settings.url, `$__env{${ALERTING.webhookVar}}`);
  assert.equal(provisioning.policies[0].receiver, ALERTING.contactPoint);

  // Y la variable llega al proceso de Grafana: si no, el contacto se provisiona con una URL
  // vacía y la alerta no sale, sin error en ninguna parte.
  const compose = YAML.parse(proyecto.read('deploy/docker-compose.yaml'));
  assert.match(compose.services.lgtm.environment[ALERTING.webhookVar], /ALERT_WEBHOOK_URL/);
  assert.ok(compose.services[ALERTING.sink.serviceKey], 'no hay sumidero al que apuntar por defecto');
  assert.match(proyecto.read('deploy/.env'), new RegExp(`${ALERTING.webhookVar}=http://`));
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
