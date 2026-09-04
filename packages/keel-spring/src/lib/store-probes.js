// Fuente única del JUnit con el que `scripts/store-check.js` ejercita, contra el motor real, los
// dos mecanismos que hasta ahora solo se GENERABAN: el relay del outbox y los almacenes de
// idempotencia.
//
// Mismo papel que `claim-probes.js`, y por el mismo motivo — pero sobre un hueco distinto.
// `claim-check` cubre `operation.claim` y `operation.guardClaim`: el reclamo de un barrido y la
// guarda de un efecto irreversible. Lo que queda fuera es todo lo que no cuelga de una operación
// del diseño sino del servicio entero:
//
//   · el JPQL de `findPending` y el LEASE de `claimBatch` (o su `findAndModify` documental),
//   · la carrera que arbitra la clave primaria de `idempotency_record`,
//   · la clave compuesta de `processed_event`.
//
// Ninguna de esas cadenas la mira ninguna red. Los tests comparan cadenas, `java-syntax` solo
// tokeniza y javac da por bueno cualquier JPQL sintácticamente válido. Y su modo de fallo es el
// de siempre en este repo: **no falla**. Un predicado que no casa deja el relay reclamando cero
// filas como si el outbox estuviera vacío; una clave compuesta a la que le falta el `handlerId`
// deduplica de más y descarta mensajes de otro handler en silencio.
//
// **Dos clases, no una, y no es organización.** `OutboxRelayStore` es package-private en
// `…messaging.outbox` y `ProcessedEventWriter` lo es en `…messaging.idempotency`: una sola clase
// de prueba no puede importar los dos. Cada una vive en el paquete de lo que mide.
//
// **Los nombres salen del MODELO**, no escritos a mano. Es la lección que costó una medición
// entera en `claim-check`: mientras derivaba las columnas por su cuenta, medía una segunda copia
// de la misma derivación y romper el generador lo dejaba en verde.

import { outboxNames, usesOutbox } from '../scaffold/outbox.js';
import { processedEventNames, usesIdempotency } from '../scaffold/idempotency.js';
import { declaresIdempotency, idempotentOperations } from '../scaffold/http-idempotency.js';
import { reconciliationClaims } from '../scaffold/reconciliation-claim.js';
// La MISMA derivación que usa claim-check para sembrar una fila: los NOT NULL de la entidad, no
// una lista escrita a mano. Una segunda copia se separa, y el día que se separe el síntoma será
// «el barrido no se llevó nada» — indistinguible del defecto que se persigue.
import { requiredLiterals, accessor } from './claim-probes.js';
import { screamingSnake } from './naming.js';
// La MISMA decisión que toma el generador para el barrido. No es una preferencia del check: sin
// ella el reclamo de reconciliación NO FUNCIONA en MySQL — medido, ver el javadoc de `reclamar`.
import { needsReadCommitted } from './claim-sql.js';

/** Las dos clases que escribe el runner. El `--tests` de Gradle las toma con un comodín. */
export const CLASS_OUTBOX = 'OutboxStoreCheckTest';
export const CLASS_IDEMPOTENCY = 'IdempotencyStoreCheckTest';
export const CLASS_RECONCILIATION = 'ReconciliationStoreCheckTest';
export const TEST_GLOB = '*StoreCheckTest';

// Los parámetros con los que corre la suite. Van FIJOS y bajos a propósito: el lote acotado y el
// presupuesto de reintentos son parte de lo que se mide, y con los valores de producción (100 y
// 10) haría falta sembrar cien filas y fallar diez veces para ver la cota.
export const BATCH_SIZE = 3;
export const MAX_ATTEMPTS = 3;
// El lease. Largo para el caso que afirma que EXCLUYE, y se pisa con 0 en el que afirma que
// CADUCA: son las dos mitades de la misma promesa y no se pueden medir con el mismo valor.
export const CLAIM_TIMEOUT_MS = 600000;

/**
 * Qué hay que medir en ESTE diseño.
 *
 * Los predicados son los MISMOS que deciden si el generador emite cada pieza. Preguntar por otra
 * cosa —que el fichero exista, que la capa esté declarada— se separa del generador en cuanto uno
 * de los dos cambie, y entonces el check dejaría de medir en silencio lo que dice medir.
 */
export function storeSubjects(model) {
  const scope = idempotentOperations(model)[0]?.name ?? null;
  const subscription = model.subscriptions?.[0] ?? null;
  return {
    document: model.persistenceKind === 'document',
    outbox: usesOutbox(model),
    // El almacén de claves de petición. `declaresIdempotency` deja fuera las operaciones cuya
    // guarda es la clave natural del agregado: ahí no hay almacén que medir porque no se genera.
    commandIdempotency: declaresIdempotency(model),
    dedupe: usesIdempotency(model),
    // El reclamo del barrido de reconciliación, con el MISMO predicado que decide si build lo
    // genera: `reconciliationClaims` devuelve solo los que pudo generar sin inventar nada. Se
    // toma el primero — un diseño con varios tiene la misma mecánica en todos.
    reconciliation: reconciliationClaims(model)[0] ?? null,
    // El `scope` con el que el handler agrupa sus claves. No lo escribe build —la llamada la pone
    // el agente— pero el vocabulario sí es del diseño, y usar el nombre real de la operación hace
    // que la medición pase por las mismas longitudes de columna que la producción.
    scope: scope ?? 'store-check',
    // Lo mismo para el handler que deduplica: el listener que build sí emite, o el nombre del
    // evento suscrito. Es el vocabulario con el que el agente escribirá la llamada.
    handlerId: subscription?.listenerClass ?? subscription?.name ?? 'store-check-handler'
  };
}

/** ¿Hay algo que ejercitar en este diseño? */
export function hasSubjects(subjects) {
  return Boolean(subjects.outbox || subjects.commandIdempotency || subjects.dedupe || subjects.reconciliation);
}

/**
 * Las clases a escribir, cada una con el paquete donde tiene que caer.
 *
 * `packages` lo resuelve el runner LEYENDO el árbol generado, no suponiéndolo: si el scaffold
 * reorganiza el layout, el runner lo sigue en vez de escribir un import que no existe.
 */
export function storeTestClasses(model, subjects, options) {
  const clases = [];
  if (subjects.outbox) {
    clases.push({
      className: CLASS_OUTBOX,
      package: options.packages.outbox,
      content: subjects.document
        ? documentOutboxClass(model, options)
        : relationalOutboxClass(model, options)
    });
  }
  if (subjects.commandIdempotency || subjects.dedupe) {
    clases.push({
      className: CLASS_IDEMPOTENCY,
      package: options.packages.dedupe,
      content: subjects.document
        ? documentIdempotencyClass(model, subjects, options)
        : relationalIdempotencyClass(model, subjects, options)
    });
  }
  if (subjects.reconciliation) {
    clases.push({
      className: CLASS_RECONCILIATION,
      package: options.packages.reconciliation,
      content: subjects.document
        ? documentReconciliationClass(model, subjects, options)
        : relationalReconciliationClass(model, subjects, options)
    });
  }
  return clases;
}

// ─── Preámbulo común ─────────────────────────────────────────────────────────

const javaString = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

function file(pkg, imports, body) {
  const estatico = (x) => (x.startsWith('static ') ? 1 : 0);
  const ordenados = [...new Set(imports)].sort(
    (a, b) => estatico(a) - estatico(b) || a.localeCompare(b)
  );
  return `package ${pkg};\n\n${ordenados.map((i) => `import ${i};`).join('\n')}\n\n${body}\n`;
}

const CABECERA = `/**
 * El relay del outbox y los almacenes de idempotencia, ejercitados contra el motor real que
 * levanta infra/.
 *
 * <p>Lo escribe scripts/store-check.js desde src/lib/store-probes.js: no es parte del proyecto
 * generado y no se versiona con él.
 */`;

/** La aserción que hace fallable todo lo demás en la rama documental. */
function midiendoElContenedor(model) {
  return `
    @Test
    void seMideLaBaseDelContenedorYNoUnMongodEmbebido() {
        // El perfil \`test\` trae flapdoodle (mongod embebido y STANDALONE). Sin apagarlo, esta
        // suite entera mediría una base en memoria y saldría en verde sin haber tocado el
        // contenedor — el gemelo exacto del @AutoConfigureTestDatabase(Replace.NONE) de la rama
        // relacional. Esto es lo único que hace fallable esa decisión.
        assertEquals("${model.service.name.replaceAll('-', '_')}", mongo.getDb().getName(),
                "la suite está hablando con otra base: el mongod embebido del perfil test");
        assertNotNull(mongo.getDb().runCommand(new org.bson.Document("hello", 1)).getString("setName"),
                "el servidor no es miembro de un replica set: es el embebido, no el de infra/");
    }
`;
}

