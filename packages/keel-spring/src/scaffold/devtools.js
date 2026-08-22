// Contenedor `devtools` de validación de infraestructura (portado del proyecto
// de referencia). Es una caja de herramientas Alpine con solo las CLIs del stack
// elegido (psql, redis-cli, kcat, mc, aws…) que el agente alcanza vía
// `docker exec` para sondear que BD/broker/cache/storage responden antes de la
// verificación funcional. Se acompaña de `validate-infra.sh`, que ejecuta un
// check por tecnología. Consume `selectedInfra(model)` de stack-catalog.js.

import { createHash } from 'node:crypto';
import { declaredBuckets } from '../lib/buckets.js';
import { deadLetterDestination, deadLetterSubscriptions, subscriptionDestination } from '../lib/dead-letter.js';
import { LOCAL_AWS_ENV } from '../lib/stack-catalog.js';
import { messagingTopologyChecks } from './messaging-provisioning.js';

// Paquetes base del toolbox: shell + utilidades de red/JSON comunes a todos los checks.
const BASE_PACKAGES = ['bash', 'curl', 'jq', 'netcat-openbsd'];

// Resolución del runtime de contenedores. La comparten todos los scripts generados
// —los de `infra/` y los de `deploy/`—: mismo criterio y mismo mensaje de error.
export const RUNTIME_RESOLUTION = `RUNTIME="\${CONTAINER_RUNTIME:-}"
if [ -z "$RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then RUNTIME=podman
  else echo "No se encontró docker ni podman en el PATH." >&2; exit 2; fi
fi`;

/**
 * Resolución del frontend de compose, ya con el archivo y los argumentos fijados.
 *
 * El sondeo es `compose ls` y NO `compose version`, y la diferencia es la que hace
 * que esto funcione: `podman compose` no implementa compose, DELEGA en el binario de
 * Docker Compose que encuentre. `version` lo contesta ese binario solo, sin tocar el
 * motor, así que sale 0 incluso cuando no puede hablar con podman —el caso típico en
 * Windows, donde el docker-compose.exe del PATH busca el named pipe de Docker Desktop
 * y no el de la máquina de podman—. El resultado era un fallback que nunca se
 * activaba y un `up` que muere con un error de conexión que no menciona compose.
 * `ls` enumera proyectos: para contestarlo hay que llegar al motor.
 *
 * @param {string[]} args argumentos comunes (`-f <archivo>`, `--env-file`…).
 */
export function composeResolution(args) {
  const rendered = args.join(' ');
  return `COMPOSE=()
if [ "$RUNTIME" = "podman" ] && ! podman compose ls >/dev/null 2>&1; then
  # El frontend delegado no alcanza el motor: podman-compose es un binario aparte
  # que habla con podman directamente.
  if command -v podman-compose >/dev/null 2>&1; then
    COMPOSE=(podman-compose ${rendered})
  else
    echo "podman no puede ejecutar compose ('podman compose ls' falla) y no encuentro podman-compose." >&2
    echo "Instala podman-compose ('pip install podman-compose') o arranca la máquina ('podman machine start')." >&2
    exit 2
  fi
else
  COMPOSE=("$RUNTIME" compose ${rendered})
fi`;
}

// ¿El stack necesita el contenedor devtools? (alguna CLI vive en el toolbox).
export function needsDevtools(selected) {
  return selected.some((s) => s.cliVia === 'devtools');
}

