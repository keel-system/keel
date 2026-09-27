// Las 17 clases del análisis de huecos, con su aplicabilidad y sus UNIDADES derivadas del diseño.
//
// El problema (R3 de recomendaciones-diseno.md). El análisis de huecos de `/keel-design` (paso 4b,
// `assets/skills/keel-design/references/gap-analysis.md`) se hacía en el chat: inventario, tabla de
// cobertura y hallazgos morían con la conversación. La tabla de cobertura ya se había intentado
// persistir DOS veces —en `decisions.yaml` y después en `review.yaml`— y las dos quedó sin leer: las
// fixtures que la usaban cubrían una clase de diecisiete. Una tabla que nadie exige no se rellena.
//
// Lo que hace este módulo es la mitad mecánica, la misma que `reviews.js` hace para la revisión: DECIDE
// qué clases le tocan a este diseño y sobre qué unidades hay que recorrerlas. El lector solo da el
// veredicto (en `gaps.yaml`, ver `gaps-state.js`). Que la máquina derive las unidades es lo que hace
// exigible la cobertura: «recorrí las consultas» con una query de cuatro no pasa. Y es lo que le da a
// `/keel-evolve` su alcance gratis: una operación nueva aparece sola como unidad sin recorrer.
//
// El inventario NO se guarda en el YAML: se deriva de las capas, y guardado caducaría en cuanto el
// diseño cambiara. Las unidades son cadenas estables que se escriben tal cual en `gaps.yaml`.

const values = (collection) => Object.values(collection ?? {}).map((value) => value ?? {});
const keys = (collection) => Object.keys(collection ?? {});

function operations(layers) {
  return Object.entries(layers['use-cases']?.operations ?? {}).map(([name, op]) => [name, op ?? {}]);
}

const opsWhere = (layers, predicate) =>
  operations(layers)
    .filter(([, op]) => {
      try {
        return predicate(op);
      } catch {
        return false;
      }
    })
    .map(([name]) => name);

const commands = (layers) => opsWhere(layers, (op) => op.kind === 'command');
const queries = (layers) => opsWhere(layers, (op) => op.kind === 'query');

function hasEnumField(entity, layers) {
  return values(entity.fields).some((field) => {
    if (field.type === 'enum') return true;
    return Array.isArray(layers.domain?.types?.[field.type]?.values);
  });
}

function fileFields(layers) {
  const found = [];
  for (const [name, entity] of Object.entries(layers.domain?.entities ?? {})) {
    for (const [fieldName, field] of Object.entries(entity?.fields ?? {})) {
      if (field?.type === 'file') found.push(`${name}.${fieldName}`);
    }
  }
  return found;
}

/** Audiencia efectiva de una operación expuesta: la del endpoint, o la por defecto de la api. */
function audienceOf(layers, opName) {
  return layers.api?.endpoints?.[opName]?.audience ?? layers.api?.defaultAudience ?? 'users';
}

function dependencyUnits(layers) {
  const units = [];
  for (const [depName, dep] of Object.entries(layers.dependencies?.dependencies ?? {})) {
    for (const need of keys(dep?.needs)) units.push(`${depName}.needs.${need}`);
    for (const activation of keys(dep?.activations)) units.push(`${depName}.activations.${activation}`);
  }
  return units;
}

/**
 * Las entradas del catálogo estructural que le aplican a este diseño, según la tabla de la clase 16
 * (`gap-analysis.md § 16`). La unidad de la clase 16 no es una parte del diseño sino una PREGUNTA
 * del catálogo, porque lo que se audita es quién la contestó.
 */
function structuralEntries(layers) {
  const has = (condition) => {
    try {
      return Boolean(condition());
    } catch {
      return false;
    }
  };
  const entries = [
    ['3.1', () => keys(layers.messaging?.publishing?.events).length > 0],
    ['3.2', () => commands(layers).length > 0],
    ['3.3', () => queries(layers).length > 0],
    ['3.4', () => opsWhere(layers, (op) => !op.internal).some((name) => ['services', 'both'].includes(audienceOf(layers, name)))],
    ['3.5', () => keys(layers.messaging?.subscriptions).length > 0],
    ['3.6', () => keys(layers['http-clients']?.clients).length > 0],
    ['3.7', () => Boolean(layers.persistence)],
    ['3.8', () => opsWhere(layers, (op) => op.kind === 'query' && (op.output?.list || op.output?.paginated)).length > 0],
    ['3.9', () => Boolean(layers.persistence) && commands(layers).length > 0],
    ['3.10', () => Boolean(layers.storage)]
  ];
  return entries.filter(([, condition]) => has(condition)).map(([section]) => section);
}

