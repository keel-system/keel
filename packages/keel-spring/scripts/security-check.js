#!/usr/bin/env node
// La SEGURIDAD que emite keel-spring de extremo a extremo, contra el proveedor de identidad de prueba REAL de cada stack
// (incremento 4.4 de PLAN-PROVEEDOR-IDENTIDAD.md): Keycloak con el realm que siembra `init-keycloak.sh`, o el emulador de
// Cognito con la configuración que emite build.
//
// Por qué existe: la prueba emitida del contrato del token (`token-check`, casos IDT-*) firma sus tokens con la clave del
// perfil `test`, y la del arnés (`emulator-harness-check`) sustituye el transporte. Nada de eso dice que la cadena entera
// funcione con el proveedor: que el servidor resuelva las claves por el discovery del `issuer-uri`, que acepte el emisor y
// solo ese, que las authorities salgan de los claims que el proveedor pone de verdad, y que el arnés pida los tokens —las
// personas de `tokenAs` incluidas— que el proveedor da. Los otros tres generadores lo miden contra Keycloak con su
// `security-check`; lo que cambia entre proveedores son los claims, y eso lo mide la prueba emitida en los cuatro.
//
//   node packages/keel-spring/scripts/security-check.js [--auth=keycloak|cognito] [--keep]
//   npm run security-check --workspace packages/keel-spring
//
// Sin --auth, los dos proveedores, uno detrás de otro. Necesita JDK, red (Gradle) y podman o docker; minutos.
//
// El diseño es `profile-directory` (identidad por el claim `sub`, permiso otorgado por un rol). Sus handlers son TODOs:
// aquí se sustituyen por uno que responde CARD_NOT_FOUND nombrando al llamante que recibió, que es lo que hace observable
// la identidad sin escribir la lógica del servicio. Al final se falsa, en cada proveedor: con la regla de la ruta rebajada
// a «autenticado», solo FL-SEC-001-C y -F (la persona sin rol) salen en rojo; y con un proveedor que distingue el tipo de token (Cognito,
// `token_use`), sin esa comprobación, solo FL-SEC-001-J.
//
// El ID token de FL-SEC-001-J NO es el `id_token` del emulador: mock-oauth2-server aplica los claims del mapping a los
// dos tokens (medido con la 6.0.1), así que su `id_token` dice `token_use: access` y escondería D1. La red añade a su
// copia de la configuración un mapping propio, con la forma del ID token de Cognito, y comprueba que el token lo lleve.
//
// Códigos de salida: 0 todo verde · 1 algún paso en rojo · 2 el entorno no permite correrlo.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from '@keel-system/keel-core';
import { tokenContract, emulatedSubject } from '@keel-system/keel-core/gen/identity-providers';
import { scaffoldService } from '../src/scaffold/index.js';
import { tmpDir } from '../test/helpers/tmp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DESIGN = 'profile-directory';
const PACKAGE = 'com/identity/profiledirectory';
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const only = args.find((arg) => arg.startsWith('--auth='))?.slice('--auth='.length);
const PROVIDERS = only ? [only] : ['keycloak', 'cognito'];
const isWindows = process.platform === 'win32';
const results = [];

if (PROVIDERS.some((auth) => !['keycloak', 'cognito'].includes(auth))) {
  console.error(`--auth admite keycloak o cognito, no '${only}'.`);
  process.exit(2);
}

function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
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

function containerRuntime() {
  for (const candidate of ['podman', 'docker']) {
    if (spawnSync(candidate, ['info'], { encoding: 'utf8', shell: isWindows }).status === 0) return candidate;
  }
  return null;
}

const runtime = containerRuntime();
if (!runtime) {
  console.error('security-check necesita podman o docker en marcha.');
  process.exit(2);
}
if (spawnSync('java', ['-version']).status !== 0) {
  console.error('security-check necesita un JDK en el PATH.');
  process.exit(2);
}
const env = { ...process.env, CONTAINER_RUNTIME: runtime };

function bash(projectDir, script, scriptArgs = []) {
  const result = spawnSync(bashExecutable(), [script, ...scriptArgs], { cwd: projectDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function readEnvFile(file) {
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()])
  );
}

const javaString = (value) => JSON.stringify(value);

// El ID token con la forma del de Cognito: los claims del usuario fijo, con `token_use: id` y el cliente en `aud`.
const ID_TOKEN_PROBE = { param: 'keel_probe', match: 'id-token' };

