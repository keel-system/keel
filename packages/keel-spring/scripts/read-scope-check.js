#!/usr/bin/env node
// EJECUTA la lectura acotada (DSL 2.27, `reads` y `readMiss`) que emite keel-spring: los casos RS-1 a RS-11 de
// keel-core/gen/read-scope.js, con los mismos ids que ejecutarán keel-nest, keel-dotnet y keel-go, sobre los MISMOS
// diseños (keel-core/test/helpers/read-scope-designs.js).
//
// Por qué existe: lo que se mide aquí compila diga lo que diga — un listado que no suma el predicado, un total que
// cuenta filas ajenas, una carga por id que no compara, un claim ausente tratado como «todo», un camino que compara el
// campo equivocado, una clave de caché sin el scope. Su fallo no se ve: es una fuga de datos (OWASP API1). Dos clases
// JUnit dentro del proyecto generado (src/lib/read-scope-probes.js): el ADAPTADOR contra el motor real de infra/ (RS-1 a
// RS-8) y el BORDE sin base (RS-9 a RS-11).
//
//   node packages/keel-spring/scripts/read-scope-check.js [diseño] [--database=<motor>] [--sabotage=<id>] [--keep]
//   npm run read-scope-check --workspace packages/keel-spring
//
// Diseños: vault-scoped (relacional: claim, exentos, caché y el salto Asset.owner → Owner.code), vault-scoped-mongo (lo
// mismo en documental), shop-scoped (propiedad por la identidad, roles exentos, forbidden, paginado y un filtro) y
// conduit-scoped (documental: el dueño por Article.author → Profile.subject, not-found, carga por slug). Necesita podman
// o docker, y JDK.
//
// --sabotage=<id> rompe lo emitido conservando la forma (sigue compilando), y verde significa que cae en EXACTAMENTE sus
// casos de READ_SCOPE_SABOTAGES que este diseño ejecuta (casesOf): ni uno más ni uno menos.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { OPTIONAL_AUTH_SABOTAGES, READ_SCOPE_SABOTAGES, readScopePath, scopedRootsOf } from '@keel-system/keel-core/gen/read-scope';
import { tmpDir } from '../test/helpers/tmp.js';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService } from '../src/scaffold/index.js';
import { databaseHealthProbe } from '../src/lib/stack-catalog.js';
import {
  ADAPTER_CLASS, EDGE_CLASS, OPTIONAL_CLASS, PACKAGE_LEAF, adapterTestClass, casesOf, edgeTestClass, namedTypes, optionalAuthOperations,
  optionalAuthTestClass, probedEntities
} from '../src/lib/read-scope-probes.js';
import { READ_SCOPE_DESIGNS } from '../../keel-core/test/helpers/read-scope-designs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'designs');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const designName = args.find((arg) => !arg.startsWith('--')) ?? 'vault-scoped';
const database = args.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? 'postgresql';
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;

/**
 * Cada sabotaje: `[archivo (sufijo, {root} = cada raíz acotada), texto o expresión, sustituto]`, uno o varios. Todos
 * compilan: lo que se mide es la sonda, no javac. `(model) => [...]` cuando depende del diseño.
 */
