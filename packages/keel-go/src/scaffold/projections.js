// La copia local de un dato de otro servidor (`dependencies.needs` con `strategy: replicated`, tramo 13h). Las dos piezas de
// los otros tres generadores, en internal/application:
//
//   <E>Projector  la ESCRITURA: upsert idempotente que invoca el handler de la operación de proyección (la que dispara la
//                 suscripción del `fedBy`). Una reentrega tardía —un hecho anterior o igual al guardado— no pisa nada.
//   <E>Reader     la LECTURA: aplica `onMiss` cuando la copia todavía no tiene el dato (pedirlo al proveedor, fallar con el
//                 error del diseño o decir que no está para degradar), y lee por lote cuando la lee un listado.
//
// La copia se guarda en su PROPIA transacción: el Save del adaptador de una réplica abre una aunque el contexto traiga otra
// (repositories.js), el REQUIRES_NEW de keel-spring.
//
// Como en keel-dotnet, el proyector construye la copia con `Rehydrate<E>`: una réplica no lleva invariantes del dominio propio,
// las garantiza su dueño. Lo único del agente es la `hydrate` del lector con `onMiss: fetch` (el mapeo del resultado de la
// llamada a la copia), en un archivo sin la cabecera de código generado: `<e>_hydrate.go`.

import { LOCK_VERSION } from '@keel-system/keel-core/gen';
import { usesRelational } from '@keel-system/keel-core/gen/features';
import { occurredAtField } from '@keel-system/keel-core/gen/replica';
import { goExported, goUnexported } from '../lib/go-projection.js';
import { alignRows, commentLines, goString, keyedLiteral } from '../lib/go-source.js';
import { domainMembers } from './entities.js';
import { sentinelOf } from './errors.js';
import { callMethod, clientField, clientParam, clientPort } from './http-clients.js';
import { applicationPath, declType, fieldImports, goTypeName, layout, localName, packageFile } from './render.js';
import { naturalKeyBatchFinder, naturalKeyFinder, portName, repositoryParam } from './repositories.js';

/** Las réplicas que el diseño declara, ya resueltas por el modelo, con su entidad. Solo relacionales (la frontera lo dice). */
export function replicas(model) {
  if (!usesRelational(model)) return [];
  const found = [];
  for (const dependency of model.dependencies ?? []) {
    for (const need of dependency.needs ?? []) {
      if (need.strategy !== 'replicated' || !need.replica) continue;
      const entity = (model.entities ?? []).find((candidate) => candidate.name === need.replica.entityName);
      if (entity && entity.persisted) found.push({ dependency, need, entity });
    }
  }
  return found;
}

/** ¿Es esta entidad la copia local de una réplica? Entonces su Save abre su propia transacción. */
export function isReplica(model, entity) {
  return replicas(model).some((replica) => replica.entity === entity);
}

/** ¿Hay alguna copia? Entonces la unidad de trabajo necesita `apart`. */
export function usesReplicas(model) {
  return replicas(model).length > 0;
}

/** La réplica que alimenta la suscripción que dispara esta operación (`fedBy`). */
export function projectionsFedBy(model, operation) {
  const fed = (model.subscriptions ?? []).filter((sub) => sub.trigger === operation.name && sub.feedsReplica);
  return replicas(model).filter(({ entity }) => fed.some((sub) => sub.feedsReplica.entity === entity.name));
}

/** Las réplicas que lee esta operación (`usedBy`). */
export function replicasReadBy(model, operation) {
  return replicas(model).filter(({ need }) => (need.usedBy ?? []).includes(operation.name));
}

const projectorType = (need) => goTypeName(need.replica.projectorClass);
const readerType = (need) => goTypeName(need.replica.readerClass);

