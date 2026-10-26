#!/usr/bin/env node
// target-db-check: la puerta de M5 (PLAN-KEEL-RECOVER-MYSQL.md). La paridad deja cada flujo sobre la base del
// REGENERADO vacía y con su estado de partida: `empty` y `loadScript` del adaptador de MySQL de keel-recover. Aquí se
// ejecutan contra un MySQL real (la versión de M0, por digest) con el esquema que crea de verdad cada generador y el
// `infra/fixtures.sql` que emite para la fixture `shop-api`:
//
//   keel-dotnet  el DDL del modelo de EF Core (`infra/export-schema.sh`: `dotnet ef dbcontext script`, sin base, tras
//                compilar la solución). SDK 10 y red para restaurar.
//   keel-spring  el DDL de las entidades JPA (`infra/export-schema.sh`: Hibernate con el perfil schema-export, que
//                arranca la app contra el MySQL de aquí y escribe el baseline sin tocarlo, con los índices parciales y
//                las FK entre agregados que añade el script). JDK y red para Gradle.
//
// Lo que se comprueba, por generador: la carga del fixtures.sql deja una fila por registro en cada tabla; el vaciado
// deja la base a 0 sin tocar el historial de migraciones; y la carga se repite tras el vaciado (la del flujo siguiente).
//
//   node packages/keel-recover/scripts/target-db-check.js [--generator=dotnet|spring] [--keep] [--sabotage=skip-table]
//   npm run target-db-check --workspace packages/keel-recover
//
// Sin --generator, los dos, uno detrás de otro (la memoria no da para los dos a la vez).
//
// --sabotage=skip-table: el vaciado se salta una tabla (su TRUNCATE no llega a la base). Tiene que salir rojo en el
// vaciado y en la recarga, y solo ahí.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService, loadFixtures } from 'keel-core';
import { containerRuntime, resolveRuntime } from '../src/lib/containers.js';
import { databaseAdapter } from '../src/lib/db/index.js';
import { mysql } from '../src/lib/db/mysql.js';
import { rows } from '../src/lib/db/relational.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { scaffoldService as scaffoldSpring } from '../../keel-spring/src/scaffold/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DESIGN = path.join(here, '..', '..', '..', 'fixtures', 'designs', 'shop-api');
const MYSQL_IMAGE = 'docker.io/library/mysql:8.0.26@sha256:882e55f40d61034a2bb8a1abab1353571ad2a33866f382350788eb34740528b5';
const CONTAINER = 'rec-target-db-check';
// keel-spring arranca su app en el host contra esta base: el puerto, publicado solo en local
const HOST_PORT = 33061;
const DATABASE = { tech: 'mysql', name: 'shop', auth: { user: 'shop', password: 'shop' } };

const keep = process.argv.includes('--keep');
const sabotage = process.argv.find((a) => a.startsWith('--sabotage='))?.split('=')[1] ?? null;
const only = process.argv.find((a) => a.startsWith('--generator='))?.split('=')[1] ?? null;
const SABOTAGES = ['skip-table'];
if (sabotage && !SABOTAGES.includes(sabotage)) {
  console.error(`--sabotage=${sabotage}: los que hay son ${SABOTAGES.join(', ')}`);
  process.exit(2);
}

const runtime = resolveRuntime();
if (!runtime) {
  console.error('target-db-check necesita podman o docker en marcha.');
  process.exit(2);
}
const rt = containerRuntime(runtime);
const db = databaseAdapter('mysql');

// La base, por el cliente de su contenedor (el mismo camino que la paridad).
const sql = (text) => mysql(rt, CONTAINER, DATABASE, text);
const count = (table) => Number(rows(sql(`select count(*) from \`${table}\`;`).out)[0]?.[0] ?? NaN);
const wait = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
const tail = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-1500);

/** El rt del adaptador, con el sabotaje: el vaciado pierde el TRUNCATE de `table`. */
function sabotaged(table) {
  return {
    ...rt,
    exec: (c, args, opts) => (opts?.input && /truncate table/.test(opts.input) ? rt.exec(c, args, { ...opts, input: opts.input.replace(`truncate table \`${table}\`;\n`, '') }) : rt.exec(c, args, opts)),
  };
}

