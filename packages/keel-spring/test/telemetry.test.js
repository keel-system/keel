// Telemetría opcional (`telemetry: otel` en keel-stack.json): trazas, métricas y logs por OTLP a un
// colector. Lo que se fija aquí son las propiedades que no se ven comparando un archivo suelto:
// que sin la opción no aparezca NADA, que el endpoint salga de una sola fuente en las tres
// proyecciones (config de la app, compose de deploy/ y receptor del colector), que la traza
// cruce el outbox en las dos ramas, y las dos regresiones que salieron de medir en vivo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService, resolveStack } from '../src/scaffold/index.js';
import { askStackConfig, normalizeTelemetry, stackDrift, describeStack } from '../src/lib/stack-config.js';
import { TELEMETRY_INFRA, collectorEndpoint, collectorHostEndpoint } from '../src/lib/stack-catalog.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function generate(fixture, stack) {
  const { manifest, layers } = loadService(path.join(fixturesDir, fixture));
  const workspace = tmpDir('keel-telemetry-');
  const result = scaffoldService({ manifest, layers, workspace, force: true, stack });
  const root = path.join(workspace, result.outDir);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const find = (suffix) => {
    const hit = files.find((file) => file.endsWith(suffix));
    assert.ok(hit, `no se generó ningún archivo que acabe en ${suffix}`);
    return read(hit);
  };
  return { files, read, find, has: (rel) => files.includes(rel) };
}

// ─── Elección de stack ───────────────────────────────────────────────────────

test('telemetría: por defecto no hay, y un stack anterior a la opción se lee como none sin ser deriva', async () => {
  const { manifest, layers } = loadService(path.join(fixturesDir, 'stock-reservation'));
  const asked = await askStackConfig(manifest, layers, { defaults: true });
  assert.equal(asked.telemetry, 'none');
  assert.equal((await askStackConfig(manifest, layers, { defaults: true, telemetry: 'otel' })).telemetry, 'otel');

  // Un keel-stack.json escrito antes de que existiera la opción no tiene la clave.
  const legacy = { group: 'com.x', database: 'postgresql', broker: 'kafka', auth: 'keycloak', cache: null, storage: null };
  assert.equal(resolveStack(legacy, layers, manifest).telemetry, 'none');
  const drift = stackDrift(legacy, layers);
  assert.ok(!drift.missing.includes('telemetry') && !drift.stale.includes('telemetry'), JSON.stringify(drift));

  assert.throws(() => normalizeTelemetry('jaeger'), /no soportada/);
  assert.ok(describeStack({ telemetry: 'otel' }).includes('OpenTelemetry'));
  assert.ok(!describeStack({ telemetry: 'none' }).includes('OpenTelemetry'));
});

// ─── Sin telemetría no aparece nada ──────────────────────────────────────────

test('telemetría: sin elegirla no se genera ninguna pieza, y el contrato del evento conserva traceparent a null', () => {
  const project = generate('stock-reservation', { broker: 'kafka' });
  assert.ok(!project.files.some((file) => file.includes('/infrastructure/telemetry/')), 'paquete telemetry sin elegirlo');
  assert.ok(!project.files.some((file) => file.endsWith('/telemetry.yaml')), 'fragmento telemetry sin elegirlo');
  assert.ok(!project.has('deploy/otel/collector.yaml'));
  assert.ok(!project.has('docs/keel/conventions/observability.md'));

  const gradle = project.read('build.gradle');
  for (const dep of ['micrometer-tracing-bridge-otel', 'opentelemetry-exporter-otlp', 'micrometer-registry-otlp', 'opentelemetry-logback-appender', 'datasource-micrometer']) {
    assert.ok(!gradle.includes(dep), `${dep} sin telemetría`);
  }
  const compose = project.read('deploy/docker-compose.yaml');
  assert.ok(!compose.includes('otel-collector') && !compose.includes(TELEMETRY_INFRA.endpointVar));

  // El relay y el mediator, byte a byte como antes: ni MessageTracing ni Observation.
  assert.ok(!project.find('/OutboxRelay.java').includes('MessageTracing'));
  assert.ok(!project.find('/UseCaseMediator.java').includes('Observation'));

  // Lo único que cambia en la salida por defecto: el campo del contrato y la sobrecarga del listener.
  assert.ok(project.find('/EventMetadata.java').includes('String traceparent'));
  assert.ok(project.find('/EventEnvelope.java').includes('metadata.withContext(correlationId, null)'));
  const correlation = project.find('/CorrelationContext.java');
  assert.ok(correlation.includes('public static void runWith(EventMetadata metadata, Runnable action)'));
  assert.ok(correlation.includes('runWith(metadata.correlationId(), action);'));
  assert.ok(!correlation.includes('MessageTracing'));
  assert.ok(!project.read('infra/check-idempotency.sh').includes("'inboundContext'"));
});

