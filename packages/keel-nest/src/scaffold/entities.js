// Entidades de dominio PURAS (sin TypeORM ni Nest), con la misma forma que las de keel-spring:
// raíces de agregado en domain/aggregate, entidades internas en domain/entity. Modelo encapsulado:
//   · el estado entra por UN constructor de rehidratación, que lo usa el adaptador de persistencia
//     (el estado ya es válido y no se revalida); recibe un objeto `<Entidad>State` y no una lista de
//     argumentos posicionales, que en TypeScript se desordenan sin que nada lo note;
//   · getters de solo lectura (las colecciones salen como copia), ningún setter: la mutación es por
//     métodos de negocio que escribe el agente;
//   · la guarda privada del lifecycle (`transitionTo`) con las transiciones del diseño;
//   · el buffer de eventos de dominio en las raíces emisoras;
//   · TODOs guiados del factory, de los métodos semánticos y de los invariantes.
// La persistencia vive aparte (incremento 6): el dominio no sabe cómo se guarda.

import { DIRS, classPath, declType, entityDir, fieldImports, tsModule, tsdoc } from './render.js';
import { INVALID_TRANSITION_TS } from './exceptions.js';
import { DOMAIN_EVENT_TS } from './events.js';

export function generate(model) {
  return (model.entities ?? []).map((entity) => renderEntity(model, entity));
}

/**
 * Los miembros del estado de la entidad: campos del diseño + relaciones (internas como entidad de
 * dominio, externas como el id de la otra raíz cuando hay persistencia). El mismo reparto que
 * `domainMembers` de keel-spring, con el tipo que se declara en TypeScript.
 */
export function domainMembers(model, entity) {
  const members = entity.fields.map((field) => ({ kind: 'field', field, name: field.name, type: declType(field) }));
  for (const relation of entity.relations ?? []) {
    // La referencia de vuelta a la raíz no es un miembro del dominio: dentro del agregado el
    // contexto ya es la raíz, y modelarla obligaría a recorrer el ciclo hija→padre→hija.
    if (relation.backReference) continue;
    const toMany = relation.cardinality === 'one-to-many' || relation.cardinality === 'many-to-many';
    if (!relation.internal && model.layersPresent?.persistence) {
      members.push({ kind: 'externalRef', relation, name: `${relation.name}Id`, type: relation.required ? 'string' : 'string | null' });
    } else if (toMany) {
      members.push({ kind: 'relationMany', relation, name: relation.name, type: `readonly ${relation.entity}[]` });
    } else {
      members.push({ kind: 'relationOne', relation, name: relation.name, type: relation.required ? relation.entity : `${relation.entity} | null` });
    }
  }
  return members;
}

const isCollection = (member) => member.kind === 'relationMany' || Boolean(member.field?.list);