const SABOTAGES = {
  // El finder no suma el predicado: las filas y el total, de la misma consulta (D4).
  'rs-no-filter': [
    ['{root}RepositoryImpl.java', '            where.add(readScope(root, query, cb, scope));\n', ''],
    ['{root}RepositoryImpl.java', '            where.add(readScope(scope));\n', '']
  ],
  // El total cuenta sin el scope: las filas siguen acotadas.
  'rs-count-unscoped': [
    [
      '{root}RepositoryImpl.java',
      /return (\w+)\.findAll\(specification, withStableOrder\(pageable\)\)\.map\(this::toDomain\);/,
      'return new org.springframework.data.domain.PageImpl<>($1.findAll(specification, withStableOrder(pageable)).getContent().stream().map(this::toDomain).toList(), withStableOrder(pageable), $1.count());'
    ],
    ['{root}RepositoryImpl.java', /long total = mongoTemplate\.count\(query, (\w+)\.class\);/, 'long total = mongoTemplate.count(new Query(), $1.class);']
  ],
  // La carga por id no compara.
  'rs-get-leak': [['{root}RepositoryImpl.java', '        if (admitted) {', '        if (admitted || true) {']],
  // El conjunto vacío (o el dueño nulo) lo ve todo, en el adaptador y en el borde.
  'rs-empty-is-all': [
    ['{root}RepositoryImpl.java', '        return cb.disjunction();', '        return cb.conjunction();'],
    ['{root}RepositoryImpl.java', '        return Criteria.where(property).in(List.of());', '        return new Criteria();'],
    ['ReadScopes.java', 'return ReadScope.within(callerScope.scopedValues());', 'return callerScope.scopedValues().isEmpty() ? ReadScope.unrestricted() : ReadScope.within(callerScope.scopedValues());']
  ],
  // El predicado sustituye a los criterios en vez de sumarse.
  'rs-finder-replace': [
    ['{root}RepositoryImpl.java', '            where.add(readScope(root, query, cb, scope));', '            where.clear();\n            where.add(readScope(root, query, cb, scope));'],
    ['{root}RepositoryImpl.java', '            where.add(readScope(scope));', '            where.clear();\n            where.add(readScope(scope));']
  ],
  // Compara otro campo de texto de la raíz del otro lado del camino.
  'rs-path': (model) =>
    scopedRootsOf(model).flatMap(({ entity, read }) => {
      const { target, hops } = readScopePath(model, read);
      if (hops.length === 0) return [];
      const other = target.fields.find((field) => field.name !== read.field && field.javaType === 'String' && !field.list);
      if (!other) throw new Error(`rs-path: ${target.name} no tiene otro campo de texto con el que sabotear`);
      return [
        [`${entity.name}RepositoryImpl.java`, `.<String>get("${read.field}"), scope)`, `.<String>get("${other.name}"), scope)`],
        [`${entity.name}RepositoryImpl.java`, `scoped("${read.field}", scope)`, `scoped("${other.name}", scope)`]
      ];
    }),
  // La clave de caché no lleva el scope.
  'rs-cache-key': [
    ['CachedOperations.java', /, query\.readScope\(\)\.cacheKey\(\)\)/g, ')'],
    ['CachedOperations.java', 'return query.readScope().cacheKey();', 'return "all";']
  ],
  // level: optional: un token que no se puede decodificar se trata como si no hubiera token (anónimo) en vez de 401.
  'oa-degrade': [
    [
      'SecurityConfig.java',
      '    private final SecurityErrorHandlers securityErrorHandlers;\n',
      '    private final SecurityErrorHandlers securityErrorHandlers;\n\n' +
        '    @org.springframework.beans.factory.annotation.Autowired\n' +
        '    private org.springframework.security.oauth2.jwt.JwtDecoder sabotageDecoder;\n\n' +
        '    private String sabotagedToken(jakarta.servlet.http.HttpServletRequest request) {\n' +
        '        String token = new org.springframework.security.oauth2.server.resource.web.DefaultBearerTokenResolver().resolve(request);\n' +
        '        if (token == null) return null;\n' +
        '        try { sabotageDecoder.decode(token); return token; } catch (RuntimeException invalid) { return null; }\n' +
        '    }\n'
    ],
    ['SecurityConfig.java', '.oauth2ResourceServer(oauth2 -> oauth2.authenticationEntryPoint(', '.oauth2ResourceServer(oauth2 -> oauth2.bearerTokenResolver(this::sabotagedToken).authenticationEntryPoint(']
  ],
  // level: optional: la identidad nunca llega, ni con un token válido.
  'oa-ignore-token': [['CallerIdentity.java', '        return resolve();\n', '        return null;\n']]
};

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function resolveRuntime() {
  const preferred = process.env.CONTAINER_RUNTIME;
  for (const runtime of preferred ? [preferred] : ['docker', 'podman']) {
    if (run(runtime, ['--version']).status !== 0) continue;
    const frontends = runtime === 'podman' ? [{ command: 'podman', prefix: ['compose'] }, { command: 'podman-compose', prefix: [] }] : [{ command: 'docker', prefix: ['compose'] }];
    return { runtime, frontends };
  }
  return null;
}

