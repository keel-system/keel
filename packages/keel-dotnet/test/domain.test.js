// El DOMINIO que emite keel-dotnet, sobre el árbol en memoria de las fixtures compartidas. Lo que solo se ve
// ejecutándolo (la escala normalizada, el rechazo con 400, la transición negada con 409) lo miden las sondas
// de `npm run cs-check` (scripts/probes/DomainProbes); aquí va lo que se juzga sin SDK:
//   · PARIDAD: los errores que el dominio puede lanzar —clase, `code` y status— son los que EMITEN keel-spring
//     y keel-nest para el mismo diseño, y el gate del formato vigila los mismos campos;
//   · el gate del formato, EJECUTADO con bash: rojo recién generado, verde con una llamada real;
//   · la forma: cada enum declara el valor que viaja, cada estado lleva todos los miembros de su entidad, la
//     metadata de un evento va en el orden del cable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { WIRE_SHAPES } from '@keel-system/keel-core/gen/wire';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { FIXTURES_DIR, fixtureNames, planFixture } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';
import { domainMembers } from '../src/scaffold/entities.js';
import { csMember } from '../src/scaffold/render.js';

const fixtures = fixtureNames();
const plans = new Map();
for (const name of fixtures) plans.set(name, await planFixture(name));

function otherPlan(planService, name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planService({ manifest, layers, workspace: FIXTURES_DIR }).files;
}

// ─── Paridad de errores ──────────────────────────────────────────────────────────────────────────

/** Los errores de dominio que emite keel-spring: clase → { code, http }. La misma lectura que keel-nest. */
function springErrors(files) {
  const errors = new Map();
  for (const file of files) {
    if (!/\/domain\/errors\/\w+\.java$/.test(file.path)) continue;
    const name = path.basename(file.path, '.java');
    const fixed = /super\(message, "([A-Z0-9_]+)", (\d+), null\)/.exec(file.content);
    const dynamic = /super\(message, "([A-Z0-9_]+)", httpStatus, null\)/.exec(file.content);
    const transition = /"(INVALID_STATE_TRANSITION)", (\d+), null\)/.exec(file.content);
    if (fixed) errors.set(name, { code: fixed[1], http: Number(fixed[2]) });
    else if (dynamic) errors.set(name, { code: dynamic[1], http: 'dinámico' });
    else if (transition) errors.set(name, { code: transition[1], http: Number(transition[2]) });
  }
  return errors;
}

/** Los mismos, de lo que emite keel-nest. */
function nestErrors(files) {
  const errors = new Map();
  for (const file of files) {
    if (!/^src\/domain\/errors\/.+\.ts$/.test(file.path)) continue;
    const name = /export (?:abstract )?class (\w+)/.exec(file.content)?.[1];
    const code = /code: '([A-Z0-9_]+)'/.exec(file.content)?.[1];
    if (!name || !code) continue;
    const http = /httpStatus: (\d+)/.exec(file.content)?.[1];
    errors.set(name, { code, http: http ? Number(http) : 'dinámico' });
  }
  return errors;
}

/** Los mismos, de lo que emite keel-dotnet. */
function dotnetErrors(files) {
  const errors = new Map();
  for (const file of files) {
    if (!/\.Domain\/Errors\/\w+\.cs$/.test(file.path)) continue;
    const name = /public (?:sealed |abstract )?class (\w+)/.exec(file.content)?.[1];
    const match = /code: "([A-Z0-9_]+)", httpStatus: (\d+|httpStatus)\)/.exec(file.content);
    if (!name || !match) continue;
    errors.set(name, { code: match[1], http: match[2] === 'httpStatus' ? 'dinámico' : Number(match[2]) });
  }
  return errors;
}

const sorted = (map) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));

