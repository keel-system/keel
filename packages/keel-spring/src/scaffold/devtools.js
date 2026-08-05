// Contenedor `devtools` de validación de infraestructura (portado del proyecto
// de referencia). Es una caja de herramientas Alpine con solo las CLIs del stack
// elegido (psql, redis-cli, kcat, mc, aws…) que el agente alcanza vía
// `docker exec` para sondear que BD/broker/cache/storage responden antes de la
// verificación funcional. Se acompaña de `validate-infra.sh`, que ejecuta un
// check por tecnología. Consume `selectedInfra(model)` de stack-catalog.js.

import { declaredBuckets } from '../lib/buckets.js';
import { LOCAL_AWS_ENV } from '../lib/stack-catalog.js';
import { messagingTopologyChecks } from './messaging-provisioning.js';

// Paquetes base del toolbox: shell + utilidades de red/JSON comunes a todos los checks.
const BASE_PACKAGES = ['bash', 'curl', 'jq', 'netcat-openbsd'];

// ¿El stack necesita el contenedor devtools? (alguna CLI vive en el toolbox).
export function needsDevtools(selected) {
  return selected.some((s) => s.cliVia === 'devtools');
}

// Dockerfile.devtools: base + los apk de las CLIs con cliVia 'devtools' + las
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
export function devtoolsService(selected, service) {
  const dependsOn = [...new Set(selected.filter((s) => s.cliVia === 'devtools').map((s) => s.serviceKey))];
  return {
    build: { context: './docker', dockerfile: 'Dockerfile.devtools' },
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
#   docker compose -f infra/docker-compose.yaml up -d && bash infra/validate-infra.sh
set -u

RUNTIME="\${CONTAINER_RUNTIME:-}"
if [ -z "$RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then RUNTIME=podman
  else echo "No se encontró docker ni podman en el PATH." >&2; exit 2; fi
fi

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
  echo "$fail comprobación(es) fallaron. ¿Está la infraestructura arriba ('$RUNTIME compose -f infra/docker-compose.yaml up -d') y lista?" >&2
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
  const destinations = model?.messaging?.channels ?? [];
  const purges = broker && destinations.length > 0 ? destinations : [];
  const httpStub = selected.find((s) => s.category === 'httpStub');
  if (!db && !cache && purges.length === 0 && !httpStub) return null;

  const dbName = service.name.replace(/-/g, '_');
  const steps = [];

  if (db) {
    const container = db.cliVia === 'dbcontainer' ? `${service.name}-db` : `${service.name}-devtools`;
    const cmd = concreteCmd(db.entry, dbName, db.entry.cliResetCmd);
    // --schema: además de los datos, se lleva por delante las TABLAS. Hace falta
    // porque `ddl-auto: update` nunca elimina una columna obsoleta ni afloja un
    // NOT NULL preexistente: tras regenerar entidades, una columna que ya no
    // mapea nadie sigue en la tabla y rompe todo INSERT con un 409 opaco que no
    // apunta a su causa. Vaciar los datos no lo arregla; recrear el esquema sí.
    const drop = db.entry.cliDropSchemaCmd
      ? concreteCmd(db.entry, dbName, db.entry.cliDropSchemaCmd)
      : null;
    const dataStep = `if $RUNTIME exec ${sq(container)} sh -c ${sq(cmd)}; then
  echo "Datos reseteados (${db.entry.label})."
else
  echo "FALLO al resetear los datos. ¿Está la infraestructura arriba ('$RUNTIME compose -f infra/docker-compose.yaml up -d')?" >&2
  exit 1
fi`;
    if (!drop) {
      steps.push(dataStep);
    } else {
      steps.push(`if [ "$MODE" = schema ]; then
  if $RUNTIME exec ${sq(container)} sh -c ${sq(drop)}; then
    echo "Esquema recreado (${db.entry.label}): lo vuelve a crear Hibernate al arrancar la app."
  else
    echo "FALLO al recrear el esquema. ¿Está la infraestructura arriba ('$RUNTIME compose -f infra/docker-compose.yaml up -d')?" >&2
    exit 1
  fi
else
  ${dataStep.split('\n').join('\n  ')}
fi`);
    }
  }

  if (cache) {
    // Todas las claves del servicio: cachés (<servicio>:<uso>) y claves de
    // idempotencia (<servicio>:idem:<clave>) comparten prefijo por convención.
    const host = cache.entry.serviceKey;
    const flush = `redis-cli -h ${host} --scan --pattern '${service.artifactId}:*' | xargs -r redis-cli -h ${host} DEL >/dev/null`;
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

  const supportsSchema = Boolean(db?.entry.cliDropSchemaCmd);
  return `#!/usr/bin/env bash
# reset-db.sh — deja el estado de prueba de ${service.name} como recién arrancado:
# ${[
    db ? 'vacía los datos de la BD (esquema intacto)' : null,
    cache ? 'borra las claves de la caché' : null,
    purges.length > 0 ? `purga los destinos de mensajería (${purges.join(', ')})` : null,
    httpStub ? 'reinicia el stub de proveedores (mappings y log de peticiones)' : null
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
# --schema es para después de regenerar entidades: 'ddl-auto: update' no elimina
# columnas obsoletas ni afloja un NOT NULL preexistente, así que el esquema queda
# con restos que ninguna entidad mapea y todo INSERT falla con un 409 sin relación
# aparente con la causa. Recrear el esquema es la salida; el volumen no se toca.`
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
RUNTIME="\${CONTAINER_RUNTIME:-}"
if [ -z "$RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then RUNTIME=podman
  else echo "No se encontró docker ni podman en el PATH." >&2; exit 2; fi
fi

${steps.join('\n\n')}
`;
}

// Sustituye los placeholders de un comando del catálogo (por defecto el
// cliValidateCmd) con los valores concretos (credenciales de prueba). Solo las
// BD usan user/pass/db/service.
function concreteCmd(entry, dbName, cmd = entry.cliValidateCmd) {
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