function composeUp(frontends, projectDir) {
  for (const frontend of frontends) {
    const result = run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'up', '-d', 'db'], { cwd: projectDir });
    if (result.status === 0) return frontend;
  }
  return null;
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

function classOf(projectDir, className) {
  const file = walk(path.join(projectDir, 'src/main/java')).find((candidate) => path.basename(candidate) === `${className}.java`);
  if (!file) throw new Error(`read-scope-check: no encuentro ${className}.java en el proyecto generado`);
  const text = fs.readFileSync(file, 'utf8');
  return { file, text, pkg: /^package\s+([\w.]+);/m.exec(text)[1] };
}

function readResults(projectDir, className) {
  const dir = path.join(projectDir, 'build/test-results/test');
  if (!fs.existsSync(dir)) return [];
  const file = fs.readdirSync(dir).find((name) => name.includes(className) && name.endsWith('.xml'));
  if (!file) return [];
  const xml = fs.readFileSync(path.join(dir, file), 'utf8');
  const cases = [];
  const re = /<testcase[^>]*\bname="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const failure = /<(failure|error)[^>]*message="([^"]*)"/.exec(match[3] ?? '');
    cases.push({ name: match[1].replace(/\(\)$/, ''), ok: !failure, detail: failure ? failure[2].replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&').slice(0, 300) : '' });
  }
  return cases;
}

/** El caso de una prueba por su prefijo: `rs8_Asset_…` → RS-8, `oa2_getArticle_…` → OA-2. */
const caseOf = (testName) => {
  const match = /^(rs|oa)(\d+)_/.exec(testName);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : '?';
};

const design = READ_SCOPE_DESIGNS.find((candidate) => candidate.name === designName);
if (!design) {
  console.error(`No hay ningún diseño de lectura acotada '${designName}'. Los hay: ${READ_SCOPE_DESIGNS.map((d) => d.name).join(', ')}.`);
  process.exit(2);
}
if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`No hay ningún sabotaje '${sabotage}'. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}
const runtime = resolveRuntime();
if (!runtime) {
  console.error('No hay docker ni podman en el PATH.');
  process.exit(2);
}
if (run('java', ['-version']).status !== 0) {
  console.error('No hay JDK en el PATH.');
  process.exit(2);
}

const service = loadService(path.join(fixturesDir, design.from));
design.mutate(service.layers);
const document = (service.layers.persistence?.default?.model ?? 'relational') === 'document';
const engine = document ? 'mongodb' : database;
const stack = { database: engine, ...(service.layers['use-cases'] && Object.values(service.layers['use-cases'].operations ?? {}).some((op) => op.cache) ? { cache: 'redis' } : {}) };
const model = buildModel({ manifest: service.manifest, layers: service.layers, stack });
const cases = casesOf(model);
let expected = null;
if (sabotage) {
  const declared = [...READ_SCOPE_SABOTAGES, ...OPTIONAL_AUTH_SABOTAGES].find((entry) => entry.id === sabotage);
  // La mitad del borde de rs-empty-is-all es el claim AUSENTE, que solo existe con scoping: con la propiedad, sin
  // identidad no hay scope (CallerIdentity responde 401), así que ahí no tiene dónde caer.
  const scoping = scopedRootsOf(model).some(({ read }) => read.kind === 'scoping');
  // Con el campo acotado al otro lado de una relación, el listado y su total propios son RS-8 (read-scope-probes.js):
  // lo que ahí rompe un sabotaje de RS-1 o RS-2 cae en RS-8.
  const onPath = !cases.includes('RS-1') && cases.includes('RS-8');
  const located = declared.falls.map((id) => (onPath && (id === 'RS-1' || id === 'RS-2') ? 'RS-8' : id));
  expected = [...new Set(located)].filter((id) => cases.includes(id) && !(sabotage === 'rs-empty-is-all' && id === 'RS-10' && !scoping));
  if (expected.length === 0) {
    console.error(`El sabotaje '${sabotage}' cae en ${declared.falls.join(', ')}, y ${designName} no ejecuta ninguno (ejecuta ${cases.join(', ')}).`);
    process.exit(2);
  }
}
const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-read-scope-keep-')) : tmpDir('keel-read-scope-check-');
scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack });
const projectDir = path.join(workspace, 'services', fs.readdirSync(path.join(workspace, 'services'))[0]);

if (sabotage) {
  const entries = typeof SABOTAGES[sabotage] === 'function' ? SABOTAGES[sabotage](model) : SABOTAGES[sabotage];
  const roots = scopedRootsOf(model).map(({ entity }) => entity.name);
  let applied = 0;
  for (const [pattern, from, to] of entries) {
    const suffixes = pattern.includes('{root}') ? roots.map((root) => `${path.sep}${pattern.replace('{root}', root)}`) : [`${path.sep}${pattern}`];
    for (const file of walk(path.join(projectDir, 'src/main/java')).filter((candidate) => suffixes.some((suffix) => candidate.endsWith(suffix)))) {
      const text = fs.readFileSync(file, 'utf8');
      const changed = typeof from === 'string' ? text.replaceAll(from, to) : text.replace(from, to);
      if (changed !== text) {
        fs.writeFileSync(file, changed);
        applied += 1;
      }
    }
  }
  if (applied === 0) {
    console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy para ${designName} (¿cambió el texto?).`);
    process.exit(2);
  }
  console.log(`(sabotaje: ${sabotage}; tiene que caer en ${expected.join(', ')})`);
}

