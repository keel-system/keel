// El mapa del sistema: qué servicios lo componen, quién consume a quién y en
// qué orden se construyen.
//
// El resto del método tiene grano de un servicio: `specs/<servicio>/` es la
// fuente de verdad y todas las skills operan sobre uno. Pero un encargo real
// ("un sistema de venta de tickets") llega antes de que exista ningún servicio,
// y decidir cuáles hay y en qué orden se construyen es una decisión previa que
// no cabe en el DSL. De ahí este sidecar de workspace: `system.yaml` no describe
// lo que un servicio hace —eso es el DSL—, sino cómo se reparte el encargo.
//
// Lo que hace útil el mapa no es la tabla: es que, siendo declarativo, se puede
// contrastar contra los diseños reales. Es la única comprobación cross-servicio
// del método — `crossrefs.js` valida referencias DENTRO de un servicio y no
// puede saber si el `source: flight-catalog` de una suscripción existe, ni si
// ese servicio publica de verdad ese evento. Eso se comprueba aquí.
//
// Determinismo: sin marcas de tiempo ni rutas absolutas; las olas se ordenan
// alfabéticamente dentro de cada nivel y los hallazgos se emiten en orden fijo,
// para que `keel system check` sirva de puerta de CI.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import { schemaPathFor } from './assets.js';
import { MANIFEST_FILE } from './loader.js';
import { summarizeService } from './summarize-service.js';
import { listDerivatives } from './derivatives.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

export const SYSTEM_FILE = 'system.yaml';

// Estado real de un diseño frente al `status` que el mapa declara.
// absent: no existe specs/<servicio>. broken: existe y no carga.
// designing: carga pero tiene errores o capas en plantilla. designed: en verde.
const STATUS_LABEL = {
  absent: 'sin diseñar',
  broken: 'no carga',
  designing: 'en diseño',
  designed: 'diseñado',
  external: 'externo'
};

/** El `status` declarado que se corresponde con cada estado real. */
const EXPECTED_DECLARED = {
  absent: 'planned',
  broken: 'designing',
  designing: 'designing',
  designed: 'designed'
};

function buildValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: false });
  return ajv.compile(JSON.parse(fs.readFileSync(schemaPathFor('system'), 'utf8')));
}

/**
 * Errores de Ajv en una línea accionable: `message` a secas no dice qué
 * propiedad sobra ni qué valores acepta un enum — eso vive en `params`.
 * (Mismo criterio que design-index.js; no se comparte porque cada uno reporta
 * sobre un archivo distinto y la duplicación son tres líneas.)
 */
function describeAjvErrors(errors) {
  return errors
    .map((entry) => {
      const where = entry.instancePath || '/';
      if (entry.keyword === 'additionalProperties') {
        return `${where} propiedad no reconocida '${entry.params.additionalProperty}'`;
      }
      if (entry.keyword === 'enum') {
        return `${where} ${entry.message} (${entry.params.allowedValues.join(', ')})`;
      }
      return `${where} ${entry.message}`;
    })
    .join('; ');
}

/**
 * Lee y valida `system.yaml`. Devuelve { map, errors }: el mapa es null si no
 * existe o no es válido, y el motivo va en errors.
 */
export function loadSystemMap(cwd = process.cwd()) {
  const file = path.join(cwd, SYSTEM_FILE);
  if (!fs.existsSync(file)) {
    return { map: null, exists: false, errors: [] };
  }

  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { map: null, exists: true, errors: [`${SYSTEM_FILE}: YAML inválido — ${error.message}`] };
  }

  const validate = buildValidator();
  if (!validate(doc)) {
    return {
      map: null,
      exists: true,
      errors: [`${SYSTEM_FILE}: no cumple system.schema.json — ${describeAjvErrors(validate.errors)}`]
    };
  }

  return { map: doc, exists: true, errors: [] };
}

/** Slugs de `specs/` con manifiesto, en orden alfabético. */
function designSlugs(cwd) {
  const specsDir = path.join(cwd, 'specs');
  let entries;
  try {
    entries = fs.readdirSync(specsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(specsDir, name, MANIFEST_FILE)))
    .sort();
}

