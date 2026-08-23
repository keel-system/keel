// Mensajería del servicio: solo los contratos transversales al broker.
// Build genera la EventEnvelope (envoltura de wire que reutiliza la
// EventMetadata que el agregado estampó al emitir: el eventId es la clave de
// idempotencia y no se regenera), por evento el record de integración
// <Evento>IntegrationEvent (gemelo de wire, desacoplado del dominio) y el
// PUERTO <Evento>Publisher (interfaz junto al record del evento en
// domain/events), y el bridge <Servicio>DomainEventBridge que traduce cada
// evento de dominio a su evento de integración y lo entrega según la
// reliability declarada (outbox transaccional o envío tras commit). También el
// record del payload de cada suscripción (contrato de la fuente, con su
// envoltura propia cuando envelope: wrapped).
//
// Lo único que depende del broker elegido (keel-stack.json) es el ENVÍO: la
// implementación de OutboxDispatcher (modo outbox) o de <Evento>Publisher
// (best-effort) y los listeners, que escribe el agente siguiendo la skill
// keel-spring-<broker>.

import { javaFile, javaPath, subPackage } from './render.js';
import { domainTypeImport } from './entities.js';
import { usesOutbox, outboxNames } from './outbox.js';
import { correlationImport } from './correlation.js';
import { deadLetterDestination } from '../lib/dead-letter.js';

const MESSAGING_PKG = 'infrastructure.messaging';
const INTEGRATION_PKG = 'infrastructure.messaging.events';
const EVENTS_PKG = 'domain.events';
const SUBSCRIPTIONS_PKG = 'infrastructure.messaging.subscriptions';

export function generate(model) {
  if (!model.layersPresent.messaging) return [];
  const subscriptions = model.subscriptions ?? [];
  if (model.events.length === 0 && subscriptions.length === 0) return [];

  // El envelope es el contrato de (de)serialización tanto al publicar como al
  // consumir; se genera si hay publicación o suscripción.
  const files = [renderEnvelope(model)];
  const outbox = usesOutbox(model);
  for (const event of model.events) {
    files.push(renderIntegrationEvent(model, event));
    if (!outbox) {
      files.push(renderPublisherPort(model, event));
      files.push(renderPublisherStub(model, event));
    }
  }
  if (model.events.length > 0) files.push(renderBridge(model, outbox));
  for (const sub of subscriptions) {
    files.push(renderSubscriptionMessage(model, sub));
    if (sub.envelopeRecord) files.push(renderSubscriptionEnvelope(model, sub));
  }
  return files;
}

function renderEnvelope(model) {
  const body = `/**
 * Envoltura estándar de los eventos publicados: metadata + payload.
 *
 * La metadata es la MISMA que el agregado estampó al emitir el evento de
 * dominio (ver domain/events/EventMetadata): conserva el eventId, que es la
 * clave de idempotencia del consumidor. Aquí solo se le añade la correlación
 * del request, que el dominio no conoce.
 */
public record EventEnvelope<T>(EventMetadata metadata, T data) {

    public static <T> EventEnvelope<T> of(EventMetadata metadata, T data, String correlationId) {
        return new EventEnvelope<>(metadata.withCorrelationId(correlationId), data);
    }
}`;
  return {
    path: javaPath(model, MESSAGING_PKG, 'EventEnvelope'),
    content: javaFile(subPackage(model, MESSAGING_PKG), [`${subPackage(model, EVENTS_PKG)}.EventMetadata`], body)
  };
}