for (const name of fixtures) {
  test(`${name}: los errores del dominio (clase, code y status) son los que emiten keel-nest y keel-spring`, () => {
    const dotnet = dotnetErrors(plans.get(name).files);
    assert.ok(dotnet.size > 0, 'keel-dotnet emite errores para este diseño');
    assert.deepEqual(sorted(dotnet), sorted(nestErrors(otherPlan(planNest, name))));
    // InvalidValueException es la traducción explícita de la IllegalArgumentException de los constructores
    // compactos de Java, que keel-spring convierte en 400 VALIDATION_ERROR en su API (como en keel-nest).
    dotnet.delete('InvalidValueException');
    assert.deepEqual(sorted(dotnet), sorted(springErrors(otherPlan(planSpring, name))));
  });
}

// ─── El gate del formato ─────────────────────────────────────────────────────────────────────────

/** Los sujetos (`Entidad.campo`) de un check-domain-guards.sh. */
const subjects = (script) => [...script.matchAll(/^guard '([^']+)'/gm)].map((match) => match[1]);

for (const name of fixtures) {
  test(`${name}: el gate del formato vigila los mismos campos que el de keel-nest y el de keel-spring`, () => {
    const gate = (files) => files.find((file) => file.path === 'infra/check-domain-guards.sh');
    const dotnet = gate(plans.get(name).files);
    const nest = gate(otherPlan(planNest, name));
    const spring = gate(otherPlan(planSpring, name));
    assert.equal(Boolean(dotnet), Boolean(nest), 'los tres generan el gate, o ninguno');
    assert.equal(Boolean(dotnet), Boolean(spring), 'los tres generan el gate, o ninguno');
    if (dotnet) {
      assert.deepEqual(subjects(dotnet.content), subjects(nest.content));
      assert.deepEqual(subjects(dotnet.content), subjects(spring.content));
    }
  });
}

const bash = spawnSync('bash', ['--version']).status === 0;

function writeTree(files) {
  const dir = tmpDir('keel-dotnet-guards-');
  for (const file of files) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  return dir;
}

const runGate = (dir) => spawnSync('bash', ['infra/check-domain-guards.sh'], { cwd: dir, encoding: 'utf8' });
const CALLER = 'src/ProductCatalog.Application/SkuNormalizer.cs';
const caller = (call) => `using ProductCatalog.Domain.ValueObject;

namespace ProductCatalog.Application;

public static class SkuNormalizer
{
    public static string Normalize(string sku)
    {
        var normalized = sku.Trim().ToUpperInvariant();
        ${call}
        return normalized;
    }
}
`;

test('el gate del formato: rojo recién generado nombrando el campo; una llamada en un comentario no cuenta', { skip: !bash && 'sin bash' }, () => {
  const dir = writeTree(plans.get('product-catalog').files);
  const fresh = runGate(dir);
  assert.equal(fresh.status, 1, fresh.stdout);
  assert.match(fresh.stdout, /Product\.sku: nadie llama a SKUFormat\.Validate/);
  fs.writeFileSync(path.join(dir, CALLER), caller('// SKUFormat.Validate(normalized);'));
  assert.equal(runGate(dir).status, 1, 'una llamada en un comentario no cuenta');
  fs.writeFileSync(path.join(dir, CALLER), caller('/// SKUFormat.Validate(normalized);'));
  assert.equal(runGate(dir).status, 1, 'ni en un comentario de documentación');
});

test('el gate del formato: verde con una llamada real; sin la clase generada, lo dice en vez de pedir la llamada', { skip: !bash && 'sin bash' }, () => {
  const dir = writeTree(plans.get('product-catalog').files);
  fs.writeFileSync(path.join(dir, CALLER), caller('SKUFormat.Validate(normalized);'));
  const green = runGate(dir);
  assert.equal(green.status, 0, green.stdout);
  assert.match(green.stdout, /valueTypeFormat {6}OK/);
  fs.rmSync(path.join(dir, 'src/ProductCatalog.Domain/ValueObject/SKUFormat.cs'));
  const missing = runGate(dir);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /no existe src\/ProductCatalog\.Domain\/ValueObject\/SKUFormat\.cs — lo genera build/);
});

// ─── La forma ────────────────────────────────────────────────────────────────────────────────────

