// La copia local de un dato de otro servidor (`dependencies.needs` con `strategy: replicated`, incremento 13j). Las
// mismas dos clases que keel-spring, en application/projection:
//
//   <E>Projector  la ESCRITURA: upsert idempotente que invoca el handler de la operación de proyección (la que
//                 dispara la suscripción del `fedBy`). Una reentrega tardía no pisa un valor más nuevo.
//   <E>Reader     la LECTURA: aplica `onMiss` cuando la copia todavía no tiene el dato (pedirlo al proveedor,
//                 fallar con el error del diseño o devolver vacío para degradar).
//
// El cableado es el de keel-spring: listener → guarda de idempotencia → UseCaseMediator → handler → Projector →
// puerto del repositorio. El listener NUNCA llama al Projector: sería otra puerta al dominio saltándose el mediator.
// Las dos clases son de application (sin Nest): declaran `static readonly inject` y las cablea el UseCaseModule.

import { DIRS, capitalize, classPath, decapitalize, entityDir, tsModule } from './render.js';
import { portPath as clientPortPath } from './http-clients.js';
import { ANNOTATIONS_TS } from './mediator.js';
import { PORT_DIR } from './repositories.js';

const PROJECTION_DIR = 'application/projection';

/** Las réplicas que el diseño declara, ya resueltas por el modelo, con su entidad. */
export function replicas(model) {
  const found = [];
  for (const dependency of model.dependencies ?? []) {
    for (const need of dependency.needs ?? []) {
      if (!need.replica) continue;
      const entity = (model.entities ?? []).find((candidate) => candidate.name === need.replica.entityName);
      if (entity) found.push({ dependency, need, entity });
    }
  }
  return found;
}

export const projectorPath = (replica) => classPath(PROJECTION_DIR, replica.projectorClass);
export const readerPath = (replica) => classPath(PROJECTION_DIR, replica.readerClass);

/** Las clases de aplicación que el UseCaseModule tiene que cablear: el proyector y el lector de cada réplica. */
export function projectionClasses(model) {
  return replicas(model).flatMap(({ need }) => [
    { symbol: need.replica.projectorClass, from: projectorPath(need.replica) },
    { symbol: need.replica.readerClass, from: readerPath(need.replica) }
  ]);
}

export function generate(model) {
  return replicas(model).flatMap(({ dependency, need, entity }) => [renderProjector(model, dependency, need, entity), renderReader(model, dependency, need, entity)]);
}

// Lo que la proyección mantiene: todo menos el id técnico y la clave de correlación, que identifican la fila.
function projectedFields(entity, replica) {
  return entity.fields.filter((field) => !field.isId && field.name !== replica.keyField && !field.generated);
}

// Si la copia guarda el instante del hecho, se compara antes de escribir: una reentrega tardía no pisa un valor más
// nuevo. La misma regla que keel-spring.
function occurredAtField(entity) {
  return entity.fields.find((field) => /^(occurredAt|updatedAt|eventTime)$/.test(field.name)) ?? null;
}

const repositoryPortPath = (entity) => classPath(PORT_DIR, `${entity.name}Repository`);

