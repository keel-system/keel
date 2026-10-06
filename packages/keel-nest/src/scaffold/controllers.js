// Controladores REST: uno por grupo (el <Grupo>V1Controller de keel-spring), con la base de la API
// del diseño, y por cada operación con ruta un LECTOR generado que convierte la petición al mensaje
// del caso de uso y lo despacha por el UseCaseMediator.
//
// El lector es lo que en Spring hacen el binding y Bean Validation, en el MISMO orden, porque el
// orden decide qué error ve el cliente cuando hay más de uno:
//   1. los parámetros de ruta, convertidos a su tipo (un uuid mal formado es petición malformada);
//   2. el cuerpo, leído y convertido (malformada) y validado (Validation Error, «no supera»);
//   3. la query: el obligatorio ausente («Falta el parámetro»), convertida (malformada);
//   4. las restricciones de ruta y query (Validation Error, «viola restricciones declaradas»).
// Qué se valida sale de las reglas neutrales (inputValidation, keel-core/gen/constraints.js), las
// mismas que keel-spring escribe como anotaciones; dónde viaja cada campo y si el cuerpo es
// obligatorio, de keel-core/gen/api-contract.js. Sin class-validator: no vería los tipos del cable
// (Decimal, bigint) y sus decoradores tendrían que ir en los mensajes de la capa application.

import { requestShape, returnsLocation, locationTarget } from 'keel-core/gen/api-contract';
import { DIRS, classPath, fieldImports, tsModule, tsdoc, tsString } from './render.js';
import { MEDIATOR_TS } from './mediator.js';
import { messageComponents, messagePath, returnTypeOf, isPartialUpdate } from './services.js';
import { PAGED_RESPONSE_TS } from './dtos.js';
import { REQUEST_READING_TS, ROUTES_TS, usesApi } from './rest-support.js';

export const VALUE_READERS_TS = 'src/infrastructure/rest/value-readers.ts';
const CONTROLLERS_DIR = 'infrastructure/rest/controllers';

const DECORATOR_BY_METHOD = { GET: 'Get', POST: 'Post', PUT: 'Put', PATCH: 'Patch', DELETE: 'Delete' };

/** Los controladores con su archivo, para quien los registra (AppModule). */
export function controllerClasses(model) {
  if (!usesApi(model)) return [];
  return (model.services ?? [])
    .filter((service) => (service.operations ?? []).some((op) => op.route))
    .map((service) => ({ symbol: service.controllerClass, from: classPath(CONTROLLERS_DIR, service.controllerClass) }));
}

export function generate(model) {
  if (!usesApi(model)) return [];
  const files = [];
  for (const service of model.services ?? []) {
    const routed = (service.operations ?? []).filter((op) => op.route);
    if (routed.length > 0) files.push(renderController(model, service, routed));
  }
  if ((model.valueObjects ?? []).length > 0) files.push(valueReaders(model));
  files.push(routesFile(model));
  return files;
}