/**
 * Lee el diseño de un servicio del mapa: su estado real y lo que declara de
 * cara al mapa (dependencias, eventos publicados, suscripciones). Los servicios
 * `external` y los que aún no existen devuelven `present: false`.
 */
function readSpec(cwd, name) {
  const dir = path.join(cwd, 'specs', name);
  if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) {
    return { present: false, actualStatus: 'absent' };
  }

  const { status, layers, summary } = summarizeService(dir);
  if (status.loadFailed) {
    return { present: true, actualStatus: 'broken', errors: status.errors };
  }

  const { derivatives } = listDerivatives(dir, { cwd });
  const integration = derivatives.find((entry) => entry.id === 'integration');

  return {
    present: true,
    actualStatus: status.ok && status.pending.length === 0 ? 'designed' : 'designing',
    errors: status.errors,
    pending: status.pending,
    layers: layers.present,
    // El contrato es lo que un consumidor necesita para diseñarse: sin
    // INTEGRATION.md al día, `/keel-design` entra en modo degradado.
    contract: integration?.status ?? 'not-applicable',
    dependencies: (summary.dependencies?.dependencies ?? []).map((dep) => dep.name),
    // Un proveedor al que solo se le pide trabajo también es una dependencia del
    // diseño, pero se contrasta contra `invokes`, no contra `consumes`.
    activatedProviders: (summary.dependencies?.dependencies ?? [])
      .filter((dep) => (dep.activations ?? []).length > 0)
      .map((dep) => dep.name),
    readProviders: (summary.dependencies?.dependencies ?? [])
      .filter((dep) => (dep.needs ?? []).length > 0)
      .map((dep) => dep.name),
    // Consumir el evento de fallo de alguien a quien le encargas trabajo también
    // es leer de él, aunque no haya ningún `need`: la suscripción `fact` que
    // sostiene una compensación exige su arista `consumes` igual que una réplica.
    compensatedProviders: (summary.dependencies?.dependencies ?? [])
      .filter((dep) => (dep.compensations ?? []).length > 0)
      .map((dep) => dep.name),
    published: summary.messaging?.published ?? [],
    subscriptions: (summary.messaging?.subscriptions ?? []).map((sub) => ({
      name: sub.name,
      source: sub.source,
      nature: sub.nature ?? 'fact'
    })),
    // Para comprobar que a quien se invoca por HTTP enseña de verdad una puerta M2M.
    machineEndpoints: (summary.api?.endpoints ?? []).filter((endpoint) =>
      ['services', 'both'].includes(endpoint.audience)
    ).length
  };
}

/**
 * Reparte los servicios en olas de construcción. Solo cuentan las aristas
 * **bloqueantes** hacia servicios que diseñamos aquí: un proveedor externo ya
 * tiene contrato y uno no bloqueante se puede diseñar en paralelo (en modo
 * degradado, o porque el acoplamiento va en el otro sentido).
 *
 * Cuentan las dos direcciones de dependencia, y por el mismo motivo: hace falta
 * el contrato del otro para diseñarse. Al leer (`consumes`) es su contrato de
 * salida; al pedirle trabajo (`invokes`) es el de entrada, sin el cual no se
 * sabe qué mandarle.
 *
 * Kahn por niveles, cada nivel ordenado alfabéticamente. Lo que no entra en
 * ninguna ola es un ciclo: se devuelve aparte para que quien llame lo reporte.
 */
function computeWaves(services) {
  const buildable = Object.keys(services)
    .filter((name) => !services[name].external)
    .sort();
  const blockers = new Map();

  for (const name of buildable) {
    const entry = services[name];
    const required = new Set();
    for (const edge of entry.consumes ?? []) {
      if (edge.blocking === false) continue;
      if (!buildable.includes(edge.from) || edge.from === name) continue;
      required.add(edge.from);
    }
    for (const edge of entry.invokes ?? []) {
      if (edge.blocking === false) continue;
      if (!buildable.includes(edge.to) || edge.to === name) continue;
      required.add(edge.to);
    }
    for (const before of entry.after ?? []) {
      if (buildable.includes(before) && before !== name) required.add(before);
    }
    blockers.set(name, required);
  }

  const waves = [];
  const placed = new Set();
  let pending = [...buildable];

  while (pending.length > 0) {
    const ready = pending.filter((name) => [...blockers.get(name)].every((dep) => placed.has(dep)));
    if (ready.length === 0) break; // ciclo: nadie más puede entrar
    waves.push(ready);
    for (const name of ready) placed.add(name);
    pending = pending.filter((name) => !placed.has(name));
  }

  return { waves, cycle: pending };
}

