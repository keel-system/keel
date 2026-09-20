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

import { ALERTING, OBSERVABILITY_DIR, GRAFANA_PROVISIONING, alertSinkEndpoint } from '../lib/stack-catalog.js';
import {
  ATTRIBUTES,
  OBSERVATIONS,
  RUNTIME_JVM,
  consumerLagFor,
  promGauge,
  promMetric,
  promTag,
  runtimePool,
  usesTelemetry
} from '../lib/telemetry-probes.js';
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
    { path: `deploy/${OBSERVABILITY_DIR}/alertmanager.example.yaml`, content: alertmanagerExample(model) },
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
    const items = [
      timeseries('Consumos por segundo', [
        target(`sum by (${promTag(ATTRIBUTES.eventType)}) (rate(${consume.count}[$__rate_interval]))`, `{{${promTag(ATTRIBUTES.eventType)}}}`)
      ])
    ];
    // El RETRASO, que es otra pregunta: el ritmo y la duración no bajan cuando un consumidor se
    // queda atrás —procesa igual de rápido, solo que cada vez más tarde—. Solo se emite si el
    // broker elegido publica la serie; con los otros, una consulta aquí no fallaría: se quedaría
    // vacía, que es lo que este módulo existe para no hacer.
    const lag = consumerLag(model);
    if (lag) {
      items.push(
        timeseries('Retraso del consumidor (mensajes por detrás)', [
          target(`max by (topic) (${lag.series})`, '{{topic}}')
        ])
      );
    }
    row('Mensajes consumidos', items);
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

  // El RUNTIME va el último a propósito: no es lo que se mira primero, es a donde se baja cuando
  // lo de arriba dice que algo va lento y no se sabe por qué. Lo publica Boot en este mismo
  // scrape desde siempre; lo que faltaba era enseñarlo.
  const pool = poolFor(model);
  const runtimeItems = [
    timeseries(
      'Heap usado sobre el máximo',
      [
        target(
          `sum(${RUNTIME_JVM.memoryUsed}{area="heap"}) / clamp_min(sum(${RUNTIME_JVM.memoryMax}{area="heap"}), 1)`,
          'heap'
        )
      ],
      'percentunit'
    ),
    // Segundos de pausa por segundo de reloj: cuánto del tiempo se le va a la JVM en recolectar.
    timeseries(
      'Tiempo en pausas de GC',
      [target(`sum(rate(${promMetric(RUNTIME_JVM.gcPause.replace(/_seconds$/, '')).sum}[$__rate_interval]))`, 'gc')],
      's'
    )
  ];
  if (pool) {
    runtimeItems.push(
      timeseries(`Conexiones del pool (${pool.label})`, [
        target(`sum(${pool.active})`, 'en uso'),
        ...(pool.idle ? [target(`sum(${pool.idle})`, 'libres')] : []),
        target(`sum(${pool.max})`, 'máximo'),
        target(`sum(${pool.saturation})`, 'esperando')
      ])
    );
  }
  row('Runtime', runtimeItems);

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

/**
 * El pool de conexiones de ESTE proyecto, o `null` si el diseño no persiste nada.
 *
 * <p>Bifurca por modelo, y es una de las asimetrías que más barata sale de cometer: las celdas de
 * Hikari en un proyecto documental no fallan, se quedan vacías justo en el sitio al que se baja
 * cuando algo va lento.
 */
function poolFor(model) {
  if (!model.layersPresent?.persistence) return null;
  return runtimePool(model.persistenceKind);
}

/**
 * El retraso del consumidor, si hay consumidores y el broker elegido lo publica.
 *
 * <p>Las dos condiciones son necesarias: un servicio que solo PUBLICA no tiene ningún consumidor
 * del que medir retraso, y con RabbitMQ o SNS/SQS el dato no sale de la aplicación (ver
 * `CONSUMER_LAG` en `src/lib/telemetry-probes.js`, que dice qué mirar en su lugar).
 */
