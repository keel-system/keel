// El DOMINIO que emite keel-go, sobre el árbol en memoria de las fixtures compartidas. Lo que solo se ve
// ejecutándolo (la escala normalizada, el rechazo con 400, la transición negada con 409) lo mide la sonda de
// `npm run go-check` (scripts/probes/domain_probe_test.go); aquí va lo que se juzga sin Go:
//   · PARIDAD: los errores que el dominio puede devolver —`code` y status— son los que EMITEN keel-spring,
//     keel-nest y keel-dotnet para el mismo diseño, y el gate del formato vigila los mismos campos;
//   · el gate del formato, EJECUTADO con bash: rojo recién generado, verde con una llamada real;
//   · la forma: cada enum declara el valor que viaja, cada estado lleva todos los miembros de su entidad, la
//     metadata de un evento va en el orden del cable, y la entidad no expone un campo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { WIRE_SHAPES } from '@keel-system/keel-core/gen/wire';
import { planService } from '../src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { goExported, enumConstant } from '../src/lib/go-projection.js';
import { domainMembers } from '../src/scaffold/entities.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));
const loaded = new Map(fixtures.map((name) => [name, loadService(path.join(FIXTURES_DIR, name))]));
const plans = new Map(fixtures.map((name) => [name, planService({ ...loaded.get(name), workspace: FIXTURES_DIR })]));
const other = (plan, name) => plan({ ...loaded.get(name), workspace: FIXTURES_DIR }).files;
const domainFile = (files, name) => files.find((file) => file.path === `internal/domain/${name}.go`)?.content;

// ─── Paridad de errores ──────────────────────────────────────────────────────────────────────────

/** Los errores de dominio que emite keel-go: el par `code:status` de cada centinela. */
function goErrors(files) {
  const content = domainFile(files, 'errors');
  return new Set(
    [...content.matchAll(/^var Err\w+ = &Error\{kind: (\w+), code: "([A-Z0-9_]+)", status: (\d+)\}$/gm)].map(([, kind, code, status]) =>
      kind === 'KindDomain' && status === '0' ? `${code}:dinámico` : `${code}:${status}`
    )
  );
}

/** Los mismos, de lo que emite keel-dotnet (que ya se mide contra keel-spring y keel-nest). */
function dotnetErrors(files) {
  const errors = new Set();
  for (const file of files) {
    if (!/\.Domain\/Errors\/\w+\.cs$/.test(file.path)) continue;
    const match = /code: "([A-Z0-9_]+)", httpStatus: (\d+|httpStatus)\)/.exec(file.content);
    if (match) errors.add(`${match[1]}:${match[2] === 'httpStatus' ? 'dinámico' : match[2]}`);
  }
  return errors;
}

/** Los de keel-spring, por si keel-dotnet derivara: el `code` y el status de cada clase. */
function springErrors(files) {
  const errors = new Set();
  for (const file of files) {
    if (!/\/domain\/errors\/\w+\.java$/.test(file.path)) continue;
    const fixed = /"([A-Z0-9_]+)", (\d+), null\)/.exec(file.content);
    const dynamic = /super\(message, "([A-Z0-9_]+)", httpStatus, null\)/.exec(file.content);
    if (fixed) errors.add(`${fixed[1]}:${fixed[2]}`);
    else if (dynamic) errors.add(`${dynamic[1]}:dinámico`);
  }
  return errors;
}

// VALIDATION_ERROR es el error del valor que incumple su tipo. keel-go lo necesita también con un enum (su
// `Parse<Enum>` rechaza un valor de fuera), donde los otros lo rechaza el lector del cable sin un error de dominio.
const withoutValidation = (set) => [...set].filter((entry) => !entry.startsWith('VALIDATION_ERROR:')).sort();

