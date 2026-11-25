import { aggregateIndex } from './gen/data-lifecycle.js';

// Los diagramas del diseño, derivados de las capas y nunca redactados: un diagrama que escribe un agente puede
// contradecir al YAML, y uno derivado no. Son texto Mermaid porque GitHub y GitLab lo pintan dentro de DESIGN.md sin
// nada más y el panel ya carga sus librerías por versión fija. Deterministas: el orden es el del YAML.
//
// Es un diagrama de DOMINIO y no un entidad-relación a propósito: tablas, FK y tablas de elementos las decide el
// generador según el modelo de persistencia, y para un diseño documental un ER sería falso. Lo que dibuja es lo que
// decide el diseñador: fronteras de agregado, quién cruza una, cardinalidades y las máquinas de estados.

const SCALARS = new Set(['string', 'text', 'int', 'long', 'decimal', 'boolean', 'date', 'timestamp', 'uuid', 'json', 'binary', 'duration']);

function entriesOf(value) {
  return value && typeof value === 'object' ? Object.entries(value) : [];
}

/** Las comillas rompen una etiqueta de Mermaid y no hay forma de escaparlas que pinten todas las versiones. */
function label(text) {
  return String(text).replace(/"/g, "'").replace(/\s+/g, ' ').trim();
}

function fieldFlags(name, field, naturalKey) {
  const flags = [];
  if (field.id) flags.push('id');
  if (naturalKey.includes(name)) flags.push('clave natural');
  if (field.unique) flags.push('único');
  if (field.required && !field.id) flags.push('requerido');
  if (field.personal) flags.push('personal');
  if (field.sensitive) flags.push('sensible');
  if (field.generated) flags.push('generado');
  if (field.computed !== undefined) flags.push('calculado');
  if (field.default !== undefined) flags.push(`default ${field.default}`);
  return flags;
}

function memberLine(name, field, naturalKey) {
  const type = `${field.type ?? '?'}${field.list ? '[]' : ''}`;
  const flags = fieldFlags(name, field, naturalKey);
  return label(`${name}: ${type}${flags.length > 0 ? ` · ${flags.join(', ')}` : ''}`);
}

function multiplicity(cardinality, required) {
  const one = required ? '1' : '0..1';
  switch (cardinality) {
    case 'one-to-many':
      return ['1', '*'];
    case 'many-to-one':
      return ['*', one];
    case 'many-to-many':
      return ['*', '*'];
    default:
      return ['1', one];
  }
}

function checkText(check) {
  const parts = entriesOf(check)
    .filter(([key]) => key !== 'description' && key !== 'error')
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key} ${value.join(', ')}`;
      if (value && typeof value === 'object') return `${key} ${entriesOf(value).map(([k, v]) => `${k}=${v}`).join(' ')}`;
      return `${key} ${value}`;
    });
  return parts.join(' · ');
}

function typeClass(name, type) {
  if (Array.isArray(type?.values)) {
    return [`class ${name} {`, '  <<enumeration>>', ...type.values.map((value) => `  ${label(value)}`), '}'];
  }
  if (type?.fields) {
    return [
      `class ${name} {`,
      '  <<value object>>',
      ...entriesOf(type.fields).map(([field, spec]) => `  ${memberLine(field, spec ?? {}, [])}`),
      '}'
    ];
  }
  return [];
}

/**
 * El diagrama de clases del dominio: un `namespace` por agregado declarado, la raíz marcada, composición dentro del
 * agregado, flecha discontinua entre agregados (se referencian por id) y los value objects y enums que usan las
 * entidades. Devuelve `{ diagram, notes }`: `notes` son los hechos del diseño que el diagrama hace visibles y conviene
 * decir en prosa (no declara agregados, una entidad sin persistir).
 */
export function domainDiagram(layers) {
  const domain = layers.domain ?? {};
  const entities = entriesOf(domain.entities);
  const declaresAggregates = entriesOf(domain.aggregates).length > 0;
  const index = aggregateIndex(layers);
  const persistence = layers.persistence;
  const persisted = (name) => persistence?.entities?.[name]?.persisted !== false;
  const notes = [];

  const classOf = (name, entity) => {
    const at = index.get(name);
    const stereotypes = [];
    if (at?.isRoot && domain.aggregates?.[at.aggregate]) stereotypes.push('raíz');
    if (persistence?.entities?.[name]?.deletion === 'logical') stereotypes.push('borrado lógico');
    if (persistence && !persisted(name)) stereotypes.push('no persistida');
    const naturalKey = persistence?.entities?.[name]?.naturalKey ?? [];
    return [
      `class ${name} {`,
      ...(stereotypes.length > 0 ? [`  <<${stereotypes.join(' · ')}>>`] : []),
      ...entriesOf(entity.fields).map(([field, spec]) => `  ${memberLine(field, spec ?? {}, naturalKey)}`),
      '}'
    ];
  };

  const lines = ['classDiagram', '  direction LR'];
  const indent = (block, prefix) => block.map((line) => `${prefix}${line}`);

  if (declaresAggregates) {
    const placed = new Set();
    for (const [aggregateName, aggregate] of entriesOf(domain.aggregates)) {
      const root = aggregate?.root ?? aggregateName;
      const members = [root, ...(aggregate?.entities ?? []).filter((member) => member !== root)];
      const body = members
        .filter((member) => domain.entities?.[member])
        .flatMap((member) => {
          placed.add(member);
          return classOf(member, domain.entities[member]);
        });
      lines.push(`  namespace ${aggregateName}Aggregate {`, ...indent(body, '    '), '  }');
    }
    const loose = entities.filter(([name]) => !placed.has(name));
    for (const [name, entity] of loose) lines.push(...indent(classOf(name, entity), '  '));
    if (loose.length > 0) {
      notes.push(`Fuera de todo agregado: ${loose.map(([name]) => name).join(', ')}.`);
    }
  } else {
    for (const [name, entity] of entities) lines.push(...indent(classOf(name, entity), '  '));
    notes.push('El dominio no declara agregados: cada entidad es su propia frontera de consistencia.');
  }

  const usedTypes = new Set(
    entities.flatMap(([, entity]) => entriesOf(entity.fields).map(([, field]) => field?.type)).filter((type) => type && !SCALARS.has(type))
  );
  for (const [name, type] of entriesOf(domain.types)) {
    if (usedTypes.has(name)) lines.push(...indent(typeClass(name, type), '  '));
  }

  for (const [name, entity] of entities) {
    for (const [relation, spec] of entriesOf(entity.relations)) {
      if (!spec?.entity) continue;
      const [from, to] = multiplicity(spec.cardinality, spec.required === true);
      const source = index.get(name);
      const target = index.get(spec.entity);
      const sameAggregate = declaresAggregates && source && target && source.aggregate === target.aggregate;
      // Composición solo del dueño hacia su hija interna; la hija que apunta a su raíz es una flecha normal.
      const owns = spec.cardinality === 'one-to-many' || spec.cardinality === 'one-to-one';
      let arrow = '-->';
      if (declaresAggregates && !sameAggregate) arrow = '..>';
      else if (sameAggregate && owns && !target.isRoot) arrow = '*--';
      lines.push(`  ${name} "${from}" ${arrow} "${to}" ${spec.entity} : ${relation}`);
    }
  }

  for (const [name, entity] of entities) {
    const checks = (entity.checks ?? []).map(checkText).filter(Boolean);
    if (checks.length > 0) lines.push(`  note for ${name} "${label(`checks: ${checks.join(' | ')}`)}"`);
  }

  if (persistence) {
    const unpersisted = entities.map(([name]) => name).filter((name) => !persisted(name));
    if (unpersisted.length > 0) notes.push(`Sin persistir (no guardan estado propio): ${unpersisted.join(', ')}.`);
  }

  return { diagram: lines.join('\n'), notes };
}

function deadlineText(deadline) {
  const after = deadline.after?.seconds !== undefined
    ? `${deadline.after.seconds} s`
    : `${deadline.after?.parameter ?? '?'} ${deadline.after?.unit ?? ''}`.trim();
  return `plazo ${after} desde ${deadline.since}`;
}

/** Los estados alcanzables desde `initial` siguiendo las transiciones declaradas. */
function reachable(initial, transitions) {
  const seen = new Set([initial]);
  const pending = [initial];
  while (pending.length > 0) {
    for (const next of transitions[pending.pop()] ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return seen;
}

/**
 * Un `stateDiagram-v2` por entidad con `lifecycle`. Cada arista lleva las operaciones que la ejecutan (`transitions`
 * de use-cases) y el plazo que la dispara (`deadlines`, DSL 2.26). Lo que el diseñador viene a buscar va en `findings`
 * y en una nota del diagrama: aristas que no ejecuta ninguna operación, estados inalcanzables desde el inicial y
 * valores del enum que la máquina no menciona.
 */
export function lifecycleDiagrams(layers) {
  const domain = layers.domain ?? {};
  const operations = entriesOf(layers['use-cases']?.operations);
  return entriesOf(domain.entities)
    .filter(([, entity]) => entity?.lifecycle?.transitions)
    .map(([name, entity]) => {
      const { field, transitions, deadlines = {} } = entity.lifecycle;
      const fieldSpec = entity.fields?.[field] ?? {};
      const enumValues = fieldSpec.type === 'enum' ? fieldSpec.values ?? [] : domain.types?.[fieldSpec.type]?.values ?? [];
      const initial = fieldSpec.default;
      const findings = [];

      const byEdge = new Map();
      for (const [operation, op] of operations) {
        for (const transition of op?.transitions ?? []) {
          if (transition?.entity !== name) continue;
          for (const from of transition.from ?? []) {
            const key = `${from}->${transition.to}`;
            byEdge.set(key, [...(byEdge.get(key) ?? []), operation]);
          }
        }
      }

      const lines = ['stateDiagram-v2'];
      if (initial !== undefined) lines.push(`  [*] --> ${initial}`);
      for (const [from, targets] of entriesOf(transitions)) {
        if (!Array.isArray(targets) || targets.length === 0) {
          lines.push(`  ${from} --> [*]`);
          continue;
        }
        for (const to of targets) {
          const parts = [...(byEdge.get(`${from}->${to}`) ?? [])];
          const deadline = deadlines[from]?.to === to ? deadlines[from] : null;
          if (deadline) parts.push(deadlineText(deadline));
          if (parts.length === 0) {
            parts.push('sin operación');
            findings.push(`${from} → ${to}: ninguna operación la ejecuta (CHK-DOMAIN-TRANSITION-UNEXECUTED).`);
          }
          lines.push(`  ${from} --> ${to} : ${label(parts.join(', '))}`);
        }
      }

      const states = new Set([...Object.keys(transitions), ...Object.values(transitions).flat()]);
      if (initial !== undefined) {
        const live = reachable(initial, transitions);
        for (const state of states) {
          if (!live.has(state)) {
            findings.push(`${state}: ninguna cadena de transiciones llega a él desde el estado inicial ${initial}.`);
            lines.push(`  note right of ${state} : inalcanzable`);
          }
        }
      } else {
        findings.push(`${field} no declara default: el estado en que nace ${name} lo fija la operación que la crea, y el diagrama no lo dibuja.`);
      }
      for (const value of enumValues) {
        if (value in transitions) continue;
        if (states.has(value)) {
          findings.push(`${value}: no declara sus transiciones; si es terminal, va con [] (CHK-DOMAIN-STATE-NO-TRANSITIONS).`);
        } else {
          findings.push(`${value}: valor del enum que la máquina de estados no menciona (CHK-DOMAIN-STATE-NO-TRANSITIONS).`);
          lines.push(`  ${value}`, `  note right of ${value} : fuera del ciclo`);
        }
      }

      return { entity: name, field, diagram: lines.join('\n'), findings };
    });
}

/** Los diagramas como datos: la forma de `domain.diagrams` del panel `overview.html` (`keel describe --diagram --json`). */
export function diagramData(layers) {
  const { diagram, notes } = domainDiagram(layers);
  return { domain: diagram, notes, lifecycles: lifecycleDiagrams(layers) };
}

/** Todo junto, como markdown con bloques ```mermaid: lo que imprime `keel describe --diagram` y lo que pega DESIGN.md. */
export function renderDiagramMarkdown(layers) {
  const domain = domainDiagram(layers);
  const out = ['## Dominio', '', '```mermaid', domain.diagram, '```'];
  if (domain.notes.length > 0) out.push('', ...domain.notes.map((note) => `- ${note}`));
  for (const lifecycle of lifecycleDiagrams(layers)) {
    out.push('', `## Ciclo de vida de ${lifecycle.entity} (${lifecycle.field})`, '', '```mermaid', lifecycle.diagram, '```');
    if (lifecycle.findings.length > 0) out.push('', ...lifecycle.findings.map((finding) => `- ${finding}`));
  }
  return `${out.join('\n')}\n`;
}