/**
 * - `title` — el nombre de la clase en `gap-analysis.md`.
 * - `units(layers)` — las unidades que hay que recorrer. Una clase aplica si tiene alguna: el
 *   disparador «Aplica si» de la doctrina y el inventario son la misma pregunta vista dos veces, y
 *   derivarlos por separado permitiría una clase que aplica sin nada que recorrer.
 * - `acceptable: false` — la clase entera no admite el cierre `accepted` (`gap-analysis.md` § Cierre):
 *   ahí no hay default seguro y «aceptado» significaría «que lo decida el generador». El `http` de los
 *   errores (clase 2) y el orden de las colecciones (clase 5) también lo prohíben, pero son UNA
 *   pregunta dentro de su clase, no la clase: el orden lo vigila `CHK-USECASES-COLLECTION-NO-SORT`
 *   (que no admite aceptación) y el `http`, de momento, nadie.
 */
export const GAP_CLASSES = {
  1: {
    title: 'Alcanzabilidad del ciclo de vida',
    units: (layers) =>
      Object.entries(layers.domain?.entities ?? {})
        .filter(([, entity]) => entity?.lifecycle || hasEnumField(entity ?? {}, layers))
        .map(([name]) => name)
  },
  2: { title: 'Guardas ↔ errores', units: (layers) => commands(layers) },
  3: { title: 'Determinación del estado', units: (layers) => keys(layers.domain?.entities) },
  4: { title: 'Concurrencia y unicidad', units: (layers) => commands(layers) },
  5: { title: 'Consultas', units: (layers) => queries(layers) },
  6: {
    title: 'Fronteras del agregado y cascadas',
    units: (layers) => (keys(layers.domain?.entities).length > 1 ? keys(layers.domain?.entities) : [])
  },
  7: {
    title: 'Contrato de eventos',
    units: (layers) => [
      ...keys(layers.messaging?.publishing?.events).map((name) => `publishing.${name}`),
      ...keys(layers.messaging?.subscriptions).map((name) => `subscriptions.${name}`)
    ]
  },
  8: {
    title: 'Fallo de dependencias externas',
    units: (layers) => [
      ...dependencyUnits(layers),
      ...keys(layers['http-clients']?.clients).map((name) => `clients.${name}`),
      ...keys(layers.messaging?.subscriptions).map((name) => `subscriptions.${name}`)
    ]
  },
  9: {
    title: 'Autorización a nivel de dato',
    acceptable: false,
    units: (layers) => operations(layers).map(([name]) => name)
  },
  10: {
    title: 'Archivos',
    units: (layers) => (layers.storage ? keys(layers.storage.buckets) : fileFields(layers))
  },
  11: {
    title: 'Superficie servidor-a-servidor',
    units: (layers) => [
      ...(layers.api
        ? opsWhere(layers, (op) => !op.internal).filter((name) => ['services', 'both'].includes(audienceOf(layers, name)))
        : []),
      ...keys(layers.security?.serviceClients).map((name) => `serviceClients.${name}`)
    ]
  },
  12: {
    title: 'Zonas grises de la equivalencia',
    acceptable: false,
    units: (layers) => (layers.domain || layers['use-cases'] ? ['service'] : [])
  },
  13: { title: 'Ejecuciones programadas', units: (layers) => opsWhere(layers, (op) => Boolean(op.schedule)) },
  14: {
    title: 'Estado persistido',
    units: (layers) => (layers.persistence ? keys(layers.persistence.entities) : keys(layers.domain?.entities))
  },
  15: {
    title: 'Superficie HTTP',
    units: (layers) => (layers.api ? opsWhere(layers, (op) => !op.internal) : [])
  },
  16: { title: 'Decisiones estructurales sin dueño', units: (layers) => structuralEntries(layers) },
  17: {
    title: 'Correo saliente',
    units: (layers) => (Array.isArray(layers.mail?.sentBy) ? [...layers.mail.sentBy] : [])
  }
};

export const gapClassFor = (number) => GAP_CLASSES[number];

/**
 * El inventario de este diseño: las clases que aplican, en orden, con sus unidades. Tolerante a un
 * diseño a medias: una clase cuyo cálculo lanza no aplica, igual que en `applicableReviews`.
 *
 * @returns {Array<{ class: number, title: string, units: string[] }>}
 */
export function gapInventory(layers) {
  const inventory = [];
  for (const [number, entry] of Object.entries(GAP_CLASSES)) {
    let units = [];
    try {
      units = [...new Set(entry.units(layers ?? {}))];
    } catch {
      units = [];
    }
    if (units.length > 0) inventory.push({ class: Number(number), title: entry.title, units });
  }
  return inventory;
}
