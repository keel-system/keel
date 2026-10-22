import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { CHARACTERIZED_FILE, SCENARIOS_FILE, loadProvenance, readCharacterization } from 'keel-core';
import { loadSandbox, containerOf } from './sandbox.js';
import { verifyCriterion } from './probe.js';
import { toolRequestAsync } from './tool-http.js';
import { dbHash, restoreSnapshot } from './mongo.js';
import { loadContractMap, plannedFlows, sealDocument } from './characterize.js';
import { renderFidelity } from './fidelity.js';

// `keel-recover characterize` sobre el workspace: qué lee (legacy/<servicio>/ y specs/<servicio>/),
// cómo habla con el legacy (el contenedor de herramientas del sandbox, como probe) y qué escribe.
//
//   specs/<servicio>/characterized.yaml           el sello que lee `keel validate --ready`
//   legacy/<servicio>/recordings/characterization/ un JSON por flujo: pasos, status y datos
//   legacy/<servicio>/FIDELITY.md                  el informe de fidelidad

const readYaml = (file) => (fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, 'utf8')) : null);

/**
 * Todo lo que hace falta para ejecutar, sin tocar ningún contenedor. `errors` no vacío = no se
 * puede caracterizar (no es un flujo en rojo: es que no hay contra qué).
 */
export function prepareCharacterization(legacyArg, { spec = null } = {}) {
  const legacyDir = path.resolve(legacyArg);
  const errors = [];
  const legacyDoc = readYaml(path.join(legacyDir, 'legacy.yaml'));
  const name = legacyDoc?.name ?? path.basename(legacyDir);
  const specDir = spec ? path.resolve(spec) : path.resolve(legacyDir, '..', '..', 'specs', name);

  const sandbox = loadSandbox(path.join(legacyDir, 'sandbox'));
  errors.push(...sandbox.errors);
  const { map, errors: mapErrors } = loadContractMap(path.join(legacyDir, 'contract-map.yaml'));
  errors.push(...mapErrors);

  const scenariosFile = path.join(specDir, SCENARIOS_FILE);
  const scenariosText = fs.existsSync(scenariosFile) ? fs.readFileSync(scenariosFile, 'utf8') : null;
  if (scenariosText === null) errors.push(`no existe ${scenariosFile}: los escenarios de caracterización son del paso 4 (/keel-recover)`);
  const provenance = loadProvenance(specDir);
  if (!provenance.present) errors.push(`no hay provenance.yaml en ${specDir}: characterize es para un diseño recuperado`);
  errors.push(...provenance.errors);

  const marks = readCharacterization(scenariosText, provenance.doc).flows;
  const planned = scenariosText === null ? [] : plannedFlows(scenariosText, marks);
  if (scenariosText !== null && planned.length === 0) errors.push('ningún flujo marcado keep, fix o frontier: no hay nada que ejecutar contra el legacy');
  return {
    errors,
    name,
    legacyDir,
    specDir,
    sandbox,
    map,
    scenariosText,
    provenance: provenance.doc,
    legacy: { name: provenance.doc?.legacy?.name ?? name, commit: provenance.doc?.legacy?.commit ?? null },
    planned,
    newFlows: marks.filter((f) => f.mark === 'new').length,
  };
}

/**
 * El contexto de ejecución contra el legacy: cada flujo parte del snapshot de verify, y tras
 * restaurar la base su huella tiene que ser la del snapshot (si no, el flujo partiría del estado
 * que dejó el anterior y su verde no diría nada).
 */
export function legacyContext(prep, rt, { snapshotHash = null } = {}) {
  const { spec } = prep.sandbox;
  const tool = containerOf(prep.sandbox, spec.tool.service);
  const db = spec.database ? containerOf(prep.sandbox, spec.database.service) : null;
  return {
    side: prep.map.legacy,
    sideName: 'legacy',
    semantics: prep.map.semantics ?? {},
    base: spec.app.base,
    random: () => crypto.randomBytes(12).toString('hex'),
    http: async ({ method, url, headers, body }) => {
      const r = await toolRequestAsync(rt, tool, { method, url, headers, body, timeoutSeconds: 20 });
      return { status: r.status, body: r.body };
    },
    reset: async () => {
      if (!db) return { ok: true };
      const r = restoreSnapshot(rt, db, spec.database.name);
      if (!r.ok) return r;
      if (!snapshotHash) return { ok: true };
      const h = dbHash(rt, db, spec.database.name);
      if (!h.ok) return { ok: false, error: `no se pudo leer la huella de la base: ${h.error}` };
      return h.value === snapshotHash ? { ok: true } : { ok: false, error: `la base restaurada (${h.value}) no es el snapshot de verify (${snapshotHash})` };
    },
  };
}

/** `verify.json` en verde con snapshot: la misma condición que probe. */
export function verifyGate(prep) {
  return verifyCriterion(prep.sandbox);
}

/** Lo que se escribe tras una ejecución completa (con `seal: false`, solo las grabaciones). */
export function writeCharacterization(prep, records, { seal = true, snapshotHash = null } = {}) {
  const written = [];
  const recDir = path.join(prep.legacyDir, 'recordings', 'characterization');
  fs.mkdirSync(recDir, { recursive: true });
  for (const r of records) {
    const file = path.join(recDir, `${r.id}.json`);
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
    written.push(file);
  }
  if (!seal) return written;

  const doc = sealDocument({ legacy: { ...prep.legacy, snapshot: snapshotHash }, scenariosText: prep.scenariosText, records });
  const sealFile = path.join(prep.specDir, CHARACTERIZED_FILE);
  fs.writeFileSync(
    sealFile,
    `# Lo escribe \`keel-recover characterize\`: los escenarios de caracterización ejecutados contra el legacy,\n# sellados por flujo. No se edita a mano; lo lee el criterio \`characterized\` de \`keel validate --ready\`.\n${YAML.stringify(doc, { lineWidth: 0 })}`
  );
  written.push(sealFile);

  const history = fs.existsSync(path.join(prep.legacyDir, 'recordings', 'coverage.json'))
    ? JSON.parse(fs.readFileSync(path.join(prep.legacyDir, 'recordings', 'coverage.json'), 'utf8'))
    : [];
  const fidelityFile = path.join(prep.legacyDir, 'FIDELITY.md');
  fs.writeFileSync(
    fidelityFile,
    renderFidelity({
      service: prep.name,
      legacy: prep.legacy,
      records,
      newFlows: prep.newFlows,
      provenance: prep.provenance,
      coverage: history.at(-1) ?? null,
      surface: readYaml(path.join(prep.legacyDir, 'surface.yaml')),
      unobserved: readYaml(path.join(prep.legacyDir, 'unobserved.yaml')),
      map: prep.map,
    })
  );
  written.push(fidelityFile);
  return written;
}
