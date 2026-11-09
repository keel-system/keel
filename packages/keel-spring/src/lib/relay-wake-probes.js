// El relay del outbox por réplica (DSL 2.26, inc. 9), EJECUTADO contra el motor real por store-check: los casos RW de
// keel-core/gen/timer-plan.js (`RELAY_WAKE_CASES`), con el relay EMITIDO en marcha —su bucle, su despertar y su
// reintento— y el bridge EMITIDO escribiendo la fila. El dispatcher es un doble que apunta cada intento, y el sondeo de
// respaldo va a 600 s: todo lo que salga antes lo ha hecho salir un despertar o un reintento, nunca el sondeo.
//
// Por qué el bridge y no una fila escrita a mano: el despertar es la línea que el bridge añade tras escribir la fila
// (`OUTBOX_WAKE_LINE`), y un caso que la escribiera por su cuenta mediría una copia. `append` es privado, así que se
// llama por reflexión: la envoltura va a null —el bridge la serializa como `null`, y al doble le da igual el cuerpo—.
//
// El contexto se cierra al acabar la clase (@DirtiesContext): con el relay en marcha, un contexto cacheado seguiría
// reclamando las filas que siembran las demás clases de la suite.

import { RELAY_WAKE_CASES, RELAY_SABOTAGES } from '@keel-system/keel-core/gen/timer-plan';
import { outboxNames, OUTBOX_WAKE_LINE } from '../scaffold/outbox.js';
import { conexionPerezosa } from './claim-probes.js';

export const CLASS_RELAY_WAKE = 'RelayWakeStoreCheckTest';

/** El sondeo de respaldo de la sonda: lo bastante largo para que nada de lo medido pueda deberse a él. */
export const PROBE_POLL_MS = 600000;
/** El backoff de la sonda: corto, para que RW-3 vea el reintento en segundos. */
export const PROBE_BACKOFF_MS = 300;
/** Cuánto espera cada caso a que el evento salga: muy por debajo del sondeo, muy por encima del despertar. */
export const PROBE_WAIT_MS = 5000;

/** Los métodos de la clase, uno por caso RW, con su id delante (es lo que lee el veredicto de un sabotaje). */
export const RELAY_WAKE_METHODS = Object.freeze({
  'RW-1': 'rw1_unEventoConfirmadoSaleSinEsperarAlSondeo',
  'RW-2': 'rw2_enReposoNoHayPasadasHastaElSondeo',
  'RW-3': 'rw3_unFalloSeReintentaASuBackoffYNoAlSondeo'
});

/**
 * Los sabotajes: un parche sobre lo emitido que tumba exactamente sus casos.
 *   · relay-no-wake: el bridge deja de despertar al relay (cae RW-1);
 *   · relay-no-retry: el relay olvida el reintento que programó, y la fila espera al sondeo (cae RW-3).
 */
export const RELAY_WAKE_SABOTAGES = Object.freeze({
  'relay-no-wake': Object.freeze({
    file: (model) => `${model.service.className}DomainEventBridge.java`,
    find: OUTBOX_WAKE_LINE,
    replace: '// sabotaje relay-no-wake: sin despertar',
    breaks: RELAY_SABOTAGES['relay-no-wake']
  }),
  'relay-no-retry': Object.freeze({
    file: () => 'OutboxRelay.java',
    find: 'pendingRetryMs = Math.min(remembered, retryAtMs);',
    replace: 'pendingRetryMs = Long.MAX_VALUE; // sabotaje relay-no-retry',
    breaks: RELAY_SABOTAGES['relay-no-retry']
  })
});

const relayProperties = () => [
  '"scheduling.enabled=true"',
  `"outbox.relay.poll-ms=${PROBE_POLL_MS}"`,
  '"outbox.relay.batch-size=3"',
  '"outbox.relay.max-attempts=5"',
  `"outbox.relay.backoff.initial-ms=${PROBE_BACKOFF_MS}"`,
  `"outbox.relay.backoff.max-ms=${PROBE_BACKOFF_MS}"`,
  '"outbox.relay.claim-timeout-ms=60000"'
];

/**
 * La clase de prueba, en el paquete del relay (`passes()` es package-private). `packages.bridge` es el del bridge.
 */