// ─── Outbox, rama relacional ─────────────────────────────────────────────────

function relationalOutboxClass(model, { datasource, packages }) {
  const { entity: entityClass, repository: repoClass } = outboxNames(model);
  const properties = [
    `"spring.datasource.url=${datasource.url}"`,
    `"spring.datasource.username=${datasource.username}"`,
    `"spring.datasource.password=${datasource.password ?? ''}"`,
    '"spring.jpa.hibernate.ddl-auto=create-drop"',
    '"spring.flyway.enabled=false"'
  ];

  const body = `${CABECERA}
@DataJpaTest(properties = {
        ${properties.join(',\n        ')}
})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Import(OutboxRelayStore.class)
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class ${CLASS_OUTBOX} {

    private static final int LOTE = ${BATCH_SIZE};
    private static final int MAX_INTENTOS = ${MAX_ATTEMPTS};
    private static final long LEASE_MS = ${CLAIM_TIMEOUT_MS}L;

    @Autowired
    private ${repoClass} outbox;

    @Autowired
    private OutboxRelayStore store;

    private TransactionTemplate tx;

    @Autowired
    void transacciones(PlatformTransactionManager manager) {
        this.tx = new TransactionTemplate(manager);
    }

    @BeforeEach
    void limpia() {
        outbox.deleteAllInBatch();
    }

    /**
     * Los candidatos, leídos como los lee el relay.
     *
     * <p>La consulta toma un LOCK PESIMISTA —es lo que reparte los candidatos entre réplicas— y
     * un lock exige transacción. En producción la abre {@code claimBatch}; aquí, donde se mira la
     * consulta a solas, la abre el test. Sin ella el motor la rechaza y el rojo habla de la
     * transacción que falta, no del predicado, que es lo único que estos casos quieren medir.
     */
    private List<${entityClass}> pendientes() {
        return tx.execute(status -> outbox.findPending(MAX_INTENTOS, Instant.now(), PageRequest.of(0, LOTE)));
    }

    /** Una fila del outbox con el desenlace que pide el caso. */
    private UUID fila(Instant creada, Instant publicada, int intentos, Instant proximoIntento) {
        ${entityClass} row = new ${entityClass}(
                UUID.randomUUID(), "destino", "clave", "TipoDeEvento", "{}",
                creada, publicada, intentos, null, proximoIntento);
        return outbox.saveAndFlush(row).getId();
    }

    private UUID pendiente() {
        return fila(Instant.now(), null, 0, null);
    }

    @Test
    void elPendienteDejaFueraLoPublicadoYLoQueAgotoIntentos() {
        UUID viva = pendiente();
        fila(Instant.now(), Instant.now(), 1, null);
        fila(Instant.now(), null, MAX_INTENTOS, null);

        var pendientes = pendientes();

        // Un predicado que no discrimine no falla: republica lo ya entregado, o vuelve a intentar
        // sin fin lo que ya se rindió. Las dos cosas son silenciosas.
        assertEquals(1, pendientes.size(), "findPending no discrimina entre pendiente, publicado y rendido");
        assertEquals(viva, pendientes.get(0).getId(), "devolvió una fila que no era la pendiente");
    }

    @Test
    void elPendienteRespetaElBackoff() {
        // La mitad que nadie miraba: \`nextAttemptAt is null or nextAttemptAt <= :now\`. Con el
        // operador al revés, el relay reintenta justo lo que acaba de aplazar y no toca nunca lo
        // elegible — y sigue siendo un JPQL perfectamente válido para javac y para Hibernate.
        UUID yaVencido = fila(Instant.now(), null, 1, Instant.now().minusSeconds(60));
        fila(Instant.now(), null, 1, Instant.now().plusSeconds(3600));

        var pendientes = pendientes();

        assertEquals(1, pendientes.size(), "findPending no respeta el backoff");
        assertEquals(yaVencido, pendientes.get(0).getId(), "se llevó la fila cuyo backoff no ha vencido");
    }

    @Test
    void elLoteVaAcotadoYEmpiezaPorLaMasAntigua() {
        Instant base = Instant.now().minusSeconds(3600);
        UUID primera = fila(base, null, 0, null);
        for (int i = 1; i <= LOTE + 2; i++) {
            fila(base.plusSeconds(i), null, 0, null);
        }

        var pendientes = pendientes();

        assertEquals(LOTE, pendientes.size(), "el lote no va acotado: una pasada con miles de filas las publica todas");
        // Sin ORDER BY el motor devuelve las filas como le conviene, y «en orden de llegada»
        // —que es lo que el relay promete a quien consume— deja de cumplirse sin que nada falle.
        assertEquals(primera, pendientes.get(0).getId(), "el lote no empieza por la más antigua");
    }

    @Test
    void reclamarEstampaElLeaseYExcluyeAlSegundoReclamo() {
        // La exclusión mutua entre réplicas, entera. El SKIP LOCKED solo dura la transacción del
        // reclamo, que termina ANTES de la publicación: lo que retira la fila mientras el despacho
        // viaja por la red es el lease sobre next_attempt_at. Sin él, la segunda réplica —o esta
        // misma en la pasada siguiente— vuelve a encontrarla elegible y el evento sale dos veces.
        UUID id = pendiente();

        var primera = store.claimBatch(MAX_INTENTOS, LOTE, LEASE_MS);
        var segunda = store.claimBatch(MAX_INTENTOS, LOTE, LEASE_MS);

        assertEquals(1, primera.size(), "el primer reclamo no se llevó la fila pendiente");
        assertEquals(id, primera.get(0).id(), "reclamó otra fila");
        assertTrue(segunda.isEmpty(), "el segundo reclamo se llevó la misma fila: el lease no la retiró");
    }

    @Test
    void yEseLeaseCADUCA() {
        // La otra mitad. Un lock de base de datos se suelta al morir la conexión; una marca en una
        // fila no. Sin caducidad, la réplica que muera entre el reclamo y la entrega retiene el
        // evento para siempre — y ese evento es justo el que el outbox prometió no perder.
        pendiente();

        store.claimBatch(MAX_INTENTOS, LOTE, 0L);
        var despues = store.claimBatch(MAX_INTENTOS, LOTE, 0L);

        assertEquals(1, despues.size(), "con el lease ya vencido la fila no volvió a ser elegible");
    }

    @Test
    void marcarPublicadaLaSacaDelPendienteParaSiempre() {
        UUID id = pendiente();

        store.markPublished(id);

        assertTrue(pendientes().isEmpty(),
                "una fila publicada sigue saliendo por findPending: se republicaría en cada pasada");
        assertNotNull(outbox.findById(id).orElseThrow().getPublishedAt(),
                "no quedó estampada la fecha de publicación");
    }

    @Test
    void fallarCuentaElIntentoYSeRINDEAlAgotarlos() {
        UUID id = pendiente();

        for (int intento = 1; intento < MAX_INTENTOS; intento++) {
            var parcial = store.markFailed(id, "boom", MAX_INTENTOS, 1L, 10L);
            assertEquals(intento, parcial.attempts(), "el contador de intentos no avanza");
            assertFalse(parcial.deadLettered(), "se rindió antes de agotar el presupuesto");
        }
        var ultimo = store.markFailed(id, "boom", MAX_INTENTOS, 1L, 10L);

        assertTrue(ultimo.deadLettered(), "agotó el presupuesto y no se declaró rendida");
        // El conteo de rendidas es la señal de la única promesa del mecanismo —«ningún evento se
        // pierde»— justo cuando deja de cumplirse. Antes de existir, lo único que ocurría era una
        // línea de log, y una línea de log no dispara nada.
        assertEquals(1L, outbox.countDeadLettered(MAX_INTENTOS), "el conteo de rendidas no la ve");
    }

    @Test
    void yEseConteoDiscrimina() {
        pendiente();
        fila(Instant.now(), Instant.now(), MAX_INTENTOS, null);

        // Ni lo pendiente con presupuesto ni lo ya publicado. Un conteo que los sumara dispararía
        // la alerta con el mecanismo sano, y la alerta que suena siempre se apaga.
        assertEquals(0L, outbox.countDeadLettered(MAX_INTENTOS),
                "el conteo de rendidas cuenta lo que no se rindió");
    }

    @Test
    void laPurgaSeLlevaLoPublicadoViejoYNADAMas() {
        // El cron diario. Su predicado tiene DOS mitades y la segunda es la que importa: sin el
        // "publishedAt is not null", la purga se lleva por delante eventos PENDIENTES. Eso es
        // pérdida de datos en el mecanismo cuya única promesa es que no se pierde nada, y ocurre
        // sin excepción, sin log y sin métrica — el servicio sigue respondiendo 2xx y los eventos
        // simplemente no llegan nunca.
        Instant viejo = Instant.now().minusSeconds(86400);
        Instant corte = Instant.now().minusSeconds(3600);
        fila(viejo, viejo, 0, null);                       // publicada y vieja: se va
        UUID pendienteVieja = fila(viejo, null, 0, null);  // PENDIENTE y vieja: se queda
        UUID publicadaReciente = fila(Instant.now(), Instant.now(), 0, null);

        int borradas = tx.execute(status -> outbox.deletePublishedBefore(corte));

        assertEquals(1, borradas, "la purga no se llevó exactamente la fila publicada y vieja");
        assertTrue(outbox.findById(pendienteVieja).isPresent(),
                "la purga borró un evento PENDIENTE: eso es pérdida de datos, y silenciosa");
        assertTrue(outbox.findById(publicadaReciente).isPresent(),
                "la purga se llevó una fila publicada dentro de la ventana de retención");
    }
}`;

  return file(
    packages.outbox,
    [
      'java.time.Instant',
      'java.util.List',
      'java.util.UUID',
      'org.junit.jupiter.api.BeforeEach',
      'org.junit.jupiter.api.Test',
      'org.springframework.beans.factory.annotation.Autowired',
      'org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase',
      'org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest',
      'org.springframework.context.annotation.Import',
      'org.springframework.data.domain.PageRequest',
      'org.springframework.transaction.PlatformTransactionManager',
      'org.springframework.transaction.annotation.Propagation',
      'org.springframework.transaction.annotation.Transactional',
      'org.springframework.transaction.support.TransactionTemplate',
      'static org.junit.jupiter.api.Assertions.assertEquals',
      'static org.junit.jupiter.api.Assertions.assertFalse',
      'static org.junit.jupiter.api.Assertions.assertNotNull',
      'static org.junit.jupiter.api.Assertions.assertTrue'
    ],
    body
  );
}

