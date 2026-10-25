// El respaldo de la procedencia (src/lib/backing.js): una fila `asked` cita una pregunta CONTESTADA o el cierre, y una
// `measured`, algo grabado que existe. La corrida de control de shop-api dejó «extrapolaciones» del diseñador en su
// reporte, sin pregunta detrás; esto es lo que no las deja pasar por decisiones del humano.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { provenanceBacking } from '../src/lib/backing.js';
import { tmpDir } from './helpers/tmp.js';

function recovery(rows, { questions = [], files = [] } = {}) {
  const root = tmpDir('keel-recover-backing-');
  const legacy = path.join(root, 'legacy', 'svc');
  const spec = path.join(root, 'specs', 'svc');
  fs.mkdirSync(spec, { recursive: true });
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(spec, 'provenance.yaml'), YAML.stringify({ kind: 'provenance', schema: 1, elements: rows }));
  if (questions) fs.writeFileSync(path.join(legacy, 'questions.yaml'), YAML.stringify({ kind: 'questions', schema: 1, questions }));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(legacy, file)), { recursive: true });
    fs.writeFileSync(path.join(legacy, file), '{}');
  }
  return { backing: () => provenanceBacking(spec, legacy, questions ?? []) };
}

const answered = { id: 'fix-status-names', answer: 'Nombres', applied: true };
const open = { id: 'fix-order-amount-max' };

test('asked: cita una pregunta contestada, o el cierre; una sin contestar o ninguna no respalda', () => {
  const { backing } = recovery(
    [
      { element: 'domain.types.OrderStatus', level: 'asked', evidence: '2026-10-23: fix-status-names (Nombres y ciclo de vida)' },
      { element: 'security.cors', level: 'asked', evidence: 'cierre del diseño, gaps clase 15 (listProducts)' },
      { element: 'domain.types.Money', level: 'asked', evidence: 'moneda única: decisions.yaml → structural §3.4' },
      { element: 'domain.entities.OrderMain.fields.orderAmount', level: 'asked', evidence: 'el máximo, según fix-order-amount-max' },
      { element: 'domain.entities.Product.fields.status', level: 'asked', evidence: 'extrapolación: fuera de rango sale 400 y no 422' }
    ],
    { questions: [answered, open] }
  );
  assert.deepEqual(
    backing().asked.map((row) => row.element),
    ['domain.entities.OrderMain.fields.orderAmount', 'domain.entities.Product.fields.status']
  );
});

test('asked: el id se cita entero; un id que es prefijo de otro no cuenta como citado', () => {
  const { backing } = recovery([{ element: 'a', level: 'asked', evidence: 'fix-status-names-v2 (otra pregunta)' }], { questions: [answered] });
  assert.equal(backing().asked.length, 1);
});

test('measured: una grabación que existe, por ruta, por id de sonda o un artefacto del legacy; una inventada no', () => {
  const { backing } = recovery(
    [
      { element: 'p', level: 'measured', evidence: 'recordings/round-0/R0-001.json' },
      { element: 'q', level: 'measured', evidence: 'R0-002 (422)' },
      { element: 'r', level: 'measured', evidence: 'índice único en surface.yaml' },
      { element: 's', level: 'measured', evidence: 'postgres 9.4 en el sandbox (sandbox/verify.json)' },
      { element: 't', level: 'measured', evidence: 'recordings/round-0/R0-099.json' },
      { element: 'u', level: 'measured', evidence: 'lo vi funcionar' },
      { element: 'v', level: 'read', evidence: 'src/A.java:1' }
    ],
    { questions: [], files: ['recordings/round-0/R0-001.json', 'recordings/round-0/R0-002.json', 'surface.yaml', 'sandbox/verify.json'] }
  );
  assert.deepEqual(
    backing().measured.map((row) => row.element),
    ['t', 'u']
  );
});

test('sin questions.yaml no aplica: una recuperación anterior a la herramienta (conduit, a mano) no se juzga así', () => {
  const { backing } = recovery([{ element: 'a', level: 'asked', evidence: 'decidido por el humano' }], { questions: null });
  assert.deepEqual(backing(), { applies: false, asked: [], measured: [] });
});
