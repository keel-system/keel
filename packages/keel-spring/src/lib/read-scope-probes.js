// Las sondas de la LECTURA ACOTADA (DSL 2.27, `reads` y `readMiss`) para keel-spring: los casos RS-1 a RS-11 de
// keel-core/gen/read-scope.js, con los mismos ids que ejecutarán keel-nest, keel-dotnet y keel-go sobre los MISMOS
// diseños (keel-core/test/helpers/read-scope-designs.js). Dos clases JUnit que scripts/read-scope-check.js escribe
// dentro del proyecto generado (no forman parte de él):
//
//   · el ADAPTADOR (RS-1 a RS-8), contra el motor real que levanta infra/: el listado y su total acotados, el scope sin
//     filtro, la carga por id o por clave con su readMiss, el conjunto vacío y la composición con los criterios;
//   · el BORDE (RS-9 a RS-11), sin base: la clave de caché por scope, ReadScopes desde un token y el 403 del cable.
//
// Las etiquetas importan para el falsado: cada sabotaje tiene que caer en EXACTAMENTE sus casos. En una raíz cuyo
// campo acotado está al otro lado de una relación (Asset.owner → Owner.code), lo que solo es verdad si el camino es el
// correcto (la fila propia se ve, la ajena no, el total) es RS-8; lo que sigue siendo verdad con el camino roto (el
// scope sin filtro, el vacío, la fila que no existe, la ajena) conserva su caso.

import { findersOf } from '@keel-system/keel-core/gen';
import { READ_SCOPE_KEY_CASES, readMissMessage, readScopePath, scopedRootsOf, scopedReadsOf } from '@keel-system/keel-core/gen/read-scope';
import { cachedOperations } from '@keel-system/keel-core/gen/cache-plan';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { DOMAIN_ERROR_RESPONSES } from '@keel-system/keel-core/gen/api-errors';
import { constructorArgs } from './finder-probes.js';
import { conexionPerezosa } from './claim-probes.js';
import { messageComponents } from '../scaffold/services.js';
import { scopedLoadsOf, readScopesMethod } from '../scaffold/read-scope.js';

export const PACKAGE_LEAF = 'readscopecheck';
export const ADAPTER_CLASS = 'ReadScopeAdapterCheckTest';
export const EDGE_CLASS = 'ReadScopeEdgeCheckTest';

const java = (text) => JSON.stringify(text);
const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const decap = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;

/** Las raíces acotadas, con su lectura, su camino y lo que las sondas necesitan de ellas. */
export function scopedRoots(model) {
  return scopedRootsOf(model).map(({ entity, read }) => {
    const path = readScopePath(model, read);
    if (path.hops.length > 1) throw new Error(`read-scope-check: ${entity.name} se acota por ${path.hops.length} saltos; las sondas recorren uno`);
    return { entity, read, path, target: path.hops[0]?.entity ?? null, finders: findersOf(model, entity.name).filter((finder) => finder.scope), loads: scopedLoadsOf(model, entity) };
  });
}

/** Los tipos que nombran las sondas y cuyo paquete hay que leer del proyecto generado. */
export function namedTypes(model) {
  const names = new Set();
  const visit = (field) => {
    if (field.kind === 'enum') names.add(field.namedType);
    if (field.kind === 'composite') {
      names.add(field.namedType);
      model.valueObjects.find((candidate) => candidate.name === field.namedType)?.fields.forEach(visit);
    }
  };
  for (const { entity, target, finders } of scopedRoots(model)) {
    for (const subject of [entity, target].filter(Boolean)) {
      names.add(subject.name);
      subject.fields.forEach(visit);
    }
    for (const finder of finders) for (const criterion of finder.criteria) visit(criterion.input);
  }
  return [...names];
}

/** Las raíces cuyo adaptador importa la sonda: las acotadas y las del otro lado del camino. */
export function probedEntities(model) {
  const names = new Set();
  for (const { entity, target } of scopedRoots(model)) {
    names.add(entity.name);
    if (target) names.add(target.name);
  }
  return [...names];
}

