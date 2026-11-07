#!/usr/bin/env node
// El PASO DE ESQUEMA de build (keel-core/gen/schema-steps.js, inc. 2b del plan 2.26) contra un motor de verdad: que una
// base ya desplegada, cuya baseline no tiene las tablas del generador, ARRANQUE con Flyway y `ddl-auto: validate` —lo
// que hace `develop`— cuando build le añade el paso.
//
// Ninguna otra red lo ve. El SQL del paso lo ejecuta `timer-sql-check` de keel-core, pero ahí no hay Hibernate: lo que
// solo se mide aquí es que las columnas que crea el paso son las que VALIDA el mapeo JPA que emite keel-spring (un
// `varchar` donde Hibernate espera `text`, un `datetime` sin precisión, una clave primaria en otro orden). Y el defecto
// que esto cierra no falla en ninguna prueba: el proyecto compila, sus escenarios corren en `local` con `ddl-auto`, y el
// arranque cae en el primer despliegue.
//
// Cómo, en cuatro pasos y sin nada a mano:
//   1. genera la fixture y le pide a Hibernate el DDL de sus entidades (el perfil schema-export que usa
//      infra/export-schema.sh, desde un JUnit, sin arrancar la aplicación);
//   2. le QUITA las tablas del generador y lo deja como V1__baseline_schema.sql: es la base de un proyecto completado
//      antes de que esas tablas existieran;
//   3. `build --refresh`: build lee esa baseline y escribe el paso V2__keel_*.sql;
//   4. arranca el contexto JPA con Flyway y `validate` contra la base VACÍA, dos veces (la segunda es el redespliegue,
//      con el historial ya aplicado), y comprueba que las tablas del generador existen.
//
//   node packages/keel-spring/scripts/schema-step-check.js [fixture] [--database=postgresql|mysql] [--keep] [--sabotage=no-step]
//   npm run schema-step-check --workspace packages/keel-spring
//
// `--sabotage=no-step` borra el paso antes del paso 4, como si build no lo escribiera: verde es que el arranque caiga.
// Necesita podman o docker, y JDK.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { STEP_MARK } from '@keel-system/keel-core/gen/schema-steps';
import { tmpDir } from '../test/helpers/tmp.js';
import { scaffoldService } from '../src/scaffold/index.js';
import { databaseHealthProbe } from '../src/lib/stack-catalog.js';
import { generatorTables } from '../src/scaffold/migrations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'designs');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const fixture = args.find((arg) => !arg.startsWith('--')) ?? 'notification-mailer';
const database = args.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? 'postgresql';
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
if (sabotage && sabotage !== 'no-step') {
  console.error(`schema-step-check: sabotaje desconocido '${sabotage}' (conocido: no-step)`);
  process.exit(2);
}
if (!['postgresql', 'mysql'].includes(database)) {
  console.error(`schema-step-check: el paso del generador solo existe para postgresql y mysql, no para '${database}'`);
  process.exit(2);
}

const MIGRATIONS = 'src/main/resources/db/migration';
const EXPORT_TARGET = 'build/schema/baseline.sql';
const EXPORT_CLASS = 'SchemaStepExportCheckTest';
const BOOT_CLASS = 'SchemaStepBootCheckTest';

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function resolveRuntime() {
  for (const runtime of process.env.CONTAINER_RUNTIME ? [process.env.CONTAINER_RUNTIME] : ['docker', 'podman']) {
    if (run(runtime, ['--version']).status !== 0) continue;
    const frontends =
      runtime === 'podman'
        ? [{ command: 'podman', prefix: ['compose'] }, { command: 'podman-compose', prefix: [] }]
        : [{ command: 'docker', prefix: ['compose'] }];
    return { runtime, frontends };
  }
  return null;
}

function composeUp(frontends, projectDir) {
  for (const frontend of frontends) {
    if (run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'up', '-d', 'db'], { cwd: projectDir }).status === 0) {
      return frontend;
    }
  }
  return null;
}

function waitForDatabase(runtime, container, probe) {
  const deadline = Date.now() + probe.budgetSeconds * 1000;
  while (Date.now() < deadline) {
    if (run(runtime, ['exec', container, ...probe.argv]).status === 0) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, probe.intervalSeconds * 1000);
  }
  return false;
}

/** El paquete raíz del proyecto, leído de la clase de la aplicación: las sondas viven ahí. */
function rootPackage(projectDir) {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const app = walk(path.join(projectDir, 'src/main/java')).find((file) => fs.readFileSync(file, 'utf8').includes('@SpringBootApplication'));
  if (!app) throw new Error('no encuentro la clase @SpringBootApplication en el proyecto generado');
  return /^package\s+([\w.]+);/m.exec(fs.readFileSync(app, 'utf8'))[1];
}

function datasourceProperties(datasource) {
  return [
    `"spring.datasource.url=${datasource.url}"`,
    `"spring.datasource.username=${datasource.username}"`,
    `"spring.datasource.password=${datasource.password ?? ''}"`
  ];
}

