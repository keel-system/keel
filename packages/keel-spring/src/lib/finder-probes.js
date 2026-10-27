// La sonda de los FINDERS de las búsquedas (DSL 2.22) para keel-spring: un JUnit que construye el agregado por su
// constructor, lo guarda con el ADAPTADOR generado y llama a cada finder contra el motor real que levanta infra/. Las
// mismas preguntas que el db-check/doc-check de keel-dotnet y keel-nest, con el vocabulario de
// keel-core/gen/query-filters.js: una fila que cumple el `where` (releída tras guardarla) y otra que no; por criterio,
// un valor que la encuentra y otros que no — los extremos de gte/lte dentro, los de gt/lt fuera y el texto como literal.
// La escribe scripts/finder-check.js; no forma parte del proyecto generado.

import { findersOf, FINDER_PROBE_TEXT, finderTextProbes } from 'keel-core/gen';
import { screamingSnake } from 'keel-core/gen/naming';
import { LOCK_VERSION } from 'keel-core/gen/relational';
import { domainMembers } from '../scaffold/entities.js';

export const CLASS_NAME = 'FinderCheckTest';
export const PACKAGE_LEAF = 'findercheck';

const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const java = (text) => JSON.stringify(text);

/**
 * Un texto que cumple un patrón sencillo (clases `[A-Z]`, `[a-z]`, `[0-9]`, `\d`, literales y cuantificadores
 * `{n}`, `{n,m}`, `+`, `*`, `?`). `seed` varía los dígitos y las letras: dos filas no comparten valor. Null si el patrón
 * tiene algo que no sé recorrer, y entonces lo dice el runner nombrando el campo.
 */
export function textForPattern(pattern, seed) {
  let source = pattern.replace(/^\^/, '').replace(/\$$/, '');
  const tokens = [];
  while (source.length > 0) {
    let set;
    const klass = /^\[([^\]]+)\]/.exec(source) ?? (/^\\d/.test(source) ? ['\\d', '0-9'] : null);
    if (klass) {
      set = klass[1];
      source = source.slice(klass[0].length);
    } else if (/^[\\(|.]/.test(source)) {
      if (source.startsWith('\\') && source.length > 1 && !/[dws]/i.test(source[1])) {
        set = { literal: source[1] };
        source = source.slice(2);
      } else return null;
    } else {
      set = { literal: source[0] };
      source = source.slice(1);
    }
    let count = 1;
    const quantifier = /^\{(\d+)(?:,(\d*))?\}|^[+*?]/.exec(source);
    if (quantifier) {
      count = quantifier[1] != null ? Number(quantifier[1]) : quantifier[0] === '+' ? 1 : 0;
      source = source.slice(quantifier[0].length);
    }
    tokens.push({ set, count });
  }
  let index = 0;
  const pick = (set) => {
    if (typeof set === 'object') return set.literal;
    const ranges = [...set.matchAll(/(.)-(.)/g)].map((match) => [match[1].charCodeAt(0), match[2].charCodeAt(0)]);
    if (ranges.length === 0) return set[0];
    const [from, to] = ranges[0];
    const value = String.fromCharCode(from + ((seed + index++) % (to - from + 1)));
    return value;
  };
  return tokens.map(({ set, count }) => Array.from({ length: count }, () => pick(set)).join('')).join('');
}