// infra/docker/Dockerfile: base + los apk de las CLIs con cliVia 'devtools' + las
// que se instalan por curl (sqlcmd para SQL Server, mc para MinIO).
export function dockerfileDevtools(selected) {
  const viaDevtools = selected.filter((s) => s.cliVia === 'devtools');
  const apk = new Set(BASE_PACKAGES);
  for (const s of viaDevtools) for (const pkg of s.entry.alpinePackages ?? []) apk.add(pkg);

  const lines = [
    '# Toolbox de validación de infraestructura generado por keel-spring.',
    '# Solo trae las CLIs del stack elegido (keel-stack.json). Sin puertos: es un',
    '# objetivo interno de `docker exec`, no un servicio expuesto.',
    'FROM alpine:3.20',
    `RUN apk add --no-cache ${[...apk].join(' ')}`
  ];

  const ids = new Set(selected.map((s) => s.id));
  if (ids.has('sqlserver')) {
    // sqlcmd (go-sqlcmd): binario estático; no hay paquete apk.
    lines.push(
      'RUN apk add --no-cache bzip2 tar \\',
      ' && curl -sSL https://github.com/microsoft/go-sqlcmd/releases/download/v1.8.0/sqlcmd-linux-amd64.tar.bz2 \\',
      '    | tar -xj -C /usr/local/bin sqlcmd \\',
      ' && chmod +x /usr/local/bin/sqlcmd'
    );
  }
  if (ids.has('minio')) {
    // mc (MinIO client): binario oficial; no hay paquete apk.
    lines.push(
      'RUN curl -sSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc \\',
      ' && chmod +x /usr/local/bin/mc'
    );
  }

  lines.push('WORKDIR /scripts', 'CMD ["sleep", "infinity"]', '');
  return lines.join('\n');
}

// Servicio `devtools` del docker-compose: se construye desde ./docker (relativo
// al propio compose, dentro de infra/), queda vivo con `sleep infinity` y depende
// de los servicios que va a sondear.
/**
 * Etiqueta de la imagen del toolbox, derivada del CONTENIDO de su Dockerfile.
 *
 * Sin ella, compose la nombra por proyecto (`<proyecto>_devtools:latest`) y no
 * reconstruye una etiqueta que ya existe: quien haya levantado el proyecto una vez
 * sigue corriendo el toolbox viejo para siempre. Duele en dos casos que no son
 * raros — cambiar de broker en el cuestionario de stack, y ampliar el toolbox en
 * una versión nueva del generador—, y duele mal: el síntoma es un `aws: not found`
 * o un `kcat: not found` en `validate-infra.sh`, que se lee como infraestructura
 * rota y no como imagen caducada. Con la etiqueta atada al contenido, un toolbox
 * distinto es una imagen distinta y compose no tiene nada que reutilizar.
 */
export function devtoolsImageTag(selected) {
  return createHash('sha256').update(dockerfileDevtools(selected)).digest('hex').slice(0, 12);
}

export function devtoolsService(selected, service) {
  const dependsOn = [...new Set(selected.filter((s) => s.cliVia === 'devtools').map((s) => s.serviceKey))];
  return {
    // Sin clave `dockerfile:` a propósito, y por eso el archivo se llama
    // `Dockerfile` a secas: podman-compose no la honra —busca el nombre por
    // defecto en el contexto y aborta con "no Containerfile or Dockerfile
    // specified or found"—, así que el proyecto generado no se podía construir
    // con el único frontend de compose que funciona en podman sobre Windows. El
    // directorio `docker/` ya acota qué imagen es: el sufijo no aportaba nada.
    build: { context: './docker' },
    image: `${service.name}-devtools:${devtoolsImageTag(selected)}`,
    container_name: `${service.name}-devtools`,
    command: 'sleep infinity',
    // Siempre, no solo con broker snssqs: el mismo toolbox sirve al storage
    // (MinIO habla S3) y son credenciales dummy sin efecto fuera de la infra local.
    environment: { ...LOCAL_AWS_ENV },
    ...(dependsOn.length > 0 ? { depends_on: dependsOn } : {})
  };
}