for (const name of fixtures) {
  test(`${name}: los errores del dominio (code y status) son los que emiten keel-dotnet y keel-spring`, () => {
    const go = goErrors(plans.get(name).files);
    assert.ok(go.size > 0, 'keel-go emite errores para este diseño');
    assert.deepEqual(withoutValidation(go), withoutValidation(dotnetErrors(other(planDotnet, name))));
    assert.deepEqual(withoutValidation(go), withoutValidation(springErrors(other(planSpring, name))));
    const { model } = plans.get(name);
    const typed = model.valueObjects.length + model.formatTypes.length + model.enums.length > 0;
    assert.equal(go.has('VALIDATION_ERROR:400'), typed, 'VALIDATION_ERROR existe si y solo si hay un tipo propio que lo devuelve');
  });
}

// ─── El gate del formato ─────────────────────────────────────────────────────────────────────────

/** Los sujetos (`Entidad.campo`) de un check-domain-guards.sh. */
const subjects = (script) => [...script.matchAll(/^guard '([^']+)'/gm)].map((match) => match[1]);
const gate = (files) => files.find((file) => file.path === 'infra/check-domain-guards.sh');

for (const name of fixtures) {
  test(`${name}: el gate del formato vigila los mismos campos que el de keel-dotnet y el de keel-spring`, () => {
    const go = gate(plans.get(name).files);
    const dotnet = gate(other(planDotnet, name));
    const spring = gate(other(planSpring, name));
    assert.equal(Boolean(go), Boolean(dotnet), 'los tres generan el gate, o ninguno');
    assert.equal(Boolean(go), Boolean(spring), 'los tres generan el gate, o ninguno');
    if (go) {
      assert.deepEqual(subjects(go.content), subjects(dotnet.content));
      assert.deepEqual(subjects(go.content), subjects(spring.content));
    }
  });
}

const bash = spawnSync('bash', ['--version']).status === 0;

function writeTree(files) {
  const dir = tmpDir('keel-go-guards-');
  for (const file of files) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  return dir;
}

const runGate = (dir) => spawnSync('bash', ['infra/check-domain-guards.sh'], { cwd: dir, encoding: 'utf8' });
const CALLER = 'internal/application/sku.go';
const caller = (call) => `package application

import "product-catalog/internal/domain"

// normalizeSKU normaliza un sku.
func normalizeSKU(sku string) (string, error) {
	normalized := sku
	${call}
	return normalized, nil
}
`;

test('el gate del formato: rojo recién generado nombrando el campo; una llamada en un comentario no cuenta', { skip: !bash && 'sin bash' }, () => {
  const dir = writeTree(plans.get('product-catalog').files);
  const fresh = runGate(dir);
  assert.equal(fresh.status, 1, fresh.stdout);
  assert.match(fresh.stdout, /Product\.sku: nadie llama a SKUFormat\.Validate/);
  fs.writeFileSync(path.join(dir, CALLER), caller('// domain.SKUFormat.Validate(normalized)'));
  assert.equal(runGate(dir).status, 1, 'una llamada en un comentario no cuenta');
});

test('el gate del formato: verde con una llamada real, dentro o fuera del dominio; sin la variable generada, lo dice', { skip: !bash && 'sin bash' }, () => {
  const dir = writeTree(plans.get('product-catalog').files);
  fs.writeFileSync(path.join(dir, CALLER), caller('if err := domain.SKUFormat.Validate(normalized); err != nil {\n\t\treturn "", err\n\t}'));
  const green = runGate(dir);
  assert.equal(green.status, 0, green.stdout);
  assert.match(green.stdout, /valueTypeFormat {6}OK/);
  fs.rmSync(path.join(dir, CALLER));
  fs.writeFileSync(path.join(dir, 'internal/domain/sku.go'), 'package domain\n\nfunc check(sku string) error {\n\treturn SKUFormat.Validate(sku)\n}\n');
  assert.equal(runGate(dir).status, 0, 'la llamada sin calificar, dentro del dominio, también cuenta');
  fs.rmSync(path.join(dir, 'internal/domain/sku_format.go'));
  const missing = runGate(dir);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /no existe internal\/domain\/sku_format\.go — lo genera build/);
});

// ─── La forma ────────────────────────────────────────────────────────────────────────────────────