// ─── Con telemetría ──────────────────────────────────────────────────────────

test('telemetría: dependencias, paquete telemetry y convention solo con otel', () => {
  const project = generate('stock-reservation', { broker: 'kafka', telemetry: 'otel' });
  const gradle = project.read('build.gradle');
  for (const dep of ['micrometer-tracing-bridge-otel', 'opentelemetry-exporter-otlp', 'micrometer-registry-otlp', 'opentelemetry-logback-appender-1.0', 'datasource-micrometer-spring-boot']) {
    assert.ok(gradle.includes(dep), `falta ${dep}`);
  }
  for (const cls of ['TelemetryConfig', 'MessageTracing', 'MessageTracingInstaller']) {
    assert.ok(project.files.some((file) => file.endsWith(`/infrastructure/telemetry/${cls}.java`)), `falta ${cls}`);
  }
  assert.ok(project.has('docs/keel/conventions/observability.md'));
  // Sin logback-spring.xml: rompería el formato estructurado de la consola (ver telemetry.js).
  assert.ok(!project.files.some((file) => file.endsWith('logback-spring.xml')));
});

test('telemetría: gradiente por perfil — local sin exportar, production con endpoint obligatorio, test apagado', () => {
  const project = generate('stock-reservation', { broker: 'kafka', telemetry: 'otel' });
  const yaml = (profile) => project.read(`src/main/resources/parameters/${profile}/telemetry.yaml`);
  const endpointVar = TELEMETRY_INFRA.endpointVar;

  assert.ok(yaml('local').includes('${TELEMETRY_EXPORT_ENABLED:false}'));
  assert.ok(yaml('local').includes(`\${${endpointVar}:${collectorHostEndpoint()}}/v1/traces`));
  assert.ok(yaml('develop').includes('${TELEMETRY_EXPORT_ENABLED:true}'));
  assert.ok(yaml('production').includes(`\${${endpointVar}}/v1/traces`), 'production: endpoint sin default');
  assert.ok(!yaml('production').includes(`\${${endpointVar}:`), 'production no puede inventar un colector');
  assert.ok(yaml('production').includes('${TRACING_SAMPLING_PROBABILITY:0.1}'));
  for (const profile of ['local', 'develop', 'production']) {
    const parsed = YAML.parse(yaml(profile).replace(/\$\{[^}]*\}/g, 'X'));
    assert.ok(parsed.management.otlp.tracing && parsed.management.otlp.logging && parsed.management.otlp.metrics.export, profile);
    assert.deepEqual(parsed.spring.kafka, { template: { 'observation-enabled': true }, listener: { 'observation-enabled': true } });
    assert.ok(project.read(`src/main/resources/application-${profile}.yaml`).includes(`parameters/${profile}/telemetry.yaml`));
  }
  const testYaml = YAML.parse(yaml('test'));
  assert.equal(testYaml.management.tracing.enabled, false);
  assert.equal(testYaml.management.otlp.tracing.export.enabled, false);

  // Logs: traceId en el patrón siempre, JSON (ECS) fuera de local.
  assert.ok(project.read('src/main/resources/parameters/local/logging.yaml').includes('%X{traceId:-},%X{spanId:-}'));
  assert.ok(!project.read('src/main/resources/parameters/local/logging.yaml').includes('structured'));
  assert.ok(project.read('src/main/resources/parameters/production/logging.yaml').includes('${LOG_FORMAT:ecs}'));
});