// Gemelo de wire del evento de dominio: lo que sale del servicio. Existe para
// que un cambio de serialización o de broker nunca obligue a tocar el dominio.
function renderIntegrationEvent(model, event) {
  const imports = new Set([
    `${subPackage(model, EVENTS_PKG)}.EventMetadata`,
    'com.fasterxml.jackson.annotation.JsonIgnore'
  ]);
  const components = event.fields.map((field) => {
    for (const name of field.imports) imports.add(name);
    const typeImport = domainTypeImport(model, field);
    if (typeImport) imports.add(typeImport);
    return `${field.javaType} ${field.name}`;
  });
  const payloadParams = components.join(', ');

  const body = `/**
 * Evento de integración ${event.name}: proyección de wire del evento de dominio
 * ${event.className}${event.channel ? `, publicado en el canal '${event.channel}'` : ''}.
 *
 * Deliberadamente desacoplado del dominio: cambiar el broker o el formato de
 * serialización no debe alcanzar a domain/events.
 *
 * La metadata se conserva como componente (el bridge la necesita para construir
 * la EventEnvelope) pero NO se serializa: la metadata autoritativa del mensaje
 * es la del envelope, y duplicarla en 'data' confundiría al consumidor.
 */
public record ${event.integrationClass}(@JsonIgnore EventMetadata metadata${payloadParams ? `, ${payloadParams}` : ''}) {
}`;
  return {
    path: javaPath(model, INTEGRATION_PKG, event.integrationClass),
    content: javaFile(subPackage(model, INTEGRATION_PKG), [...imports], body)
  };
}

// Bridge domain → integración. Escucha lo que el adaptador de repositorio
// publicó al drenar el agregado y entrega según la reliability del diseño:
//   outbox      → @EventListener síncrono, DENTRO de la transacción del cambio
//                 (la fila y el cambio confirman o revierten juntos).
//   best-effort → @TransactionalEventListener(AFTER_COMMIT): nunca se publica
//                 un evento de una transacción que revirtió.
function renderBridge(model, outbox) {
  const imports = new Set([
    correlationImport(model),
    'org.springframework.stereotype.Component'
    // EventEnvelope vive en este mismo paquete: no se importa.
  ]);
  for (const event of model.events) {
    imports.add(`${subPackage(model, EVENTS_PKG)}.${event.className}`);
    imports.add(`${subPackage(model, INTEGRATION_PKG)}.${event.integrationClass}`);
  }

  const fields = [];
  const ctorParams = [];
  const ctorAssigns = [];

  if (outbox) {
    imports.add('org.springframework.beans.factory.annotation.Value');
    imports.add('org.springframework.context.event.EventListener');
    imports.add('com.fasterxml.jackson.core.JsonProcessingException');
    imports.add('com.fasterxml.jackson.databind.ObjectMapper');
    // El espejo persistido del outbox cambia de nombre con el modelo (Jpa /
    // Document), pero el bridge lo usa igual: escribe la fila y se acabó.
    const outboxTypes = outboxNames(model);
    imports.add(`${subPackage(model, 'infrastructure.messaging.outbox')}.${outboxTypes.entity}`);
    imports.add(`${subPackage(model, 'infrastructure.messaging.outbox')}.${outboxTypes.repository}`);
    imports.add('java.time.Instant');
    imports.add('java.util.UUID');
    fields.push(
      `    private final ${outboxTypes.repository} outboxRepository;`,
      '    private final ObjectMapper objectMapper;'
    );
    ctorParams.push(`${outboxTypes.repository} outboxRepository`, 'ObjectMapper objectMapper');
    ctorAssigns.push('        this.outboxRepository = outboxRepository;', '        this.objectMapper = objectMapper;');
  } else {
    imports.add('org.springframework.transaction.event.TransactionalEventListener');
    imports.add('org.springframework.transaction.event.TransactionPhase');
    for (const event of model.events) {
      imports.add(`${subPackage(model, EVENTS_PKG)}.${event.publisherClass}`);
      const field = publisherField(event);
      fields.push(`    private final ${event.publisherClass} ${field};`);
      ctorParams.push(`${event.publisherClass} ${field}`);
      ctorAssigns.push(`        this.${field} = ${field};`);
    }
  }

  // Destino y routing key solo los necesita el modo outbox, que es quien escribe
  // la fila (append). En best-effort el bridge no toca el transporte: cada
  // <Evento>Publisher lee sus propias propiedades, así que declararlas aquí
  // dejaba un @Value muerto por evento más el del destino.
  const destinationField =
    outbox && model.events[0]
      ? `    @Value("\${${model.events[0].destinationProperty}:${model.events[0].destinationDefault}}")\n    private String destination;`
      : '';
  const routingFields = outbox
    ? model.events
        .map(
          (event) =>
            `    @Value("\${${event.routingKeyProperty}:${event.routingKeyDefault}}")\n    private String ${routingField(event)};`
        )
        .join('\n\n')
    : '';

  const methods = model.events.map((event) => renderBridgeMethod(event, outbox)).join('\n\n');

  const body = `/**
 * ${model.service.className}DomainEventBridge — traduce cada evento de dominio a su evento de
 * integración y lo entrega ${
   outbox
     ? 'al outbox DENTRO de la transacción que provocó el cambio: la fila y el\n * cambio del agregado confirman o revierten juntos (reliability: outbox).'
     : 'tras confirmar la transacción (reliability: best-effort): un rollback\n * no publica nada, pero un fallo del broker sí pierde el evento.'
 }
 *
 * Los eventos llegan aquí porque el adaptador de repositorio drena
 * pullDomainEvents() al persistir el agregado. Nadie más publica eventos.
 */
@Component
public class ${model.service.className}DomainEventBridge {

${[destinationField, routingFields, fields.join('\n')].filter(Boolean).join('\n\n')}

    public ${model.service.className}DomainEventBridge(${ctorParams.join(', ')}) {
${ctorAssigns.join('\n')}
    }

${methods}${outbox ? `\n\n${renderOutboxAppend(model)}` : ''}
}`;

  return {
    path: javaPath(model, MESSAGING_PKG, `${model.service.className}DomainEventBridge`),
    content: javaFile(subPackage(model, MESSAGING_PKG), [...imports], body)
  };
}

