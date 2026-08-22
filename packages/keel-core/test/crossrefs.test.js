import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCrossRefs } from '../src/lib/crossrefs.js';

const entity = (fields = {}, extra = {}) => ({
  fields: { id: { type: 'uuid', id: true, generated: true }, ...fields },
  ...extra,
});

const baseDomain = () => ({
  entities: {
    Order: entity({}, { relations: { lines: { entity: 'OrderLine', cardinality: 'one-to-many' } } }),
    OrderLine: entity(),
    Catalog: entity({}, { relations: { products: { entity: 'Product', cardinality: 'one-to-many' } } }),
    Product: entity(),
  },
  aggregates: {
    Order: { root: 'Order', entities: ['OrderLine'] },
    Catalog: { root: 'Catalog', entities: ['Product'] },
  },
});

const run = (layers, wip = false) => checkCrossRefs({ layers, wip });

// Varios fixtures de abajo declaran salidas de varios elementos sin `sort` porque lo
// que miden es otra cosa (paginación, proyección de referencias, listas en el input).
// Desde que existe el aviso de orden no declarado emiten uno legítimo y ajeno a su
// asunto. Se filtra aquí en vez de meter un `sort` de relleno en cada fixture: el
// relleno cambiaría lo que el test ejercita, el filtro no. Lo que NO se hace es relajar
// la aserción a `some(...)`: el resto de la lista se sigue comprobando entera, que es
// lo que convierte a estos tests en detectores de avisos nuevos e inesperados.
const otherThanSortNotice = (warnings) => warnings.filter((w) => !w.includes("no declara 'sort'"));

test('agregados bien formados no producen errores ni warnings', () => {
  const { errors, warnings } = run({ domain: baseDomain(), 'use-cases': {} });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('spec sin aggregates sigue validando limpio (retrocompatibilidad)', () => {
  const domain = baseDomain();
  delete domain.aggregates;
  const { errors, warnings } = run({ domain, 'use-cases': {} });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('raíz inexistente es error', () => {
  const domain = baseDomain();
  domain.aggregates.Order.root = 'Pedido';
  const { errors } = run({ domain, 'use-cases': {} });
  assert.ok(errors.some((e) => e.includes(`aggregates.Order.root: la entidad 'Pedido' no existe`)));
});

test('entidad interna inexistente es error', () => {
  const domain = baseDomain();
  domain.aggregates.Order.entities = ['Linea'];
  const { errors } = run({ domain, 'use-cases': {} });
  assert.ok(errors.some((e) => e.includes(`aggregates.Order.entities: la entidad 'Linea' no existe`)));
});

test('entidad en dos agregados es error', () => {
  const domain = baseDomain();
  domain.aggregates.Catalog.entities = ['Product', 'OrderLine'];
  const { errors } = run({ domain, 'use-cases': {} });
  assert.ok(errors.some((e) => e.includes(`la entidad 'OrderLine' pertenece a más de un agregado`)));
});

test('raíz repetida en su propio entities es error', () => {
  const domain = baseDomain();
  domain.aggregates.Order.entities = ['Order', 'OrderLine'];
  const { errors } = run({ domain, 'use-cases': {} });
  assert.ok(errors.some((e) => e.includes(`la raíz 'Order' es miembro implícito`)));
});

test('entidad fuera de todo agregado es warning', () => {
  const domain = baseDomain();
  delete domain.aggregates.Catalog;
  domain.entities.Catalog.relations = {};
  const { errors, warnings } = run({ domain, 'use-cases': {} });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes(`la entidad 'Catalog' no pertenece a ningún agregado`)));
  assert.ok(warnings.some((w) => w.includes(`la entidad 'Product' no pertenece a ningún agregado`)));
});

test('relación hacia entidad interna de otro agregado es warning', () => {
  const domain = baseDomain();
  domain.entities.Order.relations.line = { entity: 'Product', cardinality: 'many-to-one' };
  const { warnings } = run({ domain, 'use-cases': {} });
  assert.ok(
    warnings.some((w) =>
      w.includes(`Order.relations.line: apunta a 'Product', entidad interna del agregado 'Catalog'`)
    )
  );
});

test('relación hacia la raíz de otro agregado no avisa', () => {
  const domain = baseDomain();
  domain.entities.Product.relations = { catalog: { entity: 'Catalog', cardinality: 'many-to-one' } };
  const { warnings } = run({ domain, 'use-cases': {} });
  assert.deepEqual(warnings, []);
});

test('per-aggregate sin aggregates declarados es error, incluso con --wip', () => {
  const domain = baseDomain();
  delete domain.aggregates;
  const layers = {
    domain,
    'use-cases': {},
    persistence: { default: { model: 'relational' }, entities: { Order: {} }, consistency: { transactionalBoundary: 'per-aggregate' } },
  };
  for (const wip of [false, true]) {
    const { errors } = run(layers, wip);
    assert.ok(errors.some((e) => e.includes(`'per-aggregate' exige que domain declare aggregates`)), `wip=${wip}`);
  }
});

test('per-aggregate con aggregates declarados es válido', () => {
  const layers = {
    domain: baseDomain(),
    'use-cases': {},
    persistence: { default: { model: 'relational' }, entities: { Order: {} }, consistency: { transactionalBoundary: 'per-aggregate' } },
  };
  const { errors } = run(layers);
  assert.deepEqual(errors, []);
});

// --- persistence: consistency.optimisticLocking ---

const withLocking = (policy, domain = baseDomain()) => ({
  domain,
  'use-cases': {},
  persistence: { default: { model: 'relational' }, entities: { Order: {} }, consistency: { optimisticLocking: policy } },
});

test("optimisticLocking 'declared' sin ninguna raíz que declare lockVersion avisa: equivale a none", () => {
  const { errors, warnings } = run(withLocking('declared'));
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes("optimisticLocking: 'declared'") && w.includes('lockVersion')));
});

test("optimisticLocking 'declared' con una raíz que declara lockVersion valida limpio", () => {
  const domain = baseDomain();
  domain.entities.Order.fields.lockVersion = { type: 'integer' };
  const { errors, warnings } = run(withLocking('declared', domain));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("optimisticLocking 'all' y 'none' no exigen nada del dominio", () => {
  for (const policy of ['all', 'none']) {
    const { errors, warnings } = run(withLocking(policy));
    assert.deepEqual(errors, [], policy);
    assert.deepEqual(warnings, [], policy);
  }
});

// --- persistence: audit ---

const withAudit = (audit, domain = baseDomain(), extra = {}) => ({
  domain,
  'use-cases': {},
  persistence: { default: { model: 'relational' }, entities: { Order: {} }, audit },
  ...extra,
});

const securityLayer = { authentication: { protocol: 'oidc' }, access: { default: { level: 'authenticated' } } };

test('sin bloque audit los defectos (timestamps all, authorship none) validan limpio', () => {
  const { errors, warnings } = run(withAudit(undefined));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("audit.timestamps 'declared' con los campos reservados en domain valida limpio", () => {
  const domain = baseDomain();
  domain.entities.Order.fields.createdAt = { type: 'timestamp', generated: true };
  domain.entities.Order.fields.updatedAt = { type: 'timestamp', generated: true };
  const { errors, warnings } = run(withAudit({ timestamps: 'declared' }, domain));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("audit.timestamps 'declared' sin ningún campo declarado es error", () => {
  const { errors } = run(withAudit({ timestamps: 'declared' }));
  assert.ok(errors.some((e) => e.includes("audit.timestamps: 'declared'") && e.includes('createdAt/updatedAt')));
});

test("declarar un campo reservado bajo 'all' o 'none' es error", () => {
  for (const policy of ['all', 'none']) {
    const domain = baseDomain();
    domain.entities.Order.fields.createdAt = { type: 'timestamp', generated: true };
    const { errors } = run(withAudit({ timestamps: policy }, domain));
    assert.ok(
      errors.some((e) => e.includes(`audit.timestamps: '${policy}'`) && e.includes('Order.createdAt')),
      policy
    );
  }
});

test('campo reservado de auditoría sin generated es error (el cliente podría enviarlo)', () => {
  const domain = baseDomain();
  domain.entities.Order.fields.createdAt = { type: 'timestamp' };
  const { errors } = run(withAudit({ timestamps: 'declared' }, domain));
  assert.ok(errors.some((e) => e.includes('Order.fields.createdAt') && e.includes("generated: true")));
});

test('campo reservado de auditoría con el tipo equivocado es error', () => {
  const domain = baseDomain();
  domain.entities.Order.fields.createdBy = { type: 'uuid', generated: true };
  const { errors } = run(withAudit({ authorship: 'declared' }, domain), false);
  assert.ok(errors.some((e) => e.includes('Order.fields.createdBy') && e.includes("exige 'string'")));
});

test("audit.authorship 'declared' con capa security valida limpio", () => {
  const domain = baseDomain();
  domain.entities.Order.fields.createdBy = { type: 'string', generated: true };
  domain.entities.Order.fields.updatedBy = { type: 'string', generated: true };
  const { errors, warnings } = run(withAudit({ authorship: 'declared' }, domain, { security: securityLayer }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('autoría sin capa security es error: no hay actor que registrar', () => {
  for (const policy of ['all', 'declared']) {
    const domain = baseDomain();
    if (policy === 'declared') domain.entities.Order.fields.createdBy = { type: 'string', generated: true };
    const { errors } = run(withAudit({ authorship: policy }, domain));
    assert.ok(errors.some((e) => e.includes('audit.authorship') && e.includes('capa security')), policy);
  }
});

test("audit.authorship 'all' con security no exige nada del dominio", () => {
  const { errors, warnings } = run(withAudit({ authorship: 'all' }, baseDomain(), { security: securityLayer }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('sin capa persistence las reglas de auditoría no aplican', () => {
  const domain = baseDomain();
  domain.entities.Order.fields.createdBy = { type: 'string' };
  const { errors, warnings } = run({ domain, 'use-cases': {} });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

// --- persistence: miembros de naturalKey e indexes → domain ---

// Order tiene un campo escalar, un value object compuesto (total → Money) y una hija;
// OrderLine apunta de vuelta a Order, que es la relación que se indexa.
const domainForPersistenceMembers = () => ({
  types: { Money: { fields: { amount: { type: 'decimal' }, currency: { type: 'string' } } } },
  entities: {
    Order: entity(
      { code: { type: 'string' }, total: { type: 'Money' } },
      { relations: { lines: { entity: 'OrderLine', cardinality: 'one-to-many' } } }
    ),
    OrderLine: entity(
      { position: { type: 'int' } },
      { relations: { order: { entity: 'Order', cardinality: 'many-to-one' } } }
    ),
    // Otro agregado: de él, Order solo guarda el id. Ningún índice lo alcanza.
    Customer: entity({ email: { type: 'string' } }),
  },
  aggregates: { Order: { root: 'Order', entities: ['OrderLine'] } },
});

const persistenceMembers = (entities, model = 'relational') => ({
  domain: domainForPersistenceMembers(),
  'use-cases': {},
  persistence: { default: { model }, entities },
});

test('naturalKey e indexes sobre campos y value objects válidos no producen errores', () => {
  const { errors } = run(
    persistenceMembers({
      Order: { naturalKey: ['code'], indexes: [['code'], ['total.amount']] },
      OrderLine: { indexes: [['position']] },
    })
  );
  assert.deepEqual(errors, []);
});

test('una relación se admite por su nombre y con el sufijo Id indistintamente', () => {
  for (const member of ['order', 'orderId']) {
    const { errors } = run(persistenceMembers({ OrderLine: { indexes: [[member, 'position']] } }));
    assert.deepEqual(errors, [], `miembro '${member}'`);
  }
});

test('un miembro de indexes que no existe en la entidad es error', () => {
  const { errors } = run(persistenceMembers({ OrderLine: { indexes: [['postion']] } }));
  assert.ok(
    errors.some((e) => e.includes(`entities.OrderLine.indexes: 'postion' no es un campo ni una relación`)),
    errors.join('\n')
  );
});

test('un miembro de naturalKey que no existe en la entidad es error', () => {
  const { errors } = run(persistenceMembers({ Order: { naturalKey: ['slug'] } }));
  assert.ok(
    errors.some((e) => e.includes(`entities.Order.naturalKey: 'slug' no es un campo ni una relación`)),
    errors.join('\n')
  );
});

// Indexar por un campo de una entidad hija solo tiene sentido con `model: document`:
// ahí la hija va anidada dentro del documento de su raíz, así que es una ruta real
// del mismo registro. En el relacional vive en otra tabla y ningún índice la alcanza.
test('un dot-path a una entidad hija es válido con model: document', () => {
  const { errors } = run(persistenceMembers({ Order: { indexes: [['lines.position']] } }, 'document'));
  assert.deepEqual(errors, []);
});

test('el mismo dot-path a una entidad hija es error con model: relational', () => {
  const { errors } = run(persistenceMembers({ Order: { indexes: [['lines.position']] } }));
  assert.ok(
    errors.some((e) => e.includes("'lines.position': 'lines' es una relación")),
    errors.join('\n')
  );
});

test('ni siquiera con document se indexa por un campo de OTRO agregado', () => {
  // La frontera del agregado no la mueve el motor: de un agregado ajeno solo se
  // guarda su id, esté en una columna o en un campo del documento.
  const domain = domainForPersistenceMembers();
  domain.entities.Order.relations.customer = { entity: 'Customer', cardinality: 'many-to-one' };
  const { errors } = run({
    domain,
    'use-cases': {},
    persistence: { default: { model: 'document' }, entities: { Order: { indexes: [['customer.email']] } } },
  });
  assert.ok(
    errors.some((e) => e.includes("'customer.email': 'Customer' es otro agregado")),
    errors.join('\n')
  );
});

test('un dot-path a un campo que la entidad hija no declara es error', () => {
  const { errors } = run(persistenceMembers({ Order: { indexes: [['lines.postion']] } }, 'document'));
  assert.ok(
    errors.some((e) => e.includes("la entidad 'OrderLine' no declara el campo 'postion'")),
    errors.join('\n')
  );
});

test('un dot-path sobre un campo que no es value type compuesto es error', () => {
  const { errors } = run(persistenceMembers({ Order: { indexes: [['code.amount']] } }));
  assert.ok(
    errors.some((e) => e.includes(`'code.amount': 'code' no es un value type compuesto`)),
    errors.join('\n')
  );
});

test('un subcampo inexistente del value object es error', () => {
  const { errors } = run(persistenceMembers({ Order: { indexes: [['total.importe']] } }));
  assert.ok(
    errors.some((e) => e.includes(`el tipo 'Money' no declara el campo 'importe'`)),
    errors.join('\n')
  );
});

// --- persistence: natural key sobre un campo recalculado de una entidad hija ---

const computedNaturalKey = (entityName, naturalKey) => {
  const layers = persistenceMembers({ [entityName]: { naturalKey } });
  layers.domain.entities.OrderLine.fields.position.computed =
    'Es la última posición libre al añadir; se recompacta al borrar.';
  layers.domain.entities.Order.fields.code.computed = 'Se deriva del identificador.';
  return layers;
};

test('naturalKey sobre un campo computed de una entidad hija es aviso', () => {
  const { errors, warnings } = run(computedNaturalKey('OrderLine', ['order', 'position']));
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes(
        `persistence: entities.OrderLine.naturalKey: 'position' es un campo computed de una entidad interna del agregado 'Order'`
      )
    ),
    warnings.join('\n')
  );
});

test('naturalKey sobre un campo computed de la raíz no avisa', () => {
  // La raíz no se reparte entre filas hermanas: no hay estado intermedio colisionante.
  const { warnings } = run(computedNaturalKey('Order', ['code']));
  assert.ok(!warnings.some((w) => w.includes('es un campo computed')), warnings.join('\n'));
});

test('naturalKey sobre un campo no computed de una entidad hija no avisa', () => {
  const { warnings } = run(persistenceMembers({ OrderLine: { naturalKey: ['order', 'position'] } }));
  assert.ok(!warnings.some((w) => w.includes('es un campo computed')), warnings.join('\n'));
});

// --- use-cases: exclude con dot-path (proyección de entidades hijas) ---

// Dominio con relación a hija en el mismo agregado (Order → lines → OrderLine), un campo
// escalar en la hija (costPrice) y un value object compuesto embebido (address → Address).
const domainForExclude = () => ({
  types: {
    Address: { fields: { zip: { type: 'string' }, city: { type: 'string' } } },
  },
  entities: {
    Order: entity(
      { internalNote: { type: 'string' }, address: { type: 'Address' } },
      { relations: { lines: { entity: 'OrderLine', cardinality: 'one-to-many' } } }
    ),
    OrderLine: entity({ costPrice: { type: 'decimal' }, quantity: { type: 'int' } }),
  },
  aggregates: { Order: { root: 'Order', entities: ['OrderLine'] } },
});

const excludeLayers = (exclude) => ({
  domain: domainForExclude(),
  'use-cases': {
    operations: {
      getOrder: {
        description: 'Recupera un pedido por su id.',
        kind: 'query',
        internal: true,
        input: { entity: 'Order' },
        output: { entity: 'Order', exclude },
      },
    },
  },
});

test('exclude plano de un campo existente es válido (retrocompatibilidad)', () => {
  const { errors, warnings } = run(excludeLayers(['internalNote']));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('exclude con dot-path hacia un campo de la entidad hija es válido', () => {
  const { errors, warnings } = run(excludeLayers(['lines.costPrice']));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('exclude con dot-path hacia un campo de un value object es válido', () => {
  const { errors, warnings } = run(excludeLayers(['address.zip']));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('exclude de un campo terminal inexistente en la hija es error', () => {
  const { errors } = run(excludeLayers(['lines.nope']));
  assert.ok(
    errors.some((e) =>
      e.includes(`use-cases: getOrder.output.exclude 'lines.nope': el campo 'nope' no existe en la entidad 'OrderLine'`)
    )
  );
});

test('exclude cuyo segmento intermedio no es relación ni value object es error', () => {
  const { errors } = run(excludeLayers(['internalNote.foo']));
  assert.ok(
    errors.some((e) =>
      e.includes(
        `use-cases: getOrder.output.exclude 'internalNote.foo': el campo 'internalNote' de la entidad 'Order' no es una relación ni un value object anidable`
      )
    )
  );
});

test('exclude con dot-path que cruza a otro agregado es warning', () => {
  const domain = domainForExclude();
  // Segundo agregado con su raíz, alcanzable desde OrderLine por relación.
  domain.entities.Product = entity({ costPrice: { type: 'decimal' } });
  domain.entities.OrderLine.relations = { product: { entity: 'Product', cardinality: 'many-to-one' } };
  domain.aggregates.Catalog = { root: 'Product' };
  const layers = {
    domain,
    'use-cases': {
      operations: {
        getOrder: {
          description: 'Recupera un pedido por su id.',
          kind: 'query',
          internal: true,
          input: { entity: 'Order' },
          output: { entity: 'Order', exclude: ['lines.product.costPrice'] },
        },
      },
    },
  };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes(`la relación 'product' apunta al agregado 'Catalog', que se serializa por id`)
    )
  );
});

// --- use-cases: embed (referencia a otro agregado proyectada como objeto) ---

// Order (agregado propio) → customer, la raíz de otro agregado; y lines, hija
// del propio agregado.
const domainForEmbed = () => ({
  entities: {
    Order: entity(
      {},
      {
        relations: {
          lines: { entity: 'OrderLine', cardinality: 'one-to-many' },
          customer: { entity: 'Customer', cardinality: 'many-to-one' },
        },
      }
    ),
    OrderLine: entity(),
    Customer: entity({ name: { type: 'string' } }, { relations: { referrer: { entity: 'Customer', cardinality: 'many-to-one' } } }),
  },
  aggregates: {
    Order: { root: 'Order', entities: ['OrderLine'] },
    Customer: { root: 'Customer' },
  },
});

test('embeber una entidad que no figura en ningún agregado es válido (es su propio agregado)', () => {
  const domain = domainForEmbed();
  delete domain.aggregates.Customer; // Customer queda fuera de todo agregado declarado
  const layers = {
    domain,
    'use-cases': {
      operations: {
        getOrder: {
          kind: 'query',
          internal: true,
          input: { entity: 'Order' },
          output: { entity: 'Order', embed: ['customer'] },
        },
      },
    },
  };
  const { errors } = run(layers);
  assert.deepEqual(errors, []);
});

const embedLayers = (embed, { direction = 'output' } = {}) => ({
  domain: domainForEmbed(),
  'use-cases': {
    operations: {
      getOrder: {
        description: 'Recupera un pedido por su id.',
        kind: 'query',
        internal: true,
        input: direction === 'input' ? { entity: 'Order', embed } : { entity: 'Order' },
        output: direction === 'output' ? { entity: 'Order', embed } : { entity: 'Order' },
      },
    },
  },
});

test('embed de una relación hacia la raíz de otro agregado es válido', () => {
  const { errors, warnings } = run(embedLayers(['customer']));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('embed de una auto-referencia es válido: apunta a otra instancia, su propio agregado', () => {
  const layers = embedLayers([]);
  layers['use-cases'].operations.getCustomer = {
    description: 'Recupera un cliente por su id.',
    kind: 'query',
    internal: true,
    input: { entity: 'Customer' },
    output: { entity: 'Customer', embed: ['referrer'] },
  };
  const { errors } = run(layers);
  assert.deepEqual(errors, []);
});

test('embed de una relación inexistente es error', () => {
  const { errors } = run(embedLayers(['nope']));
  assert.ok(errors.some((e) => e.includes(`getOrder.output.embed 'nope': la entidad 'Order' no declara esa relación`)));
});

test('embed de una entidad hija del propio agregado es error: ya se proyecta anidada', () => {
  const { errors } = run(embedLayers(['lines']));
  assert.ok(errors.some((e) => e.includes(`getOrder.output.embed 'lines': 'OrderLine' es una entidad interna del agregado 'Order'`)));
});

test('embed de una relación to-many hacia otro agregado es error', () => {
  const layers = embedLayers(['customer']);
  layers.domain.entities.Order.relations.customer.cardinality = 'one-to-many';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`solo se pueden embeber relaciones many-to-one/one-to-one`)));
});

test('embed en el input es error: en la entrada la referencia viaja por id', () => {
  const { errors } = run(embedLayers(['customer'], { direction: 'input' }));
  assert.ok(errors.some((e) => e.includes(`getOrder.input.embed 'customer': embed solo aplica al output`)));
});

// --- storage: campos file ↔ buckets ---

const domainWithFile = (bucket = 'productImages') => ({
  entities: { Product: entity({ photo: { type: 'file', bucket } }) },
});

const storageLayer = (...bucketNames) => ({
  // `signedUrlTtlSeconds` porque estos buckets son privados por default: sin él, el
  // aviso de «la URL firmada caduca y el diseño no dice cuándo» ensucia toda fixture
  // que solo quiera hablar de otra cosa.
  buckets: Object.fromEntries(
    bucketNames.map((name) => [name, { allowedContentTypes: ['image/png'], signedUrlTtlSeconds: 900 }])
  ),
});

test('bucket privado sin caducidad de URL firmada es aviso', () => {
  // `private` significa que la lectura pasa por una firma que caduca, y esa caducidad
  // es contrato con quien recibe el enlace. Sin declararla la elige quien construya y
  // no queda en el diseño: así es como un enlace pensado para minutos acaba durando
  // días sin que nadie lo haya decidido.
  const storage = storageLayer('productImages');
  delete storage.buckets.productImages.signedUrlTtlSeconds;
  const layers = { domain: domainWithFile('productImages'), 'use-cases': {}, storage };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes("buckets.productImages: es private y no declara 'signedUrlTtlSeconds'")), warnings.join(' | '));
});

test('bucket público no reclama caducidad de URL firmada', () => {
  // No hay firma que caducar: exigirla ahí sería pedir una decisión sobre un mecanismo
  // que ese bucket no usa.
  const storage = storageLayer('productImages');
  delete storage.buckets.productImages.signedUrlTtlSeconds;
  storage.buckets.productImages.visibility = 'public';
  const layers = { domain: domainWithFile('productImages'), 'use-cases': {}, storage };
  const { warnings } = run(layers);
  assert.ok(!warnings.some((w) => w.includes('signedUrlTtlSeconds')), warnings.join(' | '));
});

test('campo file cuyo bucket existe en storage no produce errores ni warnings', () => {
  const layers = { domain: domainWithFile('productImages'), 'use-cases': {}, storage: storageLayer('productImages') };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('campo file con bucket inexistente en storage es error', () => {
  const layers = { domain: domainWithFile('otroBucket'), 'use-cases': {}, storage: storageLayer('productImages') };
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`Product.fields.photo: el bucket 'otroBucket' no está en storage: buckets`)));
});

test('campo file sin capa storage es error (sin --wip)', () => {
  const layers = { domain: domainWithFile('productImages'), 'use-cases': {} };
  const { errors, pending } = run(layers, false);
  assert.ok(errors.some((e) => e.includes(`el bucket 'productImages' no está en storage: buckets (no hay capa storage)`)));
  assert.deepEqual(pending, []);
});

test('campo file sin capa storage con --wip va a pending, no a errors', () => {
  const layers = { domain: domainWithFile('productImages'), 'use-cases': {} };
  const { errors, pending } = run(layers, true);
  assert.deepEqual(errors, []);
  assert.ok(pending.some((p) => p.includes(`el bucket 'productImages' está pendiente de definir en storage`)));
});

test('bucket declarado sin ningún campo file que lo referencie es warning', () => {
  const layers = { domain: domainWithFile('productImages'), 'use-cases': {}, storage: storageLayer('productImages', 'invoices') };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes(`storage: buckets.invoices: bucket declarado pero sin ningún campo file`)));
});

// --- messaging: canales ↔ eventos/suscripciones ---

const domainForMessaging = () => ({ entities: { Product: entity() } });
const useCasesForMessaging = () => ({
  operations: { retireProduct: { kind: 'command', emits: ['ProductRetired'] } },
});

test('evento y suscripción cuyo canal existe en channels no produce errores ni warnings', () => {
  const layers = {
    domain: domainForMessaging(),
    'use-cases': useCasesForMessaging(),
    messaging: {
      channels: { productEvents: {}, inventoryEvents: {} },
      publishing: { events: { ProductRetired: { channel: 'productEvents', payload: {} } } },
      subscriptions: {
        StockDepleted: { source: 'inventory-service', channel: 'inventoryEvents', payload: {}, triggers: 'retireProduct' },
      },
    },
  };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('evento con canal inexistente en channels es error', () => {
  const layers = {
    domain: domainForMessaging(),
    'use-cases': useCasesForMessaging(),
    messaging: {
      channels: { productEvents: {} },
      publishing: { events: { ProductRetired: { channel: 'otroCanal', payload: {} } } },
    },
  };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`messaging: publishing.events.ProductRetired.channel: el canal 'otroCanal' no está en messaging: channels`)
    )
  );
});

test('suscripción con canal inexistente en channels es error', () => {
  const layers = {
    domain: domainForMessaging(),
    'use-cases': useCasesForMessaging(),
    messaging: {
      channels: { productEvents: {} },
      subscriptions: {
        StockDepleted: { source: 'inventory-service', channel: 'otroCanal', payload: {}, triggers: 'retireProduct' },
      },
    },
  };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`messaging: subscriptions.StockDepleted.channel: el canal 'otroCanal' no está en messaging: channels`)
    )
  );
});

test('canal declarado sin ningún evento o suscripción que lo referencie es warning', () => {
  const layers = {
    domain: domainForMessaging(),
    'use-cases': useCasesForMessaging(),
    messaging: {
      channels: { productEvents: {}, canalHuerfano: {} },
      publishing: { events: { ProductRetired: { channel: 'productEvents', payload: {} } } },
    },
  };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes(`messaging: channels.canalHuerfano: canal declarado pero sin ningún evento o suscripción que lo referencie`)
    )
  );
});

// --- messaging: contrato de recepción de las suscripciones ---

const useCasesForContract = () => ({
  operations: {
    retireProduct: {
      kind: 'command',
      input: { fields: { productId: { type: 'uuid', required: true }, reason: { type: 'string' } } },
    },
  },
});

const contractLayers = (subOverrides = {}, channelOverrides = {}) => ({
  domain: domainForMessaging(),
  'use-cases': useCasesForContract(),
  messaging: {
    channels: { inventoryEvents: { external: true, ...channelOverrides } },
    subscriptions: {
      StockDepleted: {
        source: 'inventory-service',
        channel: 'inventoryEvents',
        contract: {
          envelope: 'wrapped',
          payloadPath: 'data',
          discriminator: { location: 'header', name: 'eventType', value: 'stock.depleted' },
          messageId: { location: 'header', name: 'messageId' },
        },
        payload: { productId: { type: 'uuid', required: true, wireName: 'product_id' } },
        triggers: 'retireProduct',
        ...subOverrides,
      },
    },
  },
});

test('suscripción con contrato de recepción completo no produce errores ni warnings', () => {
  const { errors, warnings } = run(contractLayers());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('campo requerido del input de triggers que no llega en el payload es error', () => {
  const layers = contractLayers({ payload: { sku: { type: 'string', required: true } } });
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`el campo requerido 'productId' del input de 'retireProduct' no llega en el payload`)
    )
  );
});

test('input mapea el payload aunque los nombres difieran', () => {
  const layers = contractLayers({
    payload: { itemId: { type: 'uuid', required: true } },
    input: { productId: 'itemId' },
  });
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('input que mapea un campo inexistente en el payload es error', () => {
  const layers = contractLayers({ input: { productId: 'itemId' } });
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`subscriptions.StockDepleted.input.productId: el campo 'itemId' no existe en el payload`)
    )
  );
});

test('input que mapea un campo que la operación no declara es error', () => {
  const layers = contractLayers({ input: { productCode: 'productId' } });
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`subscriptions.StockDepleted.input.productCode: la operación 'retireProduct' no declara ese campo`)
    )
  );
});

test('campo del payload que no alimenta el input de la operación es warning', () => {
  const layers = contractLayers({
    payload: {
      productId: { type: 'uuid', required: true },
      warehouseId: { type: 'uuid' },
    },
  });
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes(`subscriptions.StockDepleted.payload.warehouseId: no alimenta ningún campo del input`)
    )
  );
});

