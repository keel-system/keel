// El CONTRATO HTTP que emite keel-spring, leído de sus controladores Java: la tabla de rutas (método, ruta,
// status, Location, query, cuerpo) y los campos de cada DTO de respuesta. Es el oráculo de las paridades de
// contrato de los otros generadores (keel-nest y keel-dotnet), que comparan su API contra esto.

const STATUS_BY_CONSTANT = { OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204 };

/**
 * Nombre y parámetros del método público de un bloque. Cuenta paréntesis y se salta los literales de
 * cadena: un `@Pattern(regexp = "^[a-z]{2}(-[A-Z]{2})?$")` en un parámetro de ruta trae paréntesis
 * dentro, y una expresión regular de un solo nivel dejaba la operación sin reconocer.
 */
function javaSignature(block) {
  const head = /public [^(]+ (\w+)\(/.exec(block);
  if (!head) return null;
  let depth = 1;
  let inString = false;
  for (let i = head.index + head[0].length; i < block.length; i++) {
    const char = block[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return { name: head[1], params: block.slice(head.index + head[0].length, i) };
  }
  return null;
}

/** La tabla de rutas de los controladores Java que emite keel-spring, por nombre de operación. */
export function springRoutes(files) {
  const routes = new Map();
  for (const file of files.filter((f) => /\/controllers\/.+V1Controller\.java$/.test(f.path))) {
    const base = /@RequestMapping\("([^"]*)"\)/.exec(file.content)?.[1] ?? '';
    // Un bloque por método: desde sus anotaciones hasta la llave que lo cierra.
    const blocks = file.content.split(/\n(?=    (?:\/\*\*|@(?:Get|Post|Put|Patch|Delete)Mapping|@Operation))/);
    for (const block of blocks) {
      const mapping = /@(Get|Post|Put|Patch|Delete)Mapping\((?:value = )?"([^"]*)"/.exec(block);
      const signature = javaSignature(block);
      if (!mapping || !signature) continue;
      const { name, params } = signature;
      const status = /ResponseEntity\.created/.test(block)
        ? 201
        : STATUS_BY_CONSTANT[/@ResponseStatus\(HttpStatus\.(\w+)\)/.exec(block)?.[1]] ?? Number(/HttpStatus\.valueOf\((\d+)\)/.exec(block)?.[1] ?? 200);
      const query = [...params.matchAll(/@RequestParam(?:\([^)]*\))? (?:@\w+(?:\([^)]*\))? )*[\w<>.]+ (\w+)/g)].map((m) => m[1]);
      // El Pageable de Spring Data lee tres parámetros: página, tamaño y orden.
      if (/Pageable pageable/.test(params)) query.push('page', 'size', 'sort');
      const body = /@RequestBody\(required = false\)/.test(params) ? 'optional' : /@RequestBody/.test(params) ? 'required' : null;
      routes.set(name, {
        method: mapping[1].toUpperCase(),
        path: `${base}${mapping[2]}`,
        status,
        location: /ResponseEntity\.created/.test(block),
        query: [...query].sort(),
        body,
        multipart: /consumes = MediaType\.MULTIPART_FORM_DATA_VALUE/.test(block)
      });
    }
  }
  return routes;
}

/** Los campos de un record de DTO de keel-spring, en orden. */
export function springDtoFields(files, name) {
  const file = files.find((f) => f.path.endsWith(`/application/dtos/${name}.java`));
  if (!file) return null;
  const components = /public record \w+\(\s*([\s\S]*?)\n\)/.exec(file.content)?.[1] ?? '';
  return components
    .split(/,\n/)
    .map((line) => /(\w+)\s*$/.exec(line.trim())?.[1])
    .filter(Boolean);
}

