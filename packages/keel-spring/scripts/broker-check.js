#!/usr/bin/env node
// Conformidad EN VIVO de la fontanería de brokers que emite `build`.
//
// Qué cubre y qué no. El generador habla con tres brokers por CLI desde el
// contenedor devtools —kcat, la API de gestión de RabbitMQ, la CLI de AWS contra
// LocalStack— y nada de eso se ejecuta en `npm test`: la suite compara cadenas y
// `compile-check` compila, pero entre "compila" y "el pipeline completo con agente
// lo prueba" no había ninguna red. Los comentarios de `integration-tests.js` son
// el registro de los bugs que solo aparecieron en vivo, cada uno al precio de una
// corrida entera del pipeline.
//
// **No arranca la aplicación**, a propósito: `AbstractFlowIT` es `@SpringBootTest`
// y el `main` recién generado no compila (build deja TODOs para el agente). Lo que
// sí es 100 % de `build` —y por tanto exigible en verde recién generado— es la capa
// de infraestructura y sondeo, que es exactamente donde viven esos bugs.
//
// Los comandos NO se escriben aquí: salen de `src/lib/broker-probes.js`, el mismo
// módulo del que el arnés renderiza su Java. Un runner con comandos propios
// comprobaría que los brokers responden, no que el generador acierta. La única
// excepción es BRK-11 —la palanca de detener y levantar el broker de los escenarios
// de outbox—, cuyos comandos son del runtime de contenedores y salen del catálogo
// (`brokerContainer`, `cliValidateCmd`), que es también de donde los saca el arnés.
//
//   node packages/keel-spring/scripts/broker-check.js [fixture] [--broker=<id>] [--keep]
//   npm run broker-check --workspace packages/keel-spring
//
// Salidas: 0 todo OK · 1 hay fallos · 2 la infraestructura no levantó (sin veredicto).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { deadLetterDestination, subscriptionDestination } from '../src/lib/dead-letter.js';
import { resolveStack, scaffoldService } from '../src/scaffold/index.js';
import { buildModel } from '../src/lib/model.js';
// El catálogo, no la lista de ids que exporta broker-probes con el mismo nombre: de
// aquí salen el comando de sondeo y el nombre del contenedor que estampa el compose.
import { BROKERS as BROKERS_CATALOG, brokerContainer } from '../src/lib/stack-catalog.js';
import {
  BROKERS,
  argv as toArgv,
  releaseParts,
  SQS_SWEEP_VISIBILITY,
  deliverParts,
  deliverShell,
  needsSingleLineBody,
  collapseToSingleLine,
  headersJson,
  isEmptyRead,
  offsetsParts,
  purgeParts,
  rabbitProbeBody,
  rabbitPublishBody,
  readParts,
  readAttemptLimit,
  READ_BATCH_LIMIT,
  READ_DEDUPE_KEY,
  sqsAttributesJson,
  UNKNOWN_TOPIC,
  ENDPOINTS,
  queueDeliverParts
} from '../src/lib/broker-probes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'test', 'fixtures');

const args = process.argv.slice(2);
const fixture = args.find((arg) => !arg.startsWith('--')) ?? 'catalog-extended';
const keep = args.includes('--keep');
const only = args.find((arg) => arg.startsWith('--broker='))?.split('=')[1];
const brokers = only ? [only] : BROKERS;

// ─── Ejecución de procesos ───────────────────────────────────────────────────

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error
  };
}

/**
 * Runtime y frontend de compose con la MISMA lógica que los scripts generados
 * (`CONTAINER_RUNTIME`, luego docker, luego podman), con una diferencia que solo
 * se ve en vivo: en Windows `podman compose` delega en el docker-compose.exe del
 * PATH, que no encuentra el named pipe de la máquina podman y falla con un error
 * de conexión. Por eso el fallback no se decide por disponibilidad sino por
 * resultado: se prueba y, si no conecta, se pasa a `podman-compose`.
 */
function resolveRuntime() {
  const preferred = process.env.CONTAINER_RUNTIME;
  const candidates = preferred ? [preferred] : ['docker', 'podman'];
  for (const runtime of candidates) {
    if (run(runtime, ['--version']).status !== 0) continue;
    const frontends =
      runtime === 'podman'
        ? [
            { command: 'podman', prefix: ['compose'] },
            { command: 'podman-compose', prefix: [] }
          ]
        : [{ command: 'docker', prefix: ['compose'] }];
    return { runtime, frontends };
  }
  return null;
}

function composeUp(frontends, projectDir) {
  const failures = [];
  for (const frontend of frontends) {
    const result = run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'up', '-d'], {
      cwd: projectDir
    });
    if (result.status === 0) return { frontend, log: result.stdout + result.stderr };
    failures.push(`${frontend.command}: ${(result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ')}`);
  }
  return { frontend: null, log: failures.join('\n') };
}

function composeDown(frontend, projectDir) {
  run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'down', '-v'], { cwd: projectDir });
}

// ─── El contenedor devtools: por donde pasan todos los comandos ──────────────

function makeDevtools(runtime, container, projectDir) {
  const exec = (parts) => run(runtime, ['exec', container, ...parts]);
  return {
    exec,
    shell: (line) => run(runtime, ['exec', container, 'sh', '-c', line]),
    copy: (content, remotePath) => {
      const local = path.join(projectDir, `.keel-probe-${path.basename(remotePath)}`);
      fs.writeFileSync(local, content, 'utf8');
      const result = run(runtime, ['cp', local, `${container}:${remotePath}`]);
      fs.rmSync(local, { force: true });
      return result;
    }
  };
}

// ─── Escenarios ──────────────────────────────────────────────────────────────
//
// Cada uno ataca una clase de fallo concreta que ya se ha pagado al menos una vez.

const BODY_FILE = '/tmp/keel-check-body.json';
const PROBE_FILE = '/tmp/keel-check-probe.json';
const ATTRS_FILE = '/tmp/keel-check-attrs.json';

// Cuerpo con lo que rompe el paso por `exec`/`cp`: comillas dobles, acentos y un
// `$` que una shell interpolaría.
const TRICKY = 'acentós, "comillas" y $HOME sin interpolar';

