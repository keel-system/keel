// La sonda del cronómetro y de los plazos (DSL 2.26, PLAN-DSL-226-PLAZOS.md, incremento 3): el JUnit que
// `scripts/timer-check.js` escribe DENTRO del proyecto generado y ejecuta contra el motor que levanta su `infra/`.
//
// Ejecuta lo que build emitió —el rechazo tardío del dominio, el armado del adaptador, el almacén con las sentencias de
// keel-core y el sondeador— y no una copia: los nombres (entidad, estados, campo `since`, componente del plazo, `kind`)
// salen del MODELO. Cada caso lleva el id de keel-core/gen/deadlines.js (DEADLINE_CASES) delante de su nombre, y los
// sabotajes de abajo tienen que caer en exactamente los suyos.
//
// Lo que escribiría el agente —el método semántico de la entidad y el handler de la operación `by`— lo pone la sonda
// con `timerProbePatches`: sin él, el disparo acabaría en el `UnsupportedOperationException` del stub.

import { subPackage } from '../scaffold/render.js';
import { modelDeadlines, lateGuards, DEADLINE_CASES } from '@keel-system/keel-core/gen/deadlines';
import { timerStatements } from '@keel-system/keel-core/gen/timer-store';
import { deadlinesClass, deadlineComponent } from '../scaffold/timer.js';

export const CLASS_NAME = 'TimerProbeTest';
export const PACKAGE_LEAF = 'infrastructure.timer';

const cap = (name) => name[0].toUpperCase() + name.slice(1);
const decap = (name) => name[0].toLowerCase() + name.slice(1);

/** El sujeto: el primer plazo con rechazo tardío del diseño, con todo lo que la sonda nombra. */
export function timerSubject(model) {
  const entry = modelDeadlines(model).find(({ entity }) => lateGuards(entity).length > 0) ?? modelDeadlines(model)[0];
  if (!entry) throw new Error('el diseño no declara ningún plazo: no hay cronómetro que ejercitar');
  const { entity, deadline, kind } = entry;
  const operation = (model.services ?? []).flatMap((service) => service.operations ?? []).find((op) => op.name === deadline.by);
  const guard = lateGuards(entity).find((candidate) => candidate.from === deadline.state) ?? null;
  const error = guard ? model.errors.find((candidate) => candidate.code === guard.error) : null;
  // El destino de una transición tardía: otro que el de la caducidad, saliendo del estado del plazo.
  const lateTarget = entity.lifecycle.transitions.find((transition) => transition.from === deadline.state)?.to.find((state) => state !== deadline.to) ?? null;
  return { entity, deadline, kind, operation, guard, error, lateTarget, enumType: entity.lifecycle.enumType, statusField: entity.lifecycle.field };
}

/** Los argumentos del constructor de rehidratación, en su orden: lo que deja construir la entidad en un estado dado. */
function rehydrationArgs(subject) {
  const { entity, deadline, enumType, statusField } = subject;
  const args = entity.fields.map((field) => {
    if (field.isId) return 'id';
    if (field.name === statusField) return 'status';
    if (field.name === deadline.since) return 'since';
    if (!field.required) return 'null';
    if (field.javaType === 'String') return `"${'1'.repeat(Math.min(field.constraints?.maxLength ?? 6, 6))}"`;
    if (field.javaType === 'Instant') return 'since';
    if (field.javaType === 'Integer' || field.javaType === 'int') return '0';
    if (field.javaType === 'Long' || field.javaType === 'long') return '0L';
    if (field.javaType === 'Boolean' || field.javaType === 'boolean') return 'false';
    return `${field.javaType}.values()[0]`;
  });
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) args.push('null');
  return { args, enumType };
}

/**
 * Lo que escribiría el agente, como parches de texto sobre el proyecto generado: `{ file, find, replace }`. Un método
 * PÚBLICO de la sonda en la entidad (los de transición son privados) y el handler de la operación `by`, que caduca la
 * entidad, salvo la que la propiedad de sistema `keel.timer.fail` nombre (el caso del aparcado).
 */
