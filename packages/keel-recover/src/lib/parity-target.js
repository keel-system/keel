import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadCharacterized, readCharacterization, resolveCharacterized } from 'keel-core';
import { validateAs } from './schema.js';
import { toolRequestAsync } from './tool-http.js';
import { mongoEval } from './mongo.js';
import { plannedFlows, tally } from './characterize.js';
import { prepareCharacterization } from './characterize-legacy.js';
import { TARGET_MARKS, compareRecords, parityVerdict, renderParity } from './parity.js';

// `keel-recover parity legacy/<servicio> --target <target.yaml>` sobre el workspace (paso 7): los mismos
// flujos contra el servicio regenerado, y sus datos comparados con lo que grabó `characterize` del legacy.
//
//   legacy/<servicio>/recordings/parity/<destino>/<FL>.json   cada flujo contra el regenerado
//   legacy/<servicio>/recordings/parity/<destino>.json        la comparación entera
//   legacy/<servicio>/PARITY-<destino>.md                     el informe
//
// El lado del legacy no se vuelve a ejecutar: se lee de recordings/characterization/, y por eso se exige
// su sello al día y en verde. Comparar contra un legacy cuyo diseño no se ha caracterizado no mide nada.

/** El mismo curl, fijado por digest, que los sandboxes de fixture. */
export const TOOL_IMAGE = 'docker.io/curlimages/curl:8.10.1@sha256:fcff5cf7a4b895da7bd2933c914938db2b05d2113fa0d6c55b6d29930408f661';

export function loadTarget(file) {
  let target;
  try {
    target = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { target: null, errors: [err.code === 'ENOENT' ? `no existe ${file}` : `${path.basename(file)} no es YAML: ${err.message}`] };
  }
  const errors = validateAs('target', target ?? {}).map((e) => `${path.basename(file)}: ${e}`);
  return { target: errors.length ? null : target, errors };
}

/** Todo lo que hace falta antes de tocar ningún contenedor; `errors` no vacío = no se puede medir. */
export function prepareParity(legacyArg, { spec = null, targetFile }) {
  const prep = prepareCharacterization(legacyArg, { spec, sandbox: false });
  const errors = [...prep.errors];
  const { target, errors: targetErrors } = loadTarget(path.resolve(targetFile));
  errors.push(...targetErrors);
  if (prep.map && !prep.map.keel) errors.push('contract-map.yaml no tiene lado `keel`: cómo se pide cada operación al servicio regenerado');
  if (errors.length) return { errors };

  const marks = readCharacterization(prep.scenariosText, prep.provenance).flows;
  const seal = resolveCharacterized(loadCharacterized(prep.specDir), prep.scenariosText, marks, prep.legacy.name);
  const stale = [
    !seal.present ? 'no hay sello' : null,
    seal.notRun.length ? `sin ejecutar: ${seal.notRun.join(', ')}` : null,
    seal.changed.length ? `cambiados desde la ejecución: ${seal.changed.join(', ')}` : null,
    seal.failed.length ? `en rojo contra el legacy: ${seal.failed.map((f) => f.id).join(', ')}` : null,
    ...seal.errors,
  ].filter(Boolean);
  if (stale.length) errors.push(`la caracterización del legacy no está al día y en verde (${stale.join('; ')}): pasa antes keel-recover characterize`);

  const recDir = path.join(prep.legacyDir, 'recordings', 'characterization');
  const legacyRecords = [];
  for (const p of prep.planned) {
    const file = path.join(recDir, `${p.id}.json`);
    if (!fs.existsSync(file)) {
      errors.push(`falta la grabación del legacy ${path.relative(prep.legacyDir, file)}`);
      continue;
    }
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (r.sha256 !== p.sha256) errors.push(`la grabación de ${p.id} es de otro texto del flujo: pasa antes keel-recover characterize`);
    legacyRecords.push(r);
  }
  return {
    errors,
    prep,
    target,
    legacyRecords,
    planned: plannedFlows(prep.scenariosText, marks, { marks: TARGET_MARKS }),
    legacyTally: tally(legacyRecords),
  };
}