function scenarios(broker, context) {
  const { devtools, topic, subscriptionTopic, subscriptionQueue, subscriptionName, publishEventType, deadLetterQueue, deadLetterSource, resetDb } = context;
  // Todo lo que se publica en el canal propio viaja con su `eventType`: es lo que
  // discrimina dentro del destino único (filtro de la suscripción en SNS, filtrado
  // por canal en Kafka). Sin él, el broker descarta el mensaje con toda la razón y
  // el escenario mediría el filtro, no lo que dice medir.
  const outbound = publishEventType ? { eventType: publishEventType } : {};
  // Dónde se ENTREGA un mensaje entrante y dónde se LEE no siempre coinciden: en
  // snssqs se publica en el topic de la fuente y se lee de la cola del consumidor,
  // que cuelga de él por la suscripción con filtro. En kafka y rabbitmq es el
  // mismo destino.
  const inbound = subscriptionTopic ?? topic;
  const inboundRead = subscriptionQueue ?? inbound;

  const read = (destination, options = {}) => {
    if (broker === 'kafka') {
      return devtools.exec(toArgv(broker, readParts(broker, { destination, offset: options.offset ?? 'beginning' })));
    }
    if (broker === 'rabbitmq') {
      devtools.copy(rabbitProbeBody(options.count ?? 10), PROBE_FILE);
      return devtools.exec(toArgv(broker, readParts(broker, { destination, bodyFile: PROBE_FILE })));
    }
    return devtools.exec(
      toArgv(broker, readParts(broker, { destination, count: String(options.count ?? 10), hideSeconds: options.hideSeconds }))
    );
  };

  const deliver = (destination, key, body, headers = {}) => {
    // El mismo colapso que el arnés generado aplica antes de copiar, y de la MISMA
    // fuente: `kcat -l` manda un mensaje por línea, así que un cuerpo multilínea se
    // publicaría troceado. Si el runner no lo hiciera, probaría una entrega distinta
    // de la que el generador escribe — que es justo lo que este módulo existe para evitar.
    const wire = needsSingleLineBody(broker) ? collapseToSingleLine(body) : body;
    if (broker === 'kafka') {
      devtools.copy(wire, BODY_FILE);
      return devtools.shell(deliverShell({ destination, key, bodyFile: BODY_FILE, headers }));
    }
    if (broker === 'rabbitmq') {
      devtools.copy(
        rabbitPublishBody({
          // Con el binding en "#" cualquier routing key entrega; se usa la clave del
          // mensaje, que es lo que significa el parámetro.
          routingKey: key,
          key,
          headersJson: headersJson(headers),
          payloadBase64: Buffer.from(wire, 'utf8').toString('base64')
        }),
        BODY_FILE
      );
      return devtools.exec(toArgv(broker, deliverParts(broker, { destination, bodyFile: BODY_FILE })));
    }
    devtools.copy(wire, BODY_FILE);
    const withAttributes = Object.keys(headers).length > 0;
    if (withAttributes) devtools.copy(sqsAttributesJson(headers), ATTRS_FILE);
    return devtools.exec(
      toArgv(broker, deliverParts(broker, { destination, bodyFile: BODY_FILE, attrsFile: ATTRS_FILE, withAttributes }))
    );
  };

  const purge = (destination) => {
    const parts = purgeParts(broker, { destination });
    return parts ? devtools.exec(toArgv(broker, parts)) : { status: 0, stdout: '', stderr: '' };
  };

  /**
   * Lee hasta juntar `expected` apariciones del marcador. Hace falta por dos
   * razones que no son del generador: la entrega SNS→SQS no es instantánea, y una
   * lectura de SQS puede devolver menos mensajes de los que hay aunque estén todos
   * (long polling sobre varios servidores). Sin esto, un "solo llegó 1" no
   * distinguiría "el broker deduplicó" —que es lo que BRK-7 juzga— de "aún no ha
   * llegado el segundo".
   */
  /**
   * Junta hasta `count` mensajes DISTINTOS, con la misma orquestación que el arnés generado:
   * lotes del tamaño que el broker admite, dedupe por su clave y la misma cota de intentos.
   *
   * Existe porque `readUntil` cuenta dentro de UNA respuesta, y por eso este runner no podía
   * ver —y no vio— el defecto que una corrida encontró: con más de diez mensajes el arnés
   * pide dos lotes, el segundo repesca del primero (con `--visibility-timeout 0` un mensaje
   * leído vuelve a estar visible al instante) y el conteo salía inflado. Leyendo de una sola
   * vez, ese camino no se recorre.
   */
  /**
   * Todos los mensajes distintos de un destino, leyendo por lotes donde el broker lo acota.
   *
   * Con snssqs esto es un BARRIDO, no una lectura: oculta lo que devuelve para poder avanzar y
   * lo suelta al terminar. El porqué está en `SQS_SWEEP_VISIBILITY` — sin ocultar hay un techo
   * duro de 10 y el barrido devuelve siempre los mismos diez primeros.
   */
  const readAll = (destination, count) => {
    const limit = READ_BATCH_LIMIT[broker];
    const perCall = Number.isFinite(limit) ? limit : count;
    const sweeping = Number.isFinite(limit) && count > perCall;
    const seen = new Map();
    const handles = [];
    const attempts = readAttemptLimit(broker, count);
    try {
      for (let attempt = 0; attempt < attempts && seen.size < count; attempt++) {
        const size = Math.min(count - seen.size, perCall);
        const options = { count: size, hideSeconds: sweeping ? SQS_SWEEP_VISIBILITY : undefined };
        const batch = keyedMessages(broker, read(destination, options).stdout);
        // Barriendo, un lote CORTO no prueba nada: lo devuelto queda oculto, así que el único
        // final fiable es el lote vacío. Sin ocultar, el lote corto sí es el final.
        if (batch.length === 0) break;
        for (const message of batch) {
          if (message.handle) handles.push(message.handle);
          if (!seen.has(message.key)) seen.set(message.key, message.body);
        }
        if (!sweeping && batch.length < size) break;
        sleep(500);
      }
    } finally {
      // Se suelta SIEMPRE, también si un escenario revienta a mitad: dejar el buzón ciego
      // haría fallar a los escenarios siguientes por algo que no es suyo.
      for (const handle of handles) {
        const parts = releaseParts(broker, { destination, receiptHandle: handle });
        if (parts) devtools.exec(toArgv(broker, parts));
      }
    }
    return [...seen.values()];
  };

  const readUntil = (destination, marker, expected, attempts = 8) => {
    let best = [];
    for (let attempt = 0; attempt < attempts; attempt++) {
      // Se cuenta dentro de UNA respuesta, no acumulando entre lecturas: SQS lee
      // con `--visibility-timeout 0`, así que el mismo mensaje vuelve en la lectura
      // siguiente y sumar daría dos copias donde solo hay una.
      const found = payloadsOf(broker, read(destination, { count: 10 }).stdout).filter((payload) =>
        payload.includes(marker)
      );
      if (found.length > best.length) best = found;
      if (best.length >= expected) break;
      sleep(1500);
    }
    return best;
  };

  /**
   * Entrega a la cola de descarte, que no se alcanza igual en los tres brokers: una DLQ no
   * cuelga de ningún canal —se llega a ella por redrive en snssqs y por el argumento
   * x-dead-letter-routing-key en rabbitmq—, así que en los dos hay que enviar DIRECTO a la
   * cola: no existe topic ni exchange con su nombre. En kafka el destino se nombra igual se
   * publique donde se publique y vale la entrega normal.
   */
  const deliverToDeadLetter = (marker) => {
    if (broker === 'kafka') return deliver(deadLetterQueue, marker, JSON.stringify({ marker }));
    const body = JSON.stringify({ marker });
    if (broker === 'rabbitmq') {
      // El sobre de la API de gestión, con la routing key puesta al NOMBRE DE LA COLA: es
      // así como entrega el exchange por defecto.
      devtools.copy(
        rabbitPublishBody({
          routingKey: deadLetterQueue,
          key: marker,
          headersJson: headersJson({}),
          payloadBase64: Buffer.from(body, 'utf8').toString('base64')
        }),
        BODY_FILE
      );
    } else {
      devtools.copy(body, BODY_FILE);
    }
    return devtools.exec(
      toArgv(broker, queueDeliverParts(broker, { destination: deadLetterQueue, bodyFile: BODY_FILE }))
    );
  };

  /** Espera a que el marcador sea visible en el descarte: entregar no es haber llegado. */
  const deadLetterHas = (marker) =>
    untilOk(() => {
      const result = read(deadLetterQueue);
      return result.status === 0 && result.stdout.includes(marker)
        ? result
        : { ...result, status: result.status === 0 ? 1 : result.status };
    });

  /**
   * Lo contrario, y hace falta por la misma razón que `readUntil`: una purga no es
   * instantánea, y afirmar "vacío" en la primera lectura confundiría "se purgó" con
   * "todavía no se ve". La lectura no consume (peek con requeue en RabbitMQ,
   * `--visibility-timeout 0` en SQS), así que reintentar no altera lo que mide.
   */
  const untilEmpty = (destination, attempts = 6) => {
    let last = { status: 0, stdout: '', stderr: '' };
    for (let attempt = 0; attempt < attempts; attempt++) {
      last = read(destination, { count: 10 });
      if (isEmptyRead(broker, last.stdout)) return { ok: true, last };
      sleep(1000);
    }
    return { ok: false, last };
  };

  return [
    {
      id: 'BRK-1',
      title: 'el destino de publicación existe o falla de forma reconocible',
      // Dos exigencias distintas según quién siembra la topología. En snssqs y
      // RabbitMQ el destino tiene que existir ya: el fallo histórico era arrancar
      // contra una cola inexistente y morir con NonExistentQueue en el primer
      // escenario. En Kafka el topic nace al primer PRODUCE, así que lo que se
      // exige es lo contrario: que leer antes de publicar falle con el error que
      // el arnés traduce a "no hay mensajes". Si Kafka cambiara ese texto, la
      // tolerancia del arnés se rompería en silencio y solo se vería aquí.
      check: () => {
        const result = read(topic);
        if (result.status === 0) return ok();
        if (broker === 'kafka' && (result.stdout + result.stderr).includes(UNKNOWN_TOPIC)) return ok();
        return ko(`lectura falló: ${firstLine(result.stderr || result.stdout)}`);
      }
    },
    {
      id: 'BRK-2',
      title: 'publicar con marcador único y leerlo de vuelta',
      // Topic/cola físicos equivocados, y kcat sin `-C` (que saldría en verde y mudo).
      check: () => {
        const marker = `keel-${Date.now()}`;
        const sent = deliver(topic, marker, `{"marker":"${marker}"}`, outbound);
        if (sent.status !== 0) return ko(`entrega falló: ${firstLine(sent.stderr || sent.stdout)}`);
        const back = readUntil(topic, marker, 1);
        return back.length > 0
          ? ok()
          : ko('el mensaje publicado no vuelve en la lectura');
      }
    },
    {
      id: 'BRK-3',
      title: 'un cuerpo con comillas, acentos y $ vuelve intacto',
      // Escapado por `exec`/`cp`: en Windows el cliente de contenedores corrompe
      // las comillas de un JSON y el fallo aparece lejos de su causa.
      check: () => {
        // Igualdad EXACTA contra el cuerpo enviado, no `includes`: lo que se juzga
        // es que no se pierda ni se altere un solo byte por el camino.
        const body = JSON.stringify({ text: TRICKY });
        const sent = deliver(topic, 'tricky', body, outbound);
        if (sent.status !== 0) return ko(`entrega falló: ${firstLine(sent.stderr || sent.stdout)}`);
        const back = readUntil(topic, body, 1);
        return back.includes(body)
          ? ok()
          : ko(`el cuerpo no vuelve byte a byte: ${firstLine(back[back.length - 1] ?? '(nada)')}`);
      }
    },
    {
      id: 'BRK-3b',
      title: 'un cuerpo MULTILÍNEA llega como UN solo mensaje',
      // El defecto que costó cinco escenarios en la corrida de notifications-spring:
      // `kcat -l` manda un mensaje POR LÍNEA del archivo, y un payload escrito como
      // text block Java —la forma natural de escribir JSON en un escenario— llegaba
      // troceado en varios mensajes indeserializables. BRK-3 no podía verlo: su cuerpo
      // sale de `JSON.stringify`, que escapa cualquier salto, así que por construcción
      // nunca lleva uno de verdad.
      check: () => {
        const marker = `multiline-${Date.now()}`;
        const pretty = JSON.stringify({ marker, text: TRICKY, n: 1 }, null, 2);
        if (!/[\r\n]/.test(pretty)) return ko('el cuerpo de prueba no es multilínea');
        const sent = deliver(topic, 'multiline', pretty, outbound);
        if (sent.status !== 0) return ko(`entrega falló: ${firstLine(sent.stderr || sent.stdout)}`);
        // El marcador de búsqueda NO puede ser TRICKY, y esto llevaba fallando por eso en los
        // TRES brokers: TRICKY lleva comillas y dentro del cuerpo JSON viajan ESCAPADAS, así
        // que un `includes` literal sobre el cuerpo crudo no casa jamás. El escenario se
        // estaba suspendiendo a sí mismo por su marcador, no por el canal.
        //
        // Se busca por un token sin comillas —lo que se juzga aquí es CUÁNTOS mensajes
        // volvieron, no su forma— y el contenido se comprueba abajo, ya parseado, que es
        // donde el escapado deja de estorbar.
        const back = readUntil(topic, marker, 1);
        const hits = back.filter((line) => line.includes(marker));
        if (hits.length === 0) return ko('el cuerpo multilínea no vuelve en la lectura');
        if (hits.length > 1) return ko(`el cuerpo se troceó en ${hits.length} mensajes`);
        // Y sigue siendo JSON válido tras el colapso: los saltos estaban fuera de las
        // cadenas, que es la premisa de colapsarlos.
        try {
          const parsed = JSON.parse(hits[0]);
          return parsed.text === TRICKY ? ok() : ko('el contenido no sobrevive al colapso');
        } catch (error) {
          return ko(`el mensaje entregado no es JSON válido: ${error.message}`);
        }
      }
    },
    {
      id: 'BRK-4',
      title: 'purgar deja la lectura vacía según el predicado del broker',
      // Aislamiento entre flujos. En Kafka no hay purga posible: su equivalente es
      // la marca de offset, que es lógica del arnés y no del canal — se comprueba
      // que los offsets avancen, que es de lo que depende la marca.
      check: () => {
        if (broker === 'kafka') {
          const before = lastOffset(devtools, topic);
          deliver(topic, 'offset-probe', '{"n":1}', outbound);
          const after = lastOffset(devtools, topic);
          return after > before ? ok() : ko(`el offset no avanza (${before} → ${after})`);
        }
        deliver(topic, 'to-purge', '{"n":1}', outbound);
        const purged = purge(topic);
        if (purged.status !== 0) return ko(`purga falló: ${firstLine(purged.stderr || purged.stdout)}`);
        const after = read(topic, { count: 1 });
        return isEmptyRead(broker, after.stdout) ? ok() : ko(`tras purgar sigue habiendo mensajes: ${firstLine(after.stdout)}`);
      }
    },
    {
      id: 'BRK-6',
      title: 'las cabeceras del mensaje entregado llegan al broker',
      // La mitad ENTRANTE del arnés: el discriminador y la clave de deduplicación
      // viajan en cabeceras, y sin ellas ninguna suscripción con contract es
      // ejercitable.
      check: () => {
        const marker = `hdr-${Date.now()}`;
        // El discriminador del diseño va en la cabecera: es lo que decide si el
        // mensaje llega (filtro de la suscripción en SNS, binding en Rabbit) y lo
        // que el listener usa para descartar lo que no es suyo.
        const sent = deliver(inbound, marker, `{"marker":"${marker}"}`, {
          eventType: subscriptionName ?? 'ProbeEvent',
          messageId: marker
        });
        if (sent.status !== 0) return ko(`entrega con cabeceras falló: ${firstLine(sent.stderr || sent.stdout)}`);
        const back = headersOf(broker, devtools, inboundRead, marker);
        return back.includes(marker) ? ok() : ko('el mensaje con cabeceras no llega a su destino');
      }
    },
    {
      id: 'BRK-7',
      title: 'entregar dos veces el mismo messageId entrega los dos mensajes',
      // El escenario del que depende TODA la obligación de reentrega: si el broker
      // deduplicase por su cuenta, el escenario de compensación pasaría en verde
      // sin haber probado nada.
      check: () => {
        purge(inboundRead);
        const marker = `dup-${Date.now()}`;
        const body = `{"marker":"${marker}"}`;
        for (let attempt = 0; attempt < 2; attempt++) {
          const sent = deliver(inbound, marker, body, {
            eventType: subscriptionName ?? 'ProbeEvent',
            messageId: marker
          });
          if (sent.status !== 0) return ko(`entrega ${attempt + 1} falló: ${firstLine(sent.stderr || sent.stdout)}`);
        }
        const copies = readUntil(inboundRead, marker, 2).length;
        return copies >= 2 ? ok() : ko(`el broker entregó ${copies} copia(s): la reentrega no es ejercitable`);
      }
    },
    {
      id: 'BRK-14',
      title: 'leer más mensajes de los que cabe en una llamada no los cuenta dos veces',
      // El escenario que faltaba, y que se echa de menos por lo que dejó pasar: el arnés
      // pide por lotes cuando el broker acota la llamada, y con `--visibility-timeout 0`
      // un mensaje leído vuelve a estar visible AL INSTANTE — así que el lote siguiente
      // puede repescarlo. Durante cuatro corridas el conteo salió inflado con más de diez
      // mensajes, y el gate en vivo no podía verlo porque leía de UNA vez lo que el arnés
      // lee por lotes.
      //
      // El modo de fallo es el peor: un conteo inflado ACUSA de duplicar eventos a un
      // servicio que no duplica ninguno, y se arbitra contra código correcto.
      check: () => {
        const wanted = (READ_BATCH_LIMIT[broker] === Infinity ? 10 : READ_BATCH_LIMIT[broker]) + 5;
        purge(topic);
        const marker = `bulk-${Date.now()}`;
        for (let n = 0; n < wanted; n++) {
          const sent = deliver(topic, `${marker}-${n}`, `{"marker":"${marker}","n":${n}}`, outbound);
          if (sent.status !== 0) return ko(`entrega ${n + 1} falló: ${firstLine(sent.stderr || sent.stdout)}`);
        }
        // Se piden MÁS de los publicados a propósito: así el bucle agota sus intentos
        // repescando, que es justo la condición en la que el conteo se inflaba.
        const distinct = readAll(topic, wanted + 5).filter((body) => body.includes(marker));
        if (distinct.length === wanted) return ok();
        return distinct.length > wanted
          ? ko(`se contaron ${distinct.length} mensajes habiendo publicado ${wanted}: la lectura repesca`)
          : ko(`solo llegaron ${distinct.length} de ${wanted} mensajes publicados`);
      }
    },
    {
      id: 'BRK-9',
      title: 'sondear un destino virgen no revienta',
      // Regresión ya documentada en `safeNextOffset`: contra un broker recién
      // levantado el topic no existe y kcat sale con código 1, que el arnés
      // convertía en excepción justo en el primer flujo de la suite.
      check: () => {
        const virgin = `keel-virgin-${Date.now()}`;
        if (broker === 'kafka') {
          const result = devtools.exec(toArgv(broker, offsetsParts({ destination: virgin, format: '%o\\n' })));
          // Lo que se exige no es que salga 0, sino que el fallo sea reconocible:
          // el arnés lo traduce a marca 0. Un cuelgue o un éxito mudo sí serían bugs.
          return result.status === 0 || /unknown topic/i.test(result.stderr)
            ? ok()
            : ko(`fallo no reconocible: ${firstLine(result.stderr || result.stdout)}`);
        }
        const result = read(virgin, { count: 1 });
        return result.status !== 0 || isEmptyRead(broker, result.stdout)
          ? ok()
          : ko('un destino inexistente devuelve algo que parece un mensaje');
      }
    },
    ...(deadLetterQueue ? [{
      id: 'BRK-12',
      title: 'el destino de descarte existe y se lee con el nombre que el arnés usa',
      // Cierra el falso verde más peligroso del arnés. `deadLetterMessages(...)` se usa
      // sobre todo en NEGATIVO —«el mensaje se confirma sin acabar en la DLQ»—, y una
      // lectura contra una cola que no existe devuelve vacío: la aserción pasaría para
      // siempre sin mirar nada. Ya ocurrió en el propio generador, donde la primera
      // versión del helper componía el nombre desde el topic y en SNS/SQS el consumidor
      // tiene cola propia.
      //
      // Lo que NO puede probar este check: que el broker MUEVA ahí un mensaje agotado.
      // Eso exige la aplicación viva rechazando el mensaje, y aquí no se arranca (el
      // `main` recién generado ni siquiera compila). Su gate es un escenario `FL-*`.
      check: () => {
        const marker = `keel-dlq-${Date.now()}`;
        deliverToDeadLetter(marker);
        const back = deadLetterHas(marker);
        if (!back.ok) {
          return ko(`entregado a '${deadLetterQueue}' y no vuelve: ${firstLine(back.last.stderr || back.last.stdout)}`);
        }
        if (broker !== 'snssqs') return ok();
        // Y en SQS, además, que el enlace exista de verdad. La cola de descarte puede
        // estar creada y la RedrivePolicy no haberse aplicado: entonces el mensaje
        // agotado se reentrega para siempre en vez de apartarse, y la cola que el
        // escenario mira está vacía por una razón que no es la que cree.
        const attributes = devtools.exec([
          ...toArgv(broker, []),
          'sqs',
          'get-queue-attributes',
          '--queue-url',
          `${ENDPOINTS.snssqs.queueUrlPrefix}${deadLetterSource}`,
          '--attribute-names',
          'RedrivePolicy'
        ]);
        if (attributes.status !== 0) {
          return ko(`no se pueden leer los atributos de '${deadLetterSource}': ${firstLine(attributes.stderr)}`);
        }
        return attributes.stdout.includes(deadLetterQueue)
          ? ok()
          : ko(`la RedrivePolicy de '${deadLetterSource}' no apunta a '${deadLetterQueue}': ${firstLine(attributes.stdout)}`);
      }
    }] : []),
    ...(deadLetterQueue && broker !== 'kafka' ? [{
      id: 'BRK-13',
      title: 'reset-db.sh vacía también el destino de descarte',
      // El respaldo de que el descarte entra en el reset. BRK-10 solo mira el código
      // de salida del script, y un destino que no se purga NO lo pone en rojo: las
      // purgas son tolerantes a fallo a propósito (que la cola aún no exista no es
      // estado sucio). O sea que la fila que promete «estado limpio» saldría verde con
      // el descarte intacto, que es justo el arrastre que se quería cerrar: un mensaje
      // muerto sobrevive al reset y contamina el flujo siguiente, y como la aserción
      // sobre el descarte suele ser NEGATIVA —«se absorbió sin acabar en la DLQ»—, no
      // aparece como ruido sino como un escenario fallando por algo ajeno.
      //
      // Va el último de los escenarios porque borra estado; BRK-10 vuelve a ejecutar el
      // script después, que es idempotente.
      check: () => {
        const marker = `keel-reset-dlq-${Date.now()}`;
        const sent = deliverToDeadLetter(marker);
        if (sent.status !== 0) {
          return ko(`entrega al descarte falló: ${firstLine(sent.stderr || sent.stdout)}`);
        }
        // Antes de resetear hay que VER el mensaje: purgar una cola en la que el
        // marcador todavía no ha aterrizado dejaría el escenario verde sin haber
        // purgado nada, que es el mismo falso verde que cierra BRK-12.
        const landed = deadLetterHas(marker);
        if (!landed.ok) {
          return ko(`el marcador no llega a '${deadLetterQueue}': ${firstLine(landed.last.stderr || landed.last.stdout)}`);
        }
        const reset = resetDb();
        if (reset.status !== 0) {
          return ko(`reset-db.sh falló: ${firstLine(reset.stderr || reset.stdout)}`);
        }
        const empty = untilEmpty(deadLetterQueue);
        return empty.ok
          ? ok()
          : ko(`tras el reset sigue habiendo mensajes en '${deadLetterQueue}': ${firstLine(empty.last.stdout)}`);
      }
    }] : [])
  ];
}