/** Los casos que ejecuta la sonda de este diseño: con ellos se calcula qué tiene que caer con cada sabotaje. */
export function casesOf(model) {
  const cases = new Set();
  for (const { read, path, finders, loads } of scopedRoots(model)) {
    const hop = path.hops.length > 0;
    if (finders.length > 0) {
      cases.add(hop ? 'RS-8' : 'RS-1');
      if (finders.some((finder) => finder.result === 'page')) cases.add(hop ? 'RS-8' : 'RS-2');
      cases.add('RS-3');
      if (read.kind === 'scoping') cases.add(hop ? 'RS-8' : 'RS-6');
      if (finders.some((finder) => compositionFilter(finder))) cases.add('RS-7');
    }
    if (loads.length > 0) {
      cases.add(hop ? 'RS-8' : read.readMiss === 'forbidden' ? 'RS-5' : 'RS-4');
      cases.add(read.readMiss === 'forbidden' ? 'RS-5' : 'RS-4');
      cases.add('RS-3');
    }
    if (finders.length > 0) cases.add('RS-6');
  }
  if (cachedScoped(model)) cases.add('RS-9');
  if (edgeReads(model).length > 0) cases.add('RS-10');
  if (scopedReadsOf(model).some((operation) => operation.readScope.readMiss === 'forbidden')) cases.add('RS-11');
  return [...cases].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
}

/** El primer criterio del finder con el que se puede pedir algo que ninguna fila sembrada cumple (RS-7). */
function compositionFilter(finder) {
  return finder.criteria.find((criterion) => criterion.op === 'eq' && criterion.match === 'exact' && (criterion.input.kind === 'enum' || criterion.input.javaType === 'String')) ?? null;
}

// ─── El adaptador ────────────────────────────────────────────────────────────────────────────────────────────

