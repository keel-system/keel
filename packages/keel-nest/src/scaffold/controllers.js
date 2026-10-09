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
import { callsPaymentGateway } from 'keel-core/gen/payments-model';
import { DIRS, classPath, fieldImports, tsModule, tsdoc, tsString } from './render.js';
import { MEDIATOR_TS } from './mediator.js';
import { messageComponents, messagePath, returnTypeOf, isPartialUpdate } from './services.js';
import { PAGED_RESPONSE_TS, FILE_UPLOAD_TS } from './dtos.js';
import { MULTIPART_READING_TS } from './storage.js';
import { REQUEST_READING_TS, ROUTES_TS, usesApi } from './rest-support.js';
import { CALLER_IDENTITY_TS, callerResolution } from './security.js';

export const VALUE_READERS_TS = 'src/infrastructure/rest/value-readers.ts';
export const PAGEABLE_READING_TS = 'src/infrastructure/rest/pageable-reading.ts';
const CONTROLLERS_DIR = 'infrastructure/rest/controllers';

// Los defaults del Pageable de keel-spring: `@PageableDefault` sin tamaño es 10 (la anotación gana a
// `spring.data.web.pageable.default-page-size`), y el tope de Spring Data sin `max-page-size` es 2000.
const PAGEABLE_DEFAULT_SIZE = 10;
const PAGEABLE_MAX_SIZE = 2000;

/**
 * El orden por defecto del diseño (`output.sort`) que se puede aplicar sin más: un criterio sobre un
 * agregado embebido necesita un join que lo resuelva, y entonces no se traduce (lo avisa el modelo).
 */
function translatableSort(operation) {
  const sort = operation.sort ?? [];
  if (sort.length === 0 || sort.some((criterion) => criterion.embedded)) return [];
  return sort;
}

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
  const pageable = (model.services ?? []).some((service) =>
    (service.operations ?? []).some((operation) => operation.route && messageComponents(model, operation).some((c) => c.pageable))
  );
  if (pageable) files.push({ path: PAGEABLE_READING_TS, content: pageableReading() });
  files.push(routesFile(model));
  return files;
}

/**
 * La lectura del Pageable con la semántica del PageableHandlerMethodArgumentResolver de Spring Data,
 * que es indulgente a propósito: una página o un tamaño que no se pueden leer no son un 400 sino el
 * valor por defecto, una página negativa es la 0 y un tamaño por encima del tope es el tope.
 */
function pageableReading() {
  const body = `export interface PageableDefaults {
  readonly defaultSize: number;
  readonly maxSize: number;
  /** El orden del diseño (output.sort), si el cliente no pide uno. */
  readonly defaultSort?: readonly SortOrder[];
}

/** \`?page=&size=&sort=prop,dir\` → Pageable, como lo lee Spring Data. */
export function readPageable(query: Record<string, unknown>, defaults: PageableDefaults): Pageable {
  const page = parseBounded(first(query['page']), Number.MAX_SAFE_INTEGER) ?? 0;
  let size = parseBounded(first(query['size']), defaults.maxSize) ?? defaults.defaultSize;
  if (size < 1) size = defaults.defaultSize;
  if (size > defaults.maxSize) size = defaults.maxSize;
  const sort = readSort(query['sort']);
  return { page, size, sort: sort.length > 0 ? sort : [...(defaults.defaultSort ?? [])] };
}

function first(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : undefined;
  return value == null ? undefined : String(value);
}

/**
 * Un entero con los límites de Spring Data: sin texto no hay valor (se usa el default); lo que no es
 * un entero de Java se lee como 0; negativo, 0; por encima del tope, el tope.
 */
function parseBounded(text: string | undefined, upper: number): number | null {
  if (text == null || text.trim() === '') return null;
  if (!/^[+-]?\\d+$/.test(text)) return 0;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > 2147483647 || parsed < -2147483648) return 0;
  return parsed < 0 ? 0 : parsed > upper ? upper : parsed;
}

/**
 * \`sort\` repetido o con varias propiedades: \`name,desc\`, \`status,name\`. La última pieza es la
 * dirección si lo es (sin distinguir mayúsculas) y vale para todas las propiedades de ese valor.
 */
function readSort(raw: unknown): SortOrder[] {
  const values = Array.isArray(raw) ? raw.map(String) : raw == null ? [] : [String(raw)];
  const orders: SortOrder[] = [];
  for (const value of values) {
    const parts = value.split(',').filter((part) => part.trim() !== '');
    if (parts.length === 0) continue;
    const last = parts[parts.length - 1]!.trim().toLowerCase();
    const direction = last === 'asc' || last === 'desc' ? last : null;
    const properties = direction ? parts.slice(0, -1) : parts;
    for (const property of properties) orders.push({ property, direction: direction ?? 'asc' });
  }
  return orders;
}`;
  return tsModule(
    PAGEABLE_READING_TS,
    [
      { symbol: 'Pageable', from: 'src/domain/repository/page.ts', type: true },
      { symbol: 'SortOrder', from: 'src/domain/repository/page.ts', type: true }
    ],
    body
  );
}