// validate-infra.sh: un check por tecnología. Ejecuta el cliValidateCmd (con las
// credenciales del catálogo ya sustituidas) dentro del contenedor que corresponda
// —devtools, o el propio contenedor de la BD para cliVia 'dbcontainer'— y sale
// con código != 0 si alguno falla.
export function validateInfraScript(selected, service, model = null) {
  const dbName = service.name.replace(/-/g, '_');
  // Puerto por defecto del servicio (config.js: `${SERVER_PORT:8080}`).
  const appPort = 8080;
  const checks = selected
    .filter((s) => s.entry.cliValidateCmd)
    .map((s) => {
      const container = s.cliVia === 'dbcontainer' ? `${service.name}-db` : `${service.name}-devtools`;
      const label = `${s.entry.label} (${s.serviceKey})`;
      return `check ${sq(label)} ${sq(container)} ${sq(concreteCmd(s.entry, dbName))}`;
    });
  checks.push(...bucketChecks(selected, service, model));
  // Topología de mensajería: que los topics y colas EXISTAN. El check del
  // catálogo (`sns list-topics`) da verde con la lista vacía, que es justo el
  // estado roto — LocalStack sano y ni un solo recurso sembrado.
  for (const { label, cmd } of messagingTopologyChecks(model ?? {})) {
    checks.push(`check ${sq(label)} ${sq(`${service.name}-devtools`)} ${sq(cmd)}`);
  }

  return `#!/usr/bin/env bash
# validate-infra.sh — sondea la infraestructura de prueba de ${service.name}.
# Un check por tecnología elegida en keel-stack.json; ejecuta cada CLI dentro
# del contenedor devtools (o del propio contenedor de la BD). Uso (desde la raíz
# del proyecto; con podman, exporta CONTAINER_RUNTIME=podman):
#   bash infra/up.sh && bash infra/validate-infra.sh
set -u

${RUNTIME_RESOLUTION}

fail=0
# Reintentos porque 'Up' no es 'listo': Keycloak en start-dev, Kafka y LocalStack
# publican su listener bastante después de que el contenedor arranque, y un solo
# intento a los pocos segundos de 'up -d' da un FALLO que a la segunda pasada es
# verde — un falso negativo que hace perder el tiempo buscando en la infra lo que
# no está roto. Con la infra sana el primer intento acierta y esto no cuesta nada.
RETRIES="\${KEEL_CHECK_RETRIES:-5}"
DELAY="\${KEEL_CHECK_DELAY:-5}"
check() {
  label="$1"; container="$2"; cmd="$3"
  attempt=1
  while [ "$attempt" -le "$RETRIES" ]; do
    if $RUNTIME exec "$container" sh -c "$cmd" >/dev/null 2>&1; then
      echo "  OK     $label"
      return
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -le "$RETRIES" ] && sleep "$DELAY"
  done
  echo "  FALLO  $label (tras $RETRIES intentos)"
  fail=$((fail + 1))
}

echo "Validando infraestructura vía '$RUNTIME exec'…"
${checks.join('\n')}

# Procesos ajenos a la validación que comparten esta infraestructura. Un
# 'gradlew bootRun' olvidado escribe en la misma BD que la suite y contamina la
# matriz con datos que ningún escenario creó — un fallo que parece de negocio y
# no lo es. Es aviso, no error: el puerto ocupado no impide correr las pruebas
# (la suite arranca en un puerto aleatorio), solo explica resultados imposibles.
listeners=""
if command -v netstat >/dev/null 2>&1; then
  listeners=$(netstat -ano 2>/dev/null | grep -E "[:.]${appPort} " | grep -Ei "listen" || true)
elif command -v ss >/dev/null 2>&1; then
  listeners=$(ss -ltn 2>/dev/null | grep -E "[:.]${appPort} " || true)
fi
if [ -n "$listeners" ]; then
  echo "  AVISO  algo escucha en el puerto ${appPort}: ¿un 'gradlew bootRun' de otra sesión?"
  echo "         Comparte BD y broker con la suite: ciérralo antes de ejecutar integrationTest."
fi

if [ "$fail" -ne 0 ]; then
  echo "$fail comprobación(es) fallaron. ¿Está la infraestructura arriba ('bash infra/up.sh') y lista?" >&2
  exit 1
fi
echo "Infraestructura OK."
`;
}

