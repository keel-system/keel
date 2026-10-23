import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LEGACY_DIR } from './helpers/golden.js';
import { tmpDir } from './helpers/tmp.js';
import { chooseVersion, fingerprint } from '../src/lib/fingerprint.js';
import { dockerRunImages, imageFacts, leadingVersion } from '../src/lib/images.js';
import { cmpEvidence, evidence } from '../src/lib/repo.js';

// Los hechos que el golden fija byte a byte, afirmados uno a uno: reescribir el golden no puede
// aceptar en silencio que se pierda uno. Cada trampa de las fixtures es una que midió el inc. 1.

const fp = (name) => fingerprint(path.join(LEGACY_DIR, name));

test('elegir versión: la fuente fuerte fija la mayor, la más específica gana dentro de ella', () => {
  // RealWorld: circleci/node:8.5.0 y node_js: 8 dicen lo mismo, y 8.5.0 dice más.
  const rw = chooseVersion('node', [
    { version: '8', via: 'travis', evidence: '.travis.yml:2' },
    { version: '8.5.0', via: 'circleci', evidence: '.circleci/config.yml:6' },
  ]);
  assert.deepEqual(rw, { version: '8.5.0', evidence: '.circleci/config.yml:6', consistent: true });
  // Sock Shop: el pom compila para 1.8 y Travis construía con oraclejdk11.
  const ss = chooseVersion('java', [
    { version: '11', via: 'travis', evidence: '.travis.yml:6' },
    { version: '1.8', via: 'maven java.version', evidence: 'pom.xml:22' },
  ]);
  assert.deepEqual(ss, { version: '1.8', evidence: 'pom.xml:22', consistent: false });
  // Un rango se declara pero no se elige.
  assert.equal(chooseVersion('node', [{ version: '>=6', via: 'engines', evidence: 'package.json:3' }]).version, null);
});

test('imágenes: versión de lenguaje, de herramienta y de motor', () => {
  assert.deepEqual(
    imageFacts('maven:3.2-jdk-8').map((f) => [f.what, f.name, f.version]),
    [
      ['build-tool', 'maven', '3.2'],
      ['language', 'java', '8'],
    ]
  );
  assert.deepEqual(imageFacts('circleci/mongo:3.4.9').map((f) => [f.what, f.name, f.version]), [['service', 'mongodb', '3.4.9']]);
  assert.deepEqual(imageFacts('mcr.microsoft.com/mssql/server:2019-latest').map((f) => f.name), ['sqlserver']);
  assert.equal(imageFacts('mongo@sha256:' + 'a'.repeat(64))[0].pinned, true);
  assert.equal(leadingVersion('jre-latest'), null);
  assert.equal(leadingVersion('14-alpine'), '14');
  // El build.sh de Sock Shop: `$DOCKER_CMD run … maven:3.2-jdk-8 mvn …`
  assert.deepEqual(dockerRunImages('$DOCKER_CMD run --rm -v $HOME/.m2:/root/.m2 -w /src maven:3.2-jdk-8 mvn package'), ['maven:3.2-jdk-8']);
  assert.deepEqual(dockerRunImages('docker run --name realworld-mongo -p 27017:27017 mongo & sleep 5'), ['mongo']);
});

test('evidencia: tramos comprimidos y orden por número de línea', () => {
  assert.equal(evidence('pom.xml', [17, 16, 9]), 'pom.xml:9,16-17');
  assert.equal(evidence('pom.xml', []), 'pom.xml');
  assert.ok(cmpEvidence('a.js:9', 'a.js:10') < 0);
  assert.ok(cmpEvidence('src/a-b.java:5', 'src/a-b.java:40') < 0);
});

test('java8-maven: objetivo 1.8 del pom frente al JDK 11 de la CI, sin wrapper y con repositorio muerto', () => {
  const doc = fp('java8-maven');
  assert.equal(doc.language.version, '1.8');
  assert.equal(doc.language.evidence, 'pom.xml:16');
  assert.equal(doc.language.consistent, false);
  assert.ok(doc.language.declarations.some((d) => d.version === '11' && d.via === 'travis'));
  assert.deepEqual([doc.build.wrapper, doc.build.version, doc.build.evidence], [false, '3.6', 'docker/Dockerfile:1']);
  assert.deepEqual(doc.framework, { name: 'spring-boot', version: '1.5.22.RELEASE', evidence: 'pom.xml:11-12' });
  assert.deepEqual(doc.packaging, { kind: 'jar', name: 'inventory-service', evidence: 'pom.xml:7,49' });
  assert.equal(doc.server.name, 'tomcat');
  assert.deepEqual(doc.repositories[0].risks, ['insecure-http', 'sunset']);
  assert.equal(doc.dockerfiles[0].stages.every((s) => s.pinned === false), true);
  const mongo = doc.services.find((s) => s.via === 'compose' && s.tech === 'mongodb');
  assert.deepEqual([mongo.version, mongo.alias], ['3.6', 'inventory-db']);
  assert.equal(doc.source, undefined, 'una fixture dentro de otro repo no hereda su commit');
});

