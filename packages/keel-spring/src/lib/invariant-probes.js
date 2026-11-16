// Las sondas de la GUARDA DEL AGREGADO (DSL 2.31: checks, las cotas de la entidad y los derivados estructurados) para
// keel-spring: los vectores de keel-core/test/helpers/entity-check-designs.js (INVARIANT_VECTORS, que pasa el script), con los ids IC-* y
// CP-* que ejecutarán keel-nest, keel-dotnet y keel-go sobre el MISMO sujeto. Una clase JUnit que
// scripts/invariant-check.js escribe dentro del proyecto generado (no forma parte de él), con el contexto entero del
// perfil `local` contra el motor real de infra/.
//
// Cada vector se construye con el constructor de rehidratación (el estado que sea, también uno que ningún método de
// negocio dejaría) y se guarda por el PUERTO: lo que se mide es el save que emite build y la ensureInvariants() que
// llama. Las etiquetas importan para el falsado (cada sabotaje cae en exactamente sus casos): solo IC-10 mira la fila
// después de un rechazo, solo CP-5 lee la columna persistida, y CP-1 a CP-3 leen el derivado de lo que devuelve el save.

import { constructorArgs } from './finder-probes.js';
import { domainMembers } from '../scaffold/entities.js';
import { screamingSnake } from './naming.js';

export const PACKAGE_LEAF = 'invariantcheck';
export const CLASS_NAME = 'InvariantCheckTest';
/** La raíz del sujeto sobre la que están escritos los vectores. */
export const SUBJECT_ROOT = 'Product';

const java = (text) => JSON.stringify(text);
const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const decap = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;

/** Los casos que ejecuta la sonda, en el orden de los vectores. */
export function casesOf(vectors) {
  return [...new Set(vectors.map((vector) => vector.case))];
}

/** Un valor del vector (con los nombres del diseño) como expresión Java del tipo del campo. */
function javaValue(field, value, use) {
  if (value === null || value === undefined) return 'null';
  if (field.kind === 'enum') {
    use(field.namedType);
    return `${field.namedType}.${screamingSnake(String(value))}`;
  }
  if (field.base === 'json') return java(JSON.stringify(value));
  switch (field.base) {
    case 'decimal': return `new BigDecimal(${java(String(value))})`;
    case 'timestamp': return `Instant.parse(${java(value)})`;
    case 'date': return `LocalDate.parse(${java(value)})`;
    case 'long': return `${value}L`;
    case 'int': return String(value);
    case 'boolean': return String(value);
    default: return java(String(value));
  }
}

/**
 * La clase de prueba sobre `vectors`. `packages`: port, adapters (repositorios del almacén), errors y types (el paquete de cada tipo del
 * dominio por nombre).
 */
