// Capa dependencies: lo único que exige código propio es una réplica local
// (strategy: replicated). Todo lo demás ya sale de otras capas — el puerto y el
// adaptador del cliente de http-clients.js, el listener de la skill del broker,
// el guard de idempotency.js, la entidad/repositorio de entities.js y
// repositories.js. Aquí se generan dos clases por réplica:
//
//   <E>Projector  escritura: upsert idempotente invocado desde el handler de la
//                 operación de proyección que dispara la suscripción.
//   <E>Reader     lectura: aplica la política onMiss cuando la copia no tiene
//                 el dato (pedirlo al proveedor, fallar, o degradar).
//
// El cableado es listener → IdempotencyGuard → UseCaseMediator → handler →
// Projector → puerto de repositorio. El listener NUNCA llama al Projector
// directamente: sería una segunda puerta de entrada al dominio saltándose el
// mediator (prohibido por constitution.md) y duplicaría la idempotencia.

import { javaFile, javaPath, subPackage } from './render.js';
import { domainSubPackage, domainTypeImport } from './entities.js';

const PROJECTION_PKG = 'application.projection';
const ANNOTATIONS_PKG = 'application.annotations';
const PORT_PKG = 'domain.repository';
const ERRORS_PKG = 'domain.errors';
const CLIENTS_PKG = 'domain.clients';

export function generate(model) {
  if (!model.dependencies) return [];

  const files = [];
  for (const dependency of model.dependencies) {
    for (const need of dependency.needs) {
      if (!need.replica) continue;
      const entity = model.entities.find((e) => e.name === need.replica.entityName);
      if (!entity) continue;
      files.push(renderProjector(model, dependency, need, entity));
      files.push(renderReader(model, dependency, need, entity));
    }
  }
  return files;
}

// Campos que la proyección mantiene: todo lo que no es el id técnico ni la clave
// de correlación (esos identifican la fila, no se actualizan).
function projectedFields(entity, replica) {
  return entity.fields.filter((field) => !field.isId && field.name !== replica.keyField && !field.generated);
}

// Si el payload trae un instante del hecho, se compara antes de escribir: es lo
// que impide que una reentrega tardía pise un valor más nuevo. Es el problema que
// el DSL deliberadamente no declara (sería un SLA de implementación); lo resuelve
// el generador porque es una decisión de solución.
function occurredAtField(entity) {
  return entity.fields.find((field) => /^(occurredAt|updatedAt|eventTime)$/.test(field.name)) ?? null;
}

