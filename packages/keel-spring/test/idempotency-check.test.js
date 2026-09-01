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

function build(name, mutate = null) {
  const service = loadService(fixture(name));
  const layers = mutate ? structuredClone(service.layers) : service.layers;
  if (mutate) mutate(layers);
  const workspace = tmpDir('keel-idem-check-');
  const result = scaffoldService({
    manifest: service.manifest,
    layers,
    workspace,
    force: true
  });
  return path.join(workspace, result.outDir);
}

/**
 * El mismo diseño, pero con el reclamo de la reconciliación SIN generar. Es lo que hace
 * falta para probar los checks que solo aplican cuando build no pudo generarlo: con el
 * reclamo generado, el gate exige llamarlo y esos tres checks no se emiten — que es
 * justo lo que se quiere, porque pedirle al agente que reescriba lo que ya existe tiene
 * como camino de menor resistencia un segundo mecanismo en paralelo.
 *
 * El hueco que se reproduce es el único que la validación no cierra: DOS entidades
 * esperando el mismo desenlace, donde «el lote» deja de estar definido.
 */
const sinReclamoGenerado = (layers) => {
  layers.domain.entities.Category.lifecycle = {
    field: 'status',
    transitions: { active: ['withdrawn'], withdrawn: ['active'] }
  };
  layers.domain.entities.Category.fields.status = {
    type: 'enum',
    values: ['active', 'withdrawn'],
    required: true,
    default: 'active'
  };
  layers['use-cases'].operations.retireProduct.transitions.push({
    entity: 'Category',
    from: ['active'],
    to: 'withdrawn'
  });
};

// ¿El script reporta ESTE sujeto? Se mira el encabezado del hallazgo y no el texto
// entero: los `why` se citan entre ellos —el de la cota empieza por «el reclamo del
// barrido no acota su lote»— y un `match` sobre el cuerpo confundiría los dos.
const reports = (out, subject) =>
  out.split(/\r?\n/).some((line) => /^\s*\[[a-zA-Z]+\]/.test(line) && line.split(':')[0].includes(subject));

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