/** Ruta del diseño (`/products/{id}`) en la sintaxis de Nest (`products/:id`). */
function nestPath(path) {
  return String(path).replace(/^\//, '').replace(/\{([^}]+)\}/g, ':$1');
}

// ─── Lectores de valores ────────────────────────────────────────────────────

/** Expresión del lector de un campo, en modo `json` (cuerpo) o `text` (ruta y query). */
function readerOf(field, mode) {
  let element;
  if (field.kind === 'enum') element = `${mode}.enumOf(${field.elementTsType})`;
  else if (field.kind === 'composite') element = mode === 'json' ? `read${field.elementTsType}` : 'unreadableAsText';
  else {
    const base = { string: 'string', text: 'string', file: 'string', uuid: 'uuid', int: 'int', long: 'long', decimal: 'decimal', boolean: 'boolean', date: 'date', timestamp: 'timestamp', json: 'json' }[field.base] ?? 'string';
    element = `${mode}.${base}`;
  }
  return field.list ? `${mode}.listOf(${element})` : element;
}

/** Imports que necesita leer un campo: su tipo (enum, value object) y su lector de value object. */
function readerImports(model, field) {
  const imports = fieldImports(model, field);
  if (field.kind === 'composite') imports.push({ symbol: `read${field.elementTsType}`, from: VALUE_READERS_TS });
  return imports;
}

function valueReaders(model) {
  const imports = [
    { symbol: 'json', from: REQUEST_READING_TS },
    { symbol: 'valueObject', from: REQUEST_READING_TS }
  ];
  const functions = model.valueObjects.map((vo) => {
    imports.push({ symbol: vo.name, from: classPath(DIRS.valueObjects, vo.name) });
    const args = vo.fields.map((field) => {
      for (const imp of readerImports(model, field)) if (imp.symbol !== `read${vo.name}`) imports.push(imp);
      const read = `${readerOf(field, 'json')}(fields[${tsString(field.name)}])`;
      // Un campo obligatorio ausente llega como null y lo rechaza el constructor del value object.
      if (field.list) return `${read} ?? []`;
      return field.required ? `${read}!` : read;
    });
    return `/** ${vo.name} desde el cuerpo JSON: si su constructor lo rechaza, la petición es malformada. */
export function read${vo.name}(value: unknown): ${vo.name} | null {
  return valueObject(value, (fields) => new ${vo.name}(${args.join(', ')}));
}`;
  });
  return { path: VALUE_READERS_TS, content: tsModule(VALUE_READERS_TS, imports, functions.join('\n\n')) };
}

// ─── Controladores ──────────────────────────────────────────────────────────

function renderController(model, service, routed) {
  const file = classPath(CONTROLLERS_DIR, service.controllerClass);
  const imports = [
    { symbol: 'Controller', from: '@nestjs/common' },
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'HttpCode', from: '@nestjs/common' },
    { symbol: 'Param', from: '@nestjs/common' },
    { symbol: 'Query', from: '@nestjs/common' },
    { symbol: 'Body', from: '@nestjs/common' },
    { symbol: 'UseCaseMediator', from: MEDIATOR_TS }
  ];
  const readers = [];
  const methods = routed.map((operation) => renderMethod(model, operation, imports, readers));
  const body = `${tsdoc(`Operaciones HTTP de ${service.controllerClass.replace(/V1Controller$/, '')}. Solo traduce: lee la petición, despacha el caso de uso y devuelve su resultado.`)}@Controller(${tsString(model.api.routeBase.replace(/^\//, ''))})
export class ${service.controllerClass} {
  constructor(@Inject(UseCaseMediator) private readonly mediator: UseCaseMediator) {}

${methods.join('\n\n')}
}

${readers.join('\n\n')}`;
  return { path: file, content: tsModule(file, imports, body) };
}

function renderMethod(model, operation, imports, readers) {
  const route = operation.route;
  const decorator = DECORATOR_BY_METHOD[route.method];
  imports.push({ symbol: decorator, from: '@nestjs/common' }, { symbol: operation.messageClass, from: messagePath(operation) });
  const resultType = returnTypeOf(operation);
  if (operation.responseDto) imports.push({ symbol: operation.responseDto.name, from: classPath(DIRS.dtos, operation.responseDto.name), type: true });
  if (operation.paginated) imports.push({ symbol: 'PagedResponse', from: PAGED_RESPONSE_TS, type: true });
  const location = returnsLocation(model, operation);
  const readerName = `read${operation.messageClass}`;
  readers.push(renderReader(model, operation, readerName, imports));

  const params = ['@Param() params: Record<string, string>', '@Query() query: Record<string, unknown>', '@Body() body: unknown'];
  let call = `this.mediator.dispatch(${readerName}(params, query, body))`;
  let statements;
  if (location) {
    imports.push(
      { symbol: 'Req', from: '@nestjs/common' },
      { symbol: 'Res', from: '@nestjs/common' },
      { symbol: 'FastifyReply', from: 'fastify', type: true },
      { symbol: 'FastifyRequest', from: 'fastify', type: true },
      { symbol: 'locationOf', from: ROUTES_TS }
    );
    params.push('@Req() request: FastifyRequest', '@Res({ passthrough: true }) reply: FastifyReply');
    const target = locationTarget(model, operation);
    const value = target.param ? `params[${tsString(target.param)}]` : 'response.id';
    statements = `    const response = await ${call};
    // 201 con la ruta que LEE el recurso creado (keel-core/gen/api-contract.js).
    void reply.header('Location', locationOf(request, ${tsString(target.path)}, ${value}));
    return response;`;
  } else {
    statements = resultType ? `    return ${call};` : `    await ${call};`;
  }
  if (operation.multipart) {
    statements = `    // Subida multipart: la lectura del binario llega con la capa storage (incremento 13 de keel-nest).
    throw new Error('TODO: ${operation.name} es una subida multipart, que keel-nest todavía no genera');`;
  }
  imports.push({ symbol: 'HttpCode', from: '@nestjs/common' });
  return `${tsdoc(operation.description, '  ')}  @${decorator}(${tsString(nestPath(route.path))})
  @HttpCode(${route.status})
  async ${operation.name}(${params.join(', ')}): Promise<${resultType ?? 'void'}> {
${statements}
  }`;
}