// ─── Utilidades de escenario ─────────────────────────────────────────────────

const ok = () => ({ ok: true });
const ko = (detail) => ({ ok: false, detail });

function firstLine(text) {
  return (text ?? '').trim().split('\n')[0] ?? '';
}

/**
 * Los cuerpos de los mensajes leídos, ya desenvueltos de lo que cada CLI añade.
 * No basta con buscar el texto en la salida cruda: RabbitMQ y SQS devuelven el
 * mensaje DENTRO de un JSON, así que sus comillas vuelven escapadas otra vez y una
 * comparación literal fallaría por la envoltura, no por el contenido. Esto es
 * reimplementar el desenvuelto que hace el arnés — orquestación, no canal.
 */
/**
 * Los mensajes de una respuesta con su CLAVE de deduplicación, cuando el broker la tiene.
 *
 * Es lo que `payloadsOf` no puede dar: aquel devuelve solo los cuerpos, y dos apariciones del
 * mismo mensaje son indistinguibles ahí. La clave sale de `READ_DEDUPE_KEY`, la misma tabla de
 * la que el arnés renderiza su Java.
 */
function keyedMessages(broker, output) {
  const key = READ_DEDUPE_KEY[broker];
  const text = (output ?? '').trim();
  if (!key || !text) return payloadsOf(broker, output).map((body, index) => ({ key: String(index), body }));
  try {
    return (JSON.parse(text).Messages ?? []).map((message) => ({
      key: message[key],
      body: message.Body,
      handle: message.ReceiptHandle
    }));
  } catch {
    return [];
  }
}