export function invariantTestClass(model, { vectors, packages, document, properties = [], doubles = [] }) {
  const root = model.entities.find((entity) => entity.name === SUBJECT_ROOT);
  const childRelation = root.relations.find((relation) => relation.internal && relation.cardinality === 'one-to-many');
  const child = model.entities.find((entity) => entity.name === childRelation.entity);
  const store = document ? `${SUBJECT_ROOT}MongoRepository` : `${SUBJECT_ROOT}JpaRepository`;
  const imports = new Set([
    'java.math.BigDecimal',
    'java.time.Instant',
    'java.time.LocalDate',
    'java.util.List',
    'java.util.UUID',
    'org.junit.jupiter.api.BeforeEach',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.test.context.SpringBootTest',
    'org.springframework.test.context.ActiveProfiles',
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertThrows',
    `${packages.errors}.DomainException`,
    `${packages.port}.${SUBJECT_ROOT}Repository`,
    `${packages.adapters}.${store}`,
    `${packages.types[SUBJECT_ROOT]}.${SUBJECT_ROOT}`,
    `${packages.types[child.name]}.${child.name}`
  ]);
  const use = (name) => imports.add(`${packages.types[name]}.${name}`);
  const port = `${decap(SUBJECT_ROOT)}Repository`;
  const raw = decap(store);
  const fields = [`    @Autowired\n    private ${SUBJECT_ROOT}Repository ${port};`, `    @Autowired\n    private ${store} ${raw};`];
  if (doubles.length > 0) imports.add('org.springframework.test.context.bean.override.mockito.MockitoBean');
  for (const double of doubles) {
    imports.add(double.fqn);
    fields.push(`    @MockitoBean\n    private ${double.type} ${decap(double.type)};`);
  }

  let seed = 31;
  const fieldOf = (entity, name) => entity.fields.find((field) => field.name === name);
  const imageArgs = (image, idExpr) => {
    const forced = { id: idExpr };
    for (const [name, value] of Object.entries(image)) {
      const field = fieldOf(child, name);
      if (field) forced[name] = javaValue(field, value, use);
    }
    return constructorArgs(model, child, seed++, forced, { enum: use, type: use });
  };
  /** `new Product(...)` del estado, con `idExpr` y `lockExpr`; cada imagen con el id que diga `imageIds`. */
  const construct = (state, { idExpr = 'UUID.randomUUID()', lockExpr = 'null', imageIds = [] } = {}) => {
    const forced = { id: idExpr };
    for (const [name, value] of Object.entries(state)) {
      if (name === childRelation.name) {
        const images = value.map((image, at) => `new ${child.name}(${imageArgs(image, imageIds[at] ?? 'UUID.randomUUID()').join(', ')})`);
        forced[name] = images.length === 0 ? 'List.of()' : `List.of(${images.join(', ')})`;
        continue;
      }
      const field = fieldOf(root, name);
      if (field) forced[name] = javaValue(field, value, use);
    }
    const args = constructorArgs(model, root, seed++, forced, { enum: use, type: use });
    if (root.usesOptimisticLocking && !root.declaresLockVersion) args[args.length - 1] = lockExpr;
    return `new ${SUBJECT_ROOT}(${args.join(', ')})`;
  };
  if (!domainMembers(model, root).some((member) => member.name === childRelation.name)) throw new Error('invariant-check: el sujeto no tiene sus imágenes en el dominio');

  const tests = [];
  const counter = new Map();
  for (const vector of vectors) {
    const index = (counter.get(vector.case) ?? 0) + 1;
    counter.set(vector.case, index);
    const method = `${vector.case.toLowerCase().replace('-', '')}_${index}`;
    const title = `    // ${vector.case}: ${vector.title}${vector.expect ? ` → ${vector.expect}` : ''}`;
    const rejected = (expression) => `        DomainException rejected = assertThrows(DomainException.class, () -> ${port}.save(${expression}));
        assertEquals(${java(vector.expect)}, rejected.getCode());`;
    let body;
    if (vector.case === 'IC-10') {
      // Una fila válida que ya existía; el rechazo no tiene que tocarla.
      body = `        UUID id = UUID.randomUUID();
        ${SUBJECT_ROOT} stored = ${port}.save(${construct({ ...vector.state, ...draftOf(vector.state) }, { idExpr: 'id' })});
${rejected(construct(vector.state, { idExpr: 'id', lockExpr: 'stored.getLockVersion()' }))}
        assertEquals(String.valueOf(stored.getStatus()), String.valueOf(${raw}.findById(id).orElseThrow().getStatus()));`;
    } else if (vector.case === 'CP-5') {
      // Guardado antes con una imagen más: lo que queda en la columna tiene que ser el derivado de lo que hay AHORA.
      const kept = vector.state[childRelation.name];
      const extra = { ...kept[0], storageKey: 'img-extra.png', position: kept.length + 1 };
      const ids = kept.map((_, at) => `image${at}`);
      const declarations = ids.map((name) => `        UUID ${name} = UUID.randomUUID();`).join('\n');
      const asserts = Object.entries(vector.derived).map(([name, value]) => assertDerived(fieldOf(root, name), `row.get${capital(name)}()`, value));
      body = `        UUID id = UUID.randomUUID();
${declarations}
        ${SUBJECT_ROOT} stored = ${port}.save(${construct({ ...vector.state, [childRelation.name]: [...kept, extra] }, { idExpr: 'id', imageIds: ids })});
        ${port}.save(${construct(vector.state, { idExpr: 'id', lockExpr: 'stored.getLockVersion()', imageIds: ids })});
        var row = ${raw}.findById(id).orElseThrow();
${asserts.join('\n')}`;
    } else if (vector.expect) {
      body = rejected(construct(vector.state));
    } else {
      const asserts = Object.entries(vector.derived ?? {}).map(([name, value]) => assertDerived(fieldOf(root, name), `saved.get${capital(name)}()`, value));
      body = `        ${SUBJECT_ROOT} saved = ${port}.save(${construct(vector.state)});${asserts.length > 0 ? `\n${asserts.join('\n')}` : ''}`;
    }
    tests.push(`${title}
    @Test
    void ${method}() {
${body}
    }`);
  }

  return `package ${model.service.basePackage}.${PACKAGE_LEAF};

${[...imports].sort().map((entry) => `import ${entry};`).join('\n')}

/**
 * La guarda del agregado (DSL 2.31) contra lo que emitió build y el motor real de infra/: los vectores IC-* y CP-* de
 * keel-core. Lo escribe scripts/invariant-check.js desde src/lib/invariant-probes.js: no es parte del proyecto.
 */
@SpringBootTest(properties = {
${['"scheduling.enabled=false"', ...properties].map((property) => `        ${property}`).join(',\n')}
})
@ActiveProfiles("local")
class ${CLASS_NAME} {

${fields.join('\n\n')}

    @BeforeEach
    void vacia() {
        ${raw}.deleteAll();
    }

${tests.join('\n\n')}
}
`;
}

/** El mismo estado en borrador y sin marcas: una fila válida de partida para IC-10. */
function draftOf() {
  return { status: 'draft', publishedAt: null, retiredAt: null, attributes: null };
}

function assertDerived(field, expression, value) {
  if (field.base === 'decimal') return `        assertEquals(${java(String(value))}, ${expression}.toPlainString());`;
  return `        assertEquals(${field.base === 'long' ? `${value}L` : `Integer.valueOf(${value})`}, ${expression});`;
}
