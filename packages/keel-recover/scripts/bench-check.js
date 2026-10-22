#!/usr/bin/env node
// Contraste del incremento 2 contra la línea base del banco: corre fingerprint y env-deps sobre los
// tres legacys del laboratorio (`../keel-recover-lab/<legacy>/src`) y comprueba, hecho a hecho, lo
// que dicen los runtime.yaml y environment.yaml escritos a mano en el incremento 1 y las filas
// ENV/ASSET de las hojas de respuestas (docs/recover-bench/).
//
// No entra en `npm test`: el laboratorio vive fuera del repo. Lo que esas referencias traen y es
// trabajo del AGENTE (la imagen elegida, las adaptaciones, los hosts que el código compone en
// tiempo de ejecución) no se le pide a la herramienta determinista: sale listado aparte.
//
//   node scripts/bench-check.js [--lab=<ruta>] [--out=<dir>]   (--out: deja ahí los YAML generados)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDoc } from '../src/lib/emit.js';
import { fingerprint } from '../src/lib/fingerprint.js';
import { envDeps } from '../src/lib/env-deps.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const lab = path.resolve(arg('lab') ?? path.join(here, '..', '..', '..', '..', 'keel-recover-lab'));
const outDir = arg('out') ? path.resolve(arg('out')) : null;

const dep = (env, tech) => env.dependencies.find((d) => d.tech === tech);
const cfg = (env, key) => env.config.find((c) => c.key === key);
const asset = (env, p) => env.assets.find((a) => a.path === p);