/** Lo que recibe el handler de una operación que proyecta o lee una copia, en el formato de handlerDependencies. */
export function projectionDependencies(model, operation) {
  const deps = [];
  for (const { dependency, need, entity } of projectionsFedBy(model, operation)) {
    deps.push({
      name: goUnexported(projectorType(need)),
      type: `*${projectorType(need)}`,
      doc: `${goUnexported(projectorType(need))} mantiene la copia local de ${entity.name}, propiedad de ${dependency.id}.`,
      arg: `New${projectorType(need)}(deps.${goExported(repositoryParam(entity))})`
    });
  }
  for (const { dependency, need, entity } of replicasReadBy(model, operation)) {
    const client = fetchClient(model, need);
    deps.push({
      name: goUnexported(readerType(need)),
      type: `*${readerType(need)}`,
      doc: `${goUnexported(readerType(need))} lee la copia local de ${entity.name}, propiedad de ${dependency.id}, con su política para cuando el dato falta.`,
      arg: `New${readerType(need)}(deps.${goExported(repositoryParam(entity))}${client ? `, deps.${clientField(client)}` : ''})`
    });
  }
  return deps;
}

/** El cliente con el que el lector pide lo que la copia no tiene (`onMiss: fetch`), o null. */
function fetchClient(model, need) {
  if (need.replica.onMiss.action !== 'fetch' || !need.fetch) return null;
  return (model.httpClients ?? []).find((candidate) => candidate.clientClass === need.fetch.clientClass) ?? null;
}

export function generate(model) {
  return replicas(model).flatMap(({ dependency, need, entity }) => [renderProjector(model, dependency, need, entity), ...renderReader(model, dependency, need, entity)]);
}

/** Lo que la proyección mantiene: todo menos el id técnico y la clave de correlación, que identifican la fila. */
function projectedFields(entity, replica) {
  return entity.fields.filter((field) => !field.isId && field.name !== replica.keyField && !field.generated);
}

/**
 * El estado de la copia, miembro a miembro: de la instantánea lo informado, y de la copia que ya había (o nuevo) lo que la
 * identifica. Null si el agregado tiene algo que la instantánea no informa y no se puede inventar: entonces la escritura es
 * del agente.
 */
function stateAssignments(model, entity, replica, existing) {
  const projected = new Set(projectedFields(entity, replica).map((field) => field.name));
  const pairs = [];
  for (const member of domainMembers(model, entity)) {
    const name = goExported(member.name);
    if (member.field?.isId) {
      if (existing) pairs.push([name, `existing.${name}()`]);
      else if (member.field.initializer) pairs.push([name, /^uuid./.test(member.field.initializer) ? member.field.initializer : `domain.${member.field.initializer}`]);
      else return null;
    } else if (member.declaredLock) {
      // El lockVersion declarado es la versión de la persistencia, nunca un dato de la instantánea.
      if (existing) pairs.push([name, `existing.${name}()`]);
    } else if (member.name === replica.keyField) {
      pairs.push([name, `${existing ? `existing.${name}()` : `snapshot.${name}`}`]);
    } else if (projected.has(member.name)) {
      pairs.push([name, `snapshot.${name}`]);
    } else {
      return null;
    }
  }
  if (existing && entity.usesOptimisticLocking && !entity.declaresLockVersion) pairs.push([goExported(LOCK_VERSION.field), `existing.${goExported(LOCK_VERSION.field)}()`]);
  return pairs;
}

/** El literal del estado de la copia. */
function stateLiteral(entity, pairs, indent) {
  return `domain.Rehydrate${entity.name}(domain.${entity.name}State{\n${keyedLiteral(pairs, `${indent}\t`).join('\n')}\n${indent}})`;
}