// ─── Outbox, rama documental ─────────────────────────────────────────────────

function documentOutboxClass(model, { datasource, packages }) {
  const { entity: entityClass, repository: repoClass } = outboxNames(model);
  const properties = [
    `"spring.data.mongodb.uri=${datasource.uri}"`,
    '"spring.profiles.active="',
    `"outbox.relay.batch-size=${BATCH_SIZE}"`,
    `"outbox.relay.max-attempts=${MAX_ATTEMPTS}"`,
    `"outbox.relay.claim-timeout-ms=${CLAIM_TIMEOUT_MS}"`
  ];

  const body = `${CABECERA}
@DataMongoTest(properties = {
        ${properties.join(',\n        ')}
})
@ImportAutoConfiguration(exclude = EmbeddedMongoAutoConfiguration.class)
@Import({OutboxRelay.class, ${CLASS_OUTBOX}.Dobles.class})
class ${CLASS_OUTBOX} {

    private static final int LOTE = ${BATCH_SIZE};
    private static final int MAX_INTENTOS = ${MAX_ATTEMPTS};

    /**
     * Lo que el relay necesita del contexto y {@code @DataMongoTest} no trae.
     *
     * <p>El dispatcher no se llega a usar: lo que se mide es {@code claimPending()}, que aquí es
     * el reclamo ENTERO. Publicar es I/O de red y no cabe en una aserción, así que el doble
     * revienta a propósito — si alguna vez se invocara, el caso tiene que caer.
     */
    @TestConfiguration
    static class Dobles {
        @Bean
        OutboxDispatcher dispatcher() {
            return (destination, routingKey, eventType, payload) -> {
                throw new UnsupportedOperationException("store-check mide el reclamo, no la publicación");
            };
        }

        @Bean
        MeterRegistry meterRegistry() {
            return new SimpleMeterRegistry();
        }
    }

    @Autowired
    private MongoTemplate mongo;

    @Autowired
    private ${repoClass} outbox;

    @Autowired
    private OutboxRelay relay;

    @Autowired
    private MeterRegistry metricas;

    @BeforeEach
    void limpia() {
        mongo.remove(new Query(), ${entityClass}.class);
    }

    /** Un documento del outbox con el desenlace que pide el caso. */
    private UUID fila(Instant creada, Instant publicada, int intentos, Instant proximoIntento) {
        ${entityClass} row = new ${entityClass}(
                UUID.randomUUID(), "destino", "clave", "TipoDeEvento", "{}",
                creada, publicada, intentos, null, proximoIntento);
        return mongo.save(row).getId();
    }

    private UUID pendiente() {
        return fila(Instant.now(), null, 0, null);
    }
${midiendoElContenedor(model)}
    @Test
    void elReclamoDejaFueraLoPublicadoYLoQueAgotoIntentos() {
        UUID viva = pendiente();
        fila(Instant.now(), Instant.now(), 1, null);
        fila(Instant.now(), null, MAX_INTENTOS, null);

        var reclamadas = relay.claimPending();

        // El Criteria es el gemelo silencioso del JPQL: si no casa, findAndModify devuelve null,
        // el bucle corta en la primera vuelta y el relay se comporta como si el outbox estuviera
        // vacío. Nadie se entera — no hay excepción, no hay log, no hay métrica.
        assertEquals(1, reclamadas.size(), "el reclamo no discrimina entre pendiente, publicado y rendido");
        assertEquals(viva, reclamadas.get(0).getId(), "reclamó un documento que no era el pendiente");
    }

    @Test
    void elReclamoRespetaElBackoff() {
        UUID yaVencido = fila(Instant.now(), null, 1, Instant.now().minusSeconds(60));
        fila(Instant.now(), null, 1, Instant.now().plusSeconds(3600));

        var reclamadas = relay.claimPending();

        assertEquals(1, reclamadas.size(), "el reclamo no respeta el backoff");
        assertEquals(yaVencido, reclamadas.get(0).getId(), "se llevó el documento cuyo backoff no ha vencido");
    }

    @Test
    void elLoteVaAcotadoYEmpiezaPorElMasAntiguo() {
        Instant base = Instant.now().minusSeconds(3600);
        UUID primero = fila(base, null, 0, null);
        for (int i = 1; i <= LOTE + 2; i++) {
            fila(base.plusSeconds(i), null, 0, null);
        }

        var reclamadas = relay.claimPending();

        assertEquals(LOTE, reclamadas.size(), "el bucle de findAndModify no acota el lote");
        // findAndModify SIN orden devuelve lo que le convenga: aquí el orden hay que pedirlo, y
        // sin él «en orden de llegada» deja de cumplirse sin que nada falle.
        assertEquals(primero, reclamadas.get(0).getId(), "el lote no empieza por el más antiguo");
    }

    @Test
    void reclamarEstampaLaMarcaYExcluyeAlSegundoReclamo() {
        // Aquí el findAndModify ES el reclamo entero —no hay un SELECT de candidatos delante que
        // ya filtre—, así que llamar dos veces mide la exclusión mutua de verdad: sin el criterio
        // sobre claimed_at las dos llamadas se llevan el mismo documento, y dos réplicas publican
        // el mismo evento.
        UUID id = pendiente();

        var primera = relay.claimPending();
        var segunda = relay.claimPending();

        assertEquals(1, primera.size(), "el primer reclamo no se llevó el documento pendiente");
        assertEquals(id, primera.get(0).getId(), "reclamó otro documento");
        assertTrue(segunda.isEmpty(), "el segundo reclamo se llevó el mismo documento: claimed_at no lo retiró");
        assertNotNull(mongo.findById(id, ${entityClass}.class).getClaimedAt(),
                "el reclamo no estampó claimed_at: nada retira el documento mientras dura la entrega");
    }

    @Test
    void yEsaMarcaCADUCA() {
        // Mismo razonamiento que el lease de la rama relacional, y aquí hace MÁS falta: en JPA el
        // lock se suelta solo al morir la conexión, pero un claimed_at no se suelta nunca.
        pendiente();
        relay.claimPending();

        // Se envejece la marca en vez de esperar el plazo: el umbral es global y bajarlo se
        // llevaría por delante los demás casos.
        mongo.updateFirst(new Query(), new Update().set("claimed_at", Instant.EPOCH), ${entityClass}.class);
        var despues = relay.claimPending();

        assertEquals(1, despues.size(), "con la marca ya rancia el documento no volvió a ser elegible");
    }

    @Test
    void elGaugeDeRendidasCuentaLoRendidoYSOLOEso() {
        fila(Instant.now(), null, MAX_INTENTOS, null);
        pendiente();
        fila(Instant.now(), Instant.now(), MAX_INTENTOS, null);

        // Se lee por el gauge y no por una consulta propia: así se ejercita también el cableado
        // que lo publica, que es la mitad por la que la señal llega o no llega a quien alerta.
        double rendidas = metricas.get("keel.outbox.dead_lettered").gauge().value();

        // Ni lo pendiente con presupuesto ni lo ya publicado. Un gauge que los sumara suena con el
        // mecanismo sano, y la alerta que suena siempre se apaga.
        assertEquals(1.0d, rendidas, "el gauge de rendidas no cuenta exactamente lo que se rindió");
    }

    @Test
    void laPurgaSeLlevaLoPublicadoViejoYNADAMas() {
        // Mismo caso que en la rama relacional, y se mide igual aunque aquí el predicado no lo
        // escriba nadie: lo que se juzga es el EFECTO. Una purga que se llevara lo pendiente es
        // pérdida de datos en el mecanismo cuya única promesa es que no se pierde nada, y ocurre
        // sin excepción, sin log y sin métrica.
        Instant viejo = Instant.now().minusSeconds(86400);
        Instant corte = Instant.now().minusSeconds(3600);
        fila(viejo, viejo, 0, null);                       // publicado y viejo: se va
        UUID pendienteViejo = fila(viejo, null, 0, null);  // PENDIENTE y viejo: se queda
        UUID publicadoReciente = fila(Instant.now(), Instant.now(), 0, null);

        long borrados = outbox.deletePublishedBefore(corte);

        assertEquals(1L, borrados, "la purga no se llevó exactamente el documento publicado y viejo");
        assertTrue(outbox.findById(pendienteViejo).isPresent(),
                "la purga borró un evento PENDIENTE: eso es pérdida de datos, y silenciosa");
        assertTrue(outbox.findById(publicadoReciente).isPresent(),
                "la purga se llevó un documento publicado dentro de la ventana de retención");
    }
}`;

  return file(
    packages.outbox,
    [
      'de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration',
      'io.micrometer.core.instrument.MeterRegistry',
      'io.micrometer.core.instrument.simple.SimpleMeterRegistry',
      'java.time.Instant',
      'java.util.UUID',
      'org.junit.jupiter.api.BeforeEach',
      'org.junit.jupiter.api.Test',
      'org.springframework.beans.factory.annotation.Autowired',
      'org.springframework.boot.autoconfigure.ImportAutoConfiguration',
      'org.springframework.boot.test.autoconfigure.data.mongo.DataMongoTest',
      'org.springframework.boot.test.context.TestConfiguration',
      'org.springframework.context.annotation.Bean',
      'org.springframework.context.annotation.Import',
      'org.springframework.data.mongodb.core.MongoTemplate',
      'org.springframework.data.mongodb.core.query.Query',
      'org.springframework.data.mongodb.core.query.Update',
      'static org.junit.jupiter.api.Assertions.assertEquals',
      'static org.junit.jupiter.api.Assertions.assertNotNull',
      'static org.junit.jupiter.api.Assertions.assertTrue'
    ],
    body
  );
}

