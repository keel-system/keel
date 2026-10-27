import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadCharacterized, loadFixtures, readCharacterization, resolveCharacterized } from 'keel-core';
import { validateAs } from './schema.js';
import { toolRequestAsync } from './tool-http.js';
import { databaseAdapter } from './db/index.js';
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
  // El estado de partida de los flujos en el regenerado: el MISMO infra/fixtures.sql que carga su arnés tras vaciar
  // (keel-core/gen/fixtures.js), leído del proyecto. Sin él, la base vacía no es la del legacy restaurado a su snapshot.
  const workspace = path.resolve(prep.legacyDir, '..', '..');
  const fixturesFile = target?.project ? path.join(workspace, target.project, 'infra', 'fixtures.sql') : null;
  const fixturesSql = fixturesFile && fs.existsSync(fixturesFile) ? fs.readFileSync(fixturesFile, 'utf8') : null;
  // Los dos lados tienen que partir del MISMO estado: el que caracterizó el legacy (su snapshot) y el que derivó
  // fixtures.yaml. Con otro snapshot, la paridad compararía flujos que partieron de datos distintos.
  const fixturesDoc = loadFixtures(prep.specDir).doc;
  const sealed = loadCharacterized(prep.specDir).doc?.legacy?.snapshot ?? null;
  if (fixturesDoc?.source?.snapshot && sealed && fixturesDoc.source.snapshot !== sealed) {
    errors.push(`fixtures.yaml es del snapshot ${fixturesDoc.source.snapshot} y la caracterización del ${sealed}: vuelve a derivarlo con keel-recover fixtures`);
  }
  if (fixturesDoc && !fixturesSql) {
    errors.push(`el diseño declara fixtures.yaml y el proyecto no tiene infra/fixtures.sql (${fixturesFile ?? 'target.yaml sin project'}): regenera con build --refresh`);
  }
  // Un `new` sin bloque keel-flow no se ejecuta aquí: la skill no lo exige (no existe en el legacy) y lo mide el arnés del
  // proyecto generado. Se dice en el informe, no se cuenta en rojo (corrida de control de shop-api: 19 así).
  const targetPlanned = plannedFlows(prep.scenariosText, marks, { marks: TARGET_MARKS });
  // Lo mismo un fix con noFlow sin bloque (una carrera: el ejecutor no dispara pasos a la vez), que plannedFlows no planifica.
  const unblockedNew = [
    ...targetPlanned.filter((p) => p.mark === 'new' && !p.flow && /no trae su bloque/.test(p.error ?? '')).map((p) => p.id),
    ...marks.filter((f) => f.proseOnly).map((f) => f.id),
  ];
  return {
    errors,
    prep,
    target,
    fixturesSql,
    legacyRecords,
    planned: targetPlanned.filter((p) => !unblockedNew.includes(p.id)),
    unblockedNew,
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

const KCADM = '/opt/keycloak/bin/kcadm.sh';

/**
 * Da de alta a una persona en el Keycloak del deploy (idempotente): el deploy de keel no trae usuarios fijos —el diseño
 * identifica al llamante por su `sub`—, y hasta el inc. 9 las sembraba a mano un script del laboratorio
 * (`seed-keel-idp.sh`). `session` lleva si ya se abrió la sesión de administración en ese contenedor.
 *
 * `persona` es lo que dice el actor `idp` de contract-map.yaml: su `email` cuando el diseño identifica al llamante por él
 * (`null`, una persona sin email; sin decirlo, `<usuario>@example.com`) y sus `roles` del realm. Hasta la corrida de
 * control de shop-api la persona salía siempre con `<usuario>@example.com` y sin roles: con la identidad en el claim
 * email, el regenerado no la habría reconocido como la del seed.
 */
export function seedPersona(rt, seed, username, password, session = { open: false }, persona = {}) {
  const kc = (args) => rt.exec(seed.container, [KCADM, ...args]);
  if (!session.open) {
    const login = kc(['config', 'credentials', '--server', 'http://localhost:8080', '--realm', 'master', '--user', seed.admin.user, '--password', seed.admin.password]);
    if (login.status !== 0) return { ok: false, error: `no se pudo administrar el realm en ${seed.container}: ${(login.stderr || login.stdout).trim()}` };
    session.open = true;
  }
  const email = persona.email === undefined ? `${username}@example.com` : persona.email;
  // Una persona sin email no lleva la propiedad: el claim no sale en su token.
  const emailArgs = email === null ? [] : ['-s', `email=${email}`];
  const found = kc(['get', 'users', '-r', seed.realm, '-q', `username=${username}`, '-q', 'exact=true', '--fields', 'id,username']);
  if (found.status !== 0) return { ok: false, error: `no se pudo buscar a ${username}: ${found.stderr.trim()}` };
  if (!found.stdout.includes(`"${username}"`)) {
    const created = kc(['create', 'users', '-r', seed.realm, '-s', `username=${username}`, '-s', 'enabled=true', '-s', 'emailVerified=true', ...emailArgs, '-s', `firstName=${username}`, '-s', 'lastName=Test']);
    if (created.status !== 0) return { ok: false, error: `no se pudo dar de alta a ${username}: ${(created.stderr || created.stdout).trim()}` };
  } else if (persona.email !== undefined) {
    // Ya existía (de otra ejecución): el email es el de ESTE actor, no el que tuviera.
    const id = /"id"\s*:\s*"([^"]+)"/.exec(found.stdout)?.[1];
    const updated = id ? kc(['update', `users/${id}`, '-r', seed.realm, '-s', `email=${email ?? ''}`]) : { status: 1, stderr: 'sin id en la respuesta' };
    if (updated.status !== 0) return { ok: false, error: `no se pudo poner el email de ${username}: ${(updated.stderr || updated.stdout).trim()}` };
  }
  for (const role of persona.roles ?? []) {
    const added = kc(['add-roles', '-r', seed.realm, '--uusername', username, '--rolename', role]);
    if (added.status !== 0) return { ok: false, error: `no se pudo dar el rol ${role} a ${username}: ${(added.stderr || added.stdout).trim()}` };
  }
  const reset = kc(['set-password', '-r', seed.realm, '--username', username, '--new-password', password]);
  if (reset.status !== 0) return { ok: false, error: `no se pudo poner la contraseña de ${username}: ${reset.stderr.trim()}` };
  return { ok: true };
}