// Comprobación de que el sidecar minio-init hizo su trabajo: cada bucket
// declarado en storage.keel.yaml existe, y los `visibility: public` sirven de
// verdad una lectura anónima.
//
// Es lo que convierte un hueco de storage en un fallo de INFRAESTRUCTURA, visto
// antes de arrancar el servidor, en vez de un bloqueo en cascada descubierto a
// mitad de la validación funcional (toda la superficie que sube o lee ficheros
// depende de esto).
//
// El sondeo público mide el EFECTO (un GET anónimo que devuelve 200), no el
// nombre del preset. Comparar contra `mc anonymous get | grep download` daba un
// falso FALLO en cuanto el adaptador de la app aplicaba su propia bucket policy
// al arrancar: `mc` etiqueta como `custom` cualquier policy que no coincida byte
// a byte con uno de sus presets, aunque sea más restrictiva y correcta (solo
// `s3:GetObject`, sin `s3:ListBucket`). Un rojo que hay que ir a desmentir a mano
// cuesta más que el check que lo produjo.
function bucketChecks(selected, service, model) {
  if (!selected.some((s) => s.id === 'minio')) return [];
  const buckets = declaredBuckets(model ?? {});
  const container = `${service.name}-devtools`;
  const alias = 'mc alias set local http://minio:9000 minioadmin minioadmin >/dev/null';
  return buckets.map((bucket) => {
    const object = '.keel-anon-probe';
    const url = `http://minio:9000/${bucket.physicalName}/${object}`;
    // Sube un objeto sonda, lo lee sin credenciales y lo borra pase lo que pase:
    // el código de salida es el del GET anónimo, no el de la limpieza.
    const anonymousRead = [
      alias,
      `printf keel > /tmp/${object}`,
      `mc cp --quiet /tmp/${object} local/${bucket.physicalName}/${object} >/dev/null`
    ].join(' && ');
    const probe =
      bucket.visibility === 'public'
        ? `${anonymousRead} || exit 1; curl -sf -o /dev/null ${url}; rc=$?; ` +
          `mc rm --force local/${bucket.physicalName}/${object} >/dev/null 2>&1; exit $rc`
        : `${alias} && mc ls local/${bucket.physicalName}`;
    const label =
      bucket.visibility === 'public'
        ? `bucket ${bucket.physicalName} (público: lectura anónima efectiva)`
        : `bucket ${bucket.physicalName}`;
    return `check ${sq(label)} ${sq(container)} ${sq(probe)}`;
  });
}

