// El panel y las alertas del servicio generado (solo con `telemetry: otel`).
//
// Hasta aquí el servidor emitía todo lo necesario —el gauge del outbox, el p95 por operación, la
// tasa de error— y cada equipo construía el panel a mano. Eso tiene dos costes: el obvio, que es
// el trabajo repetido, y el que no se ve, que es que una consulta escrita a mano puede nombrar
// una serie que nadie publica. Una alerta así no falla: **no dispara nunca**, y nadie se entera.
//
// De ahí las dos reglas de este módulo:
//
//   · Los nombres de serie NO se escriben: salen de `promMetric()` / `promGauge()` sobre el
//     vocabulario de `src/lib/telemetry-probes.js`. Al cambiar el transporte de métricas, la
//     unidad base del registro cambia con él (el registro OTLP publicaba milisegundos y el de
//     Prometheus publica SEGUNDOS), y un panel con el nombre viejo dentro no falla: se queda
//     vacío, que es peor.
//   · Una fila o una alerta se emite SOLO si su subsistema existe en el diseño. Un panel con
//     paneles vacíos dice «falta señal» donde lo que falta es el subsistema.
//
// Determinista a propósito: ningún timestamp, ningún id aleatorio. `build` se ejecuta muchas
// veces sobre el mismo diseño y el árbol no puede cambiar entre dos pasadas.

import { OBSERVABILITY_DIR, GRAFANA_PROVISIONING } from '../lib/stack-catalog.js';
import { ATTRIBUTES, OBSERVATIONS, promGauge, promMetric, promTag, usesTelemetry } from '../lib/telemetry-probes.js';
import { instrumentationFor } from './telemetry.js';
import { usesOutbox } from './outbox.js';

const DATASOURCE = { type: 'prometheus', uid: 'prometheus' };

export function generate(model) {
  if (!usesTelemetry(model)) return [];
  return [
    { path: `deploy/${OBSERVABILITY_DIR}/dashboards/${model.service.artifactId}.json`, content: dashboard(model) },
    { path: `deploy/${OBSERVABILITY_DIR}/dashboards-provisioning.yaml`, content: provider() },
    { path: `deploy/${OBSERVABILITY_DIR}/alerting/keel-alerts.yaml`, content: alerting(model) },
    { path: `deploy/${OBSERVABILITY_DIR}/prometheus-rules.example.yaml`, content: prometheusRules(model) },
    // El colector escribe aquí lo que SALE de él. El directorio tiene que existir antes de
    // levantar nada: un bind-mount sobre una ruta inexistente la crea como directorio del root en
    // unos runtimes y falla en otros, y en los dos casos el exportador se queda sin escribir.
    { path: 'deploy/otel/out/.gitkeep', content: '' }
  ];
}

