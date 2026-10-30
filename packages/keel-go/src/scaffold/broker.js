// Lo que el agente escribe para el broker (incremento 9), y dónde lo engancha el arranque.
//
// El envío y la recepción dependen del broker de `keel-stack.json`: el messaging.Dispatcher del outbox (o un
// <Evento>Publisher por evento con best-effort) y los listeners de las suscripciones. En keel-spring los recoge el
// component-scan y en keel-dotnet se registran en BrokerBindings.cs; aquí van en UN archivo del paquete del arranque,
// `cmd/server/broker.go`, que build siembra una vez SIN la cabecera de código generado (es del agente) con dos funciones
// que `run` llama: brokerAdapters (lo de salida, antes de los repositorios, que necesitan el puente) y messageListeners
// (lo de entrada, después de los casos de uso, que es lo que despachan). Los tipos que se intercambian son de build, en
// `cmd/server/messaging.go`: el agente no tiene que inventarse la forma.

import { consumerUnits } from '@keel-system/keel-core/gen/messaging-plan';
import { alignRows } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';
import { MESSAGING_IMPORT, publisherPort, usesBestEffort, usesGoOutbox } from './messaging.js';
import { RABBITMQ_IMPORT, usesGoRabbitMq } from './rabbitmq.js';

/**
 * La conexión del broker que build genera y que recibe lo del agente (en brokerAdapters y en inbound), o null si build
 * no genera ninguna para ese broker.
 */
export function brokerConnection(model) {
  if (usesGoRabbitMq(model)) return { name: 'rabbit', field: 'Rabbit', type: '*rabbitmq.Connection', import: RABBITMQ_IMPORT, method: 'Publish', consume: 'Consume' };
  return null;
}

/** ¿Publica el servicio? Entonces hay adaptadores de salida. */
export function publishes(model) {
  return usesGoOutbox(model) || usesBestEffort(model);
}

/** ¿Consume? Entonces hay listeners. */
export function consumes(model) {
  return (model.subscriptions ?? []).length > 0;
}

export function brokerFiles(model) {
  const { server } = layout(model);
  const broker = model.stack?.broker ?? '<broker>';
  const connection = brokerConnection(model);
  const own = connection ? [connection.import] : [];
  return [
    { path: `${server.dir}/messaging.go`, content: packageFile(model, server, { imports: ['context', 'log/slog', 'internal/application', MESSAGING_IMPORT, ...(consumes(model) ? own : [])], body: typesBody(model) }) },
    { path: `${server.dir}/broker.go`, content: packageFile(model, server, { imports: ['log/slog', MESSAGING_IMPORT, ...(publishes(model) ? own : [])], body: agentBody(model, broker), generated: false }) }
  ];
}

function typesBody(model) {
  const parts = [];
  if (publishes(model)) {
    const rows = usesGoOutbox(model)
      ? [{ indent: '\t', cells: ['Dispatcher', 'messaging.Dispatcher'] }]
      : [{ indent: '\t', cells: ['Publishers', 'messaging.Publishers'] }];
    parts.push(`// outbound son los adaptadores de salida del broker que devuelve brokerAdapters (cmd/server/broker.go). Lo que quede
// a nil es el respaldo de build: ${usesGoOutbox(model) ? 'el dispatcher que no deja arrancar fuera de local y test' : 'el publisher que solo avisa'}.
type outbound struct {
${alignRows(rows).join('\n')}
}`);
  }
  if (consumes(model)) {
    const connection = brokerConnection(model);
    const rows = [
      { indent: '\t', cells: ['Settings', 'messaging.Settings'] },
      ...(connection ? [{ indent: '\t', cells: [connection.field, connection.type] }] : []),
      { indent: '\t', cells: ['UseCases', '*application.UseCases'] },
      { indent: '\t', cells: ['Guard', '*messaging.IdempotencyGuard'] },
      { indent: '\t', cells: ['Logger', '*slog.Logger'] }
    ];
    parts.push(`// inbound es lo que reciben los listeners: la mensajería del perfil (el topic, la cola o el grupo de cada
// suscripción)${connection ? `, la conexión con el broker (${connection.field}: se consume con ${connection.field}.${connection.consume})` : ''}, los casos de uso que
// despachan, la guarda de los mensajes procesados y el logger.
type inbound struct {
${alignRows(rows).join('\n')}
}

// listener consume su cola, topic o grupo hasta que ctx se cancela; un error que devuelva para el servicio entero.
type listener func(ctx context.Context) error`);
  }
  return `\n${parts.join('\n\n')}\n`;
}