/**
 * Aristas del mapa como lista plana, para la vista de contextos y el JSON.
 *
 * `from`/`to` es siempre proveedor → dependiente, venga la arista de un
 * `consumes` (el dependiente lee) o de un `invokes` (el dependiente pide). Lo
 * que las distingue es `relation`: quien pinta el mapa necesita saber si la
 * flecha transporta un dato o una petición de trabajo.
 */
function flattenEdges(services) {
  const edges = [];
  for (const name of Object.keys(services).sort()) {
    for (const edge of services[name].consumes ?? []) {
      edges.push({
        from: edge.from,
        to: name,
        relation: 'reads',
        kind: edge.kind,
        what: edge.what,
        events: edge.events ?? null,
        strategy: edge.strategy ?? null,
        blocking: edge.blocking !== false,
        why: edge.why
      });
    }
    for (const edge of services[name].invokes ?? []) {
      edges.push({
        from: edge.to,
        to: name,
        relation: 'invokes',
        kind: edge.kind,
        what: edge.what,
        events: edge.events ?? null,
        strategy: null,
        blocking: edge.blocking !== false,
        why: edge.why
      });
    }
  }
  return edges;
}

/**
 * Construye el plan del sistema: servicios con su estado real, olas de
 * construcción, aristas y hallazgos. Objeto puro: sin escrituras, sin consola,
 * sin exitCode.
 *
 * Los `findings` llevan `level` solo para presentarlos ordenados; para `check`
 * todos son motivo de rojo, igual que los avisos de `keel index --check`: un
 * mapa que no coincide con los diseños es un mapa que miente.
 */