/** El dashboard, como objeto JSON ya serializado. */
function dashboard(model) {
  const panels = [];
  let y = 0;
  const row = (title, items) => {
    panels.push({ type: 'row', title, gridPos: { h: 1, w: 24, x: 0, y }, collapsed: false, panels: [] });
    y += 1;
    const width = Math.floor(24 / items.length);
    items.forEach((item, index) => {
      panels.push({ ...item, gridPos: { h: 8, w: width, x: width * index, y } });
    });
    y += 8;
  };

  const useCase = promMetric(OBSERVATIONS.useCase);
  const operationTag = promTag(ATTRIBUTES.operation);
  const outcomeTag = promTag(ATTRIBUTES.outcome);

  row('Casos de uso', [
    timeseries('Ejecuciones por operación (por segundo)', [
      target(`sum by (${operationTag}) (rate(${useCase.count}[$__rate_interval]))`, `{{${operationTag}}}`)
    ]),
    timeseries('Tasa de error', [
      target(
        `sum(rate(${useCase.count}{${outcomeTag}="error"}[$__rate_interval]))` +
          ` / clamp_min(sum(rate(${useCase.count}[$__rate_interval])), 0.001)`,
        'error'
      )
    ]),
    // Con exemplars: cada punto enseña el id de una traza de ejemplo, que es el salto que este
    // panel existe para dar — de «el p95 subió» a la petición concreta que lo subió.
    timeseries(
      'p95 por operación (con exemplars)',
      [
        {
          ...target(
            `histogram_quantile(0.95, sum by (le, ${operationTag}) (rate(${useCase.bucket}[$__rate_interval])))`,
            `{{${operationTag}}}`
          ),
          exemplar: true
        }
      ],
      's'
    )
  ]);

  if (model.layersPresent?.api) {
    const http = promMetric('http.server.requests');
    row('HTTP', [
      timeseries('Peticiones por segundo y estado', [
        target(`sum by (status) (rate(${http.count}[$__rate_interval]))`, '{{status}}')
      ]),
      timeseries(
        'p95 por endpoint (con exemplars)',
        [{ ...target(`histogram_quantile(0.95, sum by (le, uri) (rate(${http.bucket}[$__rate_interval])))`, '{{uri}}'), exemplar: true }],
        's'
      )
    ]);
  }

  if (usesOutbox(model)) {
    const publish = promMetric(OBSERVATIONS.outboxPublish);
    row('Outbox', [
      // Debería ser siempre 0: cada unidad es un evento que agotó sus reintentos y NO salió.
      stat('Eventos rendidos (debería ser 0)', [target(promGauge('keel.outbox.dead_lettered'), 'rendidos')]),
      timeseries('Eventos publicados por segundo', [
        target(`sum by (${promTag(ATTRIBUTES.eventType)}) (rate(${publish.count}[$__rate_interval]))`, `{{${promTag(ATTRIBUTES.eventType)}}}`)
      ])
    ]);
  }

  if (model.layersPresent?.messaging) {
    const consume = promMetric(OBSERVATIONS.messageConsume);
    row('Mensajes consumidos', [
      timeseries('Consumos por segundo', [
        target(`sum by (${promTag(ATTRIBUTES.eventType)}) (rate(${consume.count}[$__rate_interval]))`, `{{${promTag(ATTRIBUTES.eventType)}}}`)
      ])
    ]);
  }

  for (const entry of instrumentationFor(model)) {
    if (entry.id === 'cache') {
      row('Caché', [
        timeseries('Ratio de acierto por caché', [
          target(
            'sum by (cache) (rate(cache_gets_total{result="hit"}[$__rate_interval]))' +
              ' / clamp_min(sum by (cache) (rate(cache_gets_total[$__rate_interval])), 0.001)',
            '{{cache}}'
          )
        ])
      ]);
    }
    if (entry.id === 'storage') {
      const storage = promMetric(OBSERVATIONS.storage);
      row('Almacenamiento', [
        timeseries('Operaciones por segundo', [
          target(
            `sum by (${promTag(ATTRIBUTES.storageOperation)}, ${promTag(ATTRIBUTES.storageBucket)}) (rate(${storage.count}[$__rate_interval]))`,
            `{{${promTag(ATTRIBUTES.storageBucket)}}} · {{${promTag(ATTRIBUTES.storageOperation)}}}`
          )
        ]),
        timeseries(
          'p95 por operación',
          [
            target(
              `histogram_quantile(0.95, sum by (le, ${promTag(ATTRIBUTES.storageOperation)}) (rate(${storage.bucket}[$__rate_interval])))`,
              `{{${promTag(ATTRIBUTES.storageOperation)}}}`
            )
          ],
          's'
        )
      ]);
    }
    if (entry.id === 'mail') {
      const mail = promMetric(OBSERVATIONS.mailSend);
      row('Correo', [
        timeseries('Entregas por segundo y desenlace', [
          target(`sum by (${outcomeTag}) (rate(${mail.count}[$__rate_interval]))`, `{{${outcomeTag}}}`)
        ]),
        timeseries('p95 de la entrega', [target(`histogram_quantile(0.95, sum by (le) (rate(${mail.bucket}[$__rate_interval])))`, 'p95')], 's')
      ]);
    }
  }

  const json = {
    uid: dashboardUid(model),
    title: `${model.service.name} — Keel`,
    description:
      'Generado por keel-spring build. Lo REGENERA cada build: una edición hecha en la interfaz de Grafana se pierde. ' +
      'Para conservarla, exporta el JSON y sustituye el archivo de deploy/observability/dashboards/.',
    tags: ['keel', model.service.artifactId],
    timezone: 'browser',
    editable: true,
    schemaVersion: 39,
    version: 1,
    refresh: '30s',
    time: { from: 'now-1h', to: 'now' },
    panels
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

/** El uid del panel: estable, derivado del servicio, sin nada aleatorio. */
export function dashboardUid(model) {
  return `keel-${model.service.artifactId}`;
}

function target(expr, legend) {
  return { datasource: DATASOURCE, expr, legendFormat: legend, refId: 'A' };
}

function timeseries(title, targets, unit = null) {
  return {
    type: 'timeseries',
    title,
    datasource: DATASOURCE,
    targets: targets.map((t, index) => ({ ...t, refId: String.fromCharCode(65 + index) })),
    fieldConfig: { defaults: unit ? { unit } : {}, overrides: [] }
  };
}

function stat(title, targets) {
  return {
    type: 'stat',
    title,
    datasource: DATASOURCE,
    targets: targets.map((t, index) => ({ ...t, refId: String.fromCharCode(65 + index) })),
    fieldConfig: {
      defaults: { thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: 1 }] } },
      overrides: []
    }
  };
}

