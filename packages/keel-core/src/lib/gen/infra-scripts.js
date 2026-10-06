// La infraestructura de PRUEBA del proyecto generado, agrupada bajo `infra/`: el docker-compose con
// solo los contenedores que el diseño + stack necesitan, el contenedor `devtools` con las CLIs que
// los sondean, y los scripts que la manejan (`up.sh`, `down.sh`, `validate-infra.sh`, `reset-db.sh`).
//
// Es NEUTRAL: los contenedores salen del catálogo (`infra-catalog.js`) y los scripts son bash que
// habla con ellos, sin saber en qué lenguaje está el servidor que se prueba. Que la escriba un solo
// módulo es lo que hace que el servidor de keel-spring y el de keel-nest del mismo diseño se puntúen
// contra los MISMOS contenedores, reseteados del MISMO modo entre flujos.
//
// Lo que sí cambia entre generadores entra por la PLATAFORMA (`platform`), y son textos, no
// decisiones:
//   generator         nombre del generador, para las cabeceras de lo emitido.
//   historyTable      tabla de historial de migraciones, que el reset de datos respeta
//                     (sustituye `{history}`/`{HISTORY}` de los `cliResetCmd` del catálogo).
//   strayProcess      { comment, hint, close }: el proceso olvidado que comparte la infra con la
//                     suite (el AVISO de validate-infra.sh).
//   schemaRebuiltBy   { relational, document }: quién rehace el esquema tras `reset-db.sh --schema`.
//   schemaHelp        { relational, document }: el comentario que explica cuándo usar `--schema`.
//   httpStubsReadme   (service) → texto de `infra/http-stubs/README.md`.
//   extraChecks       (model) → [{ label, cmd }] que validate-infra.sh ejecuta en devtools además
//                     de los del catálogo (la topología de mensajería que siembra el generador).
//   extraFiles        (model) → archivos adicionales de `infra/` (aprovisionamientos).

import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { declaredBuckets } from './buckets.js';
import { deadLetterDestination, deadLetterSubscriptions, subscriptionDestination } from './dead-letter.js';
import { scopingClaimChecks } from './identity-realm.js';
import {
  DATABASES,
  BROKERS,
  AUTH,
  CACHES,
  STORAGE,
  HTTP_STUB,
  MAIL_SINK,
  LOCAL_AWS_ENV,
  MC_BINARY_URL,
  selectedInfra,
  brokerContainer,
  storageContainer
} from './infra-catalog.js';

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
 * La ruta tal y como la entiende el binario que la va a abrir, no el shell que la escribe.
 *
 * En Git Bash sobre Windows una ruta absoluta es `/c/Users/…`, y el frontend de compose puede ser
 * un programa de WINDOWS: `podman-compose` es Python, y abre el archivo él mismo —no se lo pasa al
 * motor—, así que con la ruta POSIX aborta con «missing files». Medido en una corrida: `up.sh` no
 * levantaba nada con podman en Windows, y el mensaje no mencionaba ni las rutas ni el shell.
 *
 * `MSYS_NO_PATHCONV=1` (que estos scripts ponen, y tienen que poner: sin él MSYS destroza los
 * argumentos que SÍ son rutas del contenedor) desactiva la traducción automática, así que se hace
 * aquí y solo para lo que va como argumento. Las variables siguen en POSIX para que el propio
 * bash pueda leerlas (`[ -f ]`, `.`).
 *
 * Fuera de Git Bash no hay `cygpath` y la ruta se deja igual, que es lo correcto en Linux y macOS.
 */