export function timerProbePatches(model) {
  const subject = timerSubject(model);
  const { entity, deadline, operation, enumType } = subject;
  const repository = `${decap(entity.name)}Repository`;
  const withClock = Boolean(subject.guard);
  return [
    {
      file: `${entity.name}.java`,
      find: '    public UUID getId() {',
      replace: `    /** Sonda del cronómetro (timer-check): el método semántico que escribiría el agente. */
    public void probeTransition(${enumType} target) {
        transitionTo(target);
    }
${withClock ? `
    /** Sonda del cronómetro (timer-check): la transición con la hora y los plazos. */
    public void probeTransition(${enumType} target, java.time.Instant now, ${subPackage(model, 'domain.deadline')}.${deadlinesClass(model)} deadlines) {
        transitionTo(target, now, deadlines);
    }
` : ''}
    public UUID getId() {`
    },
    {
      file: `${operation.handlerClass}.java`,
      find: `        throw new UnsupportedOperationException("TODO: ${operation.name}");`,
      replace: `        // Sonda del cronómetro (timer-check): lo que escribiría el agente.
        if (command.id().toString().equals(System.getProperty("keel.timer.fail"))) {
            throw new IllegalStateException("fallo de prueba del cronómetro");
        }
        var found = ${repository}.findById(command.id()).orElseThrow();
        found.probeTransition(${subPackage(model, 'domain.enums')}.${enumType}.${deadline.to});
        ${repository}.save(found);`
    }
  ];
}

// ─── Lo que cambia por modelo de persistencia ────────────────────────────────

function relationalSupport(model) {
  const fire = timerStatements(model.stack.database).fire;
  return {
    imports: ['javax.sql.DataSource', 'org.springframework.jdbc.core.simple.JdbcClient'],
    fields: `    @Autowired
    private DataSource dataSource;

    private JdbcClient jdbc() {
        return JdbcClient.create(dataSource);
    }`,
    clear: 'jdbc().sql("DELETE FROM keel_timer").update();',
    count: 'return jdbc().sql("SELECT count(*) FROM keel_timer WHERE kind = :kind").param("kind", kind).query(Long.class).single();',
    // La MISMA sentencia que el arnés (keel-core: `fire`): el temporizador vence ya, con la hora de la base.
    fire: `jdbc().sql(${JSON.stringify(fire)}).param("kind", kind).update();`
  };
}

function documentSupport() {
  return {
    imports: [
      'org.springframework.data.mongodb.core.MongoTemplate',
      'org.springframework.data.mongodb.core.query.Criteria',
      'org.springframework.data.mongodb.core.query.Query',
      'org.springframework.data.mongodb.core.query.Update',
      'java.util.Date'
    ],
    fields: `    @Autowired
    private MongoTemplate mongo;`,
    clear: 'mongo.remove(new Query(), "keel_timer");',
    count: 'return mongo.count(Query.query(Criteria.where("kind").is(kind)), "keel_timer");',
    fire: 'mongo.updateMulti(Query.query(Criteria.where("kind").is(kind)), new Update().set("due_at", Date.from(store.dbNow())), "keel_timer");'
  };
}

// ─── La clase ────────────────────────────────────────────────────────────────