// [referencia, hecho, comprobación(runtime, environment)]
const BENCH = {
  'sockshop-shipping': {
    facts: [
      ['runtime.language', 'java 1.8 en pom.xml:22', (r) => r.language.version === '1.8' && r.language.evidence === 'pom.xml:22'],
      ['runtime.build', 'maven sin wrapper', (r) => r.build.tool === 'maven' && r.build.wrapper === false],
      ['runtime.framework', 'spring-boot 1.4.0.RELEASE en pom.xml:16-17', (r) => r.framework.version === '1.4.0.RELEASE' && r.framework.evidence === 'pom.xml:16-17'],
      ['runtime.packaging', 'jar, finalName shipping, pom.xml:9,77', (r) => r.packaging.kind === 'jar' && r.packaging.name === 'shipping' && r.packaging.evidence === 'pom.xml:9,77'],
      ['runtime.repositories', 'spring-releases repo.spring.io/libs-release', (r) => r.repositories.some((x) => x.id === 'spring-releases' && x.url === 'https://repo.spring.io/libs-release')],
      ['runtime.upstream_dockerfile', 'docker/shipping/Dockerfile, msd-java:jre-latest sin fijar', (r) => r.dockerfiles.some((d) => d.path === 'docker/shipping/Dockerfile' && d.stages[0].image === 'weaveworksdemos/msd-java:jre-latest' && !d.stages[0].pinned)],
      ['environment.dependencies[rabbitmq]', 'broker rabbitmq, host rabbitmq, alias rabbitmq', (r, e) => dep(e, 'rabbitmq')?.kind === 'broker' && dep(e, 'rabbitmq').provision.aliases.includes('rabbitmq')],
      ['SH-ENV-02', 'guest/guest fijas en RabbitMqConfiguration.java:28-29', (r, e) => dep(e, 'rabbitmq').credentials?.some((c) => c.user === 'guest' && c.password === 'guest' && c.where === 'code' && /RabbitMqConfiguration\.java:28-29$/.test(c.evidence))],
      ['environment.dependencies[zipkin]', 'tracing zipkin apagado por defecto, sin provisión', (r, e) => dep(e, 'zipkin')?.enabled_by_default === false && dep(e, 'zipkin').provision.via === 'none'],
      ['environment.config[port]', 'port 8080 en application.properties:1', (r, e) => e.listen.port === 8080 && cfg(e, 'port')?.evidence === 'src/main/resources/application.properties:1'],
      ['SH-ENV-03', 'sin base de datos', (r, e) => !e.dependencies.some((d) => d.kind === 'database')],
      ['SH-ASSET-01', 'la prueba de integración ITShippingController', (r, e) => asset(e, 'src/test/java/works/weave/socks/shipping/controllers/ITShippingController.java')?.level === 'integration'],
    ],
    agent: ['adaptations (imagen eclipse-temurin:8-jre, JaCoCo, red --internal)'],
  },
  'sockshop-orders': {
    facts: [
      ['runtime.language', 'java 1.8 en pom.xml:22', (r) => r.language.version === '1.8' && r.language.evidence === 'pom.xml:22'],
      ['OR-ENV-01', 'maven sin wrapper y spring-boot 1.4.4.RELEASE', (r) => r.build.wrapper === false && r.framework.version === '1.4.4.RELEASE'],
      ['runtime.packaging', 'jar, finalName orders, pom.xml:81', (r) => r.packaging.name === 'orders' && r.packaging.evidence.endsWith(',81')],
      ['runtime.repositories', 'spring-releases, cerrado al anónimo', (r) => r.repositories.some((x) => x.id === 'spring-releases' && x.risks.includes('requires-auth'))],
      ['OR-ENV-03', 'docker/orders/Dockerfile con msd-java:jre-latest sin fijar', (r) => r.dockerfiles.some((d) => d.path === 'docker/orders/Dockerfile' && !d.stages[0].pinned)],
      ['environment.dependencies[mongodb]', 'mongodb host orders-db, base data, application.properties:2', (r, e) => dep(e, 'mongodb')?.endpoints.some((x) => x.host === 'orders-db' && x.database === 'data' && x.evidence === 'src/main/resources/application.properties:2')],
      ['environment.config[port]', 'port 8082 (el error del operador: no es 8080)', (r, e) => e.listen.port === 8082 && e.listen.key === 'port'],
      ['environment.config[http.timeout]', 'http.timeout 5 en OrdersController.java:46', (r, e) => cfg(e, 'http.timeout')?.default === '5' && /OrdersController\.java:46$/.test(cfg(e, 'http.timeout').evidence)],
      ['OR-ENV-04', 'port, db (orders-db), http.timeout, domain, proxy.host/port, zipkin apagado', (r, e) => ['port', 'db', 'http.timeout', 'domain', 'proxy.host', 'proxy.port', 'zipkin_enabled'].every((k) => cfg(e, k)) && cfg(e, 'db').default === 'orders-db' && dep(e, 'zipkin').enabled_by_default === false],
      ['OR-ENV-05 (parcial)', 'llamadas HTTP salientes detectadas (los hosts payment y shipping los compone el código)', (r, e) => e.outbound_http.call_sites.length > 0],
      ['OR-ASSET-01', 'test/json-server/server.py es un stub Flask', (r, e) => asset(e, 'test/json-server/server.py')?.kind === 'stub' && asset(e, 'test/json-server/server.py').format === 'flask'],
      ['OR-ASSET-02', 'la spec solo documenta POST y GET /orders', (r, e) => asset(e, 'api-spec/orders.json')?.operations === 2],
      ['OR-ASSET-03', 'api-spec/hooks.js trae un seed', (r, e) => asset(e, 'api-spec/hooks.js')?.seeds === true],
    ],
    agent: [
      'dependencies[payment|shipping]: http://payment/paymentAuth y http://shipping/shipping los compone OrdersConfigurationProperties en tiempo de ejecución; la herramienta da las llamadas, el agente sus destinos',
      'dependencies[customer/address/card/items]: URLs que llegan en el cuerpo de POST /orders',
      'adaptations (mongo:4.4, eclipse-temurin:8-jre + JaCoCo, red --internal)',
    ],
  },
  'realworld-node': {
    facts: [
      ['runtime.language / RW-ENV-05', 'node 8.5.0 de .circleci/config.yml:6, con node_js 8 de .travis.yml:2', (r) => r.language.version === '8.5.0' && r.language.evidence === '.circleci/config.yml:6' && r.language.declarations.some((d) => d.via === 'travis' && d.evidence === '.travis.yml:2')],
      ['runtime.package_manager / RW-ENV-04', 'yarn con yarn.lock', (r) => r.package_manager.name === 'yarn' && r.lockfiles.some((l) => l.file === 'yarn.lock')],
      ['runtime.framework', 'express 4.13.4', (r) => r.framework.name === 'express' && r.framework.version === '4.13.4'],
      ['runtime.database', 'mongodb 3.4.9 de .circleci/config.yml:7', (r) => r.services.some((s) => s.tech === 'mongodb' && s.version === '3.4.9' && s.evidence === '.circleci/config.yml:7')],
      ['runtime.entrypoint', 'node ./app.js (scripts.start)', (r) => r.entrypoint.command === 'node ./app.js'],
      ['runtime.engines', 'package.json no declara engines', (r) => r.engines === null],
      ['RW-ASSET-02', 'mongo:start levanta mongo sin versión', (r) => r.services.some((s) => s.via === 'script' && s.image === 'mongo' && s.version === null)],
      ['environment.dependencies[mongodb]', 'mongodb por MONGODB_URI (app.js:34) y la URI fija de desarrollo (app.js:36)', (r, e) => dep(e, 'mongodb')?.endpoints.some((x) => x.env === 'MONGODB_URI' && x.evidence === 'app.js:34') && dep(e, 'mongodb').endpoints.some((x) => x.host === 'localhost' && x.evidence === 'app.js:36')],
      ['RW-ENV-01/03', 'NODE_ENV comparado con production', (r, e) => cfg(e, 'NODE_ENV')?.compared_with?.includes('production')],
      ['RW-ENV-02', 'SECRET leído del entorno (config/index.js:2)', (r, e) => cfg(e, 'SECRET')?.evidence === 'config/index.js:2'],
      ['environment.config[PORT]', 'PORT 3000 en app.js:82', (r, e) => e.listen.port === 3000 && e.listen.env === 'PORT' && e.listen.evidence === 'app.js:82'],
      ['RW-ASSET-01', 'colección Postman de 31 peticiones', (r, e) => e.assets.some((a) => a.kind === 'collection' && a.requests === 31)],
    ],
    agent: [
      'config: los valores del sandbox (NODE_ENV=production, SECRET de prueba, MONGODB_URI hacia el alias)',
      'adaptations (mongo:3.4.9 frente a 3.6/7.0, nyc 14.1.1, red --internal)',
      'only_in: production de MONGODB_URI: el `if (isProduction)` lo lee el agente; la herramienta da los dos endpoints',
    ],
  },
};