export function buildSystemPlan(cwd = process.cwd()) {
  const { map, exists, errors } = loadSystemMap(cwd);
  if (!map) {
    return { exists, system: null, services: [], waves: [], edges: [], cycle: [], findings: errors.map(error) };
  }

  const declared = map.services;
  const names = Object.keys(declared).sort();
  const findings = [];

  // Cada diseño se lee una sola vez: las comprobaciones cruzadas necesitan los
  // dos extremos de la arista.
  const specs = new Map(
    names.map((name) => [name, declared[name].external ? { present: false, actualStatus: 'external' } : readSpec(cwd, name)])
  );

  // --- Coherencia interna del mapa -----------------------------------------
  for (const name of names) {
    const entry = declared[name];
    const seen = new Set();
    for (const edge of entry.consumes ?? []) {
      const label = `services.${name}.consumes[${edge.from}]`;
      if (edge.from === name) {
        findings.push(error(`${label}: un servicio no se consume a sí mismo.`));
        continue;
      }
      if (!(edge.from in declared)) {
        findings.push(error(`${label}: '${edge.from}' no está declarado en services. Añádelo al mapa o corrige la arista.`));
        continue;
      }
      const key = `${edge.from}/${edge.kind}`;
      if (seen.has(key)) {
        findings.push(warning(`${label}: hay dos aristas ${edge.kind} contra '${edge.from}'. Únelas en una con todos sus 'what'.`));
      }
      seen.add(key);
      if (edge.kind === 'http' && edge.events) {
        findings.push(warning(`${label}: 'events' solo aplica a aristas de tipo events; en una arista http no significa nada.`));
      }
      if (edge.kind === 'events' && !edge.events) {
        findings.push(
          warning(
            `${label}: arista de eventos sin 'events'. Sin los nombres de evento no se puede comprobar que '${edge.from}' los publique.`
          )
        );
      }
      // El evento suscrito tiene que estar en el `publishes` del proveedor: es
      // el acuerdo entre dos servicios que hasta ahora nadie comprobaba.
      for (const event of edge.events ?? []) {
        if (!(declared[edge.from].publishes ?? []).includes(event)) {
          findings.push(
            error(
              `${label}: '${edge.from}' no declara publicar '${event}'. Añádelo a services.${edge.from}.publishes o corrige el nombre.`
            )
          );
          continue;
        }
        // La única comprobación del método que cruza dos specs: que el
        // proveedor publique de verdad, en su capa messaging, lo que el mapa
        // promete al consumidor. Solo se exige a un diseño ya cerrado.
        const provider = specs.get(edge.from);
        if (provider?.actualStatus === 'designed' && !provider.published.includes(event)) {
          findings.push(
            error(
              `specs/${edge.from}: el mapa dice que publica '${event}' para '${name}', pero su capa messaging no lo publica. ` +
                'Uno de los dos está mal, y el consumidor se integrará contra un evento que no existe.'
            )
          );
        }
      }
    }
    // --- Aristas de activación: este servicio le pide trabajo a otro ---------
    const invoked = new Set();
    for (const edge of entry.invokes ?? []) {
      const label = `services.${name}.invokes[${edge.to}]`;
      if (edge.to === name) {
        findings.push(error(`${label}: un servicio no se invoca a sí mismo.`));
        continue;
      }
      if (!(edge.to in declared)) {
        findings.push(error(`${label}: '${edge.to}' no está declarado en services. Añádelo al mapa o corrige la arista.`));
        continue;
      }
      const key = `${edge.to}/${edge.kind}`;
      if (invoked.has(key)) {
        findings.push(warning(`${label}: hay dos aristas ${edge.kind} contra '${edge.to}'. Únelas en una con todos sus 'what'.`));
      }
      invoked.add(key);
      if (edge.kind === 'http' && edge.events) {
        findings.push(warning(`${label}: 'events' solo aplica a aristas de tipo events; en una arista http no significa nada.`));
      }
      if (edge.kind === 'events' && !edge.events) {
        findings.push(
          warning(
            `${label}: arista de eventos sin 'events'. Sin los nombres del mensaje no se puede comprobar que '${edge.to}' se comprometa a atenderlo.`
          )
        );
      }

      // Un mensaje no puede ser a la vez una petición que le hacemos y un hecho
      // nuestro al que el otro reacciona por su cuenta: son dos acoplamientos
      // opuestos, y declarados a la vez fabrican un ciclo que no existe.
      const mirrored = (declared[edge.to].consumes ?? []).find(
        (other) => other.from === name && other.kind === edge.kind
      );
      if (mirrored) {
        findings.push(
          error(
            `${label}: '${name}' declara que le pide trabajo a '${edge.to}' y '${edge.to}' declara que consume de '${name}' por el mismo canal. ` +
              'Decide cuál es: si el trabajo se le pide, la arista es solo esta; si el otro reacciona a un hecho nuestro por su cuenta, la arista es solo su consumes.'
          )
        );
      }

      const provider = specs.get(edge.to);
      for (const event of edge.events ?? []) {
        // Espejo del acuerdo de eventos, con el sentido invertido: al leer se
        // comprueba que el proveedor PUBLIQUE; al pedirle trabajo, que ESCUCHE.
        if (provider?.actualStatus !== 'designed') continue;
        const sub = provider.subscriptions.find((entry) => entry.name === event);
        if (!sub) {
          findings.push(
            error(
              `specs/${edge.to}: el mapa dice que '${name}' le pide trabajo con '${event}', pero su capa messaging no lo consume. ` +
                'Sin suscripción, el mensaje se publica y no lo atiende nadie.'
            )
          );
        } else if (sub.nature !== 'request') {
          findings.push(
            error(
              `specs/${edge.to}: consume '${event}' como 'fact', pero '${name}' lo emite para pedirle trabajo. ` +
                "Un 'fact' es un hecho al que se reacciona por cuenta propia: nadie se compromete a atenderlo, y su payload no es contrato de entrada. " +
                `Márcalo nature: request en messaging: subscriptions.${event}, o corrige la arista.`
            )
          );
        }
      }
      // Pedir trabajo por HTTP exige una puerta abierta a servicios.
      if (edge.kind === 'http' && provider?.actualStatus === 'designed' && provider.machineEndpoints === 0) {
        findings.push(
          warning(
            `specs/${edge.to}: '${name}' le llama por HTTP, pero su capa api no expone ningún endpoint con audience 'services' ni 'both'.`
          )
        );
      }
    }

    for (const before of entry.after ?? []) {
      if (!(before in declared)) {
        findings.push(error(`services.${name}.after: '${before}' no está declarado en services.`));
      } else if (before === name) {
        findings.push(error(`services.${name}.after: un servicio no va después de sí mismo.`));
      }
    }
    if (entry.external && (entry.consumes || entry.invokes)) {
      findings.push(
        warning(
          `services.${name}: es external y declara 'consumes' o 'invokes'. Lo que consume o invoca un sistema ajeno no es asunto de este mapa.`
        )
      );
    }
  }

  // --- Olas de construcción -------------------------------------------------
  const { waves, cycle } = computeWaves(declared);
  if (cycle.length > 0) {
    const breakable = cycle
      .flatMap((name) => [
        ...(declared[name].consumes ?? [])
          .filter((edge) => edge.blocking !== false && cycle.includes(edge.from))
          .map((edge) => `${name} ← ${edge.from}`),
        ...(declared[name].invokes ?? [])
          .filter((edge) => edge.blocking !== false && cycle.includes(edge.to))
          .map((edge) => `${name} → ${edge.to}`)
      ])
      .sort();
    findings.push(
      error(
        `Ciclo bloqueante entre ${cycle.join(', ')}: ninguno puede diseñarse primero.\n` +
          `  Aristas implicadas: ${breakable.join(', ')}.\n` +
          '  Decide con el diseñador qué lado se diseña en modo degradado y márcala blocking: false.\n' +
          '  Un ciclo aparente casi siempre es una arista dibujada al revés.'
      )
    );
  }

  const waveOf = new Map();
  waves.forEach((wave, level) => {
    for (const name of wave) waveOf.set(name, level + 1);
  });

  // --- Estado real y deriva contra los diseños ------------------------------
  const services = names.map((name) => {
    const entry = declared[name];
    const spec = specs.get(name);
    const declaredStatus = entry.status ?? 'planned';

    if (entry.external && fs.existsSync(path.join(cwd, 'specs', name, MANIFEST_FILE))) {
      findings.push(
        warning(`services.${name}: está marcado external pero existe specs/${name}. Si lo diseñamos aquí, quita external.`)
      );
    }

    if (!entry.external) {
      const expected = EXPECTED_DECLARED[spec.actualStatus];
      if (declaredStatus !== expected) {
        findings.push(
          warning(
            `services.${name}: el mapa declara status '${declaredStatus}' y el diseño está '${STATUS_LABEL[spec.actualStatus]}'. ` +
              `Actualiza status a '${expected}'.`
          )
        );
      }
      if (spec.actualStatus === 'broken') {
        findings.push(error(`specs/${name}: no carga — ${spec.errors.join('; ')}`));
      }
      findings.push(...checkSpecDrift(name, entry, declared, spec));
    }

    return {
      name,
      summary: entry.summary,
      responsibility: entry.responsibility,
      notResponsible: entry.notResponsible ?? [],
      owns: entry.owns ?? [],
      publishes: entry.publishes ?? [],
      external: entry.external === true,
      derivedFrom: entry.derivedFrom ?? null,
      declaredStatus,
      status: spec.actualStatus,
      statusLabel: STATUS_LABEL[spec.actualStatus],
      contract: spec.contract ?? null,
      wave: waveOf.get(name) ?? null,
      consumes: (entry.consumes ?? []).map((edge) => ({
        from: edge.from,
        kind: edge.kind,
        what: edge.what,
        events: edge.events ?? null,
        strategy: edge.strategy ?? null,
        blocking: edge.blocking !== false,
        why: edge.why
      })),
      invokes: (entry.invokes ?? []).map((edge) => ({
        to: edge.to,
        kind: edge.kind,
        what: edge.what,
        events: edge.events ?? null,
        blocking: edge.blocking !== false,
        why: edge.why
      })),
      consumedBy: names
        .filter((other) => (declared[other].consumes ?? []).some((edge) => edge.from === name))
        .sort(),
      // Quién nos pide trabajo: es lo que convierte nuestras puertas de entrada
      // en contrato con alguien concreto, y alimenta el brief del servicio.
      invokedBy: names
        .filter((other) => (declared[other].invokes ?? []).some((edge) => edge.to === name))
        .sort()
    };
  });

  const byName = new Map(services.map((service) => [service.name, service]));

  // ¿Puede empezarse a diseñar? Cada proveedor bloqueante debe tener su
  // INTEGRATION.md al día; es literalmente lo que pide el paso 2 de /keel-design.
  for (const service of services) {
    if (service.external || service.status !== 'absent') continue;
    // Set: dos aristas al mismo proveedor (una http y una de eventos) esperan un
    // único contrato, y listarlo dos veces solo hace ruido.
    const missing = new Set(
      [
        ...service.consumes.filter((edge) => edge.blocking).map((edge) => edge.from),
        ...service.invokes.filter((edge) => edge.blocking).map((edge) => edge.to)
      ]
        .map((provider) => byName.get(provider))
        .filter((provider) => provider && !provider.external && provider.contract !== 'fresh')
        .map((provider) => `${provider.name} (${provider.contract === 'stale' ? 'contrato atrasado' : 'sin contrato'})`)
    );
    if (missing.size > 0) {
      service.blockedBy = [...missing].sort();
    }
  }

  // Diseños que existen y el mapa no conoce: o falta una entrada, o alguien
  // diseñó algo que nadie planificó.
  for (const slug of designSlugs(cwd)) {
    if (!(slug in declared)) {
      findings.push(warning(`specs/${slug} no está en el mapa del sistema. Añádelo a services o retíralo del workspace.`));
    }
  }

  return {
    exists,
    system: { name: map.system.name, description: map.system.description, tdr: map.system.tdr ?? null },
    services,
    waves: waves.map((wave, level) => ({ level: level + 1, services: wave })),
    cycle,
    edges: flattenEdges(declared),
    findings
  };
}

