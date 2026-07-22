// Contenedor `devtools` de validación de infraestructura (portado del proyecto
// de referencia). Es una caja de herramientas Alpine con solo las CLIs del stack
// elegido (psql, redis-cli, kcat, mc, aws…) que el agente alcanza vía
// `docker exec` para sondear que BD/broker/cache/storage responden antes de la
// verificación funcional. Se acompaña de `validate-infra.sh`, que ejecuta un
// check por tecnología. Consume `selectedInfra(model)` de stack-catalog.js.

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

// Servicio `devtools` del docker-compose: se construye desde ./docker, queda vivo
// con `sleep infinity` y depende de los servicios que va a sondear.
export function devtoolsService(selected, service) {
  const dependsOn = [...new Set(selected.filter((s) => s.cliVia === 'devtools').map((s) => s.serviceKey))];
  return {
    build: { context: './docker', dockerfile: 'Dockerfile.devtools' },
    container_name: `${service.name}-devtools`,
    command: 'sleep infinity',
    ...(dependsOn.length > 0 ? { depends_on: dependsOn } : {})
  };
}

// validate-infra.sh: un check por tecnología. Ejecuta el cliValidateCmd (con las
// credenciales del catálogo ya sustituidas) dentro del contenedor que corresponda
// —devtools, o el propio contenedor de la BD para cliVia 'dbcontainer'— y sale
// con código != 0 si alguno falla.
export function validateInfraScript(selected, service) {
  const dbName = service.name.replace(/-/g, '_');
  const checks = selected
    .filter((s) => s.entry.cliValidateCmd)
    .map((s) => {
      const container = s.cliVia === 'dbcontainer' ? `${service.name}-db` : `${service.name}-devtools`;
      const label = `${s.entry.label} (${s.serviceKey})`;
      return `check ${sq(label)} ${sq(container)} ${sq(concreteCmd(s.entry, dbName))}`;
    });

  return `#!/usr/bin/env bash
# validate-infra.sh — sondea la infraestructura de prueba de ${service.name}.
# Un check por tecnología elegida en keel-stack.json; ejecuta cada CLI dentro
# del contenedor devtools (o del propio contenedor de la BD). Uso:
#   docker compose up -d && ./validate-infra.sh
# En Windows: bash validate-infra.sh (marca el bit de ejecución con chmod +x).
set -u

RUNTIME="\${CONTAINER_RUNTIME:-}"
if [ -z "$RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then RUNTIME=podman
  else echo "No se encontró docker ni podman en el PATH." >&2; exit 2; fi
fi

fail=0
check() {
  label="$1"; container="$2"; cmd="$3"
  if $RUNTIME exec "$container" sh -c "$cmd" >/dev/null 2>&1; then
    echo "  OK     $label"
  else
    echo "  FALLO  $label"
    fail=$((fail + 1))
  fi
}

echo "Validando infraestructura vía '$RUNTIME exec'…"
${checks.join('\n')}

if [ "$fail" -ne 0 ]; then
  echo "$fail comprobación(es) fallaron. ¿Está la infraestructura arriba ('$RUNTIME compose up -d') y lista?" >&2
  exit 1
fi
echo "Infraestructura OK."
`;
}

// Sustituye los placeholders del cliValidateCmd con los valores concretos del
// catálogo (credenciales de prueba). Solo las BD usan user/pass/db/service.
function concreteCmd(entry, dbName) {
  const user = entry.user ? entry.user(dbName) : '';
  return entry.cliValidateCmd
    .replaceAll('{user}', user)
    .replaceAll('{pass}', entry.password ?? '')
    .replaceAll('{db}', dbName)
    .replaceAll('{service}', entry.service ?? '');
}

// Envuelve un valor como literal seguro entre comillas simples para bash.
function sq(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
