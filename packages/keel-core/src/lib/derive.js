import YAML from 'yaml';

/**
 * Reescribe el texto del manifiesto de un servicio derivado conservando
 * comentarios y estilo del origen (API de documentos de yaml):
 * nombre nuevo, versión 0.1.0, linaje en basedOn y description marcada
 * como pendiente de revisión (prefijo TODO que `keel validate` detecta).
 */
export function rewriteManifestForDerivation(sourceText, { name, basedOn }) {
  const doc = YAML.parseDocument(sourceText);
  doc.setIn(['service', 'name'], name);
  doc.setIn(['service', 'version'], '0.1.0');
  doc.setIn(['service', 'basedOn'], basedOn);
  const description = doc.getIn(['service', 'description']);
  if (typeof description === 'string' && !/^TODO\b/i.test(description.trim())) {
    const origin = basedOn.split('@')[0];
    doc.setIn(['service', 'description'], `TODO: revisar descripción heredada de ${origin} — ${description}`);
  }
  // lineWidth: 0 evita plegar líneas largas (la description prefijada) al serializar
  return doc.toString({ lineWidth: 0 });
}

/**
 * Reescribe la cabecera de los escenarios heredados: solo la **ruta** del
 * blockquote de sello (`> specs/<origen> v1.2.0 …` → `> specs/<nuevo> v1.2.0 …`).
 *
 * La versión se conserva a propósito. El manifiesto derivado nace en 0.1.0, así
 * que el sello del origen deja los escenarios en `stale` para `keel describe`
 * (ver derivatives.js): es la señal correcta —hay que regenerarlos tras ajustar
 * el diseño— y renumerarlos aquí sería afirmar que ya describen al servicio nuevo.
 *
 * Un archivo sin esa cabecera se devuelve intacto: se copia tal cual.
 */
export function rewriteScenariosForDerivation(sourceText, { name }) {
  return sourceText.replace(/^(>\s*)specs\/\S+(\s+v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/m, `$1specs/${name}$2`);
}
