// La prueba EMITIDA de la mensajería (incremento 9): lo que decide el contrato y se puede ejecutar sin broker ni base,
// con los mismos casos que keel-nest ejecuta sobre lo suyo (keel-nest/test/messaging.test.js):
//   · la envoltura en el cable: la metadata en el orden de WIRE_SHAPES, con sus nulos, y `data` sin la metadata;
//   · su lectura, y lo que incumple el contrato (no se reintenta);
//   · el contrato de cada suscripción: un payload que no es un objeto, un campo de otro tipo y el obligatorio que falta,
//     con las frases de keel-spring;
//   · el backoff del relay contra la referencia de keel-core, y la curva del reintento del listener.
// Lo que habla con el broker o la base lo juzgan `db-check` y `broker-check`.

import { WIRE_SHAPES } from 'keel-core/gen/wire';
import { outboxBackoffMs } from 'keel-core/gen/messaging-stores';
import { kafkaListenerRetry, rabbitListenerRetry } from 'keel-core/gen';
import { csFile, csMember, csString, namespaceOf, solution } from './render.js';
import { messagingNamespace, usesDotnetOutbox, usesKafka, usesMessaging, usesRabbitMq, usesSnsSqs } from './messaging.js';
import { snsSqsConsumption } from 'keel-core/gen/messaging-plan';

