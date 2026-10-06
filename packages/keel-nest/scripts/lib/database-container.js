// Un motor de base de datos en contenedor para los checks en vivo de keel-nest (db-check, y el
// arranque de ts-check, que con persistencia necesita una base). La imagen, el puerto interno y la
// contraseña salen del catálogo neutral (keel-core/gen/infra-catalog): el mismo motor que levanta el
// docker-compose de keel-spring.

import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { DATABASES } from 'keel-core/gen/infra-catalog';

export const DB_NAME = 'keel_db_check';

export function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', shell: process.platform === 'win32' && command === 'npm', ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** podman o docker, el primero que esté instalado Y en marcha; null si ninguno. */
export function resolveRuntime() {
  for (const runtime of ['podman', 'docker']) {
    if (run(runtime, ['--version']).status === 0 && run(runtime, ['ps']).status === 0) return runtime;
  }
  return null;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Arranca el motor en un puerto libre y espera a que acepte conexiones. Devuelve su nombre de
 * contenedor, su puerto y la URL JDBC con la que lo leen los servidores generados.
 */
export async function startDatabase(runtime, engine) {
  const db = DATABASES[engine];
  const port = await freePort();
  const name = `keel-nest-db-${engine}-${process.pid}-${port}`;
  const env =
    engine === 'postgresql'
      ? ['-e', `POSTGRES_DB=${DB_NAME}`, '-e', `POSTGRES_USER=${DB_NAME}`, '-e', `POSTGRES_PASSWORD=${db.password}`]
      : ['-e', `MYSQL_DATABASE=${DB_NAME}`, '-e', `MYSQL_USER=${DB_NAME}`, '-e', `MYSQL_PASSWORD=${db.password}`, '-e', `MYSQL_ROOT_PASSWORD=${db.password}`];
  const started = run(runtime, ['run', '-d', '--rm', '--name', name, '-p', `${port}:${db.port}`, ...env, db.image]);
  if (started.status !== 0) throw new Error(`no arrancó ${db.image}: ${started.stderr}`);
  const probe =
    engine === 'postgresql'
      ? ['exec', name, 'pg_isready', '-U', DB_NAME, '-d', DB_NAME]
      : ['exec', name, 'mysql', '-u', DB_NAME, `-p${db.password}`, '-e', 'SELECT 1', DB_NAME];
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    if (run(runtime, probe).status === 0) {
      // pg_isready responde antes de que el servidor definitivo acepte conexiones tras el init.
      await sleep(engine === 'postgresql' ? 1500 : 500);
      return { name, port, password: db.password, url: `jdbc:${engine}://127.0.0.1:${port}/${DB_NAME}`, user: DB_NAME };
    }
    await sleep(1000);
  }
  run(runtime, ['rm', '-f', name]);
  throw new Error(`${engine} no estuvo listo en 180 s`);
}

export function stopDatabase(runtime, database) {
  if (database) run(runtime, ['rm', '-f', database.name]);
}