/** El contexto de ejecución contra el regenerado: cada flujo parte de su base VACÍA, comprobada. */
export function targetContext(target, map, rt, { fixturesSql = null } = {}) {
  const { database: db, idp } = target;
  const seeded = new Set();
  const session = { open: false };
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
      const dba = databaseAdapter(db.tech);
      if (!dba) return { ok: false, error: `no se pudo vaciar la base del regenerado: keel-recover no sabe vaciar ${db.tech}` };
      const r = dba.empty(rt, db.container, { name: db.name, auth: db.auth ?? null });
      if (!r.ok) return { ok: false, error: `no se pudo vaciar la base del regenerado: ${r.error}` };
      if (r.remaining !== '0') return { ok: false, error: `la base del regenerado no quedó vacía (${r.remaining} ${dba.rowNoun})` };
      if (!fixturesSql) return { ok: true };
      const loaded = dba.loadScript(rt, db.container, { name: db.name, auth: db.auth ?? null }, fixturesSql);
      return loaded.ok ? { ok: true } : { ok: false, error: `no se pudo cargar el estado de partida (infra/fixtures.sql): ${loaded.error}` };
    },
    idpToken: idp
      ? async (actor, how = {}) => {
          const username = idp.users?.[actor] ?? actor;
          if (idp.seed && !seeded.has(username)) {
            const persona = {
              ...(how.email !== undefined ? { email: how.email === null ? null : String(how.email).replaceAll('{{actor}}', actor) } : {}),
              ...(how.roles ? { roles: how.roles } : {}),
            };
            const r = seedPersona(rt, idp.seed, username, idp.password, session, persona);
            if (!r.ok) throw new Error(r.error);
            seeded.add(username);
          }
          const form = new URLSearchParams({
            grant_type: 'password',
            client_id: idp.clientId,
            ...(idp.clientSecret ? { client_secret: idp.clientSecret } : {}),
            username,
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
  fs.writeFileSync(report, renderParity({ service: prep.service, legacy: prep.legacy, target, records, legacyTally: pp.legacyTally, comparison, verdict, unblockedNew: pp.unblockedNew ?? [] }));
  written.push(report);
  return { comparison, verdict, written };
}