function payloadsOf(broker, output) {
  const text = (output ?? '').trim();
  if (!text) return [];
  if (broker === 'kafka') return text.split(/\r?\n/).filter(Boolean);
  try {
    if (broker === 'rabbitmq') {
      return JSON.parse(text).map((message) =>
        message.payload_encoding === 'base64'
          ? Buffer.from(message.payload, 'base64').toString('utf8')
          : message.payload
      );
    }
    return (JSON.parse(text).Messages ?? []).map((message) => message.Body);
  } catch {
    // Una salida que no es el JSON esperado es en sí un hallazgo: se devuelve
    // cruda para que el escenario falle con el texto delante.
    return [text];
  }
}

function lastOffset(devtools, topic) {
  const result = devtools.exec(toArgv('kafka', offsetsParts({ destination: topic, format: '%o\\n' })));
  if (result.status !== 0) return -1;
  const offsets = result.stdout
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isInteger(value));
  return offsets.length > 0 ? Math.max(...offsets) : -1;
}

/** Lectura cruda con las cabeceras visibles, que cada CLI expone a su manera. */
function headersOf(broker, devtools, destination, marker) {
  if (broker === 'kafka') {
    return devtools.exec(['kcat', '-C', '-b', 'kafka:29092', '-t', destination, '-o', 'beginning', '-e', '-q', '-f', '%h %s\\n'])
      .stdout;
  }
  if (broker === 'rabbitmq') {
    devtools.copy(rabbitProbeBody(10), PROBE_FILE);
    return devtools.exec(toArgv(broker, readParts(broker, { destination, bodyFile: PROBE_FILE }))).stdout;
  }
  return devtools.exec([
    ...toArgv(broker, readParts(broker, { destination, count: '10' })),
    '--message-attribute-names',
    'All'
  ]).stdout;
}