/** El contenedor de herramientas en la red del regenerado: `{ ok, created, error }`. */
export function ensureTool(rt, target) {
  if (rt.exists(target.tool.container)) {
    if (!rt.running(target.tool.container)) rt.start(target.tool.container);
    return { ok: rt.running(target.tool.container), created: false, error: `${target.tool.container} no arranca` };
  }
  if (!target.tool.network) return { ok: false, created: false, error: `no existe ${target.tool.container} y target.yaml no dice en qué red crearlo (tool.network)` };
  const r = rt.runDetached(['--name', target.tool.container, '--network', target.tool.network, '--entrypoint', 'sleep', TOOL_IMAGE, 'infinity']);
  return r.status === 0 ? { ok: true, created: true } : { ok: false, created: false, error: r.stderr.trim() };
}

const COLLECTIONS = (name) => `var d = db.getSiblingDB(${JSON.stringify(name)}); var cs = d.getCollectionNames().filter(function (c) { return c.indexOf('system.') !== 0; });`;

/** El contexto de ejecución contra el regenerado: cada flujo parte de su base VACÍA, comprobada. */
export function targetContext(target, map, rt) {
  const { database: db, idp } = target;
  return {
    side: map.keel,
    sideName: 'keel',
    semantics: map.semantics ?? {},
    base: target.base,
    random: () => crypto.randomBytes(12).toString('hex'),
    http: async ({ method, url, headers, body }) => {
      const r = await toolRequestAsync(rt, target.tool.container, { method, url, headers, body, timeoutSeconds: 20 });
      return { status: r.status, body: r.body };
    },
    reset: async () => {
      if (!db) return { ok: true };
      const js = `${COLLECTIONS(db.name)} cs.forEach(function (c) { d[c].deleteMany({}); }); print(cs.reduce(function (n, c) { return n + d[c].countDocuments({}); }, 0));`;
      const r = mongoEval(rt, db.container, js, { auth: db.auth ?? null });
      if (!r.ok) return { ok: false, error: `no se pudo vaciar la base del regenerado: ${r.error}` };
      return r.value === '0' ? { ok: true } : { ok: false, error: `la base del regenerado no quedó vacía (${r.value} documentos)` };
    },
    idpToken: idp
      ? async (actor) => {
          const form = new URLSearchParams({
            grant_type: 'password',
            client_id: idp.clientId,
            ...(idp.clientSecret ? { client_secret: idp.clientSecret } : {}),
            username: idp.users?.[actor] ?? actor,
            password: idp.password,
            scope: 'openid',
          }).toString();
          const r = await toolRequestAsync(rt, target.tool.container, {
            method: 'POST',
            url: idp.tokenUrl,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form,
          });
          if (r.status !== 200 || typeof r.body?.access_token !== 'string') {
            throw new Error(`el proveedor OIDC no dio token a ${actor}: status ${r.status}, ${JSON.stringify(r.body).slice(0, 160)}`);
          }
          return r.body.access_token;
        }
      : null,
  };
}

/** Compara y escribe; devuelve `{ comparison, verdict, written }`. */
export function writeParity(pp, records) {
  const { prep, target } = pp;
  const comparison = compareRecords({ legacy: pp.legacyRecords, target: records, planned: pp.planned, map: prep.map });
  const verdict = parityVerdict(records, comparison);
  const dir = path.join(prep.legacyDir, 'recordings', 'parity', target.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const r of records) fs.writeFileSync(path.join(dir, `${r.id}.json`), `${JSON.stringify(r, null, 2)}\n`);
  const summary = path.join(prep.legacyDir, 'recordings', 'parity', `${target.name}.json`);
  fs.writeFileSync(summary, `${JSON.stringify({ target: target.name, compared: comparison.compared, verdict, rows: comparison.rows }, null, 2)}\n`);
  written.push(summary);
  const report = path.join(prep.legacyDir, `PARITY-${target.name}.md`);
  fs.writeFileSync(report, renderParity({ service: prep.service, legacy: prep.legacy, target, records, legacyTally: pp.legacyTally, comparison, verdict }));
  written.push(report);
  return { comparison, verdict, written };
}
