// `infra/reset-db.sh` purga DESTINOS REALES, no nombres lógicos del diseño.
//
// La distinción no se ve hasta que muerde. Para un canal de publicación el nombre lógico y la
// cola coinciden; para una SUSCRIPCIÓN, no: se consume de la cola de la fuente
// (`inventory.events`, `any-registered-system.events`) y no del canal que el diseño nombra. El
// script purgaba el nombre lógico, o sea una cola inexistente — y como la purga es tolerante a
// fallo a propósito, lo único que se veía era un `AVISO: no se pudo purgar …` en cada reset,
// mientras la cola de entrada arrastraba mensajes de un flujo al siguiente. Es exactamente lo que
// este script existe para impedir, y lo que su propio comentario ya argumentaba para el destino
// de descarte sin ver que valía igual para la cola principal.
//
// Kafka no entra: no tiene `cliPurgeCmd` y su aislamiento es la marca de offset de AbstractFlowIT.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Los destinos que `reset-db.sh` dice purgar, leídos de sus propios `echo`. */
function purgedDestinations(broker, fixture = 'stock-reservation') {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-purges-');
  scaffoldService({ manifest, layers, workspace, force: true, stack: { broker } });
  const script = fs.readFileSync(
    path.join(workspace, 'services', `${manifest.service.name}-spring`, 'infra', 'reset-db.sh'),
    'utf8'
  );
  return [...script.matchAll(/echo "Canal purgado \([^:]+: ([^)]+)\)\."/g)].map((match) => match[1]);
}

test('RabbitMQ: se purga la cola de la suscripción, no el canal lógico', () => {
  const purged = purgedDestinations('rabbitmq');

  // La fixture tiene tres suscripciones que comparten la cola de su fuente: se purga UNA vez.
  assert.ok(purged.includes('inventory.events'), `falta la cola de la suscripción: ${purged.join(', ')}`);
  assert.equal(purged.filter((d) => d === 'inventory.events').length, 1, 'sin duplicar por suscripción');
  // El canal de publicación sí es su propio destino y sigue purgándose.
  assert.ok(purged.includes('stockEvents'), 'falta el canal de publicación');
  // Y el descarte, que ya funcionaba.
  assert.ok(purged.includes('inventory.events-dlq'), 'falta el destino de descarte');
});

test('SNS/SQS: cada suscripción tiene cola propia y se purgan todas', () => {
  // Aquí el destino NO es el topic: dos consumidores del mismo topic necesitan colas distintas,
  // así que purgar el nombre del canal sería purgar una cola que no existe.
  const purged = purgedDestinations('snssqs');

  for (const queue of [
    'stock-reservation-stock-reserved',
    'stock-reservation-stock-count-adjusted',
    'stock-reservation-stock-rejected'
  ]) {
    assert.ok(purged.includes(queue), `falta la cola ${queue}: ${purged.join(', ')}`);
    assert.ok(purged.includes(`${queue}-dlq`), `falta el descarte de ${queue}`);
  }
  assert.ok(purged.includes('stockEvents'), 'falta el canal de publicación');
});

test('se purga exactamente la cola que declara la topología generada', () => {
  // El cruce que hace que esto no pueda volver a divergir: el destino no se recalcula aquí, se lee
  // del OTRO artefacto que build genera con la misma verdad — el `DeadLetterConfig`, que DECLARA
  // la cola. Son dos proyecciones del mismo dato, y compararlas es lo que impide que una se mueva
  // sin la otra. (El listener no sirve de ancla: lo escribe el agente, no build.)
  //
  // La fixture es justo el caso que engañaba: su suscripción declara `channel: stockEvents`, que
  // coincide con el canal de publicación, así que el script "purgaba algo" y parecía correcto
  // mientras la cola real (`inventory.events`) no se tocaba nunca.
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, 'stock-reservation'));
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-purges-topology-');
  scaffoldService({ manifest, layers, workspace, force: true, stack: { broker: 'rabbitmq' } });

  const javaRoot = path.join(workspace, 'services', `${manifest.service.name}-spring`, 'src/main/java');
  let topology = null;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'DeadLetterConfig.java') topology = fs.readFileSync(full, 'utf8');
    }
  };
  walk(javaRoot);
  assert.ok(topology, 'build no generó DeadLetterConfig.java: no hay contra qué cruzar');

  const queues = new Set([...topology.matchAll(/QueueBuilder\.durable\("([^"]+)"\)/g)].map((m) => m[1]));
  assert.ok(queues.size > 0, 'DeadLetterConfig no declara ninguna cola');

  const purged = purgedDestinations('rabbitmq');
  for (const queue of queues) {
    assert.ok(purged.includes(queue), `la topología declara la cola '${queue}' y el reset no la purga`);
  }
});