function renderProjector(model, dependency, need, entity) {
  const { replica } = need;
  const file = projectorPath(replica);
  const fields = projectedFields(entity, replica);
  const ordering = occurredAtField(entity);
  const keyField = entity.fields.find((field) => field.name === replica.keyField);
  const imports = [
    { symbol: 'ApplicationComponent', from: ANNOTATIONS_TS },
    { symbol: entity.name, from: classPath(entityDir(entity), entity.name) },
    { symbol: replica.repositoryPort, from: repositoryPortPath(entity) }
  ];
  for (const field of [keyField, ...fields].filter(Boolean)) imports.push(...(field.imports ?? []).map((imp) => ({ ...imp, type: true })));
  const type = (field) => (field.required ? field.tsType : `${field.tsType} | null`);
  const snapshot = [keyField, ...fields].filter(Boolean).map((field) => `  readonly ${field.name}: ${type(field)};`);
  const updateArgs = fields.map((field) => `snapshot.${field.name}`).join(', ');
  const guard = ordering
    ? `
      // Reentrega tardía: un hecho más viejo no puede pisar a uno más nuevo.
      if (existing.${ordering.name} != null && snapshot.${ordering.name} != null && snapshot.${ordering.name} < existing.${ordering.name}) return;`
    : `
      // TODO (agente): el payload no trae ningún instante del hecho, así que dos entregas desordenadas dejarían el valor
      // viejo. Si el proveedor expone uno, añádelo al payload en el diseño y compáralo aquí.`;
  const body = `/** El estado que informa ${dependency.id} de un ${entity.name}. */
export interface ${entity.name}Snapshot {
${snapshot.join('\n')}
}

/**
 * Mantiene al día la copia local de ${entity.name}, propiedad de ${dependency.id}.
 *
 * Es una PROYECCIÓN, no una fuente de verdad: solo se escribe desde aquí, nunca desde un handler de negocio, y no se le
 * aplican invariantes del dominio propio —las suyas las garantiza ${dependency.id}—. El upsert es idempotente: una
 * reentrega no corrompe la copia (la deduplicación estricta la hace antes la guarda del listener; esto es la segunda red).
 *
 * Necesidad que la justifica: ${dependency.id}.${need.name}${need.description ? ` — ${need.description}` : ''}
 *
 * TODO (agente): añade a ${entity.name} los dos métodos de dominio que usa (el dominio no tiene setters):
 *   static projectionOf(snapshot: ${entity.name}Snapshot): ${entity.name}   — la copia nueva; genera el id
 *   applySnapshot(${fields.map((field) => `${field.name}: ${type(field)}`).join(', ')}): void   — actualiza lo informado
 */
@ApplicationComponent()
export class ${replica.projectorClass} {
  static readonly inject = [${replica.repositoryPort}] as const;

  constructor(private readonly repository: ${replica.repositoryPort}) {}

  /**
   * Aplica el estado que informa ${dependency.id}: actualiza la copia si ya existe, la crea si es la primera noticia de
   * este ${replica.keyField}. Se ejecuta dentro de la transacción que abrió el UseCaseMediator al despachar la operación
   * de proyección.
   */
  async apply(snapshot: ${entity.name}Snapshot): Promise<void> {
    const existing = await this.repository.findBy${capitalize(replica.keyField)}(snapshot.${replica.keyField});
    if (existing != null) {${guard}
      // Los dos métodos los añade el agente al dominio (ver el TODO de la clase); hasta entonces, por su forma.
      (existing as unknown as { applySnapshot(...values: unknown[]): void }).applySnapshot(${updateArgs});
      await this.repository.save(existing);
      return;
    }
    await this.repository.save((${entity.name} as unknown as { projectionOf(snapshot: ${entity.name}Snapshot): ${entity.name} }).projectionOf(snapshot));
  }
}`;
  return { path: file, content: tsModule(file, imports, body) };
}