function renderBridgeMethod(event, outbox) {
  const args = event.fields.map((f) => `event.${f.name}()`).join(', ');
  const listener = outbox ? '@EventListener' : '@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)';
  // El `eventType` de la fila del outbox es la ETIQUETA DEL SOBRE, no el tipo Java: el
  // dispatcher la publica como atributo nativo del mensaje (message attribute en SNS,
  // `props.setType` en AMQP) y en SNS es sobre ESE valor que filtra la FilterPolicy que
  // siembra `init-messaging.sh` — cuyos valores salen de `eventTypesByChannel`, o sea,
  // del nombre del evento en el diseño. Con el nombre de la clase el filtro no casa y
  // SNS descarta el mensaje EN SILENCIO: no hay error, ni log, ni excepción; el evento
  // simplemente no llega. Debe ser el mismo literal que estampa EventMetadata.now(...)
  // en el cuerpo, o el sobre y la carta dirían cosas distintas.
  const delivery = outbox
    ? `        append(${routingField(event)}, "${event.name}", envelope);`
    : `        ${publisherField(event)}.publish(integrationEvent, correlationId);`;

  // La envoltura solo la construye el bridge en modo outbox: es lo que serializa
  // en la fila. En best-effort la arma el publisher (tiene que hacerlo de todos
  // modos, porque es quien conoce el transporte), así que calcularla aquí dejaba
  // una variable local sin usar por evento.
  const envelope = outbox
    ? `        EventEnvelope<${event.integrationClass}> envelope = EventEnvelope.of(event.metadata(), integrationEvent, correlationId);\n`
    : '';

  return `    /** ${event.name}: evento de dominio → evento de integración. */
    ${listener}
    public void on${event.className}(${event.className} event) {
        String correlationId = CorrelationContext.get();
        ${event.integrationClass} integrationEvent = new ${event.integrationClass}(event.metadata()${args ? `, ${args}` : ''});
${envelope}${delivery}
    }`;
}

