// Los diseños DERIVADOS con los que se miden los finders de las búsquedas (DSL 2.22) en las formas que la fixture
// catalog-extended no declara: una LISTA con un subcampo de value object y el texto por prefijo, en relacional; y en
// documental, la lista y la página con enum, rango exclusivo y texto sin plegar. Los comparten los generadores, para
// que sus db-check y doc-check midan los MISMOS diseños: keel-dotnet los recorre como variantes (UNCOVERED_BRANCHES)
// y keel-nest como sujetos derivados.

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