test('cada enum declara el valor del diseño que viaja, y su miembro es un identificador C#', () => {
  for (const [name, { model, files }] of plans) {
    for (const enumDef of model.enums) {
      const file = files.find((f) => f.path.endsWith(`/Enums/${enumDef.name}.cs`));
      assert.ok(file, `${name}: falta el enum ${enumDef.name}`);
      for (const { literal } of enumDef.values) {
        assert.match(file.content, new RegExp(`\\[JsonStringEnumMemberName\\("${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)\\]\\n {4}[A-Za-z_]\\w*,`), `${name}: ${enumDef.name}.${literal}`);
      }
    }
  }
});

test('el estado de rehidratación lleva todos los miembros de su entidad, y la entidad no tiene setters públicos', () => {
  for (const [name, { model, files }] of plans) {
    for (const entity of model.entities) {
      const file = files.find((f) => f.path.endsWith(`/${entity.name}.cs`) && /Domain\/(Aggregate|Entity)\//.test(f.path));
      assert.ok(file, `${name}: falta la entidad ${entity.name}`);
      const state = file.content.slice(file.content.indexOf(`class ${entity.name}State`), file.content.indexOf(`class ${entity.name}\n`));
      for (const member of domainMembers(model, entity)) {
        assert.match(state, new RegExp(`public required \\S+ ${csMember(member.name)} \\{ get; init; \\}`), `${name}: ${entity.name}State.${member.name}`);
      }
      assert.doesNotMatch(file.content, /\{ get; set; \}/, `${name}: ${entity.name} con un setter público`);
    }
  }
});

test('la transición del lifecycle usa los miembros C# del enum, no las constantes de Java', () => {
  const { files } = plans.get('notification-mailer');
  const template = files.find((f) => f.path.endsWith('/Aggregate/Template.cs')).content;
  assert.match(template, /\[TemplateStatus\.Draft\] = \[TemplateStatus\.Active\],/);
  assert.match(template, /\[TemplateStatus\.Retired\] = \[\],/);
  assert.doesNotMatch(template, /TemplateStatus\.DRAFT/);
});

test('la EventMetadata declara sus claves en el orden del cable', () => {
  const { files } = plans.get('stock-reservation');
  const metadata = files.find((f) => f.path.endsWith('/Events/EventMetadata.cs')).content;
  const params = metadata.slice(metadata.indexOf('record EventMetadata('), metadata.indexOf(')\n{'));
  const declared = [...params.matchAll(/ (\w+)(?:,|$)/gm)].map(([, member]) => member);
  assert.deepEqual(declared, WIRE_SHAPES.eventMetadata.map(csMember));
});

test('un value object con escala la normaliza con Decimals.SetScale y su igualdad compara por valor', () => {
  const { files } = plans.get('product-catalog');
  const money = files.find((f) => f.path.endsWith('/ValueObject/Money.cs')).content;
  assert.match(money, /Amount = Decimals\.SetScale\(amount, 2\);/);
  assert.match(money, /ValueEquality\.Same\(Amount, other\.Amount\)/);
  const decimals = files.find((f) => f.path.endsWith('/Support/Decimals.cs')).content;
  assert.match(decimals, /new decimal\(0, 0, 0, false, \(byte\)scale\)/, 'sin sumar el cero con escala, decimal.Round no la sube');
});

test('la expresión del diseño se ancla al valor ENTERO con \\z, no con $', () => {
  const { files } = plans.get('product-catalog');
  const format = files.find((f) => f.path.endsWith('/ValueObject/SKUFormat.cs')).content;
  assert.ok(format.includes('[GeneratedRegex(@"^(?:^[A-Z]{3}-[0-9]{4}$)\\z", RegexOptions.CultureInvariant)]'), format);
});

test('el dominio no conoce ASP.NET Core ni la persistencia', () => {
  for (const [name, { files }] of plans) {
    for (const file of files.filter((f) => /\.Domain\//.test(f.path) && f.path.endsWith('.cs'))) {
      assert.doesNotMatch(file.content, /Microsoft\.(AspNetCore|EntityFrameworkCore)/, `${name}: ${file.path}`);
    }
  }
});