test('un diseño con todas sus familias genera el script con todas', () => {
  const project = build('catalog-extended');
  const content = read(project);

  // Ocho, no seis: `domainEvent` (el raise en el agregado) y `outboundIdempotency`
  // (la cabecera que viaja al proveedor) también salen de este diseño. La lista es
  // literal a propósito — una familia nueva que no se añada aquí queda sin probar.
  for (const group of [
    'dedupe',
    'payloadContract',
    'commandIdempotency',
    'compensation',
    'domainEvent',
    'reconciliation',
    'outboundIdempotency',
    'outboxDelivery'
  ]) {
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
  assert.match(content, /tiene guarda de dominio \(declara transitions\): alreadyProcessed/);
  // projectSupplierPrice no la tiene → reclamar antes, al precio de perder el mensaje si
  // el handler falla. El cruzado es el error caro, y va en `forbid`.
  //
  // «Guarda de dominio» y «declara transitions» dejaron de ser lo mismo con el DSL 2.12: una
  // clave de idempotencia que participa en la clave natural guarda igual —y no caduca—, así
  // que el porqué nombra cuál de las dos es (ver payload-field-idempotency.test.js).
  assert.match(content, /no tiene guarda de dominio \(ni transitions, ni clave de idempotencia/);
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
  const project = build('catalog-extended', sinReclamoGenerado);
  const before = run(project);
  if (before === null) return t.skip('sin bash en el PATH');
  assert.ok(reports(before.out, 'reclamo del barrido'));

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
  const green = run(project).out;
  assert.ok(!reports(green, 'reclamo del barrido'));
  assert.ok(!reports(green, 'lote del barrido'));

  // Y sin cota vuelve el hallazgo —reclamar la tabla entera no es un lote, es una pasada
  // con tantas llamadas al proveedor como filas atascadas—, pero por su propio sujeto: el
  // reclamo sigue estando bien, lo que falta es la cota. Decir «no reclamas» cuando sí
  // reclama manda a arreglar lo que ya estaba hecho.
  fs.writeFileSync(claim, withBound.replace(' limit :batch', ''));
  const unbounded = run(project).out;
  assert.ok(reports(unbounded, 'lote del barrido'));
  assert.ok(!reports(unbounded, 'reclamo del barrido'), 'la falta de cota se reporta como si faltara el reclamo');

  // El falso positivo que motivó acotar el alcance al método: la cota no está en el
  // reclamo, pero el archivo tiene OTRA consulta paginada. Un repositorio es por
  // definición donde viven todas las consultas del agregado, así que ese `Pageable` ajeno
  // está casi siempre. Sigue sin valer, y ahora por un motivo que no depende de dónde
  // esté: ese listado no habla de los candidatos de este barrido.
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
  assert.ok(reports(run(project).out, 'lote del barrido'));
});

// El falso NEGATIVO simétrico, y el que apareció en la corrida del 13/08/2026: exigir la
// cota dentro del método del reclamo daba por incorrecta la forma que la propia convención
// prescribe. En JPQL un `@Modifying` no acepta `Pageable`, así que seleccionar candidatos
// acotados y reclamarlos con un UPDATE condicional son DOS consultas por obligación — y el
// camino de menor resistencia para callar el gate era fusionarlas en una nativa.
test('el gate acepta que seleccionar y reclamar sean dos consultas, que es la forma correcta en JPQL', (t) => {
  const project = build('catalog-extended');
  if (run(project) === null) return t.skip('sin bash en el PATH');

  const adapter = path.join(project, 'src/main/java/com/commerce/catalog/infrastructure/persistence');
  fs.mkdirSync(adapter, { recursive: true });
  fs.writeFileSync(
    path.join(adapter, 'StaleClaimRepository.java'),
    `package com.commerce.catalog.infrastructure.persistence;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface StaleClaimRepository {

    @Query("select o.id from OrderJpa o where o.awaitingSince < :threshold order by o.awaitingSince asc")
    List<UUID> findReconciliationCandidateIds(@Param("threshold") Instant threshold, Pageable pageable);

    @Modifying
    @Query("update OrderJpa o set o.claimedAt = :now where o.id in :ids and o.claimedAt is null")
    int claimCandidates(@Param("ids") Collection<UUID> ids, @Param("now") Instant now);
}
`
  );

  const out = run(project).out;
  assert.ok(!reports(out, 'reclamo del barrido'), 'el UPDATE condicional no se reconoció como reclamo');
  assert.ok(!reports(out, 'lote del barrido'), 'la cota en la consulta de candidatos no se reconoció');
});

// Un lock pesimista SÍ reparte filas disjuntas, pero solo mientras dura su transacción, y
// en el barrido la llamada al proveedor va en medio: o la sostienes durante la llamada
// —una conexión del pool retenida por la latencia de un tercero— o la sueltas antes y la
// fila queda sin marca, con lo que las N réplicas vuelven a verla. El gate aceptaba esa
// forma, así que no distinguía la correcta de la que se le parece.
test('el gate no acepta un lock pesimista como reclamo del barrido', (t) => {
  const project = build('catalog-extended', sinReclamoGenerado);
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
  assert.ok(reports(after.out, 'reclamo del barrido'));
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
  const project = build('catalog-extended', sinReclamoGenerado);
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
  const project = build('catalog-extended', sinReclamoGenerado);
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

test('con el reclamo generado el gate exige LLAMARLO, y retira los tres checks del agente', () => {
  // El riesgo que cierra este test: si los checks del agente siguieran emitiéndose sobre
  // un diseño cuyo reclamo genera build, el camino de menor resistencia para apagarlos
  // sería escribir un segundo mecanismo en paralelo al generado — que no reclama nada y
  // reparte peor. Un check que pide la implementación incorrecta es peor que no tenerlo.
  const content = read(build('catalog-extended'));

  assert.match(content, /claimForReconcileWithdrawalsRecordWithdrawal/);
  for (const subject of ['reclamo del barrido', 'lote del barrido', 'umbral del barrido']) {
    assert.ok(!content.includes(`'${subject}'`), `sigue emitiéndose el check del agente: ${subject}`);
  }
  // Y sin reclamo generado siguen ahí, que es la otra mitad de la afirmación.
  const fallback = read(build('catalog-extended', sinReclamoGenerado));
  for (const subject of ['reclamo del barrido', 'lote del barrido', 'umbral del barrido']) {
    assert.ok(fallback.includes(`'${subject}'`), `falta el check del agente: ${subject}`);
  }
});

// Un diseño puede tener DOS barridos: uno cuya activación deja esperando a una sola
// entidad —build le genera el reclamo— y otro que deja esperando a dos, donde «el lote»
// no está definido y el reclamo lo escribe el agente. Los tres checks genéricos existen
// para el segundo, pero se buscan en TODO el árbol: el reclamo que build generó para el
// primero los satisface por su cuenta —lleva su Pageable y habla de candidatos— y deja
// sin mirar justo el barrido que hay que escribir a mano. Falso verde sobre la mitad
// más frágil de la reconciliación.
const dosBarridosUnoReclamable = (layers) => {
  // `updateProduct` no declara transitions, así que esta activación no deja a nadie
  // esperando y build no puede reclamarla. La de al lado (recordWithdrawal) sigue
  // generándose: eso es lo que hace la mezcla.
  layers.dependencies.dependencies.compliance.activations.notifyRegistryChange = {
    description: 'Aviso al registro de un cambio de ficha.',
    triggeredBy: ['updateProduct'],
    via: { client: 'compliance', call: 'cancelWithdrawal' },
    effect: 'El registro conoce la ficha nueva.',
    awaits: 'acknowledgement',
    reconciledBy: 'reconcileWithdrawals',
    unansweredAfterSeconds: 3600,
    awaitingSince: 'recordWithdrawalAwaitingSince',
    onFailure: { action: 'ignore' }
  };
};

// La corrida de customer-refunds sacó este check ROJO sobre un barrido CORRECTO. Con dos
// barridos, el agente hizo lo que había que hacer: reutilizar el ReconciliationClaimStore
// que build generó para el reclamable, en vez de escribir un segundo mecanismo. El único
// @Modifying del store vive en ReconciliationClaimJpaRepository, que la exclude filtra —
// así que el check pedía la implementación INCORRECTA, y su camino de menor resistencia
// era duplicar el mecanismo para callarlo.
test('llamar al store de reclamos que build generó cuenta como marca persistida', (t) => {
  const project = build('catalog-extended', dosBarridosUnoReclamable);
  const before = run(project);
  if (before === null) return t.skip('sin bash en el PATH');
  assert.ok(reports(before.out, 'reclamo del barrido'));

  const adapter = path.join(project, 'src/main/java/com/commerce/catalog/infrastructure/persistence');
  fs.mkdirSync(adapter, { recursive: true });
  const file = path.join(adapter, 'PendingSweepAdapter.java');
  const usandoElStore = [
    'package com.commerce.catalog.infrastructure.persistence;',
    '',
    'public class PendingSweepAdapter {',
    '',
    '    public java.util.List<java.util.UUID> claimForPendingSweep() {',
    '        java.util.List<java.util.UUID> candidates = repo.candidatesForPendingSweep(states, staleBefore, org.springframework.data.domain.PageRequest.of(0, batchSize));',
    '        java.util.List<java.util.UUID> claimed = new java.util.ArrayList<>();',
    '        for (java.util.UUID id : candidates) {',
    '            if (reconciliationClaims.claim("notifyRegistryChange", id, now, claimExpiredBefore)) {',
    '                claimed.add(id);',
    '            }',
    '        }',
    '        return claimed;',
    '    }',
    '}'
  ].join(String.fromCharCode(10));
  fs.writeFileSync(file, usandoElStore);

  const green = run(project).out;
  assert.ok(!reports(green, 'reclamo del barrido'), green);
  assert.ok(!reports(green, 'lote del barrido'), green);

  // Y leer en vez de reclamar sigue siendo rojo, que es lo que el check existe para ver.
  fs.writeFileSync(
    file,
    usandoElStore.replace(
      "if (reconciliationClaims.claim(" + JSON.stringify("notifyRegistryChange") + ", id, now, claimExpiredBefore))",
      "if (repo.findAllByStatus(states).contains(id))"
    )
  );
  assert.ok(reports(run(project).out, 'reclamo del barrido'));
});

// Los patrones de un check `claim` viajan por AWK además de por grep: methodBody los usa
// para recortar el bloque. awk no entiende \s, \. ni \( —se come el escape y deja una
// regexp desbalanceada que ABORTA el check—, y el efecto es un hallazgo falso que se lee
// igual que uno real. Pasó al añadir el patrón del store, y por eso hay guarda.
test('ningún patrón de un check claim usa escapes que awk no entiende', () => {
  const content = read(build('catalog-extended', dosBarridosUnoReclamable));
  const filas = content.split(String.fromCharCode(10)).filter((line) => line.startsWith('claim '));
  assert.ok(filas.length > 0, 'no hay checks claim que revisar');
  for (const fila of filas) {
    // Los dos primeros argumentos entrecomillados tras el sujeto son patrón y bound.
    const patrones = fila.match(/'[^']*'/g) ?? [];
    for (const patron of patrones.slice(2, 4)) {
      assert.ok(
        !/\\[sdwSDW.(){}]/.test(patron),
        `patrón con escape que awk no soporta: ${patron} — usa clases entre corchetes`
      );
    }
  }
});

test('el reclamo que build generó no cuenta como el reclamo que el agente debe escribir', () => {
  const content = read(build('catalog-extended', dosBarridosUnoReclamable));

  // Los tres checks del agente están: hay un barrido sin reclamo generado.
  for (const subject of ['reclamo del barrido', 'lote del barrido']) {
    assert.ok(content.includes(`'${subject}'`), `falta el check del agente: ${subject}`);
  }
  // Y llevan el descarte de lo que build generó para el OTRO barrido. Se descarta el
  // BLOQUE y no el archivo: el reclamo del agente cabe en el mismo adaptador, y
  // prohibírselo sería pedirle la implementación incorrecta.
  const rows = content.split(String.fromCharCode(10)).filter((line) => line.startsWith('claim '));
  // Los dos que se buscan POR BLOQUE. El del umbral queda fuera a sabiendas: mira el
  // archivo entero, así que descartarlo por bloque descartaría el adaptador completo — y
  // el umbral del barrido que el agente escribe cabe justo ahí. Ese sigue pudiendo salir
  // verde por el @Value que build generó para el otro barrido, y es una limitación
  // conocida: cerrarla pidiendo otra ubicación sería pedir la implementación incorrecta.
  const genericas = rows.filter((line) => /'(reclamo|lote) del barrido'/.test(line));
  assert.equal(genericas.length, 2, 'no se emitieron los dos checks genéricos con alcance de bloque');
  for (const row of genericas) {
    assert.match(row, /ReconcileWithdrawalsRecordWithdrawal/, row);
  }
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

  // Y la otra mitad de la compensación, que vive en el AGREGADO: devolver la fila a
  // su estado. Sin esto la familia sigue roja aunque el handler esté impecable, que
  // es justo lo que se le añadió al gate.
  const aggregate = javaFile(project, 'Product.java');
  if (!aggregate) return t.skip('sin bash en el PATH');
  fs.writeFileSync(aggregate, conReactivate(fs.readFileSync(aggregate, 'utf8')));

  const result = run(project);
  if (result === null) return t.skip('sin bash en el PATH');
  assert.ok(!/\[compensation\]/.test(result.out), result.out);
});

// El método semántico que la compensación necesita en el agregado. Se escribe aquí una
// sola vez porque lo usan dos tests: el de los comentarios (donde tiene que callar al
// gate) y el de abajo (donde su ausencia tiene que ponerlo rojo).
const conReactivate = (src) =>
  src.replace(
    /(private void transitionTo\()/,
    'public void reactivate() {\n        transitionTo(ProductStatus.ACTIVE);\n    }\n\n    $1'
  );

// Deshacer a medias es peor que no deshacer: deja al proveedor y al estado propio
// contando historias distintas. El gate exigía la llamada de vuelta y que no quedaran
// TODO, pero no que la fila volviera a su sitio — así que un handler que avisa fuera y
// no toca el lifecycle salía en verde.
test('compensación: sin la transición de vuelta en el agregado, el gate se pone rojo', (t) => {
  const project = build('catalog-extended');
  const aggregate = javaFile(project, 'Product.java');
  if (!aggregate) return t.skip('sin bash en el PATH');

  const result = run(project);
  if (result === null) return t.skip('sin bash en el PATH');
  assert.match(result.out, /\[compensation\][^\n]*estado de Product/, result.out);

  // Y con ella escrita, ese hallazgo concreto desaparece.
  const conTransicion = mutating(project, aggregate, conReactivate);
  if (conTransicion === null) return t.skip('sin bash en el PATH');
  assert.ok(
    !/\[compensation\][^\n]*estado de Product/.test(conTransicion.out),
    conTransicion.out
  );
});

// La cabecera de idempotencia saliente la cablea build, pero en ESE MISMO método deja
// los TODO del contract: completarlos es reescribir el RestClient alrededor de la línea
// de la cabecera. Perderla no rompe nada visible — el retry sigue funcionando y le
// encarga al proveedor el mismo trabajo otra vez.
test('outboundIdempotency: sin la cabecera cableada, el gate se pone rojo', (t) => {
  const project = build('catalog-extended');
  const adapter = javaFile(project, 'ComplianceHttpAdapter.java');
  if (!adapter) return t.skip('sin bash en el PATH');

  // Recién generado la cabecera YA está: es la única familia que sale verde sobre el
  // árbol de build, y esa asimetría es el dato — aquí build cablea también el uso.
  const limpio = run(project);
  if (limpio === null) return t.skip('sin bash en el PATH');
  assert.ok(!/\[outboundIdempotency\]/.test(limpio.out), limpio.out);

  // El defecto real que se reintroduce: una clave nueva en cada intento. No falla,
  // duplica — que es exactamente lo que la cabecera existe para evitar.
  const result = mutating(project, adapter, (src) =>
    src.replace(
      /OutboundIdempotency\.fromPayload\(\s*"recordWithdrawal"[^)]*\)/,
      'java.util.UUID.randomUUID().toString()'
    )
  );
  if (result === null) return t.skip('sin bash en el PATH');
  assert.match(result.out, /\[outboundIdempotency\][^\n]*recordWithdrawal/, result.out);
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
  // Acotado a SU familia: el mismo listener aparece tambien en payloadContract mientras
  // no llame a requireContract(), y eso es correcto — es otra comprobacion, no ruido.
  assert.ok(!/\[dedupe\] inventory\.events \(/.test(after.out), after.out);

  // Y no es un cheque de adorno: sin la rama `tryRecord` —la única guarda de la
  // suscripción que no tiene transición detrás— el hallazgo vuelve.
  fs.writeFileSync(
    path.join(dir, 'InventoryEventsListener.java'),
    fs.readFileSync(path.join(dir, 'InventoryEventsListener.java'), 'utf8').replace('!guard.tryRecord(eventId)', 'guard.alreadyProcessed(eventId)')
  );
  assert.match(run(project).out, /\[dedupe\] inventory\.events \(/);
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

// El contrato del payload ENTRANTE. Es la otra mitad de «no te fíes del broker»:
// `dedupe` vigila que un mensaje no se procese dos veces, y esto que lo que se procese
// traiga lo que el diseño prometió. Sin el check, `requireContract()` es un método que
// nadie llama — y el camino de menor resistencia es no llamarlo.
test('el gate exige que el listener compruebe el contrato del payload entrante', () => {
  const content = read(build('catalog-extended'));

  assert.ok(content.includes("'payloadContract'"), content.slice(0, 400));
  assert.ok(content.includes('\\.requireContract\\s*\\('), 'no exige la llamada');

  // Y dice DÓNDE va la llamada. Es la parte que no puede perderse: lanzar antes de
  // filtrar por eventType manda al descarte un mensaje ajeno perfectamente válido,
  // que es justo lo que el javadoc del contrato lleva avisando desde antes.
  assert.ok(content.includes('DESPUÉS del filtro por eventType'), content);
});

// Solo se exige lo que existe: un evento sin campos obligatorios no lleva
// `requireContract()` en su record, así que pedir la llamada sería pedir lo imposible
// — y un hallazgo imposible de resolver enseña a ignorar el gate entero.
test('una suscripción sin campos obligatorios no entra en payloadContract', () => {
  const service = loadService(fixture('catalog-extended'));
  for (const sub of Object.values(service.layers.messaging.subscriptions ?? {})) {
    for (const field of Object.values(sub.payload ?? {})) delete field.required;
  }
  const workspace = tmpDir('keel-idem-noreq-');
  const result = scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true });
  const content = fs.readFileSync(
    path.join(workspace, result.outDir, 'infra', 'check-idempotency.sh'),
    'utf8'
  );

  assert.ok(!content.includes("'payloadContract'"), 'exige un contrato que ningún record comprueba');
  // El resto del gate sigue en pie: lo que se apaga es una familia, no el script.
  assert.ok(content.includes("'dedupe'"), content.slice(0, 400));
});

// El control positivo. Que el gate salga rojo recién generado prueba que mira; que se
// apague al escribir la llamada prueba que mira lo correcto. Sin esta mitad, un check
// permanentemente en rojo pasaría por bueno y enseñaría a ignorarlo.
test('payloadContract se apaga cuando el listener llama a requireContract()', (t) => {
  const project = build('catalog-extended');
  const before = run(project);
  if (before === null) return t.skip('sin bash en el PATH');
  assert.match(before.out, /\[payloadContract\] SupplierPriceChanged/);

  const dir = path.join(project, 'src/main/java/com/commerce/catalog/infrastructure/messaging/subscriptions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SupplierPriceChangedListener.java'),
    `package com.commerce.catalog.infrastructure.messaging.subscriptions;

public class SupplierPriceChangedListener {

    private final IdempotencyGuard guard;

    public void onMessage(String eventType, String eventId, String payload) {
        if (!"SupplierPriceChanged".equals(eventType)) {
            return;
        }
        SupplierPriceChangedMessage message = parse(payload);
        message.requireContract();
        if (!guard.tryRecord(eventId)) {
            return;
        }
        dispatch(message);
    }
}
`
  );
  assert.ok(!/\[payloadContract\] SupplierPriceChanged/.test(run(project).out), run(project).out);
});
