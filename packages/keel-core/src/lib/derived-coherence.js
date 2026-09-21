// Coherencia de CONTENIDO de los contratos derivados con el diseño.
//
// `listDerivatives()` sabe si un derivado está al día comparando la versión que lleva
// estampada, y nada más: un `openapi.yaml` con la versión correcta y un status equivocado
// sale «fresh». Y estos archivos no los escribe build sino un LLM siguiendo la skill
// `/keel-docs`, así que pueden desviarse del YAML sin que nada lo note — son, además, lo que
// lee quien integra y lo que viaja en el snapshot `docs/` del proyecto generado.
//
// Lo que se contrasta es solo lo ESTRUCTURAL, que no necesita criterio: rutas, métodos,
// status, canales, eventos, campos. Prosa, descripciones y ejemplos quedan fuera a propósito.
// Todo es AVISO: un derivado desviado se regenera, no bloquea el diseño del que salió.
//
// Módulo puro salvo la lectura de los tres archivos: sin consola ni escrituras.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { checkFor } from './checks.js';
import { FRAMEWORK_ERRORS } from './framework-errors.js';
import { splitScenarioBlocks, scenarioFamilyOf } from './scenario-blocks.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * @param {object} args
 * @param {object} args.layers capas del diseño
 * @param {object} args.manifest manifiesto
 * @param {string} args.docsDir `docs/<servicio>/` del workspace
 * @param {string|null} args.scenarios texto de validation-scenarios.md
 * @returns {{ findings: Array<{id: string, severity: string, message: string}> }}
 */
export function checkDerivedCoherence({ layers, manifest, docsDir, scenarios = null }) {
  const findings = [];
  const warn = (id, message) => {
    const entry = checkFor(id);
    if (!entry) throw new Error(`derived-coherence emite '${id}', que no está en el catálogo de checks`);
    findings.push({ id, severity: entry.severity, message });
  };
  if (!docsDir || !fs.existsSync(docsDir)) return { findings };

  const name = manifest?.service?.name;
  if (layers.api) checkOpenapi(path.join(docsDir, 'openapi.yaml'), layers, warn);
  if (layers.messaging) checkAsyncapi(path.join(docsDir, 'asyncapi.yaml'), layers, warn);
  if (layers.api && name) {
    checkPostman(path.join(docsDir, 'postman', `${name}-collection.json`), layers, scenarios, warn);
  }
  return { findings };
}