test('suscripción sobre canal external sin contract es warning', () => {
  const layers = contractLayers({ contract: undefined });
  delete layers.messaging.subscriptions.StockDepleted.contract;
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes(`subscriptions.StockDepleted: consume del canal externo 'inventoryEvents' sin contract —`)
    )
  );
});

test('discriminator por campo inexistente en el payload es error sin envoltura', () => {
  const layers = contractLayers({
    contract: {
      envelope: 'none',
      discriminator: { location: 'field', name: 'eventType', value: 'stock.depleted' },
    },
  });
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`subscriptions.StockDepleted.contract.discriminator: el campo 'eventType' no existe en el payload`)
    )
  );
});

test('discriminator por campo fuera del payload es warning con envelope wrapped', () => {
  const layers = contractLayers({
    contract: {
      envelope: 'wrapped',
      payloadPath: 'data',
      discriminator: { location: 'field', name: 'eventType', value: 'stock.depleted' },
    },
  });
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes(`contract.discriminator: el campo 'eventType' no está en payload — se asume que vive en la envoltura`)
    )
  );
});

test('messageId declarado con envelope keel es warning', () => {
  const layers = contractLayers({
    contract: {
      envelope: 'keel',
      messageId: { location: 'header', name: 'messageId' },
    },
  });
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes(`subscriptions.StockDepleted.contract.messageId: con envelope keel la identidad del mensaje ya es metadata.eventId`)
    )
  );
});

test('messageId declarado sin envelope sobre canal interno es warning (el default es keel)', () => {
  const layers = contractLayers(
    { channel: undefined, contract: { messageId: { location: 'header', name: 'messageId' } } },
    { external: false }
  );
  delete layers.messaging.subscriptions.StockDepleted.channel;
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes(`contract.messageId: con envelope keel`)));
});

test('messageId declarado con envelope wrapped o sobre canal external no avisa', () => {
  const wrapped = run(contractLayers()).warnings;
  assert.ok(!wrapped.some((w) => w.includes('contract.messageId:')));
  // Canal external sin envelope explícito: el default es `none`, no `keel`.
  const external = run(
    contractLayers({ contract: { messageId: { location: 'header', name: 'messageId' } } })
  ).warnings;
  assert.ok(!external.some((w) => w.includes('contract.messageId:')));
});

// Dos suscripciones sobre el mismo canal: cada listener ve el destino entero, así que
// o hay algo con que distinguir los mensajes propios de los ajenos, o deserializa los
// de otro. La envoltura Keel lo resuelve sola (`metadata.eventType`); sin ella, no.
const sharedChannelLayers = (contract) => {
  const layers = contractLayers({ contract });
  layers.messaging.subscriptions.StockRestocked = {
    ...layers.messaging.subscriptions.StockDepleted,
    contract: contract ? { ...contract } : undefined
  };
  return layers;
};

test('canal compartido sin discriminador ni envoltura Keel es warning en cada suscripción', () => {
  const { errors, warnings } = run(sharedChannelLayers({ envelope: 'none' }));
  assert.deepEqual(errors, []);
  for (const event of ['StockDepleted', 'StockRestocked']) {
    assert.ok(
      warnings.some((w) =>
        w.includes(`subscriptions.${event}.contract.discriminator: el canal 'inventoryEvents' lo comparten 2 suscripciones`)
      )
    );
  }
});

test('canal compartido con envoltura Keel no avisa: metadata.eventType ya lo distingue', () => {
  const layers = sharedChannelLayers({ envelope: 'keel' });
  // Con envoltura Keel el canal no puede ser external, que es lo que fuerza el default `none`.
  layers.messaging.channels.inventoryEvents = { external: false };
  const warnings = run(layers).warnings;
  assert.ok(!warnings.some((w) => w.includes('contract.discriminator: el canal')));
});

test('canal compartido con discriminador declarado no avisa, y una sola suscripción tampoco', () => {
  const declared = run(
    sharedChannelLayers({
      envelope: 'none',
      discriminator: { location: 'header', name: 'eventType', value: 'stock.depleted' }
    })
  ).warnings;
  assert.ok(!declared.some((w) => w.includes('contract.discriminator: el canal')));

  // Sin canal compartido no hay a quién confundir: la regla no se dispara.
  const alone = run(contractLayers({ contract: { envelope: 'none' } })).warnings;
  assert.ok(!alone.some((w) => w.includes('contract.discriminator: el canal')));
});

test('publicar en un canal marcado external es warning', () => {
  const layers = contractLayers();
  layers.messaging.publishing = {
    events: { ProductRetired: { channel: 'inventoryEvents', payload: { productId: { type: 'uuid' } } } },
  };
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) =>
      w.includes(`publishing.events.ProductRetired.channel: 'inventoryEvents' está marcado external`)
    )
  );
});

test('wireName en una capa interna es error', () => {
  const layers = {
    domain: { entities: { Product: entity({ sku: { type: 'string', wireName: 'product_sku' } }) } },
    'use-cases': {},
  };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`domain: Product.fields.sku: wireName solo es válido en contratos de sistemas externos`)
    )
  );
});

// --- M2M: audience ↔ reglas de acceso, serviceAuth y serviceClients ---

const domainForM2m = () => ({ entities: { Product: entity() } });
const useCasesForM2m = () => ({
  operations: {
    getProduct: { kind: 'query', input: { fields: { id: { type: 'uuid' } } }, output: { entity: 'Product' } },
    getProductPrice: { kind: 'query', input: { fields: { id: { type: 'uuid' } } }, output: { entity: 'Product' } },
  },
});

const m2mLayers = (apiOverrides = {}, securityOverrides = {}) => ({
  domain: domainForM2m(),
  'use-cases': useCasesForM2m(),
  api: {
    endpoints: {
      getProduct: { method: 'GET', path: '/products/{id}' },
      getProductPrice: { method: 'GET', path: '/products/{id}/price', audience: 'services' },
    },
    ...apiOverrides,
  },
  security: {
    authentication: {
      protocol: 'oidc',
      serviceAuth: { protocol: 'client-credentials', validateAudience: true },
    },
    permissions: { 'product:read': { description: 'Leer productos y precios' } },
    serviceClients: {
      'billing-service': { description: 'Consulta precios para facturar', scopes: ['product:read'] },
    },
    access: {
      default: { level: 'public' },
      rules: {
        getProductPrice: { level: 'service', scopes: ['product:read'] },
      },
    },
    ...securityOverrides,
  },
});

test('diseño M2M bien formado no produce errores ni warnings', () => {
  const { errors, warnings } = run(m2mLayers());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('api + security sin campos M2M sigue validando limpio (retrocompatibilidad)', () => {
  const layers = {
    domain: domainForM2m(),
    'use-cases': useCasesForM2m(),
    api: {
      endpoints: {
        getProduct: { method: 'GET', path: '/products/{id}' },
        getProductPrice: { method: 'GET', path: '/products/{id}/price' },
      },
    },
    security: {
      authentication: { protocol: 'oidc' },
      access: { default: { level: 'required' } },
    },
  };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('level service sobre endpoint audience users es error', () => {
  const layers = m2mLayers();
  layers.api.endpoints.getProductPrice.audience = 'users';
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`access.rules.getProductPrice: level 'service' pero el endpoint de la operación es audience 'users'`)
    )
  );
});

test('level service sobre endpoint audience both es error', () => {
  const layers = m2mLayers();
  layers.api.endpoints.getProductPrice.audience = 'both';
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`access.rules.getProductPrice: level 'service' en un endpoint audience 'both' excluiría a los usuarios`)
    )
  );
});

test('endpoint audience services con regla level required es error', () => {
  const layers = m2mLayers();
  layers.security.access.rules.getProductPrice = { level: 'required' };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`api: endpoints.getProductPrice: audience 'services' pero su regla de acceso (access.rules.getProductPrice) es level 'required'`)
    )
  );
});

test('endpoint audience services cuya regla efectiva es un default humano es error', () => {
  const layers = m2mLayers();
  delete layers.security.access.rules;
  layers.security.access.default = { level: 'required' };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`api: endpoints.getProductPrice: audience 'services' pero su regla de acceso (access.default) es level 'required'`)
    )
  );
});

test('scope inexistente en una regla de acceso es error', () => {
  const layers = m2mLayers();
  layers.security.access.rules.getProductPrice.scopes = ['price:read'];
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`security: access.rules.getProductPrice: el scope 'price:read' no existe en security: permissions`)
    )
  );
});

test('scope inexistente en un serviceClient es error', () => {
  const layers = m2mLayers();
  layers.security.serviceClients['billing-service'].scopes = ['price:read'];
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`security: serviceClients.billing-service: el scope 'price:read' no existe en security: permissions`)
    )
  );
});

test('level service con roles es error', () => {
  const layers = m2mLayers();
  layers.security.roles = { admin: { description: 'Administrador del sistema' } };
  layers.security.access.rules.getProductPrice.roles = ['admin'];
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`security: access.rules.getProductPrice: level 'service' no admite roles`)
    )
  );
});

test('scopes en una regla que ni es service ni cubre un endpoint both es error', () => {
  const layers = m2mLayers();
  layers.api.endpoints.getProduct.audience = 'users';
  layers.security.access.rules.getProduct = { level: 'required', scopes: ['product:read'] };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`security: access.rules.getProduct: declara scopes pero ni es level 'service' ni su endpoint es audience 'both'`)
    )
  );
});

test('endpoint audience both con required + scopes es válido', () => {
  const layers = m2mLayers();
  layers.api.endpoints.getProductPrice.audience = 'both';
  layers.security.access.rules.getProductPrice = { level: 'required', scopes: ['product:read'] };
  const { errors } = run(layers);
  assert.deepEqual(errors, []);
});

test('endpoints máquina sin serviceAuth es error', () => {
  const layers = m2mLayers();
  delete layers.security.authentication.serviceAuth;
  delete layers.security.serviceClients;
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`api: hay endpoints con audience 'services' o 'both' pero security: authentication no declara serviceAuth`)
    )
  );
});

test('serviceClients sin serviceAuth es error', () => {
  const layers = m2mLayers();
  delete layers.security.authentication.serviceAuth;
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`security: serviceClients declarado sin authentication.serviceAuth`)));
});

test('serviceClients sin ningún endpoint máquina es warning', () => {
  const layers = m2mLayers();
  layers.api.endpoints.getProductPrice.audience = 'users';
  layers.security.access.rules.getProductPrice = { level: 'required' };
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes(`security: serviceClients declarado pero ningún endpoint es audience 'services' ni 'both'`))
  );
});

test('level service sin scopes es warning', () => {
  const layers = m2mLayers();
  delete layers.security.access.rules.getProductPrice.scopes;
  delete layers.security.serviceClients;
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) =>
      w.includes(`security: access.rules.getProductPrice: level 'service' sin scopes`)
    )
  );
});

test('endpoint audience services con level public es warning', () => {
  const layers = m2mLayers();
  layers.security.access.rules.getProductPrice = { level: 'public' };
  delete layers.security.serviceClients;
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) =>
      w.includes(`api: endpoints.getProductPrice: audience 'services' con level 'public'`)
    )
  );
});

test('scope concedido a un serviceClient que ninguna regla exige es warning', () => {
  const layers = m2mLayers();
  layers.security.permissions['product:write'] = { description: 'Modificar productos' };
  layers.security.serviceClients['billing-service'].scopes.push('product:write');
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) =>
      w.includes(`security: serviceClients.billing-service: el scope 'product:write' no lo exige ninguna regla de acceso`)
    )
  );
});

test('scope exigido por una regla sin ningún serviceClient que lo tenga es warning', () => {
  const layers = m2mLayers();
  layers.security.serviceClients['billing-service'].scopes = ['product:write'];
  layers.security.permissions['product:write'] = { description: 'Modificar productos' };
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) =>
      w.includes(`security: el scope 'product:read' exigido por las reglas de acceso no está concedido a ningún serviceClient`)
    )
  );
});

test('defaultAudience services aplica a los endpoints derivados por auto', () => {
  const layers = m2mLayers({ auto: true, defaultAudience: 'services', endpoints: undefined });
  delete layers.api.endpoints;
  layers.security.access = {
    default: { level: 'service', scopes: ['product:read'] },
  };
  const { errors } = run(layers);
  assert.deepEqual(errors, []);
});

// --- http-clients: tipado de requests/responses y coherencia path ↔ pathParams ---

const domainForHttp = () => ({
  types: {
    Sku: { type: 'string' },
    Money: { type: 'decimal' },
  },
  entities: { Product: entity() },
});

const httpLayers = (call) => ({
  domain: domainForHttp(),
  'use-cases': {},
  'http-clients': {
    clients: {
      'pricing-service': { purpose: 'Precios vigentes por SKU', calls: { getPrice: call } },
    },
  },
});

