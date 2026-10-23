import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import pc from 'picocolors';
import { FIXTURES_FILE, checkFixtures, loadService } from 'keel-core';
import { containerRuntime, resolveRuntime } from '../lib/containers.js';
import { containerOf } from '../lib/sandbox.js';
import { databaseAdapter } from '../lib/db/index.js';
import { prepareCharacterization, verifyGate } from '../lib/characterize-legacy.js';
import { deriveFixtures } from '../lib/fixtures.js';

// `keel-recover fixtures legacy/<servicio>`: el estado de partida de los escenarios desde el snapshot del legacy. Restaura
// la base al snapshot de verify (el mismo del que parte cada flujo de characterize), la exporta, la traduce con
// `contract-map.yaml → data` y escribe specs/<servicio>/fixtures.yaml, que keel-core cruza con las capas antes de
// escribir: lo que no casa con el diseño no llega al archivo.

export function fixtures(legacyArg, options) {
  const prep = prepareCharacterization(legacyArg, { spec: options.spec });
  const blocking = prep.errors.filter((e) => !/keep, fix o frontier/.test(e));
  if (blocking.length) {
    for (const e of blocking) console.error(pc.red(`✗ ${e}`));
    process.exit(1);
  }
  if (!prep.map?.data || Object.keys(prep.map.data).length === 0) {
    console.error(pc.red('✗ contract-map.yaml no tiene sección data: no dice de qué tabla del legacy sale cada entidad'));
    process.exit(1);
  }
  const gate = verifyGate(prep);
  if (!gate.ok) {
    console.error(pc.red(`✗ ${gate.id}  ${gate.detail}`));
    process.exit(1);
  }
  const runtime = options.runtime ?? resolveRuntime();
  if (!runtime) {
    console.error(pc.red('✗ hace falta podman o docker en marcha'));
    process.exit(2);
  }
  const rt = containerRuntime(runtime);
  const { spec } = prep.sandbox;
  const dba = spec.database ? databaseAdapter(spec.database.tech) : null;
  if (!dba) {
    console.error(pc.red('✗ el sandbox no declara una base que keel-recover sepa exportar'));
    process.exit(1);
  }
  const db = containerOf(prep.sandbox, spec.database.service);
  const restored = dba.restoreSnapshot(rt, db, spec.database);
  if (!restored.ok) {
    console.error(pc.red(`✗ no se pudo restaurar el snapshot: ${restored.error}`));
    process.exit(1);
  }
  const exported = dba.exportDb(rt, db, spec.database);
  if (!exported.ok) {
    console.error(pc.red(`✗ no se pudo exportar la base del legacy: ${exported.error}`));
    process.exit(1);
  }

  const { layers, errors: loadErrors } = loadService(prep.specDir);
  if (loadErrors.length) {
    for (const e of loadErrors) console.error(pc.red(`✗ ${e}`));
    process.exit(1);
  }
  const source = { legacy: prep.legacy.name, commit: prep.legacy.commit, snapshot: gate.snapshotHash, by: 'keel-recover fixtures' };
  const derived = deriveFixtures({ exported: exported.value, data: prep.map.data, layers, source });
  const errors = [...derived.errors, ...(derived.doc ? checkFixtures(layers, derived.doc) : [])];
  if (errors.length) {
    for (const e of errors) console.error(pc.red(`✗ ${e}`));
    console.error(pc.red('\nfixtures.yaml no se escribe: corrige contract-map.yaml → data o el diseño'));
    process.exit(1);
  }
  const file = path.join(prep.specDir, FIXTURES_FILE);
  fs.writeFileSync(
    file,
    `# Lo escribe \`keel-recover fixtures\` desde el snapshot del legacy (contract-map.yaml → data): el estado de partida de\n# los escenarios, con los nombres del diseño. No se edita a mano: se cambia el mapa y se vuelve a derivar.\n${YAML.stringify(derived.doc, { lineWidth: 0 })}`
  );
  for (const [name, block] of Object.entries(derived.doc.entities)) console.log(`  ${name.padEnd(20)} ${block.records.length} registro(s)${block.reference ? ' (referencia)' : ''}`);
  console.log(pc.green(`✓ ${path.relative(process.cwd(), file)}`));
  process.exit(0);
}