// reset-db.sh: deja el estado de prueba como recién arrancado — vacía los DATOS
// de la BD preservando el esquema (lo crea Hibernate) y, si el stack tiene
// caché, borra las claves del servicio. Lo ejecuta el agente de validación
// funcional antes de cada flujo FL-*: sus Given asumen estado limpio y cada
// flujo es auto-contenido. Sin el borrado de la caché, una entrada cacheada o
// una clave de idempotencia (TTL de horas) sobrevive al reset y el flujo
// siguiente recibe la respuesta del anterior. Solo se genera si la BD declara
// cliResetCmd (h2 no: reiniciar la app basta), si hay caché o si hay broker con
// primitiva de purga.
export function resetDbScript(selected, service, model = null) {
  const db = selected.find((s) => s.category === 'database' && s.entry.cliResetCmd);
  const cache = selected.find((s) => s.category === 'cache');
  const broker = selected.find((s) => s.category === 'broker' && s.entry.cliPurgeCmd);
  // Lo que se purga son DESTINOS REALES, no nombres lógicos del diseño. Para un canal de
  // publicación coinciden; para una SUSCRIPCIÓN, no: se consume de la cola de la fuente
  // (`any-registered-system.events`) y no del canal que el diseño nombra
  // (`notificationRequests`). Purgando el nombre lógico se purgaba una cola inexistente —y como
  // la purga es tolerante a fallo, el AVISO se imprimía en cada reset y la cola de entrada
  // arrastraba mensajes entre flujos, que es justo lo que este script existe para impedir.
  // El resolutor es el mismo que ya usa el descarte unas líneas más abajo: componerlo a mano es
  // exactamente el error del que advierte el javadoc de `dead-letter.js`.
  const subscriptionQueues = broker
    ? (model?.subscriptions ?? []).map((sub) => subscriptionDestination(broker.id, model, sub))
    : [];
  const destinations = [...new Set([...(model?.messaging?.publishChannels ?? []), ...subscriptionQueues])];
  // Los destinos de descarte se purgan igual que los canales, y por un motivo que no
  // se ve hasta que muerde: un mensaje muerto sobrevive al reset (que solo tocaba BD,
  // caché y canales) y contamina el flujo siguiente. Como la aserción sobre un DLT
  // suele ser NEGATIVA —«se absorbió el duplicado sin acabar en el descarte»—, el
  // arrastre no aparece como ruido sino como un escenario fallando por algo ajeno.
  // Kafka no entra aquí (no tiene `cliPurgeCmd`): su aislamiento es la marca de offset
  // que `AbstractFlowIT.markChannels()` fija sobre cada DLT.
  const deadLetters = broker
    ? [...new Set(deadLetterSubscriptions(model ?? {}).map((sub) => deadLetterDestination(broker.id, model, sub)))]
    : [];
  const purges = broker && destinations.length > 0 ? [...destinations, ...deadLetters] : deadLetters;
  const httpStub = selected.find((s) => s.category === 'httpStub');
  const mailSink = selected.find((s) => s.category === 'mail');
  // Los objetos del bucket son estado sucio como una fila o un mensaje, y hasta ahora
  // eran los únicos que sobrevivían al reset. No muerde en cuanto la clave lleva el id
  // del recurso —no colisionan—, pero cualquier aserción sobre el CONTENIDO del bucket
  // (cuántos objetos hay, que el borrado se llevó el binario) mide entonces lo que
  // dejaron los flujos anteriores, y el escenario falla por algo que no está mirando.
  const objectStorage = selected.find((s) => s.category === 'storage' && s.id === 'minio');
  const buckets = objectStorage ? declaredBuckets(model ?? {}) : [];
  if (!db && !cache && purges.length === 0 && !httpStub && !mailSink && buckets.length === 0) return null;

  const dbName = service.name.replace(/-/g, '_');
  const steps = [];

  if (db) {
    const container = db.cliVia === 'dbcontainer' ? `${service.name}-db` : `${service.name}-devtools`;
    const cmd = concreteCmd(db.entry, dbName, db.entry.cliResetCmd);
    // --schema: además de los datos, se lleva por delante la ESTRUCTURA. Hace falta
    // en relacional porque `ddl-auto: update` nunca elimina una columna obsoleta ni
    // afloja un NOT NULL preexistente: tras regenerar entidades, una columna que ya
    // no mapea nadie sigue en la tabla y rompe todo INSERT con un 409 opaco que no
    // apunta a su causa. En documental el motivo es otro —un índice que cambia de
    // claves no se puede recrear con el mismo nombre— y quien la rehace tampoco es
    // el mismo, así que el texto se ramifica: prometer Hibernate en un proyecto
    // Mongo manda al diseñador a buscar una configuración que no existe.
    const drop = db.entry.cliDropSchemaCmd
      ? concreteCmd(db.entry, dbName, db.entry.cliDropSchemaCmd)
      : null;
    const rebuiltBy =
      model?.persistenceKind === 'document'
        ? 'las colecciones nacen al escribir y los índices los recrea MongoIndexConfig al arrancar la app'
        : 'lo vuelve a crear Hibernate al arrancar la app';
    const dataStep = `if $RUNTIME exec ${sq(container)} sh -c ${sq(cmd)}; then
  echo "Datos reseteados (${db.entry.label})."
else
  echo "FALLO al resetear los datos. ¿Está la infraestructura arriba ('bash infra/up.sh')?" >&2
  exit 1
fi`;
    if (!drop) {
      steps.push(dataStep);
    } else {
      steps.push(`if [ "$MODE" = schema ]; then
  if $RUNTIME exec ${sq(container)} sh -c ${sq(drop)}; then
    echo "Esquema recreado (${db.entry.label}): ${rebuiltBy}."
  else
    echo "FALLO al recrear el esquema. ¿Está la infraestructura arriba ('bash infra/up.sh')?" >&2
    exit 1
  fi
else
  ${dataStep.split('\n').join('\n  ')}
fi`);
    }
  }

  if (cache) {
    const host = cache.entry.serviceKey;
    const flush = cacheFlushCmd(cache.entry, service);
    steps.push(`if $RUNTIME exec ${sq(`${service.name}-devtools`)} sh -c ${sq(flush)}; then
  echo "Caché vaciada (${cache.entry.label}: claves ${service.artifactId}:*)."
else
  echo "FALLO al vaciar la caché. ¿Está '${host}' arriba?" >&2
  exit 1
fi`);
  }

  // Purga de los destinos de mensajería. Es tolerante a fallo a propósito: que la
  // cola aún no exista (la app no ha arrancado nunca contra este broker) no es un
  // estado sucio, y abortar el reset por eso bloquearía la suite entera.
  for (const destination of purges) {
    const cmd = broker.entry.cliPurgeCmd.replaceAll('{destination}', destination);
    steps.push(`if $RUNTIME exec ${sq(`${service.name}-devtools`)} sh -c ${sq(cmd)}; then
  echo "Canal purgado (${broker.entry.label}: ${destination})."
else
  echo "AVISO: no se pudo purgar '${destination}' (¿la cola/topic aún no existe?). Continúo." >&2
fi`);
  }

  // Vaciado de los buckets. `mc rm --recursive --force` sobre el bucket borra su
  // CONTENIDO, no el bucket: recrearlo es cosa del sidecar minio-init, que solo corre
  // al levantar la infraestructura, y sin él la policy pública se perdería. Tolerante a
  // fallo como las purgas: que el bucket aún no exista no es estado sucio.
  for (const bucket of buckets) {
    const alias = 'mc alias set local http://minio:9000 minioadmin minioadmin >/dev/null';
    const cmd = `${alias} && mc rm --recursive --force --quiet local/${bucket.physicalName} >/dev/null`;
    steps.push(`if $RUNTIME exec ${sq(`${service.name}-devtools`)} sh -c ${sq(cmd)}; then
  echo "Bucket vaciado (${bucket.physicalName})."
else
  echo "AVISO: no se pudo vaciar el bucket '${bucket.physicalName}' (¿aún no existe?). Continúo." >&2
fi`);
  }

  // Stub del proveedor: los mappings que programó el flujo anterior son estado
  // sucio igual que una fila, y el log de peticiones lo leen los verify de los
  // tests. Tolerante a fallo como las purgas: que el stub no esté arriba no
  // ensucia nada, y abortar aquí bloquearía flujos que no lo usan.
  if (httpStub) {
    steps.push(`if $RUNTIME exec ${sq(`${service.name}-devtools`)} sh -c ${sq(httpStub.entry.cliResetCmd)}; then
  echo "Stub de proveedores reiniciado (${httpStub.entry.label}: mappings y log de peticiones)."
else
  echo "AVISO: no se pudo reiniciar el stub HTTP (¿está 'wiremock' arriba?). Continúo." >&2
fi`);
  }

  // Buzón de correo: un mensaje del flujo anterior sigue ahí y el Then del
  // siguiente afirmaría sobre el correo equivocado —el mismo fallo que la purga de
  // los canales evita en el broker—. Tolerante a fallo como las demás purgas.
  if (mailSink) {
    steps.push(`if $RUNTIME exec ${sq(`${service.name}-devtools`)} sh -c ${sq(mailSink.entry.cliResetCmd)}; then
  echo "Buzón de correo vaciado (${mailSink.entry.label})."
else
  echo "AVISO: no se pudo vaciar el buzón de correo (¿está 'mailpit' arriba?). Continúo." >&2
fi`);
  }

  const supportsSchema = Boolean(db?.entry.cliDropSchemaCmd);
  return `#!/usr/bin/env bash
# reset-db.sh — deja el estado de prueba de ${service.name} como recién arrancado:
# ${[
    db ? 'vacía los datos de la BD (esquema intacto)' : null,
    cache ? 'borra las claves de la caché' : null,
    purges.length > 0 ? `purga los destinos de mensajería (${purges.join(', ')})` : null,
    buckets.length > 0 ? `vacía los buckets (${buckets.map((b) => b.physicalName).join(', ')})` : null,
    httpStub ? 'reinicia el stub de proveedores (mappings y log de peticiones)' : null,
    mailSink ? 'vacía el buzón de correo' : null
  ]
    .filter(Boolean)
    .join(', ')}.
# Ejecutar antes de cada flujo FL-* de specs/validation-scenarios.md: los Given
# asumen estado limpio. Uso (desde la raíz; con podman, exporta CONTAINER_RUNTIME=podman):
#   bash infra/reset-db.sh${
    supportsSchema
      ? `
#   bash infra/reset-db.sh --schema   # además, RECREA el esquema
#
${
          model?.persistenceKind === 'document'
            ? `# --schema borra la base entera. Es para después de cambiar un índice de forma:
# Mongo rechaza recrear el mismo nombre con otras claves, así que MongoIndexConfig
# falla al arrancar y el arranque se queda a medias. Vaciar los datos no lo arregla
# —el índice viejo sigue ahí—; borrar la base sí. El volumen no se toca.`
            : `# --schema es para después de regenerar entidades: 'ddl-auto: update' no elimina
# columnas obsoletas ni afloja un NOT NULL preexistente, así que el esquema queda
# con restos que ninguna entidad mapea y todo INSERT falla con un 409 sin relación
# aparente con la causa. Recrear el esquema es la salida; el volumen no se toca.`
        }`
      : ''
  }
set -u
${
  supportsSchema
    ? `
MODE=data
case "\${1:-}" in
  --schema) MODE=schema ;;
  "") ;;
  *) echo "Uso: bash infra/reset-db.sh [--schema]" >&2; exit 2 ;;