// Escritura de la fila del outbox: misma transacción que el cambio del agregado.
function renderOutboxAppend(model) {
  return `    private void append(String routingKey, String eventType, EventEnvelope<?> envelope) {
        try {
            outboxRepository.save(new ${outboxNames(model).entity}(
                    UUID.randomUUID(),
                    destination,
                    routingKey,
                    eventType,
                    objectMapper.writeValueAsString(envelope),
                    Instant.now(),
                    null,
                    0,
                    null,
                    null));
        } catch (JsonProcessingException ex) {
            // Serializar un evento propio no puede fallar: si falla, el diseño
            // del payload está roto y la transacción debe revertir.
            throw new IllegalStateException("No se pudo serializar el evento " + eventType, ex);
        }
    }`;
}

function publisherField(event) {
  return event.publisherClass[0].toLowerCase() + event.publisherClass.slice(1);
}

function routingField(event) {
  return `${event.className[0].toLowerCase()}${event.className.slice(1).replace(/Event$/, '')}RoutingKey`;
}

// Puerto de publicación del evento: interfaz pura en domain/events. Solo existe
// en modo best-effort; con outbox la entrega la hace el relay vía OutboxDispatcher.
function renderPublisherPort(model, event) {
  const body = `/**
 * Puerto de publicación del evento de integración ${event.name}. La
 * implementación (broker del stack) vive en infrastructure/messaging y la
 * escribe el agente; el único que lo invoca es el bridge de eventos.
 */
public interface ${event.publisherClass} {

    void publish(${event.integrationClass} event, String correlationId);
}`;
  return {
    path: javaPath(model, EVENTS_PKG, event.publisherClass),
    content: javaFile(subPackage(model, EVENTS_PKG), [`${subPackage(model, INTEGRATION_PKG)}.${event.integrationClass}`], body)
  };
}

// Stub transversal del puerto: satisface la inyección para que el contexto
// arranque sin broker; el agente lo sustituye por el publisher real.
function renderPublisherStub(model, event) {
  const stubClass = `${event.publisherClass}Stub`;
  const body = `@Component
public class ${stubClass} implements ${event.publisherClass} {

    private static final Logger log = LoggerFactory.getLogger(${stubClass}.class);

    @Override
    public void publish(${event.integrationClass} event, String correlationId) {
        // TODO (agente): sustituir este stub por el publisher real del broker
        //   elegido en keel-stack.json (skill keel-spring-<broker>):
        //   envolver con EventEnvelope.of(event.metadata(), event, correlationId)
        //   y publicar en el destino/routing key declarados. Mientras tanto solo
        //   se traza, para que el contexto arranque sin broker.
        log.warn("Publisher no implementado: {} no salió del servicio (correlationId={})", "${event.name}", correlationId);
    }
}`;
  return {
    path: javaPath(model, MESSAGING_PKG, stubClass),
    content: javaFile(subPackage(model, MESSAGING_PKG), [
      'org.slf4j.Logger',
      'org.slf4j.LoggerFactory',
      'org.springframework.stereotype.Component',
      `${subPackage(model, INTEGRATION_PKG)}.${event.integrationClass}`,
      `${subPackage(model, EVENTS_PKG)}.${event.publisherClass}`
    ], body)
  };
}

// Record del payload esperado del evento suscrito (contrato de la fuente).
// El listener que lo consume depende del broker: lo escribe el agente
// (skill keel-spring-<broker>) despachando la operación
// 'triggers' vía UseCaseMediator.
/**
 * Anticorrupción del payload entrante: los campos que el diseño declara `required`
 * tienen que venir de verdad.
 *
 * `@JsonIgnoreProperties(ignoreUnknown = true)` cubre los campos de MÁS. Los que
 * FALTAN entran como `null` sin que nada chiste, y no todos son inocuos: la marca
 * temporal que ordena las reentregas —para que un hecho viejo no pise a uno nuevo—
 * es un campo más de este record, y nula esa garantía se cae en silencio.
 *
 * **Va en un método aparte y NO en el constructor compacto**, que es la diferencia
 * con la guarda gemela de `http-clients.js`, y no es simetría mal hecha: en una
 * respuesta HTTP lanzar sube y sale como 500, pero aquí una excepción dispara el
 * `onFailure.retry` del diseño y acaba mandando el mensaje al DESCARTE. Un canal
 * compartido trae mensajes que no son nuestros —y hay que descartarlos sin lanzar,
 * como ya avisa el javadoc del contrato—, así que una guarda en el constructor
 * saltaría al deserializar, antes del filtro por `eventType`, y mandaría a la DLQ un
 * mensaje ajeno perfectamente válido. Por eso la llamada va DESPUÉS de enrutar, y
 * por eso `check-idempotency.sh` la exige (familia `payloadContract`): un método que
 * nadie llama no comprueba nada.
 */
