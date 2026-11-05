// La caché AOT de `deploy/Dockerfile` (inc. 4 de PLAN-KEEL-SPRING-BOOT41.md).
//
// El entrenamiento refresca el contexto DENTRO de `docker build`, sin base, sin broker y sin el
// compose que da a la app sus variables. Si algo de eso le hace falta, el entrenamiento falla y la
// imagen sale igual, sin caché y sin que nadie se entere: es una optimización, así que el fallo no
// rompe el build a propósito. Por eso lo que el perfil `aot-training` tiene que apagar o aportar se
// comprueba aquí, fixture a fixture, y no se deja al primer `deploy-check` que lo note.
//
// Medido con `deploy-check` y con imágenes construidas a mano (docs/corridas/2026-11-05-aot-cache.md):
// sin el perfil, el entrenamiento muere en Flyway y la imagen sale sin `app.aot`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { AOT_TRAINING_PLACEHOLDER, AOT_TRAINING_PROFILE, requiredByDevelop } from '../src/scaffold/config.js';
import { DATABASES } from '../src/lib/stack-catalog.js';
import { JVM_BASE_OPTS } from '../src/scaffold/deploy.js';
import { JAVA_DATABASES } from '../src/lib/java-stack.js';
import { tmpDir } from './helpers/tmp.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const TRAINING_FILE = `src/main/resources/application-${AOT_TRAINING_PROFILE}.yaml`;
const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));

// Las variantes que cambian lo que el entrenamiento tiene que apagar: el broker (solo el KafkaAdmin
// habla con el suyo al instanciarse) y el motor; y las que cambian lo que develop exige sin default.
const STACKS = [null, { broker: 'kafka' }, { database: 'mysql' }, { auth: 'cognito', storage: 's3' }];

function plan(fixture, stack) {
  const { manifest, layers, errors } = loadService(path.join(FIXTURES_DIR, fixture));
  assert.deepEqual(errors, []);
  return planService({ manifest, layers, workspace: tmpDir('aot-cache-'), stack });
}

const file = (files, filePath) => files.find((candidate) => candidate.path === filePath)?.content;

for (const fixture of fixtures) {
  for (const stack of STACKS) {
    test(`caché AOT: el perfil de entrenamiento apaga lo que conecta y da lo que develop exige (${fixture}${stack ? `, ${JSON.stringify(stack)}` : ''})`, (t) => {
      let planned;
      try {
        planned = plan(fixture, stack);
      } catch (error) {
        // Una variante que el diseño no admite (un motor relacional sobre un diseño documental, un
        // broker sin capa de mensajería…) no tiene nada que entrenar.
        t.skip(error.message.split('\n')[0]);
        return;
      }
      const { files, model } = planned;
      const yaml = YAML.parse(file(files, TRAINING_FILE)) ?? {};
      const db = DATABASES[model.stack.database];
      const relational = model.layersPresent.persistence && db && db.kind !== 'document';

      if (relational) {
        assert.equal(yaml.spring?.flyway?.enabled, false, 'Flyway migraría contra una base que el build no tiene');
        assert.equal(yaml.spring?.jpa?.hibernate?.['ddl-auto'], 'none', 'validate pide una conexión');
        assert.equal(yaml.spring?.jpa?.properties?.hibernate?.['boot.allow_jdbc_metadata_access'], false);
        assert.equal(yaml.spring?.jpa?.['database-platform'], JAVA_DATABASES[db.id].dialect);
      } else {
        // En el modelo documental no hay nada de JPA que apagar: escribirlo sería configuración que
        // nadie lee.
        assert.equal(yaml.spring?.jpa, undefined);
        assert.equal(yaml.spring?.flyway, undefined);
      }

      const kafka = model.layersPresent.messaging && model.stack.broker === 'kafka';
      assert.equal(yaml.spring?.kafka?.admin?.['auto-create'], kafka ? false : undefined);

      // Todo lo que develop lee sin default lo trae el perfil: si no, «Could not resolve
      // placeholder» y la imagen sin caché. La lista sale de los fragmentos, no se escribe.
      const missing = requiredByDevelop(files).filter((name) => yaml[name] !== AOT_TRAINING_PLACEHOLDER);
      assert.deepEqual(missing, [], 'develop exige estas variables sin default y el entrenamiento no las tiene');
    });
  }
}