/** El valor Java de muestra de un campo del dominio (o de un value object), o lanza nombrando el campo. */
function sampleFor(model, field, seed, use) {
  if (field.list) return 'List.of()';
  if (field.kind === 'enum') {
    use.enum(field.namedType);
    return `${field.namedType}.values()[0]`;
  }
  if (field.kind === 'composite') {
    const vo = model.valueObjects.find((candidate) => candidate.name === field.namedType);
    use.type(vo.name);
    return `new ${vo.name}(${vo.fields.map((sub) => sampleFor(model, sub, seed, use)).join(', ')})`;
  }
  switch (field.base) {
    case 'uuid':
      return 'UUID.randomUUID()';
    case 'int':
      return String(seed);
    case 'long':
      return `${seed}L`;
    case 'decimal':
      return 'new BigDecimal("10.00")';
    case 'boolean':
      return 'false';
    case 'timestamp':
      return 'Instant.now()';
    case 'date':
      return 'LocalDate.now()';
    default: {
      const pattern = field.inheritedPattern ?? null;
      if (pattern) {
        const text = textForPattern(pattern, seed);
        if (text === null || !new RegExp(pattern).test(text)) throw new Error(`finder-check: no sé fabricar un valor para el formato de '${field.name}' (${pattern})`);
        return java(text);
      }
      // Dentro de las cotas del campo (`size`): un Money con su moneda de 3 letras no admite otra cosa.
      const size = (field.inputRules ?? []).find((rule) => rule.rule === 'size') ?? {};
      const min = size.min ?? 1;
      const max = size.max ?? field.textMaxLength ?? Infinity;
      const text = `m${seed}`.padEnd(min, 'x');
      return java(text.length > max ? text.slice(0, max) : text);
    }
  }
}

/** Los argumentos del constructor completo del agregado, en el orden de sus miembros, con los valores forzados. */
function constructorArgs(model, entity, seed, forced, use) {
  const args = domainMembers(model, entity).map((member) => {
    if (forced[member.name] != null) return forced[member.name];
    if (member.kind === 'externalRef') return 'UUID.randomUUID()';
    if (member.kind === 'relationMany') return 'List.of()';
    if (member.kind === 'relationOne') return 'null';
    return sampleFor(model, member.field, seed, use);
  });
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) args.push('null');
  return args;
}