test('telemetría: el endpoint del colector sale de UNA fuente en la app, deploy/ y el receptor del colector', () => {
  const project = generate('stock-reservation', { broker: 'kafka', telemetry: 'otel' });
  const { collector, backend, endpointVar } = TELEMETRY_INFRA;
  const compose = YAML.parse(project.read('deploy/docker-compose.yaml'));

  assert.equal(compose.services.app.environment[endpointVar], collectorEndpoint());
  assert.equal(collectorEndpoint(), `http://${collector.serviceKey}:${collector.httpPort}`);
  assert.equal(compose.services[collector.serviceKey].image, collector.image);
  assert.ok(compose.services[collector.serviceKey].ports.some((port) => port.endsWith(`:${collector.httpPort}`)));
  assert.equal(compose.services[backend.serviceKey].image, backend.image);
  // La app no espera por el colector: un colector caído no puede impedir arrancar.
  assert.ok(!Object.keys(compose.services.app.depends_on ?? {}).includes(collector.serviceKey));

  const config = YAML.parse(project.read('deploy/otel/collector.yaml'));
  assert.equal(config.receivers.otlp.protocols.http.endpoint, `0.0.0.0:${collector.httpPort}`);
  assert.equal(config.exporters['otlphttp/backend'].endpoint, `http://${backend.serviceKey}:${backend.otlpHttpPort}`);
  assert.ok(project.read('deploy/.env').includes(`GRAFANA_PORT=${backend.grafanaPublishedPort}`));
  assert.ok(project.read('deploy/up.sh').includes('Grafana'));
});

test('telemetría: el colector es robusto — memory_limiter primero, batch al final, y todo pipeline cita componentes definidos', () => {
  const project = generate('stock-reservation', { broker: 'kafka', telemetry: 'otel' });
  const config = YAML.parse(project.read('deploy/otel/collector.yaml'));
  const pipelines = config.service.pipelines;
  assert.deepEqual(Object.keys(pipelines).sort(), ['logs', 'metrics', 'traces']);
  for (const [name, pipeline] of Object.entries(pipelines)) {
    for (const receiver of pipeline.receivers) assert.ok(receiver in config.receivers, `${name}: ${receiver}`);
    for (const processor of pipeline.processors) assert.ok(processor in config.processors, `${name}: ${processor}`);
    for (const exporter of pipeline.exporters) assert.ok(exporter in config.exporters, `${name}: ${exporter}`);
    assert.equal(pipeline.processors[0], 'memory_limiter', name);
    assert.equal(pipeline.processors.at(-1), 'batch', name);
    assert.ok(pipeline.processors.includes('attributes/redact'), name);
  }
  const exporter = config.exporters['otlphttp/backend'];
  assert.equal(exporter.retry_on_failure.enabled, true);
  assert.equal(exporter.sending_queue.enabled, true);
  const redacted = config.processors['attributes/redact'].actions.map((action) => action.key);
  assert.ok(redacted.includes('http.request.header.authorization'));
});

