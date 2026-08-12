import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

// El gate determinista del tramo que no está garantizado por construcción. Su
// propiedad central no es que exista: es que salga ROJO sobre un proyecto recién
// generado. Un script que sale verde sobre un árbol en el que el agente aún no ha
// escrito nada no distingue «correcto» de «no mira» — el mismo razonamiento por el
// que java-syntax.test.js se autocomprueba con Java roto a propósito.

const fixture = (name) => path.join(process.cwd(), 'test', 'fixtures', name);

function build(name) {
  const service = loadService(fixture(name));
  const workspace = tmpDir('keel-idem-check-');
  const result = scaffoldService({
    manifest: service.manifest,
    layers: service.layers,
    workspace,
    force: true
  });
  return path.join(workspace, result.outDir);
}

const script = (project) => path.join(project, 'infra', 'check-idempotency.sh');
const read = (project) => fs.readFileSync(script(project), 'utf8');

/** Ejecuta el script y devuelve { code, out }. Requiere bash (Git Bash en Windows). */
function run(project) {
  try {
    const out = execFileSync('bash', ['infra/check-idempotency.sh'], {
      cwd: project,
      encoding: 'utf8'
    });
    return { code: 0, out };
  } catch (error) {
    if (error.code === 'ENOENT') return null; // sin bash: el test se salta solo
    return { code: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test('un diseño con las cinco familias genera el script con las cinco', () => {
  const project = build('catalog-extended');
  const content = read(project);

  for (const group of ['dedupe', 'commandIdempotency', 'compensation', 'reconciliation', 'outboxDelivery']) {
    assert.ok(content.includes(`${group}_ko=0`), `falta la familia ${group}`);
  }
});

test('el orden del guard sale del diseño, no del agente', () => {
  const content = read(build('catalog-extended'));

  // reactivateWithdrawnProduct declara transitions → procesar y luego registrar,
  // y `tryRecord` pasa a estar PROHIBIDO ahí: es el cruce que pierde mensajes.
  const withdrawal = content.split('\n').find((line) => line.startsWith("unit 'dedupe' 'WithdrawalRejected'"));
  assert.ok(withdrawal, 'no hay fila de dedupe para WithdrawalRejected');
  assert.ok(withdrawal.includes('\\.record\\s*\\('), withdrawal);
  assert.match(content, /declara transitions: alreadyProcessed/);
  // projectSupplierPrice no las declara → reclamar antes, al precio de perder el
  // mensaje si el handler falla. El cruzado es el error caro, y va en `forbid`.
  assert.match(content, /no declara transitions: tryRecord/);
});

test('sin nada de esta familia no se genera script: un gate que siempre pasa no mira', () => {
  const project = build('metering-digest');
  const service = loadService(fixture('metering-digest'));
  const declara =
    Boolean(service.layers.messaging?.subscriptions) ||
    Object.values(service.layers['use-cases']?.operations ?? {}).some((op) => op.idempotency);
  if (declara) return; // la fixture sí declara algo: este caso no aplica
  assert.ok(!fs.existsSync(script(project)));
});

test('recién generado sale ROJO, y cada hallazgo señala trabajo que el agente aún no ha hecho', (t) => {
  const project = build('catalog-extended');
  const result = run(project);
  if (result === null) return t.skip('sin bash en el PATH');

  assert.equal(result.code, 1, result.out);
  // El listener lo escribe el agente con la skill de su broker: aquí no existe.
  assert.match(result.out, /WithdrawalRejectedListener\.java/);
  // El @Scheduled que build deja lanzando cuando el mensaje lleva argumentos.
  assert.match(result.out, /\[reconciliation\]/);
  // Y el fallback del outbox, que marca como publicadas filas que nunca salieron.
  assert.match(result.out, /solo está el fallback OutboxDispatcherFallbackConfig/);
});

test('lo que build sí genera no se reporta: el store está inyectado y no sale como ausente', (t) => {
  const project = build('catalog-extended');
  const result = run(project);
  if (result === null) return t.skip('sin bash en el PATH');

  // `IdempotencyStore` lo inyecta build en el handler, así que ese patrón pasa; lo
  // que falta es `CommandSignature.of(...)`, que es la parte que escribe el agente.
  assert.ok(!/falta 'IdempotencyStore'/.test(result.out), result.out);
  assert.match(result.out, /falta 'CommandSignature/);
});

// El barrido corre en TODAS las réplicas —@Scheduled es «cada N minutos en cada
// instancia», no «en el clúster»—, así que un findAllByStatus deja que las N se lleven
// las mismas filas y todas llamen al servidor de al lado. El gate solo comprobaba el
// @Value del umbral y el @Scheduled del disparador: lo único que decide si el barrido
// es correcto con varias instancias no lo miraba nadie.
test('el gate exige que el barrido reclame sus candidatos, y acotados', (t) => {
  const project = build('catalog-extended');
  const before = run(project);
  if (before === null) return t.skip('sin bash en el PATH');
  assert.match(before.out, /reclamo del barrido/);

  // Un reclamo real lo apaga: marca PERSISTIDA sobre un lote acotado. Donde lo ponga el
  // agente es asunto suyo, así que se busca en el árbol.
  const adapter = path.join(project, 'src/main/java/com/commerce/catalog/infrastructure/persistence');
  fs.mkdirSync(adapter, { recursive: true });
  const claim = path.join(adapter, 'StaleClaimRepository.java');
  const withBound = `package com.commerce.catalog.infrastructure.persistence;

import java.time.Instant;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface StaleClaimRepository {

    @Modifying
    @Query(value = "update orders set reserve_stock_claimed_at = :now where id in (select id from orders where status = 'reserved' and reserve_stock_claimed_at is null limit :batch)", nativeQuery = true)
    int claimStale(@Param("now") Instant now, @Param("batch") int batch);
}
`;
  fs.writeFileSync(claim, withBound);
  assert.ok(!/reclamo del barrido/.test(run(project).out));

  // Y sin cota vuelve el hallazgo: reclamar la tabla entera no es un lote, es una
  // transacción larga que las demás réplicas esperan.
  fs.writeFileSync(claim, withBound.replace(' limit :batch', ''));
  assert.match(run(project).out, /reclamo del barrido/);

  // El caso que antes pasaba en falso: la cota no está en el reclamo, pero el archivo
  // tiene OTRA consulta paginada. Un repositorio es por definición donde viven todas las
  // consultas del agregado, así que ese Pageable ajeno está casi siempre — y mientras la
  // cota se buscara en el archivo entero, este check no podía fallar nunca.
  fs.writeFileSync(
    claim,
    withBound.replace(' limit :batch', '').replace(
      '}\n',
      `
    org.springframework.data.domain.Page<Object> findAllByStatus(String status, org.springframework.data.domain.Pageable pageable);
}
`
    )
  );
  assert.match(run(project).out, /reclamo del barrido/);
});

// Un lock pesimista SÍ reparte filas disjuntas, pero solo mientras dura su transacción, y
// en el barrido la llamada al proveedor va en medio: o la sostienes durante la llamada
// —una conexión del pool retenida por la latencia de un tercero— o la sueltas antes y la
// fila queda sin marca, con lo que las N réplicas vuelven a verla. El gate aceptaba esa
// forma, así que no distinguía la correcta de la que se le parece.
test('el gate no acepta un lock pesimista como reclamo del barrido', (t) => {
  const project = build('catalog-extended');
  if (run(project) === null) return t.skip('sin bash en el PATH');

  const adapter = path.join(project, 'src/main/java/com/commerce/catalog/infrastructure/persistence');
  fs.mkdirSync(adapter, { recursive: true });
  fs.writeFileSync(
    path.join(adapter, 'StaleClaimRepository.java'),
    `package com.commerce.catalog.infrastructure.persistence;

import java.util.List;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.Lock;
import jakarta.persistence.LockModeType;

public interface StaleClaimRepository {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    List<Object> claimStale(Pageable pageable);
}
`
  );

  const after = run(project);
  assert.match(after.out, /reclamo del barrido/);
  // Y el mensaje tiene que decir qué forma se espera, no solo que falta algo: si no, el
  // camino de menor resistencia es colar un @Modifying en cualquier parte.
  assert.match(after.out, /MARCA PERSISTIDA/);
});

// El umbral se comprueba APARTE del reclamo, y esa separación costó dos correcciones:
// exigirlo en el handler de `application` pedía importar Spring donde la constitución lo
// prohíbe, y exigirlo en el mismo archivo que el reclamo contradice el reparto que el
// propio scaffold impone (puerto sin framework, adaptador con @Value, repositorio con la
// consulta). Lo que queda es lo único afirmable sin suponer arquitectura.
test('el gate exige que el umbral del barrido esté parametrizado, esté donde esté', (t) => {
  const project = build('catalog-extended');
  const before = run(project);
  if (before === null) return t.skip('sin bash en el PATH');
  assert.match(before.out, /umbral del barrido/);

  const config = path.join(project, 'src/main/java/com/commerce/catalog/infrastructure/configurations');
  fs.mkdirSync(config, { recursive: true });
  const file = path.join(config, 'ReconciliationConfig.java');
  const parameterized = `package com.commerce.catalog.infrastructure.configurations;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ReconciliationConfig {

    @Value("\${reconciliation.stale-after-ms:900000}")
    private long staleAfterMs;
}
`;
  // Un adaptador de configuración aparte lo apaga: es donde el reparto hexagonal lo pone.
  fs.writeFileSync(file, parameterized);
  assert.ok(!/umbral del barrido/.test(run(project).out), 'el umbral parametrizado aparte sigue reportándose');

  // Quemado en el código, vuelve: no se ajusta por entorno sin recompilar.
  fs.writeFileSync(file, parameterized.replace(/@Value\([^)]*\)\n\s*private long staleAfterMs;/, 'private static final long STALE_AFTER_MS = 900000L;'));
  assert.match(run(project).out, /umbral del barrido/);

  // Y un @Value que no habla de la espera tampoco vale: cualquier configuración tiene
  // uno, y aceptarlo dejaría el check verde en todo proyecto con Spring.
  fs.writeFileSync(file, parameterized.replace('reconciliation.stale-after-ms:900000', 'app.page-size:20').replace('staleAfterMs', 'pageSize').replace('ReconciliationConfig', 'PagingConfig'));
  fs.renameSync(file, path.join(config, 'PagingConfig.java'));
  assert.match(run(project).out, /umbral del barrido/);
});

// El falso negativo que costó una corrida entera: el gate exigía `@Value` DENTRO del
// handler de `application`, y la constitución que el propio generador siembra prohíbe
// que esa capa importe Spring. No había forma de satisfacer las dos cosas, así que el
// agente de calidad reportó el hallazgo como imposible tras dos pasadas.
test('reconciliation no exige @Value en el handler, que es capa sin Spring', () => {
  const project = build('catalog-extended');
  const content = read(project);

  const handlerRows = content
    .split('\n')
    .filter((line) => line.startsWith('unit ') && line.includes('reconciliation') && line.includes('CommandHandler'));
  assert.ok(handlerRows.length > 0, 'no hay fila de reconciliation sobre el handler');
  for (const row of handlerRows) {
    assert.ok(!row.includes('@Value'), `la fila sigue exigiendo @Value en application: ${row}`);
  }
  // Pero el umbral no se deja de mirar: se mira en su propia fila, sin decir en qué
  // archivo tiene que estar.
  assert.match(content, /^claim 'reconciliation' 'umbral del barrido' '@Value\|@ConfigurationProperties'/m);
});

test('los comentarios no cuentan como código: el TODO que se caza es el vivo', (t) => {
  const project = build('catalog-extended');
  const handler = execFileSync(
    'bash',
    ['-c', "find src/main/java -name 'ReactivateWithdrawnProductCommandHandler.java' | head -n 1"],
    { cwd: project, encoding: 'utf8' }
  ).trim();
  if (!handler) return t.skip('sin bash en el PATH');

  // Se sustituye el cuerpo del stub por una implementación de mentira que conserva
  // el javadoc de build (que menciona TODO en prosa). El script tiene que callarse.
  const original = fs.readFileSync(path.join(project, handler), 'utf8');
  const implementado = original
    .replace(/\/\/ TODO \(agente\):[^\n]*\n/g, '')
    .replace(/throw new UnsupportedOperationException\([^;]*\);/g, 'product.reactivate();');
  fs.writeFileSync(path.join(project, handler), implementado);

  const result = run(project);
  if (result === null) return t.skip('sin bash en el PATH');
  assert.ok(!/\[compensation\]/.test(result.out), result.out);
});

// La familia `dedupe` comprobaba el ORDEN y el USO del guard —que eran correctos— y
// salió OK en una corrida real con la deduplicación COMPLETAMENTE ROTA: la escritura
// del registro hacía `merge()` en vez de INSERT, así que `record()`/`tryRecord()`
// devolvían `true` siempre. Estos tests fijan lo que faltaba, y lo hacen del único modo
// que sirve: reintroduciendo cada defecto y exigiendo que el gate se ponga rojo. Un
// check que solo se prueba contra el árbol bueno no distingue «mira» de «no mira».
const javaFile = (project, name) => {
  const found = execFileSync('bash', ['-c', `find src/main/java -name '${name}' | head -n 1`], {
    cwd: project,
    encoding: 'utf8'
  }).trim();
  return found ? path.join(project, found) : null;
};

const mutating = (project, file, mutate) => {
  const original = fs.readFileSync(file, 'utf8');
  const mutated = mutate(original);
  assert.notEqual(mutated, original, 'la mutación no aplicó: el test no probaría nada');
  fs.writeFileSync(file, mutated);
  const result = run(project);
  fs.writeFileSync(file, original);
  return result;
};

test('dedupe: sin Persistable la escritura es un merge y el gate lo caza', (t) => {
  const project = build('catalog-extended');
  const entity = javaFile(project, 'ProcessedEventJpa.java');
  if (!entity) return t.skip('sin bash en el PATH');

  // Con la clave ASIGNADA y sin Persistable, SimpleJpaRepository.isNew() mira el id, lo
  // ve no nulo y hace merge(): SELECT + UPDATE que no viola la clave y no lanza nada.
  const result = mutating(project, entity, (s) => s.replace(/implements Persistable<[^>]+>/, ''));
  if (result === null) return t.skip('sin bash en el PATH');
  assert.match(result.out, /\[dedupe\][^\n]*ProcessedEventJpa/, result.out);
});

test('dedupe: un isNew() constante desactiva delete() y el gate lo caza', (t) => {
  const project = build('catalog-extended');
  const entity = javaFile(project, 'ProcessedEventJpa.java');
  if (!entity) return t.skip('sin bash en el PATH');

  // El más sutil de los cuatro: SimpleJpaRepository.delete() empieza con
  // `if (isNew(entity)) return;`, así que un `true` constante lo convierte en un no-op
  // silencioso y la retirada de la clave caducada deja de borrar. Arreglar el INSERT
  // desactivaba el DELETE, y nada lo delataba.
  const result = mutating(project, entity, (s) => s.replace('return !persisted;', 'return true;'));
  if (result === null) return t.skip('sin bash en el PATH');
  assert.match(result.out, /\[dedupe\][^\n]*ProcessedEventJpa/, result.out);
});

test('dedupe: sin saveAndFlush del repositorio la excepción no se traduce y el gate lo caza', (t) => {
  const project = build('catalog-extended');
  const writer = javaFile(project, 'ProcessedEventWriter.java');
  if (!writer) return t.skip('sin bash en el PATH');

  // La traducción de excepciones de Spring solo actúa al salir de un método proxeado, y
  // el proxy del EntityManager no traduce: sale un ConstraintViolationException crudo
  // que ningún catch de DataIntegrityViolationException reconoce, y el catch-all lo
  // convierte en el 500 que los escenarios de carrera prohíben.
  const result = mutating(project, writer, (s) => s.replace('.saveAndFlush(', '.persist('));
  if (result === null) return t.skip('sin bash en el PATH');
  assert.match(result.out, /\[dedupe\][^\n]*ProcessedEventWriter/, result.out);
});

test('commandIdempotency: la entidad de la clave también fuerza INSERT', (t) => {
  const project = build('catalog-extended');
  const entity = javaFile(project, 'IdempotencyRecordJpa.java');
  if (!entity) return t.skip('sin bash en el PATH');

  // Es lo que hace que la carrera de la clave la arbitre la base y no un candado en
  // memoria, y lo que permite retirar la clave caducada antes de reinsertarla.
  const result = mutating(project, entity, (s) => s.replace(/implements Persistable<[^>]+>/, ''));
  if (result === null) return t.skip('sin bash en el PATH');
  assert.match(result.out, /\[commandIdempotency\][^\n]*IdempotencyRecordJpa/, result.out);
});

// ─── Cosecha de la corrida con RabbitMQ ───────────────────────────────────────
//
// El gate buscaba `<Evento>Listener.java`, un archivo por suscripción. Con varias
// suscripciones sobre la MISMA cola —el caso de RabbitMQ cuando comparten fuente—
// eso son consumidores compitiendo: cada mensaje llega a uno solo y los demás no lo
// ven. La implementación correcta es un listener único que enruta por eventType, y el
// gate la marcaba KO. Un falso negativo cuyo camino de menor resistencia es romper el
// consumo para que el script se calle.
test('dedupe: con la cola compartida, el gate acepta un solo listener que enruta', (t) => {
  const service = loadService(fixture('stock-reservation'));
  const workspace = tmpDir('keel-idem-check-');
  const result = scaffoldService({
    manifest: service.manifest,
    layers: service.layers,
    workspace,
    force: true,
    stack: { broker: 'rabbitmq' }
  });
  const project = path.join(workspace, result.outDir);

  const before = run(project);
  if (before === null) return t.skip('sin bash en el PATH');
  // Recién generado sigue habiendo hallazgo —no hay listener— pero es UNO para las tres
  // suscripciones y nombra la cola, no tres archivos que no deberían existir.
  assert.match(before.out, /inventory\.events \(StockReserved, StockCountAdjusted, StockRejected\)/);
  assert.equal(before.out.match(/\[dedupe\] inventory\.events/g).length, 1, before.out);
  assert.ok(!/StockCountAdjustedListener\.java/.test(before.out), before.out);

  // El listener único, con las dos ramas: `record` tras despachar para las que tienen
  // guarda de dominio y `tryRecord` antes para la que no.
  const dir = path.join(project, 'src/main/java/com/fulfillment/stockreservation/infrastructure/messaging/subscriptions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'InventoryEventsListener.java'),
    `package com.fulfillment.stockreservation.infrastructure.messaging.subscriptions;

public class InventoryEventsListener {

    private final IdempotencyGuard guard;

    public void onMessage(String eventType, String eventId, String payload) {
        switch (eventType) {
            case "StockReserved" -> {
                StockReservedMessage message = parse(payload);
                if (guard.alreadyProcessed(eventId)) {
                    return;
                }
                dispatch(message);
                guard.record(eventId);
            }
            case "StockRejected" -> {
                StockRejectedMessage message = parse(payload);
                if (guard.alreadyProcessed(eventId)) {
                    return;
                }
                dispatch(message);
                guard.record(eventId);
            }
            case "StockCountAdjusted" -> {
                StockCountAdjustedMessage message = parse(payload);
                if (!guard.tryRecord(eventId)) {
                    return;
                }
                dispatch(message);
            }
            default -> { }
        }
    }
}
`
  );
  const after = run(project);
  assert.ok(!/inventory\.events \(/.test(after.out), after.out);

  // Y no es un cheque de adorno: sin la rama `tryRecord` —la única guarda de la
  // suscripción que no tiene transición detrás— el hallazgo vuelve.
  fs.writeFileSync(
    path.join(dir, 'InventoryEventsListener.java'),
    fs.readFileSync(path.join(dir, 'InventoryEventsListener.java'), 'utf8').replace('!guard.tryRecord(eventId)', 'guard.alreadyProcessed(eventId)')
  );
  assert.match(run(project).out, /inventory\.events \(/);
});

// Con Kafka la forma correcta es la contraria —cada listener tiene su grupo y recibe el
// topic entero—, así que ahí el gate sigue exigiendo un archivo por suscripción. Si esto
// se relajara para todos, el gate dejaría de ver un listener que falta.
test('dedupe: con Kafka se sigue exigiendo un listener por suscripción', (t) => {
  const service = loadService(fixture('stock-reservation'));
  const workspace = tmpDir('keel-idem-check-');
  const result = scaffoldService({
    manifest: service.manifest,
    layers: service.layers,
    workspace,
    force: true,
    stack: { broker: 'kafka' }
  });
  const out = run(path.join(workspace, result.outDir));
  if (out === null) return t.skip('sin bash en el PATH');
  assert.match(out.out, /no existe StockReservedListener\.java/);
  assert.match(out.out, /no existe StockCountAdjustedListener\.java/);
  assert.match(out.out, /no existe StockRejectedListener\.java/);
});

// La otra mitad del aviso de retención: sin guarda de dominio NO es inocuo, y el javadoc
// tiene que decirlo donde se lee, no solo en la referencia del DSL. `stock-reservation`
// tiene las dos formas en el mismo diseño, que es lo que hace comparable el par.
test('el javadoc del Message avisa de la ventana de retención según haya guarda o no', () => {
  const service = loadService(fixture('stock-reservation'));
  const workspace = tmpDir('keel-idem-check-');
  const result = scaffoldService({
    manifest: service.manifest,
    layers: service.layers,
    workspace,
    force: true,
    stack: { broker: 'kafka' }
  });
  const subs = path.join(
    workspace,
    result.outDir,
    'src/main/java/com/fulfillment/stockreservation/infrastructure/messaging/subscriptions'
  );
  const read = (name) => fs.readFileSync(path.join(subs, name), 'utf8');

  // Con transiciones (applyStockReserved): la repetición la frena el agregado.
  const guarded = read('StockReservedMessage.java');
  assert.ok(guarded.includes('processed-event.purge.retention-days'), guarded);
  assert.ok(guarded.includes('esa no caduca'), guarded);

  // Sin ellas (noteStockCount, un contador): pasada la retención el efecto se repite, y
  // eso no lo arregla ningún parámetro — es un hueco del diseño.
  const unguarded = read('StockCountAdjustedMessage.java');
  assert.ok(unguarded.includes('Aquí NO es inocuo'), unguarded);
  assert.ok(unguarded.includes('guarda de dominio'), unguarded);
  assert.ok(!unguarded.includes('esa no caduca'), unguarded);
});

// Tres suscripciones de la MISMA fuente caen en el mismo destino por convención, así que
// cada listener recibe también los otros dos eventos. El javadoc tiene que nombrar el
// valor a comparar y a los compañeros de destino: sin eso, el camino de menor resistencia
// es un listener por evento sin filtro, que deserializa lo ajeno contra su propio record.
test('el javadoc del Message nombra el discriminador implícito y quién comparte destino', () => {
  const service = loadService(fixture('stock-reservation'));
  const workspace = tmpDir('keel-idem-check-');
  const result = scaffoldService({
    manifest: service.manifest,
    layers: service.layers,
    workspace,
    force: true,
    stack: { broker: 'kafka' }
  });
  const subs = path.join(
    workspace,
    result.outDir,
    'src/main/java/com/fulfillment/stockreservation/infrastructure/messaging/subscriptions'
  );
  const message = fs.readFileSync(path.join(subs, 'StockReservedMessage.java'), 'utf8');

  assert.ok(message.includes("Se reconoce por metadata.eventType == 'StockReserved'"), message);
  // Los otros dos, por nombre: es lo que hace evidente que el destino es compartido.
  assert.ok(message.includes('StockCountAdjusted'), message);
  assert.ok(message.includes('StockRejected'), message);
  // Descartar con excepción dispara onFailure.retry y acaba mandando al descarte un
  // mensaje válido que era de otra suscripción.
  assert.ok(message.includes('SIN lanzar excepción'), message);
});
