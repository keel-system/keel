// Catálogo del paso 0b: de qué librería, de qué propiedad de Spring o de qué nombre de variable se
// deduce una dependencia externa, de qué clase es y cómo se provisiona en el sandbox. Es
// conocimiento del ECOSISTEMA (qué habla `amqplib`), nunca del legacy concreto.

/** Clase de cada tecnología. La clase decide la provisión (plan §3, paso 0b). */
export const TECH_KIND = {
  mongodb: 'database',
  postgresql: 'database',
  mysql: 'database',
  mariadb: 'database',
  sqlserver: 'database',
  oracle: 'database',
  db2: 'database',
  cassandra: 'database',
  elasticsearch: 'database',
  relational: 'database',
  h2: 'database',
  hsqldb: 'database',
  derby: 'database',
  sqlite: 'database',
  redis: 'cache',
  valkey: 'cache',
  memcached: 'cache',
  rabbitmq: 'broker',
  kafka: 'broker',
  activemq: 'broker',
  nats: 'broker',
  smtp: 'smtp',
  zipkin: 'tracing',
  jaeger: 'tracing',
  eureka: 'discovery',
  consul: 'discovery',
  'config-server': 'discovery',
  http: 'http',
};

/** Bases que viven dentro del proceso: no hay contenedor que levantar. */
export const EMBEDDED = new Set(['h2', 'hsqldb', 'derby', 'sqlite']);

// Librerías (Maven/Gradle `grupo:artefacto`, npm por nombre) → tecnología.
const JAVA_LIBS = [
  [/^org\.springframework\.boot:spring-boot-starter-data-mongodb(-reactive)?$/, 'mongodb'],
  [/^org\.mongodb:(mongo-java-driver|mongodb-driver.*)$/, 'mongodb'],
  [/^org\.springframework\.boot:spring-boot-starter-amqp$/, 'rabbitmq'],
  [/^com\.rabbitmq:amqp-client$/, 'rabbitmq'],
  [/^org\.springframework\.kafka:spring-kafka$/, 'kafka'],
  [/^org\.apache\.kafka:kafka-clients$/, 'kafka'],
  [/^org\.springframework\.boot:spring-boot-starter-activemq$/, 'activemq'],
  [/^org\.springframework\.boot:spring-boot-starter-data-redis(-reactive)?$/, 'redis'],
  [/^org\.springframework\.boot:spring-boot-starter-redis$/, 'redis'],
  [/^redis\.clients:jedis$/, 'redis'],
  [/^io\.lettuce:lettuce-core$/, 'redis'],
  [/^org\.springframework\.boot:spring-boot-starter-mail$/, 'smtp'],
  [/^(javax|jakarta|com\.sun)\.mail:.*mail$/, 'smtp'],
  [/^org\.postgresql:postgresql$/, 'postgresql'],
  [/^postgresql:postgresql$/, 'postgresql'],
  [/^mysql:mysql-connector-java$/, 'mysql'],
  [/^com\.mysql:mysql-connector-j$/, 'mysql'],
  [/^org\.mariadb\.jdbc:mariadb-java-client$/, 'mariadb'],
  [/^com\.microsoft\.sqlserver:mssql-jdbc$/, 'sqlserver'],
  [/^com\.oracle(\.database\.jdbc|\.ojdbc)?:ojdbc\d*$/, 'oracle'],
  [/^com\.h2database:h2$/, 'h2'],
  [/^org\.hsqldb:hsqldb$/, 'hsqldb'],
  [/^org\.apache\.derby:derby$/, 'derby'],
  [/^org\.springframework\.boot:spring-boot-starter-(data-jpa|jdbc|data-jdbc)$/, 'relational'],
  [/^org\.springframework\.cloud:spring-cloud-starter-(zipkin|sleuth-zipkin)$/, 'zipkin'],
  [/^io\.zipkin\.reporter2?:.*$/, 'zipkin'],
  [/^org\.springframework\.cloud:spring-cloud-starter-(netflix-)?eureka(-client)?$/, 'eureka'],
  [/^org\.springframework\.cloud:spring-cloud-starter-consul.*$/, 'consul'],
  [/^org\.springframework\.cloud:spring-cloud-starter-config$/, 'config-server'],
  [/^org\.springframework\.cloud:spring-cloud-starter-(open)?feign$/, 'http'],
  [/^io\.github\.openfeign:feign-core$/, 'http'],
  [/^com\.squareup\.okhttp3?:okhttp$/, 'http'],
  [/^org\.apache\.httpcomponents(\.client5)?:httpclient5?$/, 'http'],
];

const NODE_LIBS = {
  mongoose: 'mongodb',
  mongodb: 'mongodb',
  monk: 'mongodb',
  pg: 'postgresql',
  'pg-promise': 'postgresql',
  postgres: 'postgresql',
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mariadb',
  mssql: 'sqlserver',
  tedious: 'sqlserver',
  oracledb: 'oracle',
  sqlite3: 'sqlite',
  'better-sqlite3': 'sqlite',
  sequelize: 'relational',
  typeorm: 'relational',
  knex: 'relational',
  '@prisma/client': 'relational',
  redis: 'redis',
  ioredis: 'redis',
  memcached: 'memcached',
  amqplib: 'rabbitmq',
  'amqp-connection-manager': 'rabbitmq',
  kafkajs: 'kafka',
  'node-rdkafka': 'kafka',
  nats: 'nats',
  nodemailer: 'smtp',
  axios: 'http',
  request: 'http',
  'request-promise': 'http',
  got: 'http',
  'node-fetch': 'http',
  superagent: 'http',
  needle: 'http',
};

