#!/usr/bin/env node
// EJECUTA el `tokenAs` y el `tokenWithScope` que build emite contra el EMULADOR del proveedor (incremento 4.3 de
// PLAN-PROVEEDOR-IDENTIDAD.md) y compara la petición que arman con la de referencia (`emulatorPersonaForm`,
// `emulatorScopedForm`): casos EMU-F-* de keel-core/test/helpers/emulator-form-cases.js, los mismos en los cuatro
// generadores. Los métodos se sacan de AbstractFlowIT tal como salen y se ejecutan con `java` en un archivo único, con el
// transporte sustituido por uno que devuelve el formulario. Sin contenedores ni red: que el emulador dé el token pedido
// con esa petición lo mide `emulator-check` de keel-core.
//
// Por qué existe: un parámetro mal escrito no falla en el emulador, da un token válido sin los claims (T1), y el
// escenario que lo pidió acaba en un 403 que parece del servidor.
//
//   node packages/keel-spring/scripts/emulator-harness-check.js [--sabotage=persona-shape|scope-unsorted] [--keep]
//
// Necesita JDK. Con sabotaje, verde = cae en exactamente sus casos.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from '@keel-system/keel-core';
import { IDENTITY_PROVIDERS } from '@keel-system/keel-core/gen/identity-providers';
import { personaTokenMechanism, scopedTokenMechanism } from '@keel-system/keel-core/gen/identity-realm';
import { tmpDir } from '../test/helpers/tmp.js';
import { planService, scaffoldService } from '../src/scaffold/index.js';
import { EMULATOR_FORM_SABOTAGES, emulatorFormCases, judgeEmulatorForms } from '../../keel-core/test/helpers/emulator-form-cases.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'designs');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;

// La identidad en un claim que el proveedor no da de serie, en el `sub`, y el alcance.
const DESIGNS = ['shop-api', 'conduit', 'asset-vault'];

// Cada sabotaje rompe el Java emitido conservando su forma.
const BREAK = {
  'persona-shape': (source) => source.replace('(role != null ? "role" : "norole")', '(role != null ? "role" : "nobody")'),
  'scope-unsorted': (source) => source.replace('.distinct().sorted().toList()', '.distinct().toList()')
};

if (sabotage && !EMULATOR_FORM_SABOTAGES[sabotage]) {
  console.error(`No hay ningún sabotaje '${sabotage}'. Los hay: ${Object.keys(EMULATOR_FORM_SABOTAGES).join(', ')}.`);
  process.exit(2);
}
if (spawnSync('java', ['-version']).status !== 0) {
  console.error('No hay JDK en el PATH.');
  process.exit(2);
}

/** El método cuya firma empieza en `signature`, con su cuerpo entero (las llaves de los literales no aparecen aquí). */
function method(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`no está «${signature}» en AbstractFlowIT`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(start, i + 1);
  }
  throw new Error(`«${signature}» sin cerrar`);
}

const javaString = (value) => (value === null ? 'null' : JSON.stringify(value));

function call(testCase) {
  if (testCase.kind === 'scoped') return `h.tokenWithScope(${[testCase.role, ...testCase.values].map(javaString).join(', ')})`;
  const claims = Object.entries(testCase.claims).flatMap(([name, value]) => [javaString(name), javaString(value)]);
  return `h.tokenAs(${javaString(testCase.sub)}, ${javaString(testCase.role)}, claims(${claims.join(', ')}))`;
}

const cognito = IDENTITY_PROVIDERS.cognito;
const saved = cognito.harness;
cognito.harness = { personaTokens: 'emulator', scopedTokens: 'emulator' };
const quiet = { log: console.log, warn: console.warn };
let ok = true;
let hits = 0;
try {
  for (const name of DESIGNS) {
    const service = loadService(path.join(fixturesDir, name));
    const stack = { auth: 'cognito' };
    console.log = () => {};
    console.warn = () => {};
    let model;
    const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-emulator-keep-')) : tmpDir('keel-emulator-harness-');
    try {
      model = planService({ manifest: service.manifest, layers: service.layers, workspace: '.', stack }).model;
      scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack });
    } finally {
      Object.assign(console, quiet);
    }
    const persona = personaTokenMechanism(model) === 'emulator';
    const scopedRole = scopedTokenMechanism(model) === 'emulator' ? model.security.roles.find((role) => !model.security.scoping.exemptRoles.includes(role)) : null;
    const cases = emulatorFormCases(model, { persona, scoped: scopedRole ? { role: scopedRole } : null });
    if (cases.length === 0) throw new Error(`${name}: el diseño no usa personas ni titulares del alcance`);

    const harnessFile = (function find(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = find(full);
          if (found) return found;
        } else if (entry.name === 'AbstractFlowIT.java') return full;
      }
      return null;
    })(workspace);
    let source = fs.readFileSync(harnessFile, 'utf8');
    if (sabotage) source = BREAK[sabotage](source);
    const pieces = [method(source, 'private static String personaEncode(String value)')];
    if (persona) {
      pieces.push(method(source, 'protected String tokenAs(String sub, Map<String, String> claims)'));
      pieces.push(method(source, 'protected String tokenAs(String sub, String role, Map<String, String> claims)'));
      pieces.push(source.match(/private static final java\.util\.Set<String> PERSONA_CLAIMS = [^;]*;/)[0]);
    }
    if (scopedRole) pieces.push(method(source, 'protected String tokenWithScope(String role, String... values)'));

    const program = `import java.util.*;

public class EmulatorForm {
    private String cachedToken(String key, java.util.function.Supplier<String> mint) { return mint.get(); }
    private String requestToken(String form) { return form; }
    private static String env(String name, String fallback) { return fallback; }
    private static Map<String, String> claims(String... pairs) {
        Map<String, String> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) map.put(pairs[i], pairs[i + 1]);
        return map;
    }
    private interface Call { String run() throws Exception; }
    private static void run(String id, Call call) {
        String line;
        try { line = "form\\t" + call.run(); } catch (Exception e) { line = "error\\t" + e.getMessage(); }
        System.out.println(id + "\\t" + line.replace("\\n", " "));
    }

${pieces.map((piece) => `    ${piece}`).join('\n\n')}

    public static void main(String[] args) {
        EmulatorForm h = new EmulatorForm();
${cases.map((testCase) => `        run(${javaString(testCase.id)}, () -> ${call(testCase)});`).join('\n')}
    }
}
`;
    const dir = tmpDir('keel-emulator-java-');
    const file = path.join(dir, 'EmulatorForm.java');
    fs.writeFileSync(file, program);
    const run = spawnSync('java', ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', file], { encoding: 'utf8' });
    if (run.status !== 0) {
      console.error(`${name}: el Java no compila o no corre:\n${run.stderr}\n${program}`);
      process.exit(1);
    }
    const results = Object.fromEntries(
      run.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split('\t'))
        .map(([id, kind, ...rest]) => [id, kind === 'form' ? { form: rest.join('\t') } : { error: rest.join('\t') }])
    );
    const verdict = judgeEmulatorForms(`${name} (${cases.length} casos)`, cases, results, sabotage);
    console.log(verdict.lines.join('\n'));
    ok &&= verdict.ok;
    if (sabotage) hits += EMULATOR_FORM_SABOTAGES[sabotage].filter((id) => cases.some((c) => c.id === id)).length;
  }
} finally {
  cognito.harness = saved;
}
if (sabotage && hits === 0) {
  console.error(`Ningún diseño cubre los casos del sabotaje ${sabotage}.`);
  ok = false;
}
console.log(ok ? '\nVERDE' : '\nROJO');
process.exit(ok ? 0 : 1);
