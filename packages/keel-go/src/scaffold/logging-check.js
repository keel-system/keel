// La higiene de los logs que escribe el AGENTE (incremento 14e): `infra/check-logging.sh`, el gemelo del de los otros tres con
// patrones de Go. Los logs de las fronteras los fija build; los de negocio los añade el agente, y ahí hay formas de equivocarse
// que no rompen nada y salen caras.
//
// Es un gate de PROHIBICIÓN: nace VERDE sobre el árbol recién generado y se pone rojo cuando el agente introduce una forma
// vetada. Lo ejecuta el motor neutral de keel-core (`gen/source-gate.js`), en bash y awk: el proyecto no tiene por qué tener otro
// runtime que el de Go. Mira lo que se ejecuta: las pruebas (`_test.go`) escriben lo que necesitan.
//
// Lo que es propio de Go:
//   · la correlación y la traza viajan en el context.Context y llegan a la línea solo si se escribe con él: `logger.Info` sin
//     Context compila y las pierde. Lo mismo un `context.Background()` para lanzar trabajo;
//   · una llamada a `slog.Info`, el logger global, se salta los niveles y el formato solo si no se cableó; aquí se veta porque
//     quien escribe tiene el logger del servicio delante (`useCaseLogger(ctx)` en un handler);
//   · el mensaje construido con `fmt.Sprintf` pierde los atributos estructurados, como una plantilla interpolada.
//
// Las reglas son datos (exportadas): el test recorre esta misma lista y la falsa regla a regla, con su forma prohibida (`sample`)
// y su forma correcta (`allowed`), así que una regla nueva no entra sin su caso.

import { sourceGate } from '@keel-system/keel-core/gen/source-gate';
import { usesTelemetry } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { GO_GATE } from './idempotency-check.js';
import { personalFieldNames } from '@keel-system/keel-core/gen/personal-data';
import { goExported } from '../lib/go-projection.js';

/** Dónde busca el gate y cómo son los comentarios de Go: la plataforma del motor neutral. */
export const GO_SOURCE = { root: '.', extension: 'go', excludeDirs: GO_GATE.excludeDirs, lineComment: '//', blockComment: ['/*', '*/'] };

/** Las pruebas no cuentan: en ellas, la salida es para quien las lee. */
export const NOT_TESTS = '_test[.]go$';

// Una llamada de log: los métodos de un *slog.Logger, con o sin Context.
const LOG_CALL = '[.](Debug|Info|Warn|Error)(Context)?[(]';
const ENTRY = '(command|cmd|query|msg|dto|request|payload|body|envelope)';

/** Lo que build escribe y sí registra un ERROR: la frontera de los casos de uso y lo que corre tras el commit. */
const FRONTIER_FILES = ['/usecase[.]go$', '/after_commit[.]go$', '/operation_cache[.]go$', '/payment_outcomes[.]go$'];

/** Lo que build escribe componiendo el mensaje: el adaptador del logger de go-redis, que recibe un formato, y la caché caída. */
const BUILT_MESSAGES = ['/operation_cache[.]go$', '/internal/infrastructure/cache/store[.]go$'];

/** Lo que build escribe donde no hay un contexto que pasar: el arranque del relay y el cierre de una conexión fallida. */
const BUILT_WITHOUT_CONTEXT = ['/internal/infrastructure/messaging/outbox[.]go$', '/internal/infrastructure/(rabbitmq|kafka|snssqs)/'];