function renderProjector(model, dependency, need, entity) {
  const { replica } = need;
  const fields = projectedFields(entity, replica);
  const ordering = occurredAtField(entity);

  // Sin imports de Spring (application/ está desacoplada del framework):
  // @ApplicationComponent es propia y la transacción ya la abrió el
  // UseCaseMediator al despachar la operación de proyección.
  const imports = new Set([
    `${subPackage(model, domainSubPackage(entity))}.${entity.name}`,
    `${subPackage(model, PORT_PKG)}.${replica.repositoryPort}`,
    `${subPackage(model, ANNOTATIONS_PKG)}.ApplicationComponent`,
    ...replica.keyFieldImports
  ]);
  for (const field of fields) {
    for (const name of field.imports ?? []) imports.add(name);
    // Enum o value object del diseño: vive en otro paquete y no viaja en field.imports.
    const typeImport = domainTypeImport(model, field);
    if (typeImport) imports.add(typeImport);
  }

  const params = [
    `${replica.keyFieldJavaType} ${replica.keyField}`,
    ...fields.map((field) => `${field.javaType} ${field.name}`)
  ].join(', ');
  const args = [replica.keyField, ...fields.map((field) => field.name)].join(', ');
  const updateArgs = fields.map((field) => field.name).join(', ');

  // El dominio generado está encapsulado: sin setters y con el constructor de
  // rehidratación como único ctor. Así que la creación y la actualización pasan
  // por métodos de dominio que escribe el agente (domain-modeling.md); aquí se
  // fija el esqueleto —búsqueda, ordenación, ramas, save—, que es la parte fácil
  // de equivocar, y se dejan sus firmas exactas como TODO.
  const factorySignature = `public static ${entity.name} projectionOf(${params})`;
  const updateSignature = `public void applySnapshot(${fields.map((f) => `${f.javaType} ${f.name}`).join(', ')})`;

  const guard = ordering
    ? `
            // Reentrega tardía: un hecho más viejo no puede pisar a uno más nuevo.
            if (existing.get${capitalize(ordering.name)}() != null
                    && ${ordering.name} != null
                    && ${ordering.name}.isBefore(existing.get${capitalize(ordering.name)}())) {
                return;
            }
`
    : `
            // TODO (agente): el payload de la suscripción no trae ningún instante del
            // hecho, así que dos entregas desordenadas dejarían el valor viejo. Si el
            // proveedor expone uno, añádelo al payload en el diseño y compáralo aquí.
`;

  const todo = `    // TODO (agente): añade a ${entity.name} los dos métodos de dominio que usa este
    // projector (el dominio no tiene setters, ver docs/keel/conventions/domain-modeling.md):
    //   ${factorySignature}   — factory de la copia; genera el id
    //   ${updateSignature}   — actualiza los campos informados
`;

  const body = `/**
 * Mantiene al día la copia local de ${entity.name}, propiedad de ${dependency.id}.
 *
 * <p>Esto es una <strong>proyección</strong>, no una fuente de verdad: solo se escribe
 * desde aquí, nunca desde un handler de negocio, y no se le aplican invariantes del
 * dominio propio — las suyas las garantiza ${dependency.id}.
 *
 * <p>El upsert es idempotente por construcción, así que una reentrega del mismo evento
 * no corrompe la copia. La deduplicación estricta la hace antes el IdempotencyGuard
 * del listener; esto es la segunda red.
 *
 * <p>Necesidad que la justifica: ${dependency.id}.${need.name}${need.description ? ` — ${need.description}` : ''}
 */
@ApplicationComponent
public class ${replica.projectorClass} {

    private final ${replica.repositoryPort} repository;

    public ${replica.projectorClass}(${replica.repositoryPort} repository) {
        this.repository = repository;
    }

    /**
     * Aplica el estado que informa ${dependency.id}: actualiza la copia si ya existe,
     * la crea si es la primera noticia de este ${replica.keyField}.
     *
     * <p>Se ejecuta dentro de la transacción que abre el UseCaseMediator al despachar
     * la operación de proyección; no la abre por su cuenta.
     */
    public void apply(${params}) {
        repository.findBy${capitalize(replica.keyField)}(${replica.keyField}).ifPresentOrElse(existing -> {${guard}            existing.applySnapshot(${updateArgs});
            repository.save(existing);
        }, () -> repository.save(${entity.name}.projectionOf(${args})));
    }

${todo}}`;

  return {
    path: javaPath(model, PROJECTION_PKG, replica.projectorClass),
    content: javaFile(subPackage(model, PROJECTION_PKG), [...imports], body)
  };
}

function renderReader(model, dependency, need, entity) {
  const { replica } = need;
  const { onMiss } = replica;

  const imports = new Set([
    `${subPackage(model, domainSubPackage(entity))}.${entity.name}`,
    `${subPackage(model, PORT_PKG)}.${replica.repositoryPort}`,
    `${subPackage(model, ANNOTATIONS_PKG)}.ApplicationComponent`,
    'java.util.Optional',
    ...replica.keyFieldImports
  ]);

  const deps = [{ type: replica.repositoryPort, name: 'repository' }];
  if (onMiss.action === 'fetch' && need.fetch) {
    imports.add(`${subPackage(model, CLIENTS_PKG)}.${need.fetch.clientClass}`);
    deps.push({ type: need.fetch.clientClass, name: decapitalize(need.fetch.clientClass) });
  }
  if (onMiss.action === 'fail' && onMiss.exceptionClass) {
    imports.add(`${subPackage(model, ERRORS_PKG)}.${onMiss.exceptionClass}`);
  }

  const fieldDecls = deps.map((dep) => `    private final ${dep.type} ${dep.name};`).join('\n');
  const ctorParams = deps.map((dep) => `${dep.type} ${dep.name}`).join(', ');
  const ctorBody = deps.map((dep) => `        this.${dep.name} = ${dep.name};`).join('\n');

  return {
    path: javaPath(model, PROJECTION_PKG, replica.readerClass),
    content: javaFile(
      subPackage(model, PROJECTION_PKG),
      [...imports],
      `${readerJavadoc(dependency, need)}
@ApplicationComponent
public class ${replica.readerClass} {

${fieldDecls}

    public ${replica.readerClass}(${ctorParams}) {
${ctorBody}
    }

${missBody(model, dependency, need, entity)}
}`
    )
  };
}

