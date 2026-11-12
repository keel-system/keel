// Las sondas del CICLO DE VIDA DEL DATO (DSL 2.28: `deletion: logical`, `restorableFor`/`restores`, `retention` y
// `personal`) para keel-spring: los casos LC-*, RT-* y PD-2 de keel-core/gen/data-lifecycle.js, con los mismos ids que
// ejecutarán keel-nest, keel-dotnet y keel-go sobre los MISMOS diseños (keel-core/test/helpers/data-lifecycle-designs.js).
// Una clase JUnit que scripts/lifecycle-check.js escribe dentro del proyecto generado (no forma parte de él), con el
// contexto entero del perfil `local` contra el motor real de infra/ y el cronómetro apagado: la retención se dispara
// llamando a su recurrente, que es lo que haría el cronómetro.
//
// Las etiquetas importan para el falsado: cada sabotaje tiene que caer en EXACTAMENTE sus casos. Por eso LC-10 no siembra
// ninguna fila borrada (mide que el alcance sobreviva al predicado de vida, no la vida, que es LC-1), LC-8 SUPONE que la
// clave de una borrada se puede reusar (si no, es LC-5 quien lo dice, y LC-8 se salta), RT-1 mira el lote y RT-4 lo que
// purga `from: deleted`.

import { lifecycleRoots, ANONYMOUS_PREFIX, DATA_LIFECYCLE_CASES } from '@keel-system/keel-core/gen/data-lifecycle';
import { findersOf } from '@keel-system/keel-core/gen';
import { listsUnscoped } from '@keel-system/keel-core/gen/features';
import { idBatchReason } from '@keel-system/keel-core/gen/ref-targets';
import { readScopePath, scopedRootsOf } from '@keel-system/keel-core/gen/read-scope';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { constructorArgs } from './finder-probes.js';
import { naturalKeyFinder, uniqueFieldFinders } from '../scaffold/repositories.js';
import { deletedFinder, retentionClass, retentionTimerClass } from '../scaffold/data-lifecycle.js';
import { retentionCaches } from '@keel-system/keel-core/gen/cache-plan';

const retentionCachesOf = (model, entity) => retentionCaches(model, entity.name).length > 0;

export const PACKAGE_LEAF = 'lifecyclecheck';
export const CLASS_NAME = 'DataLifecycleCheckTest';

const java = (text) => JSON.stringify(text);
const capital = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const decap = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;
const getter = (name) => `get${capital(name)}()`;

/** Lo que las sondas necesitan de cada raíz con ciclo de vida. */
export function probedRoots(model) {
  return lifecycleRoots(model).map((root) => {
    const entity = model.entities.find((candidate) => candidate.name === root.entity);
    const keyFinder = naturalKeyFinder(model, entity);
    const keyFinders = [keyFinder, ...uniqueFieldFinders(model, entity)].filter(Boolean);
    const paginated = model.services.some((group) => group.entity === entity.name && group.operations.some((op) => op.paginated));
    const finders = findersOf(model, entity.name).filter((finder) => finder.live);
    const scoped = scopedRootsOf(model).find((candidate) => candidate.entity?.name === entity.name) ?? null;
    return {
      root,
      entity,
      keyFinder,
      keyFinders,
      listed: root.logical && listsUnscoped(model, entity) && paginated,
      finders,
      batch: root.logical && Boolean(idBatchReason(model, entity)),
      scoped,
      deleted: root.restore ? deletedFinder(entity, keyFinder) : null
    };
  });
}

/** Los campos personales que llevan una unicidad propia, por raíz: el sujeto de PD-2. */
function personalUniques(model, entity) {
  return uniqueFieldFinders(model, entity).filter((finder) => entity.fields.find((field) => field.name === finder.field)?.personal);
}

