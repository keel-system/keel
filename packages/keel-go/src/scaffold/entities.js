// Entidades de dominio PURAS (sin base de datos ni HTTP), con la misma forma que las de keel-spring, keel-nest y
// keel-dotnet, dichas en Go:
//   · un struct con los campos SIN exportar: desde fuera solo se lee, con un método por campo (`p.Status()`,
//     sin `Get`). La mutación es por métodos de negocio que escribe el agente;
//   · el estado entra por `Rehydrate<Entidad>(<Entidad>State)`, que usa el adaptador de persistencia: el estado
//     ya es válido y no se revalida. `<Entidad>State` es un struct con los campos exportados y con nombre, así
//     que no hay argumentos posicionales que se desordenen sin que nadie lo note;
//   · las colecciones se copian al entrar y al salir (`slices.Clone`): nadie las cambia por la espalda;
//   · la guarda privada del lifecycle (`transitionTo`) con las transiciones del diseño;
//   · el buffer de eventos de dominio en las raíces emisoras;
//   · TODOs guiados del constructor, de los métodos semánticos y de los invariantes, en un archivo HERMANO
//     (`<entidad>_behavior.go`, sin la cabecera de código generado): lo que escribe el agente va ahí, en el mismo
//     paquete, y el archivo de la entidad se puede regenerar sin pisarlo. Es el reparto del mensaje y su handler.
// Dos piezas (`transitionTo` y `raise`) solo las llama lo que escribe el agente; hasta entonces staticcheck las
// ve sin uso, y lo dicen con `//lint:ignore U1000` y su motivo (PLAN-KEEL-GO.md § 3.8). Ya usadas, staticcheck no
// marca la directiva (medido con la 2025.1 en el inc. 7c).
// La persistencia vive aparte (incremento 6): el dominio no sabe cómo se guarda.

import { LOCK_VERSION } from '@keel-system/keel-core/gen';
import { goExported } from '../lib/go-projection.js';
import { alignRows, commentLines, goString, keyedLiteral } from '../lib/go-source.js';
import { constantOf } from './enums.js';
import { declType, docComment, domainPath, fieldImports, goFileName, isOptional, layout, localName, packageFile } from './render.js';

const IMPORTS = ['slices', 'bytes', 'time', 'encoding/json/jsontext', 'internal/platform/wire'];

export function generate(model) {
  return (model.entities ?? []).flatMap((entity) => [renderEntity(model, entity), renderBehavior(model, entity)]);
}

/** El archivo del agente de una entidad: su constructor, sus métodos de negocio y sus invariantes. */
export function behaviorPath(model, entity) {
  return domainPath(model, `${entity.name}Behavior`);
}

/** ¿Lee alguna entidad un miembro opcional? Entonces su accesor devuelve una copia con `clonePtr`. */
export function entitiesClonePointers(model) {
  return (model.entities ?? []).some((entity) => (entity.usesOptimisticLocking && !entity.declaresLockVersion) || domainMembers(model, entity).some((member) => member.optional));
}

/**
 * ¿Es el `lockVersion` que el diseño DECLARA para portar el bloqueo optimista (`optimisticLocking: declared`)?
 * Lo lleva la persistencia igual que el que añade build: nil hasta la primera escritura, que es como el
 * adaptador sabe que el agregado es nuevo.
 */
export function isDeclaredLockVersion(entity, field) {
  return Boolean(entity.declaresLockVersion && entity.usesOptimisticLocking && field?.name === LOCK_VERSION.field);
}

/**
 * Los miembros del estado de la entidad: campos del diseño + relaciones (internas como entidad de dominio,
 * externas como el id de la otra raíz cuando hay persistencia). El mismo reparto que `domainMembers` de los
 * otros tres, con el tipo que se declara en Go.
 */
