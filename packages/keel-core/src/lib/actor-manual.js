import { accessRequirement } from './gen/access-plan.js';
import { FRAMEWORK_ERRORS, overrideFor } from './framework-errors.js';

// El manual de uso por actor: qué puede hacer cada uno de los que llaman al servicio, sobre qué y qué le puede salir
// mal. Lo derivan las capas y nunca un agente, por la misma razón que los diagramas: un manual redactado envejece en
// silencio y acaba contradiciendo al servidor. Determinista: el orden es el del YAML.
//
// Lo que ya organizan los demás derivados por capa (DESIGN.md, openapi, INTEGRATION.md) aquí se organiza por ACTOR, y
// ese cruce —roles por reglas de acceso por ciclo de vida— es también una revisión: destapa la operación que exige
// algo que nadie tiene y la transición que ningún actor puede provocar. Lo que el manual NO hace es repetir lo que
// `keel validate` ya avisa (un rol sin uso, un permiso huérfano, una arista sin operación): eso lo cita por su id.

const AUTO_PREFIX = /^(create|get|list|update|delete)[A-Z]/;

function entriesOf(value) {
  return value && typeof value === 'object' ? Object.entries(value) : [];
}

/** El texto de una celda de tabla markdown: sin barras verticales ni saltos de línea. */
function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** Las operaciones que se llaman por HTTP: endpoint explícito, o `auto` por convención CRUD, y nunca `internal`. */
function exposedOperations(layers) {
  const api = layers.api;
  if (!api) return new Map();
  const exposed = new Map();
  for (const [name, op] of entriesOf(layers['use-cases']?.operations)) {
    if (op?.internal === true) continue;
    const endpoint = api.endpoints?.[name];
    if (endpoint) {
      exposed.set(name, {
        route: `${endpoint.method ?? '?'} ${api.basePath ?? ''}${endpoint.path ?? ''}`,
        audience: endpoint.audience ?? api.defaultAudience ?? 'users'
      });
    } else if (api.auto === true && AUTO_PREFIX.test(name)) {
      exposed.set(name, { route: 'ruta CRUD automática', audience: api.defaultAudience ?? 'users' });
    }
  }
  return exposed;
}

/**
 * Los actores del diseño, en orden fijo: el anónimo, el usuario autenticado sin rol, cada rol y cada cliente máquina.
 * Solo los que el diseño hace existir; sin capa security hay uno solo, cualquier llamante.
 */
function actorsOf(layers, exposed) {
  const security = layers.security;
  if (!security) return [{ id: 'anyone', kind: 'anyone', title: 'Cualquier llamante', who: 'El servicio no declara capa security: no distingue quién llama.' }];
  const rules = [...exposed.keys()].map((name) => ruleOf(security, name));
  const actors = [];
  if (rules.some((rule) => ['public', 'optional'].includes(accessRequirement(rule).kind))) {
    actors.push({ id: 'anonymous', kind: 'anonymous', title: 'Anónimo', who: 'Llama sin identidad.' });
  }
  const protocol = security.authentication?.protocol;
  if (protocol !== 'none' && rules.some((rule) => accessRequirement(rule).kind === 'authenticated' && rule?.level !== 'service')) {
    actors.push({ id: 'authenticated', kind: 'authenticated', title: 'Usuario autenticado sin rol', who: 'Tiene identidad pero ningún rol del servicio.' });
  }
  for (const [role, spec] of entriesOf(security.roles)) {
    actors.push({ id: `role:${role}`, kind: 'role', name: role, title: `Rol ${role}`, who: spec?.description ?? '' });
  }
  for (const [client, spec] of entriesOf(security.serviceClients)) {
    actors.push({ id: `client:${client}`, kind: 'client', name: client, title: `Cliente máquina ${client}`, who: spec?.description ?? '' });
  }
  return actors;
}

function ruleOf(security, operation) {
  return security.access?.rules?.[operation] ?? security.access?.default ?? { level: 'required' };
}

/** Las autoridades que lleva un actor: las de la regla `anyOf` de `accessRequirement`. */
function authoritiesOf(security, actor) {
  if (actor.kind === 'role') return new Set([`ROLE_${actor.name}`, ...(security.roleGrants?.[actor.name] ?? [])]);
  if (actor.kind === 'client') return new Set((security.serviceClients?.[actor.name]?.scopes ?? []).map((scope) => `SCOPE_${scope}`));
  return new Set();
}

/** ¿Pasa este actor la regla de acceso de la operación? La misma lectura que hacen los cuatro generadores. */
function passes(security, actor, operation, audience) {
  if (actor.kind === 'anyone') return true;
  const rule = ruleOf(security, operation);
  const requirement = accessRequirement(rule);
  switch (requirement.kind) {
    case 'public':
    case 'optional':
      return true;
    case 'authenticated':
      if (actor.kind === 'anonymous') return false;
      if (rule.level === 'service') return actor.kind === 'client';
      return actor.kind !== 'client' || audience === 'both' || audience === 'services';
    default: {
      const held = authoritiesOf(security, actor);
      return requirement.authorities.some((authority) => held.has(authority));
    }
  }
}