function renderProjector(model, dependency, need, entity) {
  const { application } = layout(model);
  const { replica } = need;
  const type = projectorType(need);
  const snapshot = `${entity.name}Snapshot`;
  const fields = projectedFields(entity, replica);
  const keyField = entity.fields.find((field) => field.name === replica.keyField);
  const snapshotFields = [keyField, ...fields].filter(Boolean);
  const ordering = occurredAtField(entity);
  const finder = naturalKeyFinder(model, entity);
  const created = stateAssignments(model, entity, replica, false);
  const updated = stateAssignments(model, entity, replica, true);
  const writable = Boolean(created && updated && finder);
  const orderable = ordering?.required && ordering.base === 'timestamp' && !ordering.list;
  const guard = orderable
    ? `
		// Reentrega o hecho viejo: uno anterior O IGUAL al guardado se confirma sin efecto. Con el mismo instante no hay orden
		// que decida, y aplicarlo dejaría ganar al último en llegar.
		if !snapshot.${goExported(ordering.name)}.After(existing.${goExported(ordering.name)}()) {
			return nil
		}`
    : `
		// TODO (agente): el payload no trae ningún instante del hecho, así que dos entregas desordenadas dejarían el valor
		// viejo. Si el proveedor expone uno, añádelo al payload en el diseño y compáralo aquí.`;
  const write = writable
    ? `	existing, found, err := p.repository.${finder.name}(ctx, snapshot.${goExported(replica.keyField)})
	if err != nil {
		return err
	}
	if found {${guard}
		_, err := p.repository.Save(ctx, ${stateLiteral(entity, updated, '\t\t')})
		return err
	}
	_, err = p.repository.Save(ctx, ${stateLiteral(entity, created, '\t')})
	return err`
    : `	// TODO (agente): ${entity.name} tiene miembros que la instantánea no informa; construye la copia (nueva o actualizada)
	// y guárdala con p.repository.Save(...). Un hecho anterior o igual al guardado no la pisa.
	return fmt.Errorf("%w: %s", ErrNotImplemented, ${goString(`${type}.Apply`)})`;
  const rows = alignRows(snapshotFields.map((field) => ({ indent: '\t', cells: [goExported(field.name), declType(field, { qualify: true })] })));
  const body = `
// ${snapshot} es el estado que informa ${dependency.id} de un ${entity.name}.
type ${snapshot} struct {
${rows.join('\n')}
}

// ${type} mantiene al día la copia local de ${entity.name}, propiedad de ${dependency.id}. Es una PROYECCIÓN, no una fuente de
// verdad: nunca la expongas como recurso propio, y es la ÚNICA escritura de la copia.
type ${type} struct {
	repository domain.${portName(entity)}
}

// New${type} construye el proyector.
func New${type}(repository domain.${portName(entity)}) *${type} {
	return &${type}{repository: repository}
}

// Apply aplica el estado informado: crea la copia o la actualiza conservando su id, idempotente frente a la reentrega. La
// copia se guarda en su propia transacción, la abre el adaptador.
func (p *${type}) Apply(ctx context.Context, snapshot ${snapshot}) error {
${write}
}
`;
  return {
    path: applicationPath(model, type),
    content: packageFile(model, application, {
      imports: ['context', 'fmt', 'github.com/google/uuid', 'internal/domain', ...snapshotFields.flatMap((field) => fieldImports(field))],
      body,
      generated: writable && orderable
    })
  };
}