function provider() {
  return `# Provisioning de paneles de Grafana (backend de prueba de deploy/).
# Generado por keel-spring build. La ruta es la de DENTRO del contenedor y tiene que coincidir con
# el montaje del compose: viven las dos en src/lib/stack-catalog.js por eso mismo.
apiVersion: 1

providers:
  - name: keel
    type: file
    disableDeletion: false
    allowUiUpdates: true
    options:
      path: ${GRAFANA_PROVISIONING.dashboardsDir}
      foldersFromFilesStructure: false
`;
}

/**
 * Las tres alertas que valen la pena, en el formato de provisioning de Grafana.
 *
 * <p>No son tres cualesquiera: la primera es PÉRDIDA DE DATOS en el mecanismo cuya única promesa
 * es que no se pierde nada, la segunda es que el servicio está fallando y la tercera es que se
 * está degradando antes de que alguien se queje. La del outbox solo se emite si el diseño lo
 * declara — si no, consultaría una métrica que nadie publica, que es justo el fallo que este
 * módulo existe para no cometer.
 */
function alerting(model) {
  const useCase = promMetric(OBSERVATIONS.useCase);
  const operationTag = promTag(ATTRIBUTES.operation);
  const outcomeTag = promTag(ATTRIBUTES.outcome);
  const rules = [];

  if (usesOutbox(model)) {
    rules.push(
      rule({
        uid: `keel-${model.service.artifactId}-outbox`,
        title: 'Eventos del outbox rendidos',
        expr: `max_over_time(${promGauge('keel.outbox.dead_lettered')}[5m])`,
        forDuration: '5m',
        severity: 'critical',
        summary:
          'Hay eventos que agotaron sus reintentos y NO salieron. Es pérdida de datos en el mecanismo cuya única promesa es que no se pierde nada.'
      })
    );
  }

  rules.push(
    rule({
      uid: `keel-${model.service.artifactId}-errors`,
      title: 'Tasa de error de los casos de uso',
      expr:
        `sum(rate(${useCase.count}{${outcomeTag}="error"}[5m]))` +
        ` / clamp_min(sum(rate(${useCase.count}[5m])), 0.001)`,
      threshold: 0.05,
      forDuration: '10m',
      severity: 'warning',
      summary:
        'Más del 5 % de los casos de uso está fallando. Cuenta solo `error`: un rechazo del dominio (`rejected`) es un desenlace esperado.'
    }),
    rule({
      uid: `keel-${model.service.artifactId}-latency`,
      title: 'p95 de los casos de uso',
      expr: `histogram_quantile(0.95, sum by (le, ${operationTag}) (rate(${useCase.bucket}[5m])))`,
      threshold: 1,
      forDuration: '10m',
      severity: 'warning',
      summary: 'Alguna operación pasa de un segundo en el p95. Degradación antes de que alguien se queje.'
    })
  );

  const groups = [
    {
      orgId: 1,
      name: model.service.artifactId,
      folder: `Keel ${model.service.name}`,
      interval: '1m',
      rules
    }
  ];
  return `# Alertas de ${model.service.name}, provisionadas en el Grafana de deploy/.
# Generado por keel-spring build.
#
# En deploy/ no hay contacto configurado: las alertas se ven en la interfaz de Grafana y no salen
# a ninguna parte. Eso es suficiente para probar a mano; para un entorno de verdad, el equivalente
# portable de estas mismas reglas está en prometheus-rules.example.yaml.
${toYaml({ apiVersion: 1, groups })}`;
}