// ─── Preparación por broker ──────────────────────────────────────────────────
//
// Lo que el runner tiene que arreglar por su cuenta, y por qué no es trampa: la
// topología de RabbitMQ la declara la APLICACIÓN al arrancar (Spring AMQP), y este
// check no arranca la aplicación. Declarar las colas aquí es preparar el terreno,
// no sustituir lo que se está probando — en snssqs, en cambio, la topología sí es
// de `build` (init-messaging.sh) y por eso se ejecuta el script generado.
function prepare(broker, { devtools, runtime, projectDir, destinations, topology = [] }) {
  if (broker === 'snssqs') {
    // La primera pasada espera: sembrar es lo primero que se hace tras `up` y
    // LocalStack publica su listener bastante después de arrancar el contenedor,
    // igual que asume validate-infra.sh con sus reintentos.
    const first = untilOk(() =>
      run('sh', ['infra/init-messaging.sh'], { cwd: projectDir, env: { ...process.env, CONTAINER_RUNTIME: runtime } })
    );
    if (!first.ok) return `init-messaging.sh no llegó a sembrar: ${firstLine(first.last.stderr || first.last.stdout)}`;
    // Y una segunda inmediata, que es la que juzga la IDEMPOTENCIA: el script se
    // reejecuta tras cada `up`, y un create-topic que fallara al encontrarlo ya
    // creado rompería el arranque a partir del segundo día.
    const again = run('sh', ['infra/init-messaging.sh'], {
      cwd: projectDir,
      env: { ...process.env, CONTAINER_RUNTIME: runtime }
    });
    return again.status === 0
      ? null
      : `init-messaging.sh no es idempotente: falla al reejecutarse — ${firstLine(again.stderr || again.stdout)}`;
  }
  if (broker === 'rabbitmq') {
    // La topología de RabbitMQ la declara la APLICACIÓN al arrancar (Spring AMQP, desde el
    // `RabbitTopologyConfig` que genera build), y este check no arranca la aplicación:
    // declararla aquí es preparar el terreno, no sustituir lo que se prueba.
    //
    // Pero tiene que ser LA MISMA FORMA. Antes se declaraban colas planas con el nombre del
    // destino y se entregaba por `amq.default`, que enruta por nombre de cola: contra esa
    // topología —fabricada por el propio runner— la entrega funcionaba siempre. La real es
    // un EXCHANGE con una cola bindeada, y ahí `amq.default` no entrega nada. El gate salía
    // verde sobre un comando que en un servicio de verdad descartaba el mensaje en silencio,
    // y así sobrevivió hasta que lo destapó una corrida (`corrida-mail-rabbit`).
    const api = (path) => `http://rabbitmq:15672/api/${path}`;
    const put = (path, body) =>
      untilOk(() =>
        devtools.exec([
          'curl', '-sf', '-u', 'guest:guest', '-H', 'content-type: application/json',
          '-XPUT', '-d', body, api(path)
        ])
      );
    const post = (path, body) =>
      untilOk(() =>
        devtools.exec([
          'curl', '-sf', '-u', 'guest:guest', '-H', 'content-type: application/json',
          '-XPOST', '-d', body, api(path)
        ])
      );

    for (const { exchange, queue } of topology) {
      if (!put(`exchanges/%2F/${exchange}`, '{"type":"topic","durable":true}').ok) {
        return `no se pudo declarar el exchange '${exchange}'`;
      }
      if (!put(`queues/%2F/${queue}`, '{"durable":true}').ok) return `no se pudo declarar la cola '${queue}'`;
      // El binding en "#" es el que emite build: el canal transporta todo lo del emisor y
      // el filtro por eventType va en el listener.
      if (!post(`bindings/%2F/e/${exchange}/q/${queue}`, '{"routing_key":"#"}').ok) {
        return `no se pudo bindear '${queue}' a '${exchange}'`;
      }
    }
    // Lo que no cuelga de ningún exchange —el descarte, que se alcanza por argumentos de
    // cola y no por binding— sigue siendo una cola suelta.
    for (const queue of destinations) {
      if (!put(`queues/%2F/${queue}`, '{"durable":true}').ok) return `no se pudo declarar la cola '${queue}'`;
    }
  }
  return null;
}