function renderReader(model, dependency, need, entity) {
  const { replica } = need;
  const { onMiss } = replica;
  const file = readerPath(replica);
  const keyField = entity.fields.find((field) => field.name === replica.keyField);
  const keyType = keyField?.tsType ?? 'string';
  const imports = [
    { symbol: 'ApplicationComponent', from: ANNOTATIONS_TS },
    { symbol: entity.name, from: classPath(entityDir(entity), entity.name), type: true },
    { symbol: replica.repositoryPort, from: repositoryPortPath(entity) },
    ...(keyField?.imports ?? []).map((imp) => ({ ...imp, type: true }))
  ];
  const deps = [{ type: replica.repositoryPort, name: 'repository' }];
  const client = onMiss.action === 'fetch' && need.fetch ? (model.httpClients ?? []).find((candidate) => candidate.clientClass === need.fetch.clientClass) : null;
  if (client) {
    imports.push({ symbol: client.clientClass, from: clientPortPath(client) });
    deps.push({ type: client.clientClass, name: decapitalize(client.clientClass) });
  }
  if (onMiss.action === 'fail' && onMiss.exceptionClass) imports.push({ symbol: onMiss.exceptionClass, from: classPath(DIRS.errors, onMiss.exceptionClass) });
  const finder = `this.repository.findBy${capitalize(replica.keyField)}(${replica.keyField})`;
  let method;
  if (onMiss.action === 'fetch' && client) {
    method = `  /**
   * La copia local y, si aún no la tenemos, la pide a ${dependency.id} y la guarda. La copia se guarda en su PROPIA
   * transacción (el adaptador del repositorio de una réplica la abre aparte): aquí se llega desde una consulta, de
   * solo lectura. Desde un command que escribe, la llamada de red alarga su transacción: resuelve el dato antes.
   */
  async byKey(${replica.keyField}: ${keyType}): Promise<${entity.name} | null> {
    return (await ${finder}) ?? (await this.hydrate(${replica.keyField}));
  }

  private async hydrate(${replica.keyField}: ${keyType}): Promise<${entity.name} | null> {
    // TODO (agente): invoca await this.${decapitalize(client.clientClass)}.${need.fetch.call}(...) —ya devuelve el resultado de
    // dominio (${need.fetch.resultType})—, construye la copia con ${entity.name}.projectionOf(...), guárdala con
    // this.repository.save(...) y devuélvela. El retry y el circuito ya están en el adaptador: no los repitas.
    void [this.${decapitalize(client.clientClass)}, ${replica.keyField}];
    return null;
  }`;
  } else if (onMiss.action === 'fail') {
    const message = `\`No se conoce ${replica.entityName} \${${replica.keyField}} (dato de ${dependency.id} aún no replicado)\``;
    const exception = onMiss.exceptionClass
      ? `new ${onMiss.exceptionClass}(${message}${onMiss.dynamicStatus ? `, ${onMiss.httpStatus}` : ''})`
      : `new Error(${message})`;
    method = `  /**
   * La copia local, o falla con ${onMiss.error ?? 'el error de onMiss'} si ${dependency.id} todavía no nos ha informado de ese
   * ${replica.keyField}: sin el dato no se puede decidir bien, y así lo declara el diseño.${
     onMiss.exceptionClass ? '' : `\n   * TODO (agente): el diseño declara onMiss.error = ${onMiss.error}, pero ninguna operación lo declara: su clase no existe.`
   }
   */
  async byKey(${replica.keyField}: ${keyType}): Promise<${entity.name}> {
    const found = await ${finder};
    if (found == null) throw ${exception};
    return found;
  }`;
  } else {
    method = `  /**
   * La copia local, o null si ${dependency.id} todavía no nos ha informado de ese ${replica.keyField}. El diseño declara que
   * entonces el servicio DEGRADA: ${onMiss.degradedTo ?? '(sin describir)'}
   * El resultado degradado lo escribe quien llama, distinguible por el cliente de una respuesta normal.
   */
  async byKey(${replica.keyField}: ${keyType}): Promise<${entity.name} | null> {
    return ${finder};
  }`;
  }
  const freshness = replica.freshness ? `\n *\n * Tolerancia declarada en el diseño: ${replica.freshness}` : '';
  const users = need.usedBy.length > 0 ? `\n *\n * Lo usan: ${need.usedBy.join(', ')}.` : '';
  const body = `/**
 * Lectura de la copia local de ${replica.entityName} (propiedad de ${dependency.id}), con la política declarada para cuando
 * el dato todavía no está: ${onMiss.action}. La copia es eventualmente consistente —la mantiene ${replica.projectorClass} al
 * ritmo de los eventos de ${dependency.id}—: nunca la expongas como recurso propio.${freshness}${users}
 */
@ApplicationComponent()
export class ${replica.readerClass} {
  static readonly inject = [${deps.map((dep) => dep.type).join(', ')}] as const;

  constructor(${deps.map((dep) => `private readonly ${dep.name}: ${dep.type}`).join(', ')}) {}

${method}
}`;
  return { path: file, content: tsModule(file, imports, body) };
}
