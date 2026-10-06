// Configuración multi-ambiente del servicio generado.
//
// La MISMA que keel-spring, que es lo que hace que los dos servidores del mismo diseño se
// desplieguen igual: el perfil activo sale de `PROFILE` (default `local`, y admite varios
// separados por coma), el puerto de `SERVER_PORT` (8080), el margen del apagado ordenado de
// `SHUTDOWN_TIMEOUT` (30s), y cada valor sigue el gradiente literal (local) → `${VAR:default}`
// (develop) → `${VAR}` sin default (production). Un `${VAR}` sin valor no deja arrancar: un
// default silencioso en producción es un valor que nadie eligió.
//
// Forma en disco: `config/application.yaml` (lo común) + `config/parameters/<perfil>/*.yaml`
// (los fragmentos de cada perfil, que llegan con las capas que los necesitan).

const CONFIG_TS = 'src/infrastructure/config/configuration.ts';

export function generate(model) {
  return [
    { path: 'config/application.yaml', content: baseYaml(model) },
    { path: CONFIG_TS, content: configurationTs() }
  ];
}

function baseYaml(model) {
  return `# Configuración común a todos los perfiles. Los valores de cada perfil van en
# config/parameters/<perfil>/*.yaml. Placeholders: \${VAR} obligatoria, \${VAR:default} opcional.
application:
  name: ${model.service.name}
server:
  # Puerto por variable de entorno; 8080 es el que asumen los escenarios de validación.
  port: \${SERVER_PORT:8080}
  # Apagado ordenado: al recibir SIGTERM deja de aceptar conexiones, /readyz pasa a
  # OUT_OF_SERVICE y espera como máximo este margen a que terminen las peticiones en vuelo.
  shutdown-timeout: \${SHUTDOWN_TIMEOUT:30s}
`;
}

function configurationTs() {
  return `// Carga la configuración del perfil activo y la valida ANTES de crear la aplicación.
//
// Sigue la misma convención que el servidor de keel-spring del mismo diseño: perfil por
// \`PROFILE\` (default \`local\`, varios separados por coma), \`config/application.yaml\` más los
// fragmentos de \`config/parameters/<perfil>/\`, y placeholders \`\${VAR}\` (obligatoria) y
// \`\${VAR:default}\`. Una variable obligatoria sin valor no deja arrancar: se listan TODAS las que
// faltan, no la primera.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/** Token de inyección de la configuración ya resuelta. */
export const CONFIGURATION = Symbol('CONFIGURATION');

export interface Configuration {
  readonly profiles: readonly string[];
  readonly application: { readonly name: string };
  readonly server: { readonly port: number; readonly shutdownTimeoutMs: number };
  /** Cualquier valor por su ruta con puntos (\`server.port\`), ya resuelto. */
  get(path: string): unknown;
}

type Tree = Record<string, unknown>;

const PLACEHOLDER = /\\$\\{([A-Za-z0-9_]+)(?::([^}]*))?\\}/g;

export function loadConfiguration(env: NodeJS.ProcessEnv = process.env, root: string = process.cwd()): Configuration {
  const profiles = (env.PROFILE ?? 'local')
    .split(',')
    .map((profile) => profile.trim())
    .filter(Boolean);
  const configDir = join(root, 'config');

  let tree: Tree = readYaml(join(configDir, 'application.yaml'));
  for (const profile of profiles) {
    const dir = join(configDir, 'parameters', profile);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.yaml')).sort()) {
      tree = merge(tree, readYaml(join(dir, file)));
    }
  }

  const missing: string[] = [];
  const resolved = resolve(tree, env, '', missing) as Tree;
  if (missing.length > 0) {
    throw new Error(
      \`Configuración incompleta para el perfil \${profiles.join(',')}: faltan \${missing.length} variable(s) de entorno — \${missing.join('; ')}\`
    );
  }

  const get = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Tree)[key] : undefined), resolved);

  return {
    profiles,
    application: { name: String(get('application.name')) },
    server: {
      port: toPort(get('server.port')),
      shutdownTimeoutMs: toMillis(get('server.shutdown-timeout'))
    },
    get
  };
}

function readYaml(file: string): Tree {
  if (!existsSync(file)) return {};
  return (parse(readFileSync(file, 'utf8')) as Tree | null) ?? {};
}

function merge(base: Tree, override: Tree): Tree {
  const out: Tree = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] =
      isTree(current) && isTree(value) ? merge(current, value) : value;
  }
  return out;
}

function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolve(node: unknown, env: NodeJS.ProcessEnv, path: string, missing: string[]): unknown {
  if (typeof node === 'string') return resolveString(node, env, path, missing);
  if (Array.isArray(node)) return node.map((item, index) => resolve(item, env, \`\${path}[\${index}]\`, missing));
  if (isTree(node)) {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, resolve(value, env, path ? \`\${path}.\${key}\` : key, missing)])
    );
  }
  return node;
}

function resolveString(value: string, env: NodeJS.ProcessEnv, path: string, missing: string[]): string {
  return value.replace(PLACEHOLDER, (_match, name: string, fallback: string | undefined) => {
    const fromEnv = env[name];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    if (fallback !== undefined) return fallback;
    missing.push(\`\${name} (\${path})\`);
    return '';
  });
}

function toPort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(\`server.port inválido: '\${String(value)}'\`);
  return port;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** \`30s\`, \`500ms\`, \`2m\`, \`1h\`; un número a secas son milisegundos. */
export function toMillis(value: unknown): number {
  const text = String(value).trim();
  const match = /^(\\d+)(ms|s|m|h)?$/.exec(text);
  if (!match) throw new Error(\`Duración inválida: '\${text}' (usa 500ms, 30s, 2m o 1h)\`);
  return Number(match[1]) * UNITS[match[2] ?? 'ms']!;
}
`;
}