export function libraryTech(id, stack) {
  if (stack === 'node') return NODE_LIBS[id] ?? null;
  return JAVA_LIBS.find(([re]) => re.test(id))?.[1] ?? null;
}

/**
 * Propiedades de Spring que nombran una dependencia: `{ tech, role }`, con `role` el dato que
 * aporta (`url`, `host`, `port`, `database`, `user`, `password`, `enabled`). Las claves se comparan
 * normalizadas (sin guiones y en minúsculas), como hace el binding relajado.
 */
const SPRING_KEYS = [
  [/^spring\.data\.mongodb\.uri$/, 'mongodb', 'url'],
  [/^spring\.data\.mongodb\.host$/, 'mongodb', 'host'],
  [/^spring\.data\.mongodb\.port$/, 'mongodb', 'port'],
  [/^spring\.data\.mongodb\.database$/, 'mongodb', 'database'],
  [/^spring\.data\.mongodb\.username$/, 'mongodb', 'user'],
  [/^spring\.data\.mongodb\.password$/, 'mongodb', 'password'],
  [/^spring\.datasource(\.\w+)?\.(url|jdbcurl)$/, null, 'url'],
  [/^spring\.datasource(\.\w+)?\.username$/, 'relational', 'user'],
  [/^spring\.datasource(\.\w+)?\.password$/, 'relational', 'password'],
  [/^spring\.rabbitmq\.host$/, 'rabbitmq', 'host'],
  [/^spring\.rabbitmq\.port$/, 'rabbitmq', 'port'],
  [/^spring\.rabbitmq\.addresses$/, 'rabbitmq', 'host'],
  [/^spring\.rabbitmq\.username$/, 'rabbitmq', 'user'],
  [/^spring\.rabbitmq\.password$/, 'rabbitmq', 'password'],
  [/^spring\.kafka\.bootstrapservers(\[\d+\])?$/, 'kafka', 'host'],
  [/^spring\.(data\.)?redis\.host$/, 'redis', 'host'],
  [/^spring\.(data\.)?redis\.port$/, 'redis', 'port'],
  [/^spring\.(data\.)?redis\.url$/, 'redis', 'url'],
  [/^spring\.(data\.)?redis\.password$/, 'redis', 'password'],
  [/^spring\.mail\.host$/, 'smtp', 'host'],
  [/^spring\.mail\.port$/, 'smtp', 'port'],
  [/^spring\.mail\.username$/, 'smtp', 'user'],
  [/^spring\.mail\.password$/, 'smtp', 'password'],
  [/^spring\.zipkin\.baseurl$/, 'zipkin', 'url'],
  [/^spring\.zipkin\.enabled$/, 'zipkin', 'enabled'],
  [/^eureka\.client\.serviceurl\.defaultzone$/, 'eureka', 'url'],
  [/^spring\.cloud\.config\.uri$/, 'config-server', 'url'],
];

export function springKey(key) {
  const k = key.toLowerCase().replace(/-/g, '');
  for (const [re, tech, role] of SPRING_KEYS) if (re.test(k)) return { tech, role };
  return null;
}

// Nombres de variable de entorno que nombran una tecnología (Node y getenv en Java).
const ENV_NAMES = [
  [/^(MONGO(DB)?_(URI|URL|HOST)|MONGO_URI|MONGO_URL|MONGOHQ_URL|MONGOLAB_URI)$/, 'mongodb'],
  [/^(DATABASE_URL|DB_URL|DB_HOST|DATABASE_HOST)$/, 'relational'],
  [/^(PG|POSTGRES(QL)?)_?(URL|URI|HOST)$|^PGHOST$/, 'postgresql'],
  [/^MYSQL_(URL|URI|HOST)$/, 'mysql'],
  [/^REDIS_(URL|URI|HOST)$/, 'redis'],
  [/^(AMQP|RABBIT(MQ)?|CLOUDAMQP)_(URL|URI|HOST)$/, 'rabbitmq'],
  [/^KAFKA_(BROKERS?|BOOTSTRAP_SERVERS|URL|HOST)$/, 'kafka'],
  [/^(SMTP|MAIL|EMAIL)_(HOST|URL|SERVER)$/, 'smtp'],
  [/^ZIPKIN(_HOST|_URL)?$/, 'zipkin'],
];

export function envTech(name) {
  return ENV_NAMES.find(([re]) => re.test(name))?.[1] ?? null;
}

const LOCAL = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

export function isLocalHost(host) {
  return LOCAL.has(String(host).toLowerCase());
}

/** Cómo se provisiona cada clase en el sandbox. La versión de la imagen la decide 0c, no esto. */
export function provisionFor(kind, tech, dep) {
  const aliases = [...new Set(dep.endpoints.map((e) => e.host).filter((h) => h && !isLocalHost(h) && !h.includes('${')))].sort();
  if (EMBEDDED.has(tech)) return { via: 'none', reason: 'base embebida en el proceso' };
  if (kind === 'tracing') {
    return dep.enabled_by_default === false ? { via: 'none', reason: 'apagado por defecto' } : { via: 'container', aliases };
  }
  if (kind === 'database' || kind === 'broker' || kind === 'cache') {
    return tech === 'relational' ? { via: 'ask', reason: 'hay acceso relacional pero ningún driver ni URL dice qué motor' } : { via: 'container', aliases };
  }
  if (kind === 'smtp') return { via: 'mailpit', aliases };
  if (kind === 'http') return { via: 'wiremock', aliases };
  return { via: 'ask', reason: 'dependencia sin provisión conocida: la decide el humano' };
}
