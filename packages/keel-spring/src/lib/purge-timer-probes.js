// La sonda de las PURGAS EN MODO CLÚSTER (DSL 2.26, PLAN-DSL-226-PLAZOS.md, incremento 7): el JUnit que
// `scripts/store-check.js` escribe DENTRO del proyecto generado y ejecuta contra el motor que levanta su `infra/`.
//
// Hasta el incremento 7, cada purga de una tabla del generador era un `@Scheduled` que corría en TODAS las réplicas a la
// vez. Ahora es un recurrente del cronómetro (`<Tabla>PurgeTimer`), y la promesa es una sola: cada tick lo ejecuta UNA
// réplica, la que gana su fila en `keel_timer`. Lo que hace la purga no cambió y ya lo miden los casos de purga de las
// otras clases de store-check; aquí se mide quién la dispara.
//
// Dos réplicas son dos sondeadores con SUS PROPIAS instancias de cada recurrente, como dos procesos, sobre la misma base.
// El bean que purga se sustituye por un doble de Mockito COMPARTIDO por las dos: contar sus llamadas es contar cuántas
// réplicas ejecutaron el tick. Lo que se ejecuta de verdad es lo de build: el `<Tabla>PurgeTimer` (su kind, su cron), el
// `TimerPoller` (asegurar, reclamar, rearmar) y el almacén con las sentencias de keel-core.
//
// Los casos llevan el id de su decisión del plan (R1, RC-1, R2). El sabotaje `timer-every-replica` de store-check hace
// que el kind de cada purga sea distinto por instancia —cada réplica arbitra con su propia fila, que es «correr en todas»
// con otra forma— y tiene que tumbar exactamente `r1_` y `rc1_`.

import { timerPurges, usesTimer } from '@keel-system/keel-core/gen/timer-plan';
import { timerStatements } from '@keel-system/keel-core/gen/timer-store';
import { purgeTimerClass } from '../scaffold/timer.js';
import { conexionPerezosa } from './claim-probes.js';

export const CLASS_PURGE_TIMER = 'PurgeTimerStoreCheckTest';

/** Los casos que el sabotaje `timer-every-replica` tiene que tumbar, y solo ellos. */
export const EVERY_REPLICA_CASES = Object.freeze(['r1_unaFilaPorPurgaAunqueLaAsegurenDosReplicas', 'rc1_cadaTickLoEjecutaUnaSolaReplica']);

/** ¿Hay purgas sobre el cronómetro que medir en este diseño? */
export function usesPurgeTimers(model) {
  return usesTimer(model) && timerPurges(model).length > 0;
}

/** El bean que hace la purga de cada tabla: el archivo que el runner busca para leer su paquete. */
export function purgeTargetFiles(model) {
  const document = model.persistenceKind === 'document';
  const files = {
    outbox_event: 'OutboxRelay.java',
    processed_event: 'IdempotencyGuard.java',
    idempotency_record: document ? 'MongoIdempotencyStore.java' : 'JpaIdempotencyStore.java',
    reconciliation_claim: 'ReconciliationClaimPurge.java'
  };
  return Object.fromEntries(timerPurges(model).map((purge) => [purge.table, files[purge.table]]));
}

const javaString = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const targetClass = (file) => file.replace(/\.java$/, '');

/**
 * La clase, en el paquete del cronómetro: el constructor de pruebas del `TimerPoller` y su `pollOnce` son
 * package-private. `packages.targets` lleva el paquete de cada bean que purga, leído del árbol generado.
 */