/** Lo que el fixtures.sql inserta, por tabla. */
function insertsByTable(fixturesSql) {
  const out = {};
  for (const [, table] of fixturesSql.matchAll(/^INSERT INTO [`"]?([^`"\s(]+)[`"]? /gm)) out[table] = (out[table] ?? 0) + 1;
  return out;
}

function design() {
  const { manifest, layers } = loadService(DESIGN);
  const { doc: fixtures, errors } = loadFixtures(DESIGN);
  if (errors.length) throw new Error(errors.join('; '));
  return { manifest, layers, fixtures };
}

const GENERATORS = {
  dotnet: {
    label: 'keel-dotnet',
    history: { table: 'ef_migrations_history', ddl: '(migration_id varchar(150) primary key, product_version varchar(32) not null)', row: "('20261026000000_Baseline', '10.0.0')" },
    generate(work) {
      const { manifest, layers, fixtures } = design();
      const { files } = planDotnet({ manifest, layers, fixtures, workspace: path.dirname(DESIGN), stack: { database: 'mysql' } });
      for (const file of files) {
        const target = path.join(work, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content);
      }
      // dotnet ef lee los metadatos de la solución compilada: la compila antes, como el agente en su pase de calidad
      const built = spawnSync('dotnet', ['build', '-c', 'Debug'], { cwd: work, encoding: 'utf8', timeout: 900_000 });
      if (built.status !== 0) throw new Error(`dotnet build salió con ${built.status}: ${tail(built)}`);
      const exported = spawnSync('bash', ['infra/export-schema.sh'], { cwd: work, encoding: 'utf8', timeout: 900_000 });
      const ddl = path.join(work, 'build', 'schema', 'model.sql');
      if (exported.status !== 0 || !fs.existsSync(ddl)) throw new Error(`export-schema.sh salió con ${exported.status}: ${tail(exported)}`);
      // dotnet ef lo escribe con BOM, que el cliente de mysql no se salta
      return { project: work, ddl: fs.readFileSync(ddl, 'utf8').replace(/^﻿/, '') };
    },
  },
  spring: {
    label: 'keel-spring',
    history: { table: 'flyway_schema_history', ddl: '(installed_rank int primary key, version varchar(50), description varchar(200) not null)', row: "(1, '1', 'baseline schema')" },
    generate(work) {
      const { manifest, layers, fixtures } = design();
      scaffoldSpring({ manifest, layers, fixtures, workspace: work, force: true, stack: { database: 'mysql' } });
      const services = path.join(work, 'services');
      const project = path.join(services, fs.readdirSync(services)[0]);
      // La app del perfil local, contra la base de aquí: Spring lee SPRING_DATASOURCE_* por encima de parameters/local
      const env = {
        ...process.env,
        SPRING_DATASOURCE_URL: `jdbc:mysql://127.0.0.1:${HOST_PORT}/${DATABASE.name}`,
        SPRING_DATASOURCE_USERNAME: DATABASE.auth.user,
        SPRING_DATASOURCE_PASSWORD: DATABASE.auth.password,
        EXPORT_TIMEOUT: '600',
      };
      const exported = spawnSync('bash', ['infra/export-schema.sh'], { cwd: project, env, encoding: 'utf8', timeout: 900_000 });
      const ddl = path.join(project, 'build', 'schema', 'baseline.sql');
      if (exported.status !== 0 || !fs.existsSync(ddl)) {
        const log = path.join(project, 'build', 'schema', 'export.log');
        throw new Error(`export-schema.sh salió con ${exported.status}: ${tail(exported)}${fs.existsSync(log) ? `\n${fs.readFileSync(log, 'utf8').slice(-1500)}` : ''}`);
      }
      return { project, ddl: fs.readFileSync(ddl, 'utf8') };
    },
  },
};

function startMysql() {
  rt.remove(CONTAINER);
  const r = rt.run(['-d', '--name', CONTAINER, '-p', `127.0.0.1:${HOST_PORT}:3306`, '-e', 'MYSQL_ROOT_PASSWORD=root', '-e', `MYSQL_DATABASE=${DATABASE.name}`, '-e', `MYSQL_USER=${DATABASE.auth.user}`, '-e', `MYSQL_PASSWORD=${DATABASE.auth.password}`, MYSQL_IMAGE]);
  if (r.status !== 0) throw new Error(`no arrancó MySQL: ${r.stderr}`);
  // El entrypoint arranca un servidor temporal para crear la base y el usuario: listo es cuando el usuario entra
  // y el servidor definitivo escucha en TCP (el temporal solo atiende el socket).
  for (let i = 0; i < 90; i++) {
    if (sql('select 1;').ok && rt.exec(CONTAINER, ['mysqladmin', '-h', '127.0.0.1', '-uroot', '-proot', 'ping']).status === 0) return;
    wait(2000);
  }
  throw new Error('MySQL no quedó listo en 3 minutos');
}