// ─── Idempotencia, rama relacional ───────────────────────────────────────────

function relationalIdempotencyClass(model, subjects, { datasource, packages }) {
  const { entity: processedClass, repository: processedRepo } = processedEventNames(model);
  const properties = [
    `"spring.datasource.url=${datasource.url}"`,
    `"spring.datasource.username=${datasource.username}"`,
    `"spring.datasource.password=${datasource.password ?? ''}"`,
    '"spring.jpa.hibernate.ddl-auto=create-drop"',
    '"spring.flyway.enabled=false"'
  ];

  const importados = [
    ...(subjects.dedupe ? ['IdempotencyGuard.class', 'ProcessedEventWriter.class'] : []),
    ...(subjects.commandIdempotency ? ['JpaIdempotencyStore.class'] : [])
  ];

  const body = `${CABECERA}
@DataJpaTest(properties = {
        ${properties.join(',\n        ')}
})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Import({${importados.join(', ')}})
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class ${CLASS_IDEMPOTENCY} {

    private static final String SCOPE = ${javaString(subjects.scope)};
    private static final String HANDLER = ${javaString(subjects.handlerId)};

    private TransactionTemplate tx;

    @Autowired
    void transacciones(PlatformTransactionManager manager) {
        this.tx = new TransactionTemplate(manager);
    }
${commandMembers(subjects)}${dedupeMembers(subjects, processedRepo)}${
    subjects.commandIdempotency ? commandTests('La clave primaria de la tabla') : ''
  }${subjects.dedupe ? dedupeTests(processedClass, processedRepo, true) : ''}
}`;

  return file(
    packages.dedupe,
    [
      ...(subjects.commandIdempotency
        ? [
            `${packages.commandStore}.JpaIdempotencyStore`,
            `${packages.storePort}.IdempotencyStore`,
            `${packages.conflict}.IdempotencyConflictException`
          ]
        : []),
      'java.time.Instant',
      'java.util.UUID',
      'org.junit.jupiter.api.BeforeEach',
      'org.junit.jupiter.api.Test',
      'org.springframework.beans.factory.annotation.Autowired',
      'org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase',
      'org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest',
      'org.springframework.context.annotation.Import',
      'org.springframework.transaction.PlatformTransactionManager',
      'org.springframework.transaction.annotation.Propagation',
      'org.springframework.transaction.annotation.Transactional',
      'org.springframework.transaction.support.TransactionTemplate',
      'static org.junit.jupiter.api.Assertions.assertEquals',
      'static org.junit.jupiter.api.Assertions.assertFalse',
      'static org.junit.jupiter.api.Assertions.assertThrows',
      'static org.junit.jupiter.api.Assertions.assertTrue'
    ],
    body
  );
}

// ─── Idempotencia, rama documental ───────────────────────────────────────────

function documentIdempotencyClass(model, subjects, { datasource, packages }) {
  const { entity: processedClass, repository: processedRepo } = processedEventNames(model);
  const properties = [`"spring.data.mongodb.uri=${datasource.uri}"`, '"spring.profiles.active="'];

  const importados = [
    ...(subjects.dedupe ? ['IdempotencyGuard.class', 'ProcessedEventWriter.class'] : []),
    ...(subjects.commandIdempotency ? ['MongoIdempotencyStore.class'] : []),
    // Los almacenes documentales confirman con @Transactional, y @DataMongoTest no trae ningún
    // gestor de transacciones. Se importa el bean REAL del proyecto —perfil `!test`, que es el
    // que corre aquí—, así que la escritura pasa por la misma sesión transaccional que en
    // producción y exige el replica set que levanta infra/.
    'MongoTransactionConfig.class'
  ];

  const body = `${CABECERA}
@DataMongoTest(properties = {
        ${properties.join(',\n        ')}
})
@ImportAutoConfiguration(exclude = EmbeddedMongoAutoConfiguration.class)
@Import({${importados.join(', ')}})
class ${CLASS_IDEMPOTENCY} {

    private static final String SCOPE = ${javaString(subjects.scope)};
    private static final String HANDLER = ${javaString(subjects.handlerId)};

    @Autowired
    private MongoTemplate mongo;
${commandMembers(subjects)}${dedupeMembers(subjects, processedRepo)}${midiendoElContenedor(model)}${
    subjects.commandIdempotency ? commandTests('El _id de la colección') : ''
  }${subjects.dedupe ? dedupeTests(processedClass, processedRepo, false) : ''}
}`;

  return file(
    packages.dedupe,
    [
      ...(subjects.commandIdempotency
        ? [
            `${packages.commandStore}.MongoIdempotencyStore`,
            `${packages.storePort}.IdempotencyStore`,
            `${packages.conflict}.IdempotencyConflictException`
          ]
        : []),
      `${packages.mongoTx}.MongoTransactionConfig`,
      'de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration',
      'java.time.Instant',
      'java.util.UUID',
      'org.junit.jupiter.api.BeforeEach',
      'org.junit.jupiter.api.Test',
      'org.springframework.beans.factory.annotation.Autowired',
      'org.springframework.boot.autoconfigure.ImportAutoConfiguration',
      'org.springframework.boot.test.autoconfigure.data.mongo.DataMongoTest',
      'org.springframework.context.annotation.Import',
      'org.springframework.data.mongodb.core.MongoTemplate',
      'static org.junit.jupiter.api.Assertions.assertEquals',
      'static org.junit.jupiter.api.Assertions.assertFalse',
      'static org.junit.jupiter.api.Assertions.assertNotNull',
      'static org.junit.jupiter.api.Assertions.assertThrows',
      'static org.junit.jupiter.api.Assertions.assertTrue'
    ],
    body
  );
}