/** La condición de `ownership` sobre una operación para un actor: sobre qué recursos actúa y qué pasa con los ajenos. */
function ownershipOf(security, actor, operation, op, errorsByCode) {
  if (!security || !['role', 'authenticated'].includes(actor.kind)) return null;
  for (const [entity, spec] of entriesOf(security.ownership)) {
    const writes = (spec?.operations ?? []).includes(operation);
    const reads = (spec?.reads ?? []).includes(operation);
    if (!writes && !reads) continue;
    if (actor.kind === 'role' && (spec.exemptRoles ?? []).includes(actor.name)) return null;
    // Un listado acotado no responde con error por lo ajeno: sencillamente no lo trae.
    if (reads && !writes && (op?.output?.list || op?.output?.paginated)) return `ve solo los ${entity} cuyo ${spec.owner} es su identidad`;
    const notFound = reads && !writes && spec.readMiss === 'not-found';
    const miss = notFound ? 'el ajeno responde como si no existiera (404)' : `el ajeno es ${errorsByCode.get(spec.error) ?? spec.error}`;
    return `solo los ${entity} cuyo ${spec.owner} es su identidad; ${miss}`;
  }
  return null;
}

function transitionsText(op) {
  return (op?.transitions ?? []).map((t) => `${t.entity}: ${(t.from ?? []).join(', ')} → ${t.to}`).join('; ');
}

/** Lo que dispara una operación que nadie llama por HTTP: un reloj, un evento, un plazo, otra operación. */
function systemTriggers(layers, exposed) {
  const triggers = new Map();
  const add = (operation, text) => triggers.set(operation, [...(triggers.get(operation) ?? []), text]);
  for (const [name, op] of entriesOf(layers['use-cases']?.operations)) {
    if (op?.schedule?.cron) add(name, `reloj \`${op.schedule.cron}\``);
    for (const target of op?.dispatches ?? []) add(target, `la despacha ${name}`);
  }
  for (const [subscription, spec] of entriesOf(layers.messaging?.subscriptions)) {
    if (spec?.triggers) add(spec.triggers, `el evento ${subscription}${spec.source ? ` de ${spec.source}` : ''}`);
  }
  // Un desenlace del cobro lo aplica una operación interna cuando la pasarela avisa (y el barrido de reconciliación
  // cuando no avisa): payments.outcomes.
  for (const [outcome, operation] of entriesOf(layers.payments?.outcomes)) add(operation, `el desenlace ${outcome} del cobro`);
  for (const [entity, spec] of entriesOf(layers.domain?.entities)) {
    for (const [state, deadline] of entriesOf(spec?.lifecycle?.deadlines)) {
      if (deadline?.by) add(deadline.by, `el plazo de ${entity} en ${state}`);
    }
  }
  return [...entriesOf(layers['use-cases']?.operations)]
    .filter(([name]) => !exposed.has(name))
    .map(([name, op]) => ({ name, op, triggers: triggers.get(name) ?? [] }));
}

/**
 * El manual como datos: `{ actors, system, operations, findings }`. Cada actor lleva sus operaciones con la condición
 * que le aplica; `findings` son los cruces que solo se ven por actor.
 */