test('llamada solo-prosa sigue validando limpio (retrocompatibilidad)', () => {
  const { errors, warnings } = run(httpLayers({ contract: 'GET /prices/{sku} -> { amount: decimal }' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('llamada estructurada bien formada no produce errores ni warnings', () => {
  const { errors, warnings } = run(
    httpLayers({
      contract: 'Precio vigente de un SKU',
      method: 'GET',
      path: '/prices/{sku}',
      request: { pathParams: { sku: { type: 'Sku' } }, queryParams: { currency: { type: 'string' } } },
      response: { fields: { amount: { type: 'Money' } } },
    })
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('tipo inexistente en response.fields es error', () => {
  const { errors } = run(
    httpLayers({
      contract: 'Precio vigente de un SKU',
      method: 'GET',
      path: '/prices',
      response: { fields: { amount: { type: 'Price' } } },
    })
  );
  assert.ok(
    errors.some((e) =>
      e.includes(`http-clients: clients.pricing-service.calls.getPrice.response.fields.amount: el tipo 'Price' no existe en domain: types`)
    )
  );
});

test('tipo inexistente en request.body es error', () => {
  const { errors } = run(
    httpLayers({
      contract: 'Autoriza un cobro',
      method: 'POST',
      path: '/charges',
      request: { body: { amount: { type: 'Importe' } } },
    })
  );
  assert.ok(
    errors.some((e) =>
      e.includes(`http-clients: clients.pricing-service.calls.getPrice.request.body.amount: el tipo 'Importe' no existe en domain: types`)
    )
  );
});

test('variable de path no declarada en pathParams es error', () => {
  const { errors } = run(
    httpLayers({
      contract: 'Precio vigente de un SKU',
      method: 'GET',
      path: '/prices/{sku}',
      request: { pathParams: { other: { type: 'string' } } },
    })
  );
  assert.ok(errors.some((e) => e.includes(`request.pathParams: la variable '{sku}' de path no está declarada`)));
  assert.ok(errors.some((e) => e.includes(`request.pathParams.other: no aparece como '{other}' en path`)));
});

test('path con variables sin request.pathParams es warning', () => {
  const { errors, warnings } = run(
    httpLayers({ contract: 'Precio vigente de un SKU', method: 'GET', path: '/prices/{sku}' })
  );
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes(`path con variables {…} sin request.pathParams`)));
});

test('response tipada sin method+path es warning', () => {
  const { warnings } = run(
    httpLayers({
      contract: 'GET /prices/{sku} -> { amount: decimal }',
      response: { fields: { amount: { type: 'Money' } } },
    })
  );
  assert.ok(
    warnings.some((w) => w.includes(`declara request/response tipados pero no method+path`))
  );
});

test('circuitBreaker sin fallback es warning y con fallback no', () => {
  const base = { contract: 'GET /prices -> lista de precios', method: 'GET', path: '/prices' };
  const sin = run(httpLayers({ ...base, circuitBreaker: { failureRateThreshold: 50 } }));
  assert.ok(sin.warnings.some((w) => w.includes(`circuitBreaker sin fallback`)));
  const con = run(httpLayers({ ...base, circuitBreaker: { failureRateThreshold: 50 }, fallback: 'usa el último precio cacheado' }));
  assert.ok(!con.warnings.some((w) => w.includes(`circuitBreaker sin fallback`)));
});

// Reintentar es ejecutar otra vez: en una escritura ajena, el reintento duplica el
// efecto al otro lado y un timeout no distingue "no llegó" de "llegó y se hizo".
test('retry sobre una escritura ajena sin idempotencia declarada es warning', () => {
  const escritura = {
    contract: 'POST /withdrawals inscribe la retirada',
    method: 'POST',
    path: '/withdrawals',
    retry: { maxAttempts: 3, retryOn: ['timeout'] },
  };
  const sin = run(httpLayers(escritura));
  assert.ok(sin.warnings.some((w) => w.includes('reintenta un POST sin declarar')), sin.warnings.join('\n'));

  const con = run(httpLayers({ ...escritura, idempotency: { keyFrom: 'payload-hash' } }));
  assert.ok(!con.warnings.some((w) => w.includes('reintenta un POST')), con.warnings.join('\n'));
  assert.deepEqual(con.errors, []);
});

test('una lectura no gana el aviso, y una clave en un GET sí', () => {
  const lectura = { contract: 'GET /prices -> precios', method: 'GET', path: '/prices' };
  const conRetry = run(httpLayers({ ...lectura, retry: { maxAttempts: 3 } }));
  assert.ok(!conRetry.warnings.some((w) => w.includes('sin declarar')), conRetry.warnings.join('\n'));

  const conClave = run(httpLayers({ ...lectura, idempotency: { keyFrom: 'payload-hash' } }));
  assert.ok(conClave.warnings.some((w) => w.includes(`'idempotency' en un GET no aporta nada`)));
});

test('campo file en request con bucket inexistente es error', () => {
  const layers = httpLayers({
    contract: 'Sube el comprobante del cobro',
    method: 'POST',
    path: '/receipts',
    request: { body: { receipt: { type: 'file', bucket: 'receipts' } } },
  });
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`request.body.receipt: el bucket 'receipts' no está en storage: buckets (no hay capa storage)`)
    )
  );
});

test('messaging sin channels ni channel sigue validando limpio (retrocompatibilidad)', () => {
  const layers = {
    domain: domainForMessaging(),
    'use-cases': useCasesForMessaging(),
    messaging: {
      publishing: { events: { ProductRetired: { payload: {} } } },
      subscriptions: {
        StockDepleted: { source: 'inventory-service', payload: {}, triggers: 'retireProduct' },
      },
    },
  };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

// --- Cardinalidad en campos (DSL 2.1: list) ---

const domainForList = () => ({
  entities: { Product: entity({ name: { type: 'string' } }) },
  aggregates: { Catalog: { root: 'Product' } },
});

const batchLayers = (idsField) => ({
  domain: domainForList(),
  'use-cases': {
    operations: {
      getProductsByIds: {
        description: 'Resuelve varios productos por sus identificadores en una sola llamada.',
        kind: 'query',
        internal: true,
        input: { fields: { ids: idsField } },
        output: { entity: 'Product', list: true },
      },
    },
  },
});

test('campo list en el input de una operación es válido', () => {
  const { errors, warnings } = run(
    batchLayers({ type: 'uuid', list: true, required: true, constraints: { minItems: 1, maxItems: 100 } })
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(otherThanSortNotice(warnings), []);
});

test('campo list de escalar y de value object en una entidad es válido', () => {
  const domain = domainForList();
  domain.types = { Discount: { fields: { code: { type: 'string' }, percentage: { type: 'decimal' } } } };
  domain.entities.Product.fields.tags = { type: 'string', list: true };
  domain.entities.Product.fields.discounts = { type: 'Discount', list: true, constraints: { maxItems: 10 } };
  const { errors, warnings } = run({ domain, 'use-cases': {} });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('campo list de un tipo inexistente sigue siendo error de tipo', () => {
  const domain = domainForList();
  domain.entities.Product.fields.discounts = { type: 'Discount', list: true };
  const { errors } = run({ domain, 'use-cases': {} });
  assert.ok(errors.some((e) => e.includes(`domain: Product.fields.discounts: el tipo 'Discount' no existe`)));
});

test('campo list dentro de un value object es error', () => {
  const domain = domainForList();
  domain.types = { Address: { fields: { zip: { type: 'string' }, lines: { type: 'string', list: true } } } };
  const { errors } = run({ domain, 'use-cases': {} });
  assert.ok(
    errors.some((e) =>
      e.includes(`domain: types.Address.fields.lines: list no es válido dentro de un value object`)
    )
  );
});

test('campo list en pathParams de un http-client es error', () => {
  const layers = {
    domain: domainForList(),
    'use-cases': {},
    'http-clients': {
      clients: {
        pricing: {
          baseUrl: 'https://pricing.example.com',
          calls: {
            getPrices: {
              contract: 'GET /prices/{sku} -> precio del producto',
              method: 'GET',
              path: '/prices/{sku}',
              request: { pathParams: { sku: { type: 'string', list: true } } },
            },
          },
        },
      },
    },
  };
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`request.pathParams.sku: list no es válido en pathParams`)));
});

test('minItems mayor que maxItems es error', () => {
  const { errors } = run(batchLayers({ type: 'uuid', list: true, constraints: { minItems: 10, maxItems: 5 } }));
  assert.ok(
    errors.some((e) => e.includes(`getProductsByIds.input.ids: minItems (10) no puede ser mayor que maxItems (5)`))
  );
});

// --- CORS: coherencia con la capa api y con tokenLocation ---

const corsLayers = (cors, securityOverrides = {}) => ({
  domain: domainForM2m(),
  'use-cases': useCasesForM2m(),
  api: {
    endpoints: {
      getProduct: { method: 'GET', path: '/products/{id}' },
      getProductPrice: { method: 'GET', path: '/products/{id}/price' },
    },
  },
  security: {
    authentication: { protocol: 'oidc' },
    access: { default: { level: 'required' } },
    cors,
    ...securityOverrides,
  },
});

test('cors bien formado con capa api no produce errores ni warnings', () => {
  const { errors, warnings } = run(corsLayers({ description: 'Consumido por la SPA de back-office.' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('cors sin capa api es error', () => {
  const layers = corsLayers({ description: 'Consumido por la SPA de back-office.' });
  delete layers.api;
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes('cors declarado sin capa api')));
});

test('cors con tokenLocation cookie y allowCredentials false es error', () => {
  const layers = corsLayers({ description: 'Consumido por la SPA de back-office.' });
  layers.security.authentication.tokenLocation = 'cookie';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes('cors.allowCredentials debe ser true con tokenLocation cookie')));
});

test('cors con tokenLocation cookie y allowCredentials true es válido', () => {
  const layers = corsLayers({ description: 'Consumido por la SPA de back-office.', allowCredentials: true });
  layers.security.authentication.tokenLocation = 'cookie';
  const { errors } = run(layers);
  assert.deepEqual(errors, []);
});

// --- dependencies: qué otros servidores necesita este y cómo lee su dato ---

const depsLayers = () => ({
  domain: {
    entities: {
      Order: entity({ total: { type: 'decimal', required: true } }),
      ProductSnapshot: entity({
        productId: { type: 'uuid', required: true, unique: true },
        price: { type: 'decimal', required: true },
      }),
    },
  },
  'use-cases': {
    operations: {
      createOrder: {
        description: 'Crea un pedido a partir de los productos elegidos.',
        kind: 'command',
        input: { fields: { productId: { type: 'uuid', required: true } } },
        output: { entity: 'Order' },
        errors: [{ code: 'PRICE_UNAVAILABLE', when: 'No se conoce el precio vigente del producto.' }],
      },
      applyProductSnapshot: {
        description: 'Actualiza la copia local del producto con lo que informa catalog.',
        kind: 'command',
        internal: true,
        input: { fields: { productId: { type: 'uuid', required: true }, price: { type: 'decimal', required: true } } },
        output: 'void',
      },
    },
  },
  api: { endpoints: { createOrder: { method: 'POST', path: '/orders' } } },
  security: { authentication: { protocol: 'oidc' }, access: { default: { level: 'required' } } },
  messaging: {
    subscriptions: {
      ProductUpdated: {
        source: 'catalog',
        payload: { productId: { type: 'uuid', required: true }, price: { type: 'decimal', required: true } },
        triggers: 'applyProductSnapshot',
      },
    },
  },
  'http-clients': {
    clients: {
      catalog: {
        purpose: 'Resolver la información de productos al construir pedidos.',
        calls: { getProductsByIds: { contract: 'POST /internal/products/batch-get -> lista de productos.' } },
      },
    },
  },
  dependencies: {
    dependencies: {
      catalog: {
        description: 'Fuente de verdad de productos y precios.',
        contract: { version: '0.2.0' },
        needs: {
          productPricing: {
            description: 'Precio y estado del producto al construir un pedido.',
            usedBy: ['createOrder'],
            strategy: 'replicated',
            fetchedFrom: { client: 'catalog', call: 'getProductsByIds' },
            onUnavailable: { action: 'fail', error: 'PRICE_UNAVAILABLE' },
            replica: {
              entity: 'ProductSnapshot',
              keyField: 'productId',
              fedBy: ['ProductUpdated'],
              onMiss: { action: 'fetch' },
            },
          },
        },
      },
    },
  },
  persistence: { default: { model: 'relational' }, entities: { Order: {}, ProductSnapshot: {} } },
});

const need = (layers) => layers.dependencies.dependencies.catalog.needs.productPricing;

test('dependencies coherente no produce errores ni warnings', () => {
  const { errors, warnings } = run(depsLayers());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('spec sin capa dependencies sigue validando limpio (retrocompatibilidad)', () => {
  const layers = depsLayers();
  delete layers.dependencies;
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('usedBy hacia una operación inexistente es error', () => {
  const layers = depsLayers();
  need(layers).usedBy = ['repriceOrder'];
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`usedBy: la operación 'repriceOrder' no existe en use-cases`)));
});

test('un need que pide el dato al proveedor sin declarar onUnavailable es aviso', () => {
  // La decisión que falta no es un detalle de implementación: es qué ve el cliente
  // cuando el proveedor no contesta. Una activación lo declara en `onFailure` y una
  // réplica en `onMiss`; el dato que se PIDE no tenía dónde, y acababa en la prosa del
  // `fallback` de la llamada — que el generador no puede aplicar.
  const layers = depsLayers();
  delete need(layers).onUnavailable;
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes("needs.productPricing: no declara 'onUnavailable'")), warnings.join(' | '));
});

test('onUnavailable.error que ninguna operación declara es error', () => {
  // Mismo trato que `onMiss.error`: el generador lanza esa excepción, y solo existe si
  // alguna operación la declaró en su catálogo.
  const layers = depsLayers();
  need(layers).onUnavailable = { action: 'fail', error: 'PRICING_DOWN' };
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes("onUnavailable.error: el código 'PRICING_DOWN' no lo declara ninguna operación")), errors.join(' | '));
});

test('onUnavailable declarado por una operación ajena a usedBy es aviso', () => {
  const layers = depsLayers();
  layers['use-cases'].operations.applyProductSnapshot.errors = [
    { code: 'SNAPSHOT_STALE', when: 'La copia local es más vieja que el evento recibido.' }
  ];
  need(layers).onUnavailable = { action: 'fail', error: 'SNAPSHOT_STALE' };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes("onUnavailable.error: 'SNAPSHOT_STALE' no lo declara ninguna de las operaciones de usedBy")), warnings.join(' | '));
});

test('fetchedFrom con cliente inexistente es error', () => {
  const layers = depsLayers();
  need(layers).fetchedFrom.client = 'pricing';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`fetchedFrom: el cliente 'pricing' no está en http-clients: clients`)));
});

test('fetchedFrom sin capa http-clients queda pendiente con --wip', () => {
  const layers = depsLayers();
  delete layers['http-clients'];
  const { errors, pending } = run(layers, true);
  assert.deepEqual(errors, []);
  assert.ok(pending.some((p) => p.includes(`fetchedFrom: el cliente 'catalog' está pendiente de definir`)));
});

test('fetchedFrom sin capa http-clients es error sin --wip', () => {
  const layers = depsLayers();
  delete layers['http-clients'];
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes('(no hay capa http-clients)')));
});

test('fetchedFrom con llamada inexistente es error', () => {
  const layers = depsLayers();
  need(layers).fetchedFrom.call = 'getProduct';
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`fetchedFrom: la llamada 'getProduct' no existe en http-clients: clients.catalog.calls`))
  );
});

test('replica hacia una entidad inexistente es error', () => {
  const layers = depsLayers();
  need(layers).replica.entity = 'ProductCopy';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`replica.entity: la entidad 'ProductCopy' no existe en domain: entities`)));
});

test('replica.keyField que no es campo de la entidad es error', () => {
  const layers = depsLayers();
  need(layers).replica.keyField = 'sku';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`replica.keyField: el campo 'sku' no existe en la entidad 'ProductSnapshot'`)));
});

test('replica sin capa persistence es error incluso con --wip', () => {
  const layers = depsLayers();
  delete layers.persistence;
  const { errors } = run(layers, true);
  assert.ok(errors.some((e) => e.includes('replica: una copia local exige capa persistence')));
});

test('replica cuya entidad no está en persistence.entities es warning', () => {
  const layers = depsLayers();
  delete layers.persistence.entities.ProductSnapshot;
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes(`'ProductSnapshot' no aparece en persistence: entities`)));
});

test('replica.keyField sin unique es warning', () => {
  const layers = depsLayers();
  delete layers.domain.entities.ProductSnapshot.fields.productId.unique;
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes(`replica.keyField: 'productId' no es unique`)));
});

test('fedBy hacia un evento no suscrito es error', () => {
  const layers = depsLayers();
  need(layers).replica.fedBy = ['ProductRetired'];
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`fedBy: el evento 'ProductRetired' no está en messaging: subscriptions`)));
});

test('fedBy sin capa messaging queda pendiente con --wip', () => {
  const layers = depsLayers();
  delete layers.messaging;
  delete layers['use-cases'].operations.applyProductSnapshot;
  const { pending } = run(layers, true);
  assert.ok(pending.some((p) => p.includes(`fedBy: el evento 'ProductUpdated' está pendiente de definir`)));
});

test('fedBy cuyo source no coincide con la dependencia es warning', () => {
  const layers = depsLayers();
  layers.messaging.subscriptions.ProductUpdated.source = 'inventory';
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes(`declara source 'inventory', distinto de la dependencia 'catalog'`)));
});

test('onMiss.error que no declara ninguna operación es error', () => {
  const layers = depsLayers();
  need(layers).replica.onMiss = { action: 'fail', error: 'PRODUCT_UNKNOWN' };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`onMiss.error: el código 'PRODUCT_UNKNOWN' no lo declara ninguna operación`))
  );
});

test('onMiss.error declarado fuera de las operaciones de usedBy es warning', () => {
  const layers = depsLayers();
  need(layers).replica.onMiss = { action: 'fail', error: 'PRICE_UNAVAILABLE' };
  need(layers).usedBy = ['applyProductSnapshot'];
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes(`'PRICE_UNAVAILABLE' no lo declara ninguna de las operaciones de usedBy`)));
});

test('dos needs replicando la misma entidad es warning', () => {
  const layers = depsLayers();
  layers.dependencies.dependencies.catalog.needs.productAvailability = {
    usedBy: ['createOrder'],
    strategy: 'replicated',
    replica: {
      entity: 'ProductSnapshot',
      keyField: 'productId',
      fedBy: ['ProductUpdated'],
      onMiss: { action: 'degrade', degradedTo: 'Se asume disponible y se revisa al confirmar.' },
    },
  };
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes(`'ProductSnapshot' ya la replica el need 'productPricing'`)));
});

test('compensations hacia un evento no suscrito es error', () => {
  const layers = depsLayers();
  layers.dependencies.dependencies.catalog.compensations = [
    { onEvent: 'OrderPaymentFailed', description: 'Revierte la reserva contra catalog.' },
  ];
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`el evento 'OrderPaymentFailed' no está en messaging: subscriptions`)));
});

test('cliente http que ningún need usa es warning', () => {
  const layers = depsLayers();
  layers['http-clients'].clients.shipping = {
    purpose: 'Calcular los gastos de envío del pedido.',
    calls: { quote: { contract: 'POST /quotes -> coste de envío.' } },
  };
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes('clients.shipping: ningún need ni activación de dependencies lo usa')));
});

test('suscripción cuyo source no está en dependencies es warning', () => {
  const layers = depsLayers();
  layers.messaging.subscriptions.StockDepleted = {
    source: 'inventory',
    payload: { productId: { type: 'uuid', required: true }, price: { type: 'decimal', required: true } },
    triggers: 'applyProductSnapshot',
  };
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes(`subscriptions.StockDepleted: su source 'inventory' no está declarado`)));
});

// --- dependencies: activaciones (pedirle trabajo a otro, no leerle un dato) ----

/**
 * Un servicio que no lee nada de `notifications`: solo le pide que envíe el
 * aviso. Es el caso que antes había que disfrazar de `need`.
 */
const activationLayers = () => ({
  domain: { entities: { Order: entity({ total: { type: 'decimal', required: true } }) } },
  'use-cases': {
    operations: {
      confirmOrder: {
        description: 'Confirma el pedido y avisa al comprador.',
        kind: 'command',
        input: { fields: { orderId: { type: 'uuid', required: true } } },
        output: { entity: 'Order' },
        // Encarga trabajo a otro servidor por POST: sin guarda, un reenvío del comprador
        // manda dos correos, y eso ya salió del proceso.
        idempotency: { keySource: 'client-key', ttlSeconds: 3600 },
        errors: [
          { code: 'NOTICE_UNAVAILABLE', when: 'No se pudo encargar el aviso al comprador.' },
          // Los dos desenlaces del mecanismo, nombrados. No son adorno del fixture: sin
          // ellos el diseño recibe el aviso de «se usarán los canónicos», y este test
          // afirma cero warnings. Declararlos es también el camino que documenta
          // docs/framework-errors.md para sustituir un canónico.
          { code: 'IDEMPOTENCY_KEY_IN_PROGRESS', when: 'Otra petición con la misma clave está en curso.', http: 409 },
          { code: 'IDEMPOTENCY_KEY_REUSED', when: 'La misma clave llega con otro contenido.', http: 409 }
        ],
      },
    },
  },
  api: { endpoints: { confirmOrder: { method: 'POST', path: '/orders/{orderId}/confirm' } } },
  security: { authentication: { protocol: 'oidc' }, access: { default: { level: 'required' } } },
  'http-clients': {
    clients: {
      notifications: {
        purpose: 'Encargar el envío de avisos al comprador.',
        calls: { sendEmail: { contract: 'POST /emails -> acuse del encargo.' } },
      },
    },
  },
  dependencies: {
    dependencies: {
      notifications: {
        description: 'Servicio de avisos: no le leemos nada, le pedimos que envíe.',
        contract: { version: '1.2.0' },
        activations: {
          sendOrderConfirmation: {
            triggeredBy: ['confirmOrder'],
            via: { client: 'notifications', call: 'sendEmail' },
            effect: 'Sale un correo de confirmación hacia el comprador.',
            onFailure: { action: 'fail', error: 'NOTICE_UNAVAILABLE' },
          },
        },
      },
    },
  },
  persistence: { default: { model: 'relational' }, entities: { Order: {} } },
});

const activation = (layers) => layers.dependencies.dependencies.notifications.activations.sendOrderConfirmation;