function renderReader(model, dependency, need, entity) {
  const { application } = layout(model);
  const { replica } = need;
  const { onMiss } = replica;
  const type = readerType(need);
  const keyField = entity.fields.find((field) => field.name === replica.keyField);
  const keyType = declType(keyField ?? { goType: 'string', required: true }, { qualify: true });
  const key = localName(replica.keyField);
  const client = fetchClient(model, need);
  const finder = naturalKeyFinder(model, entity);
  const find = `r.repository.${finder?.name ?? `FindBy${goExported(replica.keyField)}`}(ctx, ${key})`;
  const fields = alignRows([
    { indent: '\t', cells: ['repository', `domain.${portName(entity)}`] },
    ...(client ? [{ text: '\t//lint:ignore U1000 lo usa la hydrate que escribe el agente.' }, { indent: '\t', cells: [clientParam(client), `domain.${clientPort(client)}`] }] : [])
  ]);
  const params = [`repository domain.${portName(entity)}`, ...(client ? [`${clientParam(client)} domain.${clientPort(client)}`] : [])];
  const init = ['repository: repository', ...(client ? [`${clientParam(client)}: ${clientParam(client)}`] : [])];
  let method;
  if (client) {
    method = `// ByKey es la copia local y, si aún no la tenemos, la pide a ${dependency.id} y la guarda. La copia se guarda en su PROPIA
// transacción (la abre el adaptador de una réplica): aquí se llega desde una consulta, de solo lectura. Desde un comando que
// escribe, la llamada de red alarga su transacción: resuelve el dato antes.
func (r *${type}) ByKey(ctx context.Context, ${key} ${keyType}) (*domain.${entity.name}, bool, error) {
	found, ok, err := ${find}
	if err != nil || ok {
		return found, ok, err
	}
	return r.hydrate(ctx, ${key})
}`;
  } else if (onMiss.action === 'fail') {
    const message = `fmt.Sprintf(${goString(`No se conoce ${replica.entityName} %v (dato de ${dependency.id} aún no replicado)`)}, ${key})`;
    const failure = onMiss.exceptionClass
      ? onMiss.dynamicStatus
        ? `domain.StatusErrorf(domain.${sentinelOf(onMiss.error)}, ${onMiss.httpStatus}, "%s", ${message})`
        : `domain.Errorf(domain.${sentinelOf(onMiss.error)}, "%s", ${message})`
      : `errors.New(${message})`;
    method = `// ByKey es la copia local, o falla con ${onMiss.error ?? 'el error de onMiss'} si ${dependency.id} todavía no nos ha informado de ese
// ${replica.keyField}: sin el dato no se puede decidir bien, y así lo declara el diseño.
func (r *${type}) ByKey(ctx context.Context, ${key} ${keyType}) (*domain.${entity.name}, error) {
	found, ok, err := ${find}
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ${failure}
	}
	return found, nil
}`;
  } else {
    method = `${commentLines(`ByKey es la copia local, y false si ${dependency.id} todavía no nos ha informado de ese ${replica.keyField}. El diseño declara que entonces el servicio DEGRADA: ${onMiss.degradedTo ?? '(sin describir)'}. El resultado degradado lo escribe quien llama, distinguible por el cliente de una respuesta normal.`).join('\n')}
func (r *${type}) ByKey(ctx context.Context, ${key} ${keyType}) (*domain.${entity.name}, bool, error) {
	return ${find}
}`;
  }
  const batch = naturalKeyBatchFinder(model, entity);
  const byKeys =
    batch && batch.param.name === replica.keyField
      ? `

// ByKeys son las copias locales de varios ${replica.keyField} en UNA consulta, por ${replica.keyField}. Es lo que lee una operación de
// listado: un ByKey por elemento serían N consultas por página. Solo devuelve lo ya replicado: una clave que falte NO está en
// el mapa, y a cada una de esas se le aplica la política declarada pasándola por ByKey. No la des por inexistente.
func (r *${type}) ByKeys(ctx context.Context, ${batch.plural} []${keyType}) (map[${keyType}]*domain.${entity.name}, error) {
	copies, err := r.repository.${batch.name}(ctx, ${batch.plural})
	if err != nil {
		return nil, err
	}
	byKey := make(map[${keyType}]*domain.${entity.name}, len(copies))
	for _, found := range copies {
		byKey[found.${goExported(replica.keyField)}()] = found
	}
	return byKey, nil
}`
      : '';
  const freshness = replica.freshness ? ` Tolerancia declarada en el diseño: ${replica.freshness}` : '';
  const users = need.usedBy.length > 0 ? ` Lo usan: ${need.usedBy.join(', ')}.` : '';
  const doc = commentLines(
    `${type} lee la copia local de ${replica.entityName} (propiedad de ${dependency.id}), con la política declarada para cuando el dato todavía no está: ${onMiss.action}. La copia es eventualmente consistente —la mantiene ${projectorType(need)} al ritmo de los eventos de ${dependency.id}—: nunca la expongas como recurso propio.${freshness}${users}`
  ).join('\n');
  const body = `
${doc}
type ${type} struct {
${fields.join('\n')}
}

// New${type} construye el lector.
func New${type}(${params.join(', ')}) *${type} {
	return &${type}{${init.join(', ')}}
}

${method}${byKeys}
`;
  const imports = ['context', 'errors', 'fmt', 'internal/domain', ...(keyField ? fieldImports(keyField) : [])];
  const files = [{ path: applicationPath(model, type), content: packageFile(model, application, { imports, body }) }];
  if (client) {
    const call = client.calls.find((candidate) => candidate.name === need.fetch.call);
    const hydrate = `
// hydrate pide a ${dependency.id} el ${replica.entityName} que la copia aún no tiene, lo guarda y lo devuelve.
func (r *${type}) hydrate(ctx context.Context, ${key} ${keyType}) (*domain.${entity.name}, bool, error) {
	// TODO (agente): invoca r.${clientParam(client)}.${call ? callMethod(call) : need.fetch.call}(ctx, ...) —ya devuelve el resultado de dominio (${goTypeName(need.fetch.resultType)})—,
	// construye la copia de ${entity.name} con domain.Rehydrate${entity.name} y guárdala con r.repository.Save, y devuélvela. El retry y el
	// circuito ya están en el adaptador: no los repitas.
	return nil, false, fmt.Errorf("%w: %s %v", ErrNotImplemented, ${goString(`${type}.hydrate`)}, ${key})
}
`;
    files.push({
      path: applicationPath(model, `${entity.name}Hydrate`),
      content: packageFile(model, application, { imports: ['context', 'fmt', 'internal/domain', ...(keyField ? fieldImports(keyField) : [])], body: hydrate, generated: false })
    });
  }
  return files;
}