esac
`
    : ''
}
${RUNTIME_RESOLUTION}

${steps.join('\n\n')}
`;
}

/**
 * Orden que vacía las claves del servicio en la caché, ejecutable dentro del
 * contenedor devtools. Todas las claves: cachés (`<servicio>:<uso>`) y claves de
 * idempotencia (`<servicio>:idem:<clave>`) comparten prefijo por convención.
 *
 * Es un export y no un literal porque tiene DOS consumidores —`infra/reset-db.sh`
 * y el `clearCache()` del arnés (integration-tests.js)— y son lo mismo por
 * definición: un helper que borrara un conjunto distinto del que borra el reset
 * dejaría al escenario midiendo un estado que ningún flujo puede reproducir.
 * Mismo criterio que `src/lib/broker-probes.js` con los comandos de broker.
 */
export function cacheFlushCmd(entry, service) {
  const host = entry.serviceKey;
  return `redis-cli -h ${host} --scan --pattern '${service.artifactId}:*' | xargs -r redis-cli -h ${host} DEL >/dev/null`;
}

// Sustituye los placeholders de un comando del catálogo (por defecto el
// cliValidateCmd) con los valores concretos (credenciales de prueba). Solo las
// BD usan user/pass/db/service.
export function concreteCmd(entry, dbName, cmd = entry.cliValidateCmd) {
  const user = entry.user ? entry.user(dbName) : '';
  return cmd
    .replaceAll('{user}', user)
    .replaceAll('{pass}', entry.password ?? '')
    .replaceAll('{db}', dbName)
    .replaceAll('{service}', entry.service ?? '');
}

// Envuelve un valor como literal seguro entre comillas simples para bash.
function sq(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