/**
 * Deriva entre una entrada del mapa y el diseño real del servicio.
 *
 * Asimetría deliberada: lo que el mapa planificó y el diseño aún no implementa
 * solo es deriva cuando el diseño está **cerrado** —mientras se diseña, faltar
 * es lo normal y reportarlo sería ruido en cada ejecución—, mientras que una
 * dependencia que el diseño declara y el mapa no conoce es deriva **siempre**:
 * es integración que nadie planificó, y da igual en qué punto aparezca.
 */
function checkSpecDrift(name, entry, declared, spec) {
  if (!spec.present || spec.actualStatus === 'broken') return [];
  const findings = [];
  const closed = spec.actualStatus === 'designed';

  // Cada forma de depender se contrasta contra su propia arista: leer un dato de
  // alguien y pedirle trabajo son acoplamientos distintos, y confundirlos aquí
  // haría pasar por planificada una integración que el mapa nunca vio.
  const providers = [...new Set((entry.consumes ?? []).map((edge) => edge.from))].sort();
  const invoked = [...new Set((entry.invokes ?? []).map((edge) => edge.to))].sort();

  for (const dep of spec.readProviders) {
    if (!providers.includes(dep)) {
      findings.push(
        warning(
          `specs/${name}: lee datos de '${dep}' y el mapa no lo conoce. Añade la arista a services.${name}.consumes con su porqué, o quita la dependencia.`
        )
      );
    }
  }

  for (const dep of spec.activatedProviders) {
    if (!invoked.includes(dep)) {
      findings.push(
        warning(
          `specs/${name}: le pide trabajo a '${dep}' y el mapa no lo conoce. Añade la arista a services.${name}.invokes con su porqué, o quita la activación.`
        )
      );
    }
  }

  if (closed) {
    for (const provider of providers) {
      // Una arista de lectura la justifica un `need` o una compensación: el
      // evento de fallo de un proveedor al que se le encarga trabajo se lee sin
      // que exista ningún dato suyo que replicar ni consultar.
      if (!spec.readProviders.includes(provider) && !spec.compensatedProviders.includes(provider)) {
        findings.push(
          warning(
            `specs/${name}: el mapa planifica consumir '${provider}' y su capa dependencies no declara ningún need ni compensación suya. Resuélvelo con /keel-consume.`
          )
        );
      }
    }
    for (const provider of invoked) {
      if (!spec.activatedProviders.includes(provider)) {
        findings.push(
          warning(
            `specs/${name}: el mapa planifica pedirle trabajo a '${provider}' y su capa dependencies no declara ninguna activación suya. Resuélvelo con /keel-consume.`
          )
        );
      }
    }
  }

  // Suscripciones reales contra el mapa, y contra lo que el proveedor publica
  // de verdad en su propio diseño. Esta última es la única comprobación del
  // método que cruza dos specs.
  for (const sub of spec.subscriptions) {
    if (!sub.source) continue;
    // Una suscripción `request` no es una dependencia nuestra sino una puerta de
    // entrada: la verifica el mapa desde el lado de quien nos la pide.
    if (sub.nature === 'request') continue;
    const edge = (entry.consumes ?? []).find((item) => item.from === sub.source && item.kind === 'events');
    if (!edge) {
      findings.push(
        warning(
          `specs/${name}: se suscribe a '${sub.name}' de '${sub.source}' y el mapa no declara esa arista de eventos.`
        )
      );
      continue;
    }
    if (edge.events && !edge.events.includes(sub.name)) {
      findings.push(
        warning(`specs/${name}: se suscribe a '${sub.name}' y el mapa solo declara ${edge.events.join(', ')} desde '${sub.source}'.`)
      );
    }
  }

  return findings;
}