test('una dependencia solo de activación valida limpia, sin need inventado', () => {
  const { errors, warnings } = run(activationLayers());
  assert.deepEqual(errors, []);
  // La regresión que motivó todo esto: el cliente HTTP ya no queda huérfano por
  // no colgar de ningún `need`.
  assert.deepEqual(warnings, []);
});

test('triggeredBy hacia una operación inexistente es error', () => {
  const layers = activationLayers();
  activation(layers).triggeredBy = ['cancelOrder'];
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`triggeredBy: la operación 'cancelOrder' no existe en use-cases`)));
});

test('via hacia una llamada que no existe es error', () => {
  const layers = activationLayers();
  activation(layers).via = { client: 'notifications', call: 'sendSms' };
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`via: la llamada 'sendSms' no existe en http-clients`)));
});

test('activar por evento exige que el evento se publique', () => {
  const layers = activationLayers();
  activation(layers).via = { publishes: 'DeliveryRequested' };
  delete activation(layers).onFailure;
  delete layers['http-clients'];

  const missing = run(layers);
  assert.ok(missing.errors.some((e) => e.includes(`el evento 'DeliveryRequested' no está en messaging: publishing.events`)));

  layers.messaging = {
    publishing: {
      events: { DeliveryRequested: { payload: { recipient: { type: 'string', required: true } } } },
    },
  };
  const declared = run(layers);
  assert.deepEqual(declared.errors, []);
});

test('awaits outcome por evento es contradictorio', () => {
  const layers = activationLayers();
  delete layers['http-clients'];
  activation(layers).via = { publishes: 'DeliveryRequested' };
  activation(layers).awaits = 'outcome';
  delete activation(layers).onFailure;
  layers.messaging = {
    publishing: { events: { DeliveryRequested: { payload: { recipient: { type: 'string', required: true } } } } },
  };
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`awaits: 'outcome' exige un canal síncrono`)));
});

test('onFailure.error debe declararlo alguna operación', () => {
  const layers = activationLayers();
  activation(layers).onFailure = { action: 'fail', error: 'MAILBOX_FULL' };
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`onFailure.error: el código 'MAILBOX_FULL' no lo declara ninguna operación`)));
});

test('compensations.undoes hacia una activación inexistente es error', () => {
  const layers = activationLayers();
  layers.messaging = {
    subscriptions: {
      OrderPaymentFailed: {
        source: 'notifications',
        payload: { orderId: { type: 'uuid', required: true } },
        triggers: 'confirmOrder',
      },
    },
  };
  layers.dependencies.dependencies.notifications.compensations = [
    { onEvent: 'OrderPaymentFailed', undoes: 'sendOrderCancellation' },
  ];
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`undoes: la activación 'sendOrderCancellation' no existe`)));
});

test('una suscripción request no le debe dependencia a quien la activa', () => {
  const layers = activationLayers();
  layers.messaging = {
    subscriptions: {
      DeliveryRequested: {
        source: 'storefront',
        nature: 'request',
        payload: { orderId: { type: 'uuid', required: true } },
        triggers: 'confirmOrder',
      },
    },
  };
  const asRequest = run(layers);
  assert.ok(!asRequest.warnings.some((w) => w.includes(`su source 'storefront' no está declarado`)), asRequest.warnings.join('\n'));

  // Como hecho al que reaccionamos por cuenta propia, sí es una dependencia.
  layers.messaging.subscriptions.DeliveryRequested.nature = 'fact';
  const asFact = run(layers);
  assert.ok(asFact.warnings.some((w) => w.includes(`su source 'storefront' no está declarado`)));
});

test('strategy on-demand no arrastra persistence ni messaging', () => {
  const layers = depsLayers();
  delete layers.messaging;
  delete layers.persistence;
  delete layers.domain.entities.ProductSnapshot;
  delete layers['use-cases'].operations.applyProductSnapshot;
  const spec = need(layers);
  spec.strategy = 'on-demand';
  delete spec.replica;
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

// --- storage: lectura de una clave que ya no está en el bucket -----------------

const fileReadLayers = (errors = []) => ({
  domain: {
    entities: {
      Product: entity({ image: { type: 'file', bucket: 'images' } }),
    },
  },
  'use-cases': {
    operations: {
      getProductImage: {
        type: 'query',
        internal: true,
        output: { fields: { image: { type: 'file', bucket: 'images' } } },
        errors,
      },
    },
  },
  storage: { buckets: { images: { visibility: 'private', signedUrlTtlSeconds: 900 } } },
});

test('operación que devuelve un archivo sin error de ausencia es warning', () => {
  const { errors, warnings } = run(fileReadLayers());
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some(
      (w) => w.includes('operations.getProductImage') && w.includes('clave inexistente')
    )
  );
});

test('un error con http 404 cubre la ausencia del archivo', () => {
  const { warnings } = run(fileReadLayers([{ code: 'IMAGE_GONE', when: 'el objeto no está', http: 404 }]));
  assert.deepEqual(warnings, []);
});

test('un code terminado en NOT_FOUND cubre la ausencia sin http explícito', () => {
  const { warnings } = run(fileReadLayers([{ code: 'FILE_NOT_FOUND', when: 'el objeto no está' }]));
  assert.deepEqual(warnings, []);
});

test('una operación que no devuelve archivos no dispara el warning', () => {
  const layers = fileReadLayers();
  layers['use-cases'].operations.getProductImage.output = { fields: { name: { type: 'string' } } };
  const { warnings } = run(layers);
  assert.ok(!warnings.some((w) => w.includes('clave inexistente')));
});

// --- api: variables de ruta ↔ input, internal y coherencia method ↔ kind ---

const apiLayers = (endpoint, opOverrides = {}) => ({
  domain: {
    entities: {
      Product: entity(
        { sku: { type: 'string', unique: true } },
        { relations: { category: { entity: 'Category', cardinality: 'many-to-one' } } }
      ),
      Category: entity(),
    },
  },
  'use-cases': {
    operations: {
      getProduct: {
        kind: 'query',
        input: { fields: { sku: { type: 'string' } } },
        output: { entity: 'Product' },
        ...opOverrides,
      },
    },
  },
  api: { endpoints: { getProduct: endpoint } },
  security: { authentication: { protocol: 'oidc' }, access: { default: { level: 'public' } } },
});

test('variable de ruta que el input declara es válida', () => {
  const { errors, warnings } = run(apiLayers({ method: 'GET', path: '/products/{sku}' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('variable de ruta ausente del input es error', () => {
  const { errors } = run(apiLayers({ method: 'GET', path: '/products/{id}' }));
  assert.ok(
    errors.some((e) =>
      e.includes(`api: endpoints.getProduct.path: la variable '{id}' no está en el input de la operación`)
    )
  );
});

test('varias variables de ruta se reportan por separado', () => {
  const { errors } = run(apiLayers({ method: 'GET', path: '/catalogs/{catalogId}/products/{id}' }));
  assert.equal(errors.filter((e) => e.includes('no está en el input de la operación')).length, 2);
});

test('input void con variables en la ruta es error', () => {
  const { errors } = run(apiLayers({ method: 'GET', path: '/products/{sku}' }, { input: 'void' }));
  assert.ok(errors.some((e) => e.includes(`la variable '{sku}' no está en el input de la operación`)));
});

test('ruta sin variables no exige nada del input', () => {
  const { errors, warnings } = run(apiLayers({ method: 'GET', path: '/products' }, { input: 'void' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('con input { entity } la variable resuelve contra los campos de la entidad', () => {
  const { errors } = run(apiLayers({ method: 'GET', path: '/products/{sku}' }, { input: { entity: 'Product' } }));
  assert.deepEqual(errors, []);
});

test('con input { entity } una relación resuelve por su nombre o con sufijo Id', () => {
  const byName = run(apiLayers({ method: 'GET', path: '/products/{category}' }, { input: { entity: 'Product' } }));
  assert.deepEqual(byName.errors, []);
  const byId = run(apiLayers({ method: 'GET', path: '/products/{categoryId}' }, { input: { entity: 'Product' } }));
  assert.deepEqual(byId.errors, []);
});

test('un campo excluido del input no resuelve la variable de ruta', () => {
  const { errors } = run(
    apiLayers({ method: 'GET', path: '/products/{sku}' }, { input: { entity: 'Product', exclude: ['sku'] } })
  );
  assert.ok(errors.some((e) => e.includes(`la variable '{sku}' no está en el input de la operación`)));
});

test('exponer una operación internal: true es error', () => {
  const { errors } = run(apiLayers({ method: 'GET', path: '/products/{sku}' }, { internal: true }));
  assert.ok(errors.some((e) => e.includes('api: endpoints.getProduct: la operación está declarada internal: true')));
});

test('un endpoint cuya operación no existe no cascada más errores', () => {
  const layers = apiLayers({ method: 'GET', path: '/products/{sku}' });
  layers.api.endpoints.getOther = { method: 'GET', path: '/others/{id}' };
  const { errors } = run(layers);
  assert.deepEqual(errors, ['api: endpoints.getOther: la operación no existe en use-cases']);
});

test('query expuesta con un método distinto de GET es warning', () => {
  const { errors, warnings } = run(apiLayers({ method: 'POST', path: '/products/{sku}/search' }));
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('api: endpoints.getProduct.method: la operación es kind: query')));
});

test('command expuesto con GET es warning', () => {
  const layers = apiLayers({ method: 'GET', path: '/products/{sku}' }, { kind: 'command' });
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes('la operación es kind: command y se expone con GET')));
});

// --- api: successStatus ↔ output de la operación ---

const statusLayers = (endpointOverrides, opOverrides = {}) =>
  apiLayers(
    { method: 'DELETE', path: '/products/{sku}', ...endpointOverrides },
    { kind: 'command', ...opOverrides }
  );

test('204 con output entity es error', () => {
  const { errors } = run(statusLayers({ successStatus: 204 }));
  assert.ok(
    errors.some((e) =>
      e.includes('api: endpoints.getProduct.successStatus: 204 es un status sin cuerpo y la operación declara output')
    )
  );
});

test('204 con output void valida limpio', () => {
  const { errors, warnings } = run(statusLayers({ successStatus: 204 }, { output: 'void' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('200 con output void es warning, no error', () => {
  const { errors, warnings } = run(statusLayers({ successStatus: 200 }, { output: 'void' }));
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('200 admite cuerpo y la operación declara output: "void"')));
});

test('200 con output entity no dice nada', () => {
  const { errors, warnings } = run(statusLayers({ successStatus: 200 }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('DELETE sin successStatus y con output es warning (el generador asume 204)', () => {
  const { errors, warnings } = run(statusLayers({}));
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('DELETE sin successStatus se genera como 204')));
});

test('DELETE sin successStatus con output void valida limpio', () => {
  const { errors, warnings } = run(statusLayers({}, { output: 'void' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

// --- use-cases: cache.keyFields ↔ input ---

const cacheLayers = (cache) => {
  const layers = apiLayers({ method: 'GET', path: '/products/{sku}' });
  layers['use-cases'].operations.getProduct.cache = cache;
  return layers;
};

test('keyFields que el input declara es válido', () => {
  const { errors, warnings } = run(cacheLayers({ ttlSeconds: 60, keyFields: ['sku'] }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('keyFields con un campo ajeno al input es error', () => {
  const { errors } = run(cacheLayers({ ttlSeconds: 60, keyFields: ['skuu'] }));
  assert.ok(
    errors.some((e) =>
      e.includes(`use-cases: getProduct.cache.keyFields: el campo 'skuu' no está en el input de la operación`)
    )
  );
});

test('keyFields sobre una operación con input void es error', () => {
  const layers = cacheLayers({ ttlSeconds: 60, keyFields: ['sku'] });
  layers['use-cases'].operations.getProduct.input = 'void';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`cache.keyFields: el campo 'sku' no está en el input`)));
});

// --- use-cases: paginated ↔ list y ↔ api.pagination ---

const paginatedLayers = (output, pagination = { style: 'offset', defaultSize: 20, maxSize: 100 }) => ({
  domain: { entities: { Product: entity() } },
  'use-cases': { operations: { listProducts: { kind: 'query', input: 'void', output } } },
  api: {
    endpoints: { listProducts: { method: 'GET', path: '/products' } },
    ...(pagination ? { pagination } : {}),
  },
  security: { authentication: { protocol: 'oidc' }, access: { default: { level: 'public' } } },
});

test('paginated con list y con api.pagination es válido', () => {
  const { errors, warnings } = run(paginatedLayers({ entity: 'Product', list: true, paginated: true }));
  assert.deepEqual(errors, []);
  assert.deepEqual(otherThanSortNotice(warnings), []);
});

test('paginated sin list es la forma canónica y no dispara nada', () => {
  // El sobre de paginación ya envuelve la colección: list sería redundante.
  const { errors, warnings } = run(paginatedLayers({ entity: 'Product', paginated: true }));
  assert.deepEqual(errors, []);
  assert.deepEqual(otherThanSortNotice(warnings), []);
});

test('paginated sin pagination en api es warning', () => {
  const { errors, warnings } = run(paginatedLayers({ entity: 'Product', list: true, paginated: true }, null));
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('paginated: true pero api no declara pagination')));
});

test('un output sin paginated no dispara nada', () => {
  const { errors, warnings } = run(paginatedLayers({ entity: 'Product', list: true }, null));
  assert.deepEqual(errors, []);
  assert.deepEqual(otherThanSortNotice(warnings), []);
});

// --- messaging: eventos publicados que nadie emite ---

test('evento publicado que ninguna operación emite es warning', () => {
  const layers = {
    domain: { entities: { Product: entity() } },
    'use-cases': { operations: { retireProduct: { kind: 'command', input: 'void', output: 'void' } } },
    messaging: { publishing: { events: { ProductRetired: { payload: {} } } } },
  };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes('messaging: publishing.events.ProductRetired: evento declarado pero ninguna operación lo emite')
    )
  );
});

test('sin capa use-cases utilizable no se avisa de eventos sin emisor', () => {
  const layers = {
    domain: { entities: { Product: entity() } },
    'use-cases': {},
    messaging: { publishing: { events: { ProductRetired: { payload: {} } } } },
  };
  const { warnings } = run(layers, true);
  assert.ok(!warnings.some((w) => w.includes('ninguna operación lo emite')));
});

// --- security: authentication.protocol none ↔ reglas que exigen identidad ---

const noAuthLayers = (access) => ({
  domain: { entities: { Product: entity() } },
  'use-cases': { operations: { listProducts: { kind: 'query', input: 'void', output: { entity: 'Product' } } } },
  api: { endpoints: { listProducts: { method: 'GET', path: '/products' } } },
  security: { authentication: { protocol: 'none' }, access },
});

test('protocol none con todo público es válido', () => {
  const { errors, warnings } = run(noAuthLayers({ default: { level: 'public' } }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('protocol none con default que exige identidad es error', () => {
  const { errors } = run(noAuthLayers({ default: { level: 'required' } }));
  assert.ok(
    errors.some((e) => e.includes(`security: authentication.protocol: 'none' pero access.default exige identidad`))
  );
});

test('protocol none con una regla por operación que exige identidad es error', () => {
  const layers = noAuthLayers({ default: { level: 'public' }, rules: { listProducts: { level: 'admin' } } });
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes('access.rules.listProducts exige identidad')));
});

test('protocol none con roles sobre un nivel public sigue siendo error', () => {
  const layers = noAuthLayers({ default: { level: 'public', roles: ['admin'] } });
  layers.security.roles = { admin: { description: 'Administra el catálogo' } };
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`protocol: 'none' pero access.default exige identidad`)));
});

// --- domain: default de un campo enum ---

const enumLayers = (field, types = {}) => ({
  domain: { types, entities: { Product: entity({ status: field }) } },
  'use-cases': {},
});

test('default que es un valor del enum inline es válido', () => {
  const { errors } = run(enumLayers({ type: 'enum', values: ['DRAFT', 'ACTIVE'], default: 'DRAFT' }));
  assert.deepEqual(errors, []);
});

test('default ajeno al enum inline es error', () => {
  const { errors } = run(enumLayers({ type: 'enum', values: ['DRAFT', 'ACTIVE'], default: 'BORRADOR' }));
  assert.ok(
    errors.some((e) =>
      e.includes(`domain: Product.fields.status: default 'BORRADOR' no es un valor del enum (DRAFT, ACTIVE)`)
    )
  );
});

test('default ajeno a un enum nominal es error', () => {
  const { errors } = run(
    enumLayers({ type: 'ProductStatus', default: 'BORRADOR' }, { ProductStatus: { values: ['DRAFT', 'ACTIVE'] } })
  );
  assert.ok(errors.some((e) => e.includes(`default 'BORRADOR' no es un valor del enum (DRAFT, ACTIVE)`)));
});

test('default sobre un campo no enum no se comprueba', () => {
  const { errors } = run(enumLayers({ type: 'string', default: 'lo que sea' }));
  assert.deepEqual(errors, []);
});

test('default de un campo enum list comprueba cada valor', () => {
  const { errors } = run(enumLayers({ type: 'enum', values: ['A', 'B'], list: true, default: ['A', 'C'] }));
  assert.equal(errors.filter((e) => e.includes('no es un valor del enum')).length, 1);
  assert.ok(errors.some((e) => e.includes(`default 'C' no es un valor del enum`)));
});

// --- use-cases: consistencia de proyección (el hueco que solo aparecía generando) ---

// Dos operaciones que devuelven la misma entidad: una resuelve la referencia con
// embed y la otra la deja como id plano.
const projectionLayers = (listOutput) => ({
  domain: domainForEmbed(),
  'use-cases': {
    operations: {
      getOrder: {
        description: 'Recupera un pedido por su id.',
        kind: 'query',
        internal: true,
        input: { entity: 'Order' },
        output: { entity: 'Order', embed: ['customer'] },
      },
      listOrders: {
        description: 'Lista los pedidos.',
        kind: 'query',
        internal: true,
        output: listOutput,
      },
    },
  },
});

test('proyección asimétrica de una referencia embebida es aviso, no error', () => {
  const { errors, warnings } = run(projectionLayers({ entity: 'Order', list: true }));
  const projection = otherThanSortNotice(warnings);
  assert.deepEqual(errors, []);
  assert.equal(projection.length, 1, projection.join('\n'));
  assert.match(projection[0], /listOrders/);
  assert.match(projection[0], /'customerId' plano/);
  assert.match(projection[0], /getOrder/);
});

test('proyección coherente en todas las operaciones no avisa', () => {
  const { errors, warnings } = run(
    projectionLayers({ entity: 'Order', list: true, embed: ['customer'] })
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(otherThanSortNotice(warnings), []);
});

test('una referencia excluida del payload no cuenta como proyección asimétrica', () => {
  // Sin la relación no hay nada que embeber: dejarla fuera es una decisión
  // explícita del diseño, no un olvido.
  const { errors, warnings } = run(
    projectionLayers({ entity: 'Order', list: true, exclude: ['customer'] })
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(otherThanSortNotice(warnings), []);
});

// --- use-cases: caché con embed sin vía de invalidación ---

// getOrder cachea Order embebiendo customer. Los commands declaran qué eventos
// publica cada entidad: es de ahí de donde sale "qué muta lo cacheado".
const cacheEmbedLayers = ({
  invalidatedBy = ['OrderUpdated'],
  embed = ['customer'],
  customerEmits = ['CustomerUpdated'],
  events = ['OrderUpdated', 'CustomerUpdated'],
} = {}) => ({
  domain: domainForEmbed(),
  'use-cases': {
    operations: {
      getOrder: {
        description: 'Recupera un pedido por su id.',
        kind: 'query',
        internal: true,
        input: { entity: 'Order' },
        output: { entity: 'Order', embed },
        cache: { ttlSeconds: 300, keyFields: ['id'], invalidatedBy },
      },
      updateOrder: {
        description: 'Cambia un pedido.',
        kind: 'command',
        internal: true,
        input: { entity: 'Order' },
        // Misma proyección que getOrder: si no, salta el aviso de asimetría, que
        // es de otra regla y ensucia las aserciones de esta.
        output: { entity: 'Order', embed },
        emits: ['OrderUpdated'],
      },
      ...(customerEmits.length > 0
        ? {
            updateCustomer: {
              description: 'Cambia un cliente.',
              kind: 'command',
              internal: true,
              input: { entity: 'Customer' },
              output: { entity: 'Customer' },
              emits: customerEmits,
            },
          }
        : {}),
    },
  },
  messaging: {
    channels: { main: {} },
    publishing: {
      events: Object.fromEntries(events.map((name) => [name, { channel: 'main', payload: {} }])),
    },
  },
});

test('caché que embebe una entidad sin ningún evento propio es error', () => {
  // El caso de catalog: la ficha embebe brand/category y messaging no declara
  // ningún evento suyo. No es un olvido de invalidatedBy: es imposible invalidar.
  const { errors } = run(
    cacheEmbedLayers({ customerEmits: [], events: ['OrderUpdated'] })
  );
  assert.ok(
    errors.some((e) =>
      e.includes(
        `use-cases: getOrder.cache: la caché proyecta 'Customer' anidado (embed: [customer]) y ninguna operación publica eventos de 'Customer'`
      )
    ),
    errors.join('\n')
  );
});

test('caché que embebe una entidad con eventos que invalidatedBy no lista es error', () => {
  const { errors } = run(cacheEmbedLayers());
  assert.ok(
    errors.some((e) =>
      e.includes(
        `use-cases: getOrder.cache: la caché proyecta 'Customer' anidado (embed: [customer]) y invalidatedBy no incluye ninguno de los eventos que lo mutan [CustomerUpdated]`
      )
    ),
    errors.join('\n')
  );
});

test('caché que lista el evento de la entidad embebida es válida', () => {
  const { errors, warnings } = run(
    cacheEmbedLayers({ invalidatedBy: ['OrderUpdated', 'CustomerUpdated'] })
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('caché sin embed no exige eventos de las entidades referenciadas', () => {
  // Sin embed la referencia viaja como customerId: el objeto no se proyecta y no
  // hay nada que pueda quedar rancio.
  const { errors } = run(cacheEmbedLayers({ embed: [] }));
  assert.deepEqual(errors, []);
});

test('evento de la entidad cacheada ausente de invalidatedBy es aviso, no error', () => {
  const { errors, warnings } = run(
    cacheEmbedLayers({ invalidatedBy: ['CustomerUpdated'], embed: [] })
  );
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes(`use-cases: getOrder.cache: 'Order' cambia con [OrderUpdated], que invalidatedBy no lista`)
    ),
    warnings.join('\n')
  );
});

test('con --wip y sin capa messaging la caché no se contrasta todavía', () => {
  const layers = cacheEmbedLayers({ customerEmits: [], events: [] });
  delete layers.messaging;
  const { errors } = run(layers, true);
  assert.ok(
    !errors.some((e) => e.includes('la caché proyecta')),
    errors.join('\n')
  );
});

test('una sola operación por entidad no puede ser asimétrica consigo misma', () => {
  const layers = projectionLayers({ entity: 'Order' });
  delete layers['use-cases'].operations.listOrders;
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

// --- use-cases: sort (orden por defecto de una salida de varios elementos) ---

// Order tiene un campo escalar (placedAt), una colección (tags), un value object
// compuesto (total) y dos relaciones: lines (hija) y customer (otra raíz).
const domainForSort = () => ({
  types: { Money: { fields: { amount: { type: 'decimal' }, currency: { type: 'string' } } } },
  entities: {
    Order: entity(
      {
        placedAt: { type: 'datetime' },
        tags: { type: 'string', list: true },
        total: { type: 'Money' },
      },
      {
        relations: {
          lines: { entity: 'OrderLine', cardinality: 'one-to-many' },
          customer: { entity: 'Customer', cardinality: 'many-to-one' },
        },
      }
    ),
    OrderLine: entity(),
    Customer: entity({ name: { type: 'string' } }),
  },
  aggregates: {
    Order: { root: 'Order', entities: ['OrderLine'] },
    Customer: { root: 'Customer' },
  },
});

const sortLayers = (output) => ({
  domain: domainForSort(),
  'use-cases': {
    operations: {
      listOrders: {
        description: 'Lista los pedidos.',
        kind: 'query',
        internal: true,
        input: 'void',
        output,
      },
    },
  },
});

test('sort por un campo escalar propio es válido, con y sin dirección', () => {
  const { errors } = run(sortLayers({ entity: 'Order', list: true, sort: ['placedAt:desc', 'id'] }));
  assert.deepEqual(errors, []);
});

test('sort por un campo de un agregado embebido es válido si está en embed', () => {
  const { errors } = run(
    sortLayers({ entity: 'Order', paginated: true, embed: ['customer'], sort: ['customer.name:asc'] })
  );
  assert.deepEqual(errors, []);
});

test('sort por un agregado NO embebido es error: ordena por algo que no devuelve', () => {
  const { errors } = run(sortLayers({ entity: 'Order', paginated: true, sort: ['customer.name:asc'] }));
  assert.ok(
    errors.some((e) =>
      e.includes(`listOrders.output.sort 'customer.name:asc': ordena por un campo de 'Customer', que este payload no proyecta`)
    )
  );
});

test('sort sin list ni paginated es error: un objeto único no se ordena', () => {
  const { errors } = run(sortLayers({ entity: 'Order', sort: ['placedAt:asc'] }));
  assert.ok(errors.some((e) => e.includes('listOrders.output.sort: solo tiene sentido en una salida de varios elementos')));
});

test('sort en el input es error: el orden es una decisión de la salida', () => {
  const layers = sortLayers({ entity: 'Order', list: true });
  layers['use-cases'].operations.listOrders.input = { entity: 'Order', sort: ['placedAt:asc'] };
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes('listOrders.input.sort: el orden es una decisión de la salida')));
});

test('sort por un campo inexistente es error', () => {
  const { errors } = run(sortLayers({ entity: 'Order', list: true, sort: ['nope:asc'] }));
  assert.ok(errors.some((e) => e.includes(`listOrders.output.sort 'nope:asc': el campo 'nope' no existe en la entidad 'Order'`)));
});

test('sort por una colección es error: no define un orden', () => {
  const { errors } = run(sortLayers({ entity: 'Order', list: true, sort: ['tags:asc'] }));
  assert.ok(errors.some((e) => e.includes(`'tags' es una colección y no define un orden`)));
});

test('sort por un value object compuesto es error: hay que bajar a un subcampo', () => {
  const { errors } = run(sortLayers({ entity: 'Order', list: true, sort: ['total:asc'] }));
  assert.ok(errors.some((e) => e.includes(`'total' es un value object compuesto`)));
  // Y el subcampo sí vale.
  assert.deepEqual(run(sortLayers({ entity: 'Order', list: true, sort: ['total.amount:desc'] })).errors, []);
});

test('sort por una relación sin bajar a un campo es error', () => {
  const { errors } = run(sortLayers({ entity: 'Order', list: true, sort: ['customer:asc'] }));
  assert.ok(errors.some((e) => e.includes(`'customer' es una relación, no un campo`)));
});

test('sort con el mismo campo repetido es error', () => {
  const { errors } = run(sortLayers({ entity: 'Order', list: true, sort: ['placedAt:asc', 'placedAt:desc'] }));
  assert.ok(errors.some((e) => e.includes(`ya está declarado; un criterio de orden no se repite`)));
});

// La ausencia de sort, que es el caso que esconde una DECISIÓN en vez de una errata:
// hay un default correcto (orden por id), así que nada se rompe y nada avisaba. El
// orden es contrato, y cuando el diseño calla la decisión se toma fuera de él — en la
// prosa de validation-scenarios.md o en el adaptador que el agente improvisa.
test('una salida paginada sin sort avisa: el orden es contrato y aquí no se declara', () => {
  const { errors, warnings } = run(sortLayers({ entity: 'Order', paginated: true }));
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some(
      (w) =>
        w.includes('listOrders.output: devuelve varios elementos y no declara') &&
        w.includes('el orden será por id del agregado') &&
        w.includes("quien no pide un '?sort='")
    ),
    warnings.join('\n')
  );
});

test('una salida list sin sort avisa, con la consecuencia de una colección y no de una página', () => {
  const { warnings } = run(sortLayers({ entity: 'Order', list: true }));
  const warning = warnings.find((w) => w.includes('listOrders.output: devuelve varios elementos'));
  assert.ok(warning, warnings.join('\n'));
  assert.ok(warning.includes('el orden en el que el consumidor recibe la colección'), warning);
});

test('declarar sort apaga el aviso: es una decisión tomada, no un hueco', () => {
  const { warnings } = run(sortLayers({ entity: 'Order', list: true, sort: ['placedAt:desc'] }));
  assert.ok(!warnings.some((w) => w.includes('no declara')), warnings.join('\n'));
});

// El aviso es de una salida de VARIOS elementos: sobre un objeto único no hay orden que
// declarar, y emitirlo ahí lo convertiría en ruido que se aprende a ignorar.
test('una salida de un solo objeto no avisa por no declarar sort', () => {
  const { warnings } = run(sortLayers({ entity: 'Order' }));
  assert.ok(!warnings.some((w) => w.includes('devuelve varios elementos')), warnings.join('\n'));
});

// --- use-cases: transiciones de lifecycle y compensaciones verificables --------
// El enlace operación ↔ máquina de estados, y las dos propiedades que hacen que una
// compensación funcione: que no se aplique dos veces y que devuelva el estado propio a
// donde estaba. Sin ellas una compensación valida en verde y falla en cada ejecución
// (el guard del generador rechaza la transición no declarada) o deshace dos veces el
// mismo trabajo.

const compLayers = () => ({
  domain: {
    entities: {
      Product: entity(
        {
          status: { type: 'enum', values: ['draft', 'active', 'retired'], default: 'draft' },
          // La marca de la espera: desde cuándo se cuenta el silencio del registro. La
          // declara la activación en `awaitingSince`, obligatoria con `reconciledBy`.
          recordWithdrawalAwaitingSince: { type: 'timestamp' },
        },
        {
          lifecycle: {
            field: 'status',
            transitions: { draft: ['active'], active: ['retired'], retired: ['active'] },
          },
        }
      ),
    },
  },
  'use-cases': {
    operations: {
      publishProduct: {
        description: 'Publica un producto en borrador.',
        kind: 'command',
        input: { fields: { productId: { type: 'uuid', required: true } } },
        output: 'void',
        transitions: [{ entity: 'Product', from: ['draft'], to: 'active' }],
      },
      retireProduct: {
        description: 'Retira un producto del catálogo.',
        kind: 'command',
        input: { fields: { productId: { type: 'uuid', required: true } } },
        output: 'void',
        transitions: [{ entity: 'Product', from: ['active'], to: 'retired' }],
      },
      reactivateProduct: {
        description: 'Devuelve a activo un producto cuya retirada rechazó el registro.',
        kind: 'command',
        internal: true,
        input: { fields: { productId: { type: 'uuid', required: true } } },
        output: 'void',
        transitions: [{ entity: 'Product', from: ['retired'], to: 'active' }],
      },
      // La pata del silencio: si el registro nunca contesta, ningún evento llega y
      // la compensación no se dispara. Lo que no pasa solo lo detecta un barrido.
      reconcileWithdrawals: {
        description: 'Revisa las retiradas inscritas que siguen sin desenlace del registro.',
        kind: 'command',
        internal: true,
        input: 'void',
        output: 'void',
        schedule: { cron: '0 0 * * * *' },
      },
    },
  },
  api: {
    endpoints: {
      publishProduct: { method: 'POST', path: '/products/{productId}/publish' },
      retireProduct: { method: 'POST', path: '/products/{productId}/retire' },
    },
  },
  security: { authentication: { protocol: 'oidc' }, access: { default: { level: 'required' } } },
  messaging: {
    subscriptions: {
      WithdrawalRejected: {
        source: 'compliance',
        payload: { productId: { type: 'uuid', required: true } },
        triggers: 'reactivateProduct',
        // Una compensación puede llegar antes del hecho que compensa: los reintentos
        // absorben esa carrera y la DLQ es la red. Sin nada, el mensaje se pierde.
        onFailure: { retry: { maxAttempts: 5, backoff: 'exponential' }, deadLetter: true },
      },
    },
  },
  'http-clients': {
    clients: {
      compliance: {
        purpose: 'Inscribir las retiradas en el registro regulatorio.',
        calls: { recordWithdrawal: { contract: 'POST /withdrawals -> inscripción de la retirada.' } },
      },
    },
  },
  dependencies: {
    dependencies: {
      compliance: {
        description: 'Registro regulatorio de retiradas.',
        contract: { version: '1.0.0' },
        activations: {
          recordWithdrawal: {
            // El barrido aparece aquí porque su desenlace es volver a encargar la
            // inscripción: sin ese enlace (o sin una transición de salida) sería un
            // `schedule` que no toca nada de lo que dice reconciliar.
            triggeredBy: ['retireProduct', 'reconcileWithdrawals'],
            via: { client: 'compliance', call: 'recordWithdrawal' },
            effect: 'La retirada queda inscrita en el registro regulatorio.',
            awaits: 'outcome',
            reconciledBy: 'reconcileWithdrawals',
            // Cuánto silencio del registro se tolera antes de volver a insistir: el barrido
            // no se puede escribir sin este número, así que no declararlo solo se lo pasa a
            // quien construya.
            unansweredAfterSeconds: 3600,
            awaitingSince: 'recordWithdrawalAwaitingSince',
            onFailure: { action: 'ignore' },
          },
        },
        compensations: [
          {
            onEvent: 'WithdrawalRejected',
            undoes: 'recordWithdrawal',
            description: 'El registro rechazó la retirada; el producto vuelve a activo.',
          },
        ],
      },
    },
  },
});

const transitionOf = (layers, op = 'reactivateProduct') => layers['use-cases'].operations[op].transitions[0];

// Sin envoltura Keel no hay `metadata.eventId` del que deduplicar, y esa es la única
// forma de dejar la suscripción sin clave de listener: con el default (`keel`) el
// consumidor siempre tiene una, así que las guardas del dominio no se pueden probar
// aisladas sobre el fixture base.
const withoutKeelEnvelope = (layers) => {
  layers.messaging.subscriptions.WithdrawalRejected.contract = { envelope: 'none' };
  return layers;
};

test('reconciledBy sin umbral de espera es aviso', () => {
  // El barrido elige candidatos por «lleva demasiado sin desenlace», así que el número
  // hace falta sí o sí: no declararlo no lo elimina, lo traslada a quien construya. Y
  // cuál es el correcto depende del proveedor —cuánto tarda razonablemente en
  // contestar—, que es justo lo que el diseñador sabe.
  const layers = compLayers();
  delete layers.dependencies.dependencies.compliance.activations.recordWithdrawal.unansweredAfterSeconds;
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes("reconciledBy: no declara 'unansweredAfterSeconds'")), warnings.join(' | '));
});

// La marca de la espera (`awaitingSince`, DSL 2.10). El estado dice QUE espera; el barrido
// necesita saber DESDE CUÁNDO, y hasta la 2.10 el nombre del campo era una convención que
// nadie comprobaba: un diseño sin marca validaba en verde y otro que la nombraba por lo que
// significa recibía un hueco falso del generador. Lo que se puede comprobar mecánicamente
// —que exista, que sea tiempo y que no la reescriba la auditoría— se comprueba aquí.

test('awaitingSince hacia un campo que no existe es error', () => {
  const layers = compLayers();
  layers.dependencies.dependencies.compliance.activations.recordWithdrawal.awaitingSince = 'noExiste';
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes("awaitingSince: 'noExiste' no es un campo de Product")),
    errors.join(' | ')
  );
});

test('awaitingSince sobre un campo que no es timestamp es error', () => {
  const layers = compLayers();
  layers.dependencies.dependencies.compliance.activations.recordWithdrawal.awaitingSince = 'status';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes("'status' es enum")), errors.join(' | '));
});

test('una marca que gestiona la auditoría es error: rejuvenece y el barrido no la alcanza nunca', () => {
  // El fallo que pasa todas las pruebas —donde nada más toca la entidad— y en producción
  // no se acaba nunca: cada escritura devuelve la marca a cero y la entidad no vuelve a ser
  // candidata jamás. Nada lo delata, así que error y no aviso.
  const layers = compLayers();
  layers.domain.entities.Product.fields.updatedAt = { type: 'timestamp' };
  layers.dependencies.dependencies.compliance.activations.recordWithdrawal.awaitingSince = 'updatedAt';
  layers.persistence = { ...(layers.persistence ?? {}), audit: { timestamps: 'declared' } };
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes("'updatedAt' lo gestiona la auditoría")), errors.join(' | '));

  // Sin auditoría de timestamps, el campo es del diseño y nadie lo reescribe: deja de serlo.
  layers.persistence.audit.timestamps = 'none';
  assert.deepEqual(
    run(layers).errors.filter((e) => e.includes('awaitingSince')),
    []
  );
});

test('createdAt como marca es aviso, no error: solo vale si la espera empieza al crearse', () => {
  const layers = compLayers();
  layers.domain.entities.Product.fields.createdAt = { type: 'timestamp' };
  layers.dependencies.dependencies.compliance.activations.recordWithdrawal.awaitingSince = 'createdAt';
  layers.persistence = { ...(layers.persistence ?? {}), audit: { timestamps: 'none' } };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors.filter((e) => e.includes('awaitingSince')), []);
  assert.ok(
    warnings.some((w) => w.includes("'createdAt' es cuándo nació Product")),
    warnings.join(' | ')
  );
});

test('compensación con transición de vuelta declarada no produce errores ni warnings', () => {
  const { errors, warnings } = run(compLayers());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

// ─── La saga incompleta ──────────────────────────────────────────────────────

const dosProveedores = () => {
  const layers = compLayers();
  layers['http-clients'].clients.warehouse = {
    purpose: 'Reservar el hueco de almacén de la retirada.',
    calls: { bookSlot: { contract: 'POST /slots reserva el hueco de retirada.' } },
  };
  layers.dependencies.dependencies.warehouse = {
    description: 'Almacén, que reserva el hueco físico de la retirada.',
    activations: {
      bookSlot: {
        triggeredBy: ['retireProduct'],
        via: { client: 'warehouse', call: 'bookSlot' },
        effect: 'El hueco de almacén queda reservado para la retirada.',
        onFailure: { action: 'ignore' },
      },
    },
  };
  return layers;
};

test('encargar a dos proveedores compensando solo uno avisa', () => {
  const { warnings } = run(dosProveedores());
  assert.ok(
    warnings.some((w) => w.includes(`'retireProduct' encarga trabajo a varios proveedores`)),
    warnings.join('\n')
  );
  assert.ok(warnings.some((w) => w.includes('warehouse.bookSlot queda hecho')));
});

test('sin ninguna compensación declarada no hay contradicción que señalar', () => {
  const layers = dosProveedores();
  delete layers.dependencies.dependencies.compliance.compensations;
  const { warnings } = run(layers);
  assert.ok(!warnings.some((w) => w.includes('encarga trabajo a varios proveedores')), warnings.join('\n'));
});

// ─── El silencio: el desenlace en el que no llega ningún evento ──────────────

test('compensación sin reconciliación avisa: si el evento no llega, nadie deshace nada', () => {
  const layers = compLayers();
  delete layers.dependencies.dependencies.compliance.activations.recordWithdrawal.reconciledBy;
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes(`la compensación solo se dispara si llega 'WithdrawalRejected'`)),
    warnings.join('\n')
  );
});

test('la reconciliación tiene que correr sola: sin schedule es error', () => {
  const layers = compLayers();
  delete layers['use-cases'].operations.reconcileWithdrawals.schedule;
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`'reconcileWithdrawals' no declara 'schedule'`)),
    errors.join('\n')
  );
});

test('reconciledBy hacia una operación inexistente es error', () => {
  const layers = compLayers();
  layers.dependencies.dependencies.compliance.activations.recordWithdrawal.reconciledBy = 'noExiste';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`la operación 'noExiste' no existe en use-cases`)));
});