const header = (what) => `/**
 * ${what}
 *
 * <p>Lo escribe scripts/schema-step-check.js: no es parte del proyecto generado y no se versiona con él.
 */`;

/** El paso 1: el DDL de las entidades, con el perfil schema-export que usa infra/export-schema.sh. */
function exportClass(pkg, datasource) {
  const properties = [
    ...datasourceProperties(datasource),
    '"spring.jpa.hibernate.ddl-auto=none"',
    '"spring.flyway.enabled=false"',
    '"spring.jpa.properties.jakarta.persistence.schema-generation.scripts.action=create"',
    `"spring.jpa.properties.jakarta.persistence.schema-generation.scripts.create-target=${EXPORT_TARGET}"`,
    '"spring.jpa.properties.hibernate.hbm2ddl.delimiter=;"'
  ];
  return `package ${pkg};

import org.junit.jupiter.api.Test;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;

${header('Exporta el DDL de las entidades JPA, sin tocar la base: Hibernate lo escribe al construir el EntityManagerFactory.')}
@DataJpaTest(properties = {
        ${properties.join(',\n        ')}
})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
class ${EXPORT_CLASS} {

    @Test
    void exportaElEsquema() {
    }
}
`;
}

/** El paso 4: Flyway aplica las migraciones y Hibernate valida, como en develop; y las tablas del generador están. */
function bootClass(pkg, tables, engine) {
  // El perfil `migrations` EMITIDO, sobre `local` como dice su README: lo que se mide es esa configuración, no una mía.
  const properties = ['"spring.profiles.active=local,migrations"'];
  const schema = engine === 'mysql' ? 'DATABASE()' : 'current_schema()';
  return `package ${pkg};

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;
import org.springframework.jdbc.core.JdbcTemplate;

${header('Arranca el contexto JPA con Flyway y ddl-auto: validate sobre la base desplegada que fabricó el check.')}
@DataJpaTest(properties = {
        ${properties.join(',\n        ')}
})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
class ${BOOT_CLASS} {

    @Autowired
    private JdbcTemplate jdbc;

    @Test
    void lasTablasDelGeneradorLlegaronPorElPaso() {
        Integer found = jdbc.queryForObject(
                "SELECT count(*) FROM information_schema.tables WHERE table_schema = ${schema} AND table_name IN (${tables.map((table) => `'${table}'`).join(', ')})",
                Integer.class);
        assertEquals(${tables.length}, found, "faltan tablas del generador en la base migrada");
    }
}
`;
}

/** El paso 2: la baseline sin las tablas del generador, sentencia a sentencia. */
function withoutGeneratorTables(ddl, tables) {
  const names = new Set(tables);
  const touches = (statement) => {
    const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?[`"]?(\w+)/i.exec(statement);
    const on = /(?:alter\s+table|\son)\s+(?:if\s+exists\s+)?[`"]?(\w+)/i.exec(statement);
    return names.has((create ?? on)?.[1]?.toLowerCase());
  };
  const statements = ddl.split(';').map((statement) => statement.trim()).filter(Boolean);
  const kept = statements.filter((statement) => !touches(statement));
  return { sql: kept.map((statement) => `${statement};`).join('\n') + '\n', removed: statements.length - kept.length };
}

function gradleTest(projectDir, className) {
  return run('sh', ['gradlew', 'test', '--tests', `*${className}`, '--rerun', '--console=plain', '--no-daemon'], { cwd: projectDir });
}

function junitOk(projectDir, className) {
  const dir = path.join(projectDir, 'build/test-results/test');
  const file = fs.existsSync(dir) ? fs.readdirSync(dir).find((name) => name.includes(className) && name.endsWith('.xml')) : null;
  if (!file) return { ok: false, detail: 'sin resultado de JUnit: no compiló o el contexto no arrancó' };
  const xml = fs.readFileSync(path.join(dir, file), 'utf8');
  const failure = /<(failure|error)[^>]*message="([^"]*)"/.exec(xml);
  if (!failure) return { ok: true, detail: '' };
  // El mensaje de arriba es «Failed to load ApplicationContext»: lo que dice QUÉ falló es la causa más honda.
  const causes = [...xml.matchAll(/Caused by: ([^\n]+)/g)].map((match) => match[1]);
  const cause = causes.at(-1) ?? failure[2];
  return { ok: false, detail: cause.replaceAll('&quot;', '"').replaceAll('&#10;', ' ').replaceAll('&lt;', '<').replaceAll('&gt;', '>').slice(0, 400) };
}

function step(id, ok, detail = '') {
  results.push({ id, ok });
  console.log(`  ${ok ? 'OK  ' : 'KO  '} ${id}${detail ? ` — ${detail}` : ''}`);
}

// ─── Entrada ─────────────────────────────────────────────────────────────────

const runtimeInfo = resolveRuntime();
if (!runtimeInfo) {
  console.error('No hay docker ni podman en el PATH.');
  process.exit(2);
}
if (run('java', ['-version']).status !== 0) {
  console.error('No hay JDK en el PATH: el check compila el proyecto con Gradle.');
  process.exit(2);
}

