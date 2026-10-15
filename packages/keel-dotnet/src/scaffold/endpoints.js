// Los endpoints REST: uno por operación con ruta, agrupados en un archivo por grupo (el <Grupo>V1Controller de
// keel-spring), y por cada uno un LECTOR generado que convierte la petición al mensaje del caso de uso y lo
// despacha por el IUseCaseMediator. La tabla ApiRoutes es el ÚNICO mapa de rutas: de ella se registran todos los
// endpoints, y es lo que compara con keel-spring el test de paridad del contrato.
//
// El lector es lo que en Spring hacen el binding y Bean Validation, en el MISMO orden, porque el orden decide qué
// error ve el cliente cuando hay más de uno (el mismo que el de keel-nest):
//   1. los parámetros de ruta, convertidos a su tipo (un uuid mal formado es petición malformada);
//   2. el cuerpo, leído y convertido (malformada) y validado (Validation Error, «no supera»);
//   3. la query: el obligatorio ausente («Falta el parámetro»), convertida (malformada);
//   4. las restricciones de ruta y query (Validation Error, «viola restricciones declaradas»).
// Qué se valida sale de las reglas neutrales (inputValidation, keel-core/gen/constraints.js); dónde viaja cada
// campo y si el cuerpo es obligatorio, de keel-core/gen/api-contract.js.
//
// La identidad del llamante (security.authentication.callerIdentity) NO se lee de la petición: el campo lo estampa el
// lector con CallerIdentity.Resolve(), desde la credencial que validó el middleware de seguridad.
//
// Fuera, con su incremento: las subidas multipart (capa storage, incremento 13). La frontera rechaza los diseños que
// las declaran; aquí no se emite su ruta.

import { requestShape, returnsLocation, locationTarget } from 'keel-core/gen/api-contract';
import { callsPaymentGateway } from 'keel-core/gen/payments-model';
import { csFile, csLocal, csMember, csString, fieldUsings, located, namespaceOf, xmlDoc } from './render.js';
import { componentType, isPartialUpdate, isThreeState, messageComponents, messageNamespace } from './services.js';
import { restNamespace, usesApi } from './rest-support.js';
import { repositoriesNamespace } from './repositories.js';
import { pageableDefaults } from 'keel-core/gen/pagination';
import { callerResolution, securityNamespace } from './security.js';

// Los tipos base que en C# son tipos de VALOR: un ausente se escribe `T?` (Nullable<T>), no una referencia nula.
const VALUE_BASES = new Set(['int', 'long', 'decimal', 'boolean', 'uuid', 'date', 'timestamp', 'json']);

// El lector de texto (ruta y query) de cada tipo base.
const TEXT_READERS = { string: 'String', text: 'String', file: 'String', uuid: 'Uuid', int: 'Int', long: 'Long', decimal: 'Decimal', boolean: 'Bool', date: 'Date', timestamp: 'Timestamp', json: 'Json' };

// Los nombres que usa el propio lector: un campo del diseño que se llame igual se renombra.
const READER_LOCALS = new Set(['httpRequest', 'requestFields', 'bodyChecks', 'paramChecks']);

/** ¿Es el campo un tipo de valor de C# (int, decimal, Guid, un enum…)? */
export function isValueType(field) {
  if (field.kind === 'enum') return true;
  if (field.kind === 'composite') return false;
  return VALUE_BASES.has(field.base);
}

/** ¿Se puede servir la operación hoy? Las subidas llegan con su capa. */
export function servedOperation(operation) {
  if (!operation.route || operation.multipart) return false;
  return !messageComponents(operation).some((component) => component.file);
}

/** Las operaciones con ruta que se sirven, con su grupo. */
export function servedRoutes(model) {
  return (model.services ?? []).flatMap((service) => (service.operations ?? []).filter(servedOperation).map((operation) => ({ service, operation })));
}