// ─── Piezas compartidas por las dos ramas ────────────────────────────────────

function commandMembers(subjects) {
  if (!subjects.commandIdempotency) return '';
  return `
    @Autowired
    private IdempotencyStore claves;
`;
}

function dedupeMembers(subjects, processedRepo) {
  if (!subjects.dedupe) return '';
  return `
    @Autowired
    private IdempotencyGuard guarda;

    @Autowired
    private ${processedRepo} procesados;

    @BeforeEach
    void limpiaProcesados() {
        procesados.deleteAll();
    }
`;
}

/**
 * Los casos del almacén de claves de petición.
 *
 * Idénticos en las dos ramas salvo el árbitro de la carrera —la clave primaria de la tabla o el
 * `_id` de la colección—, que es justo lo único que este check puede juzgar y que ninguna otra
 * red mira.
 */
function commandTests(arbitro) {
  return `
    @Test
    void unaClaveNuevaNoTieneRegistroYTrasGuardarlaSeLee() {
        String clave = UUID.randomUUID().toString();

        assertTrue(claves.find(SCOPE, clave).isEmpty(), "una clave sin usar devuelve registro");
        claves.save(SCOPE, clave, "firma-1", "recurso-1", 3600L);

        var guardado = claves.find(SCOPE, clave).orElseThrow();
        assertEquals("firma-1", guardado.signature(), "no se recupera la firma con la que se guardó");
        // Sin el resourceId la repetición no puede reconstruir la respuesta de la primera, que es
        // el contrato entero: no rechazar el reintento, reproducirlo.
        assertEquals("recurso-1", guardado.resourceId(), "no se recupera el id del recurso creado");
    }

    @Test
    void laMismaClaveDosVecesPIERDELaCarrera() {
        // ${arbitro} es el árbitro, y esto es lo único que lo comprueba. La traducción de la
        // violación a IdempotencyConflictException es lo que cambia de motor a motor: sin ella la
        // carrera acaba en 500 en vez de en el code que el diseño declara, y solo en el caso
        // concurrente — el que menos se reproduce a mano.
        String clave = UUID.randomUUID().toString();
        claves.save(SCOPE, clave, "firma-1", "recurso-1", 3600L);

        assertThrows(IdempotencyConflictException.class,
                () -> claves.save(SCOPE, clave, "firma-1", "recurso-1", 3600L),
                "un segundo registro con la misma clave pasó: dos ejecuciones del mismo comando");
    }

    @Test
    void otroScopeConLaMismaClaveNoColisiona() {
        // El scope es la mitad de la clave. Sin él, la misma cabecera Idempotency-Key en dos
        // operaciones distintas haría que la segunda se tomara por una repetición de la primera —
        // y devolvería el recurso equivocado, sin error.
        String clave = UUID.randomUUID().toString();
        claves.save(SCOPE, clave, "firma-1", "recurso-1", 3600L);
        claves.save(SCOPE + "-otra", clave, "firma-2", "recurso-2", 3600L);

        assertEquals("recurso-2", claves.find(SCOPE + "-otra", clave).orElseThrow().resourceId(),
                "el scope no participa en la clave");
    }

    @Test
    void unaClaveCADUCADAEsComoSiNoEstuviera() {
        // La ventana la fija el ttlSeconds del diseño, no la cadencia de la purga. Sin esto, una
        // clave queda inutilizable entre su caducidad y el cron: find la ignora, el handler
        // ejecuta, y la inserción choca contra una fila que ya no protege nada.
        String clave = UUID.randomUUID().toString();
        claves.save(SCOPE, clave, "firma-1", "recurso-1", 0L);

        assertTrue(claves.find(SCOPE, clave).isEmpty(), "una clave caducada sigue devolviendo registro");
        claves.save(SCOPE, clave, "firma-2", "recurso-2", 3600L);
        assertEquals("recurso-2", claves.find(SCOPE, clave).orElseThrow().resourceId(),
                "reutilizar una clave caducada choca contra la fila muerta");
    }`;
}

/**
 * Los casos de la deduplicación de consumo.
 *
 * El que no falla en ninguna otra parte es el del `handlerId`: una clave compuesta a la que le
 * falte esa mitad no rompe nada visible — deduplica de MÁS, y el segundo handler descarta en
 * silencio un mensaje que nunca llegó a procesar.
 */
function dedupeTests(processedClass, processedRepo, relational) {
  const arbitro = relational ? 'la clave primaria' : 'la unicidad del _id';
  const sembrarViejo = relational
    ? `        procesados.save(new ${processedClass}(
                new ${processedClass}.ProcessedEventId(HANDLER, viejo), Instant.now().minusSeconds(86400)));`
    : `        mongo.save(new ${processedClass}(
                new ${processedClass}.ProcessedEventId(HANDLER, viejo), Instant.now().minusSeconds(86400)));`;
  const purga = relational ? 'deleteProcessedBefore' : 'deleteByProcessedAtBefore';

  return `
    @Test
    void registrarUnEventoLoDejaVistoParaSiempre() {
        String evento = UUID.randomUUID().toString();

        assertFalse(guarda.alreadyProcessed(HANDLER, evento), "un evento nuevo ya figuraba como procesado");
        assertTrue(guarda.record(HANDLER, evento), "el primer registro no lo reclamó");
        assertTrue(guarda.alreadyProcessed(HANDLER, evento),
                "tras registrarlo sigue sin figurar: cada reentrega se procesaría otra vez");
    }

    @Test
    void laSegundaEntregaDelMismoEventoNOSeReclama() {
        // La ventana del duplicado, cerrada por la base y no por una consulta previa: dos entregas
        // simultáneas del mismo mensaje llegan las dos a este punto, y quien arbitra es ${arbitro}.
        String evento = UUID.randomUUID().toString();

        assertTrue(guarda.tryRecord(HANDLER, evento), "la primera entrega no se reclamó");
        assertFalse(guarda.tryRecord(HANDLER, evento),
                "la segunda entrega también se reclamó: el mensaje se procesa dos veces");
    }

    @Test
    void dosHandlersConElMISMOEventoNoSePisan() {
        // La clave es (handler, evento). Sin la primera mitad, el segundo consumidor del mismo
        // evento lo daría por procesado sin haberlo visto — y no falla nada: descarta en silencio.
        String evento = UUID.randomUUID().toString();

        assertTrue(guarda.record(HANDLER, evento), "el primer handler no reclamó el evento");
        assertTrue(guarda.record(HANDLER + "-otro", evento),
                "el segundo handler no pudo reclamar el mismo evento: la clave no lleva el handler");
        assertTrue(guarda.alreadyProcessed(HANDLER + "-otro", evento), "y tampoco quedó registrado");
    }

    @Test
    void laPurgaSeLlevaLoViejoYSOLOLoViejo() {
        // Lo que se ejercita es la consulta de purga, que es otra cadena que nadie ejecuta. Una
        // que se llevara lo reciente reabriría la ventana de deduplicación de los mensajes en
        // vuelo; una que no se llevara nada haría crecer la tabla sin tope.
        String viejo = UUID.randomUUID().toString();
        String reciente = UUID.randomUUID().toString();
        // La vieja se siembra con su fecha, no se registra y luego se reescribe: la entidad
        // fuerza el INSERT (es lo que hace que la carrera la arbitre la clave primaria), así que
        // guardarla dos veces choca contra sí misma. La reciente sí va por el camino de verdad.
${sembrarViejo}
        guarda.record(HANDLER, reciente);

        long borradas = ${
          relational
            ? // La purga es un @Modifying sobre JPQL, y eso exige transacción. En producción la abre
              // el @Transactional de IdempotencyGuard.purge(); aquí, donde se mira la consulta a
              // solas, la abre el test — si no, el rojo habla de la transacción que falta y no del
              // predicado, que es lo único que este caso quiere medir.
              `tx.execute(status -> (long) procesados.${purga}(Instant.now().minusSeconds(3600)))`
            : `procesados.${purga}(Instant.now().minusSeconds(3600))`
        };

        assertEquals(1L, borradas, "la purga no se llevó exactamente la fila vieja");
        assertFalse(guarda.alreadyProcessed(HANDLER, viejo), "la fila vieja sigue ahí");
        assertTrue(guarda.alreadyProcessed(HANDLER, reciente), "la purga se llevó por delante una fila reciente");
    }`;
}