/** Las reglas de un campo como literal TypeScript (datos neutrales de keel-core). */
function rulesLiteral(rules) {
  const value = (v) => (typeof v === 'string' ? tsString(v) : JSON.stringify(v));
  return `[${rules.map((rule) => `{ ${Object.entries(rule).map(([key, v]) => `${key}: ${value(v)}`).join(', ')} }`).join(', ')}]`;
}

function renderReader(model, operation, name, imports) {
  const { asBody, bodyRequired } = requestShape(operation);
  const components = messageComponents(model, operation);
  const fromPath = new Set((operation.pathParams ?? []).map((param) => param.name));
  const partial = isPartialUpdate(operation);
  const used = new Set();
  const use = (symbol) => used.add(symbol);
  const lines = [];
  const assigns = [];
  const pathChecks = [];
  const bodyChecks = [];
  const queryChecks = [];
  const missing = [];

  // 1. Ruta.
  for (const param of operation.pathParams ?? []) {
    for (const imp of readerImports(model, param)) imports.push(imp);
    use('text');
    lines.push(`  const ${param.name} = ${readerOf(param, 'text')}(params[${tsString(param.name)}]);`);
    // En la ruta la presencia no dice nada: el segmento existe o la ruta no casa.
    const rules = (param.inputValidation ?? []).filter((rule) => !['notNull', 'notBlank', 'notEmpty'].includes(rule.rule));
    if (rules.length > 0) pathChecks.push(`    .check(${tsString(`${operation.name}.${param.name}`)}, ${param.name}, ${rulesLiteral(rules)})`);
  }

  // 2. Cuerpo.
  if (asBody) {
    use('bodyObject');
    lines.push(`  const fields = bodyObject(body, ${bodyRequired});`);
  }
  for (const component of components) {
    if (fromPath.has(component.name)) continue;
    if (component.resolvedIdentity || component.file) continue;
    // La página no es un campo del diseño: la leen las dos líneas de abajo.
    if (operation.paginated && ['page', 'size'].includes(component.name) && !operation.bodyFields.some((f) => f.name === component.name)) continue;
    for (const imp of readerImports(model, component)) imports.push(imp);
    const rules = component.inputValidation ?? [];
    if (asBody) {
      use('json');
      const read = `${readerOf(component, 'json')}(fields[${tsString(component.name)}])`;
      const threeState = partial && !component.required && !component.list;
      lines.push(threeState
        ? `  const ${component.name} = ${tsString(component.name)} in fields ? ${read} : undefined;`
        : `  const ${component.name} = ${read};`);
      if (rules.length > 0) bodyChecks.push(`    .check(${tsString(component.name)}, ${component.name}, ${rulesLiteral(rules)})`);
    } else {
      use('text');
      if (component.required) {
        use('requireParameter');
        missing.push(component.name);
      }
      lines.push(`  const ${component.name} = ${readerOf(component, 'text')}(query[${tsString(component.name)}]);`);
      if (rules.length > 0) queryChecks.push(`    .check(${tsString(`${operation.name}.${component.name}`)}, ${component.name}, ${rulesLiteral(rules)})`);
    }
  }

  // La paginación sin persistencia: dos enteros de la query con sus defaults (también con cuerpo).
  if (operation.paginated) {
    use('text');
    lines.push(`  const page = text.int(query['page']) ?? 0;`);
    lines.push(`  const size = text.int(query['size']) ?? ${model.pagination?.defaultSize ?? 20};`);
  }

  for (const component of components) {
    let value;
    if (component.resolvedIdentity) {
      value = `unsupported('la identidad del llamante la resuelve la seguridad (incremento 8 de keel-nest)')`;
      use('unsupported');
    } else if (component.file) {
      value = `unsupported('la subida multipart llega con la capa storage (incremento 13 de keel-nest)')`;
      use('unsupported');
    } else if (component.list) {
      value = `${component.name} ?? []`;
    } else if (partial && asBody && !fromPath.has(component.name) && !component.required) {
      value = component.name;
    } else if (component.required && !component.initializer) {
      value = `${component.name}!`;
    } else {
      value = component.name;
    }
    assigns.push(`    ${component.name}: ${value}`);
  }

  // El orden de Spring: ruta convertida, cuerpo leído y validado, query presente y convertida, y
  // las restricciones de ruta y query al final.
  const ordered = [];
  const pathLines = lines.filter((line) => (operation.pathParams ?? []).some((p) => line.startsWith(`  const ${p.name} =`)));
  const otherLines = lines.filter((line) => !pathLines.includes(line));
  ordered.push(...pathLines);
  if (asBody) {
    ordered.push(...otherLines);
    if (bodyChecks.length > 0) {
      use('Violations');
      ordered.push(`  new Violations('body')\n${bodyChecks.join('\n')}\n    .throwIfAny();`);
    }
  } else {
    for (const name of missing) ordered.push(`  requireParameter(query, ${tsString(name)});`);
    ordered.push(...otherLines);
  }
  const paramChecks = [...pathChecks, ...queryChecks];
  if (paramChecks.length > 0) {
    use('Violations');
    ordered.push(`  new Violations('params')\n${paramChecks.join('\n')}\n    .throwIfAny();`);
  }
  for (const symbol of used) imports.push({ symbol, from: REQUEST_READING_TS });

  const construct = components.length > 0 ? `new ${operation.messageClass}({\n${assigns.join(',\n')}\n  })` : `new ${operation.messageClass}()`;
  return `/** Lee ${operation.route.method} ${operation.route.path} (${operation.name}) al mensaje de su caso de uso. */
function ${name}(params: Record<string, string>, query: Record<string, unknown>, body: unknown): ${operation.messageClass} {
${ordered.join('\n')}${ordered.length > 0 ? '\n' : ''}  return ${construct};
}`;
}