export function timerTestClass(model, { properties = [] } = {}) {
  const subject = timerSubject(model);
  const { entity, deadline, kind, guard, error, lateTarget, enumType, statusField } = subject;
  const document = model.persistenceKind === 'document';
  const support = document ? documentSupport() : relationalSupport(model);
  const component = deadlineComponent(entity.name, deadline.stateName);
  const { args } = rehydrationArgs(subject);
  const getStatus = `get${cap(statusField)}()`;
  const portClass = `${entity.name}Repository`;
  const caseName = (id) => DEADLINE_CASES.find((entry) => entry.id === id)?.what ?? id;

  const imports = [
    `${subPackage(model, 'domain.enums')}.${enumType}`,
    `${subPackage(model, 'domain.repository')}.${portClass}`,
    `${subPackage(model, entity.isAggregateRoot ? 'domain.aggregate' : 'domain.entity')}.${entity.name}`,
    `${subPackage(model, 'domain.deadline')}.${deadlinesClass(model)}`,
    error ? `${subPackage(model, 'domain.errors')}.${error.exceptionClass}` : null,
    ...support.imports,
    'java.lang.reflect.InvocationTargetException',
    'java.lang.reflect.Method',
    'java.time.Duration',
    'java.time.Instant',
    'java.util.ArrayList',
    'java.util.HashSet',
    'java.util.List',
    'java.util.Set',
    'java.util.UUID',
    'java.util.concurrent.CyclicBarrier',
    'java.util.concurrent.ExecutorService',
    'java.util.concurrent.Executors',
    'java.util.concurrent.Future',
    'org.junit.jupiter.api.BeforeEach',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.test.context.SpringBootTest',
    'org.springframework.test.context.ActiveProfiles',
    'org.springframework.test.util.ReflectionTestUtils',
    'org.springframework.transaction.PlatformTransactionManager',
    'org.springframework.transaction.support.TransactionTemplate',
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertTrue',
    'static org.junit.jupiter.api.Assertions.fail'
  ].filter(Boolean);

  const domainCases = guard && lateTarget
    ? `
    /** DL-1: ${caseName('DL-1')}. */
    @Test
    void dl1_dentroDelPlazoLaTransicionTardiaSale() throws Exception {
        Instant since = Instant.parse("2026-11-07T10:00:00Z");
        ${entity.name} entidad = entidad(UUID.randomUUID(), ${enumType}.${deadline.state}, since);
        transicion(entidad, ${enumType}.${lateTarget}, since.plus(deadlines.${component}()).minusMillis(1));
        assertEquals(${enumType}.${lateTarget}, entidad.${getStatus}, "un milisegundo antes del vencimiento la transición tenía que salir");
    }

    /** DL-2: ${caseName('DL-2')}. */
    @Test
    void dl2_enElInstanteExactoSeRechaza() throws Exception {
        Instant since = Instant.parse("2026-11-07T10:00:00Z");
        ${entity.name} entidad = entidad(UUID.randomUUID(), ${enumType}.${deadline.state}, since);
        try {
            transicion(entidad, ${enumType}.${lateTarget}, since.plus(deadlines.${component}()));
            fail("en el instante exacto del vencimiento la transición tardía tenía que rechazarse con ${guard.error}");
        } catch (InvocationTargetException rejected) {
            assertTrue(rejected.getCause() instanceof ${error ? error.exceptionClass : 'IllegalStateException'},
                    "el rechazo tardío no es ${guard.error}: " + rejected.getCause());
        }
        assertEquals(${enumType}.${deadline.state}, entidad.${getStatus}, "una transición rechazada no puede mover el estado");
    }

    /** DL-3: ${caseName('DL-3')}. */
    @Test
    void dl3_haciaElDestinoDeLaCaducidadSale() throws Exception {
        Instant since = Instant.parse("2026-11-07T10:00:00Z");
        ${entity.name} entidad = entidad(UUID.randomUUID(), ${enumType}.${deadline.state}, since);
        transicion(entidad, ${enumType}.${deadline.to}, since.plus(deadlines.${component}()).plusSeconds(3600));
        assertEquals(${enumType}.${deadline.to}, entidad.${getStatus});
    }

    private static void transicion(${entity.name} entidad, ${enumType} destino, Instant now) throws Exception {
        Method metodo = ${entity.name}.class.getDeclaredMethod("transitionTo", ${enumType}.class, Instant.class, ${deadlinesClass(model)}.class);
        metodo.setAccessible(true);
        metodo.invoke(entidad, destino, now, DEADLINES_FIJOS);
    }

    // Los plazos con los que se miden DL-1 a DL-3: los del contexto, que son los del perfil.
    private static ${deadlinesClass(model)} DEADLINES_FIJOS;
`
    : '';

  const body = `/**
 * La sonda del cronómetro y de los plazos (DSL 2.26), escrita por timer-check: ejecuta lo que build emitió contra el
 * motor real. Cada caso lleva su id de keel-core (DEADLINE_CASES).
 */
@SpringBootTest(properties = {
${['"scheduling.enabled=false"', ...properties].map((property) => `        ${property}`).join(',\n')}
})
@ActiveProfiles("local")
class ${CLASS_NAME} {

    private static final String KIND = "${kind}";

    @Autowired
    private TimerStore store;

    @Autowired
    private ${portClass} repository;

    @Autowired
    private ${deadlinesClass(model)} deadlines;

    @Autowired
    private List<TimerHandler> handlers;

    @Autowired
    private PlatformTransactionManager transactionManager;

${support.fields}

    @BeforeEach
    void limpia() {
        ${support.clear}
        System.clearProperty("keel.timer.fail");
        DEADLINES_FIJOS_SET(deadlines);
    }

    private static void DEADLINES_FIJOS_SET(${deadlinesClass(model)} value) {
        ${guard && lateTarget ? 'DEADLINES_FIJOS = value;' : ''}
    }

    private long temporizadores(String kind) {
        ${support.count}
    }

    private void vencer(String kind) {
        ${support.fire}
    }

    private static ${entity.name} entidad(UUID id, ${enumType} status, Instant since) {
        return new ${entity.name}(${args.join(', ')});
    }

    /** Guarda la entidad por el adaptador, en una transacción: es lo que arma el temporizador. */
    private UUID guarda(${enumType} status, Instant since) {
        UUID id = UUID.randomUUID();
        new TransactionTemplate(transactionManager).executeWithoutResult(tx -> repository.save(entidad(id, status, since)));
        return id;
    }

    /** Un código cuyo plazo venció hace \`hace\` (con la hora de la base). */
    private UUID vencida(Duration hace) {
        return guarda(${enumType}.${deadline.state}, store.dbNow().minus(deadlines.${component}()).minus(hace));
    }

    private TimerPoller sondeador(int maxAttempts, long retryDelayMs) {
        TimerPoller poller = new TimerPoller(store, handlers, transactionManager);
        ReflectionTestUtils.setField(poller, "maxSleepMs", 30_000L);
        ReflectionTestUtils.setField(poller, "batchSize", 50);
        ReflectionTestUtils.setField(poller, "leaseMs", 60_000L);
        ReflectionTestUtils.setField(poller, "maxAttempts", maxAttempts);
        ReflectionTestUtils.setField(poller, "retryDelayMs", retryDelayMs);
        return poller;
    }

    private ${enumType} estado(UUID id) {
        return repository.findById(id).orElseThrow().${getStatus};
    }
${domainCases}
    /** DL-4: ${caseName('DL-4')}. */
    @Test
    void dl4_entrarEnElEstadoArmaEnLaMismaTransaccion() {
        guarda(${enumType}.${deadline.state}, store.dbNow());
        assertEquals(1, temporizadores(KIND), "guardar una entidad que entra en '${deadline.stateName}' no armó su temporizador");

        UUID id = UUID.randomUUID();
        new TransactionTemplate(transactionManager).executeWithoutResult(tx -> {
            repository.save(entidad(id, ${enumType}.${deadline.state}, store.dbNow()));
            tx.setRollbackOnly();
        });
        assertEquals(1, temporizadores(KIND), "la transacción revirtió y el temporizador se quedó: se armó fuera de ella");
    }

    /** DL-5: ${caseName('DL-5')}. */
    @Test
    void dl5_elReclamoDevuelveSoloLoVencidoEnOrden() {
        UUID antigua = vencida(Duration.ofMinutes(30));
        UUID reciente = vencida(Duration.ofMinutes(5));
        guarda(${enumType}.${deadline.state}, store.dbNow());

        List<ClaimedTimer> reclamados = store.claim(List.of(KIND), 10, 60_000, UUID.randomUUID());

        assertEquals(2, reclamados.size(), "el reclamo tenía que llevarse los dos vencidos y no el que vence en el futuro");
        assertEquals(antigua, reclamados.get(0).entityId(), "el reclamo no va en orden de vencimiento");
        assertEquals(reciente, reclamados.get(1).entityId());
    }

    /** DL-6: ${caseName('DL-6')}. */
    @Test
    void dl6_dosReplicasNoReclamanElMismo() throws Exception {
        for (int i = 0; i < 20; i++) {
            vencida(Duration.ofMinutes(1));
        }
        CyclicBarrier salida = new CyclicBarrier(2);
        ExecutorService replicas = Executors.newFixedThreadPool(2);
        try {
            List<Future<List<ClaimedTimer>>> lotes = new ArrayList<>();
            for (int r = 0; r < 2; r++) {
                lotes.add(replicas.submit(() -> {
                    salida.await();
                    return store.claim(List.of(KIND), 20, 60_000, UUID.randomUUID());
                }));
            }
            Set<String> vistos = new HashSet<>();
            int total = 0;
            for (Future<List<ClaimedTimer>> lote : lotes) {
                for (ClaimedTimer timer : lote.get()) {
                    total++;
                    vistos.add(timer.id());
                }
            }
            assertEquals(total, vistos.size(), "dos réplicas reclamaron el mismo temporizador a la vez");
            assertEquals(20, vistos.size(), "entre las dos réplicas no se llevaron todos los vencidos");
        } finally {
            replicas.shutdownNow();
        }
        assertEquals(0, store.claim(List.of(KIND), 20, 60_000, UUID.randomUUID()).size(),
                "un temporizador arrendado volvió a reclamarse antes de que venciera su arriendo");
    }

    /** DL-7: ${caseName('DL-7')}. */
    @Test
    void dl7_unArriendoVencidoLoRetomaOtra() throws Exception {
        vencida(Duration.ofMinutes(1));
        assertEquals(1, store.claim(List.of(KIND), 10, 400, UUID.randomUUID()).size());
        assertEquals(0, store.claim(List.of(KIND), 10, 400, UUID.randomUUID()).size(), "otra réplica le quitó el temporizador con el arriendo en vigor");
        Thread.sleep(1_000);
        assertEquals(1, store.claim(List.of(KIND), 10, 400, UUID.randomUUID()).size(), "vencido el arriendo, otra réplica no lo retomó");
    }

    /** DL-8: ${caseName('DL-8')}. */
    @Test
    void dl8_unaEntidadQueYaSalioSeDescarta() {
        UUID id = vencida(Duration.ofMinutes(1));
        ${lateTarget ? `new TransactionTemplate(transactionManager).executeWithoutResult(tx -> {
            ${entity.name} found = repository.findById(id).orElseThrow();
            found.probeTransition(${enumType}.${lateTarget}${guard ? ', found.get' + cap(deadline.since) + '(), deadlines' : ''});
            repository.save(found);
        });` : ''}

        sondeador(10, 0).pollOnce();

        assertEquals(0, temporizadores(KIND), "el temporizador de una entidad que ya salió del estado no se descartó");
        assertEquals(${enumType}.${lateTarget ?? deadline.to}, estado(id), "el cronómetro movió una entidad que ya no estaba en '${deadline.stateName}'");
    }

    /** DL-9: ${caseName('DL-9')}. */
    @Test
    void dl9_conElPlazoVigenteMasLargoSeRearma() {
        UUID id = guarda(${enumType}.${deadline.state}, store.dbNow());
        vencer(KIND);

        sondeador(10, 0).pollOnce();

        assertEquals(${enumType}.${deadline.state}, estado(id), "con el plazo vigente sin vencer, el cronómetro caducó la entidad");
        assertEquals(1, temporizadores(KIND), "el temporizador se borró en vez de rearmarse");
        assertEquals(0, store.claim(List.of(KIND), 10, 60_000, UUID.randomUUID()).size(), "el temporizador no se rearmó al vencimiento vigente");
    }

    /** DL-3, de punta a punta: el temporizador vencido despacha la operación y la entidad caduca. */
    @Test
    void dl3_elVencidoDespachaYLaEntidadCaduca() {
        UUID id = vencida(Duration.ofMinutes(1));

        sondeador(10, 0).pollOnce();

        assertEquals(${enumType}.${deadline.to}, estado(id), "vencido el plazo, la entidad no pasó a '${deadline.toName}'");
        assertEquals(0, temporizadores(KIND), "el temporizador cumplido no se borró");
    }

    /** DL-10: ${caseName('DL-10')} (el sueño y el despertar). */
    @Test
    void dl10_duermeHastaElSiguienteVencimiento() {
        guarda(${enumType}.${deadline.state}, store.dbNow().minus(deadlines.${component}()).plusSeconds(5));
        TimerPoller poller = sondeador(10, 0);

        long sueno = poller.pollOnce();
        assertTrue(sueno > 2_000 && sueno <= 5_500, "con un vencimiento a 5 s el sondeador iba a dormir " + sueno + " ms");

        ${support.clear}
        assertEquals(30_000L, poller.pollOnce(), "sin nada pendiente, el sueño es el tope");

        long ahora = System.currentTimeMillis();
        poller.planWake(ahora, 30_000);
        poller.onArmed(new TimerArmed(Instant.ofEpochMilli(ahora + 1_000)));
        assertTrue(poller.wakeAtMs() <= ahora + 1_000, "armar uno que vence antes no adelantó el despertar");
    }

    /** DL-10: ${caseName('DL-10')} (el aparcado). */
    @Test
    void dl10_aparcaTrasLosIntentos() {
        UUID id = vencida(Duration.ofMinutes(1));
        System.setProperty("keel.timer.fail", id.toString());
        TimerPoller poller = sondeador(2, 0);
        long antes = store.parkedCount();

        poller.pollOnce();
        assertEquals(antes, store.parkedCount(), "aparcó al primer fallo");
        poller.pollOnce();
        assertEquals(antes + 1, store.parkedCount(), "agotados los intentos, el temporizador no se aparcó");
        assertEquals(${enumType}.${deadline.state}, estado(id));
    }

    /** R1: cada réplica asegura sus recurrentes al arrancar, y asegurarlos dos veces no duplica. */
    @Test
    void r1_laPurgaDeLaTablaEsUnRecurrente() {
        TimerPoller poller = sondeador(10, 0);
        poller.ensureRecurring();
        poller.ensureRecurring();
        assertEquals(1, temporizadores(TimerKinds.TIMER_PURGE), "la purga de la tabla no quedó asegurada como un recurrente");
    }
}`;
  return body.replace(/^/, `package ${subPackage(model, PACKAGE_LEAF)};\n\n${[...new Set(imports)].sort().map((name) => `import ${name};`).join('\n')}\n\n`);
}
