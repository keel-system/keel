// La higiene de los logs que escribe el AGENTE (incremento 14e de PLAN-KEEL-DOTNET.md): `infra/check-logging.sh`, el
// gemelo del de keel-spring y keel-nest con patrones de C#. Los logs de las fronteras los fija build; los de negocio los
// añade el agente, y ahí hay formas de equivocarse que no rompen nada y salen caras.
//
// Es un gate de PROHIBICIÓN: nace VERDE sobre el árbol recién generado y se pone rojo cuando el agente introduce una
// forma vetada. Lo ejecuta el motor neutral de keel-core (`gen/source-gate.js`), en bash y awk: el proyecto no tiene por
// qué tener otro runtime que el de .NET.
//
// Lo que es propio de .NET:
//   · el mensaje construido a mano (`$"…"` o una concatenación) sí se traduce de keel-spring: Microsoft.Extensions.Logging
//     tiene plantillas con argumentos estructurados, y un mensaje interpolado los pierde (en JSON no salen como campos);
//   · el contexto (la correlación, la transacción del caso de uso y la traza) vive en AsyncLocal, que el
//     ExecutionContext lleva a Task.Run, a los temporizadores y a un Thread nuevo. Lo que lo PIERDE son las formas
//     «Unsafe» y SuppressFlow, y esas son las que se vetan.
//
// Las reglas son datos (exportadas): el test recorre esta misma lista y la falsa regla a regla, con su forma prohibida
// (`sample`) y su forma correcta (`allowed`), así que una regla nueva no entra sin su caso.

import { sourceGate } from '@keel-system/keel-core/gen/source-gate';
import { usesTelemetry } from '@keel-system/keel-core/gen/telemetry-vocabulary';

/** Dónde busca el gate y cómo son los comentarios de C#: la plataforma del motor neutral. */
export const CS_SOURCE = { root: 'src', extension: 'cs', excludeDirs: ['bin', 'obj'], lineComment: '//', blockComment: ['/*', '*/'] };

// Una llamada de log: las extensiones de ILogger (`LogInformation(`, `Log(`) o un método de [LoggerMessage] (`LogPublished(`).
const LOG_CALL = '(^|[^A-Za-z0-9_])Log[A-Za-z]*[[:space:]]*[(]';
// Solo las extensiones de ILogger, cuyo primer argumento de texto es la PLANTILLA.
const LOG_EXTENSION = '[.]Log(Trace|Debug|Information|Warning|Error|Critical)?[[:space:]]*[(]';
const ENTRY = '(command|query|dto|request|payload|body|envelope)';

export const LOGGING_RULES = [
  {
    id: 'wholeObject',
    pattern: `${LOG_CALL}[^;]*([,(][[:space:]]*${ENTRY}[[:space:]]*[,)]|JsonSerializer[.]Serialize[(][[:space:]]*${ENTRY}|[{]${ENTRY}[}])`,
    why: 'loguea un objeto de entrada entero: lleva al backend de logs todos los datos de quien llama (emails, documentos, tokens), y cambia cuando el diseño añade un campo; loguea solo ids o campos concretos',
    sample: 'logger.LogInformation("Recibido {Command}", command);',
    allowed: 'logger.LogInformation("Recibido el pedido {OrderId}", command.OrderId);'
  },
  {
    id: 'template',
    pattern: `${LOG_EXTENSION}[^;]*([$]"|"[[:space:]]*[+])`,
    why: 'construye el mensaje a mano (interpolado o concatenado): la cadena se forma aunque el nivel esté apagado y los valores dejan de ser argumentos, así que en JSON no salen como campos; usa una plantilla con sus argumentos, o mejor un método [LoggerMessage]',
    sample: 'logger.LogInformation($"Pedido {orderId} creado");',
    allowed: 'logger.LogInformation("Pedido {OrderId} creado", orderId);'
  },
  {
    id: 'errorLevel',
    pattern: '([.]Log(Error|Critical)[[:space:]]*[(]|LogLevel[.](Error|Critical))',
    paths: ['^src/[^/]+[.](Domain|Application)/'],
    why: 'un ERROR desde el dominio o los casos de uso: ahí un fallo se LANZA y lo registra la frontera, una vez y con su pila; un error logueado y tragado es justo lo que el diseño no puede ver. Si es una degradación elegida, Warning',
    sample: 'logger.LogError("No se pudo reservar");',
    allowed: 'throw new StockUnavailableException("No se pudo reservar");'
  },
  {
    id: 'console',
    pattern: '(^|[^A-Za-z0-9_.])Console[.](Write|WriteLine|Out|Error)',
    why: 'escribe en la consola a pelo: se salta el logger del servicio, así que la línea sale sin formato ECS, sin nivel y sin correlationId ni traza; usa ILogger<T>',
    sample: 'Console.WriteLine($"pedido creado {id}");',
    allowed: 'logger.LogInformation("Pedido {Id} creado", id);'
  },
  {
    id: 'context',
    pattern: '(UnsafeQueueUserWorkItem|UnsafeRegister|UnsafeStart|ExecutionContext[.]SuppressFlow)',
    why: 'lanza trabajo SIN el contexto de la petición: sin correlationId, sin la transacción del caso de uso y, con telemetría, sin la traza. Task.Run y await lo conservan; las formas Unsafe y SuppressFlow no',
    sample: 'ThreadPool.UnsafeQueueUserWorkItem(_ => Resize(id), null);',
    allowed: 'await Task.WhenAll(portA.Find(id), portB.Find(id));'
  }
];

export function generate(model) {
  if (!(model.services ?? []).some((service) => (service.operations ?? []).length > 0)) return [];
  return [{ path: 'infra/check-logging.sh', content: script(model), executable: true }];
}

function script(model) {
  return `#!/usr/bin/env bash
# check-logging.sh — higiene de los logs de ${model.service.name}.
#
# Los logs de las fronteras los genera build; los de negocio los escribe el agente. Este gate veta cinco formas que no
# rompen nada y salen caras: loguear un objeto de entrada entero, construir el mensaje a mano, un ERROR desde Domain o
# Application (ahí un fallo se lanza y lo registra la frontera), la consola a pelo (se salta el logger del servicio) y
# lanzar trabajo sin el contexto de la petición.
#
# Uso (desde la raíz del proyecto; no necesita infraestructura ni compilar):
#   bash infra/check-logging.sh
#
# Código de salida:
#   0  sin hallazgos
#   1  hay hallazgos → vuelven al agente de código
set -u

if [ ! -d src ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró src/)." >&2
  exit 1
fi

${sourceGate({
  title: 'HIGIENE DE LOGS Y CONTEXTO',
  label: 'logging',
  rules: LOGGING_RULES.map(({ id, pattern, paths, exclude, why }) => ({ id, pattern, paths, exclude, why })),
  footer: usesTelemetry(model)
    ? 'Ver docs/keel/conventions/observability.md § Reglas para quien escribe código.'
    : 'Loguea con ILogger<T> (mejor con [LoggerMessage]): el logger del servicio pone el formato, el nivel y la correlación.',
  platform: CS_SOURCE
})}
`;
}