export function domainMembers(model, entity) {
  const members = entity.fields.map((field) =>
    isDeclaredLockVersion(entity, field)
      ? { kind: 'field', field, name: field.name, type: `*${field.goType}`, optional: true, declaredLock: true }
      : { kind: 'field', field, name: field.name, type: declType(field), optional: isOptional(field), list: field.list }
  );
  for (const relation of entity.relations ?? []) {
    // La referencia de vuelta a la raíz no es un miembro del dominio: dentro del agregado el contexto ya es la
    // raíz, y modelarla obligaría a recorrer el ciclo hija → padre → hija.
    if (relation.backReference) continue;
    const toMany = relation.cardinality === 'one-to-many' || relation.cardinality === 'many-to-many';
    if (!relation.internal && model.layersPresent?.persistence) {
      const target = model.entities.find((e) => e.name === relation.entity);
      const idField = target?.fields.find((f) => f.isId);
      const idType = idField?.goType ?? 'uuid.UUID';
      members.push({
        kind: 'externalRef',
        relation,
        name: `${relation.name}Id`,
        type: relation.required ? idType : `*${idType}`,
        optional: !relation.required,
        imports: idField?.goImports ?? ['github.com/google/uuid']
      });
    } else if (toMany) {
      members.push({ kind: 'relationMany', relation, name: relation.name, type: `[]*${relation.entity}`, list: true });
    } else {
      // Una entidad es un puntero: tiene identidad, no se copia. nil es «sin relación».
      members.push({ kind: 'relationOne', relation, name: relation.name, type: `*${relation.entity}` });
    }
  }
  return members;
}

function memberDoc(member) {
  if (member.field?.description) return member.field.description;
  if (member.declaredLock || member.kind === 'lockVersion') return 'versión de concurrencia optimista; la gestiona la persistencia. nil hasta la primera escritura.';
  if (member.kind === 'externalRef') return `id de la raíz del agregado ${member.relation.entity} (otro agregado: solo el id).`;
  if (member.kind === 'relationMany') return `las ${member.relation.entity} del agregado.`;
  if (member.kind === 'relationOne') return `la ${member.relation.entity} del agregado, o nil.`;
  return null;
}

function renderEntity(model, entity) {
  const { domain } = layout(model);
  const imports = [...IMPORTS, 'github.com/google/uuid'];
  const members = domainMembers(model, entity);
  for (const member of members) {
    if (member.field) imports.push(...fieldImports(member.field));
    if (member.imports) imports.push(...member.imports);
  }
  // Concurrencia optimista: la raíz porta la versión que gestiona la persistencia. Viaja por el estado para que
  // la ida y vuelta dominio ↔ persistencia no la pierda; nadie la cambia a mano.
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) {
    members.push({ kind: 'lockVersion', name: LOCK_VERSION.field, type: '*int64', optional: true });
  }
  const named = members.map((member) => ({ ...member, field: member.field, local: localName(member.name), method: goExported(member.name) }));
  const methods = new Set(named.map((member) => member.method));
  for (const reserved of ['PullEvents']) {
    if (methods.has(reserved)) throw new Error(`entidad ${entity.name}: el campo ${reserved} choca con un método generado en Go; renómbralo en el diseño`);
  }

  const name = entity.name;
  const receiver = name[0].toLowerCase();
  const emitted = (model.events ?? []).filter((event) => event.aggregates.includes(name));
  const struct = alignRows([
    ...named.map((member) => ({ indent: '\t', cells: [member.local, member.type] })),
    ...(emitted.length > 0 ? [{ indent: '\t', cells: ['domainEvents', '[]Event'] }] : [])
  ]);
  const state = alignRows(named.map((member) => ({ indent: '\t', cells: [member.method, member.type] })));
  const rehydrate = keyedLiteral(
    named.map((member) => [member.local, member.list ? `slices.Clone(state.${member.method})` : `state.${member.method}`]),
    '\t\t'
  );
  const accessors = named.map((member) => {
    const doc = docComment(member.method, memberDoc(member), `el campo ${member.name}`);
    let result = `${receiver}.${member.local}`;
    if (member.list) result = `slices.Clone(${result})`;
    else if (member.optional) result = `clonePtr(${result})`;
    return `${doc}func (${receiver} *${name}) ${member.method}() ${member.type} {\n\treturn ${result}\n}`;
  });

  const parts = [];
  parts.push(
    `${docComment(name, entity.description, `entidad ${name} del diseño`)}type ${name} struct {
${struct.join('\n')}
}`
  );
  parts.push(`${docComment(`${name}State`, `el estado completo de ${name}, tal como lo rehidrata la persistencia.`)}type ${name}State struct {
${state.join('\n')}
}`);
  parts.push(`// Rehydrate${name} reconstruye un ${name} desde la persistencia: el estado ya es válido y no se revalida. La
// creación de negocio va por su constructor. Las colecciones se copian: quien entrega el estado no puede
// cambiarlas después por la espalda del agregado.
func Rehydrate${name}(state ${name}State) *${name} {
	return &${name}{
${rehydrate.join('\n')}
	}
}`);
  parts.push(...accessors);
  if (entity.lifecycle) parts.push(...renderLifecycle(model, entity, receiver));
  if (emitted.length > 0) parts.push(...renderDomainEvents(emitted, entity, receiver));

  return { path: domainPath(model, name), content: packageFile(model, domain, { imports, body: `\n${parts.join('\n\n')}\n` }) };
}