function readYaml(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// ─── rutas del diseño ────────────────────────────────────────────────────────

/** Los endpoints explícitos del diseño con su ruta completa. Con `auto` no se contrasta: las rutas no son del diseño. */
function designEndpoints(layers) {
  const api = layers.api;
  if (!api || api.auto === true) return [];
  const basePath = String(api.basePath ?? '').replace(/\/$/, '');
  return Object.entries(api.endpoints ?? {}).map(([operation, endpoint]) => ({
    operation,
    method: String(endpoint?.method ?? '').toLowerCase(),
    path: `${basePath}${endpoint?.path ?? ''}`,
    successStatus: endpoint?.successStatus ?? null
  }));
}

/** Plantilla de ruta → regex. `{x}` casa un segmento; el peso cuenta los segmentos literales. */
function routeMatcher(template) {
  const segments = template.split('/').filter(Boolean);
  const pattern = segments.map((s) => (/^\{[^}]+\}$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return {
    regex: new RegExp(`^/${pattern.join('/')}/?$`),
    literals: segments.filter((s) => !/^\{[^}]+\}$/.test(s)).length
  };
}

/** Los status que una operación puede devolver sin contradecir al diseño. */
function allowedStatuses(layers, endpoint) {
  const op = layers['use-cases']?.operations?.[endpoint.operation] ?? {};
  const allowed = new Set([400]);
  if (endpoint.successStatus) allowed.add(endpoint.successStatus);
  else if (endpoint.method === 'post') [200, 201].forEach((s) => allowed.add(s));
  else if (endpoint.method === 'delete') [200, 204].forEach((s) => allowed.add(s));
  else allowed.add(200);
  for (const error of op.errors ?? []) allowed.add(error?.http ?? 400);
  for (const entry of Object.values(FRAMEWORK_ERRORS)) if (entry?.http) allowed.add(entry.http);
  if (layers.security) [401, 403].forEach((s) => allowed.add(s));
  return allowed;
}

// ─── openapi.yaml ────────────────────────────────────────────────────────────

function checkOpenapi(file, layers, warn) {
  const doc = readYaml(file);
  if (doc === null) return; // no generado: lo dice listDerivatives
  const id = 'CHK-DOCS-OPENAPI-DRIFT';
  if (!doc?.paths) {
    warn(id, `docs: openapi.yaml no se puede leer o no trae 'paths' — regenéralo con /keel-docs`);
    return;
  }
  const documented = new Map();
  for (const [route, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const operation = item?.[method];
      if (!operation?.operationId) continue;
      documented.set(operation.operationId, {
        path: route,
        method,
        statuses: new Set(Object.keys(operation.responses ?? {}).map((s) => Number(s)).filter(Number.isFinite))
      });
    }
  }
  const endpoints = designEndpoints(layers);
  const designOps = new Set(endpoints.map((e) => e.operation));
  for (const endpoint of endpoints) {
    const got = documented.get(endpoint.operation);
    if (!got) {
      warn(id, `docs: openapi.yaml no documenta '${endpoint.operation}' (${endpoint.method.toUpperCase()} ${endpoint.path}), que api declara — un integrador no la verá`);
      continue;
    }
    if (got.path !== endpoint.path || got.method !== endpoint.method) {
      warn(
        id,
        `docs: openapi.yaml documenta '${endpoint.operation}' como ${got.method.toUpperCase()} ${got.path} y api la declara ${endpoint.method.toUpperCase()} ${endpoint.path}`
      );
    }
    if (endpoint.successStatus && !got.statuses.has(endpoint.successStatus)) {
      warn(id, `docs: openapi.yaml no trae la respuesta ${endpoint.successStatus} de '${endpoint.operation}', que es su successStatus`);
    }
    const op = layers['use-cases']?.operations?.[endpoint.operation] ?? {};
    const missing = [...new Set((op.errors ?? []).map((e) => e?.http ?? 400))].filter((s) => !got.statuses.has(s));
    if (missing.length > 0) {
      warn(id, `docs: openapi.yaml no documenta ${missing.join(', ')} en '${endpoint.operation}', y sus errors los declaran`);
    }
  }
  if (layers.api?.auto !== true) {
    for (const operationId of documented.keys()) {
      if (!designOps.has(operationId)) {
        warn(id, `docs: openapi.yaml documenta '${operationId}', que api no declara — un contrato que el servidor no tiene`);
      }
    }
  }
}

// ─── asyncapi.yaml ───────────────────────────────────────────────────────────

function resolveRef(doc, node) {
  let current = node;
  for (let i = 0; i < 5 && current?.$ref; i++) {
    const parts = String(current.$ref).replace(/^#\//, '').split('/');
    current = parts.reduce((acc, part) => acc?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  }
  return current;
}

/** El esquema del payload DECLARADO de un mensaje: `data` si viaja en la envoltura keel, el payload si no. */
function payloadSchema(doc, message) {
  const payload = resolveRef(doc, message?.payload);
  const data = payload?.properties?.data;
  return resolveRef(doc, data ?? payload);
}

function checkAsyncapi(file, layers, warn) {
  const doc = readYaml(file);
  if (doc === null) return;
  const id = 'CHK-DOCS-ASYNCAPI-DRIFT';
  if (!doc?.channels) {
    warn(id, `docs: asyncapi.yaml no se puede leer o no trae 'channels' — regenéralo con /keel-docs`);
    return;
  }
  const messaging = layers.messaging;
  const channelsOf = (name) => doc.channels?.[name] ?? Object.values(doc.channels).find((c) => c?.address === name);
  for (const channel of Object.keys(messaging.channels ?? {})) {
    if (!channelsOf(channel)) warn(id, `docs: asyncapi.yaml no tiene el canal '${channel}', que messaging declara`);
  }
  const messages = doc.components?.messages ?? {};
  const events = [
    ...Object.entries(messaging.publishing?.events ?? {}).map(([n, e]) => ({ name: n, spec: e, channel: e?.channel })),
    ...Object.entries(messaging.subscriptions ?? {}).map(([n, e]) => ({ name: n, spec: e, channel: e?.channel }))
  ];
  for (const { name, spec, channel } of events) {
    const message = messages[name];
    if (!message) {
      warn(id, `docs: asyncapi.yaml no define el mensaje '${name}', que messaging declara`);
      continue;
    }
    if (channel && channelsOf(channel) && !channelsOf(channel).messages?.[name]) {
      warn(id, `docs: asyncapi.yaml no publica '${name}' en el canal '${channel}', que es el que messaging le da`);
    }
    const schema = payloadSchema(doc, message);
    if (!schema?.properties) continue; // un payload sin forma legible no se puede contrastar sin adivinar
    const declared = Object.keys(spec?.payload ?? {});
    const documented = Object.keys(schema.properties);
    const missing = declared.filter((f) => !documented.includes(f));
    const extra = documented.filter((f) => !declared.includes(f));
    if (missing.length > 0) warn(id, `docs: asyncapi.yaml omite en '${name}' ${missing.map((f) => `'${f}'`).join(', ')}, que su payload declara`);
    if (extra.length > 0) warn(id, `docs: asyncapi.yaml añade a '${name}' ${extra.map((f) => `'${f}'`).join(', ')}, que su payload no declara`);
    const required = new Set(schema.required ?? []);
    const requiredDrift = declared.filter((f) => documented.includes(f) && Boolean(spec.payload[f]?.required) !== required.has(f));
    if (requiredDrift.length > 0) {
      warn(id, `docs: asyncapi.yaml no coincide con messaging en qué campos de '${name}' son obligatorios: ${requiredDrift.map((f) => `'${f}'`).join(', ')}`);
    }
  }
}

// ─── colección Postman ───────────────────────────────────────────────────────

function flatten(items, into = []) {
  for (const item of items ?? []) {
    if (Array.isArray(item?.item)) flatten(item.item, into);
    else if (item?.request) into.push(item);
  }
  return into;
}

function requestPath(request) {
  const url = request?.url;
  const raw = typeof url === 'string' ? url : url?.raw ?? (Array.isArray(url?.path) ? `/${url.path.join('/')}` : '');
  return raw.replace(/^\{\{[^}]+\}\}/, '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
}

function assertedStatus(item) {
  const script = (item.event ?? []).flatMap((e) => e?.script?.exec ?? []).join('\n');
  const inScript = /have\.status\((\d{3})\)|\.code\)\.to\.(?:eql|equal)\((\d{3})\)/.exec(script);
  if (inScript) return Number(inScript[1] ?? inScript[2]);
  const inName = /\((\d{3})\)\s*$/.exec(item.name ?? '');
  return inName ? Number(inName[1]) : null;
}

function checkPostman(file, layers, scenarios, warn) {
  if (!fs.existsSync(file)) return;
  const id = 'CHK-DOCS-POSTMAN-DRIFT';
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    warn(id, `docs: ${path.basename(file)} no es JSON válido — regenéralo con /keel-docs`);
    return;
  }
  const rel = `postman/${path.basename(file)}`;

  // Carpetas ↔ flujos del documento de escenarios.
  if (scenarios) {
    const families = new Set(splitScenarioBlocks(scenarios).map((block) => scenarioFamilyOf(block)));
    const folders = (doc.item ?? []).filter((item) => Array.isArray(item?.item));
    const folderFlows = new Set(folders.map((f) => (/^(FL-[A-Za-z0-9]+-\d+)/.exec(f.name ?? '') ?? [])[1]).filter(Boolean));
    for (const family of families) {
      if (!folderFlows.has(family)) warn(id, `docs: ${rel} no tiene carpeta para ${family}, que validation-scenarios.md define`);
    }
    for (const flow of folderFlows) {
      if (!families.has(flow)) warn(id, `docs: ${rel} tiene una carpeta de ${flow}, que validation-scenarios.md ya no define`);
    }
  }

  // Cada request contra el endpoint que dice llamar y los status que ese endpoint puede dar.
  const endpoints = designEndpoints(layers).map((e) => ({ ...e, ...routeMatcher(e.path) }));
  if (endpoints.length === 0) return;
  for (const item of flatten(doc.item)) {
    const method = String(item.request?.method ?? '').toLowerCase();
    const route = requestPath(item.request).replace(/\{\{[^}]+\}\}/g, 'x').replace(/\/:[A-Za-z_]+/g, '/x');
    const candidates = endpoints
      .filter((e) => e.method === method && e.regex.test(route))
      .sort((a, b) => b.literals - a.literals);
    const label = `'${item.name}'`;
    if (candidates.length === 0) {
      if (method === 'options') continue; // preflight CORS: no es una operación del diseño
      warn(id, `docs: ${rel} ${label} llama a ${method.toUpperCase()} ${route}, que no casa con ningún endpoint de api`);
      continue;
    }
    const endpoint = candidates[0];
    const status = assertedStatus(item);
    if (status !== null && !allowedStatuses(layers, endpoint).has(status)) {
      warn(
        id,
        `docs: ${rel} ${label} afirma ${status} sobre '${endpoint.operation}', que ese endpoint no puede devolver según el diseño ` +
          `— suele ser el status de otro paso del flujo copiado a esta request`
      );
    }
  }
}
