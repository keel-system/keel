#!/usr/bin/env node
// La MENSAJERÍA de keel-go contra un RabbitMQ, un Kafka y un LocalStack (SNS/SQS) reales (tramos 9c, 9f y 9g): lo único que dice que la conexión, la
// topología (o el consumo por grupo), la publicación con confirmación, el consumo con su reintento y su descarte, la
// reconexión, el relay del outbox y los helpers del arnés funcionan juntos. Es el broker-check de keel-dotnet, keel-nest
// y keel-spring para este generador.
//
// Por qué no está en `npm test`: necesita Go, red (proxy.golang.org la primera vez), podman o docker, y minutos.
//
//   node packages/keel-go/scripts/broker-check.js [--broker=rabbitmq,kafka,snssqs] [--keep] [--only-sabotage=<id>]
//   npm run broker-check --workspace packages/keel-go
//
// El sujeto es stock-reservation-events: outbox, y tres suscripciones Keel de la misma fuente (en RabbitMQ comparten
// cola; en Kafka cada una tiene su consumer group; en SNS/SQS, su cola propia), con reintento y descarte. Lo que en el proyecto escribiría el agente
// se escribe aquí como SONDA, donde lo escribiría él (cmd/server/broker.go): un messaging.Dispatcher sobre
// Connection.Publish y un listener sobre Connection.Consume (en Kafka, uno por suscripción) cuyo comportamiento lo decide
// el eventId (7e000000-… falla de forma transitoria, b0000000-… es un rechazo de negocio, el
// resto se procesa con IdempotencyGuard.TryRecord). Como el servidor es un proceso aparte, el listener anota cada
// intento en build/broker-probe/attempts.log, que los flujos leen.
//
// Los flujos sonda usan SOLO los helpers que el arnés emite (DeliverStockReserved, PublishedMessages,
// DeadLetterMessages, StopBroker…) y los puntúa infra/score-scenarios.sh, así que lo que se mide es lo que el agente de
// pruebas tendrá. Al final se falsa: cada sabotaje rompe UNA pieza de lo emitido conservando su forma (y compilando), y
// tiene que dejar en FALLO exactamente su escenario.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { kafkaListenerRetry, rabbitListenerRetry } from '@keel-system/keel-core/gen';
import { resolveStack, writeStackConfig } from '@keel-system/keel-core/gen/stack';
import { makeWorkspace, mountDesign, runCommand } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { planService } from '../src/scaffold/index.js';
import { readerFunc } from '../src/scaffold/messaging.js';
import { resolveRuntime } from '../../keel-nest/scripts/lib/database-container.js';

const DESIGN = 'stock-reservation-events';
const keep = process.argv.includes('--keep');
const onlySabotage = process.argv.find((arg) => arg.startsWith('--only-sabotage='))?.split('=')[1] ?? null;
const brokerArg = process.argv.find((arg) => arg.startsWith('--broker='));
const BROKERS = brokerArg ? brokerArg.slice('--broker='.length).split(',') : ['rabbitmq', 'kafka', 'snssqs'];
const isWindows = process.platform === 'win32';
const results = [];

function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function bashExecutable() {
  if (process.env.BASH_EXECUTABLE) return process.env.BASH_EXECUTABLE;
  if (isWindows) {
    for (const candidate of [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
    ]) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
  }
  return 'bash';
}

const runtime = resolveRuntime();
if (!runtime) {
  console.error('broker-check necesita podman o docker en marcha.');
  process.exit(2);
}
const env = { ...process.env, CONTAINER_RUNTIME: runtime };

