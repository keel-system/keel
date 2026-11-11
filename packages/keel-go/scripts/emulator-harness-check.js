#!/usr/bin/env node
// EJECUTA el `TokenAs` y el `TokenWithScope` que build emite en tests/integration/credentials_test.go contra el EMULADOR
// del proveedor (incremento 4.3 de PLAN-PROVEEDOR-IDENTIDAD.md) y compara la petición que arman con la de referencia
// (`emulatorPersonaForm`, `emulatorScopedForm`): casos EMU-F-* de keel-core/test/helpers/emulator-form-cases.js, los
// mismos en los cuatro generadores. La petición vive en dos funciones libres (`personaToken`, `scopedToken`), que se sacan
// del archivo emitido tal como salen y se ejecutan con `go run`, con el transporte sustituido por uno que devuelve el
// formulario codificado. Sin contenedores ni red: que el emulador dé el token pedido lo mide `emulator-check` de keel-core.
//
//   node packages/keel-go/scripts/emulator-harness-check.js [--sabotage=persona-shape|scope-unsorted]
//
// Necesita Go. Con sabotaje, verde = cae en exactamente sus casos.

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

// Cada sabotaje rompe el Go emitido conservando su forma (sigue compilando).
const BREAK = {
  'persona-shape': (source) => source.replace('shape := "norole"', 'shape := "nobody"'),
  'scope-unsorted': (source) => source.replace('wanted := slices.Compact(slices.Sorted(slices.Values(values)))\n\tif len(wanted) >', 'wanted := slices.Compact(values)\n\tif len(wanted) >')
};

if (sabotage && !EMULATOR_FORM_SABOTAGES[sabotage]) {
  console.error(`No hay ningún sabotaje '${sabotage}'. Los hay: ${Object.keys(EMULATOR_FORM_SABOTAGES).join(', ')}.`);
  process.exit(2);
}
if (spawnSync('go', ['version']).status !== 0) {
  console.error('No hay Go en el PATH.');
  process.exit(2);
}

/** La declaración que empieza en `signature`, con su cuerpo entero. */
function declaration(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`no está «${signature}» en credentials_test.go`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(start, i + 1);
  }
  throw new Error(`«${signature}» sin cerrar`);
}

const go = (value) => JSON.stringify(value);

function call(testCase) {
  if (testCase.kind === 'scoped') return `scopedToken(ctx, ${go(testCase.role)}, []string{${testCase.values.map(go).join(', ')}})`;
  const present = Object.entries(testCase.claims).filter(([, value]) => value !== null);
  const without = Object.entries(testCase.claims).filter(([, value]) => value === null).map(([name]) => go(name));
  const claims = present.map(([name, value]) => `${go(name)}: ${go(value)}`);
  return `personaToken(ctx, Persona{Sub: ${go(testCase.sub)}, Claims: map[string]string{${claims.join(', ')}}, Without: []string{${without.join(', ')}}, Role: ${go(testCase.role ?? '')}})`;
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

  let source = files.find((file) => file.path.endsWith('/credentials_test.go')).content;
  if (sabotage) source = BREAK[sabotage](source);
  const pieces = [];
  if (persona) {
    pieces.push(declaration(source, 'type Persona struct'));
    pieces.push(declaration(source, 'var personaClaimNames = []string'));
    pieces.push(declaration(source, 'func personaToken('));
  }
  if (scopedRole) {
    pieces.push(declaration(source, 'func scopedToken('));
    pieces.push(declaration(source, 'func javaStringHash('));
  }

  const program = `package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"unicode/utf16"
)

var (
	_ = errors.New
	_ = slices.Contains[[]string]
	_ = strings.Join
	_ = utf16.Encode
)

func cachedToken(key string, mint func() (string, error)) (string, error) { return mint() }

func requestToken(ctx context.Context, form url.Values) (string, error) { return form.Encode(), nil }

func credential(name, fallback string) string { return fallback }

${pieces.join('\n\n')}

func run(id string, call func() (string, error)) {
	form, err := call()
	if err != nil {
		fmt.Printf("%s\\terror\\t%s\\n", id, strings.ReplaceAll(err.Error(), "\\n", " "))
		return
	}
	fmt.Printf("%s\\tform\\t%s\\n", id, form)
}

func main() {
	ctx := context.Background()
${cases.map((testCase) => `\trun(${go(testCase.id)}, func() (string, error) { return ${call(testCase)} })`).join('\n')}
}
`;
  const dir = tmpDir('keel-emulator-go-');
  const file = path.join(dir, 'main.go');
  fs.writeFileSync(file, program);
  const run = spawnSync('go', ['run', file], { encoding: 'utf8', cwd: dir, env: { ...process.env, GO111MODULE: 'off' } });
  if (run.status !== 0) {
    console.error(`${name}: el Go no compila o no corre:\n${run.stderr}\n${program}`);
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
if (sabotage && hits === 0) {
  console.error(`Ningún diseño cubre los casos del sabotaje ${sabotage}.`);
  ok = false;
}
console.log(ok ? '\nVERDE' : '\nROJO');
process.exit(ok ? 0 : 1);
