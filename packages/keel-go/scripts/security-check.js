#!/usr/bin/env node
// Ejercita la SEGURIDAD que emite keel-go contra un Keycloak real (incremento 8c).
//
// Por qué no está en `npm test`: necesita Go, red (proxy.golang.org la primera vez), podman o docker, y tarda minutos.
// La suite del paquete compara lo emitido (`security-parity`, `security`, `integration-harness`) y `go-check` ejecuta la
// prueba emitida de la API con tokens firmados por `securitytest`; esto es lo único que dice que la cadena entera
// funciona con el proveedor de verdad: que `init-keycloak.sh` siembra el realm (y es idempotente), que el servidor
// resuelve las claves por el discovery del `issuer-uri`, que las authorities salen de los claims de Keycloak y de los
// `roleGrants`, que la identidad del llamante llega al handler desde el token y nunca desde el cuerpo, y que el arnés
// (`tests/integration/credentials_test.go`) pide los tokens que los flujos van a usar: `TokenFor`, `SecondTokenFor`, las
// personas de `TokenAs` y los clientes máquina de `ServiceCredential` con la matriz `test-m2m-*`.
//
//   node packages/keel-go/scripts/security-check.js [--keep]
//   npm run security-check --workspace packages/keel-go
//
// El gemelo del security-check de keel-dotnet y keel-nest, con las mismas sondas. El primer sujeto es
// `profile-directory` (identidad por el claim `sub`, permiso otorgado por un rol). Sus handlers son TODOs: aquí se
// sustituyen por uno que responde CARD_NOT_FOUND nombrando al llamante que recibió, que es lo que hace observable la
// identidad sin escribir la lógica del servicio. El segundo es `notification-mailer` (solo clientes máquina, con la
// audiencia validada): keel-go aún no lo genera entero, pero su infra/ y su arnés de identidad sí, y lo que se mide es
// que cada token de máquina llegue con el cliente, los scopes y la audiencia que el realm promete.
//
// Cada mitad se falsa sobre lo emitido: la regla de GET /me/card rebajada a «autenticado» (caen solo los 403), la clave
// de la caché de TokenAs sin los claims (cae solo el token sin email) y la de ServiceCredential sin el cliente (cada
// cliente recibe el token del primero).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { resolveStack, writeStackConfig } from '@keel-system/keel-core/gen/stack';
import { realmSpec } from '@keel-system/keel-core/gen/identity-realm';
import { makeWorkspace, mountDesign, runCommand } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { planService } from '../src/scaffold/index.js';
import { resolveRuntime } from '../../keel-nest/scripts/lib/database-container.js';

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
  const result = spawnSync(bashExecutable(), [script, ...args], { cwd: projectDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function go(projectDir, args, extraEnv = {}) {
  const result = spawnSync('go', args, { cwd: projectDir, encoding: 'utf8', env: { ...env, ...extraEnv }, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// Los claims de un JWT, en Go: lo comparten las dos sondas.
const CLAIMS_GO = `// probeClaims son los claims del token, sin validar su firma: lo que el proveedor promete al servidor.
func probeClaims(s *Scenario, token string) map[string]any {
	s.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		s.Fatalf("no es un JWT: %q", token)
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		s.Fatalf("el payload del token: %v", err)
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		s.Fatalf("los claims del token: %v", err)
	}
	return claims
}
`;

const workspace = makeWorkspace('keel-go-security-');
const specDir = mountDesign(workspace, DESIGN);
const projectDir = path.join(workspace, 'services', `${DESIGN}-go`);
fs.mkdirSync(projectDir, { recursive: true });
writeStackConfig(projectDir, resolveStack({ database: 'postgresql', auth: 'keycloak' }, loadService(specDir).layers));
const generated = await runCommand(workspace, build, `specs/${DESIGN}`, { defaults: true, acceptUnready: true });
if (!step('build genera el proyecto', generated.exitCode === undefined && fs.existsSync(path.join(projectDir, 'go.mod')), generated.exitCode ? generated.output : '')) {
  process.exit(1);
}
const tidy = go(projectDir, ['mod', 'tidy']);
if (!step('go mod tidy', tidy.ok, tidy.ok ? '' : tidy.output.slice(-1200))) process.exit(1);

// Los handlers: responden CARD_NOT_FOUND nombrando al llamante que recibieron en el mensaje.
for (const [file, todo, zero, message] of [
  ['get_my_card_query_handler.go', 'getMyCard', 'GetMyCardResponseDto', '"sin ficha para %s", query.CallerSubject'],
  ['save_my_card_command_handler.go', 'saveMyCard', 'SaveMyCardResponseDto', '"guardaría para %s", cmd.CallerSubject']
]) {
  const handler = path.join(projectDir, 'internal', 'application', file);
  const source = fs.readFileSync(handler, 'utf8');
  const probed = source
    .replace(`return ${zero}{}, fmt.Errorf("%w: %s", ErrNotImplemented, "${todo}")`, `return ${zero}{}, domain.Errorf(domain.ErrCardNotFound, ${message})`)
    .replace('\t"fmt"\n', '');
  step(`el handler sonda de ${todo} se puede escribir`, probed !== source && !probed.includes('ErrNotImplemented'));
  fs.writeFileSync(handler, probed);
}

const flowsDir = path.join(projectDir, 'tests', 'integration');
fs.writeFileSync(
  path.join(flowsDir, 'probe_security_flow_test.go'),
  `//go:build integration

package integration

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

${CLAIMS_GO}
// probeField es el campo de texto name del cuerpo JSON de la respuesta.
func probeField(s *Scenario, got *Response, name string) string {
	s.Helper()
	body, err := got.JSON()
	if err != nil {
		s.Fatal(err)
	}
	object, _ := body.(map[string]any)
	text, _ := object[name].(string)
	return text
}

func probeSub(s *Scenario, token string) string {
	s.Helper()
	return fmt.Sprint(probeClaims(s, token)["sub"])
}

// probeExpect afirma el status y el code de la respuesta.
func probeExpect(s *Scenario, got *Response, status int, code string) {
	s.Helper()
	s.ExpectStatus(got, status)
	if code != "" {
		if got := probeField(s, got, "code"); got != code {
			s.Errorf("code = %q, quiero %q", got, code)
		}
	}
}

func TestProbeSecurity(t *testing.T) {
	f := StartFlow(t, nil)
	card := RouteBase + "/me/card"
	ana := Persona{Sub: "sub-ana-001", Claims: map[string]string{"email": "ana@example.test"}, Role: "card-holder"}

	f.Scenario("FL-SEC-001-A: sin credencial, la operación es 401 UNAUTHENTICATED", func(s *Scenario) {
		probeExpect(s, s.Get(card), 401, "UNAUTHENTICATED")
	})
	f.Scenario("FL-SEC-001-B: un token que no valida es 401 también en una ruta abierta", func(s *Scenario) {
		s.ExpectStatus(s.Get("/livez", Bearer("no.es-un.token")), 401)
	})
	f.Scenario("FL-SEC-001-C: autenticado sin el permiso de la regla es 403 ACCESS_DENIED", func(s *Scenario) {
		probeExpect(s, s.Get(card, Bearer(s.TokenFor("no-role"))), 403, "ACCESS_DENIED")
	})
	f.Scenario("FL-SEC-001-D: con el rol que otorga el permiso, llega al handler con el sub del token", func(s *Scenario) {
		token := s.TokenFor("card-holder")
		got := s.Get(card, Bearer(token))
		probeExpect(s, got, 404, "CARD_NOT_FOUND")
		if want := "sin ficha para " + probeSub(s, token); probeField(s, got, "message") != want {
			s.Errorf("message = %q, quiero %q", probeField(s, got, "message"), want)
		}
	})
	f.Scenario("FL-SEC-001-E: la persona de TokenAs llega con el sub que eligió el escenario", func(s *Scenario) {
		got := s.Get(card, Bearer(s.TokenAs(ana)))
		probeExpect(s, got, 404, "CARD_NOT_FOUND")
		if message := probeField(s, got, "message"); message != "sin ficha para sub-ana-001" {
			s.Errorf("message = %q", message)
		}
	})
	f.Scenario("FL-SEC-001-F: TokenAs cambia los claims de la misma persona entre peticiones", func(s *Scenario) {
		withEmail := probeClaims(s, s.TokenAs(ana))
		without := probeClaims(s, s.TokenAs(Persona{Sub: ana.Sub, Without: []string{"email"}, Role: ana.Role}))
		if withEmail["email"] != "ana@example.test" {
			s.Errorf("con email: %v", withEmail["email"])
		}
		if _, ok := without["email"]; ok {
			s.Errorf("sin email, el token lleva email = %v", without["email"])
		}
		if without["sub"] != "sub-ana-001" {
			s.Errorf("sin email, sub = %v", without["sub"])
		}
	})
	f.Scenario("FL-SEC-001-G: la identidad no se acepta del cuerpo", func(s *Scenario) {
		token := s.TokenFor("card-holder")
		got := s.Put(card, map[string]any{"callerSubject": "intruso", "displayName": "X"}, Bearer(token))
		probeExpect(s, got, 404, "CARD_NOT_FOUND")
		if want := "guardaría para " + probeSub(s, token); probeField(s, got, "message") != want {
			s.Errorf("message = %q, quiero %q", probeField(s, got, "message"), want)
		}
	})
	f.Scenario("FL-SEC-001-H: un camino que no existe es 401 sin credencial y 404 con ella", func(s *Scenario) {
		s.ExpectStatus(s.Get(RouteBase+"/no-existe"), 401)
		s.ExpectStatus(s.Get(RouteBase+"/no-existe", Bearer(s.TokenFor("card-holder"))), 404)
	})
	f.Scenario("FL-SEC-001-I: un token de otro emisor (otro host del mismo Keycloak) es 401", func(s *Scenario) {
		form := url.Values{"grant_type": {"password"}, "client_id": {"${DESIGN}-go-test"}, "username": {"card-holder"}, "password": {"password"}}
		issued, err := identityClient.PostForm("http://127.0.0.1:8180/realms/${DESIGN}/protocol/openid-connect/token", form)
		if err != nil {
			s.Fatal(err)
		}
		defer issued.Body.Close()
		var body struct {
			AccessToken string \`json:"access_token"\`
		}
		if err := json.NewDecoder(issued.Body).Decode(&body); err != nil || issued.StatusCode != http.StatusOK {
			s.Fatalf("el token del otro emisor: %d %v", issued.StatusCode, err)
		}
		s.ExpectStatus(s.Get(card, Bearer(body.AccessToken)), 401)
	})
	f.Scenario("FL-SEC-001-J: SecondTokenFor es otro titular del mismo rol", func(s *Scenario) {
		first, second := s.TokenFor("card-holder"), s.SecondTokenFor("card-holder")
		if probeSub(s, first) == probeSub(s, second) {
			s.Fatalf("los dos usuarios del rol tienen el mismo sub %s", probeSub(s, first))
		}
		got := s.Get(card, Bearer(second))
		probeExpect(s, got, 404, "CARD_NOT_FOUND")
		if want := "sin ficha para " + probeSub(s, second); probeField(s, got, "message") != want {
			s.Errorf("message = %q, quiero %q", probeField(s, got, "message"), want)
		}
	})
	f.Scenario("FL-SEC-001-K: la persona sin rol es 403", func(s *Scenario) {
		probeExpect(s, s.Get(card, Bearer(s.TokenAs(Persona{Sub: "sub-bea-002"}))), 403, "ACCESS_DENIED")
	})
}
`
);
const vet = go(projectDir, ['vet', '-tags', 'integration', './...']);
if (!step('el proyecto con los handlers y la sonda pasa go vet (con -tags integration)', vet.ok, vet.ok ? '' : vet.output.slice(-2500))) process.exit(1);

const PROBES = 'ABCDEFGHIJK';
const up = bash(projectDir, 'infra/up.sh');
if (!step('bash infra/up.sh (PostgreSQL y Keycloak)', up.status === 0, up.status === 0 ? '' : up.output.slice(-1200))) process.exit(1);
try {
  const seed = bash(projectDir, 'infra/init-keycloak.sh');
  step('bash infra/init-keycloak.sh siembra el realm', seed.status === 0 && new RegExp(`Realm '${DESIGN}' listo`).test(seed.output), seed.status === 0 ? '' : seed.output.slice(-1500));
  const again = bash(projectDir, 'infra/init-keycloak.sh');
  step('y es idempotente: la segunda pasada también sale con 0', again.status === 0, again.status === 0 ? '' : again.output.slice(-800));
  const validate = bash(projectDir, 'infra/validate-infra.sh');
  step('bash infra/validate-infra.sh', validate.status === 0, validate.status === 0 ? '' : validate.output.slice(-1200));

  // El documento de escenarios declara SOLO la sonda: un id que el documento no declara es AJENO, no puntúa, y su
  // FALLO no deja el script en 1 (sale con 2, arnés roto), así que el falsado no se podría leer. Sustituye al del
  // diseño, y su línea sale del sello: specs.sha256 vigila lo que lista, y el documento sonda no lo escribió build.
  fs.writeFileSync(path.join(projectDir, 'specs', 'validation-scenarios.md'), '#### FL-SEC-001 — sonda de la seguridad\n');
  const seal = path.join(projectDir, 'specs.sha256');
  if (fs.existsSync(seal)) {
    fs.writeFileSync(seal, fs.readFileSync(seal, 'utf8').split('\n').filter((line) => !line.endsWith('specs/validation-scenarios.md')).join('\n'));
  }
  const scored = bash(projectDir, 'infra/score-scenarios.sh');
  const lines = scored.output;
  for (const id of PROBES) {
    const ok = new RegExp(`OK\\s+FL-SEC-001-${id}`).test(lines);
    step(`score: FL-SEC-001-${id}`, ok, ok ? '' : (lines.match(new RegExp(`.*FL-SEC-001-${id}.*`))?.[0] ?? 'sin fila'));
  }
  // Con el humo (SMOKE-5: el proveedor emite las credenciales) en verde y la sonda entera en OK, el script sale con 0.
  const measured = scored.status === 0 && /Humo del arnés: OK/.test(lines);
  step('score: el humo del arnés (con SMOKE-5, las credenciales) en verde y el script con 0', measured, measured ? '' : lines.slice(-2500));

  // Falsado sobre lo emitido: cada sabotaje conserva la forma y tiene que tumbar EXACTAMENTE sus escenarios.
  const falsify = (label, file, from, to, only) => {
    const target = path.join(projectDir, file);
    const original = fs.readFileSync(target, 'utf8');
    const sabotaged = original.replace(from, to);
    if (!step(`falsado (${label}): el sabotaje se aplica a lo emitido`, sabotaged !== original)) return;
    fs.writeFileSync(target, sabotaged);
    try {
      const run = bash(projectDir, 'infra/score-scenarios.sh');
      const failing = [...PROBES].filter((id) => new RegExp(`FALLO\\s+FL-SEC-001-${id}`).test(run.output)).join('');
      const caught = run.status === 1 && failing === only;
      step(
        `falsado (${label}): salen FALLO exactamente ${[...only].map((id) => `FL-SEC-001-${id}`).join(' y ')}, y el script con 1`,
        caught,
        caught ? '' : `código ${run.status}, en FALLO: ${failing || 'ninguno'}\n${run.output.slice(-2000)}`
      );
    } finally {
      fs.writeFileSync(target, original);
    }
  };
  // Con la regla de GET /me/card rebajada a «autenticado», pasan los dos llamantes sin el permiso: el usuario sin rol
  // y la persona sin rol.
  falsify('regla rebajada', path.join('internal', 'httpapi', 'security.go'), /(\{"GET", "[^"]*\/me\/card", )anyOf\("card:self"\)\}/, '$1authenticated}', 'CK');
  // Con la clave de la caché de TokenAs sin los claims, «el mismo token sin email» es el token con email.
  falsify(
    'caché de TokenAs sin los claims',
    path.join('tests', 'integration', 'credentials_test.go'),
    '"|" + string(claims) + "|" + strings.Join(personaClaims(p), ",")',
    '"|" + string(claims[:0])',
    'F'
  );
} finally {
  const down = bash(projectDir, 'infra/down.sh', ['--volumes']);
  step('bash infra/down.sh --volumes', down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
}

// ── Segundo sujeto: los CLIENTES MÁQUINA (`ServiceCredential`) y la matriz `test-m2m-*` ─────────────────────────
//
// `profile-directory` no declara `serviceAuth`; `notification-mailer` sí (cinco clientes del diseño y la audiencia
// validada, así que la matriz entera: ok, no-scope, bad-aud y none). keel-go todavía no genera ese diseño entero (su
// frontera rechaza mensajería y correo), pero su infra/ y su arnés de identidad SÍ los emite: se escriben del plan, se
// levanta su infraestructura y una prueba sonda en tests/integration (que no arranca el servidor: no pasa por
// StartFlow) pide el token de cada cliente con el ServiceCredential emitido. Lo que se mide es lo que ningún test sin
// red puede: que cada token llegue firmado con su cliente (`azp`), sus scopes y su audiencia, tal como los describe
// `realmSpec`, la fuente de init-keycloak.sh.
{
  const MACHINE = 'notification-mailer';
  const machineWorkspace = makeWorkspace('keel-go-security-m2m-');
  const machineSpec = mountDesign(machineWorkspace, MACHINE);
  const machineDir = path.join(machineWorkspace, 'services', `${MACHINE}-go`);
  const { manifest, layers } = loadService(machineSpec);
  const stack = { database: 'postgresql', auth: 'keycloak' };
  const { model, files } = planService({ manifest, layers, workspace: machineWorkspace, stack });
  for (const file of files) {
    const target = path.join(machineDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  writeStackConfig(machineDir, resolveStack(stack, layers));
  const spec = realmSpec(model);
  const machines = [...spec.serviceClients.map((client) => ({ ...client, audience: 'ok' })), ...spec.m2mClients];
  step(
    `${MACHINE}: el plan emite infra/ y ServiceCredential, y el realm trae la matriz entera`,
    fs.existsSync(path.join(machineDir, 'infra', 'init-keycloak.sh')) &&
      /func \(s \*Scenario\) ServiceCredential\(/.test(fs.readFileSync(path.join(machineDir, 'tests', 'integration', 'credentials_test.go'), 'utf8')) &&
      ['test-m2m-ok', 'test-m2m-no-scope', 'test-m2m-bad-aud', 'test-m2m-none'].every((name) => spec.m2mClients.some((client) => client.name === name)),
    machines.map((client) => client.name).join(', ')
  );
  fs.writeFileSync(
    path.join(machineDir, 'tests', 'integration', 'probe_machine_test.go'),
    `//go:build integration

package integration

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

${CLAIMS_GO}
// TestProbeMachine pide el token de cada cliente de PROBE_CLIENTS y escribe sus claims en PROBE_OUT.
func TestProbeMachine(t *testing.T) {
	s := &Scenario{T: t}
	out := map[string]map[string]any{}
	for client := range strings.SplitSeq(os.Getenv("PROBE_CLIENTS"), ",") {
		out[client] = probeClaims(s, s.ServiceCredential(client))
	}
	data, err := json.Marshal(out)
	if err != nil {
		s.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv("PROBE_OUT"), data, 0o600); err != nil {
		s.Fatal(err)
	}
}
`
  );
  const machineTidy = go(machineDir, ['mod', 'tidy']);
  const machineVet = machineTidy.ok ? go(machineDir, ['vet', '-tags', 'integration', './tests/integration']) : machineTidy;
  if (step(`${MACHINE}: tidy y la sonda compila con el arnés emitido`, machineVet.ok, machineVet.ok ? '' : machineVet.output.slice(-2000))) {
    const probeOut = path.join(machineWorkspace, 'machine-claims.json');
    const probe = () => {
      fs.rmSync(probeOut, { force: true });
      const run = go(machineDir, ['test', '-tags', 'integration', '-count=1', '-run', '^TestProbeMachine$', './tests/integration'], {
        PROBE_CLIENTS: machines.map((client) => client.name).join(','),
        PROBE_OUT: probeOut
      });
      let claims = null;
      try {
        claims = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
      } catch {
        claims = null;
      }
      return { run, claims };
    };
    // Lo que el realm promete de cada cliente: su azp, exactamente sus scopes del servicio y su audiencia.
    const judge = (claims) =>
      machines.map((client) => {
        const token = claims?.[client.name] ?? {};
        const audiences = [token.aud ?? []].flat();
        const granted = (token.scope ?? '').split(' ').filter((scope) => spec.scopes.includes(scope)).sort();
        const audienceOk =
          client.audience === 'ok' ? audiences.includes(spec.audience) : client.audience === 'wrong' ? audiences.includes('audiencia-ajena') && !audiences.includes(spec.audience) : !audiences.includes(spec.audience);
        const ok = token.azp === client.name && JSON.stringify(granted) === JSON.stringify([...client.scopes].sort()) && audienceOk;
        return { client, ok, detail: `azp=${token.azp} scope=[${granted.join(' ')}] aud=${JSON.stringify(token.aud ?? null)}` };
      });

    const machineUp = bash(machineDir, 'infra/up.sh');
    if (step(`${MACHINE}: bash infra/up.sh`, machineUp.status === 0, machineUp.status === 0 ? '' : machineUp.output.slice(-1200))) {
      try {
        const seeded = bash(machineDir, 'infra/init-keycloak.sh');
        if (step(`${MACHINE}: bash infra/init-keycloak.sh siembra los clientes máquina y la matriz`, seeded.status === 0, seeded.status === 0 ? '' : seeded.output.slice(-1500))) {
          const { run, claims } = probe();
          if (step(`${MACHINE}: ServiceCredential da el token de cada cliente`, run.ok && claims != null, run.ok ? '' : run.output.slice(-1500))) {
            for (const verdict of judge(claims)) {
              step(`ServiceCredential("${verdict.client.name}"): su azp, sus scopes y su audiencia (${verdict.client.audience ?? 'ninguna'})`, verdict.ok, verdict.ok ? '' : verdict.detail);
            }
          }
          // Falsado: con la clave de la caché sin el cliente, cada cliente recibe el token del primero que lo pidió.
          const credentialsFile = path.join(machineDir, 'tests', 'integration', 'credentials_test.go');
          const original = fs.readFileSync(credentialsFile, 'utf8');
          const sabotaged = original.replace('cachedToken("client:"+client,', 'cachedToken("client:",');
          if (step('falsado (caché de ServiceCredential sin el cliente): el sabotaje se aplica a lo emitido', sabotaged !== original)) {
            fs.writeFileSync(credentialsFile, sabotaged);
            try {
              const { claims: broken } = probe();
              const wrong = judge(broken).filter((verdict) => !verdict.ok).map((verdict) => verdict.client.name);
              // Todos menos el primero, que es el que se queda en la caché.
              const caught = broken != null && wrong.length === machines.length - 1 && !wrong.includes(machines[0].name);
              step('falsado (caché de ServiceCredential sin el cliente): caen todos los clientes salvo el primero', caught, `en rojo: ${wrong.join(', ') || 'ninguno'}`);
            } finally {
              fs.writeFileSync(credentialsFile, original);
            }
          }
        }
      } finally {
        const down = bash(machineDir, 'infra/down.sh', ['--volumes']);
        step(`${MACHINE}: bash infra/down.sh --volumes`, down.status === 0, down.status === 0 ? '' : down.output.slice(-600));
      }
    }
  }
}

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-go-security-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\nsecurity-check: ${results.length}/${results.length} en verde.` : `\nsecurity-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