test('telemetría: la traza cruza el outbox en las DOS ramas y el mediator abre una observación por caso de uso', () => {
  for (const [fixture, broker] of [
    ['stock-reservation', 'kafka'],
    ['asset-vault', 'snssqs']
  ]) {
    const project = generate(fixture, { broker, telemetry: 'otel' });
    const relay = project.find('/OutboxRelay.java');
    assert.match(relay, /MessageTracing\.continueFrom\(MessageTracing\.traceparentOfEnvelope\(row\.(payload|getPayload)\(\)\), MessageTracing\.OUTBOX_PUBLISH, Kind\.PRODUCER/, fixture);
    assert.ok(!/^\s+dispatcher\.dispatch\(/m.test(relay), `${fixture}: queda una publicación sin trazar`);

    const mediator = project.find('/UseCaseMediator.java');
    assert.ok(mediator.includes('callUseCase(query, () ->'), fixture);
    assert.ok(mediator.includes('Observation.createNotStarted("keel.use-case"'), fixture);

    assert.ok(project.find('/EventEnvelope.java').includes('MessageTracing.currentTraceparent()'), fixture);
    assert.ok(project.find('/CorrelationContext.java').includes('MessageTracing.continueFrom('), fixture);
  }
  // Mongo solo en la rama documental.
  assert.ok(generate('asset-vault', { broker: 'snssqs', telemetry: 'otel' }).find('/TelemetryConfig.java').includes('MongoObservationCommandListener'));
  assert.ok(!generate('stock-reservation', { broker: 'kafka', telemetry: 'otel' }).find('/TelemetryConfig.java').includes('Mongo'));
});

test('telemetría: los clientes HTTP salientes se observan (y propagan traceparent) solo con otel', () => {
  const withIt = generate('asset-vault', { broker: 'snssqs', telemetry: 'otel' });
  const config = withIt.files.filter((file) => /\/infrastructure\/http\/.*Config\.java$/.test(file) && !file.endsWith('OAuth2Config.java'));
  assert.ok(config.length > 0, 'la fixture debería tener clientes HTTP');
  for (const file of config) assert.ok(withIt.read(file).includes('.observationRegistry(observationRegistry.getIfAvailable('), file);

  const without = generate('asset-vault', { broker: 'snssqs' });
  for (const file of config) assert.ok(!without.read(file).includes('observationRegistry'), file);
});

// Las dos regresiones que salieron de arrancar el servidor contra un colector real.
test('telemetría: arranca sin trazas y el predicado no deja pasar consultas colgadas de un tick descartado', () => {
  const project = generate('stock-reservation', { broker: 'kafka', telemetry: 'otel' });

  // (1) Con las trazas apagadas (perfil test, @SpringBootTest) Boot aporta un Tracer no-op pero
  //     NINGÚN Propagator: pedirlos por constructor impedía arrancar el contexto.
  const installer = project.find('/MessageTracingInstaller.java');
  assert.ok(installer.includes('ObjectProvider<Propagator> propagator'));
  assert.ok(!/MessageTracingInstaller\(\s*Tracer /.test(installer));
  assert.ok(project.find('/TelemetryConfig.java').includes('ObjectProvider<OpenTelemetry>'));

  // (2) El tick programado que el predicado descarta se queda como observación ACTUAL en forma
  //     de no-op: con `getParentObservation() != null` a secas, cada consulta del relay salía
  //     como traza raíz. Medido en el colector: una conexión JDBC raíz por segundo.
  const config = project.find('/TelemetryConfig.java');
  assert.ok(config.includes('instanceof Observation parent && !parent.isNoop()'));
  assert.ok(config.includes('"tasks.scheduled.execution"'));
  assert.ok(config.includes('startsWith("/actuator")'));
});

test('telemetría: el gate exige continuar la traza en el listener, solo con otel y envoltura keel', () => {
  const project = generate('stock-reservation', { broker: 'kafka', telemetry: 'otel' });
  const gate = project.read('infra/check-idempotency.sh');
  assert.ok(gate.includes("unit 'inboundContext'"));
  assert.ok(gate.includes('CorrelationContext[.]runWith'));
  assert.ok(gate.includes('[.]correlationId[(][)]'));
  // Con RabbitMQ varias suscripciones comparten listener: el check se agrupa igual que `dedupe`.
  const rabbit = generate('stock-reservation', { broker: 'rabbitmq', telemetry: 'otel' }).read('infra/check-idempotency.sh');
  assert.ok(rabbit.includes("'inboundContext'"));
});

// ─── Canal de logs, nombres ECS y colector de producción ─────────────────────

test('telemetría: el OTLP de logs tiene su propio interruptor, apagado, y el appender solo existe si se enciende', () => {
  const project = generate('stock-reservation', { broker: 'kafka', telemetry: 'otel' });
  for (const profile of ['local', 'develop', 'production']) {
    const yaml = project.read(`src/main/resources/parameters/${profile}/telemetry.yaml`);
    assert.ok(yaml.includes('enabled: ${LOG_EXPORT_OTLP:false}'), profile);
  }
  const config = project.find('/TelemetryConfig.java');
  assert.match(config, /@ConditionalOnProperty\(name = "management\.otlp\.logging\.export\.enabled", havingValue = "true"\)\s+public InitializingBean openTelemetryLogAppender/);
  // En deploy/ nada recoge stdout: ahí sí se exportan.
  assert.equal(YAML.parse(project.read('deploy/docker-compose.yaml')).services.app.environment.LOG_EXPORT_OTLP, 'true');
});

test('telemetría: en JSON los ids de traza salen con su nombre ECS (medido: Boot vuelca el MDC tal cual)', () => {
  const project = generate('stock-reservation', { broker: 'kafka', telemetry: 'otel' });
  for (const profile of ['develop', 'production']) {
    const logging = YAML.parse(project.read(`src/main/resources/parameters/${profile}/logging.yaml`).replace(/\$\{[^}]*\}/g, 'X'));
    assert.deepEqual(logging.logging.structured.json.rename, { traceId: 'trace.id', spanId: 'span.id' }, profile);
  }
  assert.ok(!project.read('src/main/resources/parameters/local/logging.yaml').includes('rename'));
});

test('telemetría: histogramas exponenciales de latencia y correlationId en los spans', () => {
  const project = generate('stock-reservation', { broker: 'kafka', telemetry: 'otel' });
  const yaml = YAML.parse(project.read('src/main/resources/parameters/production/telemetry.yaml').replace(/\$\{[^}]*\}/g, 'X'));
  assert.equal(yaml.management.otlp.metrics.export['histogram-flavor'], 'base2_exponential_bucket_histogram');
  const histograms = yaml.management.metrics.distribution['percentiles-histogram'];
  for (const meter of ['[http.server.requests]', '[http.client.requests]', '[keel.use-case]']) assert.equal(histograms[meter], true, meter);

  const config = project.find('/TelemetryConfig.java');
  assert.ok(config.includes('public ObservationFilter correlationIdOnSpans()'));
  // En el span HTTP, de la cabecera de la RESPUESTA: CorrelationFilter ya limpió su contexto al cerrarse.
  assert.ok(config.includes('server.getResponse().getHeader("X-Correlation-Id")'));
  assert.ok(config.includes('addHighCardinalityKeyValue(KeyValue.of("keel.correlation_id"'));
});

test('telemetría: colector de producción de referencia — agente por nodo y gateway con muestreo por cola', () => {
  const project = generate('stock-reservation', { broker: 'kafka', telemetry: 'otel' });
  const agent = YAML.parse(project.read('deploy/otel/collector-agent.example.yaml'));
  const gateway = YAML.parse(project.read('deploy/otel/collector-gateway.example.yaml'));
  for (const [name, config] of [['agent', agent], ['gateway', gateway]]) {
    for (const [signal, pipeline] of Object.entries(config.service.pipelines)) {
      for (const kind of ['receivers', 'processors', 'exporters']) {
        for (const component of pipeline[kind]) assert.ok(component in config[kind], `${name}/${signal}: ${component}`);
      }
      assert.equal(pipeline.processors[0], 'memory_limiter', `${name}/${signal}`);
      assert.equal(pipeline.processors.at(-1), 'batch', `${name}/${signal}`);
    }
  }
  // El agente recoge los logs del stdout y reparte las trazas por traceID; el gateway muestrea por cola.
  assert.deepEqual(agent.service.pipelines.logs.receivers, ['filelog']);
  assert.ok(agent.receivers.filelog.operators.some((op) => op.type === 'trace_parser'));
  assert.equal(agent.exporters.loadbalancing.routing_key, 'traceID');
  assert.ok(gateway.service.pipelines.traces.processors.includes('tail_sampling'));
  assert.ok(gateway.processors.tail_sampling.policies.some((policy) => policy.type === 'status_code'));
  // La credencial del backend, desde el entorno del colector.
  assert.ok(project.read('deploy/otel/collector-gateway.example.yaml').includes('${env:OTEL_BACKEND_AUTH}'));
  assert.ok(project.read('src/main/resources/parameters/production/telemetry.yaml').includes('collector-gateway.example.yaml'));
});