export function relayWakeTestClass(model, { datasource, packages }) {
  const document = model.persistenceKind === 'document';
  const { entity, repository } = outboxNames(model);
  const bridge = `${model.service.className}DomainEventBridge`;
  const properties = document
    ? [`"spring.mongodb.uri=${datasource.uri}"`, '"spring.profiles.active="', ...relayProperties()]
    : [
        `"spring.datasource.url=${datasource.url}"`,
        `"spring.datasource.username=${datasource.username}"`,
        `"spring.datasource.password=${datasource.password ?? ''}"`,
        ...conexionPerezosa(datasource),
        '"spring.jpa.hibernate.ddl-auto=create-drop"',
        '"spring.flyway.enabled=false"',
        ...relayProperties()
      ];
  const annotations = document
    ? `@DataMongoTest(properties = {
        ${properties.join(',\n        ')}
})
@ImportAutoConfiguration(exclude = EmbeddedMongoAutoConfiguration.class)
@Import({OutboxRelay.class, ${bridge}.class, ${CLASS_RELAY_WAKE}.Dobles.class})`
    : `@DataJpaTest(properties = {
        ${properties.join(',\n        ')}
})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Import({OutboxRelay.class, OutboxRelayStore.class, ${bridge}.class, ${CLASS_RELAY_WAKE}.Dobles.class})
@Transactional(propagation = Propagation.NOT_SUPPORTED)`;
  const clean = document ? `mongo.remove(new Query(), ${entity}.class);` : 'outbox.deleteAllInBatch();';
  // La escritura va en una transacción en la rama relacional: el despertar es un @TransactionalEventListener de
  // AFTER_COMMIT, y lo que se mide es que llegue TRAS el commit. En la documental el bridge no abre ninguna.
  const write = document
    ? 'append.invoke(bridge, "store-check", eventType, null);'
    : 'tx.executeWithoutResult(status -> invoke(eventType));';

  const body = `/**
 * El relay del outbox por réplica (DSL 2.26, inc. 9) contra el motor real: los casos RW de keel-core.
 *
 * <p>Lo escribe scripts/store-check.js desde src/lib/relay-wake-probes.js: no es parte del proyecto generado.
 */
${annotations}
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ${CLASS_RELAY_WAKE} {

    /** Cada intento de publicación: el tipo y cuándo. */
    record Intento(String eventType, long atMs) {
    }

    static final Queue<Intento> INTENTOS = new ConcurrentLinkedQueue<>();
    /** Cuántos de los siguientes intentos fallan, como un broker caído. */
    static final AtomicInteger FALLAN = new AtomicInteger();

    @TestConfiguration
    static class Dobles {
        @Bean
        OutboxDispatcher dispatcher() {
            return (destination, routingKey, eventType, payload) -> {
                INTENTOS.add(new Intento(eventType, System.currentTimeMillis()));
                if (FALLAN.getAndUpdate(n -> Math.max(0, n - 1)) > 0) {
                    throw new IllegalStateException("store-check: el broker no contesta");
                }
            };
        }

        @Bean
        MeterRegistry meterRegistry() {
            return new SimpleMeterRegistry();
        }

        @Bean
        ObjectMapper objectMapper() {
            return JsonMapper.builder().build();
        }
    }

    @Autowired
    private OutboxRelay relay;

    @Autowired
    private ${bridge} bridge;
${document ? `
    @Autowired
    private MongoTemplate mongo;
` : `
    @Autowired
    private ${repository} outbox;

    private TransactionTemplate tx;

    @Autowired
    void transacciones(PlatformTransactionManager manager) {
        this.tx = new TransactionTemplate(manager);
    }
`}
    private Method append;

    @BeforeEach
    void prepara() throws Exception {
        append = Arrays.stream(${bridge}.class.getDeclaredMethods())
                .filter(method -> method.getName().equals("append"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("el bridge ya no tiene append(): ¿cambió cómo escribe el outbox?"));
        append.setAccessible(true);
        ${clean}
        INTENTOS.clear();
        FALLAN.set(0);
    }
${document ? '' : `
    private void invoke(String eventType) {
        try {
            append.invoke(bridge, "store-check", eventType, null);
        } catch (ReflectiveOperationException failure) {
            throw new IllegalStateException(failure);
        }
    }
`}
    /** Escribe una fila por el bridge, como lo hace un caso de uso. */
    private void escribe(String eventType) throws Exception {
        ${write}
    }

    /** Los intentos de ese tipo que lleguen antes del plazo, esperando hasta tener {@code cuantos}. */
    private List<Intento> espera(String eventType, int cuantos) throws InterruptedException {
        long limite = System.currentTimeMillis() + ${PROBE_WAIT_MS};
        while (System.currentTimeMillis() < limite) {
            List<Intento> vistos = INTENTOS.stream().filter(intento -> intento.eventType().equals(eventType)).toList();
            if (vistos.size() >= cuantos) {
                return vistos;
            }
            Thread.sleep(20);
        }
        return INTENTOS.stream().filter(intento -> intento.eventType().equals(eventType)).toList();
    }

    @Test
    void elRelayEstaEnMarcha() {
        assertTrue(relay.isRunning(), "el relay no arrancó: scheduling.enabled o SmartLifecycle");
    }

    /** ${RELAY_WAKE_CASES[0].id}: ${RELAY_WAKE_CASES[0].what}. */
    @Test
    void ${RELAY_WAKE_METHODS['RW-1']}() throws Exception {
        long antes = System.currentTimeMillis();
        escribe("RW1");
        List<Intento> vistos = espera("RW1", 1);
        assertFalse(vistos.isEmpty(), "el evento no salió en ${PROBE_WAIT_MS} ms: sin despertar espera al sondeo de respaldo (${PROBE_POLL_MS} ms)");
        System.out.println("store-check RW-1: el evento salió a los " + (vistos.get(0).atMs() - antes) + " ms del commit");
    }

    /** ${RELAY_WAKE_CASES[1].id}: ${RELAY_WAKE_CASES[1].what}. */
    @Test
    void ${RELAY_WAKE_METHODS['RW-2']}() throws Exception {
        // La pasada del arranque (o la de un caso anterior) ya pasó; desde ahí, nada la despierta.
        Thread.sleep(500);
        long antes = relay.passes();
        Thread.sleep(3000);
        assertEquals(antes, relay.passes(), "el relay hizo pasadas en reposo: sondea por su cuenta en vez de esperar al despertar");
    }

    /** ${RELAY_WAKE_CASES[2].id}: ${RELAY_WAKE_CASES[2].what}. */
    @Test
    void ${RELAY_WAKE_METHODS['RW-3']}() throws Exception {
        FALLAN.set(1);
        escribe("RW3");
        // El primer intento lo despierta el caso, no el bridge: lo que mide RW-3 es el reintento, y sin esto el
        // sabotaje del despertar lo tumbaría también.
        relay.wake();
        List<Intento> vistos = espera("RW3", 2);
        assertEquals(2, vistos.size(), "la fila que falló no se reintentó en ${PROBE_WAIT_MS} ms: esperó al sondeo de respaldo y no a su backoff (${PROBE_BACKOFF_MS} ms)");
        long separacion = vistos.get(1).atMs() - vistos.get(0).atMs();
        assertTrue(separacion >= ${PROBE_BACKOFF_MS} - 50, "el reintento llegó antes de su backoff: " + separacion + " ms");
    }
}`;

  const imports = [
    'java.lang.reflect.Method',
    'java.util.Arrays',
    'java.util.List',
    'java.util.Queue',
    'java.util.concurrent.ConcurrentLinkedQueue',
    'java.util.concurrent.atomic.AtomicInteger',
    'io.micrometer.core.instrument.MeterRegistry',
    'io.micrometer.core.instrument.simple.SimpleMeterRegistry',
    'org.junit.jupiter.api.BeforeEach',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.test.context.TestConfiguration',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Import',
    'org.springframework.test.annotation.DirtiesContext',
    'tools.jackson.databind.ObjectMapper',
    'tools.jackson.databind.json.JsonMapper',
    `${packages.bridge}.${bridge}`,
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertFalse',
    'static org.junit.jupiter.api.Assertions.assertTrue',
    ...(document
      ? [
          'de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration',
          'org.springframework.boot.autoconfigure.ImportAutoConfiguration',
          'org.springframework.boot.data.mongodb.test.autoconfigure.DataMongoTest',
          'org.springframework.data.mongodb.core.MongoTemplate',
          'org.springframework.data.mongodb.core.query.Query'
        ]
      : [
          'org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest',
          'org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase',
          'org.springframework.transaction.PlatformTransactionManager',
          'org.springframework.transaction.annotation.Propagation',
          'org.springframework.transaction.annotation.Transactional',
          'org.springframework.transaction.support.TransactionTemplate'
        ])
  ];
  const estatico = (x) => (x.startsWith('static ') ? 1 : 0);
  const ordered = [...new Set(imports)].sort((a, b) => estatico(a) - estatico(b) || a.localeCompare(b));
  return `package ${packages.relay};\n\n${ordered.map((i) => `import ${i};`).join('\n')}\n\n${body}\n`;
}