function consumerLag(model) {
  if ((model.subscriptions ?? []).length === 0) return null;
  return consumerLagFor(model.stack?.broker);
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
 * Las alertas, en el formato de provisioning de Grafana: las de NEGOCIO, las del RUNTIME y —donde
 * el broker lo permite— la del retraso del consumidor.
 *
 * <p>No son unas cualesquiera. Las de negocio dicen que algo ya va mal: pérdida de datos en el
 * mecanismo cuya única promesa es que no se pierde nada, el servicio fallando, el servicio
 * degradándose. Las del runtime dicen por qué, y llegan antes — un pool agotado y un heap que no
 * baja preceden a la caída, y eran justo las dos cosas que más se rompen en producción y de las
 * que aquí no avisaba nadie.
 *
 * <p>Cada una se emite SOLO si su sujeto existe en el diseño: la del outbox con `reliability:
 * outbox`, la del pool si hay persistencia, la del retraso si hay consumidores y el broker
 * publica la serie. Una alerta sobre una métrica que nadie publica no falla: no dispara nunca.
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

  // Las dos del RUNTIME. Las de arriba dicen que el servicio está fallando o yendo lento; estas
  // dicen POR QUÉ, y llegan antes: un pool agotado y un heap que no baja preceden a la caída.
  const pool = poolFor(model);
  if (pool) {
    rules.push(
      rule({
        uid: `keel-${model.service.artifactId}-pool`,
        title: 'Saturación del pool de conexiones',
        expr: `max_over_time(${pool.saturation}[5m])`,
        forDuration: '5m',
        severity: 'warning',
        summary:
          `Hay peticiones ESPERANDO una conexión del pool (${pool.label}). A partir de aquí la latencia ` +
          'la pone la cola, no el trabajo: sube el tamaño del pool o busca lo que retiene conexiones.'
      })
    );
  }

  rules.push(
    rule({
      uid: `keel-${model.service.artifactId}-heap`,
      title: 'Presión de memoria en el heap',
      expr:
        `sum(${RUNTIME_JVM.memoryUsed}{area="heap"})` +
        ` / clamp_min(sum(${RUNTIME_JVM.memoryMax}{area="heap"}), 1)`,
      threshold: 0.9,
      forDuration: '10m',
      severity: 'warning',
      summary:
        'El heap lleva diez minutos por encima del 90 %. Lo que viene después es GC continuo y, al final, ' +
        'un OutOfMemoryError — que sí se ve, pero cuando ya no hay nada que hacer.'
    })
  );

  const lag = consumerLag(model);
  if (lag) {
    rules.push(
      rule({
        uid: `keel-${model.service.artifactId}-lag`,
        title: 'Retraso del consumidor',
        expr: `max(${lag.series})`,
        // Mil mensajes es un punto de partida, como el 5 % y el segundo de las de arriba: depende
        // del volumen de cada servicio y se ajusta con los primeros días de tráfico real.
        threshold: 1000,
        forDuration: '10m',
        severity: 'warning',
        summary:
          'El consumidor se está quedando atrás. No lo dice ninguna otra alerta: procesa igual de rápido, ' +
          'solo que cada vez más tarde.'
      })
    );
  }

  const groups = [
    {
      orgId: 1,
      name: model.service.artifactId,
      folder: `Keel ${model.service.name}`,
      interval: '1m',
      rules
    }
  ];
  // El CONTACTO, que es lo que separa «hay alertas» de «te avisan». La URL no se escribe aquí:
  // `$__env{…}` la resuelve Grafana al leer el archivo, así que el destino real lo pone quien
  // despliega sin tocar nada generado. En deploy/ la variable apunta a un sumidero que registra
  // lo que recibe, de forma que la entrega se puede LEER en vez de suponerse.
  const contactPoints = [
    {
      orgId: 1,
      name: ALERTING.contactPoint,
      receivers: [
        {
          uid: `keel-${model.service.artifactId}-webhook`,
          type: 'webhook',
          settings: { url: `$__env{${ALERTING.webhookVar}}` }
        }
      ]
    }
  ];

  // Y la política, que es la mitad que se olvida: un contacto al que no enruta nadie no recibe
  // nada. Agrupa por alerta y severidad para que una tormenta no sean cien mensajes.
  const policies = [
    {
      orgId: 1,
      receiver: ALERTING.contactPoint,
      group_by: ['alertname', 'severity'],
      group_wait: '30s',
      group_interval: '5m',
      repeat_interval: '4h'
    }
  ];

  return `# Alertas de ${model.service.name}, provisionadas en el Grafana de deploy/.
# Generado por keel-spring build.
#
# Trae también el CONTACTO y la política que enruta a él: sin las dos cosas, una alerta se ve en
# la interfaz y no sale a ninguna parte. La URL viene de la variable ${ALERTING.webhookVar}, que
# en deploy/ apunta al sumidero de alertas y en un entorno de verdad apunta a tu canal.
#
# OJO, y es una consecuencia, no un detalle: provisionar 'policies' SUSTITUYE el árbol de
# notificación por defecto de esta organización de Grafana, y el árbol provisionado deja de ser
# editable desde la interfaz. En el Grafana de deploy/ eso da igual; si llevas este archivo a un
# Grafana compartido, mira antes qué árbol tiene.
#
# El equivalente portable de estas mismas reglas, para quien no use Grafana, está en
# prometheus-rules.example.yaml, y su receptor en alertmanager.example.yaml.
${toYaml({ apiVersion: 1, groups, contactPoints, policies })}`;
}

