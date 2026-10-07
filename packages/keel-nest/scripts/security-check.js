#!/usr/bin/env node
// Ejercita la SEGURIDAD que emite keel-nest contra un Keycloak real (incremento 8).
//
// Por qué no está en `npm test`: necesita red (npm instala el proyecto), podman o docker, y tarda
// minutos. La suite del paquete ejecuta las reglas y el autenticador con tokens firmados en memoria, y la
// prueba emitida de la API (`ts-check`) los cruza con el servidor arrancado bajo el perfil test; esto es
// lo único que dice que la cadena entera funciona con el proveedor de verdad: que `init-keycloak.sh`
// siembra el realm (y es idempotente), que el servidor resuelve las claves por el discovery del
// `issuer-uri`, que las authorities salen de los claims de Keycloak y de los `roleGrants`, que la
// identidad del llamante llega al handler desde el token y nunca desde el cuerpo, y que el arnés pide
// los tokens que los flujos van a usar — incluidas las personas de `tokenAs`.
//
//   node packages/keel-nest/scripts/security-check.js [--keep]
//   npm run security-check --workspace packages/keel-nest
//
// El diseño es `profile-directory` (identidad por el claim `sub`, permiso otorgado por un rol). Sus
// handlers son TODOs: aquí se sustituyen por uno que responde CARD_NOT_FOUND nombrando al llamante que
// recibió, que es lo que hace observable la identidad sin escribir la lógica del servicio. Al final se
// falsa: con la regla de la ruta rebajada a «autenticado», la sonda del 403 sale en rojo.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWorkspace, mountDesign, runCommand } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { resolveRuntime } from './lib/database-container.js';
import { loadService } from 'keel-core';
import { resolveStack, writeStackConfig } from 'keel-core/gen/stack';

const DESIGN = 'profile-directory';
const keep = process.argv.includes('--keep');
const isWindows = process.platform === 'win32';
const results = [];

function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function bashExecutable() {
  if (process.env.BASH_EXECUTABLE) return process.env.BASH_EXECUTABLE;
  if (isWindows) {
    for (const candidate of [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
    ]) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
  }
  return 'bash';
}

const runtime = resolveRuntime();
if (!runtime) {
  console.error('security-check necesita podman o docker en marcha.');
  process.exit(2);
}
const env = { ...process.env, CONTAINER_RUNTIME: runtime };

