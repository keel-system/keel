// Qué dice una imagen de contenedor del runtime del legacy. Una imagen nombrada en su CI, en un
// Dockerfile, en un compose o en un script del repo es una DECLARACIÓN: la versión del lenguaje
// con la que sus autores lo construían, la de su herramienta de build o la del motor con el que lo
// probaban. En el incremento 1 la CI fue la única fuente de la versión de Node y del motor de
// RealWorld.

/** `registry/org/name:tag@sha256:…` → sus partes. */
export function parseImage(ref) {
  const raw = String(ref).trim();
  const [withoutDigest, digest] = raw.split('@');
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  const hasTag = colon > slash;
  const repo = hasTag ? withoutDigest.slice(0, colon) : withoutDigest;
  const tag = hasTag ? withoutDigest.slice(colon + 1) : null;
  const name = repo.slice(repo.lastIndexOf('/') + 1);
  return { image: raw, repo, name, tag, digest: digest || null, pinned: Boolean(digest) };
}

// Imágenes de lenguaje: el número que abre el tag es la versión del runtime.
const NODE_IMAGES = new Set(['node']);
const JAVA_IMAGES = new Set([
  'openjdk',
  'eclipse-temurin',
  'adoptopenjdk',
  'amazoncorretto',
  'zulu-openjdk',
  'ibmjava',
  'java',
  'jdk',
  'sapmachine',
]);
// Imágenes de herramienta de build que llevan el JDK en el tag (`maven:3.6-jdk-8`).
const BUILD_IMAGES = { maven: 'maven', gradle: 'gradle' };

// Motores y servicios de apoyo, por el nombre de la imagen.
const SERVICE_IMAGES = [
  [/^mongo(db)?$/, 'mongodb'],
  [/^postgres(ql)?$/, 'postgresql'],
  [/^mysql$/, 'mysql'],
  [/^mariadb$/, 'mariadb'],
  [/^mssql.*$/, 'sqlserver'],
  [/^oracle.*$/, 'oracle'],
  [/^redis$/, 'redis'],
  [/^valkey$/, 'valkey'],
  [/^memcached$/, 'memcached'],
  [/^rabbitmq$/, 'rabbitmq'],
  [/^(cp-)?kafka$/, 'kafka'],
  [/^(cp-)?zookeeper$/, 'zookeeper'],
  [/^activemq.*$/, 'activemq'],
  [/^elasticsearch$/, 'elasticsearch'],
  [/^cassandra$/, 'cassandra'],
  [/^(mailhog|mailpit|smtp4dev)$/, 'smtp'],
  [/^zipkin$/, 'zipkin'],
  [/^(jaeger|all-in-one)$/, 'jaeger'],
  [/^localstack$/, 'localstack'],
  [/^(wiremock|json-server)$/, 'http-stub'],
];

const SERVICE_NAMES_TRAVIS = {
  mongodb: 'mongodb',
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  redis: 'redis',
  'redis-server': 'redis',
  rabbitmq: 'rabbitmq',
  memcached: 'memcached',
  elasticsearch: 'elasticsearch',
  cassandra: 'cassandra',
};

export function travisServiceTech(name) {
  return SERVICE_NAMES_TRAVIS[String(name).trim()] ?? null;
}

/** Versión que abre un tag (`8.5.0-alpine` → `8.5.0`, `3.4` → `3.4`), o null (`latest`, `lts`). */
export function leadingVersion(tag) {
  if (!tag) return null;
  const m = /^v?(\d+(?:\.\d+){0,3})/.exec(tag);
  return m ? m[1] : null;
}

/**
 * Lo que una imagen declara, como lista de hechos `{ what, name, version }`:
 * `what` es `language` (node, java), `build-tool` (maven, gradle) o `service` (mongodb…).
 */
export function imageFacts(ref) {
  const img = parseImage(ref);
  // `mcr.microsoft.com/mssql/server`: el nombre suelto no dice nada, el repo sí.
  const name = /(^|\/)mssql\//.test(img.repo) ? 'mssql' : img.name.toLowerCase();
  const facts = [];
  if (NODE_IMAGES.has(name)) {
    facts.push({ what: 'language', name: 'node', version: leadingVersion(img.tag) });
  } else if (JAVA_IMAGES.has(name)) {
    facts.push({ what: 'language', name: 'java', version: leadingVersion(img.tag) });
  } else if (BUILD_IMAGES[name]) {
    facts.push({ what: 'build-tool', name: BUILD_IMAGES[name], version: leadingVersion(img.tag) });
    const jdk = /(?:^|[-_])(?:jdk|openjdk|temurin|corretto|java)-?(\d+)/.exec(img.tag ?? '');
    if (jdk) facts.push({ what: 'language', name: 'java', version: jdk[1] });
  } else {
    for (const [re, tech] of SERVICE_IMAGES) {
      if (re.test(name)) {
        facts.push({ what: 'service', name: tech, version: leadingVersion(img.tag) });
        break;
      }
    }
  }
  return facts.map((f) => ({ ...f, image: img.image, pinned: img.pinned }));
}

// Opciones de `docker run` que consumen el token siguiente.
const RUN_OPTS_WITH_VALUE = new Set([
  '-p', '--publish', '-e', '--env', '--name', '-v', '--volume', '-w', '--workdir', '--network', '--net',
  '-u', '--user', '--entrypoint', '-h', '--hostname', '--env-file', '-l', '--label', '--mount', '--add-host',
  '-m', '--memory', '--platform', '--restart', '--link', '--cpus', '--tmpfs', '--ulimit', '--cap-add', '--cap-drop',
]);

/** Imágenes de cada `docker run`/`podman run` de una línea de shell, con su posición en la línea. */
export function dockerRunImages(line) {
  const out = [];
  const re = /(?:\bdocker|\bpodman|\$\{?\w*DOCKER\w*\}?)\s+run\b/g;
  let m;
  while ((m = re.exec(line))) {
    const rest = line.slice(m.index + m[0].length).split(/\s*(?:&&|\|\||;|\||&)\s*/)[0];
    const tokens = rest.split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith('-')) {
        if (!t.includes('=') && RUN_OPTS_WITH_VALUE.has(t)) i++;
        continue;
      }
      out.push(t.replace(/^["']|["']$/g, ''));
      break;
    }
  }
  return out;
}
