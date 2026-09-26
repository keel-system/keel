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
import { ATTRIBUTES, INSTRUMENTATION, METRICS_TRANSPORT, OBSERVATIONS } from '../src/lib/telemetry-probes.js';
import { MANAGEMENT_PORT } from '../src/scaffold/config.js';

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
  const raw = project.read('src/main/resources/parameters/production/telemetry.yaml');
  const yaml = YAML.parse(raw.replace(/\$\{[^}]*\}\}?/g, 'X'));
  // Exponencial por defecto, y configurable: no todo backend los acepta por OTLP.
  assert.ok(raw.includes('histogram-flavor: ${METRICS_OTLP_HISTOGRAM_FLAVOR:base2_exponential_bucket_histogram}'));
  assert.equal(
    project.read('src/main/resources/parameters/local/telemetry.yaml').includes('histogram-flavor: base2_exponential_bucket_histogram'),
    true
  );
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

// ─── Instrumentación opcional por subsistema ─────────────────────────────────
//
// Lo que se fija aquí son las dos mitades del interruptor: que la propiedad EXISTA con su variable
// y su default por perfil, y que la clase que la lee exista solo cuando el diseño trae ese
// subsistema. Una palanca declarada que no mueve nada es peor que no tenerla, y una clase de
// instrumentación en un servicio sin ese subsistema no falla: no hace nada.

test('instrumentación opcional: los interruptores solo existen para los subsistemas del diseño', () => {
  const conStorage = generate('asset-vault', { telemetry: 'otel' });
  const local = conStorage.read('src/main/resources/parameters/local/telemetry.yaml');
  const develop = conStorage.read('src/main/resources/parameters/develop/telemetry.yaml');
  const production = conStorage.read('src/main/resources/parameters/production/telemetry.yaml');

  for (const entry of [INSTRUMENTATION.storage, INSTRUMENTATION.cache]) {
    const key = YAML.parse(local.replace(/\$\{[^}]*\}/g, 'X')).keel.telemetry.instrumentation[entry.id];
    assert.equal(key.enabled, true, `${entry.id}: encendido en local`);
    // Fuera de local, por variable de entorno y con default encendido: lo que el interruptor sirve
    // es para APAGAR sin recompilar, no para tener que acordarse de encenderlo.
    assert.ok(develop.includes(`\${${entry.envVar}:true}`), `${entry.id} en develop`);
    assert.ok(production.includes(`\${${entry.envVar}:true}`), `${entry.id} en production`);
  }
  // asset-vault no declara mail: su palanca no se emite.
  assert.ok(!develop.includes(INSTRUMENTATION.mail.envVar));

  const conCorreo = generate('notification-mailer', { telemetry: 'otel' });
  const mailDevelop = conCorreo.read('src/main/resources/parameters/develop/telemetry.yaml');
  assert.ok(mailDevelop.includes(`\${${INSTRUMENTATION.mail.envVar}:true}`));
  assert.ok(!mailDevelop.includes(INSTRUMENTATION.storage.envVar));
  assert.ok(!mailDevelop.includes(INSTRUMENTATION.cache.envVar));
});

test('instrumentación opcional: el perfil test la apaga, y la lista sale de la misma función', () => {
  const project = generate('asset-vault', { telemetry: 'otel' });
  const parsed = YAML.parse(project.read('src/main/resources/parameters/test/telemetry.yaml'));
  assert.equal(parsed.keel.telemetry.instrumentation.storage.enabled, false);
  assert.equal(parsed.keel.telemetry.instrumentation.cache.enabled, false);
  assert.equal(parsed.management.prometheus.metrics.export.enabled, false);
});

