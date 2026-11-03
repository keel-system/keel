// El traspaso entre `keel-go build` y `/keel-generate-go` cuando el proyecto YA estaba
// generado y algo cambió: el diseño, el stack o el generador.
//
// La lógica es neutral y vive en keel-core/gen/evolution.js, la misma que usan los otros tres:
// aquí solo están los textos de la plataforma Go que el documento cita, y lo único que no tiene
// equivalente en ellos, porque aquí el esquema lo escribe build entero: goose no reaplica una
// migración que su historial ya tiene, así que una baseline reescrita no llega nunca a una base
// que aplicó la anterior, y el servidor arranca sin decir nada y falla en la primera consulta.

import fs from 'node:fs';
import path from 'node:path';
import { digestOf } from '@keel-system/keel-core';
import { REFRESH_DIR, readManifest } from '@keel-system/keel-core/gen/generated-manifest';
import { SKILL } from '../lib/assets.js';
import { BASELINE_FILE } from './persistence.js';

export const GO_EVOLUTION = {
  generator: 'keel-go',
  skill: SKILL,
  keepBuild: '**No borres `build/` hasta cerrar la evolución**',
  scenarioWork:
    'crear las funciones de los añadidos, reescribir las de las familias cambiadas y borrar las de los quitados. ' +
    'La función de un flujo se localiza buscando su id en `tests/integration/`.',
  duplicateStub: 'dos declaraciones del mismo símbolo en el paquete, y el paquete deja de compilar'
};

const posixOf = (entry) => entry.path.split(/[\\/]/).join('/');

/**
 * Si esta pasada cambia la baseline, y si el proyecto ya migra por pasos. Se compara con lo que build
 * REGISTRÓ y no con el disco: en un proyecto con una base desplegada la baseline del disco es a propósito
 * la que aquella base aplicó, y compararla con la del diseño diría «cambió» en todos los builds.
 *
 * Tiene que llamarse antes de escribir: después, el manifiesto ya registra la nueva.
 */
export function baselineChange(files, projectDir) {
  const suffix = `/migrations/${BASELINE_FILE}`;
  const entry = files.find((file) => posixOf(file).endsWith(suffix));
  if (!entry) return null;
  const relative = posixOf(entry);
  const recorded = readManifest(projectDir)?.files?.[relative];
  if (!recorded || recorded === digestOf(entry)) return null;
  const dir = path.join(projectDir, path.dirname(relative));
  const steps = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.sql') && name !== BASELINE_FILE).sort()
    : [];
  return { relative, steps };
}

const SCHEMA_NOTE_MARK = '**El esquema cambió';

/** El aviso de EVOLUTION.md. El primer caso lo decide una pregunta; después, los archivos de `migrations/` ya lo dicen. */
export function schemaNote({ relative, steps }) {
  if (steps.length > 0) {
    return (
      `${SCHEMA_NOTE_MARK} y este proyecto ya migra por pasos** (${steps.map((name) => `\`${name}\``).join(', ')}): ` +
      `la baseline se queda como está y **no se fusiona**. \`${REFRESH_DIR}/${relative}\` es solo la referencia del esquema ` +
      'nuevo: el paso siguiente lo escribe `keel-go-code` con `references/schema-evolution.md` de la skill `keel-go-database`.'
    );
  }
  return (
    `${SCHEMA_NOTE_MARK}** (\`${relative}\`), y hay una pregunta que solo contesta el diseñador, **antes de la fase 1**: ` +
    '¿hay alguna base desplegada con la baseline anterior? goose no reaplica una migración que su historial ya tiene. ' +
    'Si no la hay, basta `bash infra/reset-db.sh --schema` antes de puntuar. Si la hay, `keel-go-code` sigue ' +
    '`references/schema-evolution.md` de la skill `keel-go-database`.'
  );
}

/**
 * Añade el aviso del esquema a la evolución de esta pasada. El segundo build antes de entrar al proyecto ya no ve
 * el cambio, porque el manifiesto registra la baseline nueva, así que el aviso se arrastra de la pasada sin cerrar
 * (`mergePrevious` no arrastra los avisos: los demás se recalculan en cada pasada, y este no se puede).
 */
export function withSchemaNote(evolution, change, previous) {
  if (!evolution) return evolution;
  const carried = (previous?.notes ?? []).filter((note) => note.startsWith(SCHEMA_NOTE_MARK));
  const note = change ? schemaNote(change) : carried[0];
  return note ? { ...evolution, notes: [...evolution.notes, note] } : evolution;
}
