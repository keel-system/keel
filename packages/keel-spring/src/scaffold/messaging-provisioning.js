// Aprovisionamiento de la topología de mensajería de prueba (broker: snssqs).
//
// Existe por la misma razón que auth-provisioning.js: los nombres de los topics,
// las colas, sus DLQ y las suscripciones son un CONTRATO entre el código generado
// (los @Value de los publishers, los @SqsListener), el arnés de integración (que
// compone la URL de la cola por concatenación) y la infraestructura. Mientras no
// existió este script, nadie creaba esos recursos: la app arrancaba apuntando a un
// topic inexistente y el humo del arnés moría con NonExistentQueue. El equivalente
// para identidad (init-keycloak.sh) y para storage (el sidecar minio-init) ya
// estaban; esto cerraba la asimetría.
//
// Solo aplica a snssqs. Kafka autocrea topics y RabbitMQ declara sus exchanges y
// colas desde la propia aplicación, así que ahí no hay topología que sembrar.

import { kebabCase } from '../lib/naming.js';

// Reintentos por defecto cuando el diseño no declara `onFailure.retry`. SQS mueve
// el mensaje a la DLQ al agotar la cuenta; el contador incluye las reapariciones
// por visibility timeout, no solo los errores reales.
const DEFAULT_MAX_RECEIVE = 5;

const ENDPOINT = 'http://localstack:4566';
const REGION = 'us-east-1';
const ACCOUNT = '000000000000';

