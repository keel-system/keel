// Utilidades de renderizado C#: DÓNDE vive cada cosa generada y cómo se escribe un archivo.
//
// La solución tiene un proyecto por capa de la arquitectura (PLAN-KEEL-DOTNET.md § 2), y la frontera
// hexagonal la hace cumplir el COMPILADOR: un proyecto solo ve a los que referencia. Por eso el nombre
// y la ruta de cada proyecto salen de UN sitio (`solution`): un emisor que escribiera en
// `src/X.Domain/` mientras otro referencia `src/X.Dominio/` no compilaría.

/** Los proyectos de la solución, en orden de dependencia, con su nombre, su carpeta y su .csproj. */
export function solution(model) {
  const root = model.service.rootNamespace;
  const project = (layer, folder = 'src') => {
    const name = `${root}.${layer}`;
    return { name, dir: `${folder}/${name}`, csproj: `${folder}/${name}/${name}.csproj` };
  };
  return {
    root,
    file: `${root}.slnx`,
    domain: project('Domain'),
    application: project('Application'),
    infrastructure: project('Infrastructure'),
    api: project('Api'),
    unitTests: project('UnitTests', 'tests')
  };
}

/**
 * Un archivo C# con namespace de archivo (C# 10+): los `using` ordenados y sin repetir, luego el
 * namespace y el cuerpo. Los `using` del framework que el SDK ya importa (ImplicitUsings) no se escriben.
 */
export function csFile({ namespace, usings = [], body, header = null }) {
  const unique = [...new Set(usings)].sort((a, b) => a.localeCompare(b));
  const parts = [];
  if (header) parts.push(header.trimEnd(), '');
  if (unique.length > 0) parts.push(...unique.map((using) => `using ${using};`), '');
  parts.push(`namespace ${namespace};`, '', body.trim(), '');
  return parts.join('\n');
}

/**
 * Un literal de cadena C# normal (no verbatim): escapa barras, comillas y saltos de línea, y escribe lo que
 * no es ASCII imprimible como `\uXXXX`, para que el fuente diga lo mismo con cualquier codificación.
 */
export function csString(value) {
  const escaped = String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r');
  const ascii = escaped.replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  return `"${ascii}"`;
}