// ─── La tabla de rutas ──────────────────────────────────────────────────────

function routesFile(model) {
  const rows = [];
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      if (!operation.route) continue;
      const { asBody, bodyRequired } = requestShape(operation);
      const fromPath = new Set((operation.pathParams ?? []).map((param) => param.name));
      const query = asBody
        ? []
        : messageComponents(model, operation).filter((c) => !fromPath.has(c.name) && !c.resolvedIdentity && !c.file).map((c) => c.name);
      rows.push(
        `  { operation: ${tsString(operation.name)}, method: ${tsString(operation.route.method)}, path: ${tsString(`${model.api.routeBase}${operation.route.path}`)}, ` +
          `status: ${operation.route.status}, location: ${returnsLocation(model, operation)}, query: [${query.map(tsString).join(', ')}], ` +
          `body: ${asBody ? (bodyRequired ? "'required'" : "'optional'") : 'null'} }`
      );
    }
  }
  const body = `/**
 * El contrato HTTP del servicio como DATOS: una fila por operación con ruta. Lo usa el filtro de
 * errores para distinguir un 404 (el camino no existe) de un 405 (existe con otro método), y lo
 * compara con keel-spring el test de paridad del contrato.
 */
export interface RouteContract {
  readonly operation: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly location: boolean;
  readonly query: readonly string[];
  readonly body: 'required' | 'optional' | null;
}

export const ROUTES: readonly RouteContract[] = [
${rows.join(',\n')}
];

const PATTERNS = ROUTES.map((route) => ({
  method: route.method,
  pattern: new RegExp(\`^\${route.path.split(/\\{[^}]+\\}/).map(escapeRegExp).join('[^/]+')}/?$\`)
}));

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
}

/** ¿El camino de la URL existe con OTRO método (405) y no con este? */
export function allowsOtherMethod(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? url;
  const matching = PATTERNS.filter((route) => route.pattern.test(path));
  return matching.length > 0 && !matching.some((route) => route.method === method.toUpperCase());
}

/**
 * URL absoluta de \`Location\`: el esquema y el host de la petición, y la plantilla de la ruta de
 * lectura expandida con el valor (como ServletUriComponentsBuilder.fromCurrentContextPath()).
 */
export function locationOf(request: FastifyRequest, template: string, value: unknown): string {
  return \`\${request.protocol}://\${request.host}\${template.replace(/\\{[^}]+\\}/, encodeURIComponent(String(value)))}\`;
}`;
  return { path: ROUTES_TS, content: tsModule(ROUTES_TS, [{ symbol: 'FastifyRequest', from: 'fastify', type: true }], body) };
}