const db = YAML.parse(fs.readFileSync(path.join(projectDir, 'src/main/resources/parameters/local/db.yaml'), 'utf8'));
const datasource = document ? { uri: db?.spring?.mongodb?.uri } : (db?.spring?.datasource ?? {});
if (document && !datasource.uri) throw new Error('el db.yaml generado no trae spring.mongodb.uri: ¿cambió la clave de la conexión?');
const optional = (name) => {
  try {
    return classOf(projectDir, name).pkg;
  } catch {
    return null;
  }
};
// Con lecturas acotadas, las sondas del adaptador (contra el motor) y del borde; con level: optional, las del borde OA.
// conduit-optional no acota ninguna lectura: no levanta base.
const anyRoot = probedEntities(model)[0] ?? null;
const optionalOps = optionalAuthOperations(model);
const pkgOf = (name) => classOf(projectDir, name).pkg;
const packages = {
  port: anyRoot ? pkgOf(`${anyRoot}Repository`) : null,
  adapters: anyRoot ? pkgOf(`${anyRoot}RepositoryImpl`) : null,
  errors: pkgOf('DomainException'),
  rest: pkgOf('ApiExceptionHandler'),
  security: optional('ReadScopes') ?? optional('SecurityConfig'),
  support: optional('CachedOperations'),
  types: Object.fromEntries(namedTypes(model).map((name) => [name, pkgOf(name)])),
  messages: Object.fromEntries(
    model.services
      .flatMap((group) => group.operations)
      .filter((op) => op.readScope || optionalOps.includes(op))
      .map((op) => [op.name, pkgOf(op.messageClass)])
  )
};

const collaborators = [];
for (const name of probedEntities(model)) {
  const impl = classOf(projectDir, `${name}RepositoryImpl`);
  const ctor = new RegExp(`public ${name}RepositoryImpl\\(([^)]*)\\)`).exec(impl.text);
  const types = ctor[1].split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
  if (document) types.push('MongoTransactionConfig');
  types.push('AuditorAwareConfig');
  for (const type of types) {
    const pkg = optional(type);
    if (pkg && !type.endsWith('JpaRepository') && !type.endsWith('MongoRepository') && !collaborators.some((c) => c.type === type)) collaborators.push({ type, fqn: `${pkg}.${type}` });
  }
}

