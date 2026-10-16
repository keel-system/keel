// La resolución de las referencias embebidas (`embed`) de un payload: el `<Raíz>RefResolver` de keel-spring y keel-nest.
//
// Un agregado solo guarda el id de la raíz ajena (frontera de agregado), así que el `<Raíz>RefDto` no se deriva de la
// entidad y el mapper lo recibe por parámetro. Quien lo produce es este resolver, y lo hace POR LOTE: una consulta por raíz
// referenciada, sea cual sea el tamaño de la página. keel-dotnet emitía la RefDto y su mapper pero no esto, y el agente de
// la corrida asset-vault escribió la lectura a mano (`FindAllByIdIn` en el puerto, el adaptador y el handler), como las
// primeras corridas de keel-nest. Qué raíces se resuelven lo decide keel-core (`refTargets`).

import { refTargets } from 'keel-core/gen/ref-targets';
import { csFile, csLocal, located, namespaceOf, entityPlace } from './render.js';
import { portClass, repositoriesNamespace } from './repositories.js';
import { usesPersistence } from './persistence.js';

export function resolverClass(entity) {
  return `${entity.name}RefResolver`;
}

/** Los resolvers que registra UseCaseRegistration (con persistencia: sin ella no hay puerto que consultar). */
export function resolverClasses(model) {
  if (!usesPersistence(model)) return [];
  return refTargets(model).map(({ entity }) => resolverClass(entity));
}

export function generate(model) {
  if (!usesPersistence(model)) return [];
  return refTargets(model).map(({ ref, entity }) => renderResolver(model, entity, ref));
}

function renderResolver(model, entity, ref) {
  const { namespace, path } = located(model, 'appSupport', resolverClass(entity));
  const idType = entity.idField?.csType ?? 'Guid';
  const port = portClass(entity);
  const mapper = `${entity.name}ApplicationMapper`;
  const usings = [namespaceOf(model, entityPlace(entity)), repositoriesNamespace(model), namespaceOf(model, 'mappers'), namespaceOf(model, 'dtos')];
  const idName = csLocal(entity.idField?.name ?? 'id');
  const body = `/// <summary>
/// Produce el ${ref.name} de las operaciones que embeben ${entity.name} (<c>embed</c>). Resuelve SIEMPRE por lote: una consulta
/// por raíz referenciada, no una por elemento —un FindById dentro del bucle de una página es un N+1—. Una referencia que no
/// existe no aparece en el diccionario: si su ausencia es un error de negocio lo decide el handler con el error del diseño.
/// La transacción de lectura la abre el UseCaseMediator.
/// </summary>
public sealed class ${resolverClass(entity)}(${port} repository, ${mapper} mapper)
{
    private readonly ${port} repository = repository;
    private readonly ${mapper} mapper = mapper;

    /// <summary>Las referencias de los ids de una página entera, en UNA consulta, indexadas por id (el orden no importa).</summary>
    public async Task<IReadOnlyDictionary<${idType}, ${ref.name}>> ResolveAll(IEnumerable<${idType}?> ids, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(ids);
        var distinct = ids.OfType<${idType}>().Distinct().ToList();
        if (distinct.Count == 0)
        {
            return new Dictionary<${idType}, ${ref.name}>();
        }
        var found = await repository.FindAllById(distinct, cancellationToken);
        return found.ToDictionary(root => root.Id, mapper.To${ref.name});
    }

    /// <summary>Una sola referencia, para las operaciones que devuelven un elemento; null si no existe.</summary>
    public async Task<${ref.name}?> Resolve(${idType}? ${idName}, CancellationToken cancellationToken = default)
    {
        if (${idName} is not { } value)
        {
            return null;
        }
        var found = await repository.FindById(value, cancellationToken);
        return found is null ? null : mapper.To${ref.name}(found);
    }
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}