const error = (message) => ({ level: 'error', message });
const warning = (message) => ({ level: 'warning', message });

/**
 * Tabla del plan para consola: olas, estado real y aristas. Texto plano sin
 * color (el color lo pone el comando) y sin marcas de tiempo.
 */
export function renderPlanTable(plan) {
  const lines = [];
  const rows = [];

  for (const wave of plan.waves) {
    for (const name of wave.services) {
      const service = plan.services.find((entry) => entry.name === name);
      rows.push(row(wave.level, service));
    }
  }
  for (const service of plan.services) {
    if (service.wave === null && !service.external) rows.push(row('—', service));
  }

  const headers = ['Ola', 'Servicio', 'Estado', 'Lee de', 'Le pide a', 'Publica'];
  lines.push(table(headers, rows));

  const externals = plan.services.filter((service) => service.external);
  if (externals.length > 0) {
    lines.push('');
    lines.push('Externos (contrato en contracts/<servicio>/INTEGRATION.md, no se diseñan aquí):');
    for (const service of externals) lines.push(`  ${service.name} — ${service.summary}`);
  }

  const blocked = plan.services.filter((service) => service.blockedBy);
  if (blocked.length > 0) {
    lines.push('');
    lines.push('Aún no se pueden diseñar (falta el contrato de su proveedor):');
    for (const service of blocked) lines.push(`  ${service.name} ← ${service.blockedBy.join(', ')}`);
  }

  return lines.join('\n');
}

function row(wave, service) {
  const peers = (edges, peer) =>
    edges.length === 0
      ? '—'
      : edges.map((edge) => `${edge[peer]} (${edge.kind}${edge.blocking ? '' : ', no bloqueante'})`).join(', ');
  return [
    String(wave),
    service.name,
    service.statusLabel,
    peers(service.consumes, 'from'),
    peers(service.invokes, 'to'),
    service.publishes.length === 0 ? '—' : service.publishes.join(', ')
  ];
}

/** Tabla de ancho fijo por columna: legible en consola y determinista. */
function table(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((entry) => entry[column].length), 0)
  );
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd();
  return [line(headers), line(widths.map((width) => '─'.repeat(width))), ...rows.map(line)].join('\n');
}