export const LOGGING_RULES = [
  {
    id: 'wholeObject',
    pattern: `(logger|Logger[(][^)]*[)])${LOG_CALL}.*,[[:space:]]*${ENTRY}[[:space:]]*[,)]`,
    exclude: [NOT_TESTS],
    why: 'loguea un objeto de entrada entero: lleva al backend de logs todos los datos de quien llama (emails, documentos, tokens), y cambia cuando el diseño añade un campo; loguea solo ids o campos concretos',
    sample: 'logger.InfoContext(ctx, "recibido", "command", command)',
    allowed: 'logger.InfoContext(ctx, "recibido", "orderId", command.OrderID)'
  },
  {
    id: 'template',
    // El mensaje es el primer texto: un atributo con fmt.Sprint es un atributo.
    pattern: `(logger|Logger[(][^)]*[)])${LOG_CALL}([^,]*,)?[[:space:]]*("[^"]*"[[:space:]]*[+][[:space:]]*)?fmt[.]Sprint`,
    exclude: [NOT_TESTS, ...BUILT_MESSAGES],
    why: 'construye el mensaje a mano: la cadena se forma aunque el nivel esté apagado y los valores dejan de ser atributos, así que en JSON no salen como campos; usa un mensaje fijo con sus atributos',
    sample: 'logger.InfoContext(ctx, fmt.Sprintf("pedido %s creado", id))',
    allowed: 'logger.InfoContext(ctx, "pedido creado", "orderId", id)'
  },
  {
    id: 'errorLevel',
    pattern: '[.]Error(Context)?[(]ctx',
    paths: ['^[.]/internal/(domain|application)/'],
    exclude: [NOT_TESTS, ...FRONTIER_FILES],
    why: 'un ERROR desde el dominio o los casos de uso: ahí un fallo se DEVUELVE y lo registra el borde, una vez y con su contexto; un error logueado y tragado es justo lo que el diseño no puede ver. Si es una degradación elegida, Warn',
    sample: 'logger.ErrorContext(ctx, "no se pudo reservar")',
    allowed: 'logger.WarnContext(ctx, "no se pudo reservar")'
  },
  {
    id: 'console',
    pattern: '(^|[^A-Za-z0-9_.])(fmt[.]Print(ln|f)?[(]|println[(]|print[(]|log[.](Print|Fatal|Panic)(ln|f)?[(]|slog[.](Debug|Info|Warn|Error)(Context)?[(])',
    exclude: [NOT_TESTS],
    why: 'escribe en la consola a pelo o con el logger global: se salta el logger del servicio, así que la línea sale sin formato ECS y sin correlationId ni traza; usa el *slog.Logger que recibe tu adaptador (useCaseLogger(ctx) en un handler)',
    sample: 'fmt.Println("pedido creado", id)',
    allowed: 'logger.InfoContext(ctx, "pedido creado", "orderId", id)'
  },
  {
    id: 'noContext',
    pattern: '(logger|Logger[(][^)]*[)])[.](Debug|Info|Warn|Error)[(]',
    exclude: [NOT_TESTS, ...BUILT_WITHOUT_CONTEXT],
    why: 'escribe sin el contexto: la correlación y la traza viajan en el context.Context y llegan a la línea solo si se escribe con él; usa InfoContext(ctx, ...), que es lo que hace que la línea se pueda encontrar',
    sample: 'logger.Info("pedido creado", "orderId", id)',
    allowed: 'logger.InfoContext(ctx, "pedido creado", "orderId", id)'
  },
  {
    id: 'context',
    pattern: 'context[.](Background|TODO)[(]',
    // El main (context.Background es de ahí) y la conexión con SNS/SQS, que construye su cliente sin ninguna petición delante.
    exclude: [NOT_TESTS, '^[.]/cmd/server/main[.]go$', '/internal/infrastructure/snssqs/connection[.]go$'],
    why: 'lanza trabajo SIN el contexto de la petición: sin correlationId, sin la transacción del caso de uso, sin la cancelación y, con telemetría, sin la traza. Hereda el contexto que recibes; lo que tiene que sobrevivir a la cancelación, context.WithoutCancel(ctx)',
    sample: 'go resize(context.Background(), id)',
    allowed: 'go resize(context.WithoutCancel(ctx), id)'
  }
];

/**
 * La regla de los datos PERSONALES (DSL 2.28, D10, PD-1): un campo que el diseño marca `personal` dentro de una llamada de
 * log (`cmd.Email`, `card.DisplayName()`). Por nombre, como el resto del gate: un homónimo de otra entidad que no es
 * personal también casa, y es preferible al revés. Null si el diseño no marca ninguno. La misma regla que los otros tres,
 * sobre el campo o el accesor de Go.
 */
export function personalRule(model) {
  const names = [...new Set(personalFieldNames(model).map(goExported))];
  if (names.length === 0) return null;
  return {
    id: 'personal',
    pattern: `${LOG_CALL}.*[.](${names.join('|')})([^A-Za-z0-9_]|$)`,
    exclude: [NOT_TESTS],
    why: `loguea un campo que el diseño marca personal (DSL 2.28: ${names.join(', ')}): su valor no puede acabar en el backend de logs; loguea el id del agregado`
  };
}

export function generate(model) {
  if (!(model.services ?? []).some((service) => (service.operations ?? []).length > 0)) return [];
  return [{ path: 'infra/check-logging.sh', content: script(model), executable: true }];
}

function script(model) {
  return `#!/usr/bin/env bash
# check-logging.sh — higiene de los logs de ${model.service.name}.
#
# Los logs de las fronteras los genera build; los de negocio los escribe el agente. Este gate veta seis formas que no
# rompen nada y salen caras: loguear un objeto de entrada entero, construir el mensaje a mano, un ERROR desde el dominio o
# los casos de uso (ahí un fallo se devuelve y lo registra el borde), la consola a pelo o el logger global (se saltan el
# logger del servicio), escribir sin el contexto y lanzar trabajo sin el contexto de la petición.
#
# Uso (desde la raíz del proyecto; no necesita infraestructura ni compilar):
#   bash infra/check-logging.sh
#
# Código de salida:
#   0  sin hallazgos
#   1  hay hallazgos → vuelven al agente de código
set -u

if [ ! -f go.mod ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró go.mod)." >&2
  exit 1
fi

${sourceGate({
  title: 'HIGIENE DE LOGS Y CONTEXTO',
  label: 'logging',
  rules: [...LOGGING_RULES.map(({ id, pattern, paths, exclude, why }) => ({ id, pattern, paths, exclude, why })), ...[personalRule(model)].filter(Boolean)],
  footer: usesTelemetry(model)
    ? 'Ver docs/keel/conventions/observability.md § Reglas para quien escribe código.'
    : 'Loguea con el *slog.Logger del servicio y con Context: pone el formato, el nivel y la correlación.',
  platform: GO_SOURCE
})}
`;
}
