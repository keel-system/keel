import { spawnSync } from 'node:child_process';

// El runtime de contenedores (podman o docker) detrás de una interfaz mínima: es lo único que el
// juez necesita del mundo, y entra por parámetro para que los criterios se prueben con un doble.

// Git Bash en Windows reescribe las rutas POSIX de los argumentos (`/coverage` → `C:/…`): con
// MSYS_NO_PATHCONV, `podman exec … /opt/x` llega tal cual (inc. 1).
const ENV = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };

export function exec(cmd, args, { input, timeoutMs = 600_000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: ENV, input, timeout: timeoutMs, maxBuffer: 256 << 20 });
  return { status: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error.message) : '') };
}

/** podman o docker, el primero instalado Y en marcha; null si ninguno. */
export function resolveRuntime() {
  for (const runtime of ['podman', 'docker']) {
    if (exec(runtime, ['--version']).status === 0 && exec(runtime, ['ps']).status === 0) return runtime;
  }
  return null;
}

/** Operaciones del runtime que usa verify. */
export function containerRuntime(runtime) {
  const rt = (args, opts) => exec(runtime, args, opts);
  return {
    name: runtime,
    compose: (file, project, args) => rt(['compose', '-f', file, '-p', project, ...args]),
    exec: (container, args, opts) => rt(['exec', ...(opts?.input !== undefined ? ['-i'] : []), container, ...args], opts),
    run: (args, opts) => rt(['run', '--rm', ...args], opts),
    stop: (container) => rt(['stop', '-t', '20', container]),
    start: (container) => rt(['start', container]),
    image: (container) => rt(['inspect', '--format', '{{.Config.Image}}', container]).stdout.trim(),
    networks: (container) => {
      const out = rt(['inspect', '--format', '{{json .NetworkSettings.Networks}}', container]).stdout.trim();
      try {
        return Object.keys(JSON.parse(out) ?? {}).sort();
      } catch {
        return [];
      }
    },
    running: (container) => rt(['inspect', '--format', '{{.State.Running}}', container]).stdout.trim() === 'true',
  };
}