test('instrumentación opcional: los aspectos de puerto y la observación de Redis, solo con su subsistema', () => {
  const conStorage = generate('asset-vault', { telemetry: 'otel' });
  const aspect = conStorage.find('/StorageObservationAspect.java');
  // Sobre el PUERTO: el adaptador lo escribe el agente, así que no hay dónde meterla dentro.
  assert.ok(aspect.includes('domain.storage.FileStorage+.*(..)'));
  assert.ok(aspect.includes(`@ConditionalOnProperty(name = "${INSTRUMENTATION.storage.property}"`));
  assert.ok(aspect.includes(`"${OBSERVATIONS.storage}"`));
  assert.ok(aspect.includes(`"${ATTRIBUTES.storageBucket}"`));
  // La firma ANTES del proceed, misma lección que LogExceptionsAspect.
  assert.ok(aspect.indexOf('getSignature()') < aspect.indexOf('joinPoint.proceed()'));
  // La clave del objeto no sale nunca: ni como etiqueta ni como atributo.
  assert.ok(!aspect.includes('args[1]'));

  const cache = conStorage.find('/CacheObservationConfig.java');
  assert.ok(cache.includes('io.lettuce.core.tracing.MicrometerTracing'));
  assert.ok(cache.includes(`@ConditionalOnProperty(name = "${INSTRUMENTATION.cache.property}"`));
  assert.ok(!conStorage.files.some((file) => file.endsWith('MailObservationAspect.java')));
  // Las métricas de acierto se piden al CONSTRUIR el gestor de cachés: un customizer de Boot no lo
  // aplicaría nadie, porque su autoconfiguración se retira en cuanto la app declara su CacheManager.
  assert.ok(conStorage.find('/CacheConfig.java').includes('.enableStatistics()'));

  const conCorreo = generate('notification-mailer', { telemetry: 'otel' });
  const mail = conCorreo.find('/MailObservationAspect.java');
  assert.ok(mail.includes('application.port.out.MailSender+.*(..)'));
  assert.ok(mail.includes(`"${OBSERVATIONS.mailSend}"`));
  assert.ok(!conCorreo.files.some((file) => file.endsWith('StorageObservationAspect.java')));
  assert.ok(!conCorreo.files.some((file) => file.endsWith('CacheObservationConfig.java')));

  // Sin telemetría no hay ninguno de los tres.
  const sin = generate('asset-vault', {});
  for (const name of ['StorageObservationAspect.java', 'CacheObservationConfig.java', 'MailObservationAspect.java']) {
    assert.ok(!sin.files.some((file) => file.endsWith(name)), name);
  }
  assert.ok(!sin.find('/CacheConfig.java').includes('.enableStatistics()'));
});

test('métricas: el transporte es SCRAPE, con el push por OTLP apagado y su propio interruptor', () => {
  const project = generate('asset-vault', { telemetry: 'otel' });
  const develop = project.read('src/main/resources/parameters/develop/telemetry.yaml');
  // Simétrico de LOG_EXPORT_OTLP y por la misma razón: los dos caminos duplican cada serie.
  assert.ok(develop.includes(`\${${METRICS_TRANSPORT.otlp.envVar}:false}`));
  assert.ok(develop.includes(`\${${METRICS_TRANSPORT.prometheus.envVar}:true}`));
  // El registro de Prometheus está en el classpath: es lo único que trae los exemplars en Boot 3.5.
  assert.ok(project.read('build.gradle').includes('micrometer-registry-prometheus'));
  // Y no hay clase de exemplars: los autoconfigura Boot. Un bean propio sería código muerto, y la
  // falsación por mutación lo demostró — quitándolo, los exemplars seguían saliendo.
  assert.ok(!project.files.some((file) => file.endsWith('ExemplarsConfig.java')));
});