/**
 * La secuencia de `stopBroker()` / `startBroker()` del arnés, contra la infra real.
 * Mismos comandos que emite `integration-tests.js`: `<runtime> stop|start <nombre>`,
 * el sondeo con el `cliValidateCmd` del catálogo y —solo donde hace falta— la
 * resiembra con el script generado.
 */
function checkBrokerControl(broker, { runtime, projectDir, devtools, container }) {
  const entry = BROKERS_CATALOG[broker];
  const stopped = run(runtime, ['stop', container]);
  if (stopped.status !== 0) {
    return ko(`no se pudo detener '${container}': ${firstLine(stopped.stderr || stopped.stdout)}`);
  }
  // Con el broker parado el sondeo TIENE que fallar. Si sale verde, o el nombre del
  // contenedor no es el del broker o el sondeo no mide lo que dice medir — y en
  // cualquiera de los dos casos el escenario de outbox estaría comprobando que la
  // API responde mientras el broker sigue vivo, que es exactamente el escenario
  // decorativo que se quería evitar.
  const whileDown = devtools.shell(entry.cliValidateCmd);
  if (whileDown.status === 0) {
    return ko(`el sondeo sigue en verde con '${container}' detenido: no está midiendo al broker`);
  }
  const started = run(runtime, ['start', container]);
  if (started.status !== 0) {
    return ko(`no se pudo levantar '${container}': ${firstLine(started.stderr || started.stdout)}`);
  }
  const ready = untilOk(() => devtools.shell(entry.cliValidateCmd), 20, 3000);
  if (!ready.ok) {
    return ko(`el broker no volvió a aceptar conexiones: ${firstLine(ready.last.stderr || ready.last.stdout)}`);
  }
  // La topología después del reinicio. LocalStack la sirve desde memoria y la pierde,
  // así que el arnés resiembra; si algún día dejara de perderla, esto seguiría en
  // verde (el script es idempotente) y la resiembra sería solo trabajo de más.
  if (broker === 'snssqs') {
    const reseeded = run('sh', ['infra/init-messaging.sh'], {
      cwd: projectDir,
      env: { ...process.env, CONTAINER_RUNTIME: runtime }
    });
    if (reseeded.status !== 0) {
      return ko(`la resiembra tras el reinicio falló: ${firstLine(reseeded.stderr || reseeded.stdout)}`);
    }
  }
  // El veredicto final es el gate de infraestructura completo: no basta con que el
  // broker responda, tiene que estar como lo dejamos.
  const validate = run('sh', ['infra/validate-infra.sh'], {
    cwd: projectDir,
    env: { ...process.env, CONTAINER_RUNTIME: runtime }
  });
  return validate.status === 0
    ? ok()
    : ko(`la infraestructura no queda sana tras el ciclo: ${firstLine(validate.stderr || validate.stdout)}`);
}