// Lo que cuesta barrer. La consulta del barrido filtra por el estado de espera y corre
// cada N minutos EN CADA RÉPLICA: sin un índice que empiece por ese campo recorre la
// tabla entera, para siempre y sin que nada lo señale — el diseño sigue siendo correcto,
// solo caro, así que no hay error que lo delate ni escenario que lo ejercite.
const withPersistedProduct = (indexes) => {
  const layers = compLayers();
  layers.domain.entities.Product.fields.recordWithdrawalAwaitingSince = { type: 'timestamp' };
  layers.persistence = {
    default: { model: 'relational' },
    entities: { Product: indexes ? { indexes } : {} },
  };
  return layers;
};

test('reconciliación sobre una entidad sin índice por el estado de espera avisa', () => {
  const { errors, warnings } = run(withPersistedProduct(null));
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) => w.includes(`ningún índice de persistence.entities.Product empieza por 'status'`)),
    warnings.join('\n')
  );
});

test('el aviso del índice del barrido mira la CABECERA del índice, no que el campo aparezca', () => {
  // Con el índice que sirve, nada que decir.
  const bien = run(withPersistedProduct([['status', 'recordWithdrawalAwaitingSince']]));
  assert.deepEqual(bien.errors, []);
  assert.ok(!bien.warnings.some((w) => w.includes('empieza por')), bien.warnings.join('\n'));

  // Y un índice que solo CONTIENE el estado no sirve para filtrar por él: sigue el aviso.
  const mal = run(withPersistedProduct([['recordWithdrawalAwaitingSince', 'status']]));
  assert.ok(
    mal.warnings.some((w) => w.includes(`empieza por 'status'`)),
    mal.warnings.join('\n')
  );
});

// Sin capa persistence no hay tabla de la que hablar: el aviso no aplica y no se inventa.
test('sin capa persistence el aviso del índice del barrido no se emite', () => {
  const { warnings } = run(compLayers());
  assert.ok(!warnings.some((w) => w.includes('empieza por')), warnings.join('\n'));
});

test('DLQ sin forma declarada de reejecución avisa', () => {
  const layers = compLayers();
  // Con reconciliación no hay aviso: el barrido es la vía de reejecución.
  assert.ok(!run(layers).warnings.some((w) => w.includes('DLQ es trabajo sin deshacer')));

  delete layers.dependencies.dependencies.compliance.activations.recordWithdrawal.reconciledBy;
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes('no tiene forma declarada de reejecutarse')),
    warnings.join('\n')
  );
});

// Cuando el evento lo publica el propio proveedor, avisarnos y rechazar el trabajo son la
// misma acción: ya lo sabe. La deuda aparece cuando el disparo viene de otro sitio y él
// sigue creyendo que su encargo está en pie.
const thirdPartyTrigger = () => {
  const layers = compLayers();
  layers.messaging.subscriptions.WithdrawalRejected.source = 'orders';
  layers.dependencies.dependencies.orders = {
    description: 'Servicio de pedidos.',
    contract: { version: '1.0.0' },
  };
  return layers;
};

const localWarnings = (layers) =>
  run(layers).warnings.filter((w) => w.includes('sigue en pie'));

test('compensación disparada por un tercero sin vuelta al proveedor avisa', () => {
  const warnings = localWarnings(thirdPartyTrigger());
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.ok(warnings[0].includes("'reactivateProduct'") && warnings[0].includes("'compliance'"));
});

test('declarar la activación de vuelta silencia el aviso de compensación sin alcance', () => {
  const layers = thirdPartyTrigger();
  layers['http-clients'].clients.compliance.calls.cancelWithdrawal = {
    contract: 'DELETE /withdrawals/{id} -> baja de la inscripción.',
  };
  layers.dependencies.dependencies.compliance.activations.cancelWithdrawal = {
    triggeredBy: ['reactivateProduct'],
    via: { client: 'compliance', call: 'cancelWithdrawal' },
    effect: 'La inscripción de la retirada queda anulada.',
    onFailure: { action: 'ignore' },
  };
  assert.deepEqual(localWarnings(layers), []);
});