test('mvnw sin .mvn/wrapper/ es un wrapper roto, no un wrapper (medido en shop-api)', () => {
  const dir = tmpDir('keel-recover-mvnw-');
  fs.cpSync(path.join(LEGACY_DIR, 'java8-maven'), dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}target`) });
  fs.writeFileSync(path.join(dir, 'mvnw'), '#!/bin/sh\n');
  const broken = fingerprint(dir);
  assert.equal(broken.build.wrapper, false);
  fs.mkdirSync(path.join(dir, '.mvn', 'wrapper'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.mvn', 'wrapper', 'maven-wrapper.properties'), 'distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.6.3/apache-maven-3.6.3-bin.zip\n');
  const whole = fingerprint(dir);
  assert.deepEqual([whole.build.wrapper, whole.build.version], [true, '3.6.3']);
});

test('java8-gradle: wrapper, war, toolchain de la CI y servicios con su alias', () => {
  const doc = fp('java8-gradle');
  assert.deepEqual([doc.build.tool, doc.build.wrapper, doc.build.version], ['gradle', true, '4.10.3']);
  assert.equal(doc.language.consistent, true);
  assert.deepEqual([doc.packaging.kind, doc.packaging.name], ['war', 'billing-service']);
  assert.equal(doc.framework.version, '2.0.9.RELEASE');
  assert.deepEqual(
    doc.repositories.map((r) => r.risks),
    [['sunset'], ['requires-auth']]
  );
  assert.deepEqual(
    doc.services.map((s) => [s.tech, s.version, s.alias]),
    [
      ['postgresql', '9.6', 'postgres'],
      ['redis', '4', 'cache'],
    ]
  );
});

test('node14: la matriz de la CI precisa el .nvmrc, registro privado y el motor sin versión del script', () => {
  const doc = fp('node14');
  assert.deepEqual([doc.language.version, doc.language.evidence], ['14.17.0', '.github/workflows/ci.yml:8']);
  assert.equal(doc.engines, null);
  assert.deepEqual(doc.lockfiles, [{ file: 'package-lock.json', manager: 'npm', format: 'npm', lockfileVersion: 1 }]);
  assert.equal(doc.package_manager.name, 'npm');
  assert.deepEqual(
    doc.registries.map((r) => [r.url, r.private]),
    [
      ['https://npm.internal.example.com', true],
      ['https://registry.npmjs.org', false],
    ]
  );
  assert.deepEqual(doc.entrypoint, { command: 'node src/server.js', via: 'scripts.start', evidence: 'package.json:6' });
  const script = doc.services.find((s) => s.via === 'script');
  assert.deepEqual([script.tech, script.version, script.note], ['postgresql', null, 'scripts.db:start']);
});

test('un repo sin archivo de build se declara como no soportado, con motivo', () => {
  const dir = tmpDir('recover-empty-');
  fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n');
  const doc = fingerprint(dir);
  assert.deepEqual(doc.stacks, []);
  assert.match(doc.unsupported, /ningún adaptador/);
});

test('con .git en la raíz, el commit y la fecha del último cambio del build', (t) => {
  const dir = tmpDir('recover-git-');
  fs.cpSync(path.join(LEGACY_DIR, 'node14'), dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: '2020-05-01T10:00:00Z', GIT_COMMITTER_DATE: '2020-05-01T10:00:00Z' } });
  try {
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'inicial');
  } catch {
    t.skip('git no disponible');
    return;
  }
  fs.writeFileSync(path.join(dir, 'NOTICE.md'), 'archivado\n');
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'aviso'], {
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: '2023-12-05T10:00:00Z', GIT_COMMITTER_DATE: '2023-12-05T10:00:00Z' },
  });
  const doc = fingerprint(dir);
  assert.match(doc.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(doc.source.date, '2023-12-05');
  assert.deepEqual(doc.source.build_changed, { date: '2020-05-01', files: ['package.json', 'package-lock.json'] });
});