const service = loadService(path.join(fixturesDir, fixture));
if (service.errors.length > 0) {
  console.error(`la fixture '${fixture}' no carga: ${service.errors.join(' | ')}`);
  process.exit(2);
}
const stack = { database };
const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-schema-step-keep-')) : tmpDir('keel-schema-step-check-');
const first = scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack });
const projectDir = path.join(workspace, first.outDir);
const tables = generatorTables(
  fs.readdirSync(path.join(projectDir, 'src/main/java'), { recursive: true })
    .filter((name) => String(name).endsWith('.java'))
    .map((name) => ({ content: fs.readFileSync(path.join(projectDir, 'src/main/java', String(name)), 'utf8') }))
).map((table) => table.table);
if (tables.length === 0) {
  console.error(`la fixture '${fixture}' no emite ninguna tabla del generador: no hay paso que medir`);
  process.exit(2);
}
const datasource = YAML.parse(fs.readFileSync(path.join(projectDir, 'src/main/resources/parameters/local/db.yaml'), 'utf8'))?.spring?.datasource ?? {};
const pkg = rootPackage(projectDir);
const testDir = path.join(projectDir, 'src/test/java', ...pkg.split('.'));
const probe = databaseHealthProbe(database, service.manifest.service.name.replaceAll('-', '_'));

console.log(`schema-step-check · ${fixture} (${database}) · ${runtimeInfo.runtime}${sabotage ? ` · SABOTAJE ${sabotage}` : ''}`);
console.log(`  tablas del generador: ${tables.join(', ')}`);

const results = [];
const frontend = composeUp(runtimeInfo.frontends, projectDir);
if (!frontend) {
  console.error('No se pudo levantar la base de infra/.');
  process.exit(2);
}
let exitCode = 2;
try {
  if (!waitForDatabase(runtimeInfo.runtime, `${service.manifest.service.name}-db`, probe)) throw new Error('el motor no aceptó conexiones a tiempo');

  // 1. El DDL de las entidades.
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, `${EXPORT_CLASS}.java`), exportClass(pkg, datasource));
  const exported = gradleTest(projectDir, EXPORT_CLASS);
  const exportFile = path.join(projectDir, EXPORT_TARGET);
  if (!fs.existsSync(exportFile)) throw new Error(`Hibernate no exportó el esquema:\n${(exported.stdout + exported.stderr).split('\n').slice(-30).join('\n')}`);
  fs.rmSync(path.join(testDir, `${EXPORT_CLASS}.java`));

  // 2. La base desplegada: la baseline sin las tablas del generador.
  const baseline = withoutGeneratorTables(fs.readFileSync(exportFile, 'utf8'), tables);
  step('baseline sin las tablas del generador', baseline.removed >= tables.length, `${baseline.removed} sentencia(s) fuera`);
  fs.writeFileSync(path.join(projectDir, MIGRATIONS, 'V1__baseline_schema.sql'), baseline.sql);

  // 3. build --refresh escribe el paso.
  const refreshed = scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, stack, mode: 'refresh' });
  const stepPath = refreshed.schema.added[0];
  const stepOk = Boolean(stepPath) && fs.readFileSync(path.join(projectDir, stepPath), 'utf8').includes(STEP_MARK);
  step('build escribe el paso', stepOk, stepPath ?? 'ninguno');
  if (sabotage === 'no-step' && stepPath) fs.rmSync(path.join(projectDir, stepPath));

  // 4. Arranque con Flyway y validate, y redespliegue.
  fs.writeFileSync(path.join(testDir, `${BOOT_CLASS}.java`), bootClass(pkg, tables, database));
  for (const label of ['arranque con Flyway y validate', 'redespliegue (historial ya aplicado)']) {
    gradleTest(projectDir, BOOT_CLASS);
    const verdict = junitOk(projectDir, BOOT_CLASS);
    step(label, verdict.ok, verdict.detail);
  }

  const failed = results.filter((item) => !item.ok).map((item) => item.id);
  if (sabotage === 'no-step') {
    const expected = ['arranque con Flyway y validate', 'redespliegue (historial ya aplicado)'];
    const caught = failed.length === expected.length && expected.every((id) => failed.includes(id));
    console.log(caught ? '\n  Verde: sin el paso, el arranque cae (y solo eso).' : `\n  ROJO: el sabotaje no cayó donde debía (${failed.join(', ') || 'nada en rojo'}).`);
    exitCode = caught ? 0 : 1;
  } else {
    console.log(`\n  ${results.length - failed.length}/${results.length} en verde`);
    exitCode = failed.length > 0 ? 1 : 0;
  }
} catch (error) {
  console.error(`  ${error.message}`);
} finally {
  if (keep) console.log(`\n  --keep: el proyecto queda en ${projectDir} y la base en pie.`);
  else run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'down', '-v'], { cwd: projectDir });
}
process.exit(exitCode);
