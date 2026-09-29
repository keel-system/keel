// «Diseño listo para generar»: el veredicto que compone lo que otros módulos ya calculan.
//
// Lo que importa probar no es cada fuente —esas tienen sus tests— sino la COMPOSICIÓN: que
// romper una sola pieza del cierre apague su criterio y solo el suyo. Un criterio que se
// enciende con la pieza de otro dice cosas falsas en la checklist, que es justo el documento
// con el que el diseñador retoma una sesión.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { tmpDir } from './helpers/tmp.js';
import { LAYERS, supportedDsl } from '../src/lib/assets.js';
import { READINESS_CRITERIA, assessReadiness } from '../src/lib/readiness.js';
import { applicableReviews } from '../src/lib/reviews.js';
import { GAP_CLASSES, gapInventory } from '../src/lib/gap-classes.js';
import { flowDigests, scenariosDigest } from '../src/lib/flow-review.js';
import { DECISIONS_FILE, FLOW_REVIEW_FILE, GAPS_FILE, REVIEW_FILE, SCENARIOS_FILE } from '../src/lib/spec-files.js';
import { validateService } from '../src/lib/validate-service.js';
import { validate } from '../src/commands/validate.js';

const DSL = supportedDsl()[0];
const VERSION = '1.0.0';

const DOMAIN = `
entities:
  Invoice:
    fields:
      id:    { type: uuid, id: true, generated: true }
      total: { type: decimal, required: true }
`;

const USE_CASES = `
operations:
  createInvoice:
    description: Da de alta una factura.
    kind: command
    internal: true
    input:
      fields:
        total: { type: decimal, required: true }
    output: { entity: Invoice }
`;

const MATRIX = `## Matriz de cobertura

| Operación | Flujos | Superficie |
|---|---|---|
| createInvoice | FL-INV-001 | interna |
`;