test('métricas: lo que se EXPONE y lo que se PERMITE dicen lo mismo, y production publica el scrape en un puerto de gestión', () => {
  const project = generate('asset-vault', { telemetry: 'otel' });
  const exposure = (profile) => project.read(`src/main/resources/parameters/${profile}/management.yaml`);
  for (const profile of ['local', 'develop', 'production']) {
    assert.ok(exposure(profile).includes(`,${METRICS_TRANSPORT.actuatorEndpointId}`), profile);
  }
  // En production el scrape se expone, pero en un PUERTO DE GESTIÓN que no se publica: lo que
  // protege esos nombres de negocio es dónde vive el endpoint, porque la autorización ahí es
  // permitAll (quien scrapea es un colector sin token). Sin ese puerto, production no publicaba
  // el scrape y el push venía apagado: por defecto no salía ninguna métrica.
  const production = YAML.parse(exposure('production').replace(/\$\{([A-Z_]+):([^}]*)\}/g, '$2'));
  assert.equal(production.management.server.port, MANAGEMENT_PORT);
  assert.ok(!exposure('production').includes('metrics,'), 'metrics sigue sin exponerse en production');
  // local y develop no mueven el actuator: el arnés y deploy/ lo leen en el puerto de la app.
  for (const profile of ['local', 'develop']) {
    assert.ok(!exposure(profile).includes('server:'), `${profile} no debería mover el actuator de puerto`);
  }
  // Y las sondas siguen en el puerto PRINCIPAL en todos los perfiles: el HEALTHCHECK las pide ahí.
  for (const profile of ['local', 'develop', 'production']) {
    assert.ok(exposure(profile).includes('add-additional-paths: true'), profile);
  }
  assert.ok(project.read('deploy/Dockerfile').includes('http://localhost:8080/readyz'));

  const security = project.find('/SecurityConfig.java');
  assert.ok(security.includes(`.requestMatchers("${METRICS_TRANSPORT.scrapePath}").permitAll()`));

  // Sin telemetría no se expone ni se permite: no hay nada que scrapear.
  const sin = generate('asset-vault', {});
  assert.ok(!sin.read('src/main/resources/parameters/local/management.yaml').includes(METRICS_TRANSPORT.actuatorEndpointId));
  assert.ok(!sin.find('/SecurityConfig.java').includes(METRICS_TRANSPORT.scrapePath));
});

test('métricas: el colector las va a BUSCAR, y el scrape llega con el nombre del servicio', () => {
  const project = generate('asset-vault', { telemetry: 'otel' });
  const collector = YAML.parse(project.read('deploy/otel/collector.yaml'));
  const job = collector.receivers.prometheus.config.scrape_configs[0];
  assert.equal(job.metrics_path, METRICS_TRANSPORT.scrapePath);
  assert.deepEqual(job.static_configs[0].targets, ['app:8080']);
  assert.ok(collector.service.pipelines.metrics.receivers.includes('prometheus'));
  // Un scrape NO trae los atributos de recurso que sí trae OTLP: sin esto las series llegan sin
  // service.name y el panel no puede filtrar por servicio.
  assert.ok(collector.service.pipelines.metrics.processors.includes('resource/scrape'));
  assert.ok(collector.processors['resource/scrape'].attributes.some((attr) => attr.key === 'service.name'));
  // Y todo pipeline sigue citando componentes definidos, exportadores a fichero incluidos.
  for (const [signal, pipeline] of Object.entries(collector.service.pipelines)) {
    for (const kind of ['receivers', 'processors', 'exporters']) {
      for (const component of pipeline[kind]) assert.ok(component in collector[kind], `${signal}: ${component}`);
    }
  }
});

test('el desenlace del caso de uso va en la OBSERVACIÓN: sin él, la alerta de errores no dispara nunca', () => {
  const project = generate('asset-vault', { telemetry: 'otel' });
  const mediator = project.find('/UseCaseMediator.java');
  assert.ok(mediator.includes(`lowCardinalityKeyValue("${ATTRIBUTES.outcome}", "ok")`));
  assert.ok(mediator.includes(`lowCardinalityKeyValue("${ATTRIBUTES.outcome}", "rejected")`));
  assert.ok(mediator.includes(`lowCardinalityKeyValue("${ATTRIBUTES.outcome}", "error")`));
  // Un rechazo del dominio NO es un error del span: es un 4xx esperado.
  const rejected = mediator.indexOf('"rejected"');
  const error = mediator.indexOf('observation.error(ex)');
  assert.ok(rejected < error && !mediator.slice(rejected, error).includes('observation.error'));

  // Sin telemetría, el mediator no menciona ninguna observación.
  assert.ok(!generate('asset-vault', {}).find('/UseCaseMediator.java').includes('Observation'));
});