function readerJavadoc(dependency, need) {
  const { replica } = need;
  const freshness = replica.freshness
    ? `\n *\n * <p>Tolerancia declarada en el diseño: ${replica.freshness}`
    : '';
  const users = need.usedBy.length > 0 ? `\n *\n * <p>Lo usan: ${need.usedBy.join(', ')}.` : '';
  return `/**
 * Lectura de la copia local de ${replica.entityName} (propiedad de ${dependency.id}), con la
 * política declarada para cuando el dato todavía no está: <strong>${replica.onMiss.action}</strong>.
 *
 * <p>La copia es eventualmente consistente: la mantiene ${replica.projectorClass} al ritmo de
 * los eventos de ${dependency.id}. Nunca la expongas tal cual como recurso propio.${freshness}${users}
 */`;
}

function missBody(model, dependency, need, entity) {
  const { replica } = need;
  const { onMiss, keyField, keyFieldJavaType } = replica;
  const finder = `repository.findBy${capitalize(keyField)}(${keyField})`;

  if (onMiss.action === 'fetch' && need.fetch) {
    const clientVar = decapitalize(need.fetch.clientClass);
    return `    /**
     * Devuelve la copia local y, si aún no la tenemos, la pide a ${dependency.id} y la guarda.
     *
     * <p><strong>Cuidado con la transacción</strong>: el UseCaseMediator ya abrió una al despachar
     * el caso de uso, así que la llamada de red ocurre dentro de ella y la mantiene abierta durante
     * todo el timeout. Es aceptable desde un handler de query (read-only); desde un command que
     * escribe, resuelve el dato antes de despachar el command, o revisa con quien diseñó si esa
     * necesidad debería ser {@code strategy: on-demand}.
     *
     * <p>Con una excepción: desde el barrido de una reconciliación no hay transacción abarcadora
     * —lo despacha {@code dispatchWithoutTransaction}—, así que ahí la llamada no retiene ninguna
     * conexión y el {@code save} de {@code hydrate} abre y confirma la suya en el adaptador.
     */
    public Optional<${entity.name}> byKey(${keyFieldJavaType} ${keyField}) {
        return ${finder}.or(() -> hydrate(${keyField}));
    }

    private Optional<${entity.name}> hydrate(${keyFieldJavaType} ${keyField}) {
        // TODO (agente): invoca ${clientVar}.${need.fetch.call}(...) y mapea el resultado
        // (${need.fetch.resultType}) a ${entity.name} con el mapper de anticorrupción del
        // cliente; después persístelo con repository.save(...) y devuélvelo.
        // El circuit breaker y el retry ya están en el adaptador del cliente: no los repitas.
        return Optional.empty();
    }`;
  }

  if (onMiss.action === 'fail') {
    const message = `"No se conoce ${replica.entityName} " + ${keyField} + " (dato de ${dependency.id} aún no replicado)"`;
    // El mismo code declarado con http distinto en dos operaciones no puede quemar
    // el status en la clase: la excepción lo recibe por constructor.
    const exception = onMiss.exceptionClass
      ? `new ${onMiss.exceptionClass}(${message}${onMiss.dynamicStatus ? `, ${onMiss.httpStatus}` : ''})`
      : `new IllegalStateException(${message})`;
    return `    /**
     * Devuelve la copia local, o falla con {@code ${onMiss.error}} si ${dependency.id} todavía
     * no nos ha informado de ese ${keyField}. Sin el dato no se puede decidir bien, y así lo
     * declara el diseño.
     */
    public ${entity.name} byKey(${keyFieldJavaType} ${keyField}) {
        return ${finder}
                .orElseThrow(() -> ${exception});${
                  onMiss.exceptionClass
                    ? ''
                    : `
        // TODO (agente): el diseño declara onMiss.error = ${onMiss.error}, pero ninguna
        // operación de use-cases lo declara todavía, así que su clase no existe.`
                }
    }`;
  }

  return `    /**
     * Devuelve la copia local, o vacío si ${dependency.id} todavía no nos ha informado de ese
     * ${keyField}. El diseño declara que en ese caso el servicio <strong>degrada</strong>:
     *
     * <p>${onMiss.degradedTo}
     *
     * <p>El resultado degradado es lógica de negocio y lo escribe quien llama: debe ser
     * distinguible por el cliente de una respuesta normal, nunca un dato plausible pero falso.
     */
    public Optional<${entity.name}> byKey(${keyFieldJavaType} ${keyField}) {
        return ${finder};
    }`;
}

function capitalize(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function decapitalize(name) {
  return name.charAt(0).toLowerCase() + name.slice(1);
}