/** Ruta del diseño (`/products/{id}`) en la sintaxis de Nest (`products/:id`). */
function nestPath(path) {
  return String(path).replace(/^\//, '').replace(/\{([^}]+)\}/g, ':$1');
}

// ─── Lectores de valores ────────────────────────────────────────────────────

/** Expresión del lector de un campo, en modo `json` (cuerpo) o `text` (ruta y query). */
export function readerOf(field, mode) {
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
export function readerImports(model, field) {
  const imports = fieldImports(model, field);
  if (field.kind === 'composite') imports.push({ symbol: `read${field.elementTsType}`, from: VALUE_READERS_TS });
  return imports;
}

export function valueReaders(model) {
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
  // Con resolvedBy, la identidad del llamante se resuelve al recurso antes de despachar (callerResolution).
  const resolving = callerResolution(model) != null && routed.some((operation) => resolvesCaller(model, operation));
  if (resolving) imports.push({ symbol: 'CallerIdentityResolver', from: CALLER_IDENTITY_TS });
  const constructor = resolving
    ? `  constructor(\n    @Inject(UseCaseMediator) private readonly mediator: UseCaseMediator,\n    @Inject(CallerIdentityResolver) private readonly callerIdentity: CallerIdentityResolver\n  ) {}`
    : '  constructor(@Inject(UseCaseMediator) private readonly mediator: UseCaseMediator) {}';
  const body = `${tsdoc(`Operaciones HTTP de ${service.controllerClass.replace(/V1Controller$/, '')}. Solo traduce: lee la petición, despacha el caso de uso y devuelve su resultado.`)}@Controller(${tsString(model.api.routeBase.replace(/^\//, ''))})
export class ${service.controllerClass} {
${constructor}

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
  // Lo que llama a la pasarela de pago va SIN transacción abarcadora (callsPaymentGateway, keel-core): su garantía
  // es registrar y confirmar ANTES de llamarla, como en keel-spring.
  const dispatch = callsPaymentGateway(model, operation.name) ? 'dispatchWithoutTransaction' : 'dispatch';
  let call = `this.mediator.${dispatch}(${readerName}(params, query, body))`;
  let resolve = '';
  // Una subida: el cuerpo es multipart/form-data. Los campos simples se leen como los de la query (el
  // @RequestParam de keel-spring lee los dos) y los binarios llegan por su nombre de parte.
  const needsRequest = Boolean(location) || operation.multipart;
  if (operation.multipart) {
    imports.push({ symbol: 'readMultipart', from: MULTIPART_READING_TS });
    resolve = '    const form = await readMultipart(request);\n';
    call = `this.mediator.${dispatch}(${readerName}(params, { ...query, ...form.fields }, form.files))`;
  }
  if (resolvesCaller(model, operation)) {
    // La credencial del token es UNA de las del recurso (resolvedBy): el mensaje lleva su clave natural, o null
    // si no es de nadie (la precondición la responde la operación con el error que declare el diseño).
    const field = messageComponents(model, operation).find((component) => component.resolvedIdentity).name;
    const readArgs = operation.multipart ? '{ ...query, ...form.fields }, form.files' : 'query, body';
    resolve += `    const read = ${readerName}(params, ${readArgs});\n    const message = new ${operation.messageClass}({ ...read, ${field}: await this.callerIdentity.resolve(read.${field}) });\n`;
    call = `this.mediator.${dispatch}(message)`;
  }
  let statements;
  if (needsRequest) {
    imports.push({ symbol: 'Req', from: '@nestjs/common' }, { symbol: 'FastifyRequest', from: 'fastify', type: true });
    params.push('@Req() request: FastifyRequest');
  }
  if (location) {
    imports.push({ symbol: 'Res', from: '@nestjs/common' }, { symbol: 'FastifyReply', from: 'fastify', type: true }, { symbol: 'locationOf', from: ROUTES_TS });
    params.push('@Res({ passthrough: true }) reply: FastifyReply');
    const target = locationTarget(model, operation);
    const value = target.param ? `params[${tsString(target.param)}]` : 'response.id';
    statements = `    const response = await ${call};
    // 201 con la ruta que LEE el recurso creado (keel-core/gen/api-contract.js).
    void reply.header('Location', locationOf(request, ${tsString(target.path)}, ${value}));
    return response;`;
  } else {
    statements = resultType ? `    return ${call};` : `    await ${call};`;
  }
  imports.push({ symbol: 'HttpCode', from: '@nestjs/common' });
  return `${tsdoc(operation.description, '  ')}  @${decorator}(${tsString(nestPath(route.path))})
  @HttpCode(${route.status})
  async ${operation.name}(${params.join(', ')}): Promise<${resultType ?? 'void'}> {
${resolve}${statements}
  }`;
}

/** Las reglas de un campo como literal TypeScript (datos neutrales de keel-core). */
function rulesLiteral(rules) {
  const value = (v) => (typeof v === 'string' ? tsString(v) : JSON.stringify(v));
  return `[${rules.map((rule) => `{ ${Object.entries(rule).map(([key, v]) => `${key}: ${value(v)}`).join(', ')} }`).join(', ')}]`;
}

function renderReader(model, operation, name, imports) {
  const shape = requestShape(operation);
  // Una subida no tiene cuerpo JSON: sus campos simples vienen del formulario, mezclados con la query.
  const asBody = shape.asBody && !operation.multipart;
  const bodyRequired = shape.bodyRequired;
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
    if (component.resolvedIdentity) continue;
    // El binario se lee de su parte, en SU posición: Spring resuelve los argumentos en orden, así que una parte
    // que falta se descubre antes que un parámetro posterior y antes de validar ninguna restricción.
    if (component.file) {
      if (operation.multipart) missing.push({ part: component.name, required: Boolean(component.required) });
      continue;
    }
    // La página no es un campo del diseño: la leen las líneas de abajo.
    if (component.pageable) continue;
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

  // La paginación con persistencia: el Pageable de Spring Data (página, tamaño y orden), con el orden
  // por defecto del diseño cuando el cliente no pide uno.
  if (components.some((component) => component.pageable)) {
    imports.push({ symbol: 'readPageable', from: PAGEABLE_READING_TS });
    const defaults = [`defaultSize: ${model.pagination?.defaultSize ?? PAGEABLE_DEFAULT_SIZE}`, `maxSize: ${model.pagination?.maxSize ?? PAGEABLE_MAX_SIZE}`];
    const order = translatableSort(operation);
    if (order.length > 0) {
      defaults.push(`defaultSort: [${order.map((c) => `{ property: ${tsString(c.property)}, direction: ${tsString(c.direction)} }`).join(', ')}]`);
    }
    lines.push(`  const pageable = readPageable(query, { ${defaults.join(', ')} });`);
  } else if (operation.paginated) {
    // La paginación sin persistencia: dos enteros de la query con sus defaults (también con cuerpo).
    use('text');
    lines.push(`  const page = text.int(query['page']) ?? 0;`);
    lines.push(`  const size = text.int(query['size']) ?? ${model.pagination?.defaultSize ?? 20};`);
  }

  for (const component of components) {
    let value;
    if (component.resolvedIdentity) {
      // La estampa el servidor desde la credencial (security.authentication.callerIdentity), nunca el
      // cuerpo: quien hace la petición no elige en nombre de quién actúa.
      value = 'CallerIdentity.resolve()';
      imports.push({ symbol: 'CallerIdentity', from: CALLER_IDENTITY_TS });
    } else if (component.file) {
      // El binario, por su nombre de parte. Uno vacío llega null, como el MultipartFile vacío de keel-spring.
      value = component.required ? `${component.name}!` : component.name;
    } else if (component.pageable) {
      value = component.name;
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
  if (operation.multipart) {
    imports.push({ symbol: 'FileUpload', from: FILE_UPLOAD_TS, type: true });
    ordered.push('  const files = body as Readonly<Record<string, FileUpload | null>>;');
  }
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
    for (const entry of missing) {
      if (typeof entry === 'string') ordered.push(`  requireParameter(query, ${tsString(entry)});`);
      else if (entry.required) {
        imports.push({ symbol: 'requirePart', from: MULTIPART_READING_TS });
        ordered.push(`  const ${entry.part} = requirePart(files, ${tsString(entry.part)});`);
      } else ordered.push(`  const ${entry.part} = files[${tsString(entry.part)}] ?? null;`);
    }
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
        : messageComponents(model, operation)
            .filter((c) => !fromPath.has(c.name) && !c.resolvedIdentity && !c.file)
            // El Pageable viaja como los tres parámetros de Spring Data.
            .flatMap((c) => (c.pageable ? ['page', 'size', 'sort'] : [c.name]));
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

/** ¿La operación recibe la identidad del llamante y el diseño la resuelve contra varias credenciales? */
function resolvesCaller(model, operation) {
  return callerResolution(model) != null && messageComponents(model, operation).some((component) => component.resolvedIdentity);
}