/** Las clases de prueba de cada raíz con finders, y lo que hay que importar de cada una. */
export function finderTestClass(model, { packages, document, datasource }) {
  const roots = model.entities.filter((entity) => entity.persisted && entity.isAggregateRoot && findersOf(model, entity.name).length > 0);
  const imports = new Set([
    'java.math.BigDecimal',
    'java.time.Instant',
    'java.time.LocalDate',
    'java.util.Arrays',
    'java.util.List',
    'java.util.UUID',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.context.annotation.Import',
    'org.springframework.data.domain.PageRequest',
    'static org.junit.jupiter.api.Assertions.assertTrue',
    'static org.junit.jupiter.api.Assertions.assertFalse'
  ]);
  const use = {
    enum: (name) => imports.add(`${packages.types[name]}.${name}`),
    type: (name) => imports.add(`${packages.types[name]}.${name}`)
  };
  const fields = [];
  const tests = [];
  let seed = 1;
  for (const entity of roots) {
    imports.add(`${packages.types[entity.name]}.${entity.name}`);
    imports.add(`${packages.port}.${entity.name}Repository`);
    imports.add(`${packages.adapters}.${entity.name}RepositoryImpl`);
    const port = `${entity.name[0].toLowerCase()}${entity.name.slice(1)}Repository`;
    fields.push(`    @Autowired\n    private ${entity.name}Repository ${port};`);
    for (const finder of findersOf(model, entity.name)) {
      const textCriteria = finder.criteria.filter((criterion) => criterion.match !== 'exact' && (criterion.target.field.textMaxLength ?? Infinity) > FINDER_PROBE_TEXT.length);
      const fixedLiteral = (entry) => {
        if (entry.field.kind === 'enum') {
          use.enum(entry.field.namedType);
          return `${entry.field.namedType}.${screamingSnake(String(entry.value))}`;
        }
        return typeof entry.value === 'string' ? java(entry.value) : String(entry.value);
      };
      const otherThan = (field, expr) =>
        field.kind === 'enum'
          ? `Arrays.stream(${field.namedType}.values()).filter(value -> value != ${expr}).findFirst().orElseThrow()`
          : field.base === 'boolean'
            ? `!${expr}`
            : `${expr} + "-otro"`;
      const forced = (text, fixed) => Object.fromEntries([
        ...textCriteria.map((criterion) => [criterion.target.field.name, java(text)]),
        ...finder.fixed.map((entry) => [entry.name, fixed(entry)])
      ]);
      const inside = constructorArgs(model, entity, seed++, forced(FINDER_PROBE_TEXT, fixedLiteral), use);
      const outside = constructorArgs(model, entity, seed++, forced(`${FINDER_PROBE_TEXT}2`, (entry) => otherThan(entry.field, fixedLiteral(entry))), use);

      const stored = (criterion) => {
        const { target } = criterion;
        if (target.kind === 'relation') return `s.get${capital(target.relation.name)}Id()`;
        if (target.kind === 'vo') return `s.get${capital(target.field.name)}().${target.sub.name}()`;
        return `s.get${capital(target.field.name)}()`;
      };
      const base = (criterion) => (criterion.target.kind === 'vo' ? criterion.target.sub : criterion.target.field)?.base;
      const shift = (criterion, value, sign) => {
        const kind = base(criterion);
        if (kind === 'timestamp') return `${value}.${sign > 0 ? 'plusSeconds' : 'minusSeconds'}(86400)`;
        if (kind === 'date') return `${value}.${sign > 0 ? 'plusDays' : 'minusDays'}(1)`;
        if (kind === 'decimal') return `${value}.${sign > 0 ? 'add' : 'subtract'}(BigDecimal.ONE)`;
        if (kind === 'long') return `(${value} ${sign > 0 ? '+' : '-'} 1L)`;
        return `(${value} ${sign > 0 ? '+' : '-'} 1)`;
      };
      const locals = [];
      const cases = finder.criteria
        .map((criterion, at) => {
          if (criterion.match !== 'exact') {
            if (!textCriteria.includes(criterion)) return null;
            const { hit, misses } = finderTextProbes(criterion);
            return { criterion, hits: [java(hit)], misses: misses.map(java) };
          }
          const local = `v${at}`;
          locals.push(`        var ${local} = ${stored(criterion)};`);
          const field = criterion.target.kind === 'vo' ? criterion.target.sub : criterion.target.field;
          if (criterion.target.kind === 'relation' || field?.base === 'uuid') return { criterion, hits: [local], misses: ['UUID.randomUUID()'] };
          if (criterion.op === 'eq') {
            const textual = ['string', 'text'].includes(field?.base);
            return { criterion, hits: [textual && criterion.compare !== 'exact' ? `${local}.toUpperCase()` : local], misses: [otherThan(field, local)] };
          }
          const plus = shift(criterion, local, 1);
          const minus = shift(criterion, local, -1);
          const table = { gte: [[local], [plus]], gt: [[minus], [local]], lte: [[local], [minus]], lt: [[plus], [local]] };
          const [hits, misses] = table[criterion.op];
          return { criterion, hits, misses };
        })
        .filter(Boolean);
      const filterOf = (probed, value) =>
        `new ${entity.name}Repository.${finder.filterType}(${finder.criteria
          .map((criterion, at) => (criterion === probed ? value : criterion.required ? `v${at}` : 'null'))
          .join(', ')})`;
      const call = (filter) =>
        finder.result === 'page'
          ? `${port}.${finder.method}(${filter ? `${filter}, ` : ''}PageRequest.of(0, 1000)).getContent()`
          : `${port}.${finder.method}(${filter ?? ''})`;
      const finds = (filter, target) => `${call(filter)}.stream().anyMatch(found -> found.getId().equals(${target}.getId()))`;
      const noFilter = finder.criteria.length > 0 ? filterOf(null, null) : null;
      const checks = [`        assertTrue(${finds(noFilter, 's')}, "sin filtros no encuentra la fila");`];
      for (const { criterion, hits, misses } of cases) {
        for (const hit of hits) checks.push(`        assertTrue(${finds(filterOf(criterion, hit), 's')}, ${java(`${criterion.name} = ${hit} no la encuentra`)});`);
        for (const miss of misses) checks.push(`        assertFalse(${finds(filterOf(criterion, miss), 's')}, ${java(`${criterion.name} = ${miss} la encuentra`)});`);
      }
      if (finder.fixed.length > 0 && !finder.criteria.some((criterion) => criterion.required)) {
        checks.push(`        assertFalse(${finds(noFilter, 'outside')}, "la fila que no cumple el where sale");`);
      }
      tests.push(`
    @Test
    void ${entity.name[0].toLowerCase()}${entity.name.slice(1)}${capital(finder.method)}AplicaLosFiltrosDelDiseño() {
        ${entity.name} inside = ${port}.save(new ${entity.name}(${inside.join(', ')}));
        ${entity.name} outside = ${port}.save(new ${entity.name}(${outside.join(', ')}));
        ${entity.name} s = ${port}.findById(inside.getId()).orElseThrow();
${locals.join('\n')}${locals.length > 0 ? '\n' : ''}${checks.join('\n')}
    }`);
    }
  }

  const adapters = roots.map((entity) => `${entity.name}RepositoryImpl.class`).join(', ');
  const header = document
    ? `@DataMongoTest(properties = {
        ${java(`spring.mongodb.uri=${datasource.uri}`)},
        // El perfil test arranca un mongod EMBEBIDO: sin apagarlo, la sonda mediría una base en memoria. El local trae
        // además los parámetros que el adaptador lee (los plazos de sus barridos).
        "spring.profiles.active=local"
})
@ImportAutoConfiguration(exclude = EmbeddedMongoAutoConfiguration.class)
@Import({ ${adapters} })`
    : `@DataJpaTest(properties = {
        ${java(`spring.datasource.url=${datasource.url}`)},
        ${java(`spring.datasource.username=${datasource.username}`)},
        ${java(`spring.datasource.password=${datasource.password ?? ''}`)},
        "spring.jpa.hibernate.ddl-auto=create-drop",
        "spring.flyway.enabled=false"
})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Import({ ${adapters} })
// Sin transacción de test: el adaptador guarda con la suya, y la del finder lee lo confirmado.
@Transactional(propagation = Propagation.NOT_SUPPORTED)`;
  if (document) {
    imports.add('org.springframework.boot.data.mongodb.test.autoconfigure.DataMongoTest');
    imports.add('org.springframework.boot.autoconfigure.ImportAutoConfiguration');
    imports.add('de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration');
  } else {
    imports.add('org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest');
    imports.add('org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase');
    imports.add('org.springframework.transaction.annotation.Propagation');
    imports.add('org.springframework.transaction.annotation.Transactional');
  }
  return `package ${model.service.basePackage}.${PACKAGE_LEAF};

${[...imports].sort().map((entry) => `import ${entry};`).join('\n')}

/**
 * Los finders de las búsquedas (DSL 2.22), ejecutados contra el motor real que levanta infra/. Lo escribe
 * scripts/finder-check.js desde src/lib/finder-probes.js: no es parte del proyecto generado.
 */
${header}
class ${CLASS_NAME} {

${fields.join('\n\n')}
${tests.join('\n')}
}
`;
}

/** Los tipos que la sonda nombra y cuyo paquete hay que leer del proyecto generado. */
export function namedTypes(model) {
  const names = new Set();
  for (const entity of model.entities.filter((candidate) => candidate.persisted && candidate.isAggregateRoot && findersOf(model, candidate.name).length > 0)) {
    names.add(entity.name);
    const visit = (field) => {
      if (field.kind === 'enum') names.add(field.namedType);
      if (field.kind === 'composite') {
        names.add(field.namedType);
        model.valueObjects.find((candidate) => candidate.name === field.namedType)?.fields.forEach(visit);
      }
    };
    entity.fields.filter((field) => field.name !== LOCK_VERSION.field || entity.declaresLockVersion).forEach(visit);
  }
  return [...names];
}