export const HOSTPATH_HELPER = `hostpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}`;

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
export function dockerfileDevtools(selected, platform) {
  const viaDevtools = selected.filter((s) => s.cliVia === 'devtools');
  const apk = new Set(BASE_PACKAGES);
  for (const s of viaDevtools) for (const pkg of s.entry.alpinePackages ?? []) apk.add(pkg);

  const lines = [
    `# Toolbox de validación de infraestructura generado por ${platform.generator}.`,
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
    // mc (MinIO client): binario estático de la release; no hay paquete apk. La URL
    // sale del catálogo —misma versión que la imagen del sidecar minio-init— y
    // NO de dl.min.io, que devuelve 410 desde que MinIO archivó esa distribución.
    //
    // El `-f` no es cosmético: sin él curl escribe el cuerpo de la respuesta de error
    // y sale 0, así que la imagen se horneaba con una página HTML marcada como
    // ejecutable y el fallo aparecía dentro de validate-infra.sh, sin mencionar la
    // descarga. Con `-f`, un origen roto mata el build de la imagen, que es donde se
    // puede leer.
    lines.push(
      `RUN curl -fsSL ${MC_BINARY_URL} -o /usr/local/bin/mc \\`,
      ' && chmod +x /usr/local/bin/mc'
    );
  }

  lines.push('WORKDIR /scripts', 'CMD ["sleep", "infinity"]', '');
  return lines.join('\n');
}

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
export function devtoolsImageTag(selected, platform) {
  return createHash('sha256').update(dockerfileDevtools(selected, platform)).digest('hex').slice(0, 12);
}