test('cada enum es un tipo cadena con una constante por valor del diseño, y Parse rechaza lo de fuera', () => {
  for (const [name, { model, files }] of plans) {
    for (const enumDef of model.enums) {
      const file = files.find((f) => f.path.startsWith('internal/domain/') && f.content.includes(`\ntype ${enumDef.name} string\n`));
      assert.ok(file, `${name}: falta el enum ${enumDef.name}`);
      for (const { literal } of enumDef.values) {
        const constant = enumConstant(enumDef.name, literal);
        assert.match(file.content, new RegExp(`\\t${constant} +${enumDef.name} = ${JSON.stringify(literal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`), `${name}: ${constant}`);
      }
      assert.match(file.content, new RegExp(`return "", Errorf\\(ErrInvalidValue, `), `${name}: ${enumDef.name} sin rechazo`);
    }
  }
});

test('el estado de rehidratación lleva todos los miembros de su entidad, y la entidad no exporta ningún campo', () => {
  for (const [name, { model, files }] of plans) {
    for (const entity of model.entities) {
      const content = files.find((f) => f.path.startsWith('internal/domain/') && f.content.includes(`\ntype ${entity.name} struct {\n`))?.content;
      assert.ok(content, `${name}: falta la entidad ${entity.name}`);
      const body = (type) => content.slice(content.indexOf(`type ${type} struct {\n`), content.indexOf('\n}\n', content.indexOf(`type ${type} struct {\n`)));
      const state = body(`${entity.name}State`);
      for (const member of domainMembers(model, entity)) {
        assert.match(state, new RegExp(`\\n\\t${goExported(member.name)} +\\S+`), `${name}: ${entity.name}State.${member.name}`);
      }
      assert.doesNotMatch(body(entity.name), /\n\t[A-Z]/, `${name}: ${entity.name} exporta un campo`);
    }
  }
});

test('la transición del lifecycle usa las constantes Go del enum, no las de Java', () => {
  const template = domainFile(plans.get('notification-mailer').files, 'template');
  assert.match(template, /\tTemplateStatusDraft: +\{TemplateStatusActive\},/);
  assert.match(template, /\tTemplateStatusRetired: +\{\},/);
  assert.doesNotMatch(template, /DRAFT[,}]/);
});

test('la EventMetadata declara sus claves en el orden del cable', () => {
  const metadata = domainFile(plans.get('stock-reservation').files, 'event_metadata');
  const struct = metadata.slice(metadata.indexOf('type EventMetadata struct {'), metadata.indexOf('\n}\n'));
  const declared = [...struct.matchAll(/`json:"(\w+)"`/g)].map(([, wire]) => wire);
  assert.deepEqual(declared, WIRE_SHAPES.eventMetadata);
});

test('un value object con escala la normaliza con Rescale, y su igualdad compara también la escala', () => {
  const money = domainFile(plans.get('product-catalog').files, 'money');
  assert.match(money, /\tamount = amount\.Rescale\(2, wire\.RoundHalfUp\)\n/);
  assert.match(money, /return v\.amount\.Equal\(other\.amount\) &&/);
  assert.match(money, /value, err := NewMoney\(in\.Amount, in\.Currency\)/, 'lo que llega por el cable pasa por el constructor');
});

test('la expresión del diseño se ancla al valor ENTERO: en RE2 `$` ya es el final del texto', () => {
  const format = domainFile(plans.get('product-catalog').files, 'sku_format');
  assert.ok(format.includes('regexp.MustCompile(`^(?:^[A-Z]{3}-[0-9]{4}$)$`)'), format);
});

test('el dominio solo importa la biblioteca estándar, uuid y el paquete del cable', () => {
  for (const [name, { files }] of plans) {
    for (const file of files.filter((f) => f.path.startsWith('internal/domain/') && f.path.endsWith('.go'))) {
      const imports = [...file.content.matchAll(/^\t?(?:import )?"([^"]+)"$/gm)].map(([, spec]) => spec);
      for (const spec of imports) {
        const allowed = !spec.split('/')[0].includes('.') || spec === 'github.com/google/uuid' || spec === `${name}/internal/platform/wire`;
        assert.ok(allowed, `${name}: ${file.path} importa ${spec}`);
      }
    }
  }
});
