import { LAYERS } from './assets.js';
import { validateService } from './validate-service.js';

function keysOf(value) {
  return value && typeof value === 'object' ? Object.keys(value) : [];
}

function summarizeDomain(doc) {
  const aggregates = keysOf(doc?.aggregates).map((name) => ({
    name,
    root: doc.aggregates[name]?.root ?? name,
    entities: Array.isArray(doc.aggregates[name]?.entities) ? doc.aggregates[name].entities : []
  }));
  const rootsByEntity = new Map();
  for (const aggregate of aggregates) {
    rootsByEntity.set(aggregate.root, { aggregate: aggregate.name, isRoot: true });
    for (const member of aggregate.entities) {
      if (!rootsByEntity.has(member)) rootsByEntity.set(member, { aggregate: aggregate.name, isRoot: false });
    }
  }
  const entities = keysOf(doc?.entities).map((name) => ({
    name,
    lifecycle: doc.entities[name]?.lifecycle != null,
    aggregate: rootsByEntity.get(name)?.aggregate ?? null,
    aggregateRoot: rootsByEntity.get(name)?.isRoot ?? false
  }));
  return { typeCount: keysOf(doc?.types).length, entities, aggregates };
}

function summarizeUseCases(doc) {
  const operations = keysOf(doc?.operations).map((name) => {
    const op = doc.operations[name] ?? {};
    return {
      name,
      kind: op.kind ?? null,
      emits: Array.isArray(op.emits) ? op.emits : [],
      internal: op.internal === true,
      schedule: op.schedule != null
    };
  });
  return { operations };
}

function summarizeApi(doc) {
  const endpoints = keysOf(doc?.endpoints).map((operation) => ({
    operation,
    method: doc.endpoints[operation]?.method ?? null,
    path: doc.endpoints[operation]?.path ?? null
  }));
  return { style: doc?.style ?? null, basePath: doc?.basePath ?? null, auto: doc?.auto === true, endpoints };
}

function summarizeSecurity(doc) {
  return {
    authentication: doc?.authentication?.protocol ?? null,
    roles: keysOf(doc?.roles),
    defaultAccess: doc?.access?.default?.level ?? null
  };
}

function summarizeMessaging(doc) {
  return {
    reliability: doc?.publishing?.reliability ?? null,
    published: keysOf(doc?.publishing?.events),
    subscriptions: keysOf(doc?.subscriptions)
  };
}

function summarizeHttpClients(doc) {
  return { clients: keysOf(doc?.clients) };
}

function summarizePersistence(doc) {
  return { model: doc?.default?.model ?? null, entities: keysOf(doc?.entities) };
}

function summarizeStorage(doc) {
  const buckets = keysOf(doc?.buckets).map((name) => ({
    name,
    visibility: doc.buckets[name]?.visibility ?? 'private'
  }));
  return { buckets };
}

const LAYER_SUMMARIZERS = {
  domain: ['domain', summarizeDomain],
  'use-cases': ['useCases', summarizeUseCases],
  api: ['api', summarizeApi],
  security: ['security', summarizeSecurity],
  messaging: ['messaging', summarizeMessaging],
  'http-clients': ['httpClients', summarizeHttpClients],
  persistence: ['persistence', summarizePersistence],
  storage: ['storage', summarizeStorage]
};

/**
 * Resumen mecánico de un diseño para `keel describe`.
 * Objeto puro sin consola ni exitCode; reutiliza validateService (wip) para
 * cargar el servicio y detectar pendientes sin duplicar esa lógica.
 */
export function summarizeService(dir) {
  const validation = validateService(dir, { wip: true });
  const { manifest, layers } = validation;

  if (!manifest) {
    return {
      service: null,
      status: {
        loadFailed: true,
        ok: false,
        errorCount: validation.loadErrors.length,
        errors: validation.loadErrors,
        pending: []
      },
      layers: { present: [], absent: [...LAYERS] },
      summary: {}
    };
  }

  const present = LAYERS.filter((layer) => layer in layers);
  const summary = {};
  for (const layer of present) {
    const [key, summarize] = LAYER_SUMMARIZERS[layer];
    summary[key] = summarize(layers[layer]);
  }

  const errors = [
    ...validation.loadErrors,
    ...validation.schemaErrors.map(({ file }) => `${file}: no cumple el schema de su capa`),
    ...validation.crossRefErrors
  ];

  return {
    service: {
      name: manifest.service?.name ?? null,
      version: manifest.service?.version ?? null,
      dsl: manifest.keel ?? null,
      domain: manifest.service?.domain ?? null,
      basedOn: manifest.service?.basedOn ?? null,
      description: manifest.service?.description ?? null
    },
    status: {
      loadFailed: false,
      ok: validation.ok,
      errorCount: errors.length,
      errors,
      pending: validation.pending
    },
    layers: { present, absent: LAYERS.filter((layer) => !present.includes(layer)) },
    summary
  };
}