/** El nombre de la clase de endpoints de un grupo: ProductV1Controller → ProductV1Endpoints. */
export function endpointsClass(service) {
  return service.controllerClass.replace(/Controller$/, 'Endpoints');
}

export function generate(model) {
  if (!usesApi(model)) return [];
  const files = [];
  for (const service of model.services ?? []) {
    const served = (service.operations ?? []).filter(servedOperation);
    if (served.length > 0) files.push(renderEndpoints(model, service, served));
  }
  files.push(routesFile(model));
  return files;
}

// ─── Lectores de valores ────────────────────────────────────────────────────────────────────────

/** El nombre del local C# de un componente, sin chocar con los del propio lector. */
function localOf(component) {
  const local = csLocal(component.name);
  return READER_LOCALS.has(local) ? `${local}Value` : local;
}

/**
 * La expresión que lee UN valor de un objeto JSON (`source`, un JsonElement?). `key` es la propiedad del cable: el
 * nombre del campo, o el de la fuente (`wireName`) en el mensaje de una suscripción.
 */
export function jsonRead(field, source, key = field.name) {
  const name = csString(key);
  if (field.list) return `JsonBodyReader.List(${source}, ${name}, ${jsonElementReader(field)})`;
  if (field.kind === 'enum') return `JsonBodyReader.EnumValue<${field.elementCsType}>(${source}, ${name})`;
  if (field.kind === 'composite') return `ValueReaders.Read${field.elementCsType}(JsonBodyReader.Property(${source}, ${name}))`;
  return `JsonBodyReader.Value<${field.elementCsType}?>(${source}, ${name})`;
}

/** La función que lee CADA elemento de una lista JSON (presente: un null dentro de la lista es malformada). */
function jsonElementReader(field) {
  if (field.kind === 'enum') return `JsonBodyReader.EnumElement<${field.elementCsType}>`;
  if (field.kind === 'composite') return `element => JsonBodyReader.Present(ValueReaders.Read${field.elementCsType}(element))`;
  return `JsonBodyReader.Element<${field.elementCsType}>`;
}

/** La expresión que lee un valor de TEXTO (`source`, un StringValues). */
function textRead(field, source) {
  if (field.list) return `TextValues.List<${field.elementCsType}>(${source}, item => ${present(field, textElement(field, 'item'))})`;
  return textElement(field, source);
}

function textElement(field, source) {
  if (field.kind === 'enum') return `TextValues.EnumValue<${field.elementCsType}>(${source})`;
  if (field.kind === 'composite') return `TextValues.Unreadable<${field.elementCsType}>(${source})`;
  return `TextValues.${TEXT_READERS[field.base] ?? 'String'}(${source})`;
}

/** Un valor que el diseño exige: si no llegó, la petición no se puede leer. */
export function present(field, expression) {
  return isValueType(field) ? `JsonBodyReader.PresentValue(${expression})` : `JsonBodyReader.Present(${expression})`;
}

/** Las reglas de un campo como argumentos C# (datos neutrales de keel-core). */
export function rulesArgs(rules) {
  return rules
    .map((rule) => {
      switch (rule.rule) {
        case 'notNull':
          return 'InputRule.NotNull';
        case 'notBlank':
          return 'InputRule.NotBlank';
        case 'notEmpty':
          return 'InputRule.NotEmpty';
        case 'size':
          return `InputRule.Size(${rule.min ?? 'null'}, ${rule.max ?? 'null'})`;
        case 'pattern':
          return `InputRule.Pattern(${csString(rule.regexp)})`;
        case 'min':
          return `InputRule.Min(${csString(String(rule.value))})`;
        case 'max':
          return `InputRule.Max(${csString(String(rule.value))})`;
        case 'digits':
          return `InputRule.Digits(${rule.integer}, ${rule.fraction})`;
        default:
          throw new Error(`keel-dotnet no sabe escribir la regla de validación '${rule.rule}'`);
      }
    })
    .join(', ');
}