function requireContractMethod(sub) {
  const required = (sub.fields ?? []).filter((field) => field.required);
  if (required.length === 0) return '';

  const checks = required
    .map(
      (field) => `        if (${field.name} == null) {
            throw new IllegalStateException(
                    "${sub.name}: el mensaje no trae '${field.name}', que el contrato declara obligatorio");
        }`
    )
    .join('\n');

  return `
    /**
     * Contrato de la fuente: los campos que el diseño declara obligatorios tienen que
     * venir. Llámalo DESPUÉS de filtrar por {@code metadata.eventType} — un mensaje
     * ajeno del canal compartido se descarta SIN lanzar, y lanzar aquí lo mandaría al
     * descarte. Un payload que incumple el contrato sí agota sus reintentos y acaba
     * en el descarte: es lo correcto, no se va a volver válido reintentándolo.
     */
    public void requireContract() {
${checks}
    }
`;
}

function renderSubscriptionMessage(model, sub) {
  const imports = new Set();
  for (const field of sub.fields) {
    for (const name of field.imports) imports.add(name);
    // Un enum o value object del diseño vive en otro paquete: sin este import el
    // record no compila (los campos de tipo de dominio no traen su propio import).
    const typeImport = domainTypeImport(model, field);
    if (typeImport) imports.add(typeImport);
  }
  // wireName: la fuente externa nombra el campo distinto que el diseño.
  const components = sub.fields
    .map((f) => {
      if (!f.wireName) return `${f.javaType} ${f.name}`;
      imports.add('com.fasterxml.jackson.annotation.JsonProperty');
      return `@JsonProperty("${f.wireName}") ${f.javaType} ${f.name}`;
    })
    .join(', ');

  const annotations = [];
  if (sub.unknownFields !== 'fail') {
    imports.add('com.fasterxml.jackson.annotation.JsonIgnoreProperties');
    annotations.push('@JsonIgnoreProperties(ignoreUnknown = true)');
  }

  const body = `/**
 * Payload del evento ${sub.name}${sub.source ? ` (fuente: ${sub.source})` : ''}.
${contractJavadoc(sub, model)} */
${annotations.map((a) => `${a}\n`).join('')}public record ${sub.messageRecord}(${components}) {
${requireContractMethod(sub)}}`;
  return {
    path: javaPath(model, SUBSCRIPTIONS_PKG, sub.messageRecord),
    content: javaFile(subPackage(model, SUBSCRIPTIONS_PKG), [...imports], body)
  };
}

// Envoltura propia de la fuente (envelope: wrapped): el payload cuelga de
// payloadPath, no de la EventEnvelope de Keel.
function renderSubscriptionEnvelope(model, sub) {
  const imports = new Set(['com.fasterxml.jackson.annotation.JsonIgnoreProperties']);
  const components = [];
  const path = sub.payloadPath.split('.');
  if (path.length > 1) {
    // Payload anidado: el agente completa los niveles intermedios.
    components.push(`Object ${path[0]}`);
  } else {
    components.push(`${sub.messageRecord} ${path[0]}`);
  }
  if (sub.discriminator?.location === 'field' && !sub.discriminator.name.includes('.')) {
    components.push(`String ${sub.discriminator.name}`);
  }
  if (sub.messageId?.location === 'field' && !sub.messageId.name.includes('.')) {
    components.push(`String ${sub.messageId.name}`);
  }

  const body = `/**
 * Envoltura con la que ${sub.source ?? 'la fuente'} publica ${sub.name}: el
 * payload cuelga de '${sub.payloadPath}'.
${path.length > 1 ? ` * TODO (agente): tipar los niveles intermedios de '${sub.payloadPath}' hasta ${sub.messageRecord}.\n` : ''} */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ${sub.envelopeRecord}(${components.join(', ')}) {
}`;
  return {
    path: javaPath(model, SUBSCRIPTIONS_PKG, sub.envelopeRecord),
    content: javaFile(subPackage(model, SUBSCRIPTIONS_PKG), [...imports], body)
  };
}

