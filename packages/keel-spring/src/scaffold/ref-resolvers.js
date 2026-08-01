// Resolución de las referencias embebidas (`embed`) de un payload.
//
// Un agregado solo guarda el UUID de la raíz ajena (frontera de agregado: sin
// asociación navegable), así que el <Raíz>RefDto no se puede derivar desde la
// entidad y el mapper lo recibe por parámetro. Quien lo produce es este
// resolver, y lo hace POR LOTE: una consulta por agregado referenciado, sea cual
// sea el tamaño de la página. Sin él, el camino de menor resistencia para el
// agente es un findById por elemento — 100 productos con dos embeds son 201
// consultas.
//
// El criterio completo (cuándo basta el lote y cuándo hace falta un join
// proyectado) está en conventions/read-composition.md.

import { javaFile, javaPath, subPackage } from './render.js';
import { domainSubPackage, capitalize } from './entities.js';
import { ANNOTATIONS_PKG } from './mediator.js';

const SUPPORT_PKG = 'application.support';
const PORT_PKG = 'domain.repository';
const MAPPER_PKG = 'application.mappers';
const DTO_PKG = 'application.dtos';

// Entidades que algún payload embebe: son las que necesitan resolver y lectura
// por lote en su puerto. `model.refDtos` ya las recoge de los responseDto y de
// los DTO de entidad hija (src/lib/model.js, collectRefDtos).
export function refTargets(model) {
  const targets = [];
  for (const ref of model.refDtos ?? []) {
    const entity = model.entities.find((e) => e.name === ref.entity);
    // Sin persistencia no hay puerto que consultar; crossrefs ya garantiza que
    // el destino de un embed es raíz de agregado.
    if (!entity?.persisted || !entity.isAggregateRoot || !entity.idField) continue;
    targets.push({ ref, entity });
  }
  return targets;
}

export function isRefTarget(model, entityName) {
  return refTargets(model).some((target) => target.entity.name === entityName);
}

// Resolvers que necesita una operación: las entidades embebidas por su
// responseDto, incluidas las que embeben los DTO de sus entidades hijas.
export function refTargetsOf(model, operation) {
  const dto = operation.responseDto;
  if (!dto) return [];

  const byEntity = new Map((model.childDtos ?? []).map((child) => [child.entity, child]));
  const found = new Set();
  const seenChildren = new Set();
  const pending = [dto];

  while (pending.length > 0) {
    const current = pending.shift();
    for (const field of current.fields ?? []) {
      if (field.kind === 'refDto') found.add(field.refEntity);
      if (field.kind === 'childDto' && !seenChildren.has(field.childEntity)) {
        seenChildren.add(field.childEntity);
        const child = byEntity.get(field.childEntity);
        if (child) pending.push(child);
      }
    }
  }
  return refTargets(model).filter((target) => found.has(target.entity.name));
}

export function generate(model) {
  if (!model.layersPresent.persistence) return [];
  return refTargets(model).map(({ ref, entity }) => renderResolver(model, entity, ref));
}

function renderResolver(model, entity, ref) {
  // UUID, no entity.idField.javaType: el puerto y el JpaRepository que genera
  // repositories.js ya tipan el id así en todas las raíces, y el resolver tiene
  // que casar con findAllById/findById.
  const idType = 'UUID';
  const idGetter = `get${capitalize(entity.idField.name)}`;
  const repositoryField = lowerFirst(`${entity.name}Repository`);
  const mapperField = lowerFirst(`${entity.name}ApplicationMapper`);
  const className = `${entity.name}RefResolver`;

  const imports = new Set([
    `${subPackage(model, ANNOTATIONS_PKG)}.ApplicationComponent`,
    `${subPackage(model, domainSubPackage(entity))}.${entity.name}`,
    `${subPackage(model, PORT_PKG)}.${entity.name}Repository`,
    `${subPackage(model, MAPPER_PKG)}.${entity.name}ApplicationMapper`,
    `${subPackage(model, DTO_PKG)}.${ref.name}`,
    'java.util.Collection',
    'java.util.List',
    'java.util.Map',
    'java.util.Objects',
    'java.util.stream.Collectors',
    'java.util.UUID'
  ]);

  const body = `/**
 * Produce el ${ref.name} de las operaciones que embeben ${entity.name} (\`embed\`).
 *
 * <p>Resuelve SIEMPRE por lote: una consulta por agregado referenciado, no una por
 * elemento. Un {@code findById} dentro del stream de una página es un N+1 — ver
 * conventions/read-composition.md.
 *
 * <p>Una referencia que no existe se resuelve a {@code null} (no aparece en el mapa):
 * la integridad la garantiza la FK cuando la relación es obligatoria, y si su ausencia
 * debe ser un error de negocio lo decide el handler con el error del diseño.
 *
 * <p>Sin {@code @Transactional}: la transacción de lectura la abre el UseCaseMediator.
 */
@ApplicationComponent
public class ${className} {

    private final ${entity.name}Repository ${repositoryField};
    private final ${entity.name}ApplicationMapper ${mapperField};

    public ${className}(${entity.name}Repository ${repositoryField}, ${entity.name}ApplicationMapper ${mapperField}) {
        this.${repositoryField} = ${repositoryField};
        this.${mapperField} = ${mapperField};
    }

    /**
     * Resuelve en UNA consulta las referencias de una colección de ids (los ids de
     * una página completa). Indexa por id: el orden de \`findAllById\` no importa.
     */
    public Map<${idType}, ${ref.name}> resolve(Collection<${idType}> ids) {
        List<${idType}> distinct = ids.stream().filter(Objects::nonNull).distinct().toList();
        if (distinct.isEmpty()) {
            return Map.of();
        }
        return ${repositoryField}.findAllById(distinct).stream()
                .collect(Collectors.toMap(${entity.name}::${idGetter}, ${mapperField}::to${ref.name}));
    }

    /** Resuelve una sola referencia, para las operaciones que devuelven un elemento. */
    public ${ref.name} resolve(${idType} id) {
        if (id == null) {
            return null;
        }
        return ${repositoryField}.findById(id).map(${mapperField}::to${ref.name}).orElse(null);
    }
}`;

  return {
    path: javaPath(model, SUPPORT_PKG, className),
    content: javaFile(subPackage(model, SUPPORT_PKG), [...imports], body)
  };
}

function lowerFirst(name) {
  return name[0].toLowerCase() + name.slice(1);
}