test('spec sin transitions no falla por la ausencia del campo (retrocompatibilidad)', () => {
  const layers = compLayers();
  for (const op of Object.values(layers['use-cases'].operations)) delete op.transitions;
  // La compensación se queda sin su guard, así que el error de idempotencia sí aparece;
  // lo que no puede aparecer es un fallo por la ausencia del campo en sí.
  const { errors } = run(layers);
  assert.ok(!errors.some((e) => e.includes('.transitions[')), errors.join('\n'));
});

// A1-A5: la transición que una operación declara existe de verdad en el lifecycle.

test('transitions hacia una entidad inexistente es error', () => {
  const layers = compLayers();
  transitionOf(layers).entity = 'Producto';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`transitions[0].entity: la entidad 'Producto' no existe en domain: entities`)));
});

test('transitions sobre una entidad sin lifecycle es error', () => {
  const layers = compLayers();
  delete layers.domain.entities.Product.lifecycle;
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`la entidad 'Product' no declara lifecycle`)));
});

test('transitions con un estado destino fuera del enum es error', () => {
  const layers = compLayers();
  transitionOf(layers).to = 'revived';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`transitions[0].to: el estado 'revived' no es un valor del enum 'status'`)));
});

test('transitions con un estado origen fuera del enum es error', () => {
  const layers = compLayers();
  transitionOf(layers).from = ['withdrawn'];
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`transitions[0].from: el estado 'withdrawn' no es un valor del enum 'status'`)));
});

test('transición que el lifecycle no declara es error, aunque ambos estados existan', () => {
  // El caso real: el diseño declara `retired` terminal y una compensación necesita
  // volver a `active`. Antes validaba en verde y el guard del generador la rechazaba
  // en cada ejecución.
  const layers = compLayers();
  layers.domain.entities.Product.lifecycle.transitions.retired = [];
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(
        `transitions[0]: la transición 'retired' → 'active' no está declarada en domain: Product.lifecycle.transitions.retired`
      )
    ),
    errors.join('\n')
  );
});

test('una query que declara transitions es error', () => {
  const layers = compLayers();
  layers['use-cases'].operations.reactivateProduct.kind = 'query';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`reactivateProduct.transitions: una operación kind: query no cambia de estado`)));
});

// A6: la inversa — una transición que nadie ejecuta no es contrato, es intención.

test('transición del lifecycle que ninguna operación ejecuta es warning', () => {
  const layers = compLayers();
  layers.domain.entities.Product.lifecycle.transitions.draft = ['active', 'retired'];
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes(`transitions.draft: ninguna operación de use-cases declara ejecutar 'draft' → 'retired'`)),
    warnings.join('\n')
  );
});

// B1-B4: las propiedades de una compensación.

test('compensación disparada por una query es error', () => {
  const layers = compLayers();
  const op = layers['use-cases'].operations.reactivateProduct;
  op.kind = 'query';
  delete op.transitions;
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`la operación 'reactivateProduct' que dispara la compensación es kind: query`)));
});

test('compensación sin ningún mecanismo que impida aplicarla dos veces es error', () => {
  const layers = withoutKeelEnvelope(compLayers());
  delete layers['use-cases'].operations.reactivateProduct.transitions;
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`nada impide que 'reactivateProduct' se aplique dos veces`)),
    errors.join('\n')
  );
});

test('los dos mecanismos de idempotencia de evento valen por separado', () => {
  const withMessageId = compLayers();
  delete withMessageId['use-cases'].operations.reactivateProduct.transitions;
  withMessageId.messaging.subscriptions.WithdrawalRejected.payload.eventId = { type: 'uuid', required: true };
  withMessageId.messaging.subscriptions.WithdrawalRejected.contract = {
    messageId: { location: 'field', name: 'eventId' },
  };
  const messageIdRun = run(withMessageId);
  assert.ok(!messageIdRun.errors.some((e) => e.includes('se aplique dos veces')), messageIdRun.errors.join('\n'));

  // El segundo es el fixture base: la transición retired → active no se puede repetir
  // porque 'active' no está entre sus propios orígenes.
  assert.ok(!run(compLayers()).errors.some((e) => e.includes('se aplique dos veces')));
});

test('la envoltura Keel es por sí sola la clave de deduplicación del listener', () => {
  // `metadata.eventId` existe sin declarar nada y alimenta el mismo `processed_event` que
  // un messageId declarado, así que vale igual como guarda. Exigir el messageId aquí sería
  // pedir un dato que ningún emisor Keel escribe: la envoltura viaja en el cuerpo.
  const layers = compLayers();
  delete layers['use-cases'].operations.reactivateProduct.transitions;
  layers.messaging.subscriptions.WithdrawalRejected.onFailure = { retry: { maxAttempts: 3 } };
  const { errors } = run(layers);
  assert.ok(!errors.some((e) => e.includes('se aplique dos veces')), errors.join('\n'));
});

test('idempotency NO protege la reentrega de un evento: es el otro eje de repetición', () => {
  // La clave de `idempotency` llega por la cabecera Idempotency-Key, que el broker no
  // manda: declararla no impide que la compensación se aplique dos veces. Darla por
  // buena sería peor que no tener la regla — protegería en el papel y no en el código.
  const layers = withoutKeelEnvelope(compLayers());
  const op = layers['use-cases'].operations.reactivateProduct;
  delete op.transitions;
  op.idempotency = { keySource: 'payload-hash' };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`nada impide que 'reactivateProduct' se aplique dos veces`)),
    errors.join('\n')
  );
});

// La otra mitad: un bloque `idempotency` cuya clave no tiene por dónde entrar.

test('idempotency en una operación sin endpoint HTTP es error', () => {
  const layers = compLayers();
  // reactivateProduct es internal y solo la dispara la suscripción.
  layers['use-cases'].operations.reactivateProduct.idempotency = { keySource: 'client-key' };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`reactivateProduct.idempotency: la clave llega por la cabecera Idempotency-Key y esta operación no tiene endpoint HTTP`)
    ),
    errors.join('\n')
  );
  // Y el mensaje apunta al mecanismo correcto para su disparador.
  assert.ok(errors.some((e) => e.includes('la reentrega se ataja con contract.messageId')));
});

// `payload-field` (DSL 2.12): la clave ES un campo del contrato, así que no depende del transporte.
// Es el hueco que cerró — un diseño real tenía una operación con dos puertas cuya clave viajaba en
// el cuerpo, y lo único que el DSL sabía decir describía una cabecera que la mitad de las entradas
// no lleva.

test('con payload-field una operación sin endpoint SÍ puede declarar idempotencia', () => {
  // Antes era error para cualquier keySource. Con la clave en el cuerpo no hay cabecera que echar
  // de menos: una operación disparada solo por una suscripción la recibe igual.
  const layers = compLayers();
  const op = layers['use-cases'].operations.reactivateProduct;
  op.input = { fields: { requestKey: { type: 'string', required: true } } };
  op.idempotency = { keySource: 'payload-field', keyField: 'requestKey' };
  const { errors } = run(layers);
  assert.ok(
    !errors.some((e) => e.includes('no tiene endpoint HTTP que la reciba')),
    errors.join('\n')
  );
});

/** El barrido con las DOS puertas: endpoint HTTP y suscripción disparándolo. */
function twoDoorLayers() {
  const layers = compLayers();
  const op = layers['use-cases'].operations.reactivateProduct;
  delete op.internal;
  delete op.transitions;
  layers.api = layers.api ?? { endpoints: {} };
  layers.api.endpoints = layers.api.endpoints ?? {};
  layers.api.endpoints.reactivateProduct = { method: 'POST', path: '/products/{id}/reactivate' };
  return layers;
}

test('client-key con dos puertas es error: el broker no manda la cabecera', () => {
  // La doctrina ya estaba escrita para compensaciones; esta es su forma general. La cabecera cierra
  // la puerta HTTP y no existe en la del broker, así que la mitad de las entradas no deduplica.
  const layers = twoDoorLayers();
  layers['use-cases'].operations.reactivateProduct.idempotency = { keySource: 'client-key' };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes('entra por DOS puertas') && e.includes('reactivateProduct')),
    errors.join('\n')
  );
});

test('con payload-field las dos puertas quedan cubiertas', () => {
  // La salida que el error propone tiene que funcionar de verdad: si señalara un camino cerrado,
  // el mensaje mandaría a dar vueltas.
  const layers = twoDoorLayers();
  const op = layers['use-cases'].operations.reactivateProduct;
  op.input = { fields: { requestKey: { type: 'string', required: true } } };
  op.idempotency = { keySource: 'payload-field', keyField: 'requestKey' };
  const { errors } = run(layers);
  assert.ok(!errors.some((e) => e.includes('entra por DOS puertas')), errors.join('\n'));
});

test('con la puerta del broker ya cerrada, client-key y dos puertas no es error', () => {
  // `contract.messageId` deduplica el mensaje en el listener: cada puerta tiene la suya y no falta
  // ninguna. Marcarlo como error aquí exigiría un cambio que no arregla nada.
  const layers = twoDoorLayers();
  layers['use-cases'].operations.reactivateProduct.idempotency = { keySource: 'client-key' };
  for (const sub of Object.values(layers.messaging.subscriptions)) {
    if (sub.triggers === 'reactivateProduct') {
      sub.contract = { ...(sub.contract ?? {}), messageId: { name: 'eventId' } };
    }
  }
  const { errors } = run(layers);
  assert.ok(!errors.some((e) => e.includes('entra por DOS puertas')), errors.join('\n'));
});

test('el keyField tiene que ser un campo del input', () => {
  // Nombrar un campo que no está deja el mecanismo apuntando a la nada, y nada lo diría después.
  const layers = compLayers();
  const op = layers['use-cases'].operations.reactivateProduct;
  op.input = { fields: { requestKey: { type: 'string', required: true } } };
  op.idempotency = { keySource: 'payload-field', keyField: 'noExiste' };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`keyField: 'noExiste' no es un campo del input`)),
    errors.join('\n')
  );
});

// Lo que se guarda de la primera ejecución es un id: con eso se reconstruye una
// ficha, no una lista — que depende del estado del resto del sistema al responder.
test('idempotency sobre una respuesta que no se reconstruye desde un id avisa', () => {
  const layers = compLayers();
  const op = layers['use-cases'].operations.retireProduct;
  op.idempotency = { keySource: 'client-key', ttlSeconds: 3600 };
  op.output = { entity: 'Product', list: true };
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes('la respuesta es una lista y de la primera')),
    warnings.join('\n')
  );

  op.output = { entity: 'Product' };
  assert.ok(!run(layers).warnings.some((w) => w.includes('de la primera ejecución solo se guarda')));
});

test('idempotency en una operación expuesta por HTTP es su sitio y no produce error', () => {
  const layers = compLayers();
  layers['use-cases'].operations.retireProduct.idempotency = { keySource: 'client-key', ttlSeconds: 3600 };
  const { errors } = run(layers);
  assert.ok(!errors.some((e) => e.includes('.idempotency:')), errors.join('\n'));
});

test('sin endpoint y sin suscripción el mensaje señala la clave natural, no messageId', () => {
  const layers = compLayers();
  const ops = layers['use-cases'].operations;
  ops.purgeDrafts = {
    description: 'Elimina los borradores caducados una vez al día.',
    kind: 'command',
    input: { fields: {} },
    output: 'void',
    schedule: { cron: '0 0 3 * * *' },
    idempotency: { keySource: 'payload-hash' },
  };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes('purgeDrafts.idempotency') && e.includes('la clave natural en persistence')),
    errors.join('\n')
  );
});

test('una transición cuyo destino es también origen no basta como guard de idempotencia', () => {
  const layers = withoutKeelEnvelope(compLayers());
  layers.domain.entities.Product.lifecycle.transitions.active = ['retired', 'active'];
  transitionOf(layers).from = ['retired', 'active'];
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`nada impide que 'reactivateProduct' se aplique dos veces`)),
    errors.join('\n')
  );
});

test('sobre un canal externo el guard de lifecycle a solas es warning: la reentrega acaba en la DLQ', () => {
  const layers = compLayers();
  layers.messaging.channels = { 'compliance-events': { external: true } };
  layers.messaging.subscriptions.WithdrawalRejected.channel = 'compliance-events';
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes('solo la frena el guard de lifecycle')),
    warnings.join('\n')
  );
});

test('compensación que no devuelve el estado que movió el trabajo encargado es warning', () => {
  // retireProduct mueve Product a retired y dispara la activación; si la compensación
  // no declara ninguna transición sobre Product, el producto se queda retirado.
  const layers = compLayers();
  delete layers['use-cases'].operations.reactivateProduct.transitions;
  layers['use-cases'].operations.reactivateProduct.idempotency = { keySource: 'payload-hash' };
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes(`'reactivateProduct' no declara ninguna transición sobre esa entidad`)),
    warnings.join('\n')
  );
});

// C: la regla general de reentrega, que la doc anunciaba como error y nadie aplicaba.

test('suscripción con reintentos y nada que impida el doble efecto es error', () => {
  const layers = withoutKeelEnvelope(compLayers());
  delete layers['use-cases'].operations.reactivateProduct.transitions;
  layers.messaging.subscriptions.WithdrawalRejected.onFailure = { retry: { maxAttempts: 3 } };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`reintenta (maxAttempts: 3) y nada impide que 'reactivateProduct' se aplique dos veces`)),
    errors.join('\n')
  );
});

test('suscripción con reintentos protegida por la transición no es error', () => {
  const layers = compLayers();
  layers.messaging.subscriptions.WithdrawalRejected.onFailure = { retry: { maxAttempts: 3 } };
  const { errors } = run(layers);
  assert.ok(!errors.some((e) => e.includes('reintenta (maxAttempts: 3)')), errors.join('\n'));
});

// Guarda de puerta vs. guarda de dominio. `contract.messageId` cierra el listener y la
// idempotency HTTP cierra el filtro: cada una cubre su camino y no sabe de la otra. Solo
// la transición vive en el dominio, por debajo de las dos puertas. Si la compensación se
// puede lanzar también a mano, es la única que sirve.

// La compensación del fixture es `internal: true`; exponerla exige quitar esa marca,
// porque un endpoint sobre una operación interna ya es error por su cuenta.
const exposedCompensation = () => {
  const layers = compLayers();
  const op = layers['use-cases'].operations.reactivateProduct;
  delete op.internal;
  layers.api.endpoints.reactivateProduct = { method: 'POST', path: '/products/{productId}/reactivate' };
  return layers;
};

test('compensación también invocable por HTTP protegida solo por messageId es error', () => {
  const layers = exposedCompensation();
  delete layers['use-cases'].operations.reactivateProduct.transitions;
  layers.messaging.subscriptions.WithdrawalRejected.payload.eventId = { type: 'uuid', required: true };
  layers.messaging.subscriptions.WithdrawalRejected.contract = {
    messageId: { location: 'field', name: 'eventId' },
  };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`'reactivateProduct' se puede ejecutar por dos caminos`)),
    errors.join('\n')
  );
});

test('la transición cubre los dos caminos: sin error aunque la compensación se exponga', () => {
  // El fixture base ya declara retired → active, que es irrepetible.
  const { errors } = run(exposedCompensation());
  assert.ok(!errors.some((e) => e.includes('dos caminos')), errors.join('\n'));
});

test('añadir idempotency no salva a la compensación expuesta: no cierra la puerta que falta', () => {
  const layers = exposedCompensation();
  const op = layers['use-cases'].operations.reactivateProduct;
  delete op.transitions;
  op.idempotency = { keySource: 'client-key', ttlSeconds: 3600 };
  layers.messaging.subscriptions.WithdrawalRejected.payload.eventId = { type: 'uuid', required: true };
  layers.messaging.subscriptions.WithdrawalRejected.contract = {
    messageId: { location: 'field', name: 'eventId' },
  };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`'reactivateProduct' se puede ejecutar por dos caminos`)),
    errors.join('\n')
  );
});

test('la compensación interna de siempre no la toca la regla', () => {
  // Un solo camino: la protección de ese camino basta, se llame como se llame.
  const layers = compLayers();
  delete layers['use-cases'].operations.reactivateProduct.transitions;
  layers.messaging.subscriptions.WithdrawalRejected.payload.eventId = { type: 'uuid', required: true };
  layers.messaging.subscriptions.WithdrawalRejected.contract = {
    messageId: { location: 'field', name: 'eventId' },
  };
  const { errors } = run(layers);
  assert.ok(!errors.some((e) => e.includes('dos caminos')), errors.join('\n'));
});

// --- Compensación: llegar fuera de orden y par hacer/deshacer -----------------
// Entre confirmar nuestro trabajo y que el proveedor publique su fallo no hay orden
// garantizado: la compensación puede llegar ANTES del hecho que compensa, y entonces
// se rechaza. Lo que decide si se pierde o se recupera es la política de la suscripción.

const withFailurePolicy = (onFailure) => {
  const layers = compLayers();
  const sub = layers.messaging.subscriptions.WithdrawalRejected;
  if (onFailure) sub.onFailure = onFailure;
  else delete sub.onFailure;
  return layers;
};

test('compensación sin reintentos ni deadLetter es error: la llegada fuera de orden se pierde', () => {
  const { errors } = run(withFailurePolicy(null));
  assert.ok(
    errors.some((e) => e.includes('no reintenta ni tiene deadLetter')),
    errors.join('\n')
  );
});

test('compensación con deadLetter pero sin reintentos es aviso, no error', () => {
  const { errors, warnings } = run(withFailurePolicy({ deadLetter: true }));
  assert.ok(!errors.some((e) => e.includes('no reintenta ni tiene deadLetter')), errors.join('\n'));
  assert.ok(
    warnings.some((w) => w.includes('acaba en la DLQ al primer intento')),
    warnings.join('\n')
  );
});

test('compensación con reintentos no produce ninguno de los dos', () => {
  const { errors, warnings } = run(
    withFailurePolicy({ retry: { maxAttempts: 5, backoff: 'exponential' }, deadLetter: true })
  );
  assert.ok(!errors.some((e) => e.includes('fuera de orden') || e.includes('no reintenta')), errors.join('\n'));
  assert.ok(!warnings.some((w) => w.includes('DLQ al primer intento')), warnings.join('\n'));
});

test('compensación sin undoes habiendo activaciones es error, no aviso', () => {
  // Su ausencia apaga en cascada las cuatro reglas que dependen de saber qué encargo
  // se deshace, así que un aviso no estaba proporcionado al daño.
  const layers = withFailurePolicy({ retry: { maxAttempts: 3 }, deadLetter: true });
  delete layers.dependencies.dependencies.compliance.compensations[0].undoes;
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes("no declara 'undoes' habiendo activaciones")),
    errors.join('\n')
  );
});

test('sin activaciones, la ausencia de undoes no se avisa: no hay a qué apuntar', () => {
  const layers = withFailurePolicy({ retry: { maxAttempts: 3 }, deadLetter: true });
  const dep = layers.dependencies.dependencies.compliance;
  delete dep.compensations[0].undoes;
  delete dep.activations;
  // Sin activaciones la dependencia necesita otro motivo de existir: un need la sostiene.
  dep.needs = {
    withdrawalStatus: {
      description: 'Estado regulatorio de la retirada de un producto.',
      usedBy: ['retireProduct'],
      strategy: 'on-demand',
      fetchedFrom: { client: 'compliance', call: 'recordWithdrawal' },
    },
  };
  const { warnings } = run(layers);
  assert.ok(!warnings.some((w) => w.includes("no declara 'undoes'")), warnings.join('\n'));
});

// ---------------------------------------------------------------------------
// La entrega garantizada, el destino de la vuelta y el reintento del llamante.
// Tres huecos de la misma familia: el diseño declara una garantía y nada la
// contrastaba con la capa que tiene que sostenerla.
// ---------------------------------------------------------------------------

test('reliability: outbox sin capa persistence es error', () => {
  const layers = compLayers();
  layers.messaging.publishing = { reliability: 'outbox', events: { ProductRetired: { payload: {} } } };
  layers['use-cases'].operations.retireProduct.emits = ['ProductRetired'];
  const conPersistence = run({ ...layers, persistence: { default: { model: 'relational' }, entities: { Product: {} } } });
  assert.ok(!conPersistence.errors.some((e) => e.includes('exige capa persistence')), conPersistence.errors.join('\n'));

  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes("publishing.reliability: 'outbox' exige capa persistence")),
    errors.join('\n')
  );
});

test('best-effort sin outbox no dice nada: la fila solo hace falta si se prometió el outbox', () => {
  const layers = compLayers();
  layers.messaging.publishing = { events: { ProductRetired: { payload: {} } } };
  layers['use-cases'].operations.retireProduct.emits = ['ProductRetired'];
  const { errors } = run(layers);
  assert.ok(!errors.some((e) => e.includes('exige capa persistence')), errors.join('\n'));
});

test('encargar trabajo publicando sobre best-effort es aviso: el encargo se puede perder', () => {
  const layers = activationLayers();
  delete layers['http-clients'];
  activation(layers).via = { publishes: 'DeliveryRequested' };
  delete activation(layers).onFailure;
  layers.messaging = {
    publishing: { events: { DeliveryRequested: { payload: { recipient: { type: 'string', required: true } } } } },
  };
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes("viaja publicando 'DeliveryRequested'") && w.includes('reliability: best-effort')),
    warnings.join('\n')
  );

  // Con outbox el encargo no se pierde, que es justo lo que el schema da por hecho
  // cuando prohíbe onFailure en esta rama.
  layers.messaging.publishing.reliability = 'outbox';
  const conOutbox = run(layers);
  assert.ok(!conOutbox.warnings.some((w) => w.includes('viaja publicando')), conOutbox.warnings.join('\n'));
});

