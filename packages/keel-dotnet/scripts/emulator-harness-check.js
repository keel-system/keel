#!/usr/bin/env node
// EJECUTA el `TokenAs` y el `TokenWithScope` que build emite en Support/Credentials.cs contra el EMULADOR del proveedor
// (incremento 4.3 de PLAN-PROVEEDOR-IDENTIDAD.md) y compara la petición que arman con la de referencia
// (`emulatorPersonaForm`, `emulatorScopedForm`): casos EMU-F-* de keel-core/test/helpers/emulator-form-cases.js, los
// mismos en los cuatro generadores. Los métodos se sacan del archivo emitido tal como salen y se ejecutan con
// `dotnet run` sobre un archivo único, con el transporte sustituido por uno que devuelve el formulario codificado. Sin
// contenedores ni red: que el emulador dé el token pedido con esa petición lo mide `emulator-check` de keel-core.
//
//   node packages/keel-dotnet/scripts/emulator-harness-check.js [--sabotage=persona-shape|scope-unsorted]
//
// Necesita el SDK 10. Con sabotaje, verde = cae en exactamente sus casos.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from '@keel-system/keel-core';
import { IDENTITY_PROVIDERS } from '@keel-system/keel-core/gen/identity-providers';
import { personaTokenMechanism, scopedTokenMechanism } from '@keel-system/keel-core/gen/identity-realm';
import { tmpDir } from '../test/helpers/tmp.js';
import { planService } from '../src/scaffold/index.js';
import { EMULATOR_FORM_SABOTAGES, emulatorFormCases, judgeEmulatorForms } from '../../keel-core/test/helpers/emulator-form-cases.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'designs');
const sabotage = process.argv.slice(2).find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;

// La identidad en un claim que el proveedor no da de serie, en el `sub`, y el alcance.
const DESIGNS = ['shop-api', 'conduit', 'asset-vault'];

// Cada sabotaje rompe el C# emitido conservando su forma.
const BREAK = {
  'persona-shape': (source) => source.replace('(role is null ? "norole" : "role")', '(role is null ? "nobody" : "role")'),
  'scope-unsorted': (source) => source.replace('values.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToList()', 'values.Distinct(StringComparer.Ordinal).ToList()')
};

if (sabotage && !EMULATOR_FORM_SABOTAGES[sabotage]) {
  console.error(`No hay ningún sabotaje '${sabotage}'. Los hay: ${Object.keys(EMULATOR_FORM_SABOTAGES).join(', ')}.`);
  process.exit(2);
}
if (spawnSync('dotnet', ['--version']).status !== 0) {
  console.error('No hay SDK de .NET en el PATH.');
  process.exit(2);
}

/** El miembro cuya declaración empieza en `signature`, con su cuerpo entero. */
function member(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`no está «${signature}» en Credentials.cs`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(start, source[i + 1] === ';' ? i + 2 : i + 1);
  }
  throw new Error(`«${signature}» sin cerrar`);
}

const cs = (value) => (value === null ? 'null' : JSON.stringify(value));

function call(testCase) {
  if (testCase.kind === 'scoped') return `Credentials.TokenWithScope(${cs(testCase.role)}, new string[] { ${testCase.values.map(cs).join(', ')} })`;
  const claims = Object.entries(testCase.claims).map(([name, value]) => `[${cs(name)}] = ${cs(value)}`);
  return `Credentials.TokenAs(${cs(testCase.sub)}, new Dictionary<string, string?> { ${claims.join(', ')} }, ${cs(testCase.role)})`;
}

// Cognito da personas y titulares por el emulador desde el 4.3: si el descriptor dijera otra cosa, el arnés saldría sin
// la rama que se mide.
const { harness } = IDENTITY_PROVIDERS.cognito;
if (harness.personaTokens !== 'emulator' || harness.scopedTokens !== 'emulator') {
  console.error(`El descriptor de Cognito no da personas ni titulares por el emulador: ${JSON.stringify(harness)}.`);
  process.exit(2);
}
let ok = true;
let hits = 0;
for (const name of DESIGNS) {
  const service = loadService(path.join(fixturesDir, name));
  const { files, model } = planService({ manifest: service.manifest, layers: service.layers, workspace: '.', stack: { auth: 'cognito' } });
  const persona = personaTokenMechanism(model) === 'emulator';
  const scopedRole = scopedTokenMechanism(model) === 'emulator' ? model.security.roles.find((role) => !model.security.scoping.exemptRoles.includes(role)) : null;
  const cases = emulatorFormCases(model, { persona, scoped: scopedRole ? { role: scopedRole } : null });
  if (cases.length === 0) throw new Error(`${name}: el diseño no usa personas ni titulares del alcance`);

  let source = files.find((file) => file.path.endsWith('/Support/Credentials.cs')).content;
  if (sabotage) source = BREAK[sabotage](source);
  const pieces = [];
  if (persona) {
    pieces.push(member(source, 'private static readonly HashSet<string> PersonaClaims'));
    pieces.push(member(source, 'public static Task<string> TokenAs('));
  }
  if (scopedRole) {
    pieces.push(member(source, 'public static Task<string> TokenWithScope('));
    pieces.push(member(source, 'private static string JavaStringHash('));
  }

  const program = `#:property Nullable=enable
#:property PublishAot=false
using System.Globalization;
using System.Text.Json;

${cases.map((testCase) => `await Run(${cs(testCase.id)}, () => ${call(testCase)});`).join('\n')}

static async Task Run(string id, Func<Task<string>> call)
{
  string line;
  try { line = "form\\t" + await call(); } catch (ArgumentException error) { line = "error\\t" + error.Message; }
  Console.WriteLine(id + "\\t" + line.Replace("\\n", " "));
}

static class Credentials
{
  private static Task<string> Cached(string key, Func<Task<string>> mint) => mint();
  private static Task<string> RequestToken(Dictionary<string, string> form) => new FormUrlEncodedContent(form).ReadAsStringAsync();
  private static string Value(string name, string fallback) => fallback;

${pieces.map((piece) => `    ${piece}`).join('\n\n')}
}
`;
  const dir = tmpDir('keel-emulator-cs-');
  const file = path.join(dir, 'EmulatorForm.cs');
  fs.writeFileSync(file, program);
  const run = spawnSync('dotnet', ['run', file], { encoding: 'utf8', cwd: dir, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
  if (run.status !== 0) {
    console.error(`${name}: el C# no compila o no corre:\n${run.stdout}\n${run.stderr}\n${program}`);
    process.exit(1);
  }
  const results = Object.fromEntries(
    run.stdout
      .trim()
      .split(/\r?\n/)
      .filter((line) => /^EMU-F-\d+\t/.test(line))
      .map((line) => line.split('\t'))
      .map(([id, kind, ...rest]) => [id, kind === 'form' ? { form: rest.join('\t') } : { error: rest.join('\t') }])
  );
  const verdict = judgeEmulatorForms(`${name} (${cases.length} casos)`, cases, results, sabotage);
  console.log(verdict.lines.join('\n'));
  ok &&= verdict.ok;
  if (sabotage) hits += EMULATOR_FORM_SABOTAGES[sabotage].filter((id) => cases.some((c) => c.id === id)).length;
}
if (sabotage && hits === 0) {
  console.error(`Ningún diseño cubre los casos del sabotaje ${sabotage}.`);
  ok = false;
}
console.log(ok ? '\nVERDE' : '\nROJO');
process.exit(ok ? 0 : 1);