const testDir = path.join(projectDir, 'src/test/java', ...model.service.basePackage.split('.'), PACKAGE_LEAF);
fs.mkdirSync(testDir, { recursive: true });
const classes = [];
if (anyRoot) {
  fs.writeFileSync(path.join(testDir, `${ADAPTER_CLASS}.java`), adapterTestClass(model, { packages, document, datasource, collaborators }), 'utf8');
  fs.writeFileSync(path.join(testDir, `${EDGE_CLASS}.java`), edgeTestClass(model, { packages }), 'utf8');
  classes.push(ADAPTER_CLASS, EDGE_CLASS);
}
if (optionalOps.length > 0) {
  // El controller de cada operación optional: el que despacha su mensaje. Sus colaboradores, por su constructor.
  const controllers = walk(path.join(projectDir, 'src/main/java'))
    .filter((file) => file.endsWith('V1Controller.java'))
    .map((file) => {
      const name = path.basename(file, '.java');
      const { text, pkg } = classOf(projectDir, name);
      const ctor = new RegExp(`public ${name}\\(([^)]*)\\)`).exec(text);
      const params = (ctor?.[1] ?? '').split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).map((type) => ({ type, fqn: `${pkgOf(type)}.${type}` }));
      return { name, pkg, params, text };
    });
  const opController = Object.fromEntries(
    optionalOps.map((op) => {
      const owner = controllers.find((controller) => controller.text.includes(`new ${op.messageClass}(`));
      if (!owner) throw new Error(`read-scope-check: ningún controller despacha ${op.messageClass}`);
      return [op.name, owner.name];
    })
  );
  const securityTypes = ['SecurityConfig', 'SecurityErrorHandlers', 'CorsConfig'].filter((name) => optional(name));
  fs.writeFileSync(path.join(testDir, `${OPTIONAL_CLASS}.java`), optionalAuthTestClass(model, { packages, controllers, opController, securityTypes }), 'utf8');
  classes.push(OPTIONAL_CLASS);
}

console.log(`read-scope-check · ${designName} (${anyRoot ? engine : 'sin base'}) · ${runtime.runtime} · casos ${cases.join(', ')}`);
const frontend = anyRoot ? composeUp(runtime.frontends, projectDir) : null;
if (anyRoot && !frontend) {
  console.error('No se pudo levantar la base de infra/.');
  process.exit(2);
}
let exitCode = 2;
try {
  let ready = !anyRoot;
  if (anyRoot) {
    const probe = databaseHealthProbe(engine, model.service.name.replaceAll('-', '_'));
    const deadline = Date.now() + probe.budgetSeconds * 1000;
    while (!ready && Date.now() < deadline) {
      ready = run(runtime.runtime, ['exec', `${service.manifest.service.name}-db`, ...probe.argv]).status === 0;
      if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, probe.intervalSeconds * 1000);
    }
  }
  if (!ready) {
    console.error('El motor no aceptó conexiones a tiempo.');
  } else {
    const gradle = run('sh', ['gradlew', 'test', '--tests', `*.${PACKAGE_LEAF}.*`, '--console=plain', '--no-daemon'], { cwd: projectDir });
    const results = classes.flatMap((className) => readResults(projectDir, className));
    if (results.length === 0) {
      console.error('La suite no llegó a ejecutarse. Salida de Gradle:');
      console.error((gradle.stdout + gradle.stderr).split('\n').slice(-60).join('\n'));
    } else {
      for (const item of results) console.log(`  ${item.ok ? 'OK  ' : 'KO  '} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
      const fell = [...new Set(results.filter((item) => !item.ok).map((item) => caseOf(item.name)))].sort();
      const missing = cases.filter((id) => !results.some((item) => caseOf(item.name) === id));
      if (missing.length > 0) console.log(`\n  sin prueba: ${missing.join(', ')}`);
      if (sabotage) {
        const want = [...expected].sort();
        const exact = fell.length === want.length && fell.every((id, at) => id === want[at]);
        console.log(`\n  cayeron ${fell.join(', ') || 'ninguno'}; tenían que caer ${want.join(', ')} → ${exact ? 'VERDE (el sabotaje se ve, y solo en sus casos)' : 'ROJO'}`);
        exitCode = exact && missing.length === 0 ? 0 : 1;
      } else {
        const failed = results.filter((item) => !item.ok).length;
        console.log(`\n  ${results.length - failed}/${results.length} en verde`);
        exitCode = failed > 0 || missing.length > 0 ? 1 : 0;
      }
    }
  }
} finally {
  if (keep) console.log(`\n  --keep: el proyecto queda en ${projectDir}${frontend ? ' y la base en pie' : ''}.`);
  else if (frontend) run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'down', '-v'], { cwd: projectDir });
}
process.exit(exitCode);