test('encargar por cliente HTTP no lo toca: ahí sí hay fallo que capturar', () => {
  const { warnings } = run(activationLayers());
  assert.ok(!warnings.some((w) => w.includes('viaja publicando')), warnings.join('\n'));
});

test('la compensación que devuelve a un estado terminal es aviso', () => {
  const layers = compLayers();
  const product = layers.domain.entities.Product;
  product.fields.status.values.push('cancelled');
  product.lifecycle.transitions.retired = ['active', 'cancelled'];
  product.lifecycle.transitions.cancelled = [];
  layers['use-cases'].operations.reactivateProduct.transitions = [
    { entity: 'Product', from: ['retired'], to: 'cancelled' },
  ];
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes("devuelve 'Product' a 'cancelled', que es un estado terminal")),
    warnings.join('\n')
  );
});

test('la compensación que devuelve a un estado con salida no dice nada', () => {
  // El fixture base vuelve a 'active', de donde sale 'retired'.
  const { warnings } = run(compLayers());
  assert.ok(!warnings.some((w) => w.includes('estado terminal')), warnings.join('\n'));
});

test('un command POST que publica sin guarda alguna es aviso', () => {
  const layers = compLayers();
  layers.messaging.publishing = { events: { ProductRetired: { payload: {} } } };
  layers['use-cases'].operations.retireProduct.emits = ['ProductRetired'];
  delete layers['use-cases'].operations.retireProduct.transitions;
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes('use-cases: retireProduct:') && w.includes('publica ProductRetired')),
    warnings.join('\n')
  );
});

test('cualquiera de las dos guardas calla el aviso del reintento del llamante', () => {
  const base = () => {
    const layers = compLayers();
    layers.messaging.publishing = { events: { ProductRetired: { payload: {} } } };
    layers['use-cases'].operations.retireProduct.emits = ['ProductRetired'];
    delete layers['use-cases'].operations.retireProduct.transitions;
    return layers;
  };
  const noRepite = (warnings) => !warnings.some((w) => w.includes('use-cases: retireProduct:'));

  // Guarda de puerta.
  const conIdempotency = base();
  conIdempotency['use-cases'].operations.retireProduct.idempotency = { keySource: 'client-key', ttlSeconds: 3600 };
  assert.ok(noRepite(run(conIdempotency).warnings), run(conIdempotency).warnings.join('\n'));

  // Guarda de dominio: la que trae el fixture de serie (active → retired, irrepetible).
  const conTransicion = base();
  conTransicion['use-cases'].operations.retireProduct.transitions = [
    { entity: 'Product', from: ['active'], to: 'retired' },
  ];
  assert.ok(noRepite(run(conTransicion).warnings), run(conTransicion).warnings.join('\n'));
});

test('un command cuyo efecto no sale del proceso no dispara el aviso', () => {
  // Sin emits y sin encargo a un proveedor, el segundo insert lo puede frenar una
  // clave natural en persistence — una salida legítima que el DSL no ve.
  // publishProduct es el caso: POST, sin emits y sin activación que lo dispare.
  const layers = compLayers();
  delete layers['use-cases'].operations.publishProduct.transitions;
  const { warnings } = run(layers);
  assert.ok(!warnings.some((w) => w.includes('use-cases: publishProduct:')), warnings.join('\n'));
});

test('PUT y DELETE no disparan el aviso: son idempotentes por definición del protocolo', () => {
  const layers = compLayers();
  layers.messaging.publishing = { events: { ProductRetired: { payload: {} } } };
  layers['use-cases'].operations.retireProduct.emits = ['ProductRetired'];
  delete layers['use-cases'].operations.retireProduct.transitions;
  layers.api.endpoints.retireProduct = { method: 'DELETE', path: '/products/{productId}' };
  const { warnings } = run(layers);
  assert.ok(!warnings.some((w) => w.includes('use-cases: retireProduct:')), warnings.join('\n'));
});

// ---------------------------------------------------------------------------
// Las dos patas que quedaban sin cruzar: un barrido que no toca lo que barre, y
// la obligación de los dos escenarios de una compensación —la única regla que
// mira validation-scenarios.md, porque es la única parte del diseño que nada
// contrastaba con el resto.
// ---------------------------------------------------------------------------

test('un barrido que no toca lo que reconcilia es aviso', () => {
  const layers = compLayers();
  // Se le quita el enlace: queda un `schedule` que cumple la forma y no reconcilia nada.
  layers.dependencies.dependencies.compliance.activations.recordWithdrawal.triggeredBy = ['retireProduct'];
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) => w.includes("'reconcileWithdrawals' corre por el reloj") && w.includes('Product')),
    warnings.join('\n')
  );
});

test('mover el lifecycle de lo que quedó esperando también cierra el barrido', () => {
  const layers = compLayers();
  const dep = layers.dependencies.dependencies.compliance;
  dep.activations.recordWithdrawal.triggeredBy = ['retireProduct'];
  // La otra forma legítima: en vez de reencargar, se rinde y devuelve el producto.
  layers['use-cases'].operations.reconcileWithdrawals.transitions = [
    { entity: 'Product', from: ['retired'], to: 'active' },
  ];
  const { warnings } = run(layers);
  assert.ok(!warnings.some((w) => w.includes('corre por el reloj')), warnings.join('\n'));
});

const scenarioDoc = (...blocks) =>
  `# catalog — Escenarios de validación\n\n## Flujos\n\n${blocks.join('\n\n')}\n`;

const EFECTO = `### FL-CMP-001: el registro rechaza la retirada
**Given**: un producto retirado cuya inscripción se encargó a compliance.
**When**: llega WithdrawalRejected.
**Then**: el producto vuelve a active, leído por GET /products/{id}.`;

const REENTREGA = `### FL-CMP-002: WithdrawalRejected se reentrega
**Given**: la compensación de FL-CMP-001 ya se aplicó.
**When**: se entrega el MISMO mensaje otra vez (misma reentrega del broker).
**Then**: no hay segundo efecto: el producto sigue en active y no se publica nada.`;

const SIMULTANEA = `### FL-CMP-003: WithdrawalRejected llega dos veces a la vez
**Given**: un producto retirado cuya inscripción se encargó a compliance.
**When**: se entregan dos copias del mismo mensaje SIMULTÁNEAMENTE.
**Then**: el producto queda en active y GET /products cuenta exactamente una reactivación.`;

test('sin documento de escenarios no se dice nada: no hay nada que cruzar', () => {
  const { warnings } = run(compLayers());
  assert.ok(!warnings.some((w) => w.includes('validation-scenarios.md')), warnings.join('\n'));
  assert.ok(!warnings.some((w) => w.includes('REENTREGA')), warnings.join('\n'));
});

test('una compensación sin ningún escenario suyo es aviso', () => {
  const scenarios = scenarioDoc(`### FL-PRD-001: alta de producto
**Given**: nada.
**When**: POST /products.
**Then**: 201.`);
  const { warnings } = checkCrossRefs({ layers: compLayers(), scenarios });
  assert.ok(
    warnings.some((w) => w.includes("ningún escenario de validation-scenarios.md que mencione 'WithdrawalRejected'")),
    warnings.join('\n')
  );
});

test('el efecto sin la reentrega es aviso: es el escenario que menos se escribe y más cuesta', () => {
  const { warnings } = checkCrossRefs({ layers: compLayers(), scenarios: scenarioDoc(EFECTO) });
  assert.ok(
    warnings.some((w) => w.includes("los escenarios de 'WithdrawalRejected' cubren el efecto pero no encuentro el de REENTREGA")),
    warnings.join('\n')
  );
});

test('la reentrega secuencial NO vale como doble entrega simultánea', () => {
  // La propiedad que sostiene el tercer aviso: si `dos veces` contase como señal de
  // simultaneidad, este documento —que solo reentrega— saldría limpio y el escenario
  // que falta seguiría faltando sin que nadie lo dijera.
  const { warnings } = checkCrossRefs({ layers: compLayers(), scenarios: scenarioDoc(EFECTO, REENTREGA) });
  assert.ok(
    warnings.some((w) => w.includes("los escenarios de 'WithdrawalRejected' no cubren la DOBLE ENTREGA SIMULTÁNEA")),
    warnings.join('\n')
  );
  // Y el de reentrega ya no se emite: son dos huecos distintos, no uno con dos avisos.
  assert.ok(!warnings.some((w) => w.includes('no encuentro el de REENTREGA')), warnings.join('\n'));
});

test('con los tres escenarios no se dice nada', () => {
  const { warnings } = checkCrossRefs({
    layers: compLayers(),
    scenarios: scenarioDoc(EFECTO, REENTREGA, SIMULTANEA),
  });
  assert.ok(!warnings.some((w) => w.includes('WithdrawalRejected') && w.includes('escenario')), warnings.join('\n'));
});

// ---------------------------------------------------------------------------
// Los otros dos mecanismos que el gate del generador no echaba de menos: el
// outbox —cuyo escenario decorativo es trivial de escribir sin darse cuenta— y
// la carrera de la clave de idempotencia.
// ---------------------------------------------------------------------------

// compLayers con entrega garantizada declarada. Necesita persistence: sin ella el
// propio checkCrossRefs ya da error duro y el aviso de escenario no llega a mirarse.
const outboxLayers = () => {
  const layers = compLayers();
  layers.persistence = { default: { model: 'relational' } };
  layers.messaging.publishing = {
    reliability: 'outbox',
    events: { ProductRetired: { payload: { productId: { type: 'uuid', required: true } } } },
  };
  layers['use-cases'].operations.retireProduct.emits = ['ProductRetired'];
  return layers;
};

const OUTBOX_DECORATIVO = `### FL-OBX-001: la retirada publica su evento
**Given**: un producto activo.
**When**: POST /products/{id}/retire.
**Then**: el canal recibe un ProductRetired con el productId.`;

const OUTBOX_REAL = `### FL-OBX-002: el evento sobrevive a un canal indisponible
**Given**: un producto activo y el canal de eventos indisponible.
**When**: POST /products/{id}/retire.
**Then**: 200, el producto queda retirado y el canal sigue vacío. Restablecido el canal,
en <= 10 s recibe exactamente un ProductRetired.`;

test('un escenario que solo afirma que el evento llega no vale como cobertura del outbox', () => {
  // La propiedad central: este documento describe un evento publicado, y lo pasaría
  // igual un servidor que publica en línea. Si el aviso no saltara aquí, el gate
  // estaría premiando justo al escenario que no distingue nada.
  const { warnings } = checkCrossRefs({ layers: outboxLayers(), scenarios: scenarioDoc(OUTBOX_DECORATIVO) });
  assert.ok(
    warnings.some((w) => w.includes("reliability: 'outbox' no tiene escenario que lo distinga de best-effort")),
    warnings.join('\n')
  );
});

test('con el escenario del canal indisponible el outbox queda cubierto', () => {
  const { warnings } = checkCrossRefs({
    layers: outboxLayers(),
    scenarios: scenarioDoc(OUTBOX_DECORATIVO, OUTBOX_REAL),
  });
  assert.ok(!warnings.some((w) => w.includes("reliability: 'outbox'")), warnings.join('\n'));
});

test('sin outbox declarado no se pide ningún escenario de canal caído', () => {
  const layers = outboxLayers();
  layers.messaging.publishing.reliability = 'best-effort';
  const { warnings } = checkCrossRefs({ layers, scenarios: scenarioDoc(OUTBOX_DECORATIVO) });
  assert.ok(!warnings.some((w) => w.includes('best-effort —')), warnings.join('\n'));
});

const idempotentLayers = () => {
  const layers = compLayers();
  layers['use-cases'].operations.retireProduct.idempotency = { keySource: 'header' };
  return layers;
};

const RETIRADA_SECUENCIAL = `### FL-IDM-001: retireProduct se reintenta con la misma clave
**Given**: un producto activo.
**When**: se llama a retireProduct dos veces con la misma Idempotency-Key.
**Then**: el segundo devuelve el mismo status y cuerpo, sin segundo efecto.`;

const RETIRADA_CARRERA = `### FL-IDM-002: dos retireProduct con la misma clave a la vez
**Given**: un producto activo.
**When**: se lanzan dos retireProduct simultáneos con la misma Idempotency-Key.
**Then**: uno devuelve 200 y el otro 200 o 409 IDEMPOTENCY_KEY_IN_PROGRESS; la API
cuenta exactamente una retirada.`;

test('idempotencia probada solo en secuencia es aviso', () => {
  const { warnings } = checkCrossRefs({ layers: idempotentLayers(), scenarios: scenarioDoc(RETIRADA_SECUENCIAL) });
  assert.ok(
    warnings.some((w) => w.includes('operations.retireProduct declara idempotency') && w.includes('CARRERA')),
    warnings.join('\n')
  );
});

test('con el escenario de carrera la idempotencia queda cubierta', () => {
  const { warnings } = checkCrossRefs({
    layers: idempotentLayers(),
    scenarios: scenarioDoc(RETIRADA_SECUENCIAL, RETIRADA_CARRERA),
  });
  // Se afirma sobre el aviso de la CARRERA, no sobre cualquiera que mencione la
  // idempotencia: el mismo diseño recibe también el de los códigos canónicos de sus
  // conflictos, que es otro asunto y no depende de los escenarios.
  assert.ok(!warnings.some((w) => w.includes('CARRERA')), warnings.join('\n'));
});

test('una operación sin escenarios propios no recibe el aviso de carrera: ya lo dice la matriz', () => {
  // Deliberado: si la operación no aparece en NINGÚN escenario, el hueco no es la
  // carrera sino la cobertura entera, y eso lo reporta la revisión de la matriz.
  // Emitir aquí «falta la carrera» apuntaría al síntoma pequeño del problema grande.
  const { warnings } = checkCrossRefs({ layers: idempotentLayers(), scenarios: scenarioDoc(EFECTO) });
  // Se afirma sobre el aviso de la CARRERA, no sobre cualquiera que mencione la
  // idempotencia: el mismo diseño recibe también el de los códigos canónicos de sus
  // conflictos, que es otro asunto y no depende de los escenarios.
  assert.ok(!warnings.some((w) => w.includes('CARRERA')), warnings.join('\n'));
});

// ---------------------------------------------------------------------------
// La compensación disparada por un TERCERO. Es la forma más común de saga —se
// encarga stock a inventory y lo que falla después es el pago, en payments— y
// hasta ahora recibía un aviso por declarar el `source` correcto, que empujaba
// justo al diseño equivocado: mover la suscripción al proveedor.
// ---------------------------------------------------------------------------

// compLayers con el fallo publicado por un tercero ('audit', ajeno a 'compliance')
// y la activación de vuelta declarada, que es lo que alcanza al proveedor.
const thirdPartyCompensation = () => {
  const layers = compLayers();
  layers.messaging.subscriptions.WithdrawalRejected.source = 'audit';
  const dep = layers.dependencies.dependencies.compliance;
  dep.activations.cancelWithdrawal = {
    triggeredBy: ['reactivateProduct'],
    via: { client: 'compliance', call: 'cancelWithdrawal' },
    effect: 'La inscripción de la retirada queda anulada en el registro.',
    onFailure: { action: 'ignore' },
  };
  layers['http-clients'].clients.compliance.calls.cancelWithdrawal = {
    contract: 'DELETE /withdrawals/{id} -> anulación de la inscripción.',
  };
  return layers;
};

test('una compensación disparada por un tercero no avisa por el source', () => {
  const { errors, warnings } = run(thirdPartyCompensation());
  assert.deepEqual(errors, []);
  assert.ok(!warnings.some((w) => w.includes('distinto de la dependencia')), warnings.join('\n'));
  assert.ok(!warnings.some((w) => w.includes('sigue en pie')), warnings.join('\n'));
});

test('pero sin la activación de vuelta sigue avisando: el proveedor no se entera', () => {
  // El test que prueba que se quitó un falso positivo y NO una comprobación.
  const layers = thirdPartyCompensation();
  delete layers.dependencies.dependencies.compliance.activations.cancelWithdrawal;
  delete layers['http-clients'].clients.compliance.calls.cancelWithdrawal;
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes("lo publica 'audit'") && w.includes('sigue en pie')),
    warnings.join('\n')
  );
  // Y el aviso que se retiró no vuelve por la puerta de atrás.
  assert.ok(!warnings.some((w) => w.includes('distinto de la dependencia')), warnings.join('\n'));
});

test('una compensación que publica el propio proveedor no dice nada (sin regresión)', () => {
  const { warnings } = run(compLayers());
  assert.ok(!warnings.some((w) => w.includes('distinto de la dependencia')), warnings.join('\n'));
  assert.ok(!warnings.some((w) => w.includes('sigue en pie')), warnings.join('\n'));
});

test('el barrido que dispara la activación de VUELTA también está enlazado', () => {
  // La tercera salida de §3.11: no reintenta el encargo, lo compensa. Es un
  // triggeredBy de otra activación del mismo proveedor, y vale igual.
  const layers = compLayers();
  const dep = layers.dependencies.dependencies.compliance;
  dep.activations.recordWithdrawal.triggeredBy = ['retireProduct'];
  dep.activations.cancelWithdrawal = {
    triggeredBy: ['reconcileWithdrawals'],
    via: { client: 'compliance', call: 'cancelWithdrawal' },
    effect: 'La inscripción sin desenlace queda anulada en el registro.',
    onFailure: { action: 'ignore' },
  };
  layers['http-clients'].clients.compliance.calls.cancelWithdrawal = {
    contract: 'DELETE /withdrawals/{id} -> anulación de la inscripción.',
  };
  const { warnings } = run(layers);
  assert.ok(!warnings.some((w) => w.includes('corre por el reloj')), warnings.join('\n'));
});

test('encargar a OTRO proveedor no cuenta: no reconcilia este encargo', () => {
  const layers = compLayers();
  const compliance = layers.dependencies.dependencies.compliance;
  compliance.activations.recordWithdrawal.triggeredBy = ['retireProduct'];
  layers['http-clients'].clients.audit = {
    purpose: 'Registrar incidencias de reconciliación.',
    calls: { logIncident: { contract: 'POST /incidents -> incidencia registrada.' } },
  };
  layers.dependencies.dependencies.audit = {
    description: 'Registro de incidencias operativas.',
    activations: {
      logIncident: {
        triggeredBy: ['reconcileWithdrawals'],
        via: { client: 'audit', call: 'logIncident' },
        effect: 'Queda constancia de la retirada sin desenlace.',
        onFailure: { action: 'ignore' },
      },
    },
  };
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes("'reconcileWithdrawals' corre por el reloj")),
    warnings.join('\n')
  );
});

test('reconciledBy sin estado de espera es aviso, aunque el barrido reencargue', () => {
  // El caso que antes pasaba en silencio: el barrido cumplía el enlace (reencarga) y
  // nadie comprobaba que hubiera algo parado que encontrar. Reconciliar es sacar de la
  // espera lo que se quedó ahí; sin estado de espera no hay consulta que escribir.
  const layers = compLayers();
  delete layers['use-cases'].operations.retireProduct.transitions;
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes('no hay un estado que signifique «esperando»')),
    warnings.join('\n')
  );
});

test('con estado de espera declarado no se dice nada (sin regresión)', () => {
  // El fixture base: retireProduct mueve Product a `retired` al encargar la inscripción.
  const { warnings } = run(compLayers());
  assert.ok(!warnings.some((w) => w.includes('esperando»')), warnings.join('\n'));
  assert.ok(!warnings.some((w) => w.includes('corre por el reloj')), warnings.join('\n'));
});

// ─── Errores del framework: el contrato que pone el mecanismo ─────────────────
//
// El hueco que cierran estas reglas lo reportaron TRES corridas completas del pipeline,
// cada una improvisando un `code` distinto para el mismo hecho. El código canónico lo
// garantiza el catálogo (docs/framework-errors.md); lo que faltaba era que el diseñador
// se enterase de que ese contrato existe sin leer el código generado.

const conflictLayers = (errors = []) => ({
  domain: { entities: { Order: entity() } },
  'use-cases': {
    operations: {
      placeOrder: {
        description: 'Registra un pedido.',
        kind: 'command',
        input: { fields: { sku: { type: 'string', required: true } } },
        output: { entity: 'Order' },
        idempotency: { keySource: 'client-key', ttlSeconds: 3600 },
        errors
      }
    }
  },
  api: { endpoints: { placeOrder: { method: 'POST', path: '/orders' } } }
});

// El canal cambió: estos conflictos ya no son un aviso que se lee sino una OBLIGACIÓN que se
// cierra —con id, con exención por escrito en decisions.yaml y bloqueando mientras siga abierta—.
// Lo que se mide es lo mismo que antes: qué se le dice al diseñador, y cuándo se calla.
const conflictObligations = (layers) =>
  run(layers).obligations.filter((item) => /framework-errors\.md/.test(item.message));

const conflictIds = (layers) => conflictObligations(layers).map((item) => item.id);

test('idempotency sin nombrar sus desenlaces levanta una obligación por desenlace', () => {
  const found = conflictObligations(conflictLayers());
  // Dos, y no una que enumere los dos: son dos contratos públicos distintos, y un diseño puede
  // tener motivos para cerrar uno y aceptar el otro.
  assert.deepEqual(
    found.map((item) => item.id),
    ['OBL-IDEM-RACE-CODE', 'OBL-IDEM-REUSE-CODE']
  );
  assert.match(found[0].message, /IDEMPOTENCY_KEY_IN_PROGRESS/);
  assert.match(found[1].message, /IDEMPOTENCY_KEY_REUSED/);
  // Cada una nombra la operación: con varias idempotentes hay que saber cuál falta.
  for (const item of found) assert.match(item.message, /placeOrder/);
});

test('declarar uno de los dos cierra esa obligación, no las dos', () => {
  const found = conflictObligations(
    conflictLayers([{ code: 'ORDER_KEY_IN_PROGRESS', when: 'Otra petición con la misma clave.', http: 409 }])
  );
  assert.deepEqual(
    found.map((item) => item.id),
    ['OBL-IDEM-REUSE-CODE']
  );
  assert.ok(!found[0].message.includes('IDEMPOTENCY_KEY_IN_PROGRESS'), found[0].message);
});