export function valueReaders(model) {
  const { namespace, path } = located(model, 'appSupport', 'ValueReaders');
  const usings = ['System.Text.Json'];
  const readers = model.valueObjects.map((vo) => {
    usings.push(...fieldUsings(model, { csType: vo.name }));
    const args = vo.fields.map((field) => {
      usings.push(...fieldUsings(model, field));
      const read = jsonRead(field, 'fields');
      // Un campo obligatorio ausente: la petición no se puede leer (el constructor no admite el null).
      if (field.list) return `${read} ?? []`;
      return field.required ? present(field, read) : read;
    });
    return `    /// <summary>${vo.name} desde el cuerpo JSON: si su constructor lo rechaza, la petición es malformada.</summary>
    public static ${vo.name}? Read${vo.name}(JsonElement? value) =>
        JsonBodyReader.ValueObject(value, fields => new ${vo.name}(${args.length > 0 ? `\n            ${args.join(',\n            ')})` : ')'});`;
  });
  const body = `/// <summary>Los value objects del diseño leídos de un cuerpo JSON, con las guardas de su constructor.</summary>
public static class ValueReaders
{
${readers.join('\n\n')}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

/** ¿Resuelve esta operación la identidad del llamante contra las credenciales del recurso (resolvedBy)? */
export function resolvesCaller(model, operation) {
  return callerResolution(model) != null && messageComponents(operation, model).some((component) => component.resolvedIdentity);
}

// ─── Endpoints ──────────────────────────────────────────────────────────────────────────────────

function renderEndpoints(model, service, served) {
  const className = endpointsClass(service);
  const { namespace, path } = located(model, 'endpoints', className);
  const usings = [
    'Microsoft.AspNetCore.Http',
    'Microsoft.Extensions.DependencyInjection',
    restNamespace(model),
    namespaceOf(model, 'appSupport'),
    namespaceOf(model, 'abstractions')
  ];
  const members = served.flatMap((operation) => [renderEndpoint(model, operation, usings), renderReader(model, operation, usings)]);
  const group = service.controllerClass.replace(/V1Controller$/, '');
  const body = `/// <summary>
/// Operaciones HTTP de ${group}. Solo traducen: leen la petición, despachan el caso de uso y escriben su resultado.
/// Las registra ApiRoutes.
/// </summary>
public static class ${className}
{
${members.join('\n\n')}