function rule({ uid, title, expr, threshold = 0, forDuration, severity, summary }) {
  return {
    uid,
    title,
    condition: 'C',
    for: forDuration,
    // SIN DATOS no es un incidente, y el default de Grafana dice lo contrario: `NoData`, que
    // notifica. Medido en vivo sobre el Grafana de deploy/ —un servicio sin tráfico dejaba las
    // CUATRO reglas en `Pending (NoData)` camino de disparar—, y eso es justo lo que enseña a un
    // equipo a ignorar sus alertas: la primera noche de un servicio nuevo avisa cuatro veces sin
    // que pase nada. Sin tráfico no hay tasa de error ni p95 que medir; y si lo que falta es el
    // servicio ENTERO, quien tiene que decirlo es la plataforma (liveness), no una alerta de
    // negocio que hablaría de otra cosa.
    noDataState: 'OK',
    // Un error de ejecución sí merece verse, pero con NOMBRE PROPIO: con `Alerting` se dispararía
    // esta misma regla y su `summary` diría que el p95 subió cuando lo que pasa es que la consulta
    // no se puede evaluar. `Error` produce una alerta aparte que no se confunde con la de negocio.
    execErrState: 'Error',
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
  const pool = poolFor(model);
  const lag = consumerLag(model);
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
${pool
    ? `      - alert: KeelConnectionPoolSaturated
        expr: max_over_time(${pool.saturation}[5m]) > 0
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Hay peticiones esperando una conexión del pool (${pool.label})"
`
    : ''}      - alert: KeelHeapPressure
        expr: >-
          sum(${RUNTIME_JVM.memoryUsed}{area="heap"})
          / clamp_min(sum(${RUNTIME_JVM.memoryMax}{area="heap"}), 1) > 0.9
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "El heap lleva diez minutos por encima del 90 %"
${lag
    ? `      - alert: KeelConsumerLag
        expr: max(${lag.series}) > 1000
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "El consumidor se está quedando atrás"
`
    : ''}`;
}

/**
 * El receptor equivalente para quien no use Grafana: Alertmanager. Hermano de
 * `prometheus-rules.example.yaml` y con el mismo estatus — nadie lo monta, es para copiarlo.
 *
 * <p>Va aparte y no dentro del archivo de reglas porque son dos cosas distintas y se despliegan en
 * dos sitios distintos: las reglas las evalúa Prometheus, el enrutado a un canal lo hace
 * Alertmanager. Tenerlas juntas invita a copiar el bloque equivocado.
 */
function alertmanagerExample(model) {
  return `# El enrutado de las alertas de ${model.service.name} a un canal, para quien no use Grafana.
# Generado por keel-spring build. Nadie monta este archivo: es una referencia.
#
# Las REGLAS que disparan están en prometheus-rules.example.yaml; esto es lo otro —a quién se le
# cuenta—, que es justo la mitad que suele faltar: una regla sin receptor no avisa a nadie.
route:
  receiver: ${ALERTING.contactPoint}
  group_by: [alertname, severity]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

receivers:
  - name: ${ALERTING.contactPoint}
    webhook_configs:
      # La URL de tu canal (o del puente que hable con él). En deploy/ el equivalente es
      # ${ALERTING.webhookVar}, que apunta al sumidero de alertas.
      - url: ${alertSinkEndpoint()}
        send_resolved: true
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