function agentBody(model, broker) {
  const connection = brokerConnection(model);
  const parts = [`// Lo que el agente escribe para el broker de keel-stack.json (${broker}), con la skill keel-go-${broker}: el envío y la
// recepción. Build siembra este archivo una vez y no lo pisa; los tipos que se intercambian están en messaging.go.`];
  if (publishes(model)) {
    const ports = usesGoOutbox(model)
      ? ['messaging.Dispatcher (Dispatcher): el envío de cada fila del outbox al broker, que tiene que fallar si el broker no confirma.']
      : model.events.map((event) => `messaging.${publisherPort(event)} (Publishers.${publisherPort(event).replace(/Publisher$/, '')}): publica ${event.name} después del commit.`);
    parts.push(`// brokerAdapters son las implementaciones de los puertos de salida del broker:
${ports.map((port) => `//   - ${port}`).join('\n')}
//
// Lo que se deje a nil es el respaldo de build. Se llama ANTES de construir los repositorios, que reciben el puente.${
      connection
        ? `
// ${connection.name} es la conexión con el broker que mantiene build: se publica con ${connection.name}.${connection.method}, que vuelve cuando el
// broker confirma.`
        : ''
    }
func brokerAdapters(settings messaging.Settings, ${connection ? `${connection.name} ${connection.type}, ` : ''}logger *slog.Logger) (outbound, error) {
	// TODO (agente): una implementación por puerto, con la skill keel-go-${broker}.
	return outbound{}, nil
}`);
  }
  if (consumes(model)) {
    const perSubscription = model.stack?.broker === 'kafka' || model.stack?.broker === 'snssqs';
    const listeners = consumerUnits(model).map((unit) =>
      unit.group ? `uno para ${unit.subscriptions[0]} (consumer group ${unit.group})` : `uno para la cola ${unit.queue} (${unit.subscriptions.join(', ')})`
    );
    parts.push(`// messageListeners son los listeners de las suscripciones, ${perSubscription ? 'UNO POR SUSCRIPCIÓN' : 'UNO POR COLA y no uno por suscripción'}:
${listeners.map((line) => `//   - ${line}`).join('\n')}
//
// ${
      model.stack?.broker === 'snssqs'
        ? 'Cada suscripción tiene su cola propia, suscrita al topic de la fuente con filtro por su tipo: a cada listener solo\n// le llega lo suyo.'
        : perSubscription
          ? 'Cada suscripción tiene su consumer group, que recibe el topic entero: dos de la misma fuente leen el mismo topic y\n// cada una descarta lo que no es suyo por el tipo del mensaje.'
          : 'Dos consumidores de la misma cola compiten y cada mensaje llega a uno solo: el de una cola compartida enruta por el\n// tipo del mensaje.'
    } El contrato de cada mensaje (cómo leerlo, cómo deduplicarlo y qué
// despachar) está en el comentario de su tipo en internal/infrastructure/messaging. Se llama DESPUÉS de construir los
// casos de uso; cada listener corre en su goroutine hasta que se apaga el servicio.
func messageListeners(deps inbound) ([]listener, error) {
	// TODO (agente): los listeners de arriba, con la skill keel-go-${broker}.
	return nil, nil
}`);
  }
  return `\n${parts.join('\n\n')}\n`;
}