/** Reintenta mientras el broker termina de arrancar: 'Up' no es 'listo'. */
/** El destino de descarte de la primera suscripción que lo declare, o null. */
function deadLetterFor(broker, model) {
  const subscription = (model.subscriptions ?? []).find((sub) => sub.deadLetter);
  return subscription ? deadLetterDestination(broker, model, subscription) : null;
}

function untilOk(action, attempts = 10, delayMs = 3000) {
  let last = { status: 1, stdout: '', stderr: '' };
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = action();
    if (last.status === 0) return { ok: true, last };
    sleep(delayMs);
  }
  return { ok: false, last };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ─── Corrida ─────────────────────────────────────────────────────────────────

function checkBroker(broker, runtimeInfo) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `keel-broker-${broker}-`));
  const results = [];
  let frontend = null;
  let projectDir = null;
  try {
    const service = loadService(path.join(fixturesDir, fixture));
    if (service.errors.length > 0) {
      return { fatal: `la fixture no carga: ${service.errors.join(' · ')}`, results };
    }
    scaffoldService({
      manifest: service.manifest,
      layers: service.layers,
      workspace,
      force: true,
      stack: { broker }
    });
    // Con el MISMO stack que el proyecto: los nombres físicos de topics y colas
    // los sanea el broker elegido (SQS no admite puntos), así que un modelo sin
    // stack sondearía destinos que no existen.
    const stack = resolveStack({ broker }, service.layers, service.manifest);
    const model = buildModel({ manifest: service.manifest, layers: service.layers, stack });
    model.stack = stack;
    const projectName = fs
      .readdirSync(path.join(workspace, 'services'), { withFileTypes: true })
      .find((entry) => entry.isDirectory()).name;
    projectDir = path.join(workspace, 'services', projectName);

    process.stdout.write(`${broker}: levantando infraestructura… `);
    const up = composeUp(runtimeInfo.frontends, projectDir);
    if (!up.frontend) return { fatal: `no levanta:\n${up.log}`, results };
    frontend = up.frontend;
    console.log(`OK (${up.frontend.command})`);

    const topic = model.messaging?.destinationDefault;
    const subscriptionTopic = (model.subscriptions ?? [])[0]?.topicDefault ?? null;
    // El nombre del contenedor lo fija `devtoolsService(...)` a partir del servicio.
    const devtools = makeDevtools(runtimeInfo.runtime, `${model.service.name}-devtools`, projectDir);

    // La topología ANTES de validar, que es el orden que documenta el agente de
    // infraestructura: `validate-infra.sh` comprueba que cada topic y cada cola
    // EXISTAN —es lo que separa "LocalStack responde" de "la topología está
    // sembrada"—, así que sembrarlas después dejaría el gate en rojo por algo que
    // todavía no ha pasado.
    // En rabbitmq la topología son PARES exchange→cola, y los dos nombres salen de build:
    // el canal propio se lee de una cola homónima (publishedDestination) y el ajeno de la
    // cola del consumidor (subscriptionDestination). Componerlos aquí a mano sería volver a
    // medir una topología distinta de la que se genera.
    const firstSub = (model.subscriptions ?? [])[0] ?? null;
    const rabbitTopology =
      broker === 'rabbitmq'
        ? [
            topic ? { exchange: topic, queue: topic } : null,
            firstSub && subscriptionTopic
              ? { exchange: subscriptionTopic, queue: subscriptionDestination('rabbitmq', model, firstSub) }
              : null
          ].filter(Boolean)
        : [];
    const prepared = prepare(broker, {
      devtools,
      runtime: runtimeInfo.runtime,
      projectDir,
      destinations:
        broker === 'rabbitmq'
          ? [deadLetterFor(broker, model)].filter(Boolean)
          : [topic, subscriptionTopic, deadLetterFor(broker, model)].filter(Boolean),
      topology: rabbitTopology
    });
    if (prepared) return { fatal: prepared, results };

    // `validate-infra.sh` ya reintenta: 'Up' no es 'listo'.
    const validate = run('sh', ['infra/validate-infra.sh'], {
      cwd: projectDir,
      env: { ...process.env, CONTAINER_RUNTIME: runtimeInfo.runtime }
    });
    if (validate.status !== 0) {
      return { fatal: `validate-infra.sh en rojo:\n${validate.stdout}${validate.stderr}`, results };
    }

    const subscription = (model.subscriptions ?? [])[0] ?? null;
    // En snssqs la cola del consumidor la nombra el propio servicio: es lo que
    // siembra `init-messaging.sh`, y leer de ella (y no del topic) es lo que
    // ejercita la suscripción con su filtro.
    // Y en rabbitmq por lo mismo: el canal de origen es un exchange, y de un exchange no se
    // lee — se lee de la cola propia que cuelga de él.
    const subscriptionQueue =
      subscription && (broker === 'snssqs' || broker === 'rabbitmq')
        ? subscriptionDestination(broker, model, subscription)
        : null;

    // El descarte se busca en LA SUSCRIPCIÓN QUE LO DECLARA, no en la primera del
    // diseño. Mirar `subscriptions[0]` dejó BRK-12 sin ejecutarse en los tres brokers
    // —en catalog-extended la primera no declara deadLetter— y la matriz salió verde
    // con nueve escenarios sin que nada dijera que faltaba el décimo. Un escenario que
    // se omite en silencio es peor que uno que falla.
    const deadLetterSub = (model.subscriptions ?? []).find((sub) => sub.deadLetter) ?? null;
    const deadLetterQueue = deadLetterSub ? deadLetterDestination(broker, model, deadLetterSub) : null;
    // Y en SQS la RedrivePolicy se comprueba sobre la cola DE ESA suscripción.
    const deadLetterSource =
      broker === 'snssqs' && deadLetterSub ? subscriptionDestination('snssqs', model, deadLetterSub) : null;
    // Un escenario que se omite en silencio es peor que uno que falla: los dos motivos
    // de omisión se dicen, y no son el mismo. Sin `deadLetter` declarado no hay destino
    // de descarte que mirar; con Kafka lo hay, pero no hay purga que ejercitar —el
    // aislamiento del descarte es la marca de offset que fija `markChannels()`, y por
    // eso el broker tampoco tiene `cliPurgeCmd` en el reset generado.
    const resetDb = () =>
      run('sh', ['infra/reset-db.sh'], {
        cwd: projectDir,
        env: { ...process.env, CONTAINER_RUNTIME: runtimeInfo.runtime }
      });
    if (!deadLetterQueue) {
      console.log('  --   BRK-12 y BRK-13 omitidos: la fixture no declara onFailure.deadLetter en ninguna suscripción');
    } else if (broker === 'kafka') {
      console.log('  --   BRK-13 omitido: en Kafka no hay purga; el aislamiento del descarte es la marca de offset del arnés');
    }

    for (const scenario of scenarios(broker, {
      devtools,
      topic,
      subscriptionTopic,
      subscriptionQueue,
      subscriptionName: subscription?.name ?? null,
      deadLetterQueue,
      deadLetterSource,
      resetDb,
      publishEventType: (model.messaging?.eventTypesByChannel?.[topic] ?? [])[0] ?? null
    })) {
      let outcome;
      try {
        outcome = scenario.check();
      } catch (failure) {
        outcome = ko(`excepción: ${failure.message}`);
      }
      results.push({ id: scenario.id, title: scenario.title, ...outcome });
      console.log(`  ${outcome.ok ? 'OK  ' : 'KO  '} ${scenario.id} ${scenario.title}${outcome.ok ? '' : ` — ${outcome.detail}`}`);
    }

    // BRK-10 va al final porque borra estado: el reset por flujo tiene que dejar
    // todos los destinos vacíos, o dos flujos se contaminan entre sí. Aquí solo se
    // juzga que el script salga con 0; que el DESCARTE quede vacío lo afirma BRK-13,
    // porque las purgas del script son tolerantes a fallo y no bajarían este código.
    const reset = resetDb();
    const resetOk = reset.status === 0;
    results.push({
      id: 'BRK-10',
      title: 'reset-db.sh sale con 0',
      ok: resetOk,
      detail: resetOk ? undefined : firstLine(reset.stderr || reset.stdout)
    });
    console.log(`  ${resetOk ? 'OK  ' : 'KO  '} BRK-10 reset-db.sh sale con 0`);

    // BRK-11 va el último porque es el más destructivo: para el broker. Ejercita la
    // palanca de los escenarios de outbox (`stopBroker`/`startBroker` de
    // AbstractFlowIT), que es la única parte del arnés que actúa sobre la
    // infraestructura y por tanto la única que ni compilar ni comparar cadenas
    // pueden juzgar. Lo que se comprueba no es que el runtime sepa parar un
    // contenedor, sino las dos cosas que el arnés da por ciertas: que el nombre del
    // contenedor es el que `build` estampó —si no, el escenario esperaría 90 s a un
    // contenedor que no existe— y que al volver el broker sirve, con su topología en
    // pie. En LocalStack eso último exige resembrar, y aquí es donde se ve si el
    // supuesto era correcto.
    const brokerControl = checkBrokerControl(broker, {
      runtime: runtimeInfo.runtime,
      projectDir,
      devtools,
      container: brokerContainer(model.service.name, BROKERS_CATALOG[broker])
    });
    results.push({ id: 'BRK-11', title: 'el broker se puede detener y volver a levantar', ...brokerControl });
    console.log(
      `  ${brokerControl.ok ? 'OK  ' : 'KO  '} BRK-11 el broker se puede detener y volver a levantar` +
        `${brokerControl.ok ? '' : ` — ${brokerControl.detail}`}`
    );

    return { fatal: null, results };
  } finally {
    if (frontend && projectDir && !keep) composeDown(frontend, projectDir);
    if (!keep) fs.rmSync(workspace, { recursive: true, force: true });
    else console.log(`  (--keep) proyecto en ${projectDir}`);
  }
}