test('nombrar los dos desenlaces cierra las dos obligaciones', () => {
  assert.deepEqual(
    conflictIds(
      conflictLayers([
        { code: 'ORDER_KEY_IN_PROGRESS', when: 'Otra petición con la misma clave.', http: 409 },
        { code: 'ORDER_KEY_REUSED', when: 'La misma clave con otro contenido.', http: 409 }
      ])
    ),
    []
  );
});

test('un code de la familia con otro status no cuenta como declarado', () => {
  // El status es parte del contrato: el generador solo sustituye el canónico por uno que
  // responda lo mismo, así que aquí la obligación tiene que seguir abierta.
  const found = conflictObligations(
    conflictLayers([{ code: 'ORDER_KEY_IN_PROGRESS', when: 'Otra petición con la misma clave.', http: 422 }])
  );
  assert.ok(found.some((item) => item.id === 'OBL-IDEM-RACE-CODE'), JSON.stringify(found));
});

const lockingLayers = (optimisticLocking, errors = []) => ({
  domain: { entities: { Order: entity() }, aggregates: { Order: { root: 'Order', entities: [] } } },
  'use-cases': {
    operations: {
      updateOrder: {
        description: 'Actualiza el pedido.',
        kind: 'command',
        input: { fields: { id: { type: 'uuid', required: true } } },
        output: { entity: 'Order' },
        errors
      }
    }
  },
  persistence: { entities: { Order: {} }, consistency: { optimisticLocking } }
});

test('optimisticLocking declarado sin error de concurrencia levanta su obligación', () => {
  for (const policy of ['all', 'declared']) {
    const found = conflictObligations(lockingLayers(policy));
    assert.equal(found.length, 1, `${policy}: ${JSON.stringify(found)}`);
    assert.equal(found[0].id, 'OBL-CONCURRENCY-CODE');
    assert.match(found[0].message, /CONCURRENT_MODIFICATION/);
  }
});

test('con optimisticLocking none no hay conflicto que nombrar', () => {
  assert.deepEqual(conflictIds(lockingLayers('none')), []);
});

test('sin pronunciarse sobre la concurrencia no se avisa, aunque el default sea all', () => {
  // El aviso es para quien está decidiendo sobre concurrencia. Emitirlo en todo diseño con
  // persistence —el default del schema es `all`— solo enseñaría a ignorar los avisos; que
  // el contrato exista igual lo garantiza el catálogo, no este recordatorio.
  const layers = lockingLayers('all');
  delete layers.persistence.consistency;
  assert.deepEqual(conflictIds(layers), []);
});

test('cualquier code de la familia de concurrencia cierra la obligación, con el prefijo del dominio', () => {
  assert.deepEqual(
    conflictIds(
      lockingLayers('all', [{ code: 'ORDER_VERSION_CONFLICT', when: 'Otra operación modificó el pedido.', http: 409 }])
    ),
    []
  );
});

test('dos candidatos de la misma familia no cuentan: ahí no se adivina', () => {
  // Con dos, el generador tampoco elige — usa el canónico—, así que la obligación tiene que
  // seguir abierta diciendo cuál va a salir.
  const found = conflictObligations(
    lockingLayers('all', [
      { code: 'ORDER_VERSION_CONFLICT', when: 'Otra operación modificó el pedido.', http: 409 },
      { code: 'LINE_CONCURRENT_UPDATE', when: 'Otra operación modificó la línea.', http: 409 }
    ])
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'OBL-CONCURRENCY-CODE');
  assert.match(found[0].message, /CONCURRENT_MODIFICATION/);
});

// --- exposedAs: el dato ajeno que además viaja en la respuesta ---
//
// Sin este campo, un `need` solo servía para DECIDIR y no había forma de decir que el
// dato se devuelve: la forma `{entity: X}` de un payload no admite campos extra. Tres
// diseños acabaron pidiendo un dato al proveedor para descartarlo tras el anticorrupción.

test('exposedAs sobre una operación con salida es válido', () => {
  const layers = depsLayers();
  need(layers).exposedAs = 'pricing';
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('exposedAs sobre una operación sin salida es error', () => {
  const layers = depsLayers();
  need(layers).usedBy = ['applyProductSnapshot'];
  need(layers).exposedAs = 'pricing';
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`'applyProductSnapshot' no devuelve nada`)),
    errors.join('\n')
  );
});

test('exposedAs que choca con un campo de la entidad proyectada es error', () => {
  const layers = depsLayers();
  need(layers).exposedAs = 'total'; // Order.total ya existe
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`exposedAs 'total'`) && e.includes('ya declara un campo o relación')),
    errors.join('\n')
  );
});

// El aviso que da valor: es la misma clase de señal que la asimetría de proyección de
// `embed` —se ve cruzando dos declaraciones del diseño, sin ejecutar nada— y nombra la
// salida que el propio DSL ya ofrece.
test('exposedAs on-demand sobre un listado avisa del N+1 y nombra replicated', () => {
  const layers = depsLayers();
  layers['use-cases'].operations.listOrders = {
    description: 'Lista los pedidos del cliente.',
    kind: 'query',
    input: 'void',
    output: { entity: 'Order', list: true, paginated: true },
  };
  const spec = need(layers);
  spec.usedBy = ['listOrders'];
  spec.exposedAs = 'pricing';
  spec.strategy = 'on-demand';
  delete spec.replica;

  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) => w.includes("'listOrders' devuelve varios elementos") && w.includes("'replicated'")),
    warnings.join('\n')
  );
});

test('la misma salida de varios elementos con replicated no avisa', () => {
  const layers = depsLayers();
  layers['use-cases'].operations.listOrders = {
    description: 'Lista los pedidos del cliente.',
    kind: 'query',
    input: 'void',
    output: { entity: 'Order', list: true, paginated: true },
  };
  const spec = need(layers);
  spec.usedBy = ['listOrders'];
  spec.exposedAs = 'pricing';

  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  // Se mira el aviso concreto, no la lista entera: `listOrders` es una operación
  // auxiliar de este test y arrastra sus propios avisos (sin endpoint, sin pagination),
  // que no tienen nada que ver con lo que aquí se mide.
  assert.ok(
    !warnings.some((w) => w.includes('una llamada por elemento')),
    warnings.join('\n')
  );
});

// ─── Capa mail: el correo que el servicio emite ──────────────────────────────

const mailUseCases = (extra = {}) => ({
  operations: {
    requestNotification: {
      kind: 'command',
      input: { fields: { templateKey: { type: 'string', required: true } } },
      output: { fields: { notificationId: { type: 'uuid' } } },
      ...extra,
    },
  },
});

const mailLayer = (overrides = {}) => ({
  delivery: { transport: 'smtp', parts: ['html', 'text'] },
  sentBy: ['requestNotification'],
  sender: { source: 'data', fallback: 'no-reply@ejemplo.com' },
  templating: { source: 'data', declaredVariables: true },
  ...overrides,
});

// La operación que manda correo declara idempotencia: sin ella salta el aviso propio
// del correo, que es legítimo pero ajeno a lo que cada fixture mide. Y la idempotencia
// por cabecera exige endpoint HTTP que la reciba, de ahí la capa api que la acompaña.
const guarded = { idempotency: { keyFrom: 'header', scope: 'client' } };
const mailApi = { endpoints: { requestNotification: { method: 'POST', path: '/notifications' } } };

test('capa mail bien formada no produce errores ni warnings', () => {
  const { errors, warnings } = run({
    domain: baseDomain(),
    'use-cases': mailUseCases(guarded),
    api: mailApi,
    security: securityLayer,
    mail: mailLayer(),
  });
  assert.deepEqual(errors, []);
  // Solo se afirma sobre los avisos DE LA CAPA: los canónicos de idempotencia son de
  // otro asunto y tienen sus propios tests; colarlos aquí ataría este test a ellos.
  assert.deepEqual(warnings.filter((w) => w.startsWith('mail:')), []);
});

test('mail: sentBy que nombra una operación inexistente es error', () => {
  // Es el único enlace del DSL entre un caso de uso y la salida por correo: si apunta
  // al vacío, el generador no encuentra dónde inyectar el envío y no lo genera en
  // ninguna parte, sin que nada lo diga.
  const { errors } = run({
    domain: baseDomain(),
    'use-cases': mailUseCases(guarded),
    api: mailApi,
    mail: mailLayer({ sentBy: ['sendSomethingElse'] }),
  });
  assert.ok(errors.some((e) => e.includes("mail: sentBy: la operación 'sendSomethingElse' no existe")), errors.join(' | '));
});

test('mail: operación que manda correo sin guarda de repetición es aviso', () => {
  // Un correo que sale no lo deshace ninguna transacción: si la operación se repite,
  // el destinatario recibe el mensaje dos veces.
  const { errors, warnings } = run({
    domain: baseDomain(),
    'use-cases': mailUseCases(),
    mail: mailLayer(),
  });
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) => w.includes("la operación 'requestNotification' manda correo y no declara 'idempotency'")),
    warnings.join(' | ')
  );
});

test('mail: remitente por dato sin fallback es aviso', () => {
  const { warnings } = run({
    domain: baseDomain(),
    'use-cases': mailUseCases(guarded),
    api: mailApi,
    mail: mailLayer({ sender: { source: 'data' } }),
  });
  assert.ok(warnings.some((w) => w.includes("mail: sender: es 'data' y no declara 'fallback'")), warnings.join(' | '));
});

test('mail: html sin alternativa textual es aviso', () => {
  // No falla en ninguna prueba: se ve en la carpeta de spam de quien lo recibe.
  const { warnings } = run({
    domain: baseDomain(),
    'use-cases': mailUseCases(guarded),
    api: mailApi,
    mail: mailLayer({ delivery: { transport: 'smtp', parts: ['html'] } }),
  });
  assert.ok(warnings.some((w) => w.includes("delivery.parts: declara 'html' sin 'text'")), warnings.join(' | '));
});

test('mail: plantillas por dato sin variables declaradas es aviso', () => {
  const { warnings } = run({
    domain: baseDomain(),
    'use-cases': mailUseCases(guarded),
    api: mailApi,
    mail: mailLayer({ templating: { source: 'data' } }),
  });
  assert.ok(warnings.some((w) => w.includes("templating: el cuerpo es 'data' y no declara 'declaredVariables'")), warnings.join(' | '));
});

// ─── identity: de dónde sale el inquilino cuando no hay token ────────────────

const identityLayers = (identity, extra = {}) => ({
  domain: baseDomain(),
  'use-cases': {
    operations: {
      acceptRequest: {
        kind: 'command',
        internal: true,
        input: { fields: { applicationKey: { type: 'string', required: true }, ref: { type: 'string', required: true } } },
        output: 'void',
      },
    },
  },
  messaging: {
    subscriptions: {
      WorkRequested: {
        source: 'any-registered-system',
        nature: 'request',
        contract: { envelope: 'keel' },
        payload: { ref: { type: 'string', required: true } },
        triggers: 'acceptRequest',
        identity,
        ...extra,
      },
    },
  },
});

const sourceIdentity = {
  field: 'applicationKey',
  from: { location: 'field', name: 'metadata.source' },
  trustedPublishers: 'El broker autentica a los emisores y todos son sistemas propios.',
  onUnresolved: 'discard',
};

test('identity resuelve el campo del input: no se reclama como campo que falta del payload', () => {
  // Sin esto, la regla de «campo requerido que no llega en el payload» marcaría en rojo
  // justo el campo que la identidad rellena — que es todo el propósito del mecanismo.
  const { errors } = run(identityLayers(sourceIdentity));
  assert.deepEqual(errors, []);
});

test('identity que nombra un campo inexistente en el input es error', () => {
  const { errors } = run(identityLayers({ ...sourceIdentity, field: 'tenantKey' }));
  assert.ok(
    errors.some((e) => e.includes("identity.field: la operación 'acceptRequest' no declara 'tenantKey'")),
    errors.join(' | ')
  );
});

test('el mismo campo en identity y en input es error: dos versiones de la verdad', () => {
  // El dato de identidad viaja por un solo camino, o una de las dos deja de validarse.
  const { errors } = run(identityLayers(sourceIdentity, { input: { applicationKey: 'ref' } }));
  assert.ok(
    errors.some((e) => e.includes("se resuelve además en 'input'")),
    errors.join(' | ')
  );
});

test('identity sobre metadata.* con envelope none es error: no hay envoltura de la que sacarla', () => {
  const layers = identityLayers(sourceIdentity);
  layers.messaging.subscriptions.WorkRequested.contract = { envelope: 'none' };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes("contract.envelope es 'none'")),
    errors.join(' | ')
  );
});

// ---------------------------------------------------------------------------
// Huecos que el diseño promete en prosa y ninguna declaración respalda. Los tres
// salieron de la misma corrida: un diseño que validaba «✔ Servicio válido» y del
// que la generación destapó siete huecos horas después. Los tres son AVISO, no
// error: la decisión sigue siendo del diseño, lo que no puede es quedar sin tomar.
// ---------------------------------------------------------------------------

const scopedLayers = () => ({
  domain: { entities: { Product: entity() }, aggregates: {} },
  'use-cases': {
    operations: {
      getProduct: {
        description: 'Consulta un producto.',
        kind: 'query',
        input: { fields: { id: { type: 'uuid', required: true } } },
        output: { entity: 'Product' },
        errors: [{ code: 'PRODUCT_FORBIDDEN', when: 'El producto no está en su alcance.', http: 403 }],
      },
    },
  },
  api: { endpoints: { getProduct: { method: 'GET', path: '/products/{id}' } } },
  security: {
    authentication: { protocol: 'oidc', tokenLocation: 'header' },
    roles: { operator: { description: 'Opera el catálogo.' } },
    permissions: { 'product:read': { description: 'Leer productos.' } },
    roleGrants: { operator: ['product:read'] },
    access: { default: { level: 'required', roles: ['operator'], permissions: ['product:read'] } },
  },
});

test('un 403 que solo pueden producir roles globales levanta la obligación del alcance', () => {
  // Fue aviso mientras el DSL no tuvo dónde declarar la acotación. Ahora que la tiene, es una
  // obligación — y de las que no se pueden aceptar: por omisión, todo el mundo alcanza todo.
  const { errors, obligations } = run(scopedLayers());
  assert.deepEqual(errors, []);
  assert.ok(
    obligations.some(
      (item) =>
        item.id === 'OBL-RESOURCE-SCOPE' &&
        item.message.includes("el error 'PRODUCT_FORBIDDEN' (403)") &&
        item.message.includes('son globales')
    ),
    JSON.stringify(obligations)
  );
});

test('sin ningún 403 declarado no se dice nada del alcance', () => {
  const layers = scopedLayers();
  layers['use-cases'].operations.getProduct.errors = [
    { code: 'PRODUCT_NOT_FOUND', when: 'No existe.', http: 404 },
  ];
  const { warnings } = run(layers);
  assert.ok(!warnings.some((w) => w.includes('son globales')), warnings.join('\n'));
});

// El alcance por recurso (DSL 2.11) es la respuesta que ese aviso llevaba pidiendo sin que el
// DSL tuviera dónde darla. Mientras no existió, el aviso solo se podía aceptar a sabiendas —y
// un aviso que solo se puede ignorar deja de ser un aviso.

const withScoping = (extra = {}) => {
  const layers = scopedLayers();
  layers.security.authentication.scoping = {
    claim: 'tenants',
    over: 'Product.id',
    error: 'PRODUCT_FORBIDDEN',
    ...extra
  };
  return layers;
};

test('declarar el alcance por recurso cierra el aviso del 403', () => {
  const { errors, warnings } = run(withScoping());
  assert.deepEqual(errors, []);
  assert.ok(!warnings.some((w) => w.includes('son globales')), warnings.join('\n'));
});

test('el alcance solo cubre SU error: otro 403 sigue avisando', () => {
  // Declarar el alcance no es una amnistía para cualquier 403. Uno distinto sigue sin tener
  // quien lo produzca, y taparlo aquí sería peor que el aviso original.
  const layers = withScoping();
  layers['use-cases'].operations.getProduct.errors.push({
    code: 'PRODUCT_LOCKED',
    when: 'Otro motivo de prohibición.',
    http: 403
  });
  const { obligations } = run(layers);
  assert.ok(
    obligations.some(
      (item) => item.id === 'OBL-RESOURCE-SCOPE' && item.message.includes("el error 'PRODUCT_LOCKED' (403)")
    ),
    JSON.stringify(obligations)
  );
});

test('el alcance sobre una entidad o un campo que no existen es error', () => {
  assert.ok(
    run(withScoping({ over: 'Ghost.code' })).errors.some((e) => e.includes("la entidad 'Ghost' no existe")),
    'entidad inexistente'
  );
  assert.ok(
    run(withScoping({ over: 'Product.ghost' })).errors.some((e) => e.includes("no declara el campo 'ghost'")),
    'campo inexistente'
  );
});

test('exentar un rol que no está en el catálogo es error', () => {
  const { errors } = run(withScoping({ exemptRoles: ['fantasma'] }));
  assert.ok(errors.some((e) => e.includes("el rol 'fantasma' no está")), errors.join('\n'));
});

test('declarar el alcance sin declarar su error es error', () => {
  // El alcance nombra el code; su status y su descripción viven en `errors`. Sin eso el 403
  // queda prometido y sin contrato, que es justo el hueco que este primitivo cierra.
  const { errors } = run(withScoping({ error: 'NUNCA_DECLARADO' }));
  assert.ok(errors.some((e) => e.includes("'NUNCA_DECLARADO' no lo declara ninguna operación")), errors.join('\n'));
});

test("un 403 sobre level 'service' no se avisa: ahí el que llama ES el alcance", () => {
  // La identidad de un cliente máquina es por cliente, no global: acotar a «los
  // recursos de quien llama» es producible sin declarar ningún claim extra.
  const layers = scopedLayers();
  layers.api.defaultAudience = 'services';
  layers.security.authentication.serviceAuth = { protocol: 'client-credentials' };
  layers.security.access.default = { level: 'service', scopes: ['product:read'] };
  const { warnings } = run(layers);
  assert.ok(!warnings.some((w) => w.includes('son globales')), warnings.join('\n'));
});

test('un escenario que nombra un serviceClient que el diseño no declara es aviso', () => {
  const layers = scopedLayers();
  layers.api.defaultAudience = 'services';
  layers.security.authentication.serviceAuth = { protocol: 'client-credentials' };
  layers.security.access.default = { level: 'service', scopes: ['product:read'] };
  layers.security.serviceClients = { 'billing-service': { description: 'Factura.', scopes: ['product:read'] } };
  const scenarios = scenarioDoc(`### FL-PRD-001: consulta con credencial de máquina
**Given**: existe un producto. El solicitante presenta un token del \`serviceClient\` **\`shipping\`**.
**When**: GET /products/{id}.
**Then**: 200.`);
  const { warnings } = checkCrossRefs({ layers, scenarios });
  assert.ok(
    warnings.some((w) => w.includes("'shipping'") && w.includes('serviceClients no declara')),
    warnings.join('\n')
  );
});

test('el mismo escenario con el cliente declarado no dice nada', () => {
  const layers = scopedLayers();
  layers.api.defaultAudience = 'services';
  layers.security.authentication.serviceAuth = { protocol: 'client-credentials' };
  layers.security.access.default = { level: 'service', scopes: ['product:read'] };
  layers.security.serviceClients = { shipping: { description: 'Envía.', scopes: ['product:read'] } };
  const scenarios = scenarioDoc(`### FL-PRD-001: consulta con credencial de máquina
**Given**: el solicitante presenta un token del \`serviceClient\` **\`shipping\`**.
**When**: GET /products/{id}.
**Then**: 200.`);
  const { warnings } = checkCrossRefs({ layers, scenarios });
  assert.ok(!warnings.some((w) => w.includes('serviceClients no declara')), warnings.join('\n'));
});

test('un rol que los escenarios nombran y security no declara es aviso', () => {
  const scenarios = scenarioDoc(`### FL-PRD-001: alta
**Given**: el solicitante tiene rol \`auditor\`.
**When**: GET /products/{id}.
**Then**: 200.`);
  const { warnings } = checkCrossRefs({ layers: scopedLayers(), scenarios });
  assert.ok(
    warnings.some((w) => w.includes("'auditor'") && w.includes('roles no declara')),
    warnings.join('\n')
  );
});

test('un barrido sin puerta y sin efecto declarado es aviso', () => {
  const layers = scopedLayers();
  layers['use-cases'].operations.purgeOldProducts = {
    description: 'Borra los datos personales de los productos viejos.',
    kind: 'command',
    input: 'void',
    output: 'void',
    schedule: { cron: '0 3 * * *' },
  };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) => w.includes('purgeOldProducts') && w.includes('no declara transitions ni emits')),
    warnings.join('\n')
  );
});

test('un barrido cuyo efecto SÍ está declarado no se avisa: el escenario se escribe contra el efecto', () => {
  // Es la asimetría del documento de escenarios: el disparador no se alcanza en los
  // dos casos, pero aquí hay algo que cambia ahí fuera contra lo que afirmar.
  const layers = scopedLayers();
  layers.domain.entities.Product = entity({ status: { type: 'enum', values: ['queued', 'sent'] } });
  layers.domain.entities.Product.lifecycle = { field: 'status', transitions: { queued: ['sent'], sent: [] } };
  layers['use-cases'].operations.dispatchQueued = {
    description: 'Despacha los productos encolados.',
    kind: 'command',
    input: 'void',
    output: 'void',
    schedule: { cron: '* * * * *' },
    transitions: [{ entity: 'Product', from: ['queued'], to: 'sent' }],
  };
  const { warnings } = run(layers);
  assert.ok(!warnings.some((w) => w.includes('no declara transitions ni emits')), warnings.join('\n'));
});