test('caché AOT: el cruce de variables no es vacuo (catalog-extended exige seis sin default)', () => {
  const { files } = plan('catalog-extended', null);
  const yaml = YAML.parse(file(files, TRAINING_FILE));
  assert.ok(requiredByDevelop(files).length >= 6);
  assert.equal(yaml.STORAGE_PUBLIC_BASE_URL, AOT_TRAINING_PLACEHOLDER);
  assert.equal(yaml.PRICING_BASE_URL, AOT_TRAINING_PLACEHOLDER);
});

test('caché AOT: cada motor relacional del catálogo trae su dialecto de Hibernate', () => {
  for (const [id, entry] of Object.entries(DATABASES)) {
    if (entry.kind === 'document') {
      assert.equal(JAVA_DATABASES[id].dialect, undefined, id);
      continue;
    }
    assert.match(JAVA_DATABASES[id].dialect ?? '', /^org\.hibernate\.dialect\.[A-Za-z]+Dialect$/, id);
  }
});

test('caché AOT: el Dockerfile entrena con el perfil de deploy/ y arranca con la caché solo si existe', () => {
  const { files } = plan('job-dispatch', null);
  const dockerfile = file(files, 'deploy/Dockerfile');
  const compose = YAML.parse(file(files, 'deploy/docker-compose.yaml'));

  // El entrenamiento corre con el perfil con el que el compose arranca la app, más el suyo encima.
  assert.equal(compose.services.app.environment.PROFILE, 'develop');
  assert.ok(dockerfile.includes(`-Dspring.profiles.active=develop,${AOT_TRAINING_PROFILE}`));
  assert.ok(dockerfile.includes('-XX:AOTCacheOutput=app.aot'));
  assert.ok(dockerfile.includes('-Dspring.context.exit=onRefresh'));
  // Las banderas de la JVM tienen que ser las mismas en el entrenamiento y en el arranque.
  assert.ok(dockerfile.includes('java $JVM_BASE_OPTS $JAVA_OPTS -XX:AOTCacheOutput=app.aot'));
  assert.ok(dockerfile.includes('ARG AOT_CACHE=true'));

  // Va DESPUÉS de la última capa del jar (entrena sobre la forma extraída, la que arranca) y como el
  // usuario de la app, que necesita poder escribir en su directorio.
  const lastCopy = dockerfile.lastIndexOf('/workspace/extracted/application/');
  const training = dockerfile.indexOf('-XX:AOTCacheOutput');
  assert.ok(lastCopy > 0 && training > lastCopy);
  assert.ok(dockerfile.indexOf('chown app:app /application') < dockerfile.indexOf('USER app'));

  // Un entrenamiento fallido no rompe la imagen…
  assert.ok(dockerfile.includes('|| { rm -f app.aot;'));
  // …y sin el archivo no se pasa la bandera: la JVM arrancaría igual, pero con tres líneas
  // [error][aot] (medido con temurin 25).
  assert.ok(dockerfile.includes('exec java $([ -f app.aot ] && echo -XX:AOTCache=app.aot) $JVM_BASE_OPTS $JAVA_OPTS -jar application.jar'));

  // Las continuaciones de línea sobreviven al template literal (un `\` a secas ante un salto de
  // línea lo borra JS y el RUN queda en una línea).
  assert.match(dockerfile, /RUN if \[ "\$AOT_CACHE" = "true" \]; then \\\n/);
});

test('cabeceras compactas: van en las banderas de la imagen, las mismas en el entrenamiento y en el arranque', () => {
  const { files } = plan('job-dispatch', null);
  const dockerfile = file(files, 'deploy/Dockerfile');
  assert.equal(JVM_BASE_OPTS, '-XX:+UseCompactObjectHeaders');
  // Una variable de la imagen, no un default de JAVA_OPTS: quien despliega con JAVA_OPTS=-Xmx… no las pierde, y
  // con ellas la caché, que la JVM ignora si las banderas no casan.
  assert.ok(dockerfile.includes(`ENV JVM_BASE_OPTS="${JVM_BASE_OPTS}"`));
  assert.ok(!/ENV JAVA_OPTS/.test(dockerfile));
  // Declarada ANTES del entrenamiento, o el RUN la vería vacía.
  assert.ok(dockerfile.indexOf('ENV JVM_BASE_OPTS') < dockerfile.indexOf('-XX:AOTCacheOutput'));
  const uses = dockerfile.match(/java \$JVM_BASE_OPTS \$JAVA_OPTS|\$JVM_BASE_OPTS \$JAVA_OPTS -jar/g) ?? [];
  assert.equal(uses.length, 2);
});