// El contrato de recepción, escrito donde el agente lo va a leer al escribir el listener.
function contractJavadoc(sub, model) {
  const lines = [];
  if (sub.envelope === 'wrapped') {
    lines.push(`Llega envuelto en ${sub.envelopeRecord}; el payload cuelga de '${sub.payloadPath}'.`);
  } else if (sub.envelope === 'keel') {
    lines.push('Llega en la EventEnvelope estándar de Keel (metadata + data).');
  } else {
    lines.push('Llega plano: el mensaje es este payload.');
  }
  if (sub.format !== 'json') {
    lines.push(`Formato: ${sub.format}${sub.schemaRef ? ` (schema '${sub.schemaRef}')` : ''}.`);
  }
  if (sub.discriminator) {
    lines.push(
      `Se reconoce por ${sub.discriminator.location} '${sub.discriminator.name}' == '${sub.discriminator.value}': el canal transporta más tipos, descarta el resto.`
    );
  } else if (sub.envelope === 'keel') {
    // El discriminador que NADIE declara y que hace falta igual. Con una fuente ajena
    // el diseño escribe `contract.discriminator` y este javadoc lo baja al listener;
    // con una fuente Keel no hay nada que declarar —`metadata.eventType` viaja siempre—
    // y por eso se olvidaba: el destino por convención es `<source>.events`, que
    // transporta TODOS los eventos de esa fuente, así que un listener sin filtro
    // despacha como suyo lo que no lo es. Se dice aunque este diseño tenga una sola
    // suscripción de ese origen: cuántos tipos viajan por el canal lo decide lo que
    // PUBLICA el emisor, no lo que nosotros consumimos.
    const shared = (model.subscriptions ?? [])
      .filter((other) => other.name !== sub.name && other.topicDefault === sub.topicDefault)
      .map((other) => other.name);
    lines.push(
      `Se reconoce por metadata.eventType == '${sub.name}': '${sub.topicDefault}' transporta todos los eventos de ${sub.source ?? 'la fuente'}, ` +
        `así que descarta el resto SIN lanzar excepción (una excepción dispara onFailure.retry y acaba mandando al descarte un mensaje válido que no era para ti).` +
        (shared.length > 0 ? ` En este diseño el destino lo comparten ${shared.join(', ')}.` : '')
    );
  }
  // De dónde sale la clave de deduplicación. El contrato puede declararla —una fuente
  // ajena que la pone en un metadato nativo del broker o en un campo del cuerpo—, pero con
  // la envoltura Keel ya existe sin declarar nada: `metadata.eventId`. Y con `none` o
  // `wrapped` sin `messageId` no hay ninguna, así que tampoco hay orden que prescribir.
  const dedupeKey = sub.messageId
    ? `${sub.messageId.location} '${sub.messageId.name}'`
    : sub.envelope === 'keel'
      ? 'metadata.eventId de la envoltura (lo estampa el emisor en el raise y viaja intacto)'
      : null;
  if (dedupeKey) {
    lines.push(`Deduplica por ${dedupeKey} antes de despachar (la entrega es at-least-once).`);
    // El orden del registro no es estilo: decide si un fallo transitorio se
    // reintenta o se traga el mensaje. Lo elige el diseño, no el agente.
    // Qué es lo que frena la repetición cambia la frase, y la frase es lo que el agente
    // implementa: decir «declara transiciones» sobre una operación guardada por su clave
    // natural es falso y manda a buscar un lifecycle que no existe.
    const guardReason =
      sub.triggerGuardKind === 'natural-key'
        ? `la clave de idempotencia participa en la clave natural del agregado, así que esa constraint ES la guarda —permanente y común a todas las puertas por las que entre la operación—`
        : `la operación declara transiciones, así que la repetición la frena el agregado`;
    lines.push(
      sub.triggerHasDomainGuard
        ? `Orden: IdempotencyGuard.alreadyProcessed(...) antes de despachar y record(...) DESPUÉS de que el handler termine bien. ${guardReason} y lo que no puede perderse es el mensaje: registrar ANTES haría que un fallo terminal se viera como «ya procesado» y su reintento no llegara nunca al descarte.`
        : `Orden: IdempotencyGuard.tryRecord(...) antes de despachar — la operación no declara ninguna guarda de dominio (ni transiciones, ni una clave de idempotencia sobre la clave natural) que frene la repetición, así que la ventana se cierra reclamando antes. Ojo: un fallo del handler deja el mensaje marcado y perdido; si eso no es tolerable, lo que falta es la guarda de dominio en el diseño.`
    );
    // La ventana. Se dice AQUÍ —y no solo en la referencia del DSL— porque este javadoc
    // es lo que lee quien escribe el listener, y la garantía que va a implementar no es
    // la que su nombre sugiere: el registro se purga, así que «no se procesa dos veces»
    // tiene fecha de caducidad. Con guarda de dominio da igual (el agregado no caduca);
    // sin ella, el efecto es repetible en cuanto pasa la retención.
    lines.push(
      `La deduplicación tiene VENTANA: el registro se purga a los processed-event.purge.retention-days (default 14, en parameters/), así que una reentrega posterior se procesa como nueva.` +
        (sub.triggerHasDomainGuard
          ? ` Aquí es inocuo: ${sub.triggerGuardKind === 'natural-key' ? 'la constraint de la clave natural' : 'la transición del agregado'} sigue rechazándola, y esa no caduca.`
          : ' Aquí NO es inocuo: sin transición que la frene, pasada la retención el efecto se vuelve a aplicar. Si el negocio necesita una ventana mayor, el mecanismo correcto es una guarda de dominio, no esta deduplicación — y eso es un hueco del diseño, no algo que se arregle en el listener.')
    );
  }
  // La identidad de quien pide el trabajo. Por HTTP la pone el proveedor de identidad en
  // un claim; por un broker no llega ningún token, así que el diseño declara qué lo
  // sustituye — y si eso no se dice AQUÍ, que es lo que lee quien escribe el listener, la
  // costura de un solo punto que el DSL promete acaba repartida por el handler, o peor:
  // el inquilino se toma del payload, que lo elige el llamante.
  if (sub.identity) {
    lines.push(
      `Identidad del emisor: resuelve ${sub.identity.field} desde ${sub.identity.from.location === 'header' ? `el header '${sub.identity.from.name}'` : `el campo '${sub.identity.from.name}' del mensaje`}, y pásala YA RESUELTA a la operación. No la leas del payload: el DSL prohíbe que viaje ahí precisamente para que no haya dos versiones de la verdad.`
    );
    lines.push(
      sub.identity.onUnresolved === 'deadLetter'
        ? `Un emisor que no corresponda a nadie registrado va a la cola de descartes (onUnresolved: deadLetter): NO lo proceses y NO lo confirmes en silencio, porque el caso frecuente es un alta que falta y en silencio son efectos que no ocurren sin que nada dé error.`
        : `Un emisor que no corresponda a nadie registrado se descarta (onUnresolved: discard): confirma el mensaje y déjalo trazado en el log. Es un fallo PERMANENTE — reintentarlo no hará aparecer un registro que no existe.`
    );
  }
  // Otro camino puede sacar a la entidad del mismo estado antes que este listener. El
  // guard del agregado arbitra, y al perdedor se le rechaza la transición: eso es la
  // carrera resuelta, no un fallo. Si el handler lo trata como error, onFailure.retry lo
  // reintenta y acaba en la DLQ un mensaje perfectamente válido — ruido operativo que se
  // lee como incidente. Solo se dice cuando build ve la carrera, no en toda suscripción.
  if ((sub.triggerRaces ?? []).length > 0) {
    lines.push(
      `Compite con ${sub.triggerRaces.join(', ')}: sacan la entidad del mismo estado. Si al despachar la transición se rechaza porque otro llegó antes, es la carrera resuelta y NO un fallo — confirma el mensaje y no lo reintentes.`
    );
    // Cuál es «se rechaza» no es evidente: el perdedor de una carrera SECUENCIAL topa con
    // el guard del agregado, y el de una SIMULTÁNEA con el bloqueo optimista al hacer
    // commit. Son la misma carrera con dos desenlaces, así que las dos van en el mismo
    // catch. Se nombra la base de Spring (OptimisticLockingFailureException) y no la de
    // JPA: cubre también la documental, y un catch por motor es una divergencia que se
    // paga con el mensaje válido en la DLQ.
    lines.push(
      `Se rechaza de DOS formas y las dos son esta carrera: InvalidStateTransitionException (otro camino ya movió el estado) y OptimisticLockingFailureException (llegasteis a la vez y perdió el commit) — captúralas juntas, la segunda con la base de org.springframework.dao, no con la de JPA ni la de Mongo.`
    );
    if (sub.triggerHasDomainGuard) {
      // Sin esto, la rama se escribe con un `return` seco y cada reentrega vuelve a cruzar
      // el dominio entero para lanzar y capturar la misma excepción. El mensaje SÍ quedó
      // atendido: lo atendió el otro camino.
      lines.push(
        `Esa rama termina igualmente en IdempotencyGuard.record(...): el mensaje quedó atendido —por el otro camino— y sin registrarlo cada reentrega vuelve a atravesar el dominio para acabar en el mismo catch.`
      );
    }
  }
  // La capa dependencies puede etiquetar esta suscripción como compensación de una
  // dependencia: no cambia el código, pero sí por qué existe.
  if (sub.compensates) {
    const { dependency, description, undoes, moves } = sub.compensates;
    lines.push(
      `Compensa la dependencia de ${dependency}${undoes ? ` deshaciendo la activación '${undoes}'` : ''}${description ? `: ${description}` : '.'}`
    );
    if (moves.length > 0) {
      lines.push(
        `Ese trabajo movió el lifecycle de ${moves.join(', ')}: la operación que despacha este listener tiene que devolver ese estado, no solo avisar al proveedor.`
      );
    }
  }
  if (sub.deadLetter) {
    // La topología es de BUILD desde que `dead-letter-config.js` la genera para los tres
    // brokers. Antes esto decía «lo configura el agente», y con eso el campo del DSL
    // declaraba una garantía que solo existía en SNS/SQS y cuyo destino nadie podía
    // nombrar: ningún escenario podía afirmar sobre la cola.
    const destination = deadLetterDestination(model.stack?.broker, model, sub);
    lines.push(
      `Con onFailure.deadLetter: tras agotar los reintentos el broker mueve el mensaje a ${destination}. La topología la genera build — NO la declares tú.`
    );
  }
  if (sub.trigger) {
    const args = sub.triggerArguments
      .map((a) => `${a.component} = ${a.source ? `payload.${a.source}()` : 'TODO (agente)'}`)
      .join(', ');
    lines.push(
      `Lo consume ${sub.listenerClass} (listener del broker del stack; lo escribe el agente) despachando ${sub.triggerMessageClass ?? sub.trigger}${args ? `(${args})` : ''} vía UseCaseMediator.`
    );
  } else {
    lines.push(`Lo consume ${sub.listenerClass} (listener del broker del stack; lo escribe el agente).`);
  }
  return lines.map((line) => ` * ${line}\n`).join('');
}