// Servicio `devtools` del docker-compose: se construye desde ./docker (relativo
// al propio compose, dentro de infra/), queda vivo con `sleep infinity` y depende
// de los servicios que va a sondear.
export function devtoolsService(selected, service, platform) {
  const dependsOn = [...new Set(selected.filter((s) => s.cliVia === 'devtools').map((s) => s.serviceKey))];
  return {
    // Sin clave `dockerfile:` a propósito, y por eso el archivo se llama
    // `Dockerfile` a secas: podman-compose no la honra —busca el nombre por
    // defecto en el contexto y aborta con "no Containerfile or Dockerfile
    // specified or found"—, así que el proyecto generado no se podía construir
    // con el único frontend de compose que funciona en podman sobre Windows. El
    // directorio `docker/` ya acota qué imagen es: el sufijo no aportaba nada.
    build: { context: './docker' },
    image: `${service.name}-devtools:${devtoolsImageTag(selected, platform)}`,
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
export function validateInfraScript(selected, service, model, platform) {
  const dbName = service.name.replace(/-/g, '_');
  // Puerto por defecto del servicio (`${SERVER_PORT:8080}` en los dos generadores).
  const appPort = 8080;
  const checks = selected
    .filter((s) => s.entry.cliValidateCmd)
    .map((s) => {
      const container = s.cliVia === 'dbcontainer' ? `${service.name}-db` : `${service.name}-devtools`;
      const label = `${s.entry.label} (${s.serviceKey})`;
      return `check ${sq(label)} ${sq(container)} ${sq(concreteCmd(s.entry, dbName, s.entry.cliValidateCmd, platform))}`;
    });
  checks.push(...bucketChecks(selected, service, model));
  // Lo que la plataforma añade y solo ella sabe derivar: la topología de mensajería (que los
  // topics y colas EXISTAN: el check del catálogo da verde con la lista vacía, que es justo el
  // estado roto).
  for (const { label, cmd } of platform.extraChecks?.(model ?? {}) ?? []) {
    checks.push(`check ${sq(label)} ${sq(`${service.name}-devtools`)} ${sq(cmd)}`);
  }
  // Alcance por recurso: el claim llega en el token de cada usuario acotado. Sin esto, un
  // atributo escrito en el usuario equivocado pasaba la validación en verde.
  for (const { label, cmd } of model ? scopingClaimChecks(model) : []) {
    checks.push(`check ${sq(label)} ${sq(`${service.name}-devtools`)} ${sq(cmd)}`);
  }
  const stray = platform.strayProcess;

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

${stray.comment}
listeners=""
if command -v netstat >/dev/null 2>&1; then
  listeners=$(netstat -ano 2>/dev/null | grep -E "[:.]${appPort} " | grep -Ei "listen" || true)
elif command -v ss >/dev/null 2>&1; then
  listeners=$(ss -ltn 2>/dev/null | grep -E "[:.]${appPort} " || true)
fi
if [ -n "$listeners" ]; then
  echo "  AVISO  algo escucha en el puerto ${appPort}: ${stray.hint}"
  echo "         Comparte BD y broker con la suite: ${stray.close}"
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
// de la BD preservando el esquema y el historial de migraciones y, si el stack tiene
// caché, borra las claves del servicio. Lo ejecuta el agente de validación
// funcional antes de cada flujo FL-*: sus Given asumen estado limpio y cada
// flujo es auto-contenido. Sin el borrado de la caché, una entrada cacheada o
// una clave de idempotencia (TTL de horas) sobrevive al reset y el flujo
// siguiente recibe la respuesta del anterior. Solo se genera si la BD declara
// cliResetCmd, si hay caché o si hay broker con
// primitiva de purga.
export function resetDbScript(selected, service, model, platform) {
  const db = selected.find((s) => s.category === 'database' && s.entry.cliResetCmd);
  const cache = selected.find((s) => s.category === 'cache');
  const broker = selected.find((s) => s.category === 'broker' && s.entry.cliPurgeCmd);
  // Lo que se purga son DESTINOS REALES, no nombres lógicos del diseño. Para un canal de
  // publicación coinciden; para una SUSCRIPCIÓN, no: el canal que el diseño nombra
  // (`notificationRequests`) es el del EMISOR, y donde se acumulan los mensajes es en la cola
  // propia de este servicio colgada de él (`notification-mailer.any-registered-system`).
  // Purgando cualquier otro nombre se purga una cola inexistente —y como la purga es tolerante
  // a fallo, lo único que queda es un AVISO en cada reset mientras la cola de entrada arrastra
  // mensajes entre flujos, que es justo lo que este script existe para impedir. Pasó dos veces:
  // con el canal lógico, y luego con el del emisor cuando RabbitMQ todavía se creía una cola.
  // El resolutor es el mismo que ya usa el descarte unas líneas más abajo: componerlo a mano es
  // exactamente el error del que advierte el comentario de `dead-letter.js`.
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
  // que el arnés de integración fija sobre cada DLT.
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
  const kind = model?.persistenceKind === 'document' ? 'document' : 'relational';
  const steps = [];

  if (db) {
    const container = db.cliVia === 'dbcontainer' ? `${service.name}-db` : `${service.name}-devtools`;
    const cmd = concreteCmd(db.entry, dbName, db.entry.cliResetCmd, platform);
    // --schema: además de los datos, se lleva por delante la ESTRUCTURA. En relacional,
    // porque el modo de iterar del ORM nunca elimina una columna obsoleta ni afloja un NOT
    // NULL preexistente; en documental, porque un índice que cambia de claves no se puede
    // recrear con el mismo nombre. Quién rehace el esquema depende del generador y del
    // modelo, así que el texto lo pone la plataforma.
    const drop = db.entry.cliDropSchemaCmd ? concreteCmd(db.entry, dbName, db.entry.cliDropSchemaCmd, platform) : null;
    const rebuiltBy = platform.schemaRebuiltBy[kind];
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
${platform.schemaHelp[kind]}`
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
 * Tiene DOS consumidores —`infra/reset-db.sh` y el helper del arnés que vacía la caché— y
 * son lo mismo por definición: un helper que borrara un conjunto distinto del que borra el
 * reset dejaría al escenario midiendo un estado que ningún flujo puede reproducir.
 */
export function cacheFlushCmd(entry, service) {
  const host = entry.serviceKey;
  return `redis-cli -h ${host} --scan --pattern '${service.artifactId}:*' | xargs -r redis-cli -h ${host} DEL >/dev/null`;
}

/**
 * Sustituye los placeholders de un comando del catálogo (por defecto el cliValidateCmd) con
 * los valores concretos: credenciales de prueba, base, servicio y la tabla de historial de
 * migraciones de la plataforma (`{history}`, y `{HISTORY}` en mayúsculas para los motores que
 * la comparan así). Solo las BD usan user/pass/db/service/history.
 */
export function concreteCmd(entry, dbName, cmd = entry.cliValidateCmd, platform = null) {
  const user = entry.user ? entry.user(dbName) : '';
  const history = platform?.historyTable ?? '';
  return cmd
    .replaceAll('{user}', user)
    .replaceAll('{pass}', entry.password ?? '')
    .replaceAll('{db}', dbName)
    .replaceAll('{service}', entry.service ?? '')
    .replaceAll('{history}', history)
    .replaceAll('{HISTORY}', history.toUpperCase());
}

// ─── infra/ completo ─────────────────────────────────────────────────────────

/**
 * Los archivos de `infra/`: el docker-compose con los contenedores que el diseño + stack piden,
 * los lanzadores, el toolbox, la validación, el reset entre flujos y lo que la plataforma añada.
 * Vacío si el diseño no necesita ningún contenedor.
 */
export function infraFiles(model, platform) {
  const { service, layersPresent, stack } = model;
  const network = `keel-${service.name}`;
  const services = {};
  const volumes = {};

  if (layersPresent.persistence && stack.database) {
    const db = DATABASES[stack.database];
    // Las opciones en memoria no levantan contenedor (composeService null).
    if (db?.composeService) {
      services.db = { container_name: `${service.name}-db`, ...db.composeService(service.name.replace(/-/g, '_')) };
      volumes['db-data'] = null;
    }
  }
  if (layersPresent.messaging && stack.broker) {
    const broker = BROKERS[stack.broker];
    const brokerServices = broker.composeServices();
    // Nombre fijo para el contenedor del broker, igual que la BD. Sin él, el nombre
    // real lo compone el proyecto de compose (`<proyecto>-<servicio>-1`) y no hay
    // forma portable de dirigirse a él: `compose ps --format` no lo es (por eso
    // up.sh sondea por HTTP). Y el arnés lo necesita direccionable para detener y
    // levantar el broker en los escenarios de outbox.
    if (brokerServices[broker.serviceKey]) {
      brokerServices[broker.serviceKey].container_name = brokerContainer(service.name, broker);
    }
    Object.assign(services, brokerServices);
  }
  if (stack.auth && stack.auth !== 'none') {
    Object.assign(services, AUTH[stack.auth].composeServices());
  }
  if (stack.cache) {
    Object.assign(services, CACHES[stack.cache].composeServices());
  }
  if (layersPresent.storage && stack.storage) {
    const storage = STORAGE[stack.storage];
    const storageServices = storage.composeServices(model);
    // Nombre fijo, como el del broker: el arnés lo detiene y lo levanta.
    if (storage.serviceKey && storageServices[storage.serviceKey]) {
      storageServices[storage.serviceKey].container_name = storageContainer(service.name, storage);
    }
    Object.assign(services, storageServices);
    if ('minio' in storageServices) volumes['minio-data'] = null;
  }

  // Proveedor de prueba de las integraciones salientes: sin él, un flujo que
  // llama a otro servicio no se puede puntuar (ver HTTP_STUB en el catálogo).
  // Y la pasarela de pago de prueba, que es el mismo WireMock hablando el protocolo de la elegida.
  if (layersPresent.httpClients || layersPresent.payments) {
    Object.assign(services, HTTP_STUB.composeServices());
  }

  // Destino de prueba del correo saliente, por el mismo motivo: un flujo que
  // termina en un correo no se puede puntuar sin a quién mandárselo, y sin la API
  // del buzón el Then sobre el correo es siempre manual (ver MAIL_SINK).
  if (layersPresent.mail) {
    Object.assign(services, MAIL_SINK.composeServices());
  }

  if (Object.keys(services).length === 0) return [];

  // Toolbox de validación: se añade si alguna CLI del stack vive en devtools.
  const selected = selectedInfra(model);
  if (needsDevtools(selected)) {
    services.devtools = devtoolsService(selected, service, platform);
  }

  for (const definition of Object.values(services)) {
    definition.networks = [network];
  }

  const compose = {
    name: service.projectName,
    services,
    ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
    networks: { [network]: { driver: 'bridge' } }
  };

  const header = `# Infraestructura de prueba generada por ${platform.generator} (según keel-stack.json).\n`;
  const files = [{ path: 'infra/docker-compose.yaml', content: header + YAML.stringify(compose, { nullStr: '' }) }];

  // Lanzador de la infraestructura de prueba. Con docker un `compose up -d` a pelo
  // basta; con podman depende de un frontend delegado que puede no alcanzar el motor,
  // y entonces la fase de infraestructura del pipeline muere en su primer comando con
  // un error de named pipe que no señala a compose. El lanzador es el único sitio
  // donde esa resolución tiene que vivir.
  files.push({ path: 'infra/up.sh', content: infraUpScript(service) });
  files.push({ path: 'infra/down.sh', content: infraDownScript(service) });

  if (needsDevtools(selected)) {
    files.push({ path: 'infra/docker/Dockerfile', content: dockerfileDevtools(selected, platform) });
  }
  // El script de validación existe siempre que haya algo que sondear (incluye el
  // caso 'dbcontainer', p. ej. Oracle, que no necesita devtools).
  if (selected.some((s) => s.entry.cliValidateCmd)) {
    files.push({ path: 'infra/validate-infra.sh', content: validateInfraScript(selected, service, model, platform) });
  }
  // Reset de estado entre flujos: datos de la BD, claves de la caché y destinos
  // de mensajería declarados (el modelo aporta los canales a purgar).
  const reset = resetDbScript(selected, service, model, platform);
  if (reset) {
    files.push({ path: 'infra/reset-db.sh', content: reset });
  }
  // El montaje del stub necesita el directorio: si no existe, el runtime lo crea
  // como root y el contenedor no puede leerlo (podman rootless, sobre todo).
  if (layersPresent.httpClients || layersPresent.payments) {
    files.push({ path: 'infra/http-stubs/mappings/.gitkeep', content: '' });
    files.push({ path: 'infra/http-stubs/README.md', content: platform.httpStubsReadme(service) });
  }
  files.push(...(platform.extraFiles?.(model) ?? []));

  return files;
}

// ─── infra/up.sh e infra/down.sh ─────────────────────────────────────────────
//
// El lanzador de la infraestructura de PRUEBA, que no se confunde con deploy/: allí
// corre el servicio ya empaquetado para que el diseñador lo toque a mano; aquí solo
// están las dependencias contra las que se puntúan los escenarios, y la aplicación
// la arranca la suite de integración. Por eso este par no publica URLs ni sondea la
// app: levanta, delega el «¿está listo?» en validate-infra.sh —que es quien sabe
// sondear cada tecnología— y se aparta.

const INFRA_PREAMBLE = `set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$HERE/docker-compose.yaml"

${RUNTIME_RESOLUTION}

${HOSTPATH_HELPER}

${composeResolution(['-f', '"$(hostpath "$COMPOSE_FILE")"'])}`;

function infraUpScript(service) {
  return `#!/usr/bin/env bash
# up.sh — levanta la infraestructura de prueba de ${service.name}.
#
# Uso (desde la raíz del proyecto):
#   bash infra/up.sh && bash infra/validate-infra.sh
#
# Resuelve el runtime (docker o podman, o \$CONTAINER_RUNTIME) y el frontend de
# compose. Levantar NO es estar listo: Kafka, Keycloak y LocalStack publican su
# listener bastante después de que el contenedor esté 'Up', así que quien decide si
# se puede empezar es validate-infra.sh, que reintenta.
${INFRA_PREAMBLE}

echo "Levantando la infraestructura de ${service.name} con '\${COMPOSE[*]}'…"
"\${COMPOSE[@]}" up -d

echo ""
echo "Contenedores arriba. Comprueba que están LISTOS antes de usarlos:"
echo "  bash infra/validate-infra.sh"
`;
}

function infraDownScript(service) {
  return `#!/usr/bin/env bash
# down.sh — para la infraestructura de prueba de ${service.name}.
#
# Uso (desde la raíz del proyecto):
#   bash infra/down.sh           para los contenedores, CONSERVA los volúmenes
#   bash infra/down.sh --volumes los borra también (la BD vuelve a nacer vacía)
#
# Para limpiar el ESTADO entre flujos de validación no se usa esto: es
# infra/reset-db.sh, que vacía datos sin tirar los contenedores ni el historial de
# migraciones. Borrar los volúmenes obliga a rearrancar y resembrar la topología.
${INFRA_PREAMBLE}

VOLUMES=""
if [ "\${1:-}" = "--volumes" ] || [ "\${1:-}" = "-v" ]; then
  VOLUMES="--volumes"
fi

echo "Parando la infraestructura de ${service.name}…"
if [ -n "$VOLUMES" ]; then
  "\${COMPOSE[@]}" down --volumes
  echo "Contenedores y volúmenes borrados."
else
  "\${COMPOSE[@]}" down
  echo "Contenedores parados; los volúmenes siguen ahí (usa --volumes para borrarlos)."
fi
`;
}

// Envuelve un valor como literal seguro entre comillas simples para bash.
function sq(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