/**
 * `<entidad>_behavior.go`: lo que build deja al agente sobre la entidad, como TODOs guiados. Nace solo con comentarios
 * —compila— y sin la cabecera de código generado: es del agente.
 */
function renderBehavior(model, entity) {
  const receiver = entity.name[0].toLowerCase();
  const parts = [
    `// Lo que escribe el agente sobre ${entity.name}: su constructor, sus métodos de negocio y las guardas de sus
// invariantes. El tipo, su estado y sus accesores están en ${goFileName(entity.name)}.go, que es de build.`
  ];
  const invariants = (entity.invariants ?? []).map((invariant) => `// TODO invariante (guarda en el constructor y en cada método mutador): ${invariant}`);
  if (invariants.length > 0) parts.push(invariants.join('\n'));
  parts.push(constructorTodo(model, entity, receiver));
  if (entity.lifecycle) parts.push(lifecycleTodos(model, entity, receiver));
  const emitted = (model.events ?? []).filter((event) => event.aggregates.includes(entity.name));
  if (emitted.length > 0) parts.push(eventTodos(emitted, entity, receiver));
  return { path: behaviorPath(model, entity), content: packageFile(model, layout(model).domain, { body: `\n${parts.join('\n\n')}\n`, generated: false }) };
}

function constructorTodo(model, entity, receiver) {
  const lines = [
    `TODO (agente): constructor \`New${entity.name}(...) (*${entity.name}, error)\` que aplique los invariantes, derive los`,
    'campos generated/computed y fije el estado inicial del lifecycle. La mutación va por métodos de negocio,',
    'no asignando campos desde fuera.'
  ];
  const initial = entity.fields.filter((field) => field.initializer);
  if (initial.length > 0) {
    lines.push(`Valores iniciales del diseño: ${initial.map((field) => `${localName(field.name)} = ${field.initializer}`).join(', ')}.`);
  }
  if (initial.some((field) => field.initializer.includes('NextLongID()'))) {
    lines.push('NextLongID() es de la persistencia: un id long lo crea la aplicación al nacer la raíz (incremento 6).');
  }
  const guarded = entity.fields.filter((field) => field.inheritedPattern && field.typeName && model.formatTypes?.some((t) => t.name === field.typeName));
  if (guarded.length > 0) {
    lines.push('Formato de los value types, tras normalizar, en el constructor y en TODO método que asigne el campo:');
    for (const field of guarded) {
      const value = field.list ? `cada elemento de ${receiver}.${localName(field.name)}` : `${receiver}.${localName(field.name)}`;
      lines.push(`  ${field.typeName}Format.Validate(${value})`);
    }
  }
  const computed = entity.fields.filter((field) => field.computed);
  for (const field of computed) lines.push(`${localName(field.name)} es computed: ${field.computed}`);
  return commentLines(lines.join('\n')).join('\n');
}