export function adapterTestClass(model, { packages, document, datasource, collaborators = [] }) {
  const imports = new Set([
    'java.math.BigDecimal',
    'java.time.Instant',
    'java.time.LocalDate',
    'java.util.Arrays',
    'java.util.List',
    'java.util.Optional',
    'java.util.Set',
    'java.util.UUID',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.context.annotation.Import',
    'org.springframework.data.domain.PageRequest',
    `${packages.port}.ReadScope`,
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertFalse',
    'static org.junit.jupiter.api.Assertions.assertThrows',
    'static org.junit.jupiter.api.Assertions.assertTrue'
  ]);
  const use = { enum: (name) => imports.add(`${packages.types[name]}.${name}`), type: (name) => imports.add(`${packages.types[name]}.${name}`) };
  const fields = [];
  for (const name of probedEntities(model)) {
    imports.add(`${packages.types[name]}.${name}`);
    imports.add(`${packages.port}.${name}Repository`);
    imports.add(`${packages.adapters}.${name}RepositoryImpl`);
    fields.push(`    @Autowired\n    private ${name}Repository ${decap(name)}Repository;`);
  }
  const tests = [];
  let seed = 701;
  for (const { entity, read, path, target, finders, loads } of scopedRoots(model)) {
    const port = `${decap(entity.name)}Repository`;
    const getter = (name) => `get${capital(name)}()`;
    const idOf = (row) => `${row}.${getter(entity.idField.name)}`;
    const hop = path.hops.length > 0;
    const scopeOf = (value) => (read.kind === 'scoping' ? `ReadScope.within(Set.of(${value}))` : `ReadScope.ownedBy(${value})`);
    const empty = read.kind === 'scoping' ? 'ReadScope.within(Set.of())' : 'ReadScope.ownedBy(null)';
    const rows = finders.length > 0 ? ['a1', 'a2', 'b1'] : ['a1', 'b1'];
    // La siembra: dos dueños (A y B), y filas de A y de B. Con salto, los dueños son filas de la otra raíz y la fila
    // apunta a la suya; sin salto, el valor acotado es el de la propia fila (a2 copia el de a1).
    const seedRows = () => {
      const lines = [];
      if (hop) {
        const targetPort = `${decap(target.name)}Repository`;
        const member = `${path.hops[0].relation}Id`;
        // El campo acotado con un valor que NINGÚN otro campo de texto del dueño repite: si coincidieran (la muestra de
        // texto es `m<seed>` para todos), comparar el campo equivocado del camino daría lo mismo y RS-8 no lo vería.
        const owned = (at) => (path.field.inheritedPattern ? {} : { [read.field]: java(`rs-own-${at}`) });
        const ownerSeedA = seed++;
        const ownerSeedB = seed++;
        lines.push(
          `        ${target.name} ownerA = ${targetPort}.save(new ${target.name}(${constructorArgs(model, target, ownerSeedA, owned(ownerSeedA), use).join(', ')}));`,
          `        ${target.name} ownerB = ${targetPort}.save(new ${target.name}(${constructorArgs(model, target, ownerSeedB, owned(ownerSeedB), use).join(', ')}));`,
          `        String valueA = ownerA.${getter(read.field)};`,
          `        String valueB = ownerB.${getter(read.field)};`
        );
        for (const row of rows) {
          const owner = row.startsWith('a') ? 'ownerA' : 'ownerB';
          lines.push(`        ${entity.name} ${row} = ${port}.save(new ${entity.name}(${constructorArgs(model, entity, seed++, { [member]: `${owner}.${getter(target.idField.name)}` }, use).join(', ')}));`);
        }
      } else {
        lines.push(`        ${entity.name} a1 = ${port}.save(new ${entity.name}(${constructorArgs(model, entity, seed++, {}, use).join(', ')}));`, `        String valueA = a1.${getter(read.field)};`);
        if (rows.includes('a2')) lines.push(`        ${entity.name} a2 = ${port}.save(new ${entity.name}(${constructorArgs(model, entity, seed++, { [read.field]: 'valueA' }, use).join(', ')}));`);
        lines.push(`        ${entity.name} b1 = ${port}.save(new ${entity.name}(${constructorArgs(model, entity, seed++, {}, use).join(', ')}));`, `        String valueB = b1.${getter(read.field)};`);
      }
      lines.push('        assertFalse(valueA.equals(valueB), "la siembra dio el mismo valor acotado a A y a B");');
      return lines.join('\n');
    };
    const name = entity.name;
    for (const finder of finders) {
      const filterNulls = finder.criteria.length > 0 ? `new ${entity.name}Repository.${finder.filterType}(${finder.criteria.map(() => 'null').join(', ')})` : null;
      const call = (scope, { size = 100, filter = filterNulls } = {}) =>
        `${port}.${finder.method}(${[filter, finder.result === 'page' ? `PageRequest.of(0, ${size})` : null, scope].filter(Boolean).join(', ')})`;
      const rowsOf = (scope, options) => `${call(scope, options)}${finder.result === 'page' ? '.getContent()' : ''}.stream().map(row -> row.${getter(entity.idField.name)}).toList()`;
      const listed = hop ? 'rs8' : 'rs1';
      tests.push(`
    @Test
    void ${listed}_${name}_${finder.method}_veSoloLasFilasDelScope() {
${seedRows()}
        List<?> seen = ${rowsOf(scopeOf('valueA'))};
        assertTrue(seen.contains(${idOf('a1')}) && seen.contains(${idOf('a2')}), "${listed.toUpperCase().replace('RS', 'RS-')}: el listado no ve las filas del scope: " + seen);
        assertFalse(seen.contains(${idOf('b1')}), "${listed.toUpperCase().replace('RS', 'RS-')}: el listado ve una fila ajena");
    }`);
      if (finder.result === 'page') {
        const total = hop ? 'rs8' : 'rs2';
        tests.push(`
    @Test
    void ${total}_${name}_${finder.method}_elTotalCuentaSoloElScope() {
${seedRows()}
        var page = ${call(scopeOf('valueA'), { size: 1 })};
        assertEquals(2L, page.getTotalElements(), "${total.toUpperCase().replace('RS', 'RS-')}: el total no son las filas del scope");
        assertEquals(2, page.getTotalPages(), "${total.toUpperCase().replace('RS', 'RS-')}: las páginas no son las del scope");
    }`);
      }
      tests.push(`
    @Test
    void rs3_${name}_${finder.method}_sinFiltroLoVeTodo() {
${seedRows()}
        List<?> seen = ${rowsOf('ReadScope.unrestricted()')};
        assertTrue(seen.containsAll(List.of(${idOf('a1')}, ${idOf('a2')}, ${idOf('b1')})), "RS-3: unrestricted no lo ve todo");
    }`);
      if (read.kind === 'scoping') {
        const multi = hop ? 'rs8' : 'rs6';
        tests.push(`
    @Test
    void ${multi}_${name}_${finder.method}_variosValoresVenLasDeTodos() {
${seedRows()}
        List<?> seen = ${rowsOf('ReadScope.within(Set.of(valueA, valueB))')};
        assertTrue(seen.containsAll(List.of(${idOf('a1')}, ${idOf('a2')}, ${idOf('b1')})), "${multi.toUpperCase().replace('RS', 'RS-')}: within con dos valores no ve las de los dos");
    }`);
      }
      const composed = compositionFilter(finder);
      if (composed) {
        const position = finder.criteria.indexOf(composed);
        let value;
        if (composed.input.kind === 'enum') {
          use.enum(composed.input.namedType);
          value = `Arrays.stream(${composed.input.namedType}.values()).filter(candidate -> candidate != a1.${getter(composed.target.field.name)}).findFirst().orElseThrow()`;
        } else value = java('rs7-ninguna-fila-lo-tiene');
        const filter = `new ${entity.name}Repository.${finder.filterType}(${finder.criteria.map((_, at) => (at === position ? value : 'null')).join(', ')})`;
        tests.push(`
    @Test
    void rs7_${name}_${finder.method}_elScopeSeSumaALosCriterios() {
${seedRows()}
        // Un filtro que no cumple ninguna fila del scope: el resultado tiene que salir vacío. Si el predicado sustituye a
        // los criterios en vez de sumarse, salen las filas de A.
        List<?> seen = ${rowsOf(scopeOf('valueA'), { filter })};
        assertTrue(seen.isEmpty(), "RS-7: el filtro no se aplicó junto al scope: " + seen);
    }`);
      }
    }
    for (const load of loads) {
      const keyOf = (row) => `${row}.${getter(load.param.name)}`;
      const missCase = read.readMiss === 'forbidden' ? 'rs5' : 'rs4';
      const own = hop ? 'rs8' : missCase;
      const label = (tag) => tag.toUpperCase().replace('RS', 'RS-');
      const nonexistent = load.param.javaType === 'UUID' ? 'UUID.randomUUID()' : load.param.javaType === 'Long' || load.param.javaType === 'long' ? 'Long.MAX_VALUE' : java('rs-no-existe');
      let error = null;
      if (read.readMiss === 'forbidden') {
        const operation = scopedReadsOf(model).find((candidate) => candidate.readScope.root === entity.name && candidate.readScope.shape === 'single');
        error = operationError(model, operation.name, read.error);
        imports.add(`${packages.errors}.${error.exceptionClass}`);
      }
      const miss = (row, scope, tag) =>
        error
          ? `        assertThrows(${error.exceptionClass}.class, () -> ${port}.${load.method}(${keyOf(row)}, ${scope}), "${label(tag)}: una fila ajena no da ${read.error}");`
          : `        assertTrue(${port}.${load.method}(${keyOf(row)}, ${scope}).isEmpty(), "${label(tag)}: una fila ajena se cargó");`;
      tests.push(`
    @Test
    void ${own}_${name}_${load.method}_cargaLaFilaPropia() {
${seedRows()}
        Optional<${entity.name}> mine = ${port}.${load.method}(${keyOf('a1')}, ${scopeOf('valueA')});
        assertTrue(mine.isPresent(), "${label(own)}: la fila propia no se cargó");
    }

    @Test
    void ${missCase}_${name}_${load.method}_unaFilaAjenaEsElReadMissYUnaQueNoExisteEsVacio() {
${seedRows()}
${miss('b1', scopeOf('valueA'), missCase)}
        // Orden de la 2.25 (D5): lo que no existe es vacío —su 404— antes que el 403 de lo ajeno.
        assertTrue(${port}.${load.method}(${nonexistent}, ${scopeOf('valueA')}).isEmpty(), "${label(missCase)}: una fila que no existe no da vacío");
    }

    @Test
    void rs3_${name}_${load.method}_sinFiltroCargaCualquiera() {
${seedRows()}
        assertTrue(${port}.${load.method}(${keyOf('b1')}, ReadScope.unrestricted()).isPresent(), "RS-3: unrestricted no carga una fila de B");
    }`);
    }
    // El conjunto vacío (o el dueño nulo) no ve nada, NUNCA todo (D3), en el listado. En la carga es una fila ajena más:
    // lo mide su readMiss (RS-4/RS-5), y medirlo aquí también haría caer RS-6 con una carga que no compara.
    for (const finder of finders.slice(0, 1)) {
      const args = [finder.criteria.length > 0 ? `new ${entity.name}Repository.${finder.filterType}(${finder.criteria.map(() => 'null').join(', ')})` : null, finder.result === 'page' ? 'PageRequest.of(0, 100)' : null, empty].filter(Boolean);
      tests.push(`
    @Test
    void rs6_${name}_${finder.method}_elScopeVacioNoVeNada() {
${seedRows()}
        assertTrue(${port}.${finder.method}(${args.join(', ')})${finder.result === 'page' ? '.getContent()' : ''}.isEmpty(), "RS-6: el scope vacío vio filas");
    }`);
    }
  }

  for (const collaborator of collaborators) imports.add(collaborator.fqn);
  const scanned = collaborators.filter((collaborator) => collaborator.type === 'ReconciliationClaimStore');
  const adapters = [...probedEntities(model).map((name) => `${name}RepositoryImpl.class`), ...collaborators.filter((c) => !scanned.includes(c)).map((collaborator) => `${collaborator.type}.class`)].join(', ');
  if (scanned.length > 0) {
    imports.add('org.springframework.boot.test.context.TestConfiguration');
    imports.add('org.springframework.context.annotation.ComponentScan');
    fields.unshift(`    @TestConfiguration
    @ComponentScan(basePackageClasses = ${scanned.map((c) => `${c.type}.class`).join(', ')})
    static class Collaborators {
    }`);
  }
  const header = document
    ? `@DataMongoTest(properties = {
        ${java(`spring.mongodb.uri=${datasource.uri}`)},
        // El perfil test arranca un mongod EMBEBIDO: sin apagarlo, la sonda mediría una base en memoria.
        "spring.profiles.active=local"
})
@ImportAutoConfiguration(exclude = EmbeddedMongoAutoConfiguration.class)
@Import({ ${adapters} })`
    : `@DataJpaTest(properties = {
        ${java(`spring.datasource.url=${datasource.url}`)},
        ${java(`spring.datasource.username=${datasource.username}`)},
        ${java(`spring.datasource.password=${datasource.password ?? ''}`)},${conexionPerezosa(datasource).map((p) => `\n        ${p},`).join('')}
        "spring.jpa.hibernate.ddl-auto=create-drop",
        "spring.flyway.enabled=false",
        "spring.profiles.active=local"
})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Import({ ${adapters} })
// Sin transacción de test: cada llamada al adaptador es la suya, como en un handler despachado por el mediator.
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
 * La lectura acotada (DSL 2.27) contra el adaptador generado y el motor real que levanta infra/: RS-1 a RS-8. Lo escribe
 * scripts/read-scope-check.js desde src/lib/read-scope-probes.js: no es parte del proyecto.
 */
${header}
class ${ADAPTER_CLASS} {

${fields.join('\n\n')}
${tests.join('\n')}
}
`;
}