export function generate(model) {
  if (!usesMessaging(model)) return [];
  const sln = solution(model);
  const usings = ['System.Text.Json', 'System.Text.Json.Serialization', 'Xunit', namespaceOf(model, 'events'), messagingNamespace(model)];
  const members = [envelopeTests(model), ...subscriptionTests(model, usings)];
  if (usesDotnetOutbox(model)) {
    usings.push(namespaceOf(model, 'outbox'));
    members.push(backoffTests());
  }
  if (usesRabbitMq(model)) {
    usings.push(namespaceOf(model, 'rabbitmq'));
    members.push(listenerRetryTests(model));
  }
  if (usesKafka(model)) {
    usings.push(namespaceOf(model, 'kafka'));
    members.push(kafkaRetryTests(model));
  }
  if (usesSnsSqs(model)) {
    usings.push(namespaceOf(model, 'snssqs'));
    members.push(snsSqsRetryTests(model));
  }
  if ((model.events ?? []).length > 0) {
    usings.push(namespaceOf(model, 'integrationEvents'));
    members.push(integrationTests(model));
  }
  const body = `public sealed class MessagingTests
{
${members.join('\n\n')}
}`;
  return [{ path: `${sln.unitTests.dir}/MessagingTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) }];
}

// La metadata de la envoltura de prueba, y lo que tiene que salir en el cable con ella, en el orden de WIRE_SHAPES.
const SAMPLE = {
  eventId: '0190f3a2-6c1e-7b3d-9a4f-2b8c1d0e5f61',
  eventType: 'SampleHappened',
  eventVersion: 1,
  occurredAt: '2026-01-02T03:04:05.006Z',
  source: 'sample-service',
  correlationId: 'corr-1',
  traceparent: null
};

function envelopeTests() {
  const metadata = Object.fromEntries(WIRE_SHAPES.eventMetadata.map((key) => [key, SAMPLE[key]]));
  const wire = JSON.stringify(Object.fromEntries(WIRE_SHAPES.eventEnvelope.map((key) => [key, key === 'metadata' ? metadata : { amount: 1 }])));
  const valid = JSON.stringify({ metadata, data: { anything: true } });
  return `    private static EventMetadata Sample() =>
        new(${csString(SAMPLE.eventId)}, ${csString(SAMPLE.eventType)}, ${SAMPLE.eventVersion}, DateTimeOffset.Parse(${csString(SAMPLE.occurredAt)}, System.Globalization.CultureInfo.InvariantCulture), ${csString(SAMPLE.source)}, null, null);

    [Fact]
    public void LaEnvolturaSaleConLaMetadataEnElOrdenDelCableConSusNulos() =>
        Assert.Equal(${csString(wire)}, EventEnvelope.ToWire(EventEnvelope.Of(Sample(), new { amount = 1 }, ${csString(SAMPLE.correlationId)})));

    [Fact]
    public void LaEnvolturaSeLeeYConservaElEventId()
    {
        var envelope = EventEnvelope.Parse(${csString(valid)});
        Assert.Equal(${csString(SAMPLE.eventId)}, envelope.Metadata.EventId);
        Assert.Equal(${csString(SAMPLE.eventType)}, envelope.Metadata.EventType);
        Assert.Equal(${csString(SAMPLE.correlationId)}, envelope.Metadata.CorrelationId);
        Assert.Null(envelope.Metadata.Traceparent);
        Assert.True(envelope.Data.GetProperty("anything").GetBoolean());
    }

    [Theory]
    [InlineData("no es json", "El mensaje no es JSON válido")]
    [InlineData("""{"data":{}}""", "El mensaje no trae la envoltura Keel (metadata + data)")]
    [InlineData("""{"metadata":{"eventType":"X","eventVersion":1,"occurredAt":"2026-01-02T03:04:05.006Z","source":"s"},"data":{}}""", "La envoltura no trae metadata.eventId")]
    [InlineData("""{"metadata":{"eventId":"${SAMPLE.eventId}","eventType":"X","eventVersion":"uno","occurredAt":"2026-01-02T03:04:05.006Z","source":"s"},"data":{}}""", "metadata.occurredAt o metadata.eventVersion no cumplen el contrato del cable")]
    public void LoQueNoEsUnaEnvolturaIncumpleElContrato(string text, string message) =>
        Assert.Equal(message, Assert.Throws<MessageContractViolation>(() => EventEnvelope.Parse(text)).Message);

    /// <summary>
    /// El eventId es la clave de deduplicación y viaja como TEXTO: un emisor que no lo escribe como uuid sigue siendo un
    /// mensaje válido, como en los servidores de keel-spring y keel-nest.
    /// </summary>
    [Fact]
    public void UnEventIdQueNoEsUuidSeLeeTalCual() =>
        Assert.Equal("evt-ch-010", EventEnvelope.Parse("""{"metadata":{"eventId":"evt-ch-010","eventType":"X","eventVersion":1,"occurredAt":"2026-01-02T03:04:05.006Z","source":"s"},"data":{}}""").Metadata.EventId);`;
}

/** Un valor JSON que NO es del tipo del campo (null si no hay ninguno: un json admite cualquier cosa). */
function wrongValue(field) {
  if (field.base === 'json') return null;
  if (!field.list && field.kind === 'base' && field.base === 'boolean') return '"no-es-booleano"';
  return 'true';
}

function subscriptionTests(model, usings) {
  const tests = [];
  for (const sub of model.subscriptions ?? []) {
    usings.push(namespaceOf(model, 'subscriptionMessages'));
    const record = sub.messageRecord;
    tests.push(`    [Fact]
    public void ${record}DeUnPayloadQueNoEsUnObjetoIncumpleElContrato() =>
        Assert.Equal(${csString(`${sub.name}: el payload no cumple el contrato del cable`)}, Assert.Throws<MessageContractViolation>(() => ${record}.FromWire(Json("[]"))).Message);`);
    const typed = sub.fields.find((field) => wrongValue(field) != null);
    if (typed) {
      const json = `{${JSON.stringify(typed.wireName ?? typed.name)}:${wrongValue(typed)}}`;
      tests.push(`    [Fact]
    public void ${record}ConUnCampoDeOtroTipoIncumpleElContrato() =>
        Assert.Throws<MessageContractViolation>(() => ${record}.FromWire(Json(${csString(json)})));`);
    }
    const required = sub.fields.find((field) => field.required);
    if (required) {
      tests.push(`    [Fact]
    public void ${record}SinUnCampoObligatorioIncumpleElContratoAlComprobarlo()
    {
        var message = ${record}.FromWire(Json("{}"));
        Assert.Equal(${csString(`${sub.name}: el mensaje no trae '${required.name}', que el contrato declara obligatorio`)}, Assert.Throws<MessageContractViolation>(message.RequireContract).Message);
    }`);
    }
  }
  if (tests.length > 0) {
    tests.unshift(`    private static JsonElement Json(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }`);
  }
  return tests;
}

function backoffTests() {
  // La referencia de keel-core, evaluada aquí: el C# tiene que dar lo mismo.
  const cases = [
    [1, 500, 60000],
    [2, 500, 60000],
    [5, 500, 60000],
    [40, 500, 2000],
    [2000, 1000, 300000]
  ].map(([attempts, initial, max]) => `    [InlineData(${attempts}, ${initial}, ${max}, ${outboxBackoffMs(attempts, initial, max)})]`);
  return `    [Theory]
${cases.join('\n')}
    public void ElBackoffDelRelayEsElDeKeelCore(int attempts, long initialMs, long maxMs, long expected) =>
        Assert.Equal(expected, OutboxBackoff.BackoffMs(attempts, initialMs, maxMs));

    [Fact]
    public void LaFilaSeRindeAlAlcanzarElMaximo()
    {
        Assert.False(OutboxBackoff.DeadLettered(9, 10));
        Assert.True(OutboxBackoff.DeadLettered(10, 10));
        Assert.Equal(OutboxBackoff.LastErrorLength, OutboxBackoff.TruncateError(new InvalidOperationException(new string('x', 5000)))!.Length);
    }`;
}

function listenerRetryTests(model) {
  const retry = rabbitListenerRetry(model);
  if (!retry) {
    return `    [Fact]
    public void SinReintentoDeclaradoUnFalloVaAlDescarteAlPrimerIntento()
    {
        Assert.Null(RabbitTopology.Retry);
        Assert.Equal(1, RabbitTopology.ListenerAttempts(RabbitTopology.Retry));
    }`;
  }
  // La curva de keel-spring (ExponentialBackOff): initial·multiplier^(n-1) con su techo.
  const expected = (attempt) => {
    const delay = retry.initialMs * retry.multiplier ** Math.max(attempt - 1, 0);
    return Math.trunc(retry.maxDelayMs != null ? Math.min(delay, retry.maxDelayMs) : delay);
  };
  const rows = [1, 2, 3, 8].map((attempt) => `    [InlineData(${attempt}, ${expected(attempt)})]`);
  return `    [Fact]
    public void ElReintentoDelListenerEsElDelDiseño() => Assert.Equal(${retry.attempts}, RabbitTopology.ListenerAttempts(RabbitTopology.Retry));

    [Theory]
${rows.join('\n')}
    public void LaEsperaEntreIntentosSigueLaCurva(int attempt, long expected) =>
        Assert.Equal(expected, RabbitTopology.ListenerBackoffMs(attempt, RabbitTopology.Retry));

    [Fact]
    public void ElRechazoDeNegocioYElContratoIncumplidoNoSeReintentan()
    {
        Assert.False(RabbitTopology.IsRetryable(new MessageContractViolation("x"), retriesNotFound: true));
        Assert.True(RabbitTopology.IsRetryable(new TimeoutException(), retriesNotFound: false));
    }`;
}

function integrationTests(model) {
  const rows = model.events.map((event) => `    [InlineData(typeof(${event.integrationClass}))]`);
  return `    /// <summary>La metadata del evento de integración no viaja en <c>data</c>: la autoritativa es la de la envoltura.</summary>
    [Theory]
${rows.join('\n')}
    public void LaMetadataNoSeSerializaEnData(Type integration) =>
        Assert.NotNull(integration.GetProperty(${csString(csMember('metadata'))})!.GetCustomAttributes(typeof(JsonIgnoreAttribute), inherit: true).SingleOrDefault());`;
}

function kafkaRetryTests(model) {
  const retry = kafkaListenerRetry(model);
  // La curva del DeadLetterConfig de keel-spring (o el DefaultErrorHandler por defecto: diez intentos sin espera).
  const expected = (attempt) => {
    const delay = retry.initialMs * retry.multiplier ** Math.max(attempt - 1, 0);
    return Math.trunc(retry.maxDelayMs != null ? Math.min(delay, retry.maxDelayMs) : delay);
  };
  const rows = [1, 2, 3, 8].map((attempt) => `    [InlineData(${attempt}, ${expected(attempt)})]`);
  return `    [Fact]
    public void ElReintentoDelConsumidorEsElDelDiseño() => Assert.Equal(${retry.attempts}, KafkaConsumption.Retry.Attempts);

    [Theory]
${rows.join('\n')}
    public void LaEsperaEntreIntentosDelConsumidorSigueLaCurva(int attempt, long expected) =>
        Assert.Equal(expected, KafkaConsumption.ListenerBackoffMs(attempt, KafkaConsumption.Retry));

    [Fact]
    public void ElDescarteDeKafkaEsElTopicPuntoDlt() => Assert.Equal("t.DLT", KafkaConsumption.DeadLetterTopic("t"));

    [Fact]
    public void ElContratoIncumplidoNoSeReintentaEnKafka()
    {
        Assert.False(KafkaConsumption.IsRetryable(new MessageContractViolation("x"), retriesNotFound: true));
        Assert.True(KafkaConsumption.IsRetryable(new TimeoutException(), retriesNotFound: false));
    }`;
}

function snsSqsRetryTests(model) {
  // La visibilidad que oculta un mensaje tras cada recepción fallida (la curva de la skill keel-spring-snssqs), redondeada
  // al segundo: la referencia, evaluada aquí con los datos de keel-core.
  const rows = [];
  snsSqsConsumption(model).forEach((entry, index) => {
    for (const received of [1, 2, 4]) {
      const delay = entry.initialMs * entry.multiplier ** Math.max(received - 1, 0);
      const capped = entry.maxDelayMs != null ? Math.min(delay, entry.maxDelayMs) : delay;
      const seconds = Math.min(Math.max(Math.ceil(capped / 1000), 0), 43200);
      rows.push(`    [InlineData(${index}, ${received}, ${seconds})]`);
    }
  });
  return `    [Theory]
${rows.join('\n')}
    public void LaVisibilidadTrasUnFalloSigueLaCurvaDelDiseño(int subscription, int received, int expected) =>
        Assert.Equal(expected, SnsSqsConsumption.RetryVisibilitySeconds(SnsSqsConsumption.Subscriptions[subscription], received));

    [Fact]
    public void ElContratoIncumplidoNoSeReintentaEnSqs()
    {
        Assert.False(SnsSqsConsumption.IsRetryable(new MessageContractViolation("x"), retriesNotFound: true));
        Assert.True(SnsSqsConsumption.IsRetryable(new TimeoutException(), retriesNotFound: false));
    }`;
}