test('métricas: el servicio AVISA al arrancar si no tienen por dónde salir', () => {
  // Los dos caminos se deciden por entorno, y apagarlos no rompe nada: el panel se queda vacío y
  // las alertas, sin datos, no disparan. El aviso es lo único que lo hace visible, y en el arranque.
  const config = generate('asset-vault', { telemetry: 'otel' }).find('/TelemetryConfig.java');
  assert.match(config, /public ApplicationListener<ApplicationReadyEvent> metricsPathCheck\(Environment environment\)/);
  // Lee exactamente las dos palancas del vocabulario, no unas escritas a mano.
  assert.ok(config.includes(`"${METRICS_TRANSPORT.prometheus.property}"`));
  assert.ok(config.includes(`"${METRICS_TRANSPORT.otlp.property}"`));
  assert.ok(config.includes(`exposed.contains("${METRICS_TRANSPORT.actuatorEndpointId}")`));
  // Y fuera del perfil test, donde las métricas se apagan a propósito.
  assert.match(config, /@Profile\("!test"\)\s+public ApplicationListener<ApplicationReadyEvent> metricsPathCheck/);
});


test('trazas: el servicio emite W3C y acepta también B3, con la librería que lo lee', () => {
  // Quien llama puede ser una malla de servicio o un sistema de la familia Zipkin, que hablan B3:
  // si el servicio solo leyera W3C, la traza nacería de nuevo al llegar aquí, sin error ninguno.
  const project = generate('asset-vault', { telemetry: 'otel' });
  for (const profile of ['local', 'develop', 'production']) {
    const yaml = YAML.parse(project.read(`src/main/resources/parameters/${profile}/telemetry.yaml`).replace(/\$\{[^}]*\}/g, 'X'));
    assert.equal(yaml.management.tracing.propagation.produce, 'w3c', profile);
    assert.equal(yaml.management.tracing.propagation.consume, 'w3c, b3, b3_multi', profile);
  }
  // Sin la librería de propagadores, B3 en consume no tiene quién lo lea.
  assert.ok(project.read('build.gradle').includes("io.opentelemetry:opentelemetry-extension-trace-propagators"));
});

test('trazas: cada réplica se identifica con service.instance.id fuera de local', () => {
  // Dos instancias del mismo servicio eran indistinguibles en el backend.
  const project = generate('asset-vault', { telemetry: 'otel' });
  for (const profile of ['develop', 'production']) {
    const yaml = project.read(`src/main/resources/parameters/${profile}/telemetry.yaml`);
    assert.ok(yaml.includes('"[service.instance.id]": ${SERVICE_INSTANCE_ID:${HOSTNAME:unknown}}'), profile);
  }
  assert.ok(!project.read('src/main/resources/parameters/local/telemetry.yaml').includes('service.instance.id'));
});

test('logs: JSON ECS fuera de local también SIN telemetría, con versión, entorno y réplica del servicio', () => {
  // La consola es el canal primario de los logs en cualquier plataforma, y quien la recoge solo
  // separa campos sin expresiones regulares si la línea es JSON. Antes dependía de la telemetría.
  for (const telemetry of ['none', 'otel']) {
    const project = generate('asset-vault', { telemetry });
    for (const profile of ['develop', 'production']) {
      const raw = project.read(`src/main/resources/parameters/${profile}/logging.yaml`);
      const yaml = YAML.parse(raw.replace(/\$\{[^}]*\}\}?/g, 'X'));
      const structured = yaml.logging.structured;
      assert.equal(structured.format.console, 'X', `${telemetry}/${profile}: falta el formato estructurado`);
      assert.ok(raw.includes('console: ${LOG_FORMAT:ecs}'), `${telemetry}/${profile}`);
      assert.ok(structured.ecs.service.version, `${telemetry}/${profile}: la línea no dice qué versión la escribió`);
      assert.ok(raw.includes('environment: ${DEPLOYMENT_ENVIRONMENT:'), `${telemetry}/${profile}`);
      assert.ok(raw.includes('node-name: ${SERVICE_INSTANCE_ID:${HOSTNAME:unknown}}'), `${telemetry}/${profile}`);
      // El renombrado de los ids de traza solo tiene sentido si hay traza.
      assert.equal(Boolean(structured.json), telemetry === 'otel', `${telemetry}/${profile}: rename`);
    }
    assert.ok(!project.read('src/main/resources/parameters/local/logging.yaml').includes('structured'), 'local sigue en texto');
  }
});