function rule({ uid, title, expr, threshold = 0, forDuration, severity, summary }) {
  return {
    uid,
    title,
    condition: 'C',
    for: forDuration,
    data: [
      {
        refId: 'A',
        relativeTimeRange: { from: 600, to: 0 },
        datasourceUid: DATASOURCE.uid,
        model: { refId: 'A', expr, instant: true }
      },
      {
        refId: 'C',
        datasourceUid: '__expr__',
        model: {
          refId: 'C',
          type: 'threshold',
          expression: 'A',
          conditions: [{ evaluator: { type: 'gt', params: [threshold] } }]
        }
      }
    ],
    labels: { severity },
    annotations: { summary }
  };
}

/**
 * Las mismas reglas en el formato de Prometheus, para quien no use Grafana. Es una REFERENCIA: no
 * se monta en ninguna parte, y por eso lleva el sufijo `.example`.
 */
function prometheusRules(model) {
  const useCase = promMetric(OBSERVATIONS.useCase);
  const operationTag = promTag(ATTRIBUTES.operation);
  const outcomeTag = promTag(ATTRIBUTES.outcome);
  const outbox = usesOutbox(model)
    ? `
      - alert: KeelOutboxDeadLettered
        expr: max_over_time(${promGauge('keel.outbox.dead_lettered')}[5m]) > 0
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: "Eventos del outbox rendidos: pérdida de datos"
`
    : '';
  return `# Las alertas de ${model.service.name} en formato Prometheus, como referencia portable.
# Generado por keel-spring build. Nadie monta este archivo: es para copiarlo al sistema de reglas
# que uses si no es el Grafana de deploy/.
groups:
  - name: keel-${model.service.artifactId}
    rules:${outbox}
      - alert: KeelUseCaseErrorRate
        expr: >-
          sum(rate(${useCase.count}{${outcomeTag}="error"}[5m]))
          / clamp_min(sum(rate(${useCase.count}[5m])), 0.001) > 0.05
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "Más del 5 % de los casos de uso está fallando"
      - alert: KeelUseCaseLatency
        expr: >-
          histogram_quantile(0.95, sum by (le, ${operationTag}) (rate(${useCase.bucket}[5m]))) > 1
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "El p95 de alguna operación pasa de un segundo"
`;
}

/**
 * YAML mínimo y determinista para la estructura de las alertas. No entra una dependencia nueva
 * por esto: el generador no tiene ninguna y el árbol que produce tiene que ser byte a byte igual
 * entre dos builds, cosa que un serializador de terceros no promete entre versiones.
 */
function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value
      .map((item) => {
        const rendered = toYaml(item, indent + 2);
        return `${pad}- ${rendered.slice(indent + 2)}`;
      })
      .join('');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${pad}{}\n`;
    return entries
      .map(([key, item]) => {
        if (item && typeof item === 'object') {
          const nested = toYaml(item, indent + 2);
          return `${pad}${key}:\n${nested}`;
        }
        return `${pad}${key}: ${scalar(item)}\n`;
      })
      .join('');
  }
  return `${pad}${scalar(value)}\n`;
}

function scalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  return /^[A-Za-z0-9_./-]+$/.test(text) ? text : JSON.stringify(text);
}