function bash(projectDir, script, args = []) {
  const result = spawnSync(bashExecutable(), [script, ...args], { cwd: projectDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function go(projectDir, args) {
  const result = spawnSync('go', args, { cwd: projectDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function checkBroker(broker) {
const kafka = broker === 'kafka';
const snssqs = broker === 'snssqs';
const label = { rabbitmq: 'RabbitMQ', kafka: 'Kafka', snssqs: 'SNS/SQS' }[broker];
console.log(`\n── ${label} ──`);
// ── El proyecto, generado por build como en una corrida ──────────────────────────────────────────
const stack = { database: 'postgresql', broker };
const workspace = makeWorkspace(`keel-go-broker-${broker}-`);
const specDir = mountDesign(workspace, DESIGN);
const projectDir = path.join(workspace, 'services', `${DESIGN}-go`);
fs.mkdirSync(projectDir, { recursive: true });
const design = loadService(specDir);
writeStackConfig(projectDir, resolveStack(stack, design.layers));
const generated = await runCommand(workspace, build, `specs/${DESIGN}`, { defaults: true, acceptUnready: true });
if (!step(`${label}: build genera el proyecto`, generated.exitCode === undefined && fs.existsSync(path.join(projectDir, 'go.mod')), generated.exitCode ? generated.output : '')) {
  return;
}
const { model } = planService({ ...design, workspace, stack });
const module = /^module\s+(\S+)/m.exec(fs.readFileSync(path.join(projectDir, 'go.mod'), 'utf8'))[1];
const sub = model.subscriptions.find((candidate) => candidate.name === 'StockReserved');
const event = model.events[0];
const channel = model.messaging.publishChannels[0];
const routingKey = event.routingKeyDefault;
// En SNS/SQS los intentos los cuenta la cola: las recepciones antes de la RedrivePolicy (onFailure.retry.maxAttempts).
const attempts = { rabbitmq: () => rabbitListenerRetry(model).attempts, kafka: () => kafkaListenerRetry(model).attempts, snssqs: () => sub.retry?.maxAttempts ?? 1 }[broker]();
// Lo que cambia de la sonda entre brokers: la conexión, la publicación, el cuerpo del mensaje y cómo se consume. En
// Kafka cada suscripción tiene su grupo y su listener: la sonda los registra TODOS (un proyecto completo los tiene, y el
// arnés espera a sus grupos), y solo el de la suscripción medida actúa.
// En SNS/SQS no hay clave de mensaje: el tipo viaja como message attribute, que es sobre lo que filtran las suscripciones.
const conn = kafka
  ? { pkg: 'kafka', param: 'kafkaConn', field: 'Kafka', publish: 'd.conn.Publish(ctx, destination, routingKey, payload, nil)', body: 'Value' }
  : snssqs
  ? { pkg: 'snssqs', param: 'snssqsConn', field: 'SNSSQS', publish: 'd.conn.Publish(ctx, destination, payload, map[string]string{"eventType": eventType, "routingKey": routingKey})', body: 'Body' }
  : { pkg: 'rabbitmq', param: 'rabbit', field: 'Rabbit', publish: 'd.conn.Publish(ctx, destination, routingKey, eventType, payload, nil)', body: 'Body' };
const listenersReturn = kafka
  ? `ignore := func(context.Context, kafka.Message) error { return nil }
	return []listener{
${model.subscriptions
  .map((candidate) => `		func(ctx context.Context) error { return deps.Kafka.Consume(ctx, ${JSON.stringify(candidate.name)}, ${candidate.name === sub.name ? 'handle' : 'ignore'}) },`)
  .join('\n')}
	}, nil`
  : snssqs
  ? `return []listener{func(ctx context.Context) error { return deps.SNSSQS.Consume(ctx, ${JSON.stringify(sub.name)}, handle) }}, nil`
  : `return []listener{func(ctx context.Context) error { return deps.Rabbit.Consume(ctx, queue, handle) }}, nil`;

// ── Lo del agente, como sonda: cmd/server/broker.go ────────────────────────────────────────────
fs.writeFileSync(
  path.join(projectDir, 'cmd', 'server', 'broker.go'),
  `package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"${module}/internal/domain"
	"${module}/internal/infrastructure/${conn.pkg}"
	"${module}/internal/infrastructure/messaging"
)

// probeDispatcher es la sonda del dispatcher que escribiría el agente: la fila tal cual, con su tipo, y espera la
// confirmación del broker.
type probeDispatcher struct {
	conn *${conn.pkg}.Connection
}

func (d probeDispatcher) Dispatch(ctx context.Context, destination, routingKey, eventType, payload string) error {
	${kafka ? '_ = eventType // en Kafka el tipo viaja en la envoltura\n\t' : ''}return ${conn.publish}
}

func brokerAdapters(_ messaging.Settings, ${conn.param} *${conn.pkg}.Connection, _ *slog.Logger) (outbound, error) {
	return outbound{Dispatcher: probeDispatcher{conn: ${conn.param}}}, nil
}

// attemptsLog guarda los intentos que ve el listener: el servidor es otro proceso, y los flujos los leen del archivo.
var attemptsLog sync.Mutex

func recordAttempt(eventID string) error {
	attemptsLog.Lock()
	defer attemptsLog.Unlock()
	dir := filepath.Join("build", "broker-probe")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(dir, "attempts.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(eventID + "\\n"); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

// messageListeners es la sonda del listener que escribiría el agente${kafka ? ', uno por suscripción' : snssqs ? ', el de la suscripción medida' : ', uno para la cola compartida'}. Lo que hace lo
// decide el eventId: 7e000000-… falla de forma transitoria (se reintenta y acaba en el descarte), b0000000-… es un
// rechazo de negocio (descarte sin reintento); el resto se procesa con IdempotencyGuard.TryRecord.
func messageListeners(deps inbound) ([]listener, error) {
${kafka || snssqs ? '' : `	queue := deps.Settings.Subscriptions[${JSON.stringify(sub.name)}].Queue
`}	handle := func(ctx context.Context, message ${conn.pkg}.Message) error {
		envelope, err := messaging.ParseEnvelope(message.${conn.body})
		if err != nil {
			return err
		}
		// ${kafka ? 'El grupo recibe el topic entero' : snssqs ? 'La cola filtra por eventType, pero el filtro no es la única defensa' : 'La cola la comparten varias suscripciones'}: lo que no es nuestro se confirma SIN efecto.
		if envelope.Metadata.EventType != ${JSON.stringify(sub.name)} {
			return nil
		}
		eventID := envelope.Metadata.EventID
		if err := recordAttempt(eventID); err != nil {
			return err
		}
		payload, err := messaging.${readerFunc(sub)}(envelope.Data)
		if err != nil {
			return err
		}
		if err := payload.RequireContract(); err != nil {
			return err
		}
		switch {
		case strings.HasPrefix(eventID, "7e000000"):
			return errors.New("fallo transitorio de la sonda")
		case strings.HasPrefix(eventID, "b0000000"):
			return domain.Errorf(domain.ErrInvalidValue, "rechazo de negocio de la sonda")
		}
		_, err = deps.Guard.TryRecord(ctx, "ProbeListener", eventID)
		return err
	}
	${listenersReturn}
}
`
);

// ── Los flujos sonda: SOLO helpers del arnés (y el contador de la sonda) ─────────────────────────
const envelope = JSON.stringify({
  metadata: { eventId: 'EVENT_ID', eventType: event.name, eventVersion: 1, occurredAt: '2026-10-14T10:00:00.000Z', source: DESIGN, correlationId: null, traceparent: null },
  data: { orderId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' }
});
const stockEnvelope = JSON.stringify({
  metadata: { eventId: 'EVENT_ID', eventType: sub.name, eventVersion: 1, occurredAt: '2026-10-14T10:00:00.000Z', source: 'inventory', correlationId: null, traceparent: null },
  data: { orderId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' }
});
const foreign = JSON.stringify({
  metadata: { eventId: 'EVENT_ID', eventType: 'SomethingElse', eventVersion: 1, occurredAt: '2026-10-14T10:00:00.000Z', source: 'inventory', correlationId: null, traceparent: null },
  data: {}
});
const q = JSON.stringify;
// Con Kafka el arranque tras levantar el broker suma el reparto del grupo, y con SNS/SQS la resiembra: más margen.
const recovery = kafka || snssqs ? 90 : 30;
// Lo publicado: en RabbitMQ, la routing key y el tipo nativo; en Kafka, la clave del registro.
// En SNS/SQS no hay clave: el tipo de la envoltura (si no casara con el filtro, la cola de arnés no lo habría recibido).
const publishedShape = snssqs
  ? `if message.EventType() != ${q(event.name)} {
				s.Errorf("tipo %q", message.EventType())
			}`
  : kafka
  ? `if message.RoutingKey != ${q(routingKey)} {
				s.Errorf("clave %q", message.RoutingKey)
			}`
  : `if message.RoutingKey != ${q(routingKey)} || message.Type() != ${q(event.name)} {
				s.Errorf("routing key %q y tipo %q", message.RoutingKey, message.Type())
			}`;
// RabbitMQ: lo que no tiene cola (mandatory) no se da por publicado. Kafka crea el topic con el primer mensaje.
const mandatoryCase = kafka
  ? ''
  : snssqs
  ? `
	f.Scenario("FL-BRK-002-B: una fila cuyo topic no existe no se da por publicada (la conexión no lo crea)", func(s *Scenario) {
		id := probeID("")
		s.Db("INSERT INTO outbox_event (id, destination, routing_key, event_type, payload, created_at, attempts) VALUES ('" + id + "', 'keel-sin-topic', '${routingKey}', '${event.name}', '{}', now(), 0)")
		// Hasta que el relay la intente o la dé por publicada: lo segundo es el fallo que se mide, y tiene que decirlo.
		s.Eventually(func() bool {
			return probeCount(s, "SELECT COUNT(*) FROM outbox_event WHERE id = '"+id+"' AND (attempts >= 1 OR published_at IS NOT NULL)") == 1
		}, 20*time.Second, "el relay no lo intentó")
		if got := probeCount(s, "SELECT COUNT(*) FROM outbox_event WHERE id = '"+id+"' AND published_at IS NULL"); got != 1 {
			s.Error("se dio por publicada una fila sin topic")
		}
		s.Db("DELETE FROM outbox_event WHERE id = '" + id + "'")
	})`
  : `
	f.Scenario("FL-BRK-002-B: lo que no tiene cola (mandatory) no se da por publicado", func(s *Scenario) {
		id := probeID("")
		probeOutboxRow(s, id, "keel.sin-ruta", probeEnvelope(probeID("")))
		// Hasta que el relay la intente o la dé por publicada: lo segundo es el fallo que se mide, y tiene que decirlo.
		s.Eventually(func() bool {
			return probeCount(s, "SELECT COUNT(*) FROM outbox_event WHERE id = '"+id+"' AND (attempts >= 1 OR published_at IS NOT NULL)") == 1
		}, 20*time.Second, "el relay no lo intentó")
		if got := probeCount(s, "SELECT COUNT(*) FROM outbox_event WHERE id = '"+id+"' AND published_at IS NULL"); got != 1 {
			s.Error("se dio por publicada una fila sin cola")
		}
		s.Db("DELETE FROM outbox_event WHERE id = '" + id + "'")
	})`;
// Kafka: el descarte conserva la clave y lleva los headers de Spring Kafka.
const deadLetterShape = kafka
  ? `
	f.Scenario("FL-BRK-001-I: el descarte conserva la clave y lleva los headers de Spring Kafka (topic de origen y excepción)", func(s *Scenario) {
		id := probeID("b0000000")
		s.Deliver${sub.name}(id, probeOrder)
		s.Eventually(func() bool { return hasEvent(s.DeadLetterMessages(${q(sub.name)}), id) }, 20*time.Second, "no llegó al descarte")
		for _, dead := range s.DeadLetterMessages(${q(sub.name)}) {
			if dead.EventID() != id {
				continue
			}
			if dead.RoutingKey != id {
				s.Errorf("clave %q, quiero %q", dead.RoutingKey, id)
			}
			if got := dead.Properties["kafka_dlt-original-topic"]; got != ${q(sub.topicDefault)} {
				s.Errorf("kafka_dlt-original-topic = %v", got)
			}
			if got, _ := dead.Properties["kafka_dlt-exception-message"].(string); !strings.Contains(got, "rechazo de negocio de la sonda") {
				s.Errorf("kafka_dlt-exception-message = %q", got)
			}
		}
	})`
  : '';
const flowsDir = path.join(projectDir, 'tests', 'integration');
fs.writeFileSync(
  path.join(flowsDir, 'broker_probe_flow_test.go'),
  `//go:build integration

package integration

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const probeOrder = ${q(JSON.stringify({ orderId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' }))}

// probeID es un uuid nuevo, con prefix en lugar de su primer tramo si lo hay.
func probeID(prefix string) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	id := fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
	if prefix != "" {
		id = prefix + id[8:]
	}
	return id
}

// probeAttempts es cuántas veces vio el listener sonda este eventId (lo anota el servidor, que es otro proceso).
func probeAttempts(eventID string) int {
	root, err := projectRoot()
	if err != nil {
		return -1
	}
	data, err := os.ReadFile(filepath.Join(root, "build", "broker-probe", "attempts.log"))
	if err != nil {
		return 0
	}
	count := 0
	for _, line := range strings.Split(string(data), "\\n") {
		if strings.TrimSpace(line) == eventID {
			count++
		}
	}
	return count
}

func probeCount(s *Scenario, sql string) int64 {
	s.Helper()
	count, err := strconv.ParseInt(strings.TrimSpace(s.Db(sql)), 10, 64)
	if err != nil {
		s.Fatal(err)
	}
	return count
}

func probeProcessed(s *Scenario, eventID string) int64 {
	return probeCount(s, "SELECT COUNT(*) FROM processed_event WHERE handler_id = 'ProbeListener' AND event_id = '"+eventID+"'")
}

func probeEnvelope(eventID string) string {
	return strings.ReplaceAll(${q(envelope)}, "EVENT_ID", eventID)
}

func probeOutboxRow(s *Scenario, id, routingKey, payload string) {
	s.Helper()
	s.Db("INSERT INTO outbox_event (id, destination, routing_key, event_type, payload, created_at, attempts) VALUES ('" + id + "', ${model.messaging.destinationDefault ? `'${model.messaging.destinationDefault}'` : "''"}, '" + routingKey + "', ${q(event.name).replace(/"/g, "'")}, '" + strings.ReplaceAll(payload, "'", "''") + "', now(), 0)")
}

func hasEvent(messages []BrokerMessage, eventID string) bool {
	return slices.ContainsFunc(messages, func(message BrokerMessage) bool { return message.EventID() == eventID })
}

func TestBrokerConsumption(t *testing.T) {
	f := StartFlow(t, nil)
	f.Scenario("FL-BRK-001-A: una entrega llega al listener y se procesa una vez", func(s *Scenario) {
		id := probeID("")
		s.DeliverStockReserved(id, probeOrder)
		s.Eventually(func() bool { return probeProcessed(s, id) == 1 }, 20*time.Second, "el listener no procesó el mensaje")
		if got := probeAttempts(id); got != 1 {
			s.Errorf("intentos = %d, quiero 1", got)
		}
	})
	f.Scenario("FL-BRK-001-B: la reentrega del mismo messageId no se procesa dos veces ni va al descarte", func(s *Scenario) {
		id := probeID("")
		s.DeliverStockReserved(id, probeOrder)
		s.Eventually(func() bool { return probeProcessed(s, id) == 1 }, 20*time.Second, "el listener no procesó el mensaje")
		s.DeliverStockReserved(id, probeOrder)
		s.Eventually(func() bool { return probeAttempts(id) == 2 }, 20*time.Second, "la reentrega no llegó")
		if got := probeProcessed(s, id); got != 1 {
			s.Errorf("procesado %d veces", got)
		}
		if hasEvent(s.DeadLetterMessages(${q(sub.name)}), id) {
			s.Error("la reentrega acabó en el descarte")
		}
	})
	f.Scenario("FL-BRK-001-C: un fallo transitorio se reintenta ${attempts} veces y acaba en el descarte", func(s *Scenario) {
		id := probeID("7e000000")
		s.DeliverStockReserved(id, probeOrder)
		s.Eventually(func() bool { return hasEvent(s.DeadLetterMessages(${q(sub.name)}), id) }, 60*time.Second, "no llegó al descarte")
		if got := probeAttempts(id); got != ${attempts} {
			s.Errorf("intentos = %d, quiero ${attempts}", got)
		}
	})
	f.Scenario("FL-BRK-001-D: un rechazo de negocio va al descarte SIN reintento", func(s *Scenario) {
		id := probeID("b0000000")
		s.DeliverStockReserved(id, probeOrder)
		s.Eventually(func() bool { return hasEvent(s.DeadLetterMessages(${q(sub.name)}), id) }, 20*time.Second, "no llegó al descarte")
		if got := probeAttempts(id); got != 1 {
			s.Errorf("intentos = %d, quiero 1", got)
		}
	})
	f.Scenario("FL-BRK-001-E: un payload que incumple el contrato va al descarte sin reintento", func(s *Scenario) {
		id := probeID("")
		s.DeliverStockReserved(id, "{}")
		s.Eventually(func() bool { return hasEvent(s.DeadLetterMessages(${q(sub.name)}), id) }, 20*time.Second, "no llegó al descarte")
		if got := probeAttempts(id); got != 1 {
			s.Errorf("intentos = %d, quiero 1", got)
		}
		if got := probeProcessed(s, id); got != 0 {
			s.Errorf("procesado %d veces", got)
		}
	})
	f.Scenario("FL-BRK-001-F: un evento ajeno del canal compartido se confirma sin efecto y sin descarte", func(s *Scenario) {
		before := len(s.DeadLetterMessages(${q(sub.name)}))
		id := probeID("")
		s.DeliverMessage(${q(sub.topicDefault)}, id, strings.ReplaceAll(${q(foreign)}, "EVENT_ID", id), nil)
		time.Sleep(1500 * time.Millisecond)
		if got := probeAttempts(id); got != 0 {
			s.Errorf("intentos = %d, quiero 0", got)
		}
		if got := len(s.DeadLetterMessages(${q(sub.name)})); got != before {
			s.Errorf("descartes %d → %d", before, got)
		}
	})
	f.Scenario("FL-BRK-001-G: entregas DISTINTAS lanzadas a la vez llegan todas, cada una con su cuerpo", func(s *Scenario) {
		// El escenario de carrera de una corrida: con un archivo de cuerpo compartido en devtools, una entrega se llevaba
		// el cuerpo de la otra. Desde goroutines no se puede terminar el escenario: se llama a la entrega del arnés y
		// se juntan sus errores.
		ids := make([]string, 8)
		errs := make([]error, len(ids))
		var wg sync.WaitGroup
		for i := range ids {
			ids[i] = probeID("")
			wg.Go(func() {
				errs[i] = deliver(s.Context(), ${q(sub.topicDefault)}, ids[i], strings.ReplaceAll(${q(stockEnvelope)}, "EVENT_ID", ids[i]), map[string]string{"eventType": ${q(sub.name)}})
			})
		}
		wg.Wait()
		for _, err := range errs {
			if err != nil {
				s.Fatal(err)
			}
		}
		s.Eventually(func() bool {
			return !slices.ContainsFunc(ids, func(id string) bool { return probeProcessed(s, id) != 1 })
		}, 30*time.Second, "alguna entrega no llegó con su cuerpo")
		for _, id := range ids {
			if got := probeAttempts(id); got != 1 {
				s.Errorf("%s: intentos = %d, quiero 1", id, got)
			}
		}
	})
	f.Scenario("FL-BRK-001-H: tras reiniciar el broker, el consumidor vuelve a consumir", func(s *Scenario) {
		s.StopBroker()
		s.StartBroker()
		id := probeID("")
		s.DeliverStockReserved(id, probeOrder)
		s.Eventually(func() bool { return probeProcessed(s, id) == 1 }, ${recovery}*time.Second, "el consumidor no volvió tras la reconexión")
	})${deadLetterShape}
}

func TestBrokerPublication(t *testing.T) {
	f := StartFlow(t, nil)
	f.Scenario("FL-BRK-002-A: una fila del outbox sale al canal con su envoltura y queda publicada", func(s *Scenario) {
		id := probeID("")
		eventID := probeID("")
		probeOutboxRow(s, id, ${q(routingKey)}, probeEnvelope(eventID))
		s.Eventually(func() bool { return hasEvent(s.PublishedMessages(${q(channel)}), eventID) }, 20*time.Second, "no se publicó")
		for _, message := range s.PublishedMessages(${q(channel)}) {
			if message.EventID() != eventID {
				continue
			}
			${publishedShape}
		}
		if got := probeCount(s, "SELECT COUNT(*) FROM outbox_event WHERE id = '"+id+"' AND published_at IS NOT NULL"); got != 1 {
			s.Error("la fila no quedó publicada")
		}
	})
${mandatoryCase}
	f.Scenario("FL-BRK-002-C: con el broker caído la fila espera, y sale al volver sin rendirse", func(s *Scenario) {
		s.StopBroker()
		eventID := probeID("")
		probeOutboxRow(s, probeID(""), ${q(routingKey)}, probeEnvelope(eventID))
		time.Sleep(3 * time.Second)
		if got := s.PublishedMessages(${q(channel)}); len(got) != 0 {
			s.Errorf("con el broker caído se leyeron %d mensajes", len(got))
		}
		s.StartBroker()
		s.Eventually(func() bool { return hasEvent(s.PublishedMessages(${q(channel)}), eventID) }, ${recovery}*time.Second, "no salió tras levantar el broker")
		if got := s.DeadLetteredEvents(); got != 0 {
			s.Errorf("rendidos = %d", got)
		}
	})
	f.Scenario("FL-BRK-002-D: un evento abandonado no se publica y se cuenta como rendido", func(s *Scenario) {
		s.PurgeMessages(${q(channel)})
		s.StopBroker()
		eventID := probeID("")
		probeOutboxRow(s, probeID(""), ${q(routingKey)}, probeEnvelope(eventID))
		s.AbandonOutboxEvent(${q(event.name)})
		s.StartBroker()
		time.Sleep(3 * time.Second)
		if hasEvent(s.PublishedMessages(${q(channel)}), eventID) {
			s.Error("el evento abandonado se publicó")
		}
		if got := s.DeadLetteredEvents(); got != 1 {
			s.Errorf("rendidos = %d, quiero 1", got)
		}
		s.ClearAbandonedOutboxEvents()
		if got := s.DeadLetteredEvents(); got != 0 {
			s.Errorf("rendidos tras limpiar = %d", got)
		}
	})
	f.Scenario("FL-BRK-002-E: PurgeMessages vacía el canal", func(s *Scenario) {
		probeOutboxRow(s, probeID(""), ${q(routingKey)}, probeEnvelope(probeID("")))
		s.Eventually(func() bool { return len(s.PublishedMessages(${q(channel)})) > 0 }, 20*time.Second, "no se publicó")
		s.PurgeMessages(${q(channel)})
		if got := s.PublishedMessages(${q(channel)}); len(got) != 0 {
			s.Errorf("quedan %d mensajes tras la purga", len(got))
		}
	})
}
`
);

const CASES = { 'FL-BRK-001': kafka ? 'ABCDEFGHI' : 'ABCDEFGH', 'FL-BRK-002': kafka ? 'ACDE' : 'ABCDE' };

// Cada sabotaje rompe UNA pieza de lo emitido conservando su forma, y compila: un sabotaje que no compila no falsa nada.
const SABOTAGES = {
  // El rechazo de negocio tratado como reintentable: se reintenta y acaba en el descarte con más de un intento.
  'rejection-retried': {
    file: kafka ? 'internal/infrastructure/kafka/consumption.go' : snssqs ? 'internal/infrastructure/snssqs/consumption.go' : 'internal/infrastructure/rabbitmq/topology.go',
    from: 'return retriesNotFound && rejected.Kind() == domain.KindNotFound',
    to: 'return retriesNotFound || rejected.Kind() != domain.KindNotFound',
    expect: 'FL-BRK-001-D'
  },
  // El archivo de cuerpo COMPARTIDO entre llamadas (el arnés de keel-dotnet antes de su arreglo): las entregas a la vez
  // se pisan el cuerpo.
  'shared-body': {
    file: 'tests/integration/messaging_test.go',
    from: 'bodyFilePrefix + "-" + rand.Text() + ".json"',
    to: 'bodyFilePrefix + "-" + rand.Text()[:0] + ".json"',
    expect: 'FL-BRK-001-G'
  },
  // Sin mandatory, lo que no tiene cola se confirma igual y el relay lo da por publicado.
  mandatory: kafka || snssqs ? null : {
    file: 'internal/infrastructure/rabbitmq/connection.go',
    from: 'ch.PublishWithDeferredConfirmWithContext(confirmCtx, exchange, routingKey, true, false, message)',
    to: 'ch.PublishWithDeferredConfirmWithContext(confirmCtx, exchange, routingKey, false, false, message)',
    expect: 'FL-BRK-002-B'
  },
  // El consumidor que no se rearma: al caer la conexión, Consume vuelve y nadie vuelve a consumir.
  'consumer-not-rearmed': kafka || snssqs ? null : {
    file: 'internal/infrastructure/rabbitmq/connection.go',
    from: '\t\tif ctx.Err() != nil {\n\t\t\treturn nil\n\t\t}\n\t\t// Si cayó la conexión',
    to: '\t\tif ctx.Err() == nil {\n\t\t\treturn nil\n\t\t}\n\t\t// Si cayó la conexión',
    expect: 'FL-BRK-001-H'
  },
  // El descarte con el header del topic de origen equivocado: quien vigila los descartes no sabría de dónde vienen.
  'dlt-headers': kafka
    ? {
        file: 'internal/infrastructure/kafka/connection.go',
        from: 'kgo.RecordHeader{Key: "kafka_dlt-original-topic", Value: []byte(record.Topic)}',
        to: 'kgo.RecordHeader{Key: "kafka_dlt-original-topic", Value: []byte(group)}',
        expect: 'FL-BRK-001-I'
      }
    : null,
  // Lo no reintentable devuelto a la cola en vez de llevarlo a la DLQ: la RedrivePolicy acaba llevándolo, pero tras
  // todas sus recepciones. Caen los dos casos «sin reintento»: el rechazo de negocio y el contrato incumplido.
  'dlq-not-direct': snssqs
    ? {
        file: 'internal/infrastructure/snssqs/connection.go',
        from: '_, err := client.SendMessage(work, &sqs.SendMessageInput{QueueUrl: aws.String(deadLetterURL), MessageBody: received.Body, MessageAttributes: received.MessageAttributes})',
        to: 'err := errors.New("sabotaje: lo no reintentable vuelve a la cola")\n\t\tc.changeVisibility(work, client, queueURL, received, 0)',
        expect: ['FL-BRK-001-D', 'FL-BRK-001-E']
      }
    : null
};

const tidy = go(projectDir, ['mod', 'tidy']);
if (!step(`${label}: go mod tidy`, tidy.ok, tidy.ok ? '' : tidy.output.slice(-1200))) return;
const built = go(projectDir, ['vet', '-tags', 'integration', './...']);
if (!step(`${label}: el proyecto con las sondas y los flujos compila y pasa go vet`, built.ok, built.ok ? '' : built.output.slice(-2000))) return;
const flows = bash(projectDir, 'infra/check-flows.sh');
step(`${label}: check-flows.sh: los flujos sonda respetan la caja negra`, flows.status === 0, flows.status === 0 ? '' : flows.output.slice(-800));

const up = bash(projectDir, 'infra/up.sh');
if (!step(`${label}: bash infra/up.sh (PostgreSQL y el broker)`, up.status === 0, up.status === 0 ? '' : up.output.slice(-1200))) return;
try {
  // La topología de SNS/SQS no la crea la aplicación: la siembra init-messaging.sh, que en una corrida ejecuta el agente
  // de infraestructura tras levantar la infra.
  if (fs.existsSync(path.join(projectDir, 'infra', 'init-messaging.sh'))) {
    const seed = bash(projectDir, 'infra/init-messaging.sh');
    step(`${label}: bash infra/init-messaging.sh`, seed.status === 0, seed.status === 0 ? '' : seed.output.slice(-1500));
  }
  const validate = bash(projectDir, 'infra/validate-infra.sh');
  step(`${label}: bash infra/validate-infra.sh (el broker incluido)`, validate.status === 0, validate.status === 0 ? '' : validate.output.slice(-1200));

  // El documento de escenarios declara SOLO las sondas: un id que el documento no declara es AJENO, y su FALLO dejaría
  // el script en 2 (arnés roto), no en 1, así que el falsado no se podría leer. Su línea sale del sello.
  fs.writeFileSync(path.join(projectDir, 'specs', 'validation-scenarios.md'), '#### FL-BRK-001 — sonda del consumo\n\n#### FL-BRK-002 — sonda de la publicación por el outbox\n');
  const seal = path.join(projectDir, 'specs.sha256');
  if (fs.existsSync(seal)) {
    fs.writeFileSync(seal, fs.readFileSync(seal, 'utf8').split('\n').filter((line) => !line.endsWith('specs/validation-scenarios.md')).join('\n'));
  }

  if (!onlySabotage) {
    const scored = bash(projectDir, 'infra/score-scenarios.sh');
    const lines = scored.output;
    for (const [flow, ids] of Object.entries(CASES)) {
      for (const id of ids) {
        const ok = new RegExp(`OK\\s+${flow}-${id}`).test(lines);
        step(`${label}: score: ${flow}-${id}`, ok, ok ? '' : (lines.match(new RegExp(`.*${flow}-${id}.*`))?.[0] ?? lines.slice(-1500)));
      }
    }
    const measured = scored.status === 0 && /Humo del arnés: OK/.test(lines);
    step(`${label}: score: el humo del arnés (con SMOKE-8, el broker y la conexión) en verde y el script con 0`, measured, measured ? '' : lines.slice(-2500));
  }

  for (const [id, sabotage] of Object.entries(SABOTAGES)) {
    if (!sabotage || (onlySabotage && id !== onlySabotage)) continue;
    const target = path.join(projectDir, sabotage.file);
    const original = fs.readFileSync(target, 'utf8');
    if (!step(`${label}: falsado ${id}: se aplica a lo emitido`, original.includes(sabotage.from))) continue;
    fs.writeFileSync(target, original.replace(sabotage.from, sabotage.to));
    try {
      const sabotaged = bash(projectDir, 'infra/score-scenarios.sh');
      const failed = [...sabotaged.output.matchAll(/FALLO\s+(FL-BRK-\d{3}-[A-Z])/g)].map((match) => match[1]);
      const expected = [sabotage.expect].flat();
      const caught = sabotaged.status === 1 && failed.length === expected.length && expected.every((flow) => failed.includes(flow));
      step(`${label}: falsado ${id}: ${expected.join(' y ')} sale${expected.length > 1 ? 'n' : ''} FALLO (y solo ${expected.length > 1 ? 'ellos' : 'él'}) y el script con 1`, caught, caught ? '' : `código ${sabotaged.status}, FALLO: ${failed.join(', ') || '(ninguno)'}\n${sabotaged.output.slice(-1500)}`);
    } finally {
      fs.writeFileSync(target, original);
    }
  }
} finally {
  const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
  step(`${label}: bash infra/down.sh --volumes`, down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
  if (keep) {
    const kept = fs.mkdtempSync(path.join(os.tmpdir(), `keel-go-broker-kept-${broker}-`));
    fs.cpSync(projectDir, kept, { recursive: true });
    console.log(`Proyecto conservado en ${kept}`);
  }
}
}

for (const broker of BROKERS) await checkBroker(broker);

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\nbroker-check: ${results.length}/${results.length} en verde.` : `\nbroker-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