let failed = 0;
for (const [legacy, spec] of Object.entries(BENCH)) {
  const src = path.join(lab, legacy, 'src');
  if (!fs.existsSync(src)) {
    console.error(`✗ ${legacy}: no está el laboratorio en ${src}`);
    failed++;
    continue;
  }
  const runtime = renderDoc(fingerprint(src));
  const environment = renderDoc(envDeps(src));
  for (const [name, doc] of [
    ['runtime.yaml', runtime],
    ['environment.yaml', environment],
  ]) {
    if (doc.errors.length) {
      console.error(`✗ ${legacy}/${name} no cumple su schema: ${doc.errors.join('; ')}`);
      failed++;
    }
    if (outDir) {
      fs.mkdirSync(path.join(outDir, legacy), { recursive: true });
      fs.writeFileSync(path.join(outDir, legacy, name), doc.text);
    }
  }
  const again = renderDoc(envDeps(src)).text === environment.text && renderDoc(fingerprint(src)).text === runtime.text;
  console.log(`\n${legacy}${again ? '' : '  ✗ NO DETERMINISTA'}`);
  if (!again) failed++;
  for (const [ref, fact, ok] of spec.facts) {
    let pass = false;
    try {
      pass = Boolean(ok(runtime.plain, environment.plain));
    } catch {
      pass = false;
    }
    if (!pass) failed++;
    console.log(`  ${pass ? '✓' : '✗'} ${ref}: ${fact}`);
  }
  for (const a of spec.agent) console.log(`  · agente: ${a}`);
}
console.log(failed ? `\n${failed} hecho(s) en rojo` : '\ntodos los hechos deterministas de la línea base, en verde');
process.exit(failed ? 1 : 0);