/** La nota del handler de la operación de proyección: aplica con el proyector. */
export function projectionNotes(model, operation) {
  return projectionsFedBy(model, operation).map(
    ({ entity, need }) =>
      `Proyección de ${entity.name}: aplica el estado que informa el evento con h.${goUnexported(projectorType(need))}.Apply(ctx, ${entity.name}Snapshot{...}) ` +
      '—upsert idempotente que ya descarta la reentrega tardía y guarda en su propia transacción—. Es la ÚNICA escritura de la copia: no la guardes por el repositorio.'
  );
}

/** La nota de un dato replicado: se lee por el lector, que aplica onMiss (la de los otros tres, con los nombres de Go). */
export function replicaNote(model, depId, need, operation, why) {
  const { replica } = need;
  const entity = replica && replicas(model).find((candidate) => candidate.need === need)?.entity;
  if (!entity) return `Dependencia ${depId}.${need.name} (replicada)${why}: la réplica no se pudo resolver (revisa los avisos del build); no leas el dato por tu cuenta`;
  const reader = `h.${goUnexported(readerType(need))}`;
  const onMiss = {
    fetch: `Si la copia aún no tiene el dato, el lector lo pide a ${depId} y lo guarda (su hydrate es tuya: lo dice su TODO).`,
    fail: `Si la copia aún no tiene el dato, el lector devuelve ${replica.onMiss.error ? `domain.${sentinelOf(replica.onMiss.error)}` : 'el error de onMiss'}: devuélvelo, no sigas con un valor inventado.`,
    degrade: `Si la copia aún no tiene el dato, el lector devuelve false y el resultado degradado lo escribes TÚ, distinguible por el cliente de una respuesta normal: ${replica.onMiss.degradedTo}`
  }[replica.onMiss.action];
  const batch =
    (operation.returnsList || operation.paginated) && naturalKeyBatchFinder(model, entity)
      ? ` Esta operación devuelve una lista: lee la página entera con ${reader}.ByKeys(ctx, ...) (UNA consulta) y pasa por ByKey solo las claves que falten, que es donde se aplica onMiss.`
      : '';
  const exposed = need.exposedAs && need.dtoName ? ` El dato SALE en la respuesta: la función de mapeo pide un ${goTypeName(need.dtoName)} por parámetro y lo pone en el campo '${need.exposedAs}'.` : '';
  return `Dependencia ${depId}.${need.name} (replicada)${why}: lee ${replica.entityName} con ${reader}.ByKey(ctx, ...), que ya aplica onMiss: ${replica.onMiss.action}. ${onMiss}${batch} NUNCA leas el repositorio de la réplica directamente ni la escribas desde aquí: la copia solo se escribe desde ${projectorType(need)}.${exposed}`;
}
