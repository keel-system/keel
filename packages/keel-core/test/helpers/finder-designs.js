// Los diseños DERIVADOS con los que se miden los finders de las búsquedas (DSL 2.22) en las formas que la fixture
// catalog-extended no declara: una LISTA con un subcampo de value object y el texto por prefijo, en relacional; y en
// documental, la lista y la página con enum, rango exclusivo y texto sin plegar. Los comparten los generadores, para
// que sus db-check y doc-check midan los MISMOS diseños: keel-dotnet los recorre como variantes (UNCOVERED_BRANCHES)
// y keel-nest como sujetos derivados.

// La búsqueda de 2.32 (`in`, `ne`, `search` y `sortable`) sobre el Product de product-catalog, en los dos modelos: la
// query `searchCatalog` es la de los casos FS-* (gen/query-filters.js) y SO-* (gen/pagination.js).
function withSearch(layers, model) {
  layers.persistence.default = { ...layers.persistence.default, model };
  layers['use-cases'].operations.searchCatalog = {
    description: 'Busca productos por estados, por notas distintas de un texto y por un texto libre en el nombre o las notas.',
    kind: 'query',
    input: {
      fields: {
        statuses: { type: 'ProductStatus', list: true, filter: { field: 'status', op: 'in' } },
        notNotes: { type: 'text', filter: { field: 'notes', op: 'ne' } },
        q: { type: 'string', constraints: { maxLength: 120 }, search: { over: ['name', 'notes'], match: 'contains', compare: 'ignore-case-accents' } }
      }
    },
    output: { entity: 'Product', paginated: true, sort: ['name:asc'], sortable: ['name', 'sku', 'price.amount'], exclude: ['apiToken'] }
  };
  layers.api.endpoints.searchCatalog = { method: 'GET', path: '/products/search' };
}

export const FINDER_DESIGNS = [
  {
    name: 'product-catalog-finder',
    from: 'product-catalog',
    mutate(layers) {
      layers['use-cases'].operations.listActiveProducts = {
        description: 'Lista los productos activos por nombre y precio mínimo, para la tienda.',
        kind: 'query',
        input: {
          fields: {
            name: { type: 'string', constraints: { maxLength: 120 }, match: 'prefix', compare: 'ignore-case-accents' },
            minPrice: { type: 'decimal', constraints: { scale: 2, scalePolicy: 'reject' }, filter: { field: 'price.amount', op: 'gte' } }
          }
        },
        where: { status: 'active' },
        output: { entity: 'Product', list: true, sort: ['name:asc'], exclude: ['apiToken'] }
      };
      // Y una PÁGINA con un enum por nombre y un rango exclusivo sobre un subcampo: la otra forma del resultado.
      layers['use-cases'].operations.searchProducts = {
        description: 'Busca productos por estado y precio máximo, paginados.',
        kind: 'query',
        input: {
          fields: {
            status: { type: 'ProductStatus' },
            belowPrice: { type: 'decimal', constraints: { scale: 2, scalePolicy: 'reject' }, filter: { field: 'price.amount', op: 'lt' } }
          }
        },
        output: { entity: 'Product', paginated: true, sort: ['name:asc'], exclude: ['apiToken'] }
      };
    }
  },
  {
    name: 'jobs-mongo-finder',
    from: 'job-dispatch-mongo',
    mutate(layers) {
      Object.assign(layers['use-cases'].operations, {
        listQueuedJobs: {
          description: 'Lista los trabajos en cola por referencia, prioridad y fecha de alta.',
          kind: 'query',
          input: {
            fields: {
              reference: { type: 'string', constraints: { maxLength: 64 }, match: 'prefix', compare: 'ignore-case' },
              priority: { type: 'JobPriority' },
              createdFrom: { type: 'timestamp', filter: { field: 'createdAt', op: 'gte' } },
              createdBefore: { type: 'timestamp', filter: { field: 'createdAt', op: 'lt' } }
            }
          },
          where: { status: 'queued' },
          output: { entity: 'Job', list: true, sort: ['createdAt:desc'] }
        },
        searchJobs: {
          description: 'Busca trabajos por un trozo de su cuerpo, paginados.',
          kind: 'query',
          input: { fields: { payload: { type: 'text', match: 'contains' } } },
          output: { entity: 'Job', paginated: true, sort: ['createdAt:asc'] }
        }
      });
    }
  }
];

/**
 * Los sujetos de la búsqueda de 2.32, aparte de FINDER_DESIGNS porque la frontera de cada generador los rechaza hasta
 * su incremento (B3-B6 de PLAN-DSL-231-232): cada uno los suma a sus redes al quitarla.
 */
export const SEARCH_DESIGNS = [
  { name: 'catalog-search', from: 'product-catalog', mutate: (layers) => withSearch(layers, 'relational') },
  { name: 'catalog-search-mongo', from: 'product-catalog', mutate: (layers) => withSearch(layers, 'document') }
];
