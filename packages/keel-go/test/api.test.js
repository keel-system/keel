// La API que emite keel-go (`internal/httpapi`), juzgada sobre el texto en todas las fixtures. Que compila, que vet y
// staticcheck no tienen nada que decir y que el contrato se cumple lo miden las pruebas emitidas api_test.go y
// edge_test.go en `npm run go-check` (con sus sabotajes); aquí, lo que se ve sin Go:
//   · los textos de cada fallo salen de keel-core/gen/api-errors.js, y cada categoría del dominio tiene los suyos;
//   · ningún auxiliar de lectura o validación se emite sin usar (staticcheck, U1000) ni se usa sin emitir;
//   · el lector sigue el orden del binding de keel-spring y lee el cuerpo campo a campo, nunca de golpe;
//   · cada operación servida tiene su endpoint, su lector y su fila en la tabla de rutas.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { ERROR_BASES } from '@keel-system/keel-core/gen/error-bases';
import { DOMAIN_ERROR_RESPONSES, FRAMEWORK_RESPONSES as FW } from '@keel-system/keel-core/gen/api-errors';
import { planService } from '../src/scaffold/index.js';
import { endpointName, readerName, servedRoutes } from '../src/scaffold/endpoints.js';
import { errorKindFor } from '../src/lib/go-projection.js';
import { stripCommentsAndStrings } from '../src/lib/go-source.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));
const plans = new Map(fixtures.map((name) => [name, planService({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR })]));
const httpapiFiles = (plan) => plan.files.filter((file) => /^internal\/httpapi\/[^/]+\.go$/.test(file.path) && !file.path.endsWith('_test.go'));
const fileOf = (plan, name) => plan.files.find((file) => file.path === `internal/httpapi/${name}.go`)?.content;

test('product-catalog: errors.go responde con los textos de api-errors.js y cada categoría del dominio tiene los suyos', () => {
  const errors = fileOf(plans.get('product-catalog'), 'errors');
  for (const key of ['invalidBody', 'invalidParams', 'malformed', 'bodyTooLarge', 'internal']) {
    assert.ok(errors.includes(JSON.stringify(FW[key].message)), `${key}: ${FW[key].message}`);
  }
  assert.ok(errors.includes(`"Falta el parámetro '%s' en la petición"`), 'el parámetro ausente con su nombre');
  for (const base of ERROR_BASES) {
    const texts = DOMAIN_ERROR_RESPONSES[base.name];
    assert.ok(errors.includes(`case domain.${errorKindFor(base.http)}:\n\t\treturn ${JSON.stringify(texts.error)}, ${JSON.stringify(texts.fallback)}`), base.name);
  }
  const middleware = fileOf(plans.get('product-catalog'), 'middleware');
  for (const key of ['notFound', 'methodNotAllowed']) assert.ok(middleware.includes(JSON.stringify(FW[key].message)), key);
});

for (const name of fixtures) {
  test(`${name}: ningún auxiliar de la API se emite sin usar ni se usa sin emitir`, () => {
    const plan = plans.get(name);
    const files = httpapiFiles(plan);
    if (files.length === 0) return;
    const code = files.map((file) => stripCommentsAndStrings(file.content)).join('\n');
    const declared = [...code.matchAll(/^func (?:\([^)]*\) )?(\w+)(?:\[[^\]]*\])?\(/gm)].map((match) => match[1]);
    const vars = [...code.matchAll(/^\t?(\w+(?:Text|Pattern\d*))\s+= regexp\.MustCompile/gm)].map((match) => match[1]);
    for (const symbol of [...declared, ...vars]) {
      // Lo exportado y los métodos de una interfaz (Error, Unwrap, Write…) los usa quien está fuera.
      if (/^[A-Z]/.test(symbol)) continue;
      const uses = [...code.matchAll(new RegExp(`\\b${symbol}\\b`, 'g'))].length;
      assert.ok(uses > 1, `${name}: ${symbol} se emite y nadie lo usa (staticcheck U1000)`);
    }
    for (const helper of ['member', 'optionalMember', 'has', 'readObject', 'malformed', 'textLength', 'exceedsDigits', 'pageParam', 'requireParam', 'requiredParam', 'optionalParam', 'optionalText', 'listParam', 'queryValue', 'textUUID', 'textInt32', 'textEnum']) {
      if (new RegExp(`\\b${helper}\\(`).test(code)) assert.ok(declared.includes(helper), `${name}: se usa ${helper} y no se emite`);
    }
  });

  test(`${name}: cada operación servida tiene su endpoint, su lector y su fila`, () => {
    const plan = plans.get(name);
    const served = servedRoutes(plan.model);
    const routes = fileOf(plan, 'routes') ?? '';
    for (const { operation } of served) {
      const code = httpapiFiles(plan).map((file) => file.content).join('\n');
      assert.ok(code.includes(`func (a *api) ${endpointName(operation)}(w http.ResponseWriter, r *http.Request) error {`), `${operation.name}: endpoint`);
      assert.ok(code.includes(`func ${readerName(operation)}(r *http.Request) (msg application.`), `${operation.name}: lector`);
      assert.ok(routes.includes(`{Operation: ${JSON.stringify(operation.name)}, `), `${operation.name}: fila`);
    }
  });
}

test('el lector lee el cuerpo campo a campo, y en el orden de keel-spring: ruta, cuerpo, reglas del cuerpo, query, reglas de los parámetros', () => {
  const plan = plans.get('catalog-extended');
  const code = httpapiFiles(plan).map((file) => file.content).join('\n');
  // Nunca el cuerpo entero sobre el mensaje: json/v2 llama a UnmarshalJSONFrom también con null.
  assert.ok(!/wire\.Unmarshal\(data, &msg\)/.test(code));
  for (const [operation, body] of [...code.matchAll(/^func (read\w+)\(r \*http\.Request\)[^{]*\{\n([\s\S]*?)\n\}$/gm)].map((m) => [m[1], m[2]])) {
    const at = (pattern) => body.search(pattern);
    const order = [at(/r\.PathValue\(/), at(/readObject\(/), at(/inBody\.err\(\)/), at(/(requireParam|queryValue|optionalParam|requiredParam|listParam|optionalText|pageParam)\(/), at(/inParams\.err\(\)/)].filter((i) => i >= 0);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `${operation}: fuera de orden`);
  }
});

test('un PATCH lee sus opcionales como tres estados y valida solo lo que llegó', () => {
  const code = httpapiFiles(plans.get('catalog-extended')).map((file) => file.content).join('\n');
  assert.match(code, /if err = optionalMember\(fields, "name", &msg\.Name\); err != nil \{/);
  // name: patchNotNull → a null es «must not be null»; con valor, su tamaño.
  assert.match(code, /if value, ok := msg\.Name\.Get\(\); ok \{\n\t\tif n := textLength\(value\); [^\n]+\{\n\t\t\tinBody\.add\("name", "size must be between \d+ and \d+"\)\n\t\t\}\n\t\} else if msg\.Name\.IsNull\(\) \{\n\t\tinBody\.add\("name", "must not be null"\)\n\t\}/);
});