function bash(projectDir, script, args = []) {
  const result = spawnSync(bashExecutable(), [script, ...args], { cwd: projectDir, encoding: 'utf8', env });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function npm(projectDir, args) {
  const result = spawnSync('npm', args, { cwd: projectDir, encoding: 'utf8', shell: isWindows, env });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const workspace = makeWorkspace('keel-nest-security-check-');
const specDir = mountDesign(workspace, DESIGN);
const projectDir = path.join(workspace, 'services', `${DESIGN}-nest`);
fs.mkdirSync(projectDir, { recursive: true });
writeStackConfig(projectDir, resolveStack({ database: 'postgresql', auth: 'keycloak' }, loadService(specDir).layers));
const generated = await runCommand(workspace, build, `specs/${DESIGN}`, { defaults: true, acceptUnready: true });
if (!step('build genera el proyecto', generated.exitCode === undefined && fs.existsSync(path.join(projectDir, 'package.json')), generated.exitCode ? generated.output : '')) {
  process.exit(1);
}
const install = npm(projectDir, ['install', '--no-audit', '--no-fund']);
if (!step('npm install', install.ok)) {
  console.error(install.output);
  process.exit(1);
}

// Los handlers: responden CARD_NOT_FOUND nombrando al llamante que recibieron en el mensaje.
for (const [file, message] of [
  ['get-my-card-query-handler.ts', 'sin ficha para ${query.callerSubject}'],
  ['save-my-card-command-handler.ts', 'guardaría para ${command.callerSubject}']
]) {
  const handler = path.join(projectDir, 'src', 'application', 'usecases', file);
  const source = fs.readFileSync(handler, 'utf8');
  fs.writeFileSync(
    handler,
    `import { CardNotFoundError } from '../../domain/errors/card-not-found-error.js';\n${source.replace(/throw new Error\('TODO: \w+'\);/, `throw new CardNotFoundError(\`${message}\`);`)}`
  );
}
const typecheck = npm(projectDir, ['run', 'typecheck']);
step('el proyecto con los handlers sonda compila con strict', typecheck.ok, typecheck.ok ? '' : typecheck.output.slice(-1500));

const flowsDir = path.join(projectDir, 'test', 'integration');
fs.writeFileSync(
  path.join(flowsDir, 'probe-security.test.ts'),
  `import { ROUTE_BASE, bearer, tokenAs, tokenFor, useFlow } from './support/flow.js';

const sub = (token: string): string => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')).sub;

describe('FL-SEC-001 · la seguridad contra Keycloak', () => {
  const flow = useFlow();

  it('FL-SEC-001-A: sin credencial, la operación es 401 UNAUTHENTICATED', async () => {
    const response = await flow.get(\`\${ROUTE_BASE}/me/card\`);
    expect(response.status, response.body).toBe(401);
    expect(response.json()).toMatchObject({ status: 401, error: 'Unauthorized', code: 'UNAUTHENTICATED' });
  });

  it('FL-SEC-001-B: un token que no valida es 401 también en una ruta abierta', async () => {
    const response = await flow.get('/livez', { Authorization: 'Bearer no.es-un.token' });
    expect(response.status, response.body).toBe(401);
  });

  it('FL-SEC-001-C: autenticado sin el permiso de la regla es 403 ACCESS_DENIED', async () => {
    const response = await flow.get(\`\${ROUTE_BASE}/me/card\`, bearer(await tokenFor('no-role')));
    expect(response.status, response.body).toBe(403);
    expect(response.json()).toMatchObject({ status: 403, error: 'Forbidden', code: 'ACCESS_DENIED' });
  });

  it('FL-SEC-001-D: con el rol que otorga el permiso, llega al handler con el sub del token', async () => {
    const token = await tokenFor('card-holder');
    const response = await flow.get(\`\${ROUTE_BASE}/me/card\`, bearer(token));
    expect(response.status, response.body).toBe(404);
    expect(response.json()).toMatchObject({ code: 'CARD_NOT_FOUND', message: \`sin ficha para \${sub(token)}\` });
  });

  it('FL-SEC-001-E: la persona de tokenAs llega con el sub que eligió el escenario', async () => {
    const response = await flow.get(\`\${ROUTE_BASE}/me/card\`, bearer(await tokenAs('sub-ana-001', { email: 'ana@example.test' }, 'card-holder')));
    expect(response.status, response.body).toBe(404);
    expect(response.json().message).toBe('sin ficha para sub-ana-001');
  });

  it('FL-SEC-001-F: tokenAs cambia los claims de la misma persona entre peticiones', async () => {
    const withEmail = await tokenAs('sub-ana-001', { email: 'ana@example.test' }, 'card-holder');
    const without = await tokenAs('sub-ana-001', { email: null }, 'card-holder');
    const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    expect(claims(withEmail).email).toBe('ana@example.test');
    expect(claims(without).email).toBeUndefined();
    expect(sub(without)).toBe('sub-ana-001');
  });

  it('FL-SEC-001-G: la identidad no se acepta del cuerpo', async () => {
    const token = await tokenFor('card-holder');
    const response = await flow.put(\`\${ROUTE_BASE}/me/card\`, { callerSubject: 'intruso', displayName: 'X' }, bearer(token));
    expect(response.status, response.body).toBe(404);
    expect(response.json().message).toBe(\`guardaría para \${sub(token)}\`);
  });

  it('FL-SEC-001-H: un camino que no existe es 401 sin credencial y 404 con ella', async () => {
    expect((await flow.get(\`\${ROUTE_BASE}/no-existe\`)).status).toBe(401);
    expect((await flow.get(\`\${ROUTE_BASE}/no-existe\`, bearer(await tokenFor('card-holder')))).status).toBe(404);
  });

  it('FL-SEC-001-I: un token de otro emisor (otro host del mismo Keycloak) es 401', async () => {
    const response = await fetch('http://127.0.0.1:8180/realms/${DESIGN}/protocol/openid-connect/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: '${DESIGN}-nest-test', username: 'card-holder', password: 'password' })
    });
    const foreign = ((await response.json()) as { access_token: string }).access_token;
    const call = await flow.get(\`\${ROUTE_BASE}/me/card\`, bearer(foreign));
    expect(call.status, call.body).toBe(401);
  });
});
`
);

const up = bash(projectDir, 'infra/up.sh');
if (!step('bash infra/up.sh (PostgreSQL y Keycloak)', up.status === 0, up.status === 0 ? '' : up.output.slice(-1200))) process.exit(1);
try {
  const seed = bash(projectDir, 'infra/init-keycloak.sh');
  step('bash infra/init-keycloak.sh siembra el realm', seed.status === 0 && /Realm 'profile-directory' listo/.test(seed.output), seed.status === 0 ? '' : seed.output.slice(-1500));
  const again = bash(projectDir, 'infra/init-keycloak.sh');
  step('y es idempotente: la segunda pasada también sale con 0', again.status === 0, again.status === 0 ? '' : again.output.slice(-800));
  const validate = bash(projectDir, 'infra/validate-infra.sh');
  step('bash infra/validate-infra.sh', validate.status === 0, validate.status === 0 ? '' : validate.output.slice(-1200));

  const scored = bash(projectDir, 'infra/score-scenarios.sh');
  const lines = scored.output;
  for (const id of 'ABCDEFGHI') {
    const ok = new RegExp(`OK\\s+FL-SEC-001-${id}`).test(lines);
    step(`score: FL-SEC-001-${id}`, ok, ok ? '' : (lines.match(new RegExp(`.*FL-SEC-001-${id}.*`))?.[0] ?? 'sin fila'));
  }
  step('score: el humo del arnés (con SMOKE-5, las credenciales) y la suite, en verde: sale con 0', scored.status === 0, scored.status === 0 ? '' : lines.slice(-2500));

  // Falsado: con la regla de GET /me/card rebajada a «autenticado», el usuario sin el permiso pasa.
  const rulesFile = path.join(projectDir, 'src', 'infrastructure', 'security', 'access-rules.ts');
  const rules = fs.readFileSync(rulesFile, 'utf8');
  const weakened = rules.replace(
    /(\{ method: 'GET', path: '\/api\/v1\/me\/card', requirement: )\{ kind: 'anyOf', authorities: \['card:self'\] \}/,
    "$1{ kind: 'authenticated' }"
  );
  if (step('falsado: la regla de GET /me/card se puede rebajar en las reglas emitidas', weakened !== rules)) {
    fs.writeFileSync(rulesFile, weakened);
    const sabotaged = bash(projectDir, 'infra/score-scenarios.sh');
    step(
      'falsado: con la regla rebajada, FL-SEC-001-C sale FALLO y el script con 1',
      sabotaged.status === 1 && /FALLO\s+FL-SEC-001-C/.test(sabotaged.output),
      `código ${sabotaged.status}`
    );
    fs.writeFileSync(rulesFile, rules);
  }
} finally {
  const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
  step('bash infra/down.sh --volumes', down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
}

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-nest-security-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\nsecurity-check: ${results.length}/${results.length} en verde.` : `\nsecurity-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