function renderEntity(model, entity) {
  const file = classPath(entityDir(entity), entity.name);
  const imports = [];
  const members = domainMembers(model, entity);
  for (const member of members) {
    if (member.kind === 'field') imports.push(...fieldImports(model, member.field));
    else if (member.kind !== 'externalRef') {
      const related = model.entities.find((e) => e.name === member.relation.entity);
      imports.push({ symbol: member.relation.entity, from: classPath(related ? entityDir(related) : DIRS.entities, member.relation.entity) });
    }
  }

  // Concurrencia optimista: la raíz porta la versión que gestiona la persistencia. Viaja por el
  // estado para que la ida y vuelta dominio↔persistencia no la pierda; nadie la muta a mano.
  const lockVersion = entity.usesOptimisticLocking && !entity.declaresLockVersion;
  const stateMembers = lockVersion
    ? [...members, { kind: 'lockVersion', name: 'lockVersion', type: 'number | null', doc: 'Versión de concurrencia optimista; la gestiona la persistencia. Null hasta la primera escritura.' }]
    : members;

  // Los TODO de invariantes van ANTES del TSDoc: entre un comentario de documentación y su clase
  // no puede haber nada, o el editor deja de asociarlos.
  const header = [];
  for (const invariant of entity.invariants ?? []) {
    header.push(`// TODO invariante (guarda en el factory y en cada método mutador): ${invariant}`);
  }
  if (entity.description) header.push(tsdoc(entity.description).trimEnd());

  const parts = [];
  const emitted = (model.events ?? []).filter((event) => event.aggregates.includes(entity.name));
  if (emitted.length > 0) {
    imports.push({ symbol: 'DomainEvent', from: DOMAIN_EVENT_TS, type: true });
    for (const event of emitted) imports.push({ symbol: event.className, from: classPath(DIRS.events, event.className), type: true });
    parts.push(renderDomainEvents(emitted, entity.name));
  }

  if (entity.lifecycle) {
    imports.push({ symbol: 'InvalidStateTransitionException', from: INVALID_TRANSITION_TS });
    parts.push(renderTransitions(entity));
  }

  parts.push(stateMembers.map((member) => `  #${member.name}: ${member.type};`).join('\n'));

  // Formato de los value types escalares: el mensaje de entrada lo deja caer a propósito y la clase
  // <Tipo>Format es quien lo hace cumplir. Se nombran aquí, campo a campo, porque es aquí donde
  // tienen que llamarse.
  const formatGuards = entity.fields.filter((field) => field.inheritedPattern && field.typeName);
  const guardTodo = formatGuards.length
    ? [
        '',
        '  // TODO (agente): formato de los value types, tras normalizar, en el factory y en TODO',
        ...formatGuards.map(
          (field) =>
            `  //   método que asigne el campo: ${field.typeName}Format.validate(${field.list ? `cada elemento de ${field.name}` : field.name}); (${classPath(DIRS.valueObjects, `${field.typeName}Format`)})`
        )
      ].join('\n')
    : '';
  const initial = entity.fields.filter((field) => field.initializer);
  const initialTodo = initial.length
    ? `\n  // Valores iniciales del diseño: ${initial.map((field) => `${field.name} = ${field.initializer}`).join(', ')}.${initial.some((field) => field.initializer.includes('Uuids.v7()')) ? `\n  // Uuids.v7() vive en ${classPath(DIRS.identity, 'Uuids')}: los ids de una raíz nacen con la versión 7.` : ''}`
    : '';
  parts.push(`  // TODO (agente): factory \`static create(...)\` que aplique los invariantes, derive los campos
  // generated/computed y fije el estado inicial del lifecycle. La mutación va por métodos de
  // negocio, no por setters.${initialTodo}${guardTodo}`);

  const assigns = stateMembers.map((member) =>
    isCollection(member) ? `    this.#${member.name} = [...state.${member.name}];` : `    this.#${member.name} = state.${member.name};`
  );
  parts.push(`  /**
   * Rehidratación desde persistencia: el estado ya es válido y no se revalida. La creación de
   * negocio va por el factory. Las colecciones se copian: quien entrega el estado no puede
   * mutarlas después por la espalda del agregado.
   */
  constructor(state: ${entity.name}State) {
${assigns.join('\n')}
  }`);

  if (entity.lifecycle) parts.push(renderTransitionTo(entity));

  // Solo getters. Las colecciones salen como copia: el alta y la baja de hijas las gobiernan
  // métodos de negocio de la raíz.
  parts.push(
    stateMembers
      .map((member) => `  get ${member.name}(): ${member.type} {\n    return ${isCollection(member) ? `[...this.#${member.name}]` : `this.#${member.name}`};\n  }`)
      .join('\n\n')
  );

  const stateDoc = stateMembers.map((member) => {
    const description = member.field?.description ?? member.doc ?? (member.kind === 'externalRef' ? `Id de la raíz del agregado ${member.relation.entity} (otro agregado: solo el id).` : null);
    const computed = member.field?.computed ? `TODO computed: ${member.field.computed}` : null;
    return `${tsdoc([description, computed], '  ')}  readonly ${member.name}: ${member.type};`;
  });

  const body = `/** El estado completo de ${entity.name}, tal como lo rehidrata la persistencia. */
export interface ${entity.name}State {
${stateDoc.join('\n')}
}

${header.length > 0 ? `${header.join('\n')}\n` : ''}export class ${entity.name} {
${parts.join('\n\n')}
}`;
  return { path: file, content: tsModule(file, imports, body) };
}

// Acumulación de eventos en la raíz: el método de negocio que provoca el cambio hace raise(...); el
// adaptador de repositorio drena el buffer al persistir. El agregado no conoce el broker.
function renderDomainEvents(emitted, entityName) {
  const pending = emitted
    .map((event) => {
      const args = event.fields.map((f) => f.name).join(', ');
      // Solo las operaciones de ESTE agregado: un evento que emiten dos raíces se genera en las
      // dos, y citarle a cada una las operaciones de la otra manda el raise() al sitio equivocado.
      const origin = event.emittedBy
        .filter((e) => e.aggregate === entityName)
        .map((e) => e.operation)
        .join(', ');
      return `  // TODO (agente): emitir ${event.name} en el método de negocio de ${origin || 'la operación que lo declara'}:
  //   this.raise(${event.className}.of(${args}));`;
    })
    .join('\n');
  const types = emitted.map((event) => event.className).join(' | ');
  return `  // ─── Eventos de dominio ──────────────────────────────────────────────────────
  // Se acumulan aquí y salen por pullDomainEvents() al persistir; nadie más construye eventos de
  // este agregado.
  #domainEvents: DomainEvent[] = [];

${pending}

  protected raise(event: ${types}): void {
    this.#domainEvents.push(event);
  }

  /** Vacía el buffer y devuelve lo acumulado; lo llama el adaptador de repositorio. */
  pullDomainEvents(): readonly DomainEvent[] {
    const pending = this.#domainEvents;
    this.#domainEvents = [];
    return pending;
  }`;
}

function renderTransitions(entity) {
  const { enumType, transitions } = entity.lifecycle;
  const entries = transitions
    .map(({ from, to }) => `    [${enumType}.${from}, new Set<${enumType}>([${to.map((state) => `${enumType}.${state}`).join(', ')}])]`)
    .join(',\n');
  // El diseño dice qué operación ejecuta cada transición: nombrarla aquí ata el método semántico a
  // su handler. Sin ella el TODO queda sin destinatario y el estado acaba mutándose desde fuera.
  const executedBy = entity.lifecycle.executedBy ?? {};
  const todos = transitions
    .flatMap(({ from, to }) =>
      to.map((state) => {
        const ops = executedBy[`${from}|${state}`] ?? [];
        const origin = ops.length ? ` (lo ejecuta ${ops.join(', ')})` : '';
        return `  // TODO (agente): método semántico ${from} → ${state}${origin} que valide la regla del diseño y llame a this.transitionTo(${enumType}.${state}).`;
      })
    )
    .join('\n');
  return `  // Transiciones válidas del lifecycle del diseño; un estado sin destinos es terminal.
  static readonly #TRANSITIONS: ReadonlyMap<${enumType}, ReadonlySet<${enumType}>> = new Map([
${entries}
  ]);

${todos}`;
}

function renderTransitionTo(entity) {
  const { field, enumType } = entity.lifecycle;
  const fieldDef = entity.fields.find((f) => f.name === field);
  const nullable = fieldDef && !(fieldDef.required || fieldDef.isId || fieldDef.generated);
  const current = nullable
    ? `const current = this.#${field};
    const allowed = current == null ? undefined : ${entity.name}.#TRANSITIONS.get(current);`
    : `const current = this.#${field};
    const allowed = ${entity.name}.#TRANSITIONS.get(current);`;
  return `  // Guarda interna del lifecycle: la llaman los métodos semánticos, nunca un handler.
  private transitionTo(target: ${enumType}): void {
    ${current}
    if (!allowed?.has(target)) {
      throw new InvalidStateTransitionException(String(current), target);
    }
    this.#${field} = target;
  }`;
}