    private static IUseCaseMediator Mediator(HttpContext http) => http.RequestServices.GetRequiredService<IUseCaseMediator>();
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

function renderEndpoint(model, operation, usings) {
  usings.push(messageNamespace(model, operation));
  const { asBody } = requestShape(operation);
  // resolvedBy: la identidad del llamante se resuelve al recurso ANTES de leer, con el resolutor del ámbito de la petición.
  const resolving = resolvesCaller(model, operation);
  if (resolving) usings.push(securityNamespace(model));
  const callerArg = resolving ? ', await http.RequestServices.GetRequiredService<CallerIdentityResolver>().Resolve(CallerIdentity.Resolve(), http.RequestAborted)' : '';
  const read = `${asBody ? 'await ' : ''}Read${csMember(operation.name)}(http.Request${callerArg})`;
  // Lo que llama a la pasarela de pago va SIN transacción abarcadora (callsPaymentGateway, keel-core): su garantía
  // es registrar y confirmar ANTES de llamarla, como en keel-spring y keel-nest.
  const dispatch = callsPaymentGateway(model, operation.name) ? 'DispatchWithoutTransaction' : 'Dispatch';
  const call = `await Mediator(http).${dispatch}(message, http.RequestAborted)`;
  const status = operation.route.status;
  let statements;
  if (operation.responseDto) {
    const lines = [`        var message = ${read};`, `        var response = ${call};`];
    if (returnsLocation(model, operation)) {
      const target = locationTarget(model, operation);
      const value = target.param ? `TextValues.Route(http.Request, ${csString(target.param)}).ToString()` : 'response.Id';
      lines.push(`        // ${status} con la ruta que LEE el recurso creado (keel-core/gen/api-contract.js).`);
      lines.push(`        http.Response.Headers.Location = HttpReply.Location(http.Request, ${csString(target.path)}, ${value});`);
    }
    lines.push(`        await HttpReply.Json(http, ${status}, response);`);
    statements = lines.join('\n');
  } else {
    statements = [`        var message = ${read};`, `        ${call};`, `        HttpReply.Status(http, ${status});`].join('\n');
  }
  return `${xmlDoc([`${operation.route.method} ${operation.route.path} (${operation.name}).`, operation.description], '    ')}    public static async Task ${csMember(operation.name)}(HttpContext http)
    {
${statements}
    }`;
}

function renderReader(model, operation, usings) {
  const { asBody, bodyRequired } = requestShape(operation);
  const components = messageComponents(operation, model);
  const fromPath = new Set((operation.pathParams ?? []).map((param) => param.name));
  const partial = isPartialUpdate(operation);
  const pathLines = [];
  const pathChecks = [];
  const bodyLines = [];
  const bodyChecks = [];
  const queryRequired = [];
  const queryLines = [];
  const queryChecks = [];

  // 1. Ruta. En la ruta la presencia no dice nada: el segmento existe o la ruta no casa.
  for (const param of operation.pathParams ?? []) {
    usings.push(...fieldUsings(model, param));
    pathLines.push(`        var ${localOf(param)} = ${textRead(param, `TextValues.Route(httpRequest, ${csString(param.name)})`)};`);
    const rules = (param.inputValidation ?? []).filter((rule) => !['notNull', 'notBlank', 'notEmpty'].includes(rule.rule));
    if (rules.length > 0) pathChecks.push(`        paramChecks.Check(${csString(`${operation.name}.${param.name}`)}, ${localOf(param)}, ${rulesArgs(rules)});`);
  }

  // 2. Cuerpo, o 3. query.
  for (const component of components) {
    if (fromPath.has(component.name)) continue;
    // La identidad del llamante no viaja en la petición: la estampa el servidor (abajo).
    if (component.resolvedIdentity) continue;
    // La página no es un campo del diseño: la leen las líneas de abajo.
    if (component.pageable) continue;
    if (operation.paginated && ['page', 'size'].includes(component.name) && !(operation.bodyFields ?? []).some((f) => f.name === component.name)) continue;
    usings.push(...fieldUsings(model, component));
    const local = localOf(component);
    // El null de un PATCH sobre un campo que el dominio exige no vacía nada: es un 400 (keel-core/gen/model.js,
    // derivePatchNotNull). Solo cuando viene.
    const rules = component.patchNotNull ? [{ rule: 'notNull' }, ...(component.inputValidation ?? [])] : component.inputValidation ?? [];
    // Las de cada elemento de una lista (keel-core/gen, elementValidationRules): las del contenedor solo dicen cuántos.
    const each = component.list ? component.elementInputValidation ?? [] : [];
    if (asBody) {
      bodyLines.push(`        var ${local} = ${jsonRead(component, 'requestFields')};`);
      const threeState = isThreeState(operation, component);
      const checks = [];
      if (rules.length > 0) checks.push(`bodyChecks.Check(${csString(component.name)}, ${local}, ${rulesArgs(rules)});`);
      if (each.length > 0) checks.push(`bodyChecks.CheckEach(${csString(component.name)}, ${local}, ${rulesArgs(each)});`);
      if (threeState) {
        // Un opcional ausente en un PATCH es «no tocar»: no se valida, como el JsonNullable sin valor de keel-spring.
        bodyLines.push(`        var ${local}Present = JsonBodyReader.Has(requestFields, ${csString(component.name)});`);
        if (checks.length > 0) bodyChecks.push(`        if (${local}Present)\n        {\n${checks.map((c) => `            ${c}`).join('\n')}\n        }`);
      } else {
        bodyChecks.push(...checks.map((c) => `        ${c}`));
      }
    } else {
      const source = `httpRequest.Query[${csString(component.name)}]`;
      if (component.required) queryRequired.push(`        TextValues.Require(httpRequest, ${csString(component.name)});`);
      queryLines.push(`        var ${local} = ${textRead(component, source)};`);
      if (rules.length > 0) queryChecks.push(`        paramChecks.Check(${csString(`${operation.name}.${component.name}`)}, ${local}, ${rulesArgs(rules)});`);
      if (each.length > 0) queryChecks.push(`        paramChecks.CheckEach(${csString(`${operation.name}.${component.name}`)}, ${local}, ${rulesArgs(each)});`);
    }
  }
  if (components.some((component) => component.pageable)) {
    // La paginación con persistencia: el Pageable de Spring Data (página, tamaño y orden), con el orden del diseño
    // cuando el cliente no pide uno. Los defaults y el tope: keel-core/gen/pagination.js.
    const { defaultSize, maxSize, defaultSort } = pageableDefaults(model, operation);
    usings.push(repositoriesNamespace(model));
    const sort = defaultSort.map((criterion) => `new SortOrder(${csString(criterion.property)}, SortDirection.${criterion.direction === 'desc' ? 'Desc' : 'Asc'})`);
    queryLines.push(`        var pageable = PageableReading.Read(httpRequest.Query, defaultSize: ${defaultSize}, maxSize: ${maxSize}, defaultSort: [${sort.join(', ')}]);`);
  } else if (operation.paginated) {
    // La paginación sin persistencia: dos enteros de la query con sus defaults (también con cuerpo).
    queryLines.push('        var page = TextValues.Int(httpRequest.Query["page"]) ?? 0;');
    queryLines.push(`        var size = TextValues.Int(httpRequest.Query["size"]) ?? ${model.pagination?.defaultSize ?? 20};`);
  }

  // El mensaje, campo a campo.
  const assigns = components.map((component) => {
    const member = csMember(component.name);
    const local = localOf(component);
    const type = componentType(operation, component, model);
    let value;
    if (component.resolvedIdentity && callerResolution(model)) {
      // resolvedBy: la credencial del token es UNA de las del recurso, y el endpoint la resolvió antes de leer a su clave
      // natural (o null si no es de nadie: la precondición la responde la operación con el error que declare el diseño).
      value = 'resolvedCaller';
    } else if (component.resolvedIdentity) {
      // La estampa el servidor desde la credencial (security.authentication.callerIdentity), nunca el cuerpo: quien hace
      // la petición no elige en nombre de quién actúa.
      usings.push(securityNamespace(model));
      value = 'CallerIdentity.Resolve()';
    } else if (type.startsWith('Optional<')) {
      const inner = type.slice('Optional<'.length, -1);
      usings.push(namespaceOf(model, 'appSupport'));
      value = `${local}Present ? Optional<${inner}>.Of(${component.list ? `${local} ?? []` : local}) : Optional<${inner}>.Absent`;
    } else if (component.list) {
      value = `${local} ?? []`;
    } else if (type.endsWith('?')) {
      // Opcional, o con default que pone el dominio: llega tal cual, null incluido.
      value = local;
    } else if (component.pageable || (operation.paginated && ['page', 'size'].includes(component.name) && !fromPath.has(component.name))) {
      value = local;
    } else {
      value = present(component, local);
    }
    return `            ${member} = ${value},`;
  });

  const lines = [...pathLines];
  if (asBody) {
    lines.push(`        var requestFields = await HttpJsonBody.ReadObject(httpRequest, required: ${bodyRequired});`);
    lines.push(...bodyLines);
    if (bodyChecks.length > 0) lines.push('        var bodyChecks = new InputViolations(ViolationSource.Body);', ...bodyChecks, '        bodyChecks.ThrowIfAny();');
  } else {
    lines.push(...queryRequired);
  }
  lines.push(...queryLines);
  const paramChecks = [...pathChecks, ...queryChecks];
  if (paramChecks.length > 0) lines.push('        var paramChecks = new InputViolations(ViolationSource.Params);', ...paramChecks, '        paramChecks.ThrowIfAny();');
  const construct = assigns.length > 0 ? `new ${operation.messageClass}\n        {\n${assigns.join('\n')}\n        }` : `new ${operation.messageClass}()`;
  const resolved = resolvesCaller(model, operation) ? ', string? resolvedCaller' : '';
  const signature = asBody
    ? `private static async Task<${operation.messageClass}> Read${csMember(operation.name)}(HttpRequest httpRequest${resolved})`
    : `private static ${operation.messageClass} Read${csMember(operation.name)}(HttpRequest httpRequest${resolved})`;
  return `    /// <summary>Lee ${operation.route.method} ${operation.route.path} (${operation.name}) al mensaje de su caso de uso.</summary>
    ${signature}
    {
${lines.join('\n')}${lines.length > 0 ? '\n' : ''}        return ${construct};
    }`;
}

// ─── La tabla de rutas ──────────────────────────────────────────────────────────────────────────

/** La fila del contrato HTTP de una operación: lo que registra ApiRoutes y compara la paridad. */
export function routeRow(model, operation) {
  const { asBody, bodyRequired } = requestShape(operation);
  const fromPath = new Set((operation.pathParams ?? []).map((param) => param.name));
  const query = asBody
    ? []
    : messageComponents(operation, model)
        .filter((c) => !fromPath.has(c.name) && !c.resolvedIdentity)
        // El Pageable viaja como los tres parámetros de Spring Data.
        .flatMap((c) => (c.pageable ? ['page', 'size', 'sort'] : [c.name]));
  return {
    operation: operation.name,
    method: operation.route.method,
    path: `${model.api.routeBase}${operation.route.path}`,
    status: operation.route.status,
    location: returnsLocation(model, operation),
    query,
    body: asBody ? (bodyRequired ? 'required' : 'optional') : null
  };
}

function routesFile(model) {
  const { namespace, path } = located(model, 'rest', 'ApiRoutes');
  const served = servedRoutes(model);
  const usings = ['Microsoft.AspNetCore.Builder', 'Microsoft.AspNetCore.Http', 'Microsoft.AspNetCore.Routing', ...(served.length > 0 ? [namespaceOf(model, 'endpoints')] : [])];
  const rows = served.map(({ service, operation }) => {
    const row = routeRow(model, operation);
    return (
      `        new(${csString(row.operation)}, ${csString(row.method)}, ${csString(row.path)}, ${row.status}, ` +
      `Location: ${row.location}, Query: [${row.query.map(csString).join(', ')}], ` +
      `Body: ${row.body ? csString(row.body) : 'null'}, Handler: ${endpointsClass(service)}.${csMember(operation.name)}),`
    );
  });
  const body = `/// <summary>Una fila del contrato HTTP del servicio: la operación, su ruta, su status y cómo viaja su entrada.</summary>
public sealed record ApiRoute(string Operation, string Method, string Path, int Status, bool Location, IReadOnlyList<string> Query, string? Body, RequestDelegate Handler);

/// <summary>
/// El contrato HTTP del servicio como DATOS: una fila por operación con ruta. Es el único mapa de rutas (de aquí se
/// registran todos los endpoints) y lo compara con keel-spring el test de paridad del contrato.
/// </summary>
public static class ApiRoutes
{
    public static IReadOnlyList<ApiRoute> All { get; } =
    [
${rows.join('\n')}
    ];

    public static IEndpointRouteBuilder MapApiRoutes(this IEndpointRouteBuilder endpoints)
    {
        foreach (var route in All)
        {
            endpoints.MapMethods(route.Path, [route.Method], route.Handler);
        }
        return endpoints;
    }
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}