// ─── Entrada ─────────────────────────────────────────────────────────────────

if (!fs.existsSync(path.join(fixturesDir, fixture, 'service.keel.yaml'))) {
  console.error(`No existe la fixture '${fixture}' en ${fixturesDir}`);
  process.exit(2);
}

const runtimeInfo = resolveRuntime();
if (!runtimeInfo) {
  console.error('No hay docker ni podman utilizable en el PATH. Este check los necesita; el resto de la suite no.');
  process.exit(2);
}

const matrix = {};
let fatal = null;
for (const broker of brokers) {
  const outcome = checkBroker(broker, runtimeInfo);
  matrix[broker] = outcome.results;
  if (outcome.fatal) {
    fatal = `${broker}: ${outcome.fatal}`;
    console.error(`${broker}: ${outcome.fatal}`);
    break;
  }
}

console.log('\nMatriz broker × escenario');
const ids = [...new Set(Object.values(matrix).flat().map((result) => result.id))];
for (const id of ids) {
  const cells = brokers.map((broker) => {
    const found = (matrix[broker] ?? []).find((result) => result.id === id);
    return `${broker}=${found ? (found.ok ? 'OK' : 'KO') : '--'}`;
  });
  console.log(`  ${id}  ${cells.join('  ')}`);
}

fs.writeFileSync(
  path.join(process.cwd(), 'broker-check.json'),
  JSON.stringify({ fixture, brokers, matrix, fatal }, null, 2),
  'utf8'
);

const failures = Object.values(matrix).flat().filter((result) => !result.ok);
if (fatal) process.exit(2);
process.exit(failures.length > 0 ? 1 : 0);
