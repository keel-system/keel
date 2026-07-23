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