// ─── Reconciliación: el reclamo del barrido ──────────────────────────────────
//
// El tercer mecanismo, y el que llegó sin ninguna red. Sus dos mitades son cadenas que nadie
// ejecutaba: el JPQL de candidatos (`e.<awaitingField> < :staleBefore`) y el UPDATE condicional
// con caducidad (`where c.claimedAt <= :expiredBefore`) — o, en la rama documental, el `Criteria`
// del upsert, que ni siquiera pasa por javac. Si el predicado no casa, el barrido reclama cero
// filas **sin fallar** y no reconcilia nada; si el UPDATE pierde su condición, dos réplicas
// encargan el mismo trabajo al proveedor.
//
// Se mide en DOS niveles y no es redundancia:
//
//   · la TIENDA (`ReconciliationClaimStore.claim`), llamada directamente — es donde vive la
//     exclusión mutua, y la lección de `claim-check` es que a través del adaptador no se ve,
//     porque el SELECT de candidatos ya filtró;
//   · el ADAPTADOR (`<E>Repository.<claim.method>()`), que es el camino de producción y donde
//     se ve si la selección de candidatos casa con algo.
//
// El caso que ATA las dos mitades es el de la segunda pasada: el barrido no mueve el lifecycle,
// así que lo único que impide re-reclamar es la marca. Un adaptador que se llevara los candidatos
// sin preguntarle a la tienda pasaría todos los demás casos y caería en ese.

/** Cuánto silencio se tolera en la suite. Bajo a propósito: la cota es lo que se mide. */
const TOLERANCIA_SEGUNDOS = 60;

/**
 * Los casos de la TIENDA. Mismo texto en las dos ramas: `claim(...)` tiene la misma firma
 * pública en la relacional (UPDATE condicional + INSERT) y en la documental (upsert con
 * criterio), que es justo lo que permite compararlas.
 */
function reconciliationStoreTests(purga) {
  return `
    @Test
    void reclamarUnCandidatoNuevoLoMarca() {
        UUID id = UUID.randomUUID();
        Instant ahora = Instant.now();

        assertTrue(reclamar(ACTIVACION, id, ahora, ahora.minusSeconds(600)),
                "un candidato sin marca previa no se pudo reclamar");
        assertTrue(marcaDe(ACTIVACION, id), "el reclamo devolvió true pero no dejó marca");
    }

    @Test
    void elSegundoReclamoDelMismoCandidatoNOEsSuyo() {
        // La exclusión mutua entera. Aquí NO hay lifecycle que mover —el estado de espera es
        // justo lo que el barrido busca—, así que lo único que impide que dos réplicas se lleven
        // el mismo candidato es esta comparación. Y entre reclamar y actuar va una llamada al
        // proveedor: perder esto no es trabajo repetido, es un encargo duplicado a un tercero.
        UUID id = UUID.randomUUID();
        Instant ahora = Instant.now();
        Instant caducaAntesDe = ahora.minusSeconds(600);

        assertTrue(reclamar(ACTIVACION, id, ahora, caducaAntesDe), "el primer reclamo falló");
        assertFalse(reclamar(ACTIVACION, id, ahora, caducaAntesDe),
                "el segundo reclamo también se lo llevó: dos réplicas encargan el mismo trabajo");
    }

    @Test
    void yEsaMarcaCADUCA() {
        // La otra mitad. Un lock se suelta al morir la conexión; una marca en una fila no. Sin
        // caducidad, la réplica que muera entre el reclamo y el desenlace retiene el candidato
        // para siempre — y ese candidato es justo el que espera un desenlace que no llegó.
        UUID id = UUID.randomUUID();
        Instant ahora = Instant.now();
        reclamar(ACTIVACION, id, ahora, ahora.minusSeconds(600));

        // Se mueve la COTA, no el reloj: esperar el plazo real no cabe en una suite.
        assertTrue(reclamar(ACTIVACION, id, ahora.plusSeconds(1), ahora.plusSeconds(1)),
                "con el reclamo ya caducado el candidato no volvió a ser reclamable");
    }

    @Test
    void dosActivacionesSobreLaMISMAEntidadNoSePisan() {
        // La clave es compuesta (activación + entidad) porque una misma fila puede estar
        // esperando el desenlace de VARIOS encargos. Sin la primera mitad, el segundo barrido
        // encuentra la marca del primero y cede el candidato: no falla nada, simplemente ese
        // encargo no se reconcilia nunca. Es el gemelo del caso del handlerId en la dedupe.
        UUID id = UUID.randomUUID();
        Instant ahora = Instant.now();
        Instant caducaAntesDe = ahora.minusSeconds(600);

        assertTrue(reclamar(ACTIVACION, id, ahora, caducaAntesDe), "el primer encargo no reclamó");
        assertTrue(reclamar(OTRA_ACTIVACION, id, ahora, caducaAntesDe),
                "el segundo encargo no pudo reclamar la misma entidad: la clave no lleva la activación");
    }

    @Test
    void laPurgaSeLlevaLoCaducadoYSOLOEso() {
        // Lo que se ejercita es la consulta de purga, otra cadena que nadie ejecuta. Una que se
        // llevara marcas VIVAS dejaría a dos réplicas llevarse el mismo candidato en esa pasada;
        // una que no se llevara nada haría crecer la tabla sin tope.
        UUID vieja = UUID.randomUUID();
        UUID reciente = UUID.randomUUID();
        Instant ahora = Instant.now();
        reclamar(ACTIVACION, vieja, ahora.minusSeconds(86400), ahora.minusSeconds(90000));
        reclamar(ACTIVACION, reciente, ahora, ahora.minusSeconds(600));

        long borradas = ${purga};

        assertEquals(1L, borradas, "la purga no se llevó exactamente la marca vieja");
        assertFalse(marcaDe(ACTIVACION, vieja), "la marca vieja sigue ahí");
        assertTrue(marcaDe(ACTIVACION, reciente), "la purga se llevó por delante una marca viva");
    }`;
}

/**
 * Los casos del ADAPTADOR. También idénticos en las dos ramas: el método del puerto tiene la
 * misma firma y las aserciones van todas contra la tabla de marcas, nunca contra el objeto de
 * dominio que devuelve — pedirle getters al agregado ataría el check a la API del dominio, que
 * es del diseño y no de este mecanismo.
 */