function renderLifecycle(model, entity, receiver) {
  const { field, enumType, transitions } = entity.lifecycle;
  const constant = (value) => constantOf(model, enumType, value);
  const variable = `${entity.name[0].toLowerCase()}${entity.name.slice(1)}Transitions`;
  const entries = keyedLiteral(
    transitions.map(({ from, to }) => [constant(from), `{${to.map(constant).join(', ')}}`]),
    '\t'
  );
  const fieldDef = entity.fields.find((f) => f.name === field);
  const nullable = fieldDef && isOptional(fieldDef);
  const member = `${receiver}.${localName(field)}`;
  const message = goString('Transición de estado no permitida: %s -> %s');
  const guard = nullable
    ? `	if ${member} == nil || !slices.Contains(${variable}[*${member}], target) {
		from := "null"
		if ${member} != nil {
			from = string(*${member})
		}
		return Errorf(ErrInvalidStateTransition, ${message}, from, target)
	}
	${member} = &target`
    : `	if !slices.Contains(${variable}[${member}], target) {
		return Errorf(ErrInvalidStateTransition, ${message}, ${member}, target)
	}
	${member} = target`;
  return [
    `// ${variable} son las transiciones del lifecycle de ${entity.name}; un estado sin destinos es terminal.
var ${variable} = map[${enumType}][]${enumType}{
${entries.join('\n')}
}`,
    `// transitionTo es la guarda del lifecycle: la llaman los métodos semánticos, nunca un caso de uso.
//
//lint:ignore U1000 la llaman los métodos semánticos que escribe el agente (los TODO de ${goFileName(entity.name)}_behavior.go).
func (${receiver} *${entity.name}) transitionTo(target ${enumType}) error {
${guard}
	return nil
}`
  ];
}

/** Un TODO por transición, con la operación que la ejecuta. */
function lifecycleTodos(model, entity, receiver) {
  const { enumType, transitions } = entity.lifecycle;
  const constant = (value) => constantOf(model, enumType, value);
  // El diseño dice qué operación ejecuta cada transición: nombrarla aquí ata el método semántico a su caso de
  // uso. Sin ella el TODO queda sin destinatario y el estado acaba cambiándose desde fuera.
  const executedBy = entity.lifecycle.executedBy ?? {};
  return transitions
    .flatMap(({ from, to }) =>
      to.map((target) => {
        const ops = executedBy[`${from}|${target}`] ?? [];
        const origin = ops.length ? ` (lo ejecuta ${ops.join(', ')})` : '';
        return `// TODO (agente): método semántico ${from} → ${target}${origin} que valide la regla del diseño y llame a ${receiver}.transitionTo(${constant(target)}).`;
      })
    )
    .join('\n');
}

/** Un TODO por evento que emite la raíz, con la llamada a `raise` ya escrita. */
function eventTodos(emitted, entity, receiver) {
  return emitted
    .map((event) => {
      const args = event.fields.map((f) => localName(f.name)).join(', ');
      // Solo las operaciones de ESTE agregado: un evento que emiten dos raíces se genera en las dos, y citarle a
      // cada una las operaciones de la otra manda el raise al sitio equivocado.
      const origin = event.emittedBy
        .filter((e) => e.aggregate === entity.name)
        .map((e) => e.operation)
        .join(', ');
      return `// TODO (agente): emitir ${event.name} en el método de negocio de ${origin || 'la operación que lo declara'}:\n//\n//\t${receiver}.raise(New${event.className}(${args}))`;
    })
    .join('\n\n');
}

// Acumulación de eventos en la raíz: el método de negocio que provoca el cambio hace raise(...); el adaptador de
// repositorio drena el buffer al persistir. El agregado no conoce el broker.
function renderDomainEvents(emitted, entity, receiver) {
  return [
    `// raise acumula un evento de dominio de ${entity.name}; sale por PullEvents al persistir.
//
//lint:ignore U1000 la llaman los métodos de negocio que escribe el agente (los TODO de ${goFileName(entity.name)}_behavior.go).
func (${receiver} *${entity.name}) raise(event Event) {
	${receiver}.domainEvents = append(${receiver}.domainEvents, event)
}`,
    `// PullEvents vacía el buffer de eventos y devuelve lo acumulado; lo llama el adaptador de repositorio.
func (${receiver} *${entity.name}) PullEvents() []Event {
	pending := ${receiver}.domainEvents
	${receiver}.domainEvents = nil
	return pending
}`
  ];
}
