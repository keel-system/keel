// Las preguntas AL BACKEND de `deploy/` que hacen los `deploy-check` de los dos generadores (incremento 14f de
// PLAN-KEEL-NEST.md). Son las mismas para keel-spring y keel-nest porque el backend, el colector, el panel, las
// alertas y el contacto son los mismos (`deploy.js`, `observability-assets.js`): lo único de cada uno es cómo se
// levanta su app y qué serie de runtime publica su scrape (DEP-1).
//
// Lo que mide la ruta de PRODUCCIÓN de la telemetría, la que una sonda con la app en el host no puede tocar: que el
// colector alcance a la app por la red del compose y se traiga sus métricas, que el exemplar sobreviva hasta el
// backend (el Prometheus de la imagen los TIRA sin `exemplar-storage`), que con él se llegue a la traza, que el panel y
// las alertas entraran, y que el CONTACTO entregue (si `$__env{…}` no se resolvió, la entrega falla sin ningún
// síntoma: las alertas se siguen viendo en la interfaz).

import { ALERTING } from './infra-catalog.js';
import { ATTRIBUTES, OBSERVATIONS, promMetric, promTag } from './telemetry-vocabulary.js';
import { dashboardUid } from './observability-assets.js';

export const DEPLOY_CASES = [
  { id: 'DEP-1', title: 'el perfil develop expone el scrape que el colector viene a buscar' },
  { id: 'DEP-2', title: 'la serie del caso de uso llegó al backend por el scrape, con su servicio' },
  { id: 'DEP-3', title: 'el exemplar sobrevivió al viaje y trae un id de traza' },
  { id: 'DEP-4', title: 'esa traza existe en el backend de trazas: el salto métrica→traza se cierra' },
  { id: 'DEP-5', title: 'los logs del servicio llegaron al backend de logs' },
  { id: 'DEP-6', title: 'el panel provisionado entró con su uid' },
  { id: 'DEP-7', title: 'las alertas provisionadas están cargadas y la política enruta al contacto' },
  { id: 'DEP-8', title: 'una alerta que dispara recorre la política y LLEGA al contacto' }
];

// Las credenciales del backend de prueba de la imagen. No son un secreto: es el Grafana de deploy/, que nace con
// admin/admin y no sale de la máquina.
const GRAFANA_USER = 'admin';
const GRAFANA_PASSWORD = 'admin';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Una lectura HTTP que nunca lanza: un ECONNREFUSED durante el arranque es esperable. */
export async function httpRead(url, options = {}) {
  try {
    const response = await fetch(url, options);
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    return { ok: false, status: 0, text: '', error: String(error) };
  }
}

/**
 * Una petición GET del diseño con la que atravesar un caso de uso, sacada del MODELO. Un GET y no un POST: un POST con
 * el cuerpo vacío lo rechaza la validación del borde y no llega al mediator. Un `{segmento}` se sustituye por un uuid
 * que no existe: el handler recién generado lanza antes de mirarlo y la observación se cierra igual.
 */
export function trafficPath(model) {
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      if (operation.route?.method !== 'GET') continue;
      return `${model.api.routeBase}${operation.route.path}`.replace(/\{[^}]+\}/g, '11111111-1111-1111-1111-111111111111');
    }
  }
  return null;
}

/**
 * DEP-2 a DEP-8 contra el backend de `deploy/` ya levantado y con tráfico enviado. `record(id, ok, detalle)` recibe
 * cada caso. Devuelve los avisos que no son un caso.
 */