// ─── El borde ────────────────────────────────────────────────────────────────────────────────────────────────

/** La lectura acotada que además se cachea, con su operación; o null. */
function cachedScoped(model) {
  const scoped = new Map(scopedReadsOf(model).map((operation) => [operation.name, operation]));
  const cache = cachedOperations(model).find((entry) => scoped.has(entry.operation));
  return cache ? { cache, operation: scoped.get(cache.operation) } : null;
}

/** Un bloque por método de ReadScopes, con su lectura. */
function edgeReads(model) {
  const blocks = new Map();
  for (const operation of scopedReadsOf(model)) blocks.set(readScopesMethod(operation.readScope), operation.readScope);
  return [...blocks.entries()].map(([method, read]) => ({ method, read }));
}

const DEFAULTS = { int: '0', long: '0L', boolean: 'false', double: '0.0' };

export function edgeTestClass(model, { packages }) {
  const imports = new Set([
    'java.util.List',
    'java.util.Set',
    'org.junit.jupiter.api.AfterEach',
    'org.junit.jupiter.api.Test',
    `${packages.port}.ReadScope`,
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertNotEquals',
    'static org.junit.jupiter.api.Assertions.assertTrue'
  ]);
  const tests = [];
  const cached = cachedScoped(model);
  if (cached) {
    const { operation } = cached;
    imports.add(`${packages.support}.CachedOperations`);
    imports.add(`${packages.messages[operation.name]}.${operation.messageClass}`);
    const message = (scope) =>
      `new ${operation.messageClass}(${messageComponents(model, operation).map((component) => (component.readScope ? scope : DEFAULTS[component.javaType] ?? 'null')).join(', ')})`;
    const keyCases = READ_SCOPE_KEY_CASES.map((entry) => {
      const scope =
        entry.scope.kind === 'unrestricted'
          ? 'ReadScope.unrestricted()'
          : entry.scope.kind === 'ownedBy'
            ? `ReadScope.ownedBy(${entry.scope.value == null ? 'null' : java(entry.scope.value)})`
            : `ReadScope.within(List.of(${entry.scope.values.map(java).join(', ')}))`;
      return `        assertEquals(${java(entry.key)}, ${scope}.cacheKey(), "RS-9 ${entry.id}");`;
    });
    tests.push(`
    @Test
    void rs9_laParteDelScopeEnLaClaveEsLaDeKeelCore() {
${keyCases.join('\n')}
    }

    @Test
    void rs9_dosLlamantesConScopesDistintosNoCompartenEntrada() {
        String a = CachedOperations.${operation.name}Key(${message('ReadScope.within(Set.of("a"))')});
        String b = CachedOperations.${operation.name}Key(${message('ReadScope.within(Set.of("b"))')});
        String owner = CachedOperations.${operation.name}Key(${message('ReadScope.ownedBy("a")')});
        assertNotEquals(a, b, "RS-9: dos scopes distintos comparten la entrada " + a);
        assertNotEquals(a, owner, "RS-9: within(a) y ownedBy(a) comparten la entrada " + a);
        // Dos exentos sí la comparten: los dos lo ven todo.
        assertEquals(CachedOperations.${operation.name}Key(${message('ReadScope.unrestricted()')}), CachedOperations.${operation.name}Key(${message('ReadScope.unrestricted()')}), "RS-9: dos exentos no comparten entrada");
    }`);
  }

  const edges = edgeReads(model);
  if (edges.length > 0) {
    imports.add(`${packages.security}.ReadScopes`);
    imports.add('org.springframework.security.core.authority.SimpleGrantedAuthority');
    imports.add('org.springframework.security.core.context.SecurityContextHolder');
    imports.add('org.springframework.security.oauth2.jwt.Jwt');
    imports.add('org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken');
    const scopingRead = edges.find(({ read }) => read.kind === 'scoping');
    if (scopingRead) {
      imports.add(`${packages.security}.JwtCallerScope`);
    }
    const scopes = scopingRead ? 'new ReadScopes(new JwtCallerScope())' : 'new ReadScopes()';
    const identity = model.security?.callerIdentity;
    for (const { method, read } of edges) {
      const checks = [];
      for (const role of read.exemptRoles) checks.push(`        as(List.of(${java(role)}), ${identityClaim(identity)});\n        assertEquals(ReadScope.unrestricted(), scopes.${method}(), "RS-10: el rol exento ${role} no da unrestricted");`);
      for (const client of read.exemptClients) checks.push(`        as(List.of(), "azp", ${java(client)});\n        assertEquals(ReadScope.unrestricted(), scopes.${method}(), "RS-10: el cliente exento ${client} no da unrestricted");`);
      if (read.kind === 'scoping') {
        checks.push(
          `        as(List.of(), ${java(read.claim)}, List.of("A", "B"));\n        assertEquals(ReadScope.within(Set.of("A", "B")), scopes.${method}(), "RS-10: el claim no da su conjunto");`,
          `        as(List.of(), "sub", "sin-claim");\n        assertEquals(ReadScope.within(Set.of()), scopes.${method}(), "RS-10: el claim ausente no da el conjunto vacío");`
        );
      } else {
        checks.push(`        as(List.of(), ${identityClaim(identity)});\n        assertEquals(ReadScope.ownedBy("rs10@x.io"), scopes.${method}(), "RS-10: el dueño no es la identidad del llamante");`);
      }
      tests.push(`
    @Test
    void rs10_${method}_construyeElScopeDesdeElToken() {
        ReadScopes scopes = ${scopes};
${checks.join('\n')}
    }`);
    }
    tests.push(`
    /** Pone en el contexto un JWT con estos roles ({@code ROLE_<rol>}) y estos claims (nombre, valor, ...). */
    private static void as(List<String> roles, Object... claims) {
        Jwt.Builder token = Jwt.withTokenValue("rs10").header("alg", "none").claim("sub", "rs10");
        for (int at = 0; at < claims.length; at += 2) {
            token.claim((String) claims[at], claims[at + 1]);
        }
        var authorities = roles.stream().map(role -> new SimpleGrantedAuthority("ROLE_" + role)).toList();
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(token.build(), authorities));
    }

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }`);
  }

  const forbidden = scopedReadsOf(model).find((operation) => operation.readScope.readMiss === 'forbidden' && operation.readScope.shape === 'single');
  if (forbidden) {
    const read = forbidden.readScope;
    const error = operationError(model, forbidden.name, read.error);
    imports.add(`${packages.errors}.${error.exceptionClass}`);
    imports.add(`${packages.rest}.ApiExceptionHandler`);
    imports.add(`${packages.rest}.ErrorResponse`);
    imports.add('org.springframework.http.ResponseEntity');
    const message = readMissMessage(model, read);
    const ctor = error.dynamicStatus ? `new ${error.exceptionClass}(${java(message)}, 403)` : `new ${error.exceptionClass}(${java(message)})`;
    tests.push(`
    @Test
    void rs11_elReadMissForbiddenSaleComo403ConSuCodeYSuTexto() {
        ResponseEntity<ErrorResponse> response = new ApiExceptionHandler().onDomainException(${ctor});
        assertEquals(403, response.getStatusCode().value(), "RS-11: status");
        ErrorResponse body = response.getBody();
        assertEquals(403, body.status(), "RS-11: status del cuerpo");
        assertEquals(${java(DOMAIN_ERROR_RESPONSES.ForbiddenException.error)}, body.error(), "RS-11: error");
        assertEquals(${java(read.error)}, body.code(), "RS-11: code");
        assertEquals(${java(message)}, body.message(), "RS-11: message");
    }`);
  }
  return `package ${model.service.basePackage}.${PACKAGE_LEAF};

${[...imports].sort().map((entry) => `import ${entry};`).join('\n')}

/**
 * La lectura acotada (DSL 2.27) en el borde, sin base: RS-9 a RS-11. Lo escribe scripts/read-scope-check.js desde
 * src/lib/read-scope-probes.js: no es parte del proyecto.
 */
class ${EDGE_CLASS} {
${tests.join('\n')}
}
`;
}

/** Los argumentos de `as(...)` que dan la identidad del llamante `rs10@x.io` según de dónde la lee CallerIdentity. */
function identityClaim(identity) {
  if (!identity) return '"sub", "rs10@x.io"';
  return identity.source === 'claim' ? `${java(identity.claim)}, "rs10@x.io"` : '"azp", "rs10@x.io"';
}