function probeClass({ credentials, foreignTokenUrl, idToken }) {
  const form = `grant_type=password&client_id=${credentials.AUTH_TEST_CLIENT}&username=card-holder&password=${credentials.AUTH_TEST_PASSWORD}`;
  const idTokenCase = idToken
    ? `
    @Test
    @DisplayName("FL-SEC-001-J: un ID token del mismo emisor, con el rol que otorga el permiso, es 401")
    void idTokenIsRejected() throws Exception {
        String token = rawToken(${javaString(credentials.AUTH_TOKEN_URL)}, ${javaString(`${form}&${ID_TOKEN_PROBE.param}=${ID_TOKEN_PROBE.match}`)});
        Assertions.assertTrue(claims(token).contains("\\"${idToken.claim}\\":\\"${idToken.rejected}\\""), "La sonda no recibió un ID token: " + claims(token));
        Response response = get("/api/v1/me/card", token);
        Assertions.assertEquals(401, response.status(), response.body());
    }
`
    : '';
  return `package com.identity.profiledirectory.flows;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

@DisplayName("FL-SEC-001 · la seguridad contra el proveedor de prueba")
class SecurityProbeIT extends AbstractFlowIT {

    private static String claims(String token) {
        return new String(Base64.getUrlDecoder().decode(token.split("\\\\.")[1]), StandardCharsets.UTF_8);
    }

    private static String sub(String token) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("\\"sub\\"\\\\s*:\\\\s*\\"([^\\"]+)\\"").matcher(claims(token));
        Assertions.assertTrue(matcher.find(), "El token no lleva sub: " + claims(token));
        return matcher.group(1);
    }

    private static String rawToken(String url, String form) throws Exception {
        HttpResponse<String> response = HttpClient.newHttpClient().send(
            HttpRequest.newBuilder(URI.create(url))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form))
                .build(),
            HttpResponse.BodyHandlers.ofString());
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("\\"access_token\\"\\\\s*:\\\\s*\\"([^\\"]+)\\"").matcher(response.body());
        Assertions.assertTrue(matcher.find(), "El proveedor no dio token: " + response.body());
        return matcher.group(1);
    }

    @Test
    @DisplayName("FL-SEC-001-A: sin credencial, la operación es 401 UNAUTHENTICATED")
    void withoutCredential() {
        Response response = get("/api/v1/me/card");
        Assertions.assertEquals(401, response.status(), response.body());
        Assertions.assertEquals("UNAUTHENTICATED", jsonPath(response, "$.code"));
    }

    @Test
    @DisplayName("FL-SEC-001-B: un token que no valida es 401 también en una ruta abierta")
    void invalidTokenOnOpenRoute() {
        Assertions.assertEquals(401, get("/actuator/health", "no.es-un.token").status());
    }

    @Test
    @DisplayName("FL-SEC-001-C: autenticado sin el permiso de la regla es 403 ACCESS_DENIED")
    void withoutPermission() {
        Response response = get("/api/v1/me/card", tokenFor("no-role"));
        Assertions.assertEquals(403, response.status(), response.body());
        Assertions.assertEquals("ACCESS_DENIED", jsonPath(response, "$.code"));
    }

    @Test
    @DisplayName("FL-SEC-001-D: con el rol que otorga el permiso, llega al handler con el sub del token")
    void reachesHandlerWithSubject() {
        String token = tokenFor("card-holder");
        Response response = get("/api/v1/me/card", token);
        Assertions.assertEquals(404, response.status(), response.body());
        Assertions.assertEquals("CARD_NOT_FOUND", jsonPath(response, "$.code"));
        Assertions.assertEquals("sin ficha para " + sub(token), jsonPath(response, "$.message"));
    }

    @Test
    @DisplayName("FL-SEC-001-E: la persona de tokenAs llega con el sub que eligió el escenario")
    void personaSubject() {
        Response response = get("/api/v1/me/card", tokenAs("sub-ana-001", "card-holder", Map.of()));
        Assertions.assertEquals(404, response.status(), response.body());
        Assertions.assertEquals("sin ficha para sub-ana-001", jsonPath(response, "$.message"));
    }

    @Test
    @DisplayName("FL-SEC-001-F: la persona sin rol es 403")
    void personaWithoutRole() {
        Assertions.assertEquals(403, get("/api/v1/me/card", tokenAs("sub-ana-001", Map.of())).status());
    }

    @Test
    @DisplayName("FL-SEC-001-G: la identidad no se acepta del cuerpo")
    void identityNotFromBody() {
        String token = tokenFor("card-holder");
        Response response = put("/api/v1/me/card", "{\\"callerSubject\\":\\"intruso\\",\\"displayName\\":\\"X\\"}", token);
        Assertions.assertEquals(404, response.status(), response.body());
        Assertions.assertEquals("guardaría para " + sub(token), jsonPath(response, "$.message"));
    }

    @Test
    @DisplayName("FL-SEC-001-H: un camino que no existe es 401 sin credencial y 404 con ella")
    void unknownPath() {
        Assertions.assertEquals(401, get("/api/v1/no-existe").status());
        Assertions.assertEquals(404, get("/api/v1/no-existe", tokenFor("card-holder")).status());
    }

    @Test
    @DisplayName("FL-SEC-001-I: un token de otro emisor (otro host del mismo proveedor) es 401")
    void foreignIssuer() throws Exception {
        String token = rawToken(${javaString(foreignTokenUrl)}, ${javaString(form)});
        Response response = get("/api/v1/me/card", token);
        Assertions.assertEquals(401, response.status(), response.body());
    }
${idTokenCase}}
`;
}