export async function probeDeployBackend({ grafanaUrl, sinkUrl, serviceName, record }) {
  const basic = 'Basic ' + Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASSWORD}`).toString('base64');
  const grafana = async (pathname, options = {}) => {
    const response = await httpRead(grafanaUrl + pathname, {
      ...options,
      headers: { Authorization: basic, 'Content-Type': 'application/json', ...(options.headers ?? {}) }
    });
    let json = null;
    try {
      json = JSON.parse(response.text);
    } catch {
      json = null;
    }
    return { ...response, json };
  };
  const promQuery = async (uid, query) =>
    (await grafana(`/api/datasources/proxy/uid/${uid}/api/v1/query?query=${encodeURIComponent(query)}`)).json?.data?.result ?? [];
  const warnings = [];

  // Los datasources, por TIPO: sus uids son de la imagen del backend y pueden cambiar con ella.
  const datasources = (await grafana('/api/datasources')).json ?? [];
  const uidOf = (type) => datasources.find((item) => item.type === type)?.uid ?? null;
  const prometheusUid = uidOf('prometheus');
  const tempoUid = uidOf('tempo');
  const lokiUid = uidOf('loki');
  if (!prometheusUid) throw new Error('Grafana no tiene datasource de Prometheus: el backend de prueba no arrancó como se esperaba');

  const useCase = promMetric(OBSERVATIONS.useCase);
  let series = [];
  for (let attempt = 0; attempt < 24 && series.length === 0; attempt++) {
    series = await promQuery(prometheusUid, useCase.count);
    if (series.length === 0) await sleep(5000);
  }

  // DEP-2. Con `service_name`: un scrape no trae los atributos de recurso, los pone el procesador `resource/scrape`.
  const withService = series.some((item) => item.metric?.service_name);
  record(
    'DEP-2',
    series.length > 0 && withService,
    series.length === 0
      ? `el backend no tiene ${useCase.count}: el colector no alcanzó a la app, o su scrape no está configurado`
      : withService
        ? ''
        : 'la serie llegó sin service_name: falta el procesador resource/scrape del colector'
  );
  if (series.length > 0 && !series.some((item) => item.metric?.[promTag(ATTRIBUTES.outcome)])) {
    warnings.push(`la serie llegó sin la etiqueta ${promTag(ATTRIBUTES.outcome)}; la alerta de tasa de error filtra por ella`);
  }

  // DEP-3. El exemplar: lo que hace que del punto se pueda saltar a la petición concreta.
  const now = Math.floor(Date.now() / 1000);
  const exemplars = await grafana(
    `/api/datasources/proxy/uid/${prometheusUid}/api/v1/query_exemplars?query=${encodeURIComponent(useCase.bucket)}&start=${now - 900}&end=${now}`
  );
  const traceId = exemplars.json?.data
    ?.flatMap((item) => item.exemplars ?? [])
    .map((item) => item.labels?.trace_id ?? item.labels?.traceID)
    .find(Boolean);
  record(
    'DEP-3',
    Boolean(traceId),
    traceId
      ? ''
      : 'ningún exemplar en el backend: el Prometheus de la imagen los acepta y los TIRA sin --enable-feature=exemplar-storage, y tampoco hay exemplar si la traza no se muestreó'
  );

  // DEP-4. Y que ese id lleve de verdad a una traza: el salto completo.
  if (traceId && tempoUid) {
    // Con reintentos: el exemplar llega por el scrape en segundos, pero la traza viaja por OTLP con dos lotes por
    // delante (el del SDK y el del colector) y Tempo tarda en hacerla consultable. Un 404 inmediato no es un fallo;
    // uno al cabo de un minuto, sí. Medido: la primera pasada de keel-nest dio 404 con la traza ya en camino.
    let trace = await grafana(`/api/datasources/proxy/uid/${tempoUid}/api/traces/${traceId}`);
    for (let attempt = 0; attempt < 12 && !trace.ok; attempt++) {
      await sleep(5000);
      trace = await grafana(`/api/datasources/proxy/uid/${tempoUid}/api/traces/${traceId}`);
    }
    record('DEP-4', trace.ok && trace.text.length > 2, trace.ok ? '' : `Tempo respondió ${trace.status} para ${traceId} tras un minuto`);
  } else {
    record('DEP-4', false, traceId ? 'no hay datasource de trazas' : 'sin exemplar no hay traza a la que saltar');
  }

  // DEP-5. Los logs. En deploy/ van por OTLP a propósito, porque allí nadie recoge la consola.
  if (lokiUid) {
    // Con reintentos, por lo mismo que DEP-4: los logs viajan por OTLP con dos lotes por delante (el
    // procesador del SDK y el del colector) y Loki tarda en hacerlos consultables. Una sola consulta
    // daba KO o OK según la pasada con el mismo servidor (medido al subir keel-spring a Boot 4).
    // Vacío al cabo de un minuto sí es un fallo. El fin de la ventana se recalcula en cada intento.
    const query = `{service_name="${serviceName}"}`;
    const readLogs = async () => {
      const end = Math.floor(Date.now() / 1000);
      const logs = await grafana(
        `/api/datasources/proxy/uid/${lokiUid}/loki/api/v1/query_range?query=${encodeURIComponent(query)}&start=${(now - 900) * 1e9}&end=${end * 1e9}&limit=5`
      );
      return (logs.json?.data?.result ?? []).flatMap((item) => item.values ?? []);
    };
    let lines = await readLogs();
    for (let attempt = 0; attempt < 12 && lines.length === 0; attempt++) {
      await sleep(5000);
      lines = await readLogs();
    }
    record('DEP-5', lines.length > 0, lines.length > 0 ? '' : 'Loki no tiene logs del servicio tras un minuto: ¿LOG_EXPORT_OTLP?');
  } else {
    record('DEP-5', false, 'no hay datasource de logs');
  }

  // DEP-6. El panel: un montaje mal puesto deja a Grafana arrancando sin decir nada.
  const uid = dashboardUid({ service: { artifactId: serviceName } });
  const panel = await grafana(`/api/dashboards/uid/${uid}`);
  record('DEP-6', panel.ok, panel.ok ? '' : `el panel ${uid} no entró (${panel.status})`);

  // DEP-7. Las reglas y la política.
  const rules = (await grafana('/api/v1/provisioning/alert-rules')).json ?? [];
  const ours = rules.filter((rule) => String(rule.uid ?? '').startsWith(`keel-${serviceName}`));
  const policy = (await grafana('/api/v1/provisioning/policies')).json ?? {};
  const routes = policy.receiver === ALERTING.contactPoint;
  record(
    'DEP-7',
    ours.length > 0 && routes,
    ours.length === 0
      ? 'ninguna regla provisionada llegó a Grafana'
      : routes
        ? ''
        : `la política no enruta a ${ALERTING.contactPoint}: las alertas se verían en la interfaz y no saldrían`
  );

  // DEP-8. La entrega, con el contacto TAL COMO QUEDÓ PROVISIONADO: si `$__env{…}` no se resolvió, su url es el
  // literal y la entrega falla sin ningún síntoma. Se dispara una alerta de verdad (no el botón «Test», que cambia de
  // API entre versiones y se salta la política): una regla temporal siempre cierta, con `for: 0s`, en el MISMO grupo
  // que las provisionadas para heredar su intervalo.
  const contacts = (await grafana('/api/v1/provisioning/contact-points')).json ?? [];
  const contact = contacts.find((item) => item.name === ALERTING.contactPoint);
  const count = (text) => (text.match(new RegExp(ALERTING.sink.path, 'g')) ?? []).length;
  if (!contact) {
    record('DEP-8', false, 'el contacto no llegó a provisionarse');
  } else if (String(contact.settings?.url ?? '').includes('$__env')) {
    record('DEP-8', false, `la url del contacto quedó sin resolver (${contact.settings.url}): la variable no llegó al proceso de Grafana`);
  } else {
    const before = count((await httpRead(`${sinkUrl}/__admin/requests`)).text);
    const provisioned = ours[0];
    const probe = {
      title: 'KeelDeployCheckProbe',
      ruleGroup: provisioned?.ruleGroup,
      folderUID: provisioned?.folderUID,
      orgID: 1,
      condition: 'B',
      for: '0s',
      noDataState: 'OK',
      execErrState: 'OK',
      labels: { severity: 'warning' },
      annotations: { summary: 'Sonda de deploy-check: comprobando que el contacto entrega' },
      data: [
        {
          refId: 'A',
          datasourceUid: '__expr__',
          relativeTimeRange: { from: 600, to: 0 },
          model: { refId: 'A', type: 'math', expression: '1', datasource: { type: '__expr__', uid: '__expr__' } }
        },
        {
          refId: 'B',
          datasourceUid: '__expr__',
          model: {
            refId: 'B',
            type: 'threshold',
            expression: 'A',
            conditions: [{ evaluator: { type: 'gt', params: [0] } }],
            datasource: { type: '__expr__', uid: '__expr__' }
          }
        }
      ]
    };
    const created = await grafana('/api/v1/provisioning/alert-rules', {
      method: 'POST',
      // Sin esto la regla queda marcada como provisionada y no se puede borrar luego por API.
      headers: { 'X-Disable-Provenance': 'true' },
      body: JSON.stringify(probe)
    });
    let delivered = before;
    if (created.ok) {
      for (let attempt = 0; attempt < 36 && delivered === before; attempt++) {
        await sleep(5000);
        delivered = count((await httpRead(`${sinkUrl}/__admin/requests`)).text);
      }
      if (created.json?.uid) await grafana(`/api/v1/provisioning/alert-rules/${created.json.uid}`, { method: 'DELETE' });
    }
    record(
      'DEP-8',
      delivered > before,
      created.ok
        ? 'la alerta disparó y la política la enrutó, pero el webhook no llegó al sumidero: mira la url del contacto y la red del compose'
        : `no se pudo crear la regla de sonda (${created.status}): sin ella no hay alerta que recorra la política`
    );
  }
  return warnings;
}