/** Los casos que ejecuta la sonda de este diseño: con ellos se calcula qué tiene que caer con cada sabotaje. */
export function casesOf(model) {
  const cases = new Set();
  for (const probe of probedRoots(model)) {
    const { root, keyFinders, listed, finders, batch, scoped } = probe;
    if (root.logical) {
      cases.add('LC-3');
      if (keyFinders.length > 0) cases.add('LC-4').add('LC-5');
      if (listed || finders.length > 0) cases.add('LC-1');
      if (listed || finders.some((finder) => finder.result === 'page')) cases.add('LC-2');
      if (root.restore) {
        cases.add('LC-6');
        if (Number.isInteger(root.restore.days)) cases.add('LC-7');
        if (keyFinders.length > 0) cases.add('LC-8');
      }
      if (batch) cases.add('LC-9');
      if (scoped && finders.some((finder) => finder.scope)) cases.add('LC-10');
    }
    if (root.retention) {
      cases.add('RT-1').add('RT-3');
      if (root.retention.then === 'anonymize') cases.add('RT-2');
      if (root.retention.fromDeleted) cases.add('RT-4');
    }
    if (personalUniques(model, probe.entity).length > 0) cases.add('PD-2');
  }
  const order = DATA_LIFECYCLE_CASES.map((entry) => entry.id);
  return [...cases].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** Los tipos cuyo paquete hay que leer del proyecto generado. */
export function namedTypes(model) {
  const names = new Set();
  const visit = (field) => {
    if (field.kind === 'enum' || field.kind === 'composite') names.add(field.namedType);
    if (field.kind === 'composite') model.valueObjects.find((candidate) => candidate.name === field.namedType)?.fields.forEach(visit);
  };
  for (const { entity, scoped } of probedRoots(model)) {
    for (const subject of [entity, scoped ? readScopePath(model, scoped.read).hops[0]?.entity : null].filter(Boolean)) {
      names.add(subject.name);
      subject.fields.forEach(visit);
    }
  }
  return [...names];
}

/** Las raíces que la sonda vacía antes de cada caso: las del ciclo de vida y las del otro lado de un camino acotado. */
export function wipedEntities(model) {
  const names = new Set();
  for (const { entity, scoped } of probedRoots(model)) {
    names.add(entity.name);
    const target = scoped ? readScopePath(model, scoped.read).hops[0]?.entity : null;
    if (target) names.add(target.name);
  }
  return [...names];
}

/** La clase de prueba. `packages`: port, adapters (repositorios del almacén), mirrors, errors, retention, timer, types. */
export function lifecycleTestClass(model, { packages, document, properties = [], doubles = [] }) {
  const imports = new Set([
    'java.math.BigDecimal',
    'java.time.Duration',
    'java.time.Instant',
    'java.time.LocalDate',
    'java.time.ZoneOffset',
    'java.util.List',
    'java.util.Optional',
    'java.util.Set',
    'java.util.UUID',
    'org.junit.jupiter.api.Assumptions',
    'org.junit.jupiter.api.BeforeEach',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.test.context.SpringBootTest',
    'org.springframework.data.domain.PageRequest',
    'org.springframework.test.context.ActiveProfiles',
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertFalse',
    'static org.junit.jupiter.api.Assertions.assertNull',
    'static org.junit.jupiter.api.Assertions.assertThrows',
    'static org.junit.jupiter.api.Assertions.assertTrue'
  ]);
  const use = { enum: (name) => imports.add(`${packages.types[name]}.${name}`), type: (name) => imports.add(`${packages.types[name]}.${name}`) };
  const store = (name) => (document ? `${name}MongoRepository` : `${name}JpaRepository`);
  const mirror = (name) => (document ? `${name}Document` : `${name}Jpa`);
  const fields = [];
  const wipes = [];
  for (const name of wipedEntities(model)) {
    imports.add(`${packages.types[name]}.${name}`);
    imports.add(`${packages.port}.${name}Repository`);
    imports.add(`${packages.adapters}.${store(name)}`);
    imports.add(`${packages.mirrors}.${mirror(name)}`);
    fields.push(`    @Autowired\n    private ${name}Repository ${decap(name)}Repository;`, `    @Autowired\n    private ${store(name)} ${decap(store(name))};`);
    wipes.push(`        ${decap(store(name))}.deleteAll();`);
  }
  // Los puertos que escribe el agente, como dobles: sin ellos el contexto no arranca, y nada de lo medido pasa por ellos.
  if (doubles.length > 0) imports.add('org.springframework.test.context.bean.override.mockito.MockitoBean');
  for (const port of doubles) {
    imports.add(port.fqn);
    fields.push(`    @MockitoBean
    private ${port.type} ${decap(port.type)};`);
  }
  const tests = [];
  let seed = 801;
  for (const probe of probedRoots(model)) {
    const { root, entity, keyFinders, listed, finders, batch, scoped } = probe;
    const name = entity.name;
    const port = `${decap(name)}Repository`;
    const raw = decap(store(name));
    const id = (row) => `${row}.${getter(entity.idField.name)}`;
    const fresh = (variable, forced = {}) =>
      `        ${name} ${variable} = ${port}.save(new ${name}(${constructorArgs(model, entity, seed++, forced, use).join(', ')}));`;
    // Las claves únicas de una fila: lo que hay que copiar para que otra ocupe su sitio.
    const keyParams = [...new Map(keyFinders.flatMap((finder) => finder.params).map((param) => [param.name, param])).values()];
    const sameKeys = (row) => Object.fromEntries(keyParams.map((param) => [param.name, `${row}.${getter(param.name)}`]));
    const backdateDeleted = (row, days) =>
      `        ${mirror(name)} stale = ${raw}.findById(${id(row)}).orElseThrow();
        stale.setDeletedAt(Instant.now().minus(Duration.ofDays(${days})));
        ${raw}.save(stale);`;
    if (root.logical) {
      tests.push(`
    @Test
    void lc3_${name}_laCargaPorIdNoVeLaBorrada() {
${fresh('borrada')}
${fresh('viva')}
        ${port}.deleteById(${id('borrada')});
        assertTrue(${port}.findById(${id('borrada')}).isEmpty(), "LC-3: la carga por id ve una fila borrada");
        assertTrue(${port}.findById(${id('viva')}).isPresent(), "LC-3: la carga por id no ve una fila viva");
        // D5: borrarla otra vez no hace nada, y sigue sin verse.
        ${port}.deleteById(${id('borrada')});
        assertTrue(${port}.findById(${id('borrada')}).isEmpty(), "LC-3: borrar dos veces la devolvió");
    }`);
      for (const finder of keyFinders) {
        const args = finder.params.map((param) => `borrada.${getter(param.name)}`).join(', ');
        tests.push(`
    @Test
    void lc4_${name}_${finder.name}_noVeLaBorrada() {
${fresh('borrada')}
        ${port}.deleteById(${id('borrada')});
        assertTrue(${port}.${finder.name}(${args}).isEmpty(), "LC-4: ${finder.name} ve una fila borrada");
    }`);
      }
      if (keyFinders.length > 0) {
        tests.push(`
    @Test
    void lc5_${name}_laClaveDeUnaBorradaSeReusa() {
${fresh('borrada')}
        ${port}.deleteById(${id('borrada')});
${fresh('nueva', sameKeys('borrada'))}
        assertTrue(${port}.findById(${id('nueva')}).isPresent(), "LC-5: la fila que reusa la clave no está");
        assertFalse(${id('nueva')}.equals(${id('borrada')}), "LC-5: la nueva es la misma fila");
    }`);
      }
      const listings = [];
      if (listed) listings.push({ call: (size) => `${port}.list(PageRequest.of(0, ${size}))`, page: true, label: 'list' });
      for (const finder of finders) {
        const filter = finder.criteria.length > 0 ? `new ${name}Repository.${finder.filterType}(${finder.criteria.map(() => 'null').join(', ')})` : null;
        if (finder.scope) imports.add(`${packages.port}.ReadScope`);
        listings.push({
          call: (size) => `${port}.${finder.method}(${[filter, finder.result === 'page' ? `PageRequest.of(0, ${size})` : null, finder.scope ? 'ReadScope.unrestricted()' : null].filter(Boolean).join(', ')})`,
          page: finder.result === 'page',
          label: finder.method
        });
      }
      for (const listing of listings) {
        const rows = (size) => `${listing.call(size)}${listing.page ? '.getContent()' : ''}.stream().map(row -> row.${getter(entity.idField.name)}).toList()`;
        tests.push(`
    @Test
    void lc1_${name}_${listing.label}_noDevuelveLasBorradas() {
${fresh('borrada')}
${fresh('viva')}
        ${port}.deleteById(${id('borrada')});
        List<?> seen = ${rows(100)};
        assertTrue(seen.contains(${id('viva')}), "LC-1: el listado no ve la fila viva: " + seen);
        assertFalse(seen.contains(${id('borrada')}), "LC-1: el listado devuelve una fila borrada");
    }`);
        if (listing.page) {
          tests.push(`
    @Test
    void lc2_${name}_${listing.label}_elTotalNoCuentaLasBorradas() {
${fresh('borrada')}
${fresh('viva1')}
${fresh('viva2')}
        ${port}.deleteById(${id('borrada')});
        var page = ${listing.call(1)};
        assertEquals(2L, page.getTotalElements(), "LC-2: el total cuenta las filas borradas");
        assertEquals(2, page.getTotalPages(), "LC-2: las páginas cuentan las filas borradas");
    }`);
        }
      }
      if (root.restore) {
        tests.push(`
    @Test
    void lc6_${name}_restaurarDentroDeLaVentanaLaDejaViva() {
${fresh('borrada')}
        ${port}.deleteById(${id('borrada')});
        assertTrue(${port}.restore(${id('borrada')}).isPresent(), "LC-6: restore no devolvió la fila");
        assertTrue(${port}.findById(${id('borrada')}).isPresent(), "LC-6: tras restaurar no se ve");
        assertTrue(${port}.restore(${id('borrada')}).isEmpty(), "LC-6: restaurar una viva no da vacío");${probe.deleted
          ? `
        ${port}.deleteById(${id('borrada')});
        assertEquals(${id('borrada')}, ${port}.${probe.deleted.name}(${probe.keyFinder.params.map((param) => `borrada.${getter(param.name)}`).join(', ')}).orElseThrow().${getter(entity.idField.name)}, "LC-6: ${probe.deleted.name} no encuentra la borrada");`
          : ''}
    }`);
        if (Number.isInteger(root.restore.days)) {
          const error = operationError(model, root.restore.operation, root.restore.error);
          imports.add(`${packages.errors}.${error.exceptionClass}`);
          tests.push(`
    @Test
    void lc7_${name}_restaurarFueraDeLaVentanaEsElErrorDeclarado() {
${fresh('borrada')}
        ${port}.deleteById(${id('borrada')});
${backdateDeleted('borrada', root.restore.days + 1)}
        assertThrows(${error.exceptionClass}.class, () -> ${port}.restore(${id('borrada')}), "LC-7: fuera de la ventana no da ${root.restore.error}");
        // Por el almacén y no por la carga del puerto, que es LC-3: el intento no le quitó la marca.
        assertTrue(${raw}.findById(${id('borrada')}).orElseThrow().getDeletedAt() != null, "LC-7: el intento la dejó viva");
    }`);
        }
        if (keyFinders.length > 0) {
          imports.add('org.springframework.dao.DataAccessException');
          imports.add('org.springframework.core.NestedExceptionUtils');
          tests.push(`
    @Test
    void lc8_${name}_restaurarConLaClaveOcupadaEsLaUnicidad() {
${fresh('borrada')}
        ${port}.deleteById(${id('borrada')});
        // Supone LC-5: si la clave de la borrada no se puede reusar, lo dice LC-5 y este caso no tiene qué medir.
        try {
            ${port}.save(new ${name}(${constructorArgs(model, entity, seed++, sameKeys('borrada'), use).join(', ')}));
        } catch (DataAccessException reuseFailed) {
            Assumptions.abort("la clave de una borrada no se reusa (LC-5)");
        }
        DataAccessException clash = assertThrows(DataAccessException.class, () -> ${port}.restore(${id('borrada')}), "LC-8: restaurar con la clave ocupada no choca con la unicidad");
        String detail = String.valueOf(NestedExceptionUtils.getMostSpecificCause(clash).getMessage());
        assertTrue(detail.contains("uk_"), "LC-8: el choque no nombra la constraint que traduce el ApiExceptionHandler: " + detail);
    }`);
        }
      }
      if (batch) {
        imports.add('java.util.List');
        tests.push(`
    @Test
    void lc9_${name}_laLecturaPorReferenciaVeLaBorrada() {
${fresh('borrada')}
        ${port}.deleteById(${id('borrada')});
        List<?> seen = ${port}.findAllById(List.of(${id('borrada')})).stream().map(row -> row.${getter(entity.idField.name)}).toList();
        assertTrue(seen.contains(${id('borrada')}), "LC-9: findAllById no ve la raíz borrada (D3)");
    }`);
      }
      const scopedFinder = scoped ? finders.find((finder) => finder.scope) : null;
      if (scopedFinder) {
        const path = readScopePath(model, scoped.read);
        const hop = path.hops[0] ?? null;
        const scopeOf = (value) => (scoped.read.kind === 'scoping' ? `ReadScope.within(Set.of(${value}))` : `ReadScope.ownedBy(${value})`);
        const lines = [];
        if (hop) {
          const target = hop.entity;
          const targetPort = `${decap(target.name)}Repository`;
          const owned = (at) => ({ [scoped.read.field]: java(`lc-own-${at}`) });
          const a = seed++;
          const b = seed++;
          lines.push(
            `        ${target.name} ownerA = ${targetPort}.save(new ${target.name}(${constructorArgs(model, target, a, owned(a), use).join(', ')}));`,
            `        ${target.name} ownerB = ${targetPort}.save(new ${target.name}(${constructorArgs(model, target, b, owned(b), use).join(', ')}));`,
            `        String valueA = ownerA.${getter(scoped.read.field)};`,
            fresh('a1', { [`${hop.relation}Id`]: `ownerA.${getter(target.idField.name)}` }),
            fresh('b1', { [`${hop.relation}Id`]: `ownerB.${getter(target.idField.name)}` })
          );
        } else {
          lines.push(fresh('a1'), `        String valueA = a1.${getter(scoped.read.field)};`, fresh('b1'));
        }
        const filter = scopedFinder.criteria.length > 0 ? `new ${name}Repository.${scopedFinder.filterType}(${scopedFinder.criteria.map(() => 'null').join(', ')})` : null;
        const call = `${port}.${scopedFinder.method}(${[filter, scopedFinder.result === 'page' ? 'PageRequest.of(0, 100)' : null, scopeOf('valueA')].filter(Boolean).join(', ')})`;
        tests.push(`
    @Test
    void lc10_${name}_${scopedFinder.method}_laVidaSeSumaAlAlcance() {
        // Sin ninguna fila borrada: lo que se mide es que el alcance sobreviva al predicado de vida, no la vida (LC-1).
${lines.join('\n')}
        List<?> seen = ${call}${scopedFinder.result === 'page' ? '.getContent()' : ''}.stream().map(row -> row.${getter(entity.idField.name)}).toList();
        assertTrue(seen.contains(${id('a1')}), "LC-10: el listado acotado no ve la fila propia: " + seen);
        assertFalse(seen.contains(${id('b1')}), "LC-10: el predicado de vida se comió el alcance: ve una fila ajena");
    }`);
      }
    }
    if (root.retention) {
      const retention = root.retention;
      const timerClass = retentionTimerClass(name);
      imports.add(`${packages.timer}.${timerClass}`);
      fields.push(`    @Autowired\n    private ${timerClass} ${decap(timerClass)};`);
      const span = retention.span;
      const ago = (extraDays) =>
        span.days
          ? `Instant.now().minus(Duration.ofDays(${span.days + extraDays}))`
          : `Instant.now().atZone(ZoneOffset.UTC).minusYears(${span.years}).minusDays(${extraDays}).toInstant()`;
      if (span.parameter) throw new Error('lifecycle-check: una retención por parámetro no tiene sujeto todavía');
      const tick = `        ${decap(timerClass)}.tick();`;
      const present = (row) => `${raw}.findById(${id(row)}).isPresent()`;
      const anonymized = (row) => `${raw}.findById(${id(row)}).orElseThrow().getAnonymizedAt() != null`;
      if (retention.fromDeleted) {
        tests.push(`
    @Test
    void rt1_${name}_soloVenceLoBorradoHaceMasDeLaRetencion() {
${fresh('viva')}
${fresh('reciente')}
        ${port}.deleteById(${id('reciente')});
${backdateDeleted('reciente', span.days - 1).replaceAll('stale', 'reciente_')}
${tick}
        assertTrue(${present('viva')}, "RT-1: una fila viva (sin deletedAt) venció");
        assertTrue(${present('reciente')}, "RT-1: una borrada dentro de la retención venció");
    }

    @Test
    void rt4_${name}_purgaLoBorradoPasadaLaRetencion() {
${fresh('vieja')}
        ${port}.deleteById(${id('vieja')});
${backdateDeleted('vieja', span.days + 1)}
${tick}
        assertFalse(${present('vieja')}, "RT-4: lo borrado hace más de la retención sigue en el almacén");
    }`);
      } else {
        const outcome = retention.then === 'delete'
          ? { due: (row) => `!${present(row)}`, kept: (row) => `${present(row)} && ${raw}.findById(${id(row)}).orElseThrow()${retention.then === 'anonymize' ? '' : ''} != null` }
          : { due: anonymized, kept: (row) => `${raw}.findById(${id(row)}).orElseThrow().getAnonymizedAt() == null` };
        tests.push(`
    @Test
    void rt1_${name}_soloVenceLoQueLlevaMasDeLaRetencion() {
${fresh('vencida', { [retention.from]: ago(1) })}
${fresh('reciente', { [retention.from]: ago(-1) })}
${tick}
        assertTrue(${outcome.due('vencida')}, "RT-1: lo vencido no se ${retention.then === 'delete' ? 'borró' : 'anonimizó'}");
        assertTrue(${outcome.kept('reciente')}, "RT-1: algo dentro de la retención se ${retention.then === 'delete' ? 'borró' : 'anonimizó'}");
    }`);
        if (retention.then === 'anonymize') {
          const rootPersonal = retention.anonymize.find((member) => member.entity === name)?.fields ?? [];
          const checks = rootPersonal.map((field) =>
            field.required
              ? `        assertEquals(${java(ANONYMOUS_PREFIX)} + ${id('vencida')}, after.${getter(field.name)}, "RT-2: ${field.name} no lleva el sustituto");
        assertEquals(${java(ANONYMOUS_PREFIX)} + ${id('otra')}, other.${getter(field.name)}, "RT-2: ${field.name} de la otra no lleva su sustituto");`
              : `        assertNull(after.${getter(field.name)}, "RT-2: ${field.name} no quedó vacío");`
          );
          tests.push(`
    @Test
    void rt2_${name}_anonimizaLoPersonalYLaUnicidadSobrevive() {
${fresh('vencida', { [retention.from]: ago(1) })}
${fresh('otra', { [retention.from]: ago(2) })}
${tick}
        ${name} after = ${port}.findById(${id('vencida')}).orElseThrow();
        ${name} other = ${port}.findById(${id('otra')}).orElseThrow();
${checks.join('\n')}
    }`);
        }
      }
    }
    // PD-2: violar una unicidad sobre un campo personal no deja el valor en ningún log generado: ni la copia de Hibernate
    // ni el aspecto @LogExceptions, que es por donde sale la excepción de un handler.
    const personal = personalUniques(model, entity);
    if (personal.length > 0) {
      const finder = personal[0];
      imports.add('org.springframework.boot.test.system.CapturedOutput');
      imports.add('org.springframework.boot.test.system.OutputCaptureExtension');
      imports.add('org.junit.jupiter.api.extension.ExtendWith');
      imports.add('org.springframework.dao.DataAccessException');
      imports.add(`${packages.annotations}.LogExceptions`);
      imports.add(`${packages.logging}.LogExceptionsAspect`);
      imports.add('org.aspectj.lang.ProceedingJoinPoint');
      imports.add('org.aspectj.lang.Signature');
      imports.add('java.lang.reflect.Proxy');
      const value = java(`pd2-${seed}@valor.personal`);
      tests.push(`
    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void pd2_${name}_${finder.field}_laUnicidadVioladaNoDejaElValorEnElLog(CapturedOutput output) throws Exception {
${fresh('primera', { [finder.field]: value })}
        DataAccessException clash = assertThrows(DataAccessException.class,
                () -> ${port}.save(new ${name}(${constructorArgs(model, entity, seed++, { [finder.field]: value }, use).join(', ')})),
                "PD-2: la unicidad de ${finder.field} no saltó");
        // La misma excepción por el aspecto de los handlers, que es por donde sale en una petición.
        Signature signature = (Signature) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] { Signature.class },
                (proxy, method, args) -> method.getName().equals("toShortString") ? "Sonda.handle(..)" : null);
        ProceedingJoinPoint joinPoint = (ProceedingJoinPoint) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] { ProceedingJoinPoint.class },
                (proxy, method, args) -> {
                    if (method.getName().equals("proceed")) {
                        throw clash;
                    }
                    return method.getName().equals("getSignature") ? signature : null;
                });
        LogExceptions annotation = Sonda.class.getDeclaredMethod("handle").getAnnotation(LogExceptions.class);
        assertThrows(DataAccessException.class, () -> new LogExceptionsAspect().logExceptions(joinPoint, annotation));
        assertTrue(output.getAll().contains("Sonda.handle"), "PD-2: el aspecto no escribió nada; la sonda no mide");
        assertFalse(output.getAll().contains(${value}), "PD-2: un log generado lleva el valor personal de ${finder.field}");
    }

    static class Sonda {
        @LogExceptions
        void handle() {
        }
    }`);
    }
  }

  return `package ${model.service.basePackage}.${PACKAGE_LEAF};

${[...imports].sort().map((entry) => `import ${entry};`).join('\n')}

/**
 * El ciclo de vida del dato (DSL 2.28) contra lo que emitió build y el motor real de infra/: LC-*, RT-* y PD-2 de
 * keel-core. Lo escribe scripts/lifecycle-check.js desde src/lib/lifecycle-probes.js: no es parte del proyecto.
 */
@SpringBootTest(properties = {
${['"scheduling.enabled=false"', ...properties].map((property) => `        ${property}`).join(',\n')}
})
@ActiveProfiles("local")
class ${CLASS_NAME} {

${fields.join('\n\n')}

    @BeforeEach
    void vacia() {
${wipes.join('\n')}
    }
${tests.join('\n')}
}
`;
}

/** Las clases que la sonda nombra y cuyo paquete hay que buscar en el proyecto (las de la retención incluidas). */
export function retentionClasses(model) {
  return probedRoots(model).filter(({ root }) => root.retention).flatMap(({ entity }) => [retentionClass(entity.name), retentionTimerClass(entity.name)]);
}

// ─── RT-3: dos réplicas, un barrido ──────────────────────────────────────────────────────────────────────────────

export const REPLICA_CLASS = 'RetentionReplicaCheckTest';

/** ¿Mide este diseño RT-3? Con alguna retención: es un recurrente del cronómetro en modo clúster. */
export const usesRetentionReplica = (model) => probedRoots(model).some(({ root }) => root.retention);

/**
 * RT-3 en el paquete del cronómetro (el constructor de pruebas del `TimerPoller` y su `pollOnce` son package-private),
 * con la forma de la sonda de las purgas (purge-timer-probes.js): dos réplicas con SUS instancias del
 * `<Raíz>RetentionTimer` sobre un doble COMPARTIDO de `<Raíz>Retention`; contar sus `due` es contar quién barrió.
 */
export function retentionReplicaTestClass(model, { packages, document, properties = [], fire, doubles = [] }) {
  const roots = probedRoots(model).filter(({ root }) => root.retention).map(({ entity }) => entity);
  const imports = new Set([
    'java.util.ArrayList',
    'java.util.List',
    'org.junit.jupiter.api.BeforeEach',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.test.context.SpringBootTest',
    'org.springframework.test.context.ActiveProfiles',
    'org.springframework.test.util.ReflectionTestUtils',
    'org.springframework.transaction.PlatformTransactionManager',
    'static org.mockito.ArgumentMatchers.any',
    'static org.mockito.ArgumentMatchers.anyInt',
    'static org.mockito.Mockito.mock',
    'static org.mockito.Mockito.times',
    'static org.mockito.Mockito.verify'
  ]);
  const clear = document ? 'mongo.remove(new Query(), "keel_timer");' : 'jdbc().sql("DELETE FROM keel_timer").update();';
  if (doubles.length > 0) imports.add('org.springframework.test.context.bean.override.mockito.MockitoBean');
  for (const port of doubles) imports.add(port.fqn);
  const doubleFields = doubles.map((port) => `    @MockitoBean\n    private ${port.type} ${decap(port.type)};`).join('\n\n');
  if (document) {
    for (const name of ['java.util.Date', 'org.springframework.data.mongodb.core.MongoTemplate', 'org.springframework.data.mongodb.core.query.Criteria', 'org.springframework.data.mongodb.core.query.Query', 'org.springframework.data.mongodb.core.query.Update']) imports.add(name);
  } else {
    for (const name of ['javax.sql.DataSource', 'org.springframework.jdbc.core.simple.JdbcClient']) imports.add(name);
  }
  const support = document
    ? `    @Autowired
    private MongoTemplate mongo;`
    : `    @Autowired
    private DataSource dataSource;

    private JdbcClient jdbc() {
        return JdbcClient.create(dataSource);
    }`;
  const fireLine = document
    ? 'mongo.updateMulti(Query.query(Criteria.where("kind").is(kind)), new Update().set("due_at", Date.from(store.dbNow())), "keel_timer");'
    : `jdbc().sql(${java(fire)}).param("kind", kind).update();`;
  const tests = roots.map((entity) => {
    const retention = retentionClass(entity.name);
    const timer = retentionTimerClass(entity.name);
    imports.add(`${packages.retention}.${retention}`);
    const extras = [];
    const lifecycle = lifecycleRoots(model).find((root) => root.entity === entity.name);
    if (lifecycle.retention.span.parameter) extras.push(`mock(${model.service.className}Parameters.class)`);
    return `
    /** RT-3: con dos réplicas sondeando, cada tick de la retención de ${entity.name} lo barre exactamente una. */
    @Test
    void rt3_${entity.name}_cadaTickLoBarreUnaSolaReplica() {
        ${retention} compartida = mock(${retention}.class);
        TimerPoller a = replica(new ${timer}(compartida${extras.map((extra) => `, ${extra}`).join('')}${retentionCachesOf(model, entity) ? ', mock(OperationCache.class)' : ''}));
        TimerPoller b = replica(new ${timer}(compartida${extras.map((extra) => `, ${extra}`).join('')}${retentionCachesOf(model, entity) ? ', mock(OperationCache.class)' : ''}));
        a.ensureRecurring();
        b.ensureRecurring();
        vencer(TimerKinds.${retentionKindConstantOf(entity.name)});
        a.pollOnce();
        b.pollOnce();
        verify(compartida, times(1).description("RT-3: la retención de ${entity.name} se barrió en más de una réplica, o en ninguna")).due(any(), anyInt());
    }`;
  });
  if (roots.some((entity) => retentionCachesOf(model, entity))) imports.add(`${packages.operationCache}.OperationCache`);
  return `package ${packages.timer};

${[...imports].sort((a, b) => (a.startsWith('static ') ? 1 : 0) - (b.startsWith('static ') ? 1 : 0) || a.localeCompare(b)).map((entry) => `import ${entry};`).join('\n')}

/**
 * RT-3 (DSL 2.28): la retención es un recurrente del cronómetro en modo clúster, y cada tick lo barre UNA réplica. Lo
 * escribe scripts/lifecycle-check.js desde src/lib/lifecycle-probes.js: no es parte del proyecto.
 */
@SpringBootTest(properties = {
${['"scheduling.enabled=false"', ...properties].map((property) => `        ${property}`).join(',\n')}
})
@ActiveProfiles("local")
class ${REPLICA_CLASS} {

    @Autowired
    private TimerStore store;

    @Autowired
    private PlatformTransactionManager transactionManager;

${support}
${doubleFields ? `\n${doubleFields}\n` : ''}
    @BeforeEach
    void limpia() {
        ${clear}
    }

    /** Una réplica: un sondeador con SU instancia del recurrente, como un proceso aparte. */
    private TimerPoller replica(RecurringTimerHandler recurrente) {
        ReflectionTestUtils.setField(recurrente, "cron", "0 30 2 * * *");
        ReflectionTestUtils.setField(recurrente, "batchSize", 10);
        List<RecurringTimerHandler> recurrentes = new ArrayList<>(List.of(recurrente));
        TimerPoller poller = new TimerPoller(store, List.of(), recurrentes, transactionManager);
        ReflectionTestUtils.setField(poller, "maxSleepMs", 30_000L);
        ReflectionTestUtils.setField(poller, "batchSize", 50);
        ReflectionTestUtils.setField(poller, "leaseMs", 60_000L);
        ReflectionTestUtils.setField(poller, "maxAttempts", 10);
        ReflectionTestUtils.setField(poller, "retryDelayMs", 0L);
        return poller;
    }

    /** El recurrente vence ya, con la hora de la base: la misma sentencia que el arnés. */
    private void vencer(String kind) {
        ${fireLine}
    }
${tests.join('\n')}
}
`;
}

const retentionKindConstantOf = (name) => `RETENTION_${name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