function replaceOnce(file, from, to) {
  const source = fs.readFileSync(file, 'utf8');
  const next = source.replace(from, to);
  if (next === source) throw new Error(`no se encontró el punto a sustituir en ${path.basename(file)}`);
  fs.writeFileSync(file, next);
  return source;
}

async function runProvider(auth) {
  const label = (name) => `${auth}: ${name}`;
  const contract = tokenContract(auth);
  const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), `keel-spring-security-${auth}-`)) : tmpDir(`keel-spring-security-${auth}-`);
  const service = loadService(path.join(here, '..', '..', '..', 'fixtures', 'designs', DESIGN));
  const quiet = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  try {
    scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack: { auth, database: 'postgresql' } });
  } finally {
    Object.assign(console, quiet);
  }
  const projectDir = path.join(workspace, 'services', `${DESIGN}-spring`);
  if (!step(label('build genera el proyecto'), fs.existsSync(path.join(projectDir, 'build.gradle')))) return;
  if (keep) console.log(`  proyecto: ${projectDir}`);

  // Los handlers: responden CARD_NOT_FOUND nombrando al llamante que recibieron.
  const usecases = path.join(projectDir, 'src', 'main', 'java', PACKAGE, 'application', 'usecases');
  for (const [file, todo, message] of [
    ['GetMyCardQueryHandler.java', 'getMyCard', '"sin ficha para " + query.callerSubject()'],
    ['SaveMyCardCommandHandler.java', 'saveMyCard', '"guardaría para " + command.callerSubject()']
  ]) {
    replaceOnce(
      path.join(usecases, file),
      `throw new UnsupportedOperationException("TODO: ${todo}");`,
      `throw new com.identity.profiledirectory.domain.errors.CardNotFoundError(${message});`
    );
  }

  const credentials = readEnvFile(path.join(projectDir, 'infra', 'test-credentials.env'));
  const foreignTokenUrl = credentials.AUTH_TOKEN_URL.replace('//localhost:', '//127.0.0.1:');
  if (!step(label('test-credentials.env da la URL del token en localhost'), foreignTokenUrl !== credentials.AUTH_TOKEN_URL, credentials.AUTH_TOKEN_URL)) return;

  // Con un proveedor que distingue el tipo de token, el emulador tiene que poder dar un ID token de verdad (ver cabecera).
  const idToken = contract.accepted ? { ...contract.accepted } : null;
  if (idToken) {
    const configFile = path.join(projectDir, 'infra', 'cognito', 'mock-oauth2-config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const callback = config.tokenCallbacks[0];
    const holder = callback.requestMappings.find((mapping) => mapping.requestParam === 'username' && mapping.match === 'card-holder');
    if (!step(label('el emulador tiene el mapping del usuario fijo card-holder, con su sub uuid'), holder?.claims.sub === emulatedSubject('card-holder'), JSON.stringify(holder))) return;
    callback.requestMappings.unshift({
      requestParam: ID_TOKEN_PROBE.param,
      match: ID_TOKEN_PROBE.match,
      claims: { ...holder.claims, [idToken.claim]: idToken.rejected, aud: credentials.AUTH_TEST_CLIENT }
    });
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  }

  const flowsDir = path.join(projectDir, 'src', 'integrationTest', 'java', PACKAGE, 'flows');
  fs.writeFileSync(path.join(flowsDir, 'SecurityProbeIT.java'), probeClass({ credentials, foreignTokenUrl, idToken }));
  // El documento de escenarios declara SOLO la sonda: un id que el documento no declara es ajeno y no puntúa.
  fs.mkdirSync(path.join(projectDir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'specs', 'validation-scenarios.md'), '#### FL-SEC-001 — sonda de la seguridad\n');
  const ids = `ABCDEFGHI${idToken ? 'J' : ''}`.split('');

  const up = bash(projectDir, 'infra/up.sh');
  if (!step(label('bash infra/up.sh (PostgreSQL y el proveedor)'), up.status === 0, up.output.slice(-1200))) {
    bash(projectDir, 'infra/down.sh', ['--volumes']);
    return;
  }
  try {
    if (fs.existsSync(path.join(projectDir, 'infra', 'init-keycloak.sh'))) {
      const seed = bash(projectDir, 'infra/init-keycloak.sh');
      if (!step(label('bash infra/init-keycloak.sh siembra el realm'), seed.status === 0, seed.output.slice(-1500))) return;
    }
    const validate = bash(projectDir, 'infra/validate-infra.sh');
    step(label('bash infra/validate-infra.sh'), validate.status === 0, validate.output.slice(-1200));

    const scored = bash(projectDir, 'infra/score-scenarios.sh');
    const lines = scored.output;
    for (const id of ids) {
      const ok = new RegExp(`OK\\s+FL-SEC-001-${id}\\b`).test(lines);
      step(label(`score: FL-SEC-001-${id}`), ok, lines.match(new RegExp(`.*FL-SEC-001-${id}\\b.*`))?.[0] ?? 'sin fila');
    }
    const notExercised = [...lines.matchAll(/NO_EJERC\S*\s+(FL-\S+)/g)].map((match) => match[1]);
    const measured = scored.status === 0 && /Humo del arnés: OK/.test(lines) && !/^\s*FALLO\s/m.test(lines) && notExercised.length === 0;
    if (!step(label('score: humo del arnés en verde, ningún FALLO, la sonda entera ejercitada y el script con 0'), measured, `código ${scored.status}\n${lines.slice(-2500)}`)) return;

    // Falsado: cada sabotaje cae en exactamente su caso.
    const sabotages = [
      {
        id: 'rule',
        // F también: es la persona sin rol sobre la misma ruta.
        breaks: ['C', 'F'],
        file: path.join(projectDir, 'src', 'main', 'java', PACKAGE, 'infrastructure', 'configurations', 'security', 'SecurityConfig.java'),
        from: '.requestMatchers(HttpMethod.GET, "/api/v1/me/card").hasAnyAuthority("card:self")',
        to: '.requestMatchers(HttpMethod.GET, "/api/v1/me/card").authenticated()'
      },
      ...(idToken
        ? [
            {
              id: 'token-use',
              breaks: ['J'],
              file: path.join(projectDir, 'src', 'main', 'java', PACKAGE, 'infrastructure', 'configurations', 'security', 'JwtAuthConverter.java'),
              from: `if (!"${idToken.value}".equals(jwt.getClaimAsString("${idToken.claim}"))) {`,
              to: 'if (false) {'
            }
          ]
        : [])
    ];
    for (const sabotage of sabotages) {
      let original;
      try {
        original = replaceOnce(sabotage.file, sabotage.from, sabotage.to);
      } catch (error) {
        step(label(`falsado ${sabotage.id}: el punto se encuentra en lo emitido`), false, error.message);
        continue;
      }
      try {
        const broken = bash(projectDir, 'infra/score-scenarios.sh');
        const failed = ids.filter((id) => new RegExp(`FALLO\\s+FL-SEC-001-${id}\\b`).test(broken.output));
        step(
          label(`falsado ${sabotage.id}: cae FL-SEC-001-${sabotage.breaks.join(', ')} y solo eso, con el script en 1`),
          broken.status === 1 && failed.join() === sabotage.breaks.join(),
          `código ${broken.status}, en FALLO: [${failed.join(', ')}]\n${broken.output.slice(-2000)}`
        );
      } finally {
        fs.writeFileSync(sabotage.file, original);
      }
    }
  } finally {
    const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
    step(label('bash infra/down.sh --volumes'), down.status === 0, down.output.slice(-600));
  }
}

for (const auth of PROVIDERS) await runProvider(auth);

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\nsecurity-check: ${results.length}/${results.length} en verde.` : `\nsecurity-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