function reconciliationSweepTests(claim, enumConstant, otroEstado) {
  return `
    @Test
    void elBarridoSoloSeLlevaLoQueLLEVAEsperandoDeMas() {
        UUID viejo = esperandoDesdeHace(TOLERANCIA_S * 10);
        UUID reciente = esperandoDesdeHace(0);

        var reclamadas = adaptador.${claim.method}();

        assertEquals(1, reclamadas.size(), "el barrido no distingue por cuánto lleva esperando");
        assertTrue(marcaDe(ACTIVACION, viejo), "no reclamó el que llevaba esperando de más");
        // La cota. Sin ella el barrido vuelve a encargar el trabajo a los pocos segundos de
        // haberlo encargado, mientras la respuesta del proveedor sigue de camino.
        assertFalse(marcaDe(ACTIVACION, reciente), "se llevó uno que acaba de empezar a esperar");
    }

    @Test
    void ySoloDesdeLosEstadosDeESPERA() {
        UUID esperando = esperandoDesdeHace(TOLERANCIA_S * 10);
        UUID ajeno = fila(${otroEstado}, Instant.now().minusSeconds(TOLERANCIA_S * 10));

        var reclamadas = adaptador.${claim.method}();

        assertEquals(1, reclamadas.size(), "el barrido se llevó una fila que no estaba esperando nada");
        assertTrue(marcaDe(ACTIVACION, esperando));
        assertFalse(marcaDe(ACTIVACION, ajeno), "reconcilió una fila cuyo encargo ya tuvo desenlace");
    }

    @Test
    void elLoteVaAcotadoYEmpiezaPorElQueMasLleva() {
        UUID masViejo = esperandoDesdeHace(TOLERANCIA_S * 100);
        for (int i = 1; i <= LOTE + 2; i++) {
            esperandoDesdeHace(TOLERANCIA_S * 10 + i);
        }

        var reclamadas = adaptador.${claim.method}();

        assertEquals(LOTE, reclamadas.size(), "el lote no va acotado: una pasada con 50.000 atascados son 50.000 llamadas al proveedor");
        // Sin ORDER BY el motor devuelve lo que le convenga, y los que más llevan esperando no
        // entrarían nunca en ningún lote mientras siga entrando trabajo nuevo.
        assertTrue(marcaDe(ACTIVACION, masViejo), "el lote no empieza por el que más lleva esperando");
    }

    @Test
    void unaFilaSINMarcaDeEsperaNoSeBarreNUNCA() {
        // Y aquí eso es CORRECTO, al revés que en el rescate de un barrido: una marca a null
        // significa «este encargo no se ha despachado», no «se perdió el reloj». Se afirma para
        // que la diferencia entre los dos mecanismos quede medida y no supuesta.
        UUID sinMarca = fila(${enumConstant}, null);

        var reclamadas = adaptador.${claim.method}();

        assertTrue(reclamadas.isEmpty(), "barrió una fila que todavía no espera nada");
        assertFalse(marcaDe(ACTIVACION, sinMarca));
    }

    @Test
    void laSegundaPasadaInmediataNoDevuelveNada() {
        // El caso que ATA las dos mitades. El barrido no mueve el lifecycle —el estado de espera
        // sigue siendo el mismo—, así que lo único que impide re-reclamar es la marca. Un
        // adaptador que se llevara los candidatos sin preguntarle a la tienda pasaría todos los
        // casos de arriba y caería aquí, que es justo el defecto que produce el encargo duplicado.
        esperandoDesdeHace(TOLERANCIA_S * 10);

        var primera = adaptador.${claim.method}();
        var segunda = adaptador.${claim.method}();

        assertEquals(1, primera.size(), "la primera pasada no se llevó el candidato");
        assertTrue(segunda.isEmpty(), "la segunda pasada volvió a llevárselo: el barrido no consulta la tienda");
    }`;
}

// ─── Reconciliación, rama relacional ─────────────────────────────────────────

function relationalReconciliationClass(model, subjects, { datasource, packages, database }) {
  const claim = subjects.reconciliation;
  const entity = entidadDe(model, claim);
  const enumType = entity.lifecycle.enumType;
  // El aislamiento con el que se llama al reclamo, y NO es un detalle del check.
  //
  // En producción el store solo se llama desde el método del barrido, que en MySQL y MariaDB abre
  // su transacción con READ_COMMITTED explícito (lib/claim-sql.js). Llamarlo con el aislamiento
  // por DEFECTO —REPEATABLE READ— no falla por rendimiento: **no funciona**. El UPDATE condicional
  // no casa ninguna fila la primera vez, pero bajo REPEATABLE READ InnoDB toma igualmente los
  // GAP LOCKS del rango que escaneó; y entonces el INSERT del writer, que corre en REQUIRES_NEW
  // —o sea, en OTRA conexión—, se queda esperando un hueco que bloquea su propia transacción
  // padre. Muere en `Lock wait timeout exceeded` y `claim()` devuelve false: el barrido no
  // reclama NADA, para siempre y sin decir nada.
  //
  // Medido: con el aislamiento por defecto, cinco de los casos de esta clase caen en MySQL y
  // ninguno en PostgreSQL. Es la prueba de que ese READ_COMMITTED es portante y no una
  // optimización — el javadoc de claim-sql.js lo justificaba solo por los INSERT de la API.
  // El motor entra por opciones y NO por `model.stack`: `buildModel` no lo expone —lo cuelga
  // `scaffoldService` después—, así que leerlo de ahí da `undefined` en silencio y el aislamiento
  // se deja de emitir sin que nada lo diga. Es el mismo camino que ya usa claim-probes.js, y esta
  // vez se vio porque el check se puso rojo; la próxima podría no verse.
  const aislamiento = needsReadCommitted(database)
    ? `
        // READ_COMMITTED, igual que el barrido: con el aislamiento por defecto de este motor el
        // UPDATE que no casa nada toma gap locks, y el INSERT del writer —que va en REQUIRES_NEW,
        // en otra conexión— espera sobre el hueco que bloquea su propia transacción padre. El
        // reclamo muere en lock-wait timeout y devuelve false. Ver lib/claim-sql.js.
        this.tx.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);`
    : '';
  const properties = [
    `"spring.datasource.url=${datasource.url}"`,
    `"spring.datasource.username=${datasource.username}"`,
    `"spring.datasource.password=${datasource.password ?? ''}"`,
    '"spring.jpa.hibernate.ddl-auto=create-drop"',
    '"spring.flyway.enabled=false"',
    ...parametrosDelBarrido(claim)
  ];

  const body = `${CABECERA}
@DataJpaTest(properties = {
        ${properties.join(',\n        ')}
})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Import({ReconciliationClaimStore.class, ReconciliationClaimWriter.class, ${entity.name}RepositoryImpl.class})
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class ${CLASS_RECONCILIATION} {

${constantesDelBarrido(claim)}

    @Autowired
    private ReconciliationClaimStore reclamos;

    @Autowired
    private ReconciliationClaimJpaRepository marcas;

    @Autowired
    private ${entity.name}JpaRepository jpa;

    @Autowired
    private ${entity.name}Repository adaptador;

    private TransactionTemplate tx;

    @Autowired
    void transacciones(PlatformTransactionManager manager) {
        this.tx = new TransactionTemplate(manager);${aislamiento}
    }

    @BeforeEach
    void limpia() {
        jpa.deleteAllInBatch();
        marcas.deleteAllInBatch();
    }

    /** ¿Existe la marca de ese encargo sobre esa fila? Es por donde se afirma todo. */
    private boolean marcaDe(String activacion, UUID id) {
        return marcas.findById(new ReconciliationClaimJpa.ReconciliationClaimId(activacion, id)).isPresent();
    }

    /**
     * El reclamo, con la transacción que necesita.
     *
     * <p>El UPDATE condicional es un {@code @Modifying}, así que exige transacción — y el store no
     * la abre: en producción se la da el método del barrido, que ya es transaccional. Aquí, donde
     * se llama al store a solas para ver la exclusión mutua (a través del adaptador no se ve: el
     * SELECT de candidatos ya filtró), la abre el test. La rama documental no necesita ninguna,
     * y por eso este helper existe en las dos: el cuerpo de los casos es el mismo texto.
     */
    private boolean reclamar(String activacion, UUID id, Instant ahora, Instant caducaAntesDe) {
        return Boolean.TRUE.equals(tx.execute(status -> reclamos.claim(activacion, id, ahora, caducaAntesDe)));
    }

    /** Una fila del agregado en el estado y con la marca de espera que pide el caso. */
    private UUID fila(${enumType} estado, Instant esperandoDesde) {
        ${entity.name}Jpa row = new ${entity.name}Jpa();
        row.setId(UUID.randomUUID());
        row.${accessor('set', entity.lifecycle.field)}(estado);
        row.${accessor('set', claim.awaitingField)}(esperandoDesde);
${requiredLiterals({ entity, statusField: entity.lifecycle.field }, claim.awaitingField, claim.awaitingField).join('\n')}
        return jpa.saveAndFlush(row).getId();
    }

    private UUID esperandoDesdeHace(long segundos) {
        return fila(${estadoDeEspera(claim, enumType)}, Instant.now().minusSeconds(segundos));
    }
${reconciliationStoreTests('tx.execute(status -> (long) marcas.deleteClaimedBefore(ahora.minusSeconds(3600)))')}
${reconciliationSweepTests(claim, estadoDeEspera(claim, enumType), otroEstado(entity, claim, enumType))}
}`;

  return file(
    packages.reconciliation,
    [
      `${packages.enums}.${enumType}`,
      `${packages.entities}.${entity.name}Jpa`,
      `${packages.jpaRepositories}.${entity.name}JpaRepository`,
      `${packages.port}.${entity.name}Repository`,
      `${packages.adapters}.${entity.name}RepositoryImpl`,
      ...importsDeEnums(entity, enumType, packages),
      'java.time.Instant',
      'java.util.UUID',
      'org.junit.jupiter.api.BeforeEach',
      'org.junit.jupiter.api.Test',
      'org.springframework.beans.factory.annotation.Autowired',
      'org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase',
      'org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest',
      'org.springframework.context.annotation.Import',
      'org.springframework.transaction.PlatformTransactionManager',
      ...(aislamiento ? ['org.springframework.transaction.TransactionDefinition'] : []),
      'org.springframework.transaction.annotation.Propagation',
      'org.springframework.transaction.annotation.Transactional',
      'org.springframework.transaction.support.TransactionTemplate',
      'static org.junit.jupiter.api.Assertions.assertEquals',
      'static org.junit.jupiter.api.Assertions.assertFalse',
      'static org.junit.jupiter.api.Assertions.assertTrue'
    ],
    body
  );
}

