// Las sondas del HISTORIAL DE CAMBIOS (DSL 2.29: `audit.history` y la query de `output: { history }`) para keel-spring:
// los casos HI-1 a HI-10 de keel-core/gen/history.js, con los mismos ids que ejecutarán keel-nest, keel-dotnet y keel-go
// sobre los MISMOS diseños (keel-core/test/helpers/history-designs.js). Una clase JUnit que scripts/history-check.js
// escribe dentro del proyecto generado (no forma parte de él), con el contexto entero del perfil `local` contra el motor
// real de infra/ y el cronómetro apagado: la retención se dispara llamando a su recurrente. HI-11 (logs y spans) lo mide
// telemetry-check, como PD-3.
//
// Las etiquetas importan para el falsado: cada sabotaje tiene que caer en EXACTAMENTE sus casos. Por eso HI-6 no escribe
// por el adaptador sino por el almacén (un diff roto no puede tumbar el orden ni el filtro), HI-3 solo afirma que las
// rutas de las hijas ESTÁN (el diff que lo lista todo es HI-2) y HI-4 mira la entrada del alta.

import { lifecycleRoots } from '@keel-system/keel-core/gen/data-lifecycle';
import { HISTORY_CASES } from '@keel-system/keel-core/gen/history';
import { readScopePath, scopedRootsOf } from '@keel-system/keel-core/gen/read-scope';
import { constructorArgs } from './finder-probes.js';
import { domainMembers } from '../scaffold/entities.js';
import { historyReadsOf, recordsHistory } from '../scaffold/history.js';
import { retentionTimerClass } from '../scaffold/data-lifecycle.js';

export const PACKAGE_LEAF = 'historycheck';
export const CLASS_NAME = 'HistoryCheckTest';

const java = (text) => JSON.stringify(text);
const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const decap = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;
const getter = (name) => `get${capital(name)}()`;
const constantOf = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/** Lo que las sondas necesitan de cada raíz con historial. */
export function probedRoots(model) {
  return model.entities.filter(recordsHistory).map((entity) => {
    const lifecycle = lifecycleRoots(model).find((root) => root.entity === entity.name) ?? null;
    const reads = historyReadsOf(model, entity);
    const scoped = reads.some((read) => read.scoped) ? scopedRootsOf(model).find((candidate) => candidate.entity?.name === entity.name) ?? null : null;
    // El campo que cambia una actualización: texto libre de la raíz, sin clave, sin unicidad y sin formato.
    const editable = entity.fields.find(
      (field) =>
        field.base === 'string' && !field.list && field.kind !== 'composite' && field.kind !== 'enum' && !field.isId && !field.unique &&
        !field.inheritedPattern && !(entity.naturalKey ?? []).includes(field.name) && entity.historyShape.paths.includes(field.name)
    );
    if (!editable) throw new Error(`history-check: ${entity.name} no tiene un campo de texto libre que editar`);
    return { entity, lifecycle, reads, scoped, editable };
  });
}