function scenariosText({ stamp = VERSION, matrix = true, emptyRow = false } = {}) {
  const table = emptyRow ? MATRIX.replace('| createInvoice | FL-INV-001 |', '| createInvoice | todos |') : MATRIX;
  return (
    `# Escenarios de validación — billing\n\n> specs/billing v${stamp}. Contrato de equivalencia.\n\n` +
    (matrix ? `${table}\n` : '') +
    '## Flujos\n\n### FL-INV-001: alta de una factura\n**Given**: nada.\n**When**: `createInvoice`\n**Then**:\n1. Se crea la factura.\n'
  );
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * Un workspace con `specs/billing` LISTO, salvo lo que se rompa por opción. Cada opción
 * rompe una sola pieza del cierre, y los derivados se calculan sobre el texto FINAL de los
 * escenarios: si no, cambiar el sello de los escenarios caducaría también el careo y el
 * test no sabría qué criterio mide.
 */
function workspace({
  domain = DOMAIN,
  useCases = USE_CASES,
  scenarioStamp = VERSION,
  matrix = true,
  emptyRow = false,
  scenarios = true,
  flowReview = true,
  review = 'full',
  gaps = 'full',
  gapsStamp = VERSION,
  // Quién firma la revisión y el barrido. `null` = el autor (sin reviewedBy): --ready lo rechaza.
  reviewedBy = 'keel-design-review',
  sweptBy = 'keel-gap-sweep',
  designStamp = VERSION,
  decisions = null,
  structural = true,
  structuralStamp = VERSION,
  underSpecs = true
} = {}) {
  const root = tmpDir('keel-readiness-');
  const dir = underSpecs ? path.join(root, 'specs', 'billing') : path.join(root, 'billing');

  write(
    path.join(dir, 'service.keel.yaml'),
    [
      `keel: "${DSL}"`,
      'service:',
      '  name: billing',
      `  version: ${VERSION}`,
      '  description: Gestiona la facturación de pedidos.',
      'layers:',
      '  domain: domain.keel.yaml',
      '  use-cases: use-cases.keel.yaml'
    ].join('\n') + '\n'
  );
  write(path.join(dir, 'domain.keel.yaml'), domain);
  write(path.join(dir, 'use-cases.keel.yaml'), useCases);

  const text = scenariosText({ stamp: scenarioStamp, matrix, emptyRow });
  if (scenarios) write(path.join(dir, SCENARIOS_FILE), text);
  if (scenarios && flowReview) {
    write(
      path.join(dir, FLOW_REVIEW_FILE),
      YAML.stringify({
        reviewedAt: VERSION,
        passes: 1,
        scenariosSha256: scenariosDigest(text),
        flows: flowDigests(text).map((entry) => ({ id: entry.id, sha256: entry.digest })),
        findings: []
      })
    );
  }

  if (review) {
    const layers = { domain: YAML.parse(domain), 'use-cases': YAML.parse(useCases) };
    const ids = applicableReviews(layers);
    const findings = (review === 'partial' ? ids.slice(1) : ids).map((id) => ({ id, verdict: 'ok' }));
    write(path.join(dir, REVIEW_FILE), YAML.stringify({ ...(reviewedBy ? { reviewedBy } : {}), reviewedAt: VERSION, findings }));
  }

  // El barrido se deriva del MISMO inventario que usa la CLI, sobre las capas de este workspace:
  // escrito a mano se desincronizaría al primer cambio de gap-classes.js y mediría eso.
  if (gaps) {
    const layers = { domain: YAML.parse(domain), 'use-cases': YAML.parse(useCases) };
    const inventory = gapInventory(layers);
    const coverage = inventory.map((entry) => ({ class: entry.class, units: [...entry.units], result: 'clean' }));
    const findings = [];
    if (gaps === 'partial') {
      // Una unidad sin recorrer; si era la única de su clase, la clase entera queda sin recorrer.
      coverage[0].units.pop();
      if (coverage[0].units.length === 0) coverage.shift();
    }
    if (gaps === 'open') {
      coverage[0].result = 'findings';
      findings.push({ class: coverage[0].class, unit: coverage[0].units[0], what: 'Algo que el diseño no dice todavía', severity: 'gap', state: 'open' });
    }
    write(path.join(dir, GAPS_FILE), YAML.stringify({ ...(sweptBy ? { reviewedBy: sweptBy } : {}), reviewedAt: gapsStamp, coverage, findings }));
  }

  // El registro estructural se deriva del MISMO inventario que la clase 16, como el barrido de arriba.
  // Vive dentro de decisions.yaml, así que se funde con lo que el caso quiera escribir ahí.
  const decisionsDoc = decisions === null ? {} : YAML.parse(decisions);
  if (structural) {
    const sections = GAP_CLASSES[16].units({ domain: YAML.parse(DOMAIN), 'use-cases': YAML.parse(useCases) });
    decisionsDoc.structural = sections.map((section) => ({
      section,
      chosen: 'lo que se eligió',
      discarded: 'la alternativa',
      reason: 'Se preguntó con la consecuencia observable delante.',
      since: structuralStamp
    }));
  }
  if (Object.keys(decisionsDoc).length > 0) write(path.join(dir, DECISIONS_FILE), YAML.stringify(decisionsDoc));

  if (designStamp) {
    write(path.join(root, 'docs', 'billing', 'DESIGN.md'), `# billing\n\n> specs/billing v${designStamp}. Documento de diseño.\n`);
  }
  return dir;
}

const failing = (result) =>
  result.criteria
    .filter((entry) => !entry.ok)
    .map((entry) => entry.id)
    .sort();

test('el diseño de partida está listo: si no lo estuviera, los demás casos no medirían nada', () => {
  const result = assessReadiness(workspace());
  assert.deepEqual(failing(result), [], JSON.stringify(result.criteria, null, 2));
  assert.equal(result.ready, true);
  assert.deepEqual(result.service, { name: 'billing', version: VERSION });
  assert.deepEqual(
    result.criteria.map((entry) => entry.id),
    READINESS_CRITERIA.map((entry) => entry.id),
    'todos los criterios, en el orden del catálogo'
  );
  // Un criterio cumplido no arrastra detalle ni comando: la checklist no dice qué hacer con lo hecho.
  assert.ok(result.criteria.every((entry) => entry.detail === null && entry.fix === null));
});

test('un diseño válido sin nada del cierre: generable, pero no listo', () => {
  const dir = workspace({ scenarios: false, review: null, gaps: null, designStamp: null });
  assert.equal(validateService(dir).ok, true, 'build lo aceptaría');
  const result = assessReadiness(dir);
  assert.equal(result.ready, false);
  assert.deepEqual(failing(result), ['coverage-matrix', 'design-doc', 'flow-review', 'gaps', 'review', 'scenarios']);
});

// Cada rotura apaga SU criterio y ningún otro.
// Sin `internal: true`, el command queda expuesto y sin errores declarados: qué contesta cuando
// no se puede aplicar lo decidiría el generador (CHK-USECASES-COMMAND-NO-ERRORS, `undecided`).
const EXPOSED_USE_CASES = USE_CASES.replace('    internal: true\n', '');
const ORPHAN_QUERY = EXPOSED_USE_CASES.replace('    kind: command\n', '    kind: query\n');
const SENSITIVE_DOMAIN = DOMAIN.replace(
  'total: { type: decimal, required: true }',
  'total: { type: decimal, required: true, sensitive: true }'
);

const ROTURAS = [
  ['validation', { useCases: USE_CASES.replace('output: { entity: Invoice }', 'output: { entity: Missing }') }],
  // Una aceptación de una obligación que el catálogo no tiene: el archivo es válido y se lee (el
  // registro estructural sigue ahí), pero la aceptación no. Un archivo ilegible apagaría los dos.
  [
    'obligations',
    { decisions: 'decisions:\n  - { id: OBL-NO-EXISTE, scope: use-cases, reason: una obligación inventada para el test, since: 1.0.0 }\n' }
  ],
  ['structural', { structural: false }],
  ['structural', { structuralStamp: '0.9.0' }],
  ['review', { review: 'partial' }],
  ['review', { review: null }],
  // Completa y vigente, pero escrita por el autor: sin la firma del agente de contexto limpio.
  ['review', { reviewedBy: null }],
  ['gaps', { gaps: null }],
  ['gaps', { gaps: 'partial' }],
  ['gaps', { gaps: 'open' }],
  ['gaps', { gapsStamp: '0.9.0' }],
  ['gaps', { sweptBy: null }],
  ['scenarios', { scenarioStamp: '0.9.0' }],
  ['coverage-matrix', { matrix: false }],
  // La operación tiene fila, pero la fila no cita ningún flujo (CHK-SCEN-MATRIX-EMPTY-ROW).
  ['coverage-matrix', { emptyRow: true }],
  ['flow-review', { flowReview: false }],
  ['design-doc', { designStamp: '0.9.0' }],
  ['design-doc', { designStamp: null }],
  // Una salida que proyecta un campo sensitive: CHK-MODEL-SENSITIVE-PROJECTED, una decisión no tomada.
  // Antes se rompía quitando `internal`, y eso dejaba además la operación huérfana: una
  // incoherencia que ningún criterio contaba hasta que entró `incoherences`.
  ['undecided', { domain: SENSITIVE_DOMAIN }],
  // Una operación sin endpoint, sin schedule y sin internal: CHK-USECASES-ORPHAN-OP, una
  // incoherencia. Una query y no un command, para que no salte además CHK-USECASES-COMMAND-NO-ERRORS.
  ['incoherences', { useCases: ORPHAN_QUERY }]
];

for (const [id, options] of ROTURAS) {
  test(`romper ${JSON.stringify(options)} apaga '${id}' y solo ese`, () => {
    const result = assessReadiness(workspace(options));
    assert.deepEqual(failing(result), [id], JSON.stringify(result.criteria, null, 2));
    const entry = result.criteria.find((item) => item.id === id);
    assert.ok(entry.detail, 'un criterio en rojo dice por qué');
    assert.ok(entry.fix, 'y con qué se cierra');
  });
}

test('un code declarado que ningún escenario provoca deja la matriz incompleta', () => {
  const conError = USE_CASES.replace(
    '    output: { entity: Invoice }\n',
    '    output: { entity: Invoice }\n    errors:\n      - { code: INVOICE_TOTAL_INVALID, http: 422, when: el total es negativo }\n'
  );
  const result = assessReadiness(workspace({ useCases: conError, review: null }));
  const matrix = result.criteria.find((entry) => entry.id === 'coverage-matrix');
  assert.equal(matrix.ok, false);
  assert.match(matrix.detail, /CHK-SCEN-ERROR-UNCOVERED/);
});

test('sin sección de matriz: ninguna comprobación con id lo ve, y el criterio sí', () => {
  // El hueco que justifica leer la matriz aquí: CHK-SCEN-MATRIX-MISSING-OP cruza las filas,
  // así que un documento sin tabla no tiene filas que cruzar y pasa en silencio.
  const dir = workspace({ matrix: false });
  assert.ok(!validateService(dir).findings.some((finding) => finding.id.startsWith('CHK-SCEN-MATRIX')));
  assert.match(assessReadiness(dir).criteria.find((entry) => entry.id === 'coverage-matrix').detail, /Matriz de cobertura/);
});

test('fuera de specs/ no hay raíz de workspace, y DESIGN.md no se busca en el cwd', () => {
  const result = assessReadiness(workspace({ underSpecs: false }));
  const design = result.criteria.find((entry) => entry.id === 'design-doc');
  assert.equal(design.ok, false);
  assert.match(design.detail, /no vive en specs\//);
});

test('con la validación cortada antes de las referencias, lo que no se evaluó no sale en verde', () => {
  const dir = workspace();
  fs.writeFileSync(path.join(dir, 'use-cases.keel.yaml'), 'operations: {}\n'); // vuelve a ser plantilla
  const result = assessReadiness(dir);
  for (const id of ['validation', 'obligations', 'review', 'coverage-matrix']) {
    assert.equal(result.criteria.find((entry) => entry.id === id).ok, false, id);
  }
  assert.match(result.criteria.find((entry) => entry.id === 'obligations').detail, /sin evaluar/);
});

test('reutiliza la validación que se le pasa y es determinista', () => {
  const dir = workspace({ review: 'partial' });
  const validation = validateService(dir, { wip: false });
  assert.deepEqual(assessReadiness(dir, { validation }), assessReadiness(dir));
  assert.deepEqual(assessReadiness(dir), assessReadiness(dir));
});

test('los criterios tienen id único y título', () => {
  const ids = READINESS_CRITERIA.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(READINESS_CRITERIA.every((entry) => /^[a-z][a-z-]*$/.test(entry.id) && entry.title));
  // Ningún id colisiona con una capa: el estampado los mezcla en listas planas.
  assert.ok(ids.every((id) => !LAYERS.includes(id)));
});

/** Ejecuta `keel validate` en proceso, capturando la salida y el código de salida. */
function runValidate(dir, options) {
  const exitCode = process.exitCode;
  const previous = { log: console.log, warn: console.warn, error: console.error };
  const salida = [];
  console.log = console.warn = console.error = (...args) => salida.push(args.map(String).join(' '));
  process.exitCode = undefined;
  try {
    validate(dir, options);
    return { exitCode: process.exitCode, salida: salida.join('\n') };
  } finally {
    Object.assign(console, previous);
    process.exitCode = exitCode;
  }
}

test('keel validate --ready: checklist entera, exit 1 mientras falte algo y 0 cuando no', () => {
  const noListo = runValidate(workspace({ flowReview: false }), { ready: true });
  assert.equal(noListo.exitCode, 1);
  assert.match(noListo.salida, /\[flow-review\]/);
  assert.ok(noListo.salida.includes(`1 de ${READINESS_CRITERIA.length} criterio(s) sin cumplir`), noListo.salida);
  // La checklist dice también lo que SÍ está: es lo que permite retomar una sesión.
  for (const { id } of READINESS_CRITERIA) assert.ok(noListo.salida.includes(`[${id}]`), id);

  const listo = runValidate(workspace(), { ready: true });
  assert.equal(listo.exitCode, undefined);
  assert.match(listo.salida, /Diseño listo para generar\./);
});

test('keel validate --ready lista ENTERAS las unidades sin recorrer: es el inventario para retomar el barrido', () => {
  const inventory = gapInventory({ domain: YAML.parse(DOMAIN), 'use-cases': YAML.parse(USE_CASES) });
  assert.ok(inventory.length > 0);
  const { salida } = runValidate(workspace({ gaps: null }), { ready: true });
  for (const entry of inventory) {
    assert.ok(salida.includes(`${entry.class}. ${entry.title}: ${entry.units.join(', ')}`), `clase ${entry.class}`);
  }
});

test('keel validate --ready --wip es una contradicción y se rechaza', () => {
  const { exitCode, salida } = runValidate(workspace(), { ready: true, wip: true });
  assert.equal(exitCode, 1);
  assert.match(salida, /contradictorios/);
});

test('keel validate sin --ready no cambia: un diseño no listo sigue siendo válido', () => {
  const { exitCode, salida } = runValidate(workspace({ scenarios: false, review: null, designStamp: null }), {});
  assert.equal(exitCode, undefined);
  assert.match(salida, /Servicio válido/);
});

test('una decisión de un aviso aceptada con su scope deja de faltar; con otro scope, no', () => {
  const aceptar = (scope) =>
    YAML.stringify({
      decisions: [
        {
          id: 'CHK-MODEL-SENSITIVE-PROJECTED',
          scope,
          reason: 'El total solo lo lee el proceso interno que da de alta la factura.',
          since: VERSION
        }
      ]
    });
  const aceptada = assessReadiness(
    workspace({ domain: SENSITIVE_DOMAIN, decisions: aceptar('use-cases.createInvoice.output.total') })
  );
  assert.deepEqual(failing(aceptada), [], JSON.stringify(aceptada.criteria, null, 2));

  // La aceptación es por UNIDAD: sobre otra operación no dice nada de esta, y además es
  // una decisión sobre algo que el diseño no levanta (huérfana), no un error.
  const otra = assessReadiness(workspace({ domain: SENSITIVE_DOMAIN, decisions: aceptar('use-cases.otherOp.output.total') }));
  assert.deepEqual(failing(otra), ['undecided']);
  assert.match(otra.criteria.find((entry) => entry.id === 'undecided').detail, /CHK-MODEL-SENSITIVE-PROJECTED/);
});

test('una incoherencia declarada falso positivo deja de faltar; con otro match o de otra versión, no', () => {
  const declarar = (match, since = VERSION) =>
    YAML.stringify({
      falsePositives: [
        { id: 'CHK-USECASES-ORPHAN-OP', match, reason: 'La invoca un proceso por lotes que el diseño no modela.', since }
      ]
    });
  const excusada = assessReadiness(workspace({ useCases: ORPHAN_QUERY, decisions: declarar('createInvoice') }));
  assert.deepEqual(failing(excusada), [], JSON.stringify(excusada.criteria, null, 2));

  const otra = assessReadiness(workspace({ useCases: ORPHAN_QUERY, decisions: declarar('otherOp') }));
  assert.deepEqual(failing(otra), ['incoherences']);
  assert.match(otra.criteria.find((entry) => entry.id === 'incoherences').detail, /1× CHK-USECASES-ORPHAN-OP/);

  const caducada = assessReadiness(workspace({ useCases: ORPHAN_QUERY, decisions: declarar('createInvoice', '0.9.0') }));
  assert.deepEqual(failing(caducada), ['incoherences']);

  // Una decisión no tomada no se declara falso positivo: se acepta en `decisions`.
  const malPuesta = YAML.stringify({
    falsePositives: [
      { id: 'CHK-MODEL-SENSITIVE-PROJECTED', match: 'createInvoice', reason: 'No es un aviso de incoherencia, es una decisión.', since: VERSION }
    ]
  });
  assert.ok(failing(assessReadiness(workspace({ domain: SENSITIVE_DOMAIN, decisions: malPuesta }))).includes('obligations'));
});