// ─── Reconciliación, rama documental ─────────────────────────────────────────

function documentReconciliationClass(model, subjects, { datasource, packages }) {
  const claim = subjects.reconciliation;
  const entity = entidadDe(model, claim);
  const enumType = entity.lifecycle.enumType;
  const properties = [
    `"spring.data.mongodb.uri=${datasource.uri}"`,
    '"spring.profiles.active="',
    ...parametrosDelBarrido(claim)
  ];

  const body = `${CABECERA}
@DataMongoTest(properties = {
        ${properties.join(',\n        ')}
})
@ImportAutoConfiguration(exclude = EmbeddedMongoAutoConfiguration.class)
@Import({ReconciliationClaimStore.class, ${entity.name}RepositoryImpl.class, MongoTransactionConfig.class})
class ${CLASS_RECONCILIATION} {

${constantesDelBarrido(claim)}

    @Autowired
    private MongoTemplate mongo;

    @Autowired
    private ReconciliationClaimStore reclamos;

    @Autowired
    private ReconciliationClaimMongoRepository marcas;

    @Autowired
    private ${entity.name}Repository adaptador;

    @BeforeEach
    void limpia() {
        mongo.remove(new Query(), ${entity.name}Document.class);
        marcas.deleteAll();
    }

    /** ¿Existe la marca de ese encargo sobre ese documento? Es por donde se afirma todo. */
    private boolean marcaDe(String activacion, UUID id) {
        return marcas.findById(ReconciliationClaimDocument.key(activacion, id)).isPresent();
    }

    /**
     * El reclamo. Aquí no hace falta transacción —el upsert es atómico por documento— y el helper
     * existe solo para que el cuerpo de los casos sea el MISMO texto que en la rama relacional,
     * donde el {@code @Modifying} sí la exige. Comparar las dos ramas es la mitad del ejercicio.
     */
    private boolean reclamar(String activacion, UUID id, Instant ahora, Instant caducaAntesDe) {
        return reclamos.claim(activacion, id, ahora, caducaAntesDe);
    }

    /** Un documento del agregado en el estado y con la marca de espera que pide el caso. */
    private UUID fila(${enumType} estado, Instant esperandoDesde) {
        ${entity.name}Document row = new ${entity.name}Document();
        row.setId(UUID.randomUUID());
        row.${accessor('set', entity.lifecycle.field)}(estado);
        row.${accessor('set', claim.awaitingField)}(esperandoDesde);
${requiredLiterals({ entity, statusField: entity.lifecycle.field }, claim.awaitingField, claim.awaitingField).join('\n')}
        return mongo.save(row).getId();
    }

    private UUID esperandoDesdeHace(long segundos) {
        return fila(${estadoDeEspera(claim, enumType)}, Instant.now().minusSeconds(segundos));
    }
${midiendoElContenedor(model)}${reconciliationStoreTests('marcas.deleteByClaimedAtBefore(ahora.minusSeconds(3600))')}
${reconciliationSweepTests(claim, estadoDeEspera(claim, enumType), otroEstado(entity, claim, enumType))}
}`;

  return file(
    packages.reconciliation,
    [
      `${packages.enums}.${enumType}`,
      `${packages.entities}.${entity.name}Document`,
      `${packages.port}.${entity.name}Repository`,
      `${packages.adapters}.${entity.name}RepositoryImpl`,
      `${packages.mongoTx}.MongoTransactionConfig`,
      ...importsDeEnums(entity, enumType, packages),
      'de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration',
      'java.time.Instant',
      'java.util.UUID',
      'org.junit.jupiter.api.BeforeEach',
      'org.junit.jupiter.api.Test',
      'org.springframework.beans.factory.annotation.Autowired',
      'org.springframework.boot.autoconfigure.ImportAutoConfiguration',
      'org.springframework.boot.test.autoconfigure.data.mongo.DataMongoTest',
      'org.springframework.context.annotation.Import',
      'org.springframework.data.mongodb.core.MongoTemplate',
      'org.springframework.data.mongodb.core.query.Query',
      'static org.junit.jupiter.api.Assertions.assertEquals',
      'static org.junit.jupiter.api.Assertions.assertFalse',
      'static org.junit.jupiter.api.Assertions.assertNotNull',
      'static org.junit.jupiter.api.Assertions.assertTrue'
    ],
    body
  );
}

// ─── Derivaciones compartidas por las dos ramas ──────────────────────────────

const entidadDe = (model, claim) => (model.entities ?? []).find((e) => e.name === claim.entity);

/** La constante del enum del estado en el que la fila ESPERA el desenlace. */
const estadoDeEspera = (claim, enumType) => `${enumType}.${screamingSnake(claim.states[0])}`;

/**
 * Un estado del lifecycle que NO es de espera, para el caso que afirma que el barrido
 * discrimina. Sale de las transiciones declaradas —no de una constante escrita aquí— porque
 * cada fixture tiene los suyos, y uno inventado ni siquiera compilaría.
 */
function otroEstado(entity, claim, enumType) {
  const espera = new Set(claim.states.map((state) => screamingSnake(state)));
  const todos = new Set();
  for (const transition of entity.lifecycle.transitions ?? []) {
    todos.add(transition.from);
    for (const to of transition.to ?? []) todos.add(to);
  }
  const otro = [...todos].find((state) => !espera.has(state));
  if (!otro) {
    throw new Error(
      `store-check: el lifecycle de ${entity.name} no tiene ningún estado fuera de la espera, ` +
        'así que no se puede afirmar que el barrido discrimine por estado'
    );
  }
  return `${enumType}.${otro}`;
}

/**
 * Los tres parámetros del barrido, con la clave que emite config.js.
 *
 * Van bajos a propósito: con el umbral del diseño (media hora larga) el caso de la cota
 * necesitaría filas de hace media hora, y con el lote de producción (50) haría falta sembrar
 * cincuenta. Lo que se mide es que las cotas EXISTAN, no sus valores.
 */
const parametrosDelBarrido = (claim) => [
  `"reconciliation.${claim.configKey}.unanswered-after-seconds=${TOLERANCIA_SEGUNDOS}"`,
  `"reconciliation.${claim.configKey}.claim-timeout-ms=${CLAIM_TIMEOUT_MS}"`,
  `"reconciliation.${claim.configKey}.batch-size=${BATCH_SIZE}"`
];

const constantesDelBarrido = (claim) => `    private static final String ACTIVACION = ${javaString(claim.activation)};
    // Una activación que NO existe en el diseño, y a propósito: lo que se mide es que la clave
    // del reclamo lleve la activación, no que el diseño tenga dos.
    private static final String OTRA_ACTIVACION = ${javaString(`${claim.activation}-otra`)};
    private static final int LOTE = ${BATCH_SIZE};
    private static final long TOLERANCIA_S = ${TOLERANCIA_SEGUNDOS};`;

/**
 * Los enums de los campos obligatorios que la siembra rellena. Se descubren del modelo, no de
 * una lista: una fixture con otro enum obligatorio traería otro nombre y el Java no compilaría.
 */
function importsDeEnums(entity, enumType, packages) {
  const escalares = new Set([
    'String', 'Integer', 'int', 'Long', 'long', 'BigDecimal', 'Boolean', 'boolean', 'Instant', 'UUID'
  ]);
  return [
    ...new Set(
      (entity.fields ?? [])
        .filter((field) => field.required && !field.isId && !field.list && !escalares.has(field.javaType))
        .map((field) => field.javaType)
        .filter((type) => type !== enumType)
    )
  ].map((type) => `${packages.enums}.${type}`);
}