/** Una pasada de un generador: `{ ok, red }` según lo esperado para el sabotaje. */
function check(key) {
  const generator = GENERATORS[key];
  const results = [];
  const step = (what, ok, detail = '') => {
    results.push({ what, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? `  (${detail})` : ''}`);
  };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'krtdb-'));
  console.log(`\n${generator.label}: shop-api con MySQL en ${work}${sabotage ? ` (sabotaje: ${sabotage})` : ''}`);
  try {
    startMysql();
    const { project, ddl } = generator.generate(work);
    const fixturesSql = fs.readFileSync(path.join(project, 'infra', 'fixtures.sql'), 'utf8');
    const expected = insertsByTable(fixturesSql);
    step('el generador emite el DDL y un fixtures.sql con registros', /CREATE TABLE/i.test(ddl) && Object.keys(expected).length > 0, Object.entries(expected).map(([t, n]) => `${t}=${n}`).join(' '));

    // La base del regenerado: su esquema y su historial de migraciones, como lo deja la primera migración.
    const { history } = generator;
    const schema = sql(`${ddl}\ncreate table \`${history.table}\` ${history.ddl};\ninsert into \`${history.table}\` values ${history.row};\n`);
    step(`el DDL de ${generator.label} carga en MySQL 8.0.26`, schema.ok, schema.ok ? '' : schema.error);

    const loaded = db.loadScript(rt, CONTAINER, DATABASE, fixturesSql);
    const counted = Object.fromEntries(Object.keys(expected).map((t) => [t, count(t)]));
    step('la carga deja una fila por registro en cada tabla', loaded.ok && Object.entries(expected).every(([t, n]) => counted[t] === n), loaded.ok ? JSON.stringify(counted) : loaded.error);

    const victim = Object.keys(expected).sort()[0];
    const emptied = db.empty(sabotage === 'skip-table' ? sabotaged(victim) : rt, CONTAINER, DATABASE);
    // sin la carga de antes, una base sin tablas también «queda a 0»
    step('el vaciado deja la base a 0', loaded.ok && emptied.ok && emptied.remaining === '0', emptied.ok ? `quedan ${emptied.remaining}` : emptied.error);
    step('y no toca el historial de migraciones', count(history.table) === 1);

    const again = db.loadScript(rt, CONTAINER, DATABASE, fixturesSql);
    step('la carga se repite tras el vaciado (el flujo siguiente)', again.ok && Object.entries(expected).every(([t, n]) => count(t) === n), again.ok ? '' : again.error.slice(0, 300));
  } catch (err) {
    step('la pasada llega al final', false, err.message);
  } finally {
    if (!keep) {
      rt.remove(CONTAINER);
      fs.rmSync(work, { recursive: true, force: true });
    } else console.log(`  (--keep: ${work} se queda; el contenedor ${CONTAINER} lo reemplaza la pasada siguiente)`);
  }
  const red = results.filter((r) => !r.ok).map((r) => r.what);
  const want = sabotage === 'skip-table' ? ['el vaciado deja la base a 0', 'la carga se repite tras el vaciado (el flujo siguiente)'] : [];
  const ok = JSON.stringify(red) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${generator.label}: ${sabotage ? `rojo en [${red.join('; ')}]` : `${results.length - red.length}/${results.length} comprobaciones`}`);
  return ok;
}

const keys = only ? [only] : Object.keys(GENERATORS);
if (keys.some((k) => !GENERATORS[k])) {
  console.error(`--generator=${only}: los que hay son ${Object.keys(GENERATORS).join(', ')}`);
  process.exit(2);
}
const outcomes = keys.map((key) => [key, check(key)]);
const failed = outcomes.filter(([, ok]) => !ok).map(([key]) => key);
console.log(`\n${failed.length ? `✗ en su color: ${outcomes.length - failed.length}/${outcomes.length} (fuera: ${failed.join(', ')})` : `✓ ${outcomes.length} generador(es) en su color`}`);
process.exit(failed.length ? 1 : 0);
