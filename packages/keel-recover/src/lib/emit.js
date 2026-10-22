import { stringify } from 'yaml';
import { validateDoc } from './schema.js';

const HEADERS = {
  runtime:
    '# Huella del runtime del legacy (paso 0a). La escribe `keel-recover fingerprint` leyendo solo el repo:\n' +
    '# es determinista, así que no se edita a mano. Cada hecho lleva su archivo:línea.\n',
  environment:
    '# Dependencias del entorno del legacy (paso 0b). La escribe `keel-recover env-deps` leyendo solo el repo.\n' +
    '# Lo que decide el agente al montar el sandbox (imagen elegida, adaptaciones y su motivo) se añade\n' +
    '# en `provision` y `adaptations`; lo demás lo regenera la herramienta.\n',
};

/** YAML estable: mismas entradas, mismos bytes, en cualquier máquina. */
export function toYaml(doc) {
  const body = stringify(doc, { lineWidth: 0, minContentWidth: 0, indent: 2, aliasDuplicateObjects: false });
  return (HEADERS[doc.kind] ?? '') + body;
}

/**
 * Documento tal como se escribe: pasa por JSON (lo que no sobrevive a JSON no se valida ni se
 * escribe), se valida contra su schema y se serializa. `errors` no vacío es un defecto de la
 * herramienta, no del legacy.
 */
export function renderDoc(doc, { json = false } = {}) {
  const plain = JSON.parse(JSON.stringify(doc));
  const errors = validateDoc(plain);
  const text = json ? `${JSON.stringify(plain, null, 2)}\n` : toYaml(plain);
  return { plain, errors, text };
}