export function purgeTimerTestClass(model, { datasource, packages }) {
  const document = model.persistenceKind === 'document';
  const purges = timerPurges(model);
  const targets = purgeTargetFiles(model);
  const entries = purges.map((purge, index) => ({
    ...purge,
    timerClass: purgeTimerClass(purge.table),
    target: targetClass(targets[purge.table]),
    mock: `objetivo${index}`
  }));

  const support = document
    ? {
        annotations: `@DataMongoTest(properties = {
        "spring.mongodb.uri=${datasource.uri}",
        "spring.profiles.active="
})
@ImportAutoConfiguration(exclude = EmbeddedMongoAutoConfiguration.class)
@Import({MongoTimerStore.class, MongoTransactionConfig.class})`,
        fields: `    @Autowired
    private MongoTemplate mongo;`,
        clear: 'mongo.remove(new Query(), "keel_timer");',
        count: 'return mongo.count(Query.query(Criteria.where("kind").regex("^" + Pattern.quote(prefijo))), "keel_timer");',
        fire: 'mongo.updateMulti(Query.query(Criteria.where("kind").is(kind)), new Update().set("due_at", Date.from(store.dbNow())), "keel_timer");',
        imports: [
          `${packages.mongoTx}.MongoTransactionConfig`,
          'de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration',
          'java.util.Date',
          'java.util.regex.Pattern',
          'org.springframework.boot.autoconfigure.ImportAutoConfiguration',
          'org.springframework.boot.data.mongodb.test.autoconfigure.DataMongoTest',
          'org.springframework.data.mongodb.core.MongoTemplate',
          'org.springframework.data.mongodb.core.query.Criteria',
          'org.springframework.data.mongodb.core.query.Query',
          'org.springframework.data.mongodb.core.query.Update'
        ]
      }
    : {
        annotations: `@DataJpaTest(properties = {
        ${[
          `"spring.datasource.url=${datasource.url}"`,
          `"spring.datasource.username=${datasource.username}"`,
          `"spring.datasource.password=${datasource.password ?? ''}"`,
          ...conexionPerezosa(datasource),
          '"spring.jpa.hibernate.ddl-auto=create-drop"',
          '"spring.flyway.enabled=false"'
        ].join(',\n        ')}
})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Import(JdbcTimerStore.class)
@Transactional(propagation = Propagation.NOT_SUPPORTED)`,
        fields: `    @Autowired
    private DataSource dataSource;

    private JdbcClient jdbc() {
        return JdbcClient.create(dataSource);
    }`,
        clear: 'jdbc().sql("DELETE FROM keel_timer").update();',
        count: 'return jdbc().sql("SELECT count(*) FROM keel_timer WHERE kind LIKE :prefijo").param("prefijo", prefijo + "%").query(Long.class).single();',
        // La MISMA sentencia que el arnés (keel-core: `fire`): el temporizador vence ya, con la hora de la base.
        fire: `jdbc().sql(${javaString(timerStatements(model.stack.database).fire)}).param("kind", kind).update();`,
        imports: [
          'javax.sql.DataSource',
          'org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest',
          'org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase',
          'org.springframework.jdbc.core.simple.JdbcClient',
          'org.springframework.transaction.annotation.Propagation',
          'org.springframework.transaction.annotation.Transactional'
        ]
      };

  const mocks = entries.map((entry) => `    private ${entry.target} ${entry.mock};`).join('\n');
  const newMocks = entries.map((entry) => `        ${entry.mock} = mock(${entry.target}.class);`).join('\n');
  const replicaTimers = entries
    .map((entry) => `        ${entry.timerClass} ${entry.mock}Timer = new ${entry.timerClass}(${entry.mock});
        ReflectionTestUtils.setField(${entry.mock}Timer, "cron", ${javaString(entry.cron.default)});
        recurrentes.add(${entry.mock}Timer);`)
    .join('\n');
  const prefixes = entries.map((entry) => `TimerKinds.${`PURGE_${entry.table.toUpperCase()}`}`).join(', ');
  const verifyOnce = entries
    .map((entry) => `        verify(${entry.mock}, times(1).description("la purga de ${entry.table} se ejecutó en más de una réplica, o en ninguna")).purge();`)
    .join('\n');
  const verifyTwice = entries
    .map((entry) => `        verify(${entry.mock}, times(1).description("la purga de ${entry.table} volvió a ejecutarse antes de su siguiente tick")).purge();`)
    .join('\n');

  const body = `/**
 * Las purgas de las tablas del generador en MODO CLÚSTER (DSL 2.26, incremento 7), contra el motor real que levanta
 * infra/: dos réplicas aseguran y sondean los mismos recurrentes, y cada tick lo ejecuta UNA.
 *
 * <p>Lo escribe scripts/store-check.js desde src/lib/purge-timer-probes.js: no es parte del proyecto generado.
 */
${support.annotations}
class ${CLASS_PURGE_TIMER} {

    @Autowired
    private TimerStore store;

    @Autowired
    private PlatformTransactionManager transactionManager;

${support.fields}

    /** El bean que hace cada purga, compartido por las dos réplicas: sus llamadas son las ejecuciones del tick. */
${mocks}

    @BeforeEach
    void limpia() {
        ${support.clear}
${newMocks}
    }

    /** Una réplica: un sondeador con SUS PROPIAS instancias de cada recurrente, como un proceso aparte. */
    private Replica replica() {
        List<RecurringTimerHandler> recurrentes = new ArrayList<>();
${replicaTimers}
        TimerPoller poller = new TimerPoller(store, List.of(), recurrentes, transactionManager);
        ReflectionTestUtils.setField(poller, "maxSleepMs", 30_000L);
        ReflectionTestUtils.setField(poller, "batchSize", 50);
        ReflectionTestUtils.setField(poller, "leaseMs", 60_000L);
        ReflectionTestUtils.setField(poller, "maxAttempts", 10);
        ReflectionTestUtils.setField(poller, "retryDelayMs", 0L);
        return new Replica(poller, recurrentes);
    }

    private record Replica(TimerPoller poller, List<RecurringTimerHandler> recurrentes) {
    }

    /** Las filas cuyo kind empieza por el de esa purga (con el sabotaje, una por réplica). */
    private long filas(String prefijo) {
        ${support.count}
    }

    /** Adelanta los temporizadores de una réplica: vencen ya, con la hora de la base. */
    private void vencer(Replica replica) {
        for (RecurringTimerHandler recurrente : replica.recurrentes()) {
            String kind = recurrente.kind();
            ${support.fire}
        }
    }

    /** R1: cada réplica asegura sus recurrentes al arrancar, y dos réplicas no duplican la fila de una purga. */
    @Test
    void r1_unaFilaPorPurgaAunqueLaAsegurenDosReplicas() {
        replica().poller().ensureRecurring();
        replica().poller().ensureRecurring();
        for (String prefijo : List.of(${prefixes})) {
            assertEquals(1, filas(prefijo), "la purga " + prefijo + " tiene que ser UNA fila en keel_timer, la arbitren las réplicas que la arbitren");
        }
    }

    /** RC-1: con dos réplicas sondeando, cada tick de una purga lo ejecuta exactamente una. */
    @Test
    void rc1_cadaTickLoEjecutaUnaSolaReplica() {
        Replica a = replica();
        Replica b = replica();
        a.poller().ensureRecurring();
        b.poller().ensureRecurring();
        vencer(a);
        vencer(b);

        a.poller().pollOnce();
        b.poller().pollOnce();

${verifyOnce}
    }

    /** R2: el tick rearma la purga para su siguiente cron, desde la hora de la base: la misma réplica no la repite ya. */
    @Test
    void r2_elTickRearmaParaElSiguienteCron() {
        Replica a = replica();
        a.poller().ensureRecurring();
        vencer(a);

        a.poller().pollOnce();
        a.poller().pollOnce();

${verifyTwice}
        Long siguiente = store.nextDueMs(a.recurrentes().stream().map(RecurringTimerHandler::kind).toList());
        assertTrue(siguiente != null && siguiente > 0, "tras el tick la purga no quedó armada para el futuro: " + siguiente);
    }
}`;

  const imports = [
    ...entries.map((entry) => `${packages.targets[entry.table]}.${entry.target}`),
    ...support.imports,
    'java.util.ArrayList',
    'java.util.List',
    'org.junit.jupiter.api.BeforeEach',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.context.annotation.Import',
    'org.springframework.test.util.ReflectionTestUtils',
    'org.springframework.transaction.PlatformTransactionManager',
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertTrue',
    'static org.mockito.Mockito.mock',
    'static org.mockito.Mockito.times',
    'static org.mockito.Mockito.verify'
  ];
  const estatico = (x) => (x.startsWith('static ') ? 1 : 0);
  const ordenados = [...new Set(imports)].sort((a, b) => estatico(a) - estatico(b) || a.localeCompare(b));
  return `package ${packages.timer};\n\n${ordenados.map((name) => `import ${name};`).join('\n')}\n\n${body}\n`;
}

/**
 * El sabotaje `timer-every-replica` sobre el árbol generado: el kind de cada `<Tabla>PurgeTimer` pasa a llevar un id por
 * instancia, así que cada réplica arbitra con su propia fila y todas ejecutan el tick. Compila y arranca: lo que rompe es
 * el arbitraje, que es lo que se mide. Devuelve los parches `{ file, find, replace }` (el archivo, por su nombre).
 */
export function everyReplicaSabotage(model) {
  return timerPurges(model).map((purge) => {
    const constant = `PURGE_${purge.table.toUpperCase()}`;
    return {
      file: `${purgeTimerClass(purge.table)}.java`,
      find: `        return TimerKinds.${constant};`,
      replace: `        return TimerKinds.${constant} + "@" + replica;`,
      field: {
        find: `    @Override\n    public String kind() {`,
        replace: `    private final String replica = java.util.UUID.randomUUID().toString();\n\n    @Override\n    public String kind() {`
      }
    };
  });
}
