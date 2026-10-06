// El sello del snapshot `specs/` de un proyecto generado.
//
// El snapshot es el diseño con el que se completa el proyecto, y el pipeline tiene prohibido
// editarlo: un escenario que contradice al diseño es un `culprit: design`, que se PROPONE en
// `design-gaps.yaml` y lo corrige el diseñador en el workspace. En la corrida `catalog`
// (2026-09-21) la prohibición estaba escrita y no bastó: el orquestador corrigió dos escenarios
// —en el snapshot y en el workspace, que estaba a dos directorios—, la suite cerró en verde y el
// hueco no volvió nunca al método.
//
// Una regla que solo está en prosa la cumple quien la lee. Esta la comprueba
// `infra/score-scenarios.sh`, que es el paso por el que toda generación tiene que pasar: con el
// snapshot tocado sale con 2 y no puntúa. El formato es el de `sha256sum` («<hash>  <ruta>»)
// para que el script lo lea sin parsear JSON, y el hash se calcula SIN retornos de carro: un
// checkout con `core.autocrlf` no cambia el diseño, y romper el sello por eso enseñaría a
// ignorarlo.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SPECS_SEAL_FILE = 'specs.sha256';

/** El sello de un directorio de specs, como texto: una línea por archivo, ordenadas. */
export function specsSeal(projectDir) {
  const specsDir = path.join(projectDir, 'specs');
  if (!fs.existsSync(specsDir)) return '';
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(specsDir);
  return files
    .map((file) => {
      const relative = path.relative(projectDir, file).split(path.sep).join('/');
      const content = fs.readFileSync(file).toString('latin1').replace(/\r/g, '');
      const hash = crypto.createHash('sha256').update(Buffer.from(content, 'latin1')).digest('hex');
      return `${hash}  ${relative}`;
    })
    .sort((a, b) => a.slice(66).localeCompare(b.slice(66)))
    .map((line) => `${line}\n`)
    .join('');
}

/** Escribe el sello junto al proyecto. Lo llama `build` cada vez que refresca el snapshot. */
export function writeSpecsSeal(projectDir) {
  fs.writeFileSync(path.join(projectDir, SPECS_SEAL_FILE), specsSeal(projectDir));
}
