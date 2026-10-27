// Resolución de las referencias embebidas (`embed`) de un payload: el `<Raíz>RefResolver` de keel-spring.
//
// Un agregado solo guarda el id de la raíz ajena (frontera de agregado), así que el `<Raíz>RefDto` no se deriva de
// la entidad y el mapper lo recibe por parámetro. Quien lo produce es este resolver, y lo hace POR LOTE: una consulta
// por raíz referenciada, sea cual sea el tamaño de la página. keel-nest emitía la RefDto y su mapper pero no esto, y
// sus dos corridas de asset-vault escribieron la lectura a mano (`findAllByIds`, `findAllByIdIn`). Qué raíces se
// resuelven lo decide keel-core (`refTargets`), igual que para keel-spring.

import { refTargets } from '@keel-system/keel-core/gen/ref-targets';
import { DIRS, classPath, decapitalize, entityDir, tsModule } from './render.js';
import { ANNOTATIONS_TS } from './mediator.js';
import { portClass, portPath } from './repositories.js';

/** Dónde vive el resolver de una raíz embebida. */
export function resolverPath(entity) {
  return classPath(DIRS.appSupport, `${entity.name}RefResolver`);
}

/** Los resolvers que registra el módulo de casos de uso. */
export function resolverClasses(model) {
  if (!model.layersPresent?.persistence) return [];
  return refTargets(model).map(({ entity }) => ({ symbol: `${entity.name}RefResolver`, from: resolverPath(entity) }));
}

export function generate(model) {
  if (!model.layersPresent?.persistence) return [];
  return refTargets(model).map(({ ref, entity }) => renderResolver(entity, ref));
}

function renderResolver(entity, ref) {
  const file = resolverPath(entity);
  const id = entity.idField;
  const idName = id?.name ?? 'id';
  const idType = id?.tsType ?? 'string';
  const port = portClass(entity);
  const mapper = `${entity.name}ApplicationMapper`;
  const repositoryField = decapitalize(port);
  const mapperField = decapitalize(mapper);
  const imports = [
    { symbol: 'ApplicationComponent', from: ANNOTATIONS_TS },
    { symbol: entity.name, from: classPath(entityDir(entity), entity.name), type: true },
    { symbol: port, from: portPath(entity) },
    { symbol: mapper, from: classPath(DIRS.mappers, mapper) },
    { symbol: ref.name, from: classPath(DIRS.dtos, ref.name), type: true },
    ...(id?.imports ?? []).map((imp) => ({ ...imp, type: true }))
  ];
  const body = `/**
 * Produce el ${ref.name} de las operaciones que embeben ${entity.name} (\`embed\`).
 *
 * Resuelve SIEMPRE por lote: una consulta por raíz referenciada, no una por elemento. Un \`findById\` dentro del bucle
 * de una página es un N+1. Una referencia que no existe no aparece en el mapa: si su ausencia es un error de negocio
 * lo decide el handler con el error del diseño. La transacción de lectura la abre el UseCaseMediator.
 */
@ApplicationComponent()
export class ${entity.name}RefResolver {
  static readonly inject = [${port}, ${mapper}] as const;

  constructor(private readonly ${repositoryField}: ${port}, private readonly ${mapperField}: ${mapper}) {}

  /** Las referencias de los ids de una página entera, en UNA consulta, indexadas por id (el orden no importa). */
  async resolveAll(ids: readonly (${idType} | null | undefined)[]): Promise<Map<${idType}, ${ref.name}>> {
    const distinct = [...new Set(ids.filter((value): value is ${idType} => value != null))];
    if (distinct.length === 0) return new Map();
    const found: ${entity.name}[] = await this.${repositoryField}.findAllById(distinct);
    return new Map(found.map((root) => [root.${idName}, this.${mapperField}.to${ref.name}(root)]));
  }

  /** Una sola referencia, para las operaciones que devuelven un elemento. */
  async resolve(${idName}: ${idType} | null | undefined): Promise<${ref.name} | null> {
    if (${idName} == null) return null;
    const found = await this.${repositoryField}.findById(${idName});
    return found == null ? null : this.${mapperField}.to${ref.name}(found);
  }
}`;
  return { path: file, content: tsModule(file, imports, body) };
}

