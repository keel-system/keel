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
  # Todas las interfaces, como el servidor de Spring (también SERVER_ADDRESS): Fastify escucha
  # por defecto solo en 127.0.0.1 y dentro de un contenedor nadie llegaría.
  address: \${SERVER_ADDRESS:0.0.0.0}
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
  readonly server: { readonly port: number; readonly address: string; readonly shutdownTimeoutMs: number };
  /** Cualquier valor por su ruta con puntos (\`server.port\`), ya resuelto. */
  get(path: string): unknown;
}

type Tree = Record<string, unknown>;

const VARIABLE_NAME = /^[A-Za-z0-9_]+$/;

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
      address: String(get('server.address') ?? '0.0.0.0'),
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

/**
 * Sustituye los placeholders de un valor. El default puede llevar otro placeholder
 * (\`\${SERVICE_INSTANCE_ID:\${HOSTNAME:unknown}}\`), como en keel-spring; lo que llega de una variable de
 * entorno se usa tal cual, sin volver a resolverlo.
 */
function resolveString(value: string, env: NodeJS.ProcessEnv, path: string, missing: string[]): string {
  let out = '';
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf('\${', index);
    const end = start < 0 ? -1 : closingBrace(value, start + 2);
    if (start < 0 || end < 0) return out + value.slice(index);
    out += value.slice(index, start);
    const inner = value.slice(start + 2, end);
    const colon = inner.indexOf(':');
    const name = colon < 0 ? inner : inner.slice(0, colon);
    index = end + 1;
    if (!VARIABLE_NAME.test(name)) {
      out += value.slice(start, end + 1);
      continue;
    }
    const fromEnv = env[name];
    if (fromEnv !== undefined && fromEnv !== '') out += fromEnv;
    else if (colon >= 0) out += resolveString(inner.slice(colon + 1), env, path, missing);
    else missing.push(\`\${name} (\${path})\`);
  }
  return out;
}

/** La llave que cierra el placeholder que empieza en \`from\`, saltando los anidados. */
function closingBrace(text: string, from: number): number {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    if (text.startsWith('\${', index)) {
      depth += 1;
      index += 1;
    } else if (text[index] === '}') {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
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