export function actorManual(layers) {
  const security = layers.security;
  const operations = layers['use-cases']?.operations ?? {};
  const exposed = exposedOperations(layers);
  const actors = actorsOf(layers, exposed);
  const findings = [];

  const errorsOf = (op) => (op?.errors ?? []).map((error) => ({ code: error.code, http: error.http, when: error.when }));
  const errorText = (op) => new Map(errorsOf(op).map((error) => [error.code, `${error.http ?? '?'} ${error.code}`]));

  const scopingOf = (actor) => {
    const scoping = security?.authentication?.scoping;
    if (!scoping || !['role', 'authenticated', 'client'].includes(actor.kind)) return null;
    const exempt =
      (actor.kind === 'role' && (scoping.exemptRoles ?? []).includes(actor.name)) ||
      (actor.kind === 'client' && (scoping.exemptClients ?? []).includes(actor.name));
    if (exempt) return null;
    return `sus operaciones sobre ${scoping.over} se acotan a los valores del claim \`${scoping.claim}\` de su token; fuera de ellos, ${scoping.error}`;
  };

  const byActor = actors.map((actor) => ({
    ...actor,
    scope: scopingOf(actor),
    operations: [...exposed]
      .filter(([name, at]) => passes(security, actor, name, at.audience))
      .map(([name, at]) => ({
        name,
        route: at.route,
        description: operations[name]?.description ?? '',
        condition: ownershipOf(security, actor, name, operations[name], errorText(operations[name])),
        transitions: transitionsText(operations[name])
      }))
  }));

  const reachable = new Set(byActor.flatMap((actor) => actor.operations.map((op) => op.name)));
  for (const name of exposed.keys()) {
    if (!reachable.has(name)) {
      findings.push(`${name}: ninguno de los actores declarados pasa su regla de acceso — exige algo que ningún rol concede ni ningún cliente lleva.`);
    }
  }

  const system = systemTriggers(layers, exposed);
  for (const entry of system) {
    if (entry.triggers.length > 0) continue;
    const transitions = transitionsText(entry.op);
    findings.push(
      `${entry.name}: no se llama por HTTP y nada declarado la dispara (ni reloj, ni evento, ni plazo, ni desenlace, ni el dispatches de otra operación)` +
        (transitions ? `, y de ella depende ${transitions}.` : '.')
    );
  }

  // El error de una transición pedida desde un estado que no la admite lo pone el generador (framework-errors.md),
  // salvo que el diseño declare uno de esa familia: entonces ese, que los errores se agregan por servicio.
  const declared = entriesOf(operations).flatMap(([, op]) => errorsOf(op));
  const invalid = FRAMEWORK_ERRORS.invalidTransition;
  const transitionError = overrideFor(declared, invalid) ?? invalid;
  const withTransitionError = (op) => {
    const errors = errorsOf(op);
    if (!(op?.transitions ?? []).length || errors.some((error) => error.code === transitionError.code)) return errors;
    const from = [...new Set(op.transitions.flatMap((t) => t.from ?? []))].join(', ');
    return [...errors, { code: transitionError.code, http: transitionError.http, when: `La entidad no está en ${from}.`, framework: transitionError === invalid }];
  };

  const reference = entriesOf(operations).map(([name, op]) => ({
    name,
    kind: op?.kind ?? null,
    route: exposed.get(name)?.route ?? null,
    description: op?.description ?? '',
    preconditions: op?.preconditions ?? [],
    rules: op?.rules ?? [],
    transitions: transitionsText(op),
    errors: withTransitionError(op)
  }));

  return { actors: byActor, system, operations: reference, findings };
}

/** El manual en markdown, con el sello de versión que lee `derivatives.js` (`> specs/<servicio> vX.Y.Z.`). */
export function renderActorManual(layers, manifest) {
  const name = manifest?.service?.name ?? 'el servicio';
  const version = manifest?.service?.version ?? '0.0.0';
  const manual = actorManual(layers);
  const out = [
    `# Manual de uso por actor de ${name}`,
    '',
    `> specs/${name} v${version}. Generado con \`keel describe ${name} --manual\`: no se edita, se cambia el diseño y se vuelve a generar.`,
    '',
    '## Actores',
    '',
    '| Actor | Quién es | Operaciones |',
    '|---|---|---|',
    ...manual.actors.map((actor) => `| ${cell(actor.title)} | ${cell(actor.who) || '—'} | ${actor.operations.length} |`)
  ];

  for (const actor of manual.actors) {
    out.push('', `## ${actor.title}`, '');
    if (actor.who) out.push(actor.who, '');
    if (actor.scope) out.push(`**Alcance:** ${actor.scope}.`, '');
    if (actor.operations.length === 0) {
      out.push('No puede ejecutar ninguna operación del servicio.');
      continue;
    }
    out.push('| Operación | Ruta | Qué hace | Cambia de estado | Condición |', '|---|---|---|---|---|');
    for (const op of actor.operations) {
      out.push(`| [${op.name}](#${op.name.toLowerCase()}) | \`${cell(op.route)}\` | ${cell(op.description) || '—'} | ${cell(op.transitions) || '—'} | ${cell(op.condition) || '—'} |`);
    }
  }

  if (manual.system.length > 0) {
    out.push('', '## Lo que hace el servicio sin que nadie lo pida', '', '| Operación | La dispara | Cambia de estado |', '|---|---|---|');
    for (const entry of manual.system) {
      out.push(`| [${entry.name}](#${entry.name.toLowerCase()}) | ${cell(entry.triggers.join('; ')) || 'nada declarado'} | ${cell(transitionsText(entry.op)) || '—'} |`);
    }
  }

  out.push('', '## Operaciones');
  for (const op of manual.operations) {
    out.push('', `### ${op.name}`, '');
    if (op.description) out.push(op.description, '');
    out.push(`- Tipo: ${op.kind ?? '—'}${op.route ? ` · \`${op.route}\`` : ' · no se llama por HTTP'}`);
    if (op.transitions) out.push(`- Cambia de estado: ${op.transitions}`);
    for (const precondition of op.preconditions) out.push(`- Precondición: ${precondition}`);
    for (const rule of op.rules) out.push(`- Regla: ${rule}`);
    if (op.errors.length > 0) {
      out.push('', '| Error | HTTP | Cuándo |', '|---|---|---|');
      for (const error of op.errors) {
        const origin = error.framework ? ' (lo pone el generador)' : '';
        out.push(`| \`${error.code}\` | ${error.http ?? '—'} | ${cell(error.when) || '—'}${origin} |`);
      }
    }
  }

  if (manual.findings.length > 0) {
    out.push('', '## Hallazgos', '', ...manual.findings.map((finding) => `- ${finding}`));
  }
  return `${out.join('\n')}\n`;
}