/** Los casos que ejecuta la sonda de este diseño: con ellos se calcula qué tiene que caer con cada sabotaje. */
export function casesOf(model) {
  const cases = new Set();
  for (const { entity, lifecycle, reads } of probedRoots(model)) {
    cases.add('HI-1').add('HI-2').add('HI-4').add('HI-5').add('HI-6');
    if (entity.historyShape.children.length > 0 || entity.historyShape.paths.some((path) => path.includes('.'))) cases.add('HI-3');
    if (reads.length > 0 && (lifecycle?.logical || reads.some((read) => read.scoped))) cases.add('HI-7');
    if (lifecycle?.restore) cases.add('HI-10');
    if (lifecycle?.retention?.fromDeleted) cases.add(lifecycle.retention.then === 'anonymize' ? 'HI-8' : 'HI-9');
  }
  const order = HISTORY_CASES.map((entry) => entry.id);
  return [...cases].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** Los tipos del dominio cuyo paquete hay que leer del proyecto generado. */
export function namedTypes(model) {
  const names = new Set();
  const visit = (field) => {
    if (field.kind === 'enum' || field.kind === 'composite') names.add(field.namedType);
    if (field.kind === 'composite') model.valueObjects.find((candidate) => candidate.name === field.namedType)?.fields.forEach(visit);
  };
  for (const { entity, scoped } of probedRoots(model)) {
    const subjects = [entity, ...entity.historyShape.children.map((child) => model.entities.find((candidate) => candidate.name === child.entity))];
    if (scoped) subjects.push(readScopePath(model, scoped.read).hops[0]?.entity);
    for (const subject of subjects.filter(Boolean)) {
      names.add(subject.name);
      subject.fields.forEach(visit);
    }
  }
  return [...names];
}

/** Las raíces que la sonda vacía antes de cada caso. */
export function wipedEntities(model) {
  const names = new Set();
  for (const { entity, scoped } of probedRoots(model)) {
    names.add(entity.name);
    const target = scoped ? readScopePath(model, scoped.read).hops[0]?.entity : null;
    if (target) names.add(target.name);
  }
  return [...names];
}

/** Las clases de la retención que la sonda nombra (las busca el script en el proyecto). */
export function retentionTimers(model) {
  return probedRoots(model).filter(({ lifecycle }) => lifecycle?.retention).map(({ entity }) => retentionTimerClass(entity.name));
}

/**
 * La clase de prueba. `packages`: port, adapters (repositorios del almacén), mirrors, history, timer y types; `engine`
 * decide cómo se escribe una hora en la tabla (HI-6).
 */
export function historyTestClass(model, { packages, document, engine, properties = [], doubles = [] }) {
  const imports = new Set([
    'java.math.BigDecimal',
    'java.time.Duration',
    'java.time.Instant',
    'java.time.LocalDate',
    'java.time.ZoneOffset',
    'java.util.List',
    'java.util.Map',
    'java.util.Set',
    'java.util.UUID',
    'java.util.function.Supplier',
    'java.util.stream.Stream',
    'org.junit.jupiter.api.BeforeEach',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.test.context.SpringBootTest',
    'org.springframework.data.domain.PageRequest',
    'org.springframework.security.core.context.SecurityContextHolder',
    'org.springframework.test.context.ActiveProfiles',
    'org.springframework.transaction.PlatformTransactionManager',
    'org.springframework.transaction.support.TransactionTemplate',
    'tools.jackson.databind.JsonNode',
    'tools.jackson.databind.node.NullNode',
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertFalse',
    'static org.junit.jupiter.api.Assertions.assertTrue',
    ...['ChangeHistory', 'FieldChange', 'HistoryEntry', 'HistoryFilter', 'HistoryRoots'].map((name) => `${packages.history}.${name}`)
  ]);
  const use = { enum: (name) => imports.add(`${packages.types[name]}.${name}`), type: (name) => imports.add(`${packages.types[name]}.${name}`) };
  const store = (name) => (document ? `${name}MongoRepository` : `${name}JpaRepository`);
  const mirror = (name) => (document ? `${name}Document` : `${name}Jpa`);
  const fields = [
    '    @Autowired\n    private ChangeHistory changeHistory;',
    '    @Autowired\n    private PlatformTransactionManager transactionManager;'
  ];
  const wipes = [];
  for (const name of wipedEntities(model)) {
    imports.add(`${packages.types[name]}.${name}`);
    imports.add(`${packages.port}.${name}Repository`);
    imports.add(`${packages.adapters}.${store(name)}`);
    fields.push(`    @Autowired\n    private ${name}Repository ${decap(name)}Repository;`, `    @Autowired\n    private ${store(name)} ${decap(store(name))};`);
    wipes.push(`        ${decap(store(name))}.deleteAll();`);
  }
  // El historial de cada caso empieza vacío: por el almacén, que es lo que se mide.
  if (document) {
    imports.add('org.springframework.data.mongodb.core.MongoTemplate');
    imports.add('org.springframework.data.mongodb.core.query.Criteria');
    imports.add('org.springframework.data.mongodb.core.query.Query');
    imports.add('org.springframework.data.mongodb.core.query.Update');
    imports.add('java.util.Date');
    fields.push('    @Autowired\n    private MongoTemplate mongoTemplate;');
    wipes.push('        mongoTemplate.remove(new Query(), "change_history");');
  } else {
    imports.add('javax.sql.DataSource');
    imports.add('org.springframework.jdbc.core.simple.JdbcClient');
    imports.add(engine === 'mysql' ? 'java.time.LocalDateTime' : 'java.time.OffsetDateTime');
    fields.push('    @Autowired\n    private DataSource dataSource;');
    wipes.push('        JdbcClient.create(dataSource).sql("DELETE FROM change_history_field").update();', '        JdbcClient.create(dataSource).sql("DELETE FROM change_history").update();');
  }
  if (doubles.length > 0) imports.add('org.springframework.test.context.bean.override.mockito.MockitoBean');
  for (const port of doubles) {
    imports.add(port.fqn);
    fields.push(`    @MockitoBean\n    private ${port.type} ${decap(port.type)};`);
  }
  // HI-6: mover la hora de las entradas que tocaron una ruta, para medir el orden y las fechas sin esperar.
  const ageEntry = document
    ? `    private void setAt(String path, Instant at) {
        mongoTemplate.updateMulti(new Query(Criteria.where("fields.path").is(path)), new Update().set("at", Date.from(at)), "change_history");
    }`
    : `    private void setAt(String path, Instant at) {
        JdbcClient.create(dataSource)
                .sql("UPDATE change_history SET at = :at WHERE id IN (SELECT entry_id FROM change_history_field WHERE path = :path)")
                .param("at", ${engine === 'mysql' ? 'LocalDateTime.ofInstant(at, ZoneOffset.UTC)' : 'OffsetDateTime.ofInstant(at, ZoneOffset.UTC)'})
                .param("path", path)
                .update();
    }`;
  const tests = [];
  let seed = 901;
  const security = model.security?.protocol;
  const jwt = security === 'oidc' || security === 'jwt';
  if (jwt) {
    imports.add('org.springframework.security.oauth2.jwt.Jwt');
    imports.add('org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken');
  } else {
    imports.add('org.springframework.security.authentication.UsernamePasswordAuthenticationToken');
  }
  const authenticate = (subject) =>
    jwt
      ? `SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(Jwt.withTokenValue("hi5").header("alg", "none").subject(${java(subject)}).build()));`
      : `SecurityContextHolder.getContext().setAuthentication(UsernamePasswordAuthenticationToken.authenticated(${java(subject)}, null, List.of()));`;

  for (const probe of probedRoots(model)) {
    const { entity, lifecycle, reads, scoped, editable } = probe;
    const name = entity.name;
    const shape = entity.historyShape;
    const type = `HistoryRoots.${constantOf(name)}`;
    const port = `${decap(name)}Repository`;
    const raw = decap(store(name));
    const id = (row) => `${row}.${getter(entity.idField.name)}`;
    const key = (row) => `String.valueOf(${id(row)})`;
    const fresh = (variable, forced = {}) =>
      `        ${name} ${variable} = ${port}.save(new ${name}(${constructorArgs(model, entity, seed++, forced, use).join(', ')}));`;
    // Una copia de lo que hay en el almacén con algunos miembros cambiados: así se actualiza sin setters y con la versión vigente.
    const copy = (variable, overrides = {}) => {
      const args = domainMembers(model, entity).map((member) => overrides[member.name] ?? `${variable}.${getter(member.name)}`);
      if (entity.usesOptimisticLocking && !entity.declaresLockVersion) args.push(`${variable}.getLockVersion()`);
      return `new ${name}(${args.join(', ')})`;
    };
    const update = (row, overrides) => `        ${port}.save(${copy(`${port}.findById(${id(row)}).orElseThrow()`, overrides)});`;
    const edited = (text) => ({ [editable.name]: java(text) });

    tests.push(`
    @Test
    void hi1_${name}_altaCambioYBajaDejanSuEntradaYUnRollbackNinguna() {
${fresh('fila')}
${update('fila', edited(`hi1-${seed}`))}
        ${port}.deleteById(${id('fila')});
        assertEquals(List.of("deleted", "updated", "created"), kinds(${type}, ${key('fila')}), "HI-1: las entradas de alta, cambio y baja");
        ${name} revertida = new ${name}(${constructorArgs(model, entity, seed++, {}, use).join(', ')});
        new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
            ${port}.save(revertida);
            status.setRollbackOnly();
        });
        assertTrue(entries(${type}, ${key('revertida')}).isEmpty(), "HI-1: una escritura que revierte dejó su entrada");
    }`);

    const value2 = `hi2-${seed}`;
    tests.push(`
    @Test
    void hi2_${name}_soloLoQueCambioYUnGuardadoSinCambiosNoEscribe() {
${fresh('fila')}
${update('fila', {})}
        assertEquals(List.of("created"), kinds(${type}, ${key('fila')}), "HI-2: un guardado sin cambios escribió una entrada");
        JsonNode before = changeHistory.value(${port}.findById(${id('fila')}).orElseThrow().${getter(editable.name)});
${update('fila', edited(value2))}
        HistoryEntry last = entries(${type}, ${key('fila')}).get(0);
        assertEquals(List.of(${java(editable.name)}), last.changes().stream().map(FieldChange::field).toList(), "HI-2: la entrada lleva lo que no cambió");
        assertEquals(before, last.changes().get(0).before(), "HI-2: before no es el valor anterior");
        assertEquals(changeHistory.value(${java(value2)}), last.changes().get(0).after(), "HI-2: after no es el valor nuevo");
    }`);

    if (shape.children.some((child) => child.list)) {
      const child = shape.children.find((candidate) => candidate.list);
      const childEntity = model.entities.find((candidate) => candidate.name === child.entity);
      imports.add(`${packages.types[child.entity]}.${child.entity}`);
      const newChild = () => `new ${child.entity}(${constructorArgs(model, childEntity, seed++, {}, use).join(', ')})`;
      const paths = (variable) => `Stream.of(${child.paths.map((path) => java(`.${path}`)).join(', ')}).map(path -> "${child.relation}[" + ${variable}.${getter(child.idField)} + "]" + path).toList()`;
      tests.push(`
    @Test
    void hi3_${name}_lasHijasViajanConSuRutaDelContrato() {
        ${child.entity} primera = ${newChild()};
${fresh('fila', { [child.relation]: 'List.of(primera)' })}
        List<String> created = entries(${type}, ${key('fila')}).get(0).changes().stream().map(FieldChange::field).toList();
        assertTrue(created.containsAll(${paths('primera')}), "HI-3: el alta no lleva las rutas de la hija: " + created);
        ${child.entity} segunda = ${newChild()};
        ${name} actual = ${port}.findById(${id('fila')}).orElseThrow();
        ${port}.save(${copy('actual', { [child.relation]: `Stream.concat(actual.${getter(child.relation)}.stream(), Stream.of(segunda)).toList()` })});
        HistoryEntry added = entries(${type}, ${key('fila')}).get(0);
        List<String> addedPaths = added.changes().stream().filter(change -> change.before().isNull()).map(FieldChange::field).toList();
        assertTrue(addedPaths.containsAll(${paths('segunda')}), "HI-3: la hija nueva no aparece con su ruta: " + addedPaths);
    }`);
    }

    const excluded = [
      entity.idField.name,
      ...entity.fields.filter((field) => field.sensitive || field.generated).map((field) => field.name),
      ...(entity.usesOptimisticLocking ? ['lockVersion'] : [])
    ];
    tests.push(`
    @Test
    void hi4_${name}_niSensitiveNiGeneratedEntranEnElHistorial() {
${fresh('fila')}
        List<String> recorded = entries(${type}, ${key('fila')}).get(0).changes().stream().map(FieldChange::field).toList();
        assertFalse(recorded.isEmpty(), "HI-4: el alta no registró nada; la sonda no mide");
        for (String forbidden : List.of(${[...new Set(excluded)].map(java).join(', ')})) {
            assertFalse(recorded.contains(forbidden), "HI-4: el historial guarda " + forbidden);
        }
    }`);

    tests.push(`
    @Test
    void hi5_${name}_elAutorEsElSujetoYFueraDeUnaPeticionElCentinela() {
        ${authenticate('sub-hi5')}
        ${name} conToken;
        try {
            conToken = ${port}.save(new ${name}(${constructorArgs(model, entity, seed++, {}, use).join(', ')}));
        } finally {
            SecurityContextHolder.clearContext();
        }
        assertEquals("sub-hi5", entries(${type}, ${key('conToken')}).get(0).author(), "HI-5: el autor no es el sujeto del token");
${fresh('sinToken')}
        String author = entries(${type}, ${key('sinToken')}).get(0).author();
        assertTrue(author.equals("system") || author.startsWith("system:"), "HI-5: fuera de una petición el autor no es el centinela: " + author);
    }`);

    tests.push(`
    @Test
    void hi6_${name}_laPaginaVaDelMasRecienteAlMasAntiguoYFiltra() {
        // Por el almacén: lo que se mide es su orden y sus filtros, no el diff del adaptador.
        String root = "hi6-" + UUID.randomUUID();
        Instant t0 = Instant.parse("2026-11-13T10:00:00Z");
        for (String path : List.of("a.x", "b", "c", "d")) {
            changeHistory.record(${type}, root, ChangeHistory.UPDATED, List.of(new FieldChange(path, NullNode.getInstance(), changeHistory.value(path))));
        }
        setAt("a.x", t0);
        setAt("b", t0.plus(Duration.ofMinutes(5)));
        setAt("c", t0.plus(Duration.ofMinutes(5)));
        setAt("d", t0.plus(Duration.ofMinutes(9)));
        assertEquals(List.of("d", "c", "b", "a.x"), firstFields(${type}, root, HistoryFilter.none(), 0, 10), "HI-6: el orden no es el más reciente primero con el id de desempate");
        assertEquals(List.of("b", "a.x"), firstFields(${type}, root, HistoryFilter.none(), 1, 2), "HI-6: la segunda página no sigue a la primera");
        assertEquals(4L, changeHistory.page(${type}, root, HistoryFilter.none(), PageRequest.of(0, 1)).getTotalElements(), "HI-6: el total");
        assertEquals(List.of("a.x"), firstFields(${type}, root, new HistoryFilter("a", null, null), 0, 10), "HI-6: el campo de la raíz no casa su ruta");
        assertEquals(List.of("a.x"), firstFields(${type}, root, new HistoryFilter("a.x", null, null), 0, 10), "HI-6: la ruta entera no casa");
        assertEquals(List.of(), firstFields(${type}, root, new HistoryFilter("x", null, null), 0, 10), "HI-6: un trozo que no es un campo casó");
        assertEquals(Set.of("b", "c", "d"), Set.copyOf(firstFields(${type}, root, new HistoryFilter(null, t0.plus(Duration.ofMinutes(5)), t0.plus(Duration.ofMinutes(9))), 0, 10)), "HI-6: from y to no incluyen sus extremos");
    }`);

    if (casesOf(model).includes('HI-7') && reads.length > 0) {
      imports.add('java.util.Optional');
      const read = reads.find((candidate) => candidate.scoped) ?? reads[0];
      const lines = [];
      if (read.scoped && scoped) {
        imports.add(`${packages.port}.ReadScope`);
        const path = readScopePath(model, scoped.read);
        const hop = path.hops[0] ?? null;
        const scopeOf = (value) => (scoped.read.kind === 'scoping' ? `ReadScope.within(Set.of(${value}))` : `ReadScope.ownedBy(${value})`);
        if (hop) {
          const target = hop.entity;
          const targetPort = `${decap(target.name)}Repository`;
          const owned = (at) => ({ [scoped.read.field]: java(`hi-own-${at}`) });
          const a = seed++;
          const b = seed++;
          lines.push(
            `        ${target.name} ownerA = ${targetPort}.save(new ${target.name}(${constructorArgs(model, target, a, owned(a), use).join(', ')}));`,
            `        ${target.name} ownerB = ${targetPort}.save(new ${target.name}(${constructorArgs(model, target, b, owned(b), use).join(', ')}));`,
            fresh('propia', { [`${hop.relation}Id`]: `ownerA.${getter(target.idField.name)}` }),
            fresh('ajena', { [`${hop.relation}Id`]: `ownerB.${getter(target.idField.name)}` }),
            `        ReadScope scope = ${scopeOf(`ownerA.${getter(scoped.read.field)}`)};`
          );
        } else {
          lines.push(fresh('propia'), fresh('ajena'), `        ReadScope scope = ${scopeOf(`propia.${getter(scoped.read.field)}`)};`);
        }
        const call = (row) => `${port}.${read.method}(${row}.${getter(read.param.name)}, scope, HistoryFilter.none(), PageRequest.of(0, 10))`;
        lines.push(
          `        assertTrue(${call('propia')}.isPresent(), "HI-7: el historial de una raíz propia no se ve");`,
          `        assertTrue(missed(() -> ${call('ajena')}), "HI-7: el historial de una raíz ajena se ve");`
        );
      }
      if (lifecycle?.logical) {
        const call = (row) => `${port}.${read.method}(${row}.${getter(read.param.name)}${read.scoped ? ', scope' : ''}, HistoryFilter.none(), PageRequest.of(0, 10))`;
        if (!read.scoped) lines.push(fresh('propia'));
        lines.push(
          fresh('borrada', lines.length > 0 && read.scoped && scoped && readScopePath(model, scoped.read).hops[0] ? { [`${readScopePath(model, scoped.read).hops[0].relation}Id`]: `ownerA.${getter(readScopePath(model, scoped.read).hops[0].entity.idField.name)}` } : {}),
          `        ${port}.deleteById(${id('borrada')});`,
          `        assertTrue(${call('propia')}.isPresent(), "HI-7: el historial de una raíz viva no se ve");`,
          `        assertTrue(missed(() -> ${call('borrada')}), "HI-7: el historial de una raíz borrada se ve");`
        );
      }
      tests.push(`
    @Test
    void hi7_${name}_elHistorialDeLoQueLaFichaNoVeNoSeVe() {
${lines.join('\n')}
    }`);
    }

    if (lifecycle?.restore) {
      tests.push(`
    @Test
    void hi10_${name}_restaurarDejaSuEntrada() {
${fresh('fila')}
        ${port}.deleteById(${id('fila')});
        ${port}.restore(${id('fila')}).orElseThrow();
        assertEquals(List.of("restored", "deleted", "created"), kinds(${type}, ${key('fila')}), "HI-10: restaurar no dejó la entrada restored");
    }`);
    }

    if (lifecycle?.retention?.fromDeleted) {
      const timerClass = retentionTimerClass(name);
      imports.add(`${packages.timer}.${timerClass}`);
      imports.add(`${packages.mirrors}.${mirror(name)}`);
      imports.add(`${packages.adapters}.${store(name)}`);
      fields.push(`    @Autowired\n    private ${timerClass} ${decap(timerClass)};`);
      const span = lifecycle.retention.span;
      if (!span.days) throw new Error('history-check: una retención que no es en días no tiene sujeto todavía');
      const expire = `${fresh('fila')}
${update('fila', edited(`hi-ret-${seed}`))}
        ${port}.deleteById(${id('fila')});
        ${mirror(name)} stale = ${raw}.findById(${id('fila')}).orElseThrow();
        stale.setDeletedAt(Instant.now().minus(Duration.ofDays(${span.days + 1})));
        ${raw}.save(stale);
        ${decap(timerClass)}.tick();`;
      if (lifecycle.retention.then === 'delete') {
        tests.push(`
    @Test
    void hi9_${name}_laPurgaDeLoBorradoSeLlevaElHistorial() {
${expire}
        assertFalse(${raw}.findById(${id('fila')}).isPresent(), "HI-9: la retención no purgó la fila; la sonda no mide");
        assertTrue(entries(${type}, ${key('fila')}).isEmpty(), "HI-9: el historial de la raíz purgada sigue ahí");
    }`);
      } else {
        const personal = shape.personal.map(({ path, required }) => `Map.entry(${java(path)}, ${required})`);
        tests.push(`
    @Test
    void hi8_${name}_anonimizarReescribeLoPersonalDelHistorial() {
${expire}
        List<HistoryEntry> all = entries(${type}, ${key('fila')});
        assertEquals("anonymized", all.get(0).change(), "HI-8: falta la entrada anonymized");
        Map<String, Boolean> personal = Map.ofEntries(${personal.join(', ')});
        JsonNode substitute = changeHistory.value("anon-" + ${key('fila')});
        int seen = 0;
        for (HistoryEntry entry : all) {
            for (FieldChange change : entry.changes()) {
                Boolean required = personal.get(change.field());
                if (required == null) {
                    continue;
                }
                seen++;
                JsonNode expected = required ? substitute : NullNode.getInstance();
                assertEquals(expected, change.before(), "HI-8: " + entry.change() + "." + change.field() + " conserva el before personal");
                assertEquals(expected, change.after(), "HI-8: " + entry.change() + "." + change.field() + " conserva el after personal");
            }
        }
        assertTrue(seen > 0, "HI-8: el historial no tenía ningún campo personal; la sonda no mide");
    }`);
      }
    }
  }

  return `package ${model.service.basePackage}.${PACKAGE_LEAF};

${[...imports].sort().map((entry) => `import ${entry};`).join('\n')}

/**
 * El historial de cambios (DSL 2.29) contra lo que emitió build y el motor real de infra/: HI-1 a HI-10 de keel-core. Lo
 * escribe scripts/history-check.js desde src/lib/history-probes.js: no es parte del proyecto.
 */
@SpringBootTest(properties = {
${['"scheduling.enabled=false"', ...properties].map((property) => `        ${property}`).join(',\n')}
})
@ActiveProfiles("local")
class ${CLASS_NAME} {

${fields.join('\n\n')}

    @BeforeEach
    void vacia() {
        SecurityContextHolder.clearContext();
${wipes.join('\n')}
    }

    private List<HistoryEntry> entries(String type, String root) {
        return changeHistory.page(type, root, HistoryFilter.none(), PageRequest.of(0, 100)).getContent();
    }

    private List<String> kinds(String type, String root) {
        return entries(type, root).stream().map(HistoryEntry::change).toList();
    }

    private List<String> firstFields(String type, String root, HistoryFilter filter, int page, int size) {
        return changeHistory.page(type, root, filter, PageRequest.of(page, size)).getContent().stream()
                .map(entry -> entry.changes().get(0).field())
                .toList();
    }

    /** No lo ve: vacío, o el error de su lectura (readMiss: forbidden). */
    private static boolean missed(Supplier<? extends java.util.Optional<?>> read) {
        try {
            return read.get().isEmpty();
        } catch (RuntimeException miss) {
            return true;
        }
    }

${ageEntry}
${tests.join('\n')}
}
`;
}