/** Envuelve un valor como literal seguro entre comillas simples para bash. */
function sq(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** ¿El stack necesita sembrar topología de mensajería? */
export function needsMessagingProvisioning(model) {
  return Boolean(model.layersPresent?.messaging) && model.stack?.broker === 'snssqs';
}

/**
 * Nombre de la cola que respalda un canal de publicación en la infraestructura de
 * prueba. **Es un contrato con el arnés**: `AbstractFlowIT#publishedMessages` compone
 * la URL de la cola concatenando el nombre del canal (ver integration-tests.js,
 * rama snssqs), así que la cola tiene que llamarse exactamente como el canal.
 *
 * Existe como función y no como literal repartido porque los dos extremos —el
 * script que la crea y el check que la verifica— tienen que derivarla del mismo
 * sitio; mientras el nombre estuvo implícito solo en el Java, el script sembraba
 * las colas de las suscripciones (`<servicio>-<sub>`) y ninguna con el nombre del
 * canal: el humo del arnés moría con NonExistentQueue en todo servicio que
 * publicara sin consumir.
 */
export function harnessQueueName(channel) {
  return channel;
}

/** Colas de arnés que exige el sondeo de eventos: una por canal de publicación. */
function harnessQueues(model) {
  const { messaging } = model;
  return (messaging.publishChannels ?? []).map((channel) => ({
    name: harnessQueueName(channel),
    // El canal es una agrupación LÓGICA: todo viaja por el destino físico único
    // del servicio y se discrimina por `eventType` (ver model.js § collectChannels).
    // Por eso la cola cuelga de `destinationDefault`, no de un topic por canal.
    topic: messaging.destinationDefault,
    eventTypes: messaging.eventTypesByChannel?.[channel] ?? []
  }));
}

/**
 * infra/init-messaging.sh — topics, colas, DLQ y suscripciones SNS→SQS.
 * Devuelve `null` si el stack no lo necesita.
 */
export function messagingProvisioning(model) {
  if (!needsMessagingProvisioning(model)) return null;

  const { service, messaging, subscriptions = [] } = model;

  // Una cola por suscripción, colgada del topic de su fuente. El nombre lo fija el
  // consumidor (este servicio), no la fuente: dos consumidores del mismo topic
  // necesitan colas distintas para recibir ambos el mensaje.
  const queues = subscriptions.map((sub) => ({
    name: `${service.artifactId}-${kebabCase(sub.name)}`,
    topic: sub.topicDefault,
    eventTypes: [sub.name],
    // `retry` es la retryPolicy del diseño; lo que SQS cuenta es el número de
    // recepciones, es decir, maxAttempts.
    maxReceive: sub.retry?.maxAttempts ?? DEFAULT_MAX_RECEIVE,
    deadLetter: sub.deadLetter !== false
  }));

  // Los topics que hay que crear: el destino físico de este servicio y los de las
  // fuentes que consumimos (en local no hay nadie más que los cree). Los canales
  // NO son topics: son la agrupación lógica dentro del destino único.
  const sourceTopics = [...new Set(queues.map((q) => q.topic))];
  const allTopics = [...new Set([messaging.destinationDefault, ...sourceTopics])];

  const renderQueue = (queue) =>
    (queue.deadLetter === false
      ? `create_queue ${sq(queue.name)}`
      : `create_queue_with_dlq ${sq(queue.name)} ${queue.maxReceive ?? DEFAULT_MAX_RECEIVE}`) +
    `\nsubscribe ${sq(queue.topic)} ${sq(queue.name)}${queue.eventTypes.map((type) => ` ${sq(type)}`).join('')}`;

  const blocks = [
    `echo "== Topics =="
${allTopics.map((topic) => `create_topic ${sq(topic)}`).join('\n')}`
  ];

  const harness = harnessQueues(model);
  if (harness.length > 0) {
    blocks.push(`# Colas de ARNÉS: no las consume la aplicación, existen para que el arnés de
# integración (AbstractFlowIT#publishedMessages / #purgeMessages) pueda leer y
# purgar lo que este servicio publica. Una por canal declarado, con el nombre del
# canal y filtrada por los eventos que el diseño enruta a él.
echo "== Colas de arnés (sondeo de lo publicado) =="
${harness.map(renderQueue).join('\n')}`);
  }

  if (queues.length > 0) {
    blocks.push(`echo "== Colas de negocio, DLQ y suscripciones =="
${queues.map(renderQueue).join('\n')}`);
  }

  const content = `#!/usr/bin/env bash
# init-messaging.sh — siembra la topología SNS/SQS de prueba de ${service.name}
# en el LocalStack de infra/docker-compose.yaml: topics, colas, sus DLQ y las
# suscripciones SNS→SQS con raw message delivery.
#
# Generado por keel-spring build a partir de specs/messaging.keel.yaml: los
# nombres son los mismos que llegan al codigo por @Value y los que compone el
# arnes de integracion. No se editan aqui a mano — si algo cambia, cambia en el
# diseno y se regenera.
#
# RAW MESSAGE DELIVERY es obligatorio: sin el, SNS mete el mensaje real dentro de
# su propio sobre ({"Type":"Notification","Message":"..."}) y el listener recibe
# una envoltura que el contrato del diseno no describe. Ver
# la skill keel-spring-snssqs.
#
# En AWS real esta topologia la crea la plataforma (IaC), no este script.
#
# Idempotente: create-topic y create-queue de AWS devuelven el recurso existente,
# y las suscripciones se comprueban antes de crearse. Se puede reejecutar tras
# cada 'compose up'. Uso (desde la raiz del proyecto; con podman, exporta
# CONTAINER_RUNTIME=podman):
#   bash infra/init-messaging.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1

RUNTIME="\${CONTAINER_RUNTIME:-}"
if [ -z "$RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then RUNTIME=podman
  else echo "No se encontro docker ni podman en el PATH." >&2; exit 2; fi
fi

DEVTOOLS=${sq(`${service.name}-devtools`)}
AWS="aws --endpoint-url ${ENDPOINT} --region ${REGION}"

# Las credenciales dummy las trae el propio contenedor devtools (docker-compose).
run() { $RUNTIME exec "$DEVTOOLS" sh -c "$*"; }

# El JSON de un parametro (RedrivePolicy, FilterPolicy...) NUNCA viaja en el argv:
# podman.exe en Windows reconstruye la linea de comandos antes de reenviarla al
# contenedor y corrompe las comillas dobles anidadas — el mismo problema que ya
# documenta AbstractFlowIT#copyToDevtools, y que aqui llegaba como una politica
# silenciosamente malformada. El JSON entra por stdin a un archivo del contenedor
# y se referencia como file://, que la CLI de aws resuelve igual. 'podman cp' no
# sirve de alternativa: falla al traducir rutas del host en Windows.
put_json() { $RUNTIME exec -i "$DEVTOOLS" sh -c "cat > $1"; }

topic_arn() { echo "arn:aws:sns:${REGION}:${ACCOUNT}:$1"; }
queue_url() { echo "${ENDPOINT}/${ACCOUNT}/$1"; }
queue_arn() { echo "arn:aws:sqs:${REGION}:${ACCOUNT}:$1"; }

create_topic() {
  run "$AWS sns create-topic --name $1" >/dev/null
  echo "  topic   $1"
}

create_queue() {
  run "$AWS sqs create-queue --queue-name $1" >/dev/null
  echo "  cola    $1"
}

# Cola + su DLQ, enlazadas por RedrivePolicy. maxReceiveCount sale del
# onFailure.retry del diseno: agotado, SQS mueve el mensaje a la DLQ sin que haya
# codigo de reintento que escribir.
create_queue_with_dlq() {
  queue="$1"; max_receive="$2"; dlq="\${queue}-dlq"
  create_queue "$dlq"
  create_queue "$queue"
  # El valor de RedrivePolicy es a su vez una cadena JSON: de ahi las comillas
  # escapadas. En un heredoc SIN comillas la barra invertida solo es especial ante
  # $, \` y \\, asi que \\" llega literal al archivo.
  put_json /tmp/keel-redrive.json <<JSON
{"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"$(queue_arn "$dlq")\\",\\"maxReceiveCount\\":\\"\${max_receive}\\"}"}
JSON
  run "$AWS sqs set-queue-attributes --queue-url $(queue_url "$queue") \\
        --attributes file:///tmp/keel-redrive.json" >/dev/null
  echo "  redrive $queue -> $dlq (maxReceiveCount=\${max_receive})"
}

# Suscripcion SNS -> SQS con raw delivery y filtro por eventType: un unico topic
# fisico hace fan-out a varias colas, y cada una recibe solo los tipos de evento
# que se le pasen. Sin tipos, la cola recibe todo lo del topic.
#   subscribe <topic> <cola> [eventType...]
subscribe() {
  topic="$1"; queue="$2"; shift 2
  arn=$(topic_arn "$topic")
  endpoint=$(queue_arn "$queue")
  existing=$(run "$AWS sns list-subscriptions-by-topic --topic-arn $arn \\
        --query \\"Subscriptions[?Endpoint=='\${endpoint}'].SubscriptionArn\\" --output text" | tr -d '\\r')
  if [ -n "$existing" ] && [ "$existing" != "None" ]; then
    echo "  sub     $topic -> $queue (ya existia)"
    return
  fi
  sub_arn=$(run "$AWS sns subscribe --topic-arn $arn --protocol sqs \\
        --notification-endpoint $endpoint --query SubscriptionArn --output text" | tr -d '\\r')
  # Los atributos se fijan de uno en uno y despues de suscribir: --attributes es un
  # mapa con sintaxis abreviada Clave=Valor,Clave=Valor y no admite un valor con
  # comas, que es justo lo que tiene el JSON del filtro.
  run "$AWS sns set-subscription-attributes --subscription-arn $sub_arn \\
        --attribute-name RawMessageDelivery --attribute-value true" >/dev/null
  if [ "$#" -eq 0 ]; then
    echo "  sub     $topic -> $queue (raw, sin filtro)"
    return
  fi
  types=""
  for event_type in "$@"; do
    if [ -n "$types" ]; then types="\${types},"; fi
    types="\${types}\\"\${event_type}\\""
  done
  put_json /tmp/keel-filter.json <<JSON
{"eventType":[\${types}]}
JSON
  run "$AWS sns set-subscription-attributes --subscription-arn $sub_arn \\
        --attribute-name FilterPolicy --attribute-value file:///tmp/keel-filter.json" >/dev/null
  echo "  sub     $topic -> $queue (raw, eventType in [\${types}])"
}

echo "Sembrando topologia SNS/SQS de ${service.name}…"

${blocks.join('\n\n')}

echo "Topologia lista. Verifica con:"
echo "  bash infra/validate-infra.sh"
`;

  return { path: 'infra/init-messaging.sh', content };
}

/**
 * Checks de `validate-infra.sh` para la topología: que cada topic y cada cola
 * EXISTAN, no solo que LocalStack responda. El check del catálogo (`sns
 * list-topics`) da verde con la lista vacía, que es justo el estado roto.
 */
export function messagingTopologyChecks(model) {
  if (!needsMessagingProvisioning(model)) return [];

  const { service, messaging, subscriptions = [] } = model;
  const aws = `aws --endpoint-url ${ENDPOINT} --region ${REGION}`;
  // El destino físico que publicamos y los de las fuentes que consumimos: en local
  // nadie más los crea, y una suscripción colgada de un topic ausente no da error
  // visible.
  const topics = [
    ...new Set([messaging.destinationDefault, ...subscriptions.map((sub) => sub.topicDefault)])
  ];
  const checks = topics.map((topic) => ({
    label: `topic ${topic}`,
    cmd: `${aws} sns get-topic-attributes --topic-arn arn:aws:sns:${REGION}:${ACCOUNT}:${topic}`
  }));

  const queues = [
    // Las de arnés van primero porque su ausencia tumba la suite entera (el humo
    // del arnés) y no solo un flujo de negocio.
    ...harnessQueues(model).map((queue) => queue.name),
    ...subscriptions.map((sub) => `${service.artifactId}-${kebabCase(sub.name)}`)
  ];
  for (const queue of queues) {
    checks.push({
      label: `cola ${queue}`,
      cmd: `${aws} sqs get-queue-url --queue-name ${queue}`
    });
  }
  return checks;
}
