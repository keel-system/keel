// Los endpoints REST (`internal/httpapi`): uno por operación con ruta, agrupados en un archivo por grupo (el
// <Grupo>V1Controller de keel-spring), y por cada uno un LECTOR generado que convierte la petición al mensaje del caso
// de uso, que se despacha por su campo de `UseCases`. La tabla `routes` (routes.go) es el ÚNICO mapa de rutas: de ella
// se registran todos los endpoints en el ServeMux, y es lo que compara con keel-spring el test de paridad del contrato.
//
// El lector hace lo que en Spring hacen el binding y Bean Validation, en el MISMO orden que keel-nest y keel-dotnet,
// porque el orden decide qué error ve el cliente cuando hay más de uno:
//   1. los parámetros de ruta, convertidos a su tipo (un uuid mal formado es petición malformada);
//   2. el cuerpo, leído y convertido campo a campo (malformada) y validado (Validation Error, «no supera»);
//   3. la query: el obligatorio ausente («Falta el parámetro»), convertida (malformada);
//   4. las restricciones de ruta y query (Validation Error, «viola restricciones declaradas»).
// Qué se valida sale de las reglas neutrales (inputValidation, keel-core/gen/constraints.js); dónde viaja cada campo y
// si el cuerpo es obligatorio, de keel-core/gen/api-contract.js. Sin reflexión de tags: cada regla es una línea.
//
// El cuerpo NO se lee de golpe sobre el mensaje: encoding/json/v2 llama a UnmarshalJSONFrom también con `null` (medido),
// así que `"price": null` pasaría por NewMoney y saldría «malformada» donde keel-spring dice «price must not be null». Se
// lee primero como objeto (qué miembros llegaron) y después cada miembro presente y no nulo sobre su campo, como el
// JsonBodyReader de keel-dotnet.
//
// Lo que el borde necesita de rest-support.js (lectores de texto, `member`, `textLength`…) se emite solo si algún lector
// lo usa: staticcheck (U1000) rechaza una función sin usar. Por eso este módulo apunta en `plan.uses` lo que pide.

import { requestShape, returnsLocation, locationTarget } from '@keel-system/keel-core/gen/api-contract';
import { pageableDefaults } from '@keel-system/keel-core/gen/pagination';
import { usesApi } from '@keel-system/keel-core/gen/features';
import { goExported, goUnexported, enumConstant } from '../lib/go-projection.js';
import { goString } from '../lib/go-source.js';
import { goFileName, layout, packageFile } from './render.js';
import { usesCallerIdentity } from './security.js';
import { componentType, isThreeState, messageComponents, messageType, operations, scaleRounding, useCaseField } from './services.js';

// Los imports que puede usar un archivo de endpoints: goFile solo escribe los que el cuerpo usa.
const ENDPOINT_IMPORTS = ['fmt', 'net/http', 'strings', 'internal/application', 'internal/domain', 'internal/platform/wire'];

// El lector de TEXTO (ruta y query) de cada tipo base del diseño.
const TEXT_READERS = {
  uuid: 'textUUID',
  int: 'textInt32',
  long: 'textInt64',
  decimal: 'textDecimal',
  boolean: 'textBool',
  date: 'textDate',
  timestamp: 'textTimestamp',
  json: 'textJSON'
};

// Las constantes de net/http de los status de éxito.
export const STATUS_CONSTANTS = { 200: 'http.StatusOK', 201: 'http.StatusCreated', 202: 'http.StatusAccepted', 204: 'http.StatusNoContent' };
const METHOD_CONSTANTS = { GET: 'http.MethodGet', POST: 'http.MethodPost', PUT: 'http.MethodPut', PATCH: 'http.MethodPatch', DELETE: 'http.MethodDelete' };

const statusOf = (status) => STATUS_CONSTANTS[status] ?? String(status);

const PRESENCE = new Set(['notNull', 'notBlank', 'notEmpty']);

/** ¿Es un binario? Viaja en una subida multipart, que llega con la capa storage (incremento 13). */
function isFile(component) {
  return component.goType === 'FileUpload' || component.elementGoType === 'FileUpload' || component.base === 'file';
}

/** ¿Se sirve la operación? Con ruta, y sin binario: la subida multipart llega en el incremento 13. */
export function servedOperation(operation) {
  return Boolean(operation.route) && !messageComponents(operation).some(isFile);
}

/** Las operaciones servidas, con su grupo. */
export function servedRoutes(model) {
  return (model.services ?? []).flatMap((service) => (service.operations ?? []).filter(servedOperation).map((operation) => ({ service, operation })));
}

/** El nombre Go del endpoint de una operación (un método de `api`): `createProduct`. */
export function endpointName(operation) {
  return goUnexported(operation.name);
}

/** El nombre del lector de una operación: `readCreateProduct`. */
export function readerName(operation) {
  return `read${goExported(operation.name)}`;
}

/** El archivo de endpoints de un grupo: ProductV1Controller → product_endpoints.go. */
export function endpointsFile(model, service) {
  const group = service.controllerClass.replace(/V1Controller$/, '').replace(/Controller$/, '');
  return `${layout(model).httpapi.dir}/${goFileName(`${group}Endpoints`)}.go`;
}

const plans = new WeakMap();

/**
 * Lo que emite la API para el modelo, una sola vez: los archivos de endpoints y la tabla de rutas, y lo que piden del
 * soporte (`uses`, los auxiliares; `enums`, los lectores de texto de cada enum; `patterns`, las expresiones de las
 * reglas `pattern`, una variable por expresión).
 */
export function apiPlan(model) {
  if (plans.has(model)) return plans.get(model);
  const plan = { uses: new Set(), enums: new Set(), patterns: new Map(), files: [] };
  plans.set(model, plan);
  if (!usesApi(model)) return plan;
  for (const service of model.services ?? []) {
    const served = (service.operations ?? []).filter(servedOperation);
    if (served.length === 0) continue;
    const body = served.flatMap((operation) => [renderEndpoint(model, operation, plan), renderReader(model, operation, plan)]).join('\n\n');
    plan.files.push({ path: endpointsFile(model, service), content: packageFile(model, layout(model).httpapi, { imports: ENDPOINT_IMPORTS, body: `\n${body}\n` }) });
  }
  plan.files.push(routesFile(model));
  return plan;
}

export function generate(model) {
  return apiPlan(model).files;
}

// ─── Endpoints ──────────────────────────────────────────────────────────────────────────────────

function renderEndpoint(model, operation, plan) {
  const { method, path, status } = operation.route;
  const full = `${model.api.routeBase}${path}`;
  const variable = operation.messageKind === 'query' ? 'query' : 'cmd';
  const call = `a.useCases.${useCaseField(operation)}.Handle(r.Context(), ${variable})`;
  const lines = [`\t${variable}, err := ${readerName(operation)}(r)`, '\tif err != nil {', '\t\treturn err', '\t}'];
  if (operation.responseDto) {
    lines.push(`\tresponse, err := ${call}`, '\tif err != nil {', '\t\treturn err', '\t}');
    if (returnsLocation(model, operation)) {
      plan.uses.add('location');
      const target = locationTarget(model, operation);
      const value = target.param ? `r.PathValue(${goString(target.param)})` : 'fmt.Sprint(response.ID)';
      lines.push(`\t// ${status} con la ruta que LEE el recurso creado (keel-core/gen/api-contract.js).`);
      lines.push(`\tw.Header().Set("Location", location(r, ${goString(target.path)}, ${value}))`);
    }
    lines.push(`\treturn writeJSON(w, ${statusOf(status)}, response)`);
  } else {
    lines.push(`\tif err := ${call}; err != nil {`, '\t\treturn err', '\t}', `\tw.WriteHeader(${statusOf(status)})`, '\treturn nil');
  }
  return `// ${endpointName(operation)} atiende ${method} ${full} (${operation.name}): lee la petición, despacha el caso de uso y
// escribe su resultado. Solo traduce; la lógica es del handler.
func (a *api) ${endpointName(operation)}(w http.ResponseWriter, r *http.Request) error {
${lines.join('\n')}
}`;
}

// ─── El lector ──────────────────────────────────────────────────────────────────────────────────

/** El tipo Go de un elemento (el de la lista, o el propio). */
function elementType(component) {
  return component.list ? component.goType.replace(/^\[\]/, '') : component.goType;
}

/** ¿Es texto en Go? */
function isText(component) {
  return elementType(component) === 'string';
}

/** El lector de texto de un componente (de su elemento si es lista). */
function textReader(model, component, plan) {
  if (component.kind === 'enum') {
    const name = elementType(component);
    plan.enums.add(name);
    plan.uses.add('textEnum');
    return `text${name}`;
  }
  if (component.kind === 'composite') throw new Error(`keel-go no lee un value object (${component.name}) de un texto de la ruta o la query`);
  const reader = TEXT_READERS[component.base] ?? 'textString';
  plan.uses.add(reader);
  return reader;
}

/** La variable del patrón de una regla `pattern`, una por expresión. */
function patternVar(plan, regexp, field) {
  if (!plan.patterns.has(regexp)) {
    const taken = new Set(plan.patterns.values());
    let name = `${goUnexported(field)}Pattern`;
    for (let n = 2; taken.has(name); n += 1) name = `${goUnexported(field)}Pattern${n}`;
    plan.patterns.set(regexp, name);
  }
  return plan.patterns.get(regexp);
}

/** Una cota (`min`/`max`) comparada con el valor, según su tipo Go. */
function boundTest(value, goType, bound, op) {
  const text = String(bound);
  // Un puntero se desreferencia ANTES de llamar al método: `*x.Cmp(...)` sería `*(x.Cmp(...))`.
  if (goType === 'wire.Decimal') return `${value.startsWith('*') ? `(${value})` : value}.Cmp(wire.MustDecimal(${goString(text)})) ${op} 0`;
  if (goType === 'int32' || goType === 'int64') {
    if (/^-?\d+$/.test(text)) return `${value} ${op} ${text}`;
    return `wire.NewDecimal(int64(${value}), 0).Cmp(wire.MustDecimal(${goString(text)})) ${op} 0`;
  }
  throw new Error(`keel-go no sabe comparar una cota sobre ${goType}`);
}

/**
 * Las comprobaciones de las reglas que NO son de presencia sobre un valor presente: `{ init?, test, message }`, con
 * el mensaje por defecto de Hibernate Validator (lo que imprime Bean Validation en keel-spring).
 */
function valueChecks(rules, value, goType, list, field, plan) {
  const checks = [];
  for (const rule of rules) {
    switch (rule.rule) {
      case 'size': {
        const min = rule.min ?? 0;
        const max = rule.max ?? 2147483647;
        const length = list ? `len(${value})` : goType === 'string' ? `textLength(${value})` : null;
        if (!length) throw new Error(`keel-go no sabe medir el tamaño de ${goType}`);
        if (!list) plan.uses.add('textLength');
        const tests = [...(min > 0 ? [`n < ${min}`] : []), ...(rule.max != null ? [`n > ${max}`] : [])];
        if (tests.length > 0) checks.push({ init: `n := ${length}`, test: tests.join(' || '), message: `size must be between ${min} and ${max}` });
        break;
      }
      case 'pattern':
        if (goType !== 'string') throw new Error(`keel-go no sabe aplicar un patrón a ${goType}`);
        checks.push({ test: `!${patternVar(plan, rule.regexp, field)}.MatchString(${value})`, message: `must match "${rule.regexp}"` });
        break;
      case 'min':
        checks.push({ test: boundTest(value, goType, rule.value, '<'), message: `must be greater than or equal to ${rule.value}` });
        break;
      case 'max':
        checks.push({ test: boundTest(value, goType, rule.value, '>'), message: `must be less than or equal to ${rule.value}` });
        break;
      case 'digits':
        plan.uses.add('exceedsDigits');
        checks.push({ test: `exceedsDigits(${value}, ${rule.integer}, ${rule.fraction})`, message: `numeric value out of bounds (<${rule.integer} digits>.<${rule.fraction} digits> expected)` });
        break;
      default:
        if (!PRESENCE.has(rule.rule)) throw new Error(`keel-go no sabe escribir la regla de validación '${rule.rule}'`);
    }
  }
  return checks;
}

/** Las líneas de unas comprobaciones, con su sangría. */
function checkLines(checks, sink, path, indent) {
  return checks.flatMap(({ init, test, message }) => [
    `${indent}if ${init ? `${init}; ` : ''}${test} {`,
    `${indent}\t${sink}.add(${path}, ${goString(message)})`,
    `${indent}}`
  ]);
}

/** Las reglas de presencia que no se cumplen con el valor ausente (o, si `present` es null, siempre presente). */
function presenceChecks(rules, present, value) {
  const checks = [];
  const absent = present ? `!${present}` : null;
  for (const rule of rules) {
    if (rule.rule === 'notNull' && absent) checks.push({ test: absent, message: 'must not be null' });
    if (rule.rule === 'notBlank') checks.push({ test: [absent, `strings.TrimSpace(${value}) == ""`].filter(Boolean).join(' || '), message: 'must not be blank' });
    if (rule.rule === 'notEmpty') checks.push({ test: [absent, `len(${value}) == 0`].filter(Boolean).join(' || '), message: 'must not be empty' });
  }
  return checks;
}

/**
 * Todas las comprobaciones de un componente: `present` es la expresión que dice si llegó (null: siempre llega),
 * `value` la del valor y `pathOf` la del campo en el detalle (un literal Go).
 */
export function componentChecks(component, { rules, each, present, value, sink, path, plan, indent = '\t' }) {
  const type = elementType(component);
  const lines = [];
  lines.push(...checkLines(presenceChecks(rules, present, value), sink, path, indent));
  const others = checkLines(valueChecks(rules, value, component.list ? 'list' : type, component.list, component.name, plan), sink, path, present ? `${indent}\t` : indent);
  if (others.length > 0) lines.push(...(present ? [`${indent}if ${present} {`, ...others, `${indent}}`] : others));
  if (each.length > 0) {
    const elementChecks = [
      ...checkLines(presenceChecks(each, null, 'e'), sink, 'at', `${indent}\t`),
      ...checkLines(valueChecks(each, 'e', type, false, component.name, plan), sink, 'at', `${indent}\t`)
    ];
    if (elementChecks.length > 0) {
      lines.push(`${indent}for i, e := range ${value} {`, `${indent}\tat := fmt.Sprintf(${goString(`${path.slice(1, -1)}[%d]`)}, i)`, ...elementChecks, `${indent}}`);
    }
  }
  return lines;
}

/** Las comprobaciones de un opcional de tres estados (PATCH): solo si llegó, y la de presencia si llegó a null. */
function threeStateChecks(component, { rules, each, field, sink, path, plan }) {
  const type = elementType(component);
  const inner = checkLines(valueChecks(rules, 'value', component.list ? 'list' : type, component.list, component.name, plan), sink, path, '		');
  if (each.length > 0) {
    const elementChecks = checkLines(valueChecks(each, 'e', type, false, component.name, plan), sink, 'at', '			');
    if (elementChecks.length > 0) {
      inner.push('		for i, e := range value {', `			at := fmt.Sprintf(${goString(`${path.slice(1, -1)}[%d]`)}, i)`, ...elementChecks, '		}');
    }
  }
  // Llegó a null: lo incumplen las reglas de presencia, y ninguna otra.
  const messages = { notNull: 'must not be null', notBlank: 'must not be blank', notEmpty: 'must not be empty' };
  const nulled = rules.filter((rule) => messages[rule.rule]).map((rule) => `		${sink}.add(${path}, ${goString(messages[rule.rule])})`);
  if (inner.length === 0 && nulled.length === 0) return [];
  if (inner.length === 0) return [`	if ${field}.IsNull() {`, ...nulled, '	}'];
  const head = `	if value, ok := ${field}.Get(); ok {`;
  return nulled.length === 0 ? [head, ...inner, '	}'] : [head, ...inner, `	} else if ${field}.IsNull() {`, ...nulled, '	}'];
}

/** ¿Llega el componente como puntero (opcional, o con default que pone el dominio)? */
function isPointer(operation, component) {
  return componentType(operation, component).startsWith('*');
}

function returnErr(expression) {
  return [`\tif ${expression}; err != nil {`, '\t\treturn msg, err', '\t}'];
}

function renderReader(model, operation, plan) {
  const { asBody, bodyRequired } = requestShape(operation);
  const components = messageComponents(operation, model);
  const message = messageType(operation);
  const pathLines = [];
  const bodyLines = [];
  const pathChecks = [];
  const bodyChecks = [];
  const queryRequired = [];
  const queryLines = [];
  const queryChecks = [];
  const mustBePresent = [];
  const identity = [];
  const paramPath = (name) => goString(`${operation.name}.${name}`);

  // 1. Ruta. En la ruta la presencia no dice nada: el segmento existe o la ruta no casa.
  for (const param of components.filter((c) => c.fromPath)) {
    const field = `msg.${goExported(param.name)}`;
    if (isText(param) && param.kind !== 'enum') pathLines.push(`\t${field} = r.PathValue(${goString(param.name)})`);
    else pathLines.push(...returnErr(`${field}, err = ${textReader(model, param, plan)}(r.PathValue(${goString(param.name)}))`));
    const rules = (param.inputValidation ?? []).filter((rule) => !PRESENCE.has(rule.rule));
    pathChecks.push(...componentChecks(param, { rules, each: [], present: null, value: field, sink: 'inParams', path: paramPath(param.name), plan }));
  }

  for (const component of components) {
    if (component.fromPath || isFile(component)) continue;
    const field = `msg.${goExported(component.name)}`;
    // La identidad del llamante no viaja en la petición: la estampa el lector desde la credencial, DESPUÉS de leer y
    // validar la petición (en keel-spring la estampa el controller sobre el comando ya validado).
    if (component.resolvedIdentity) {
      if (usesCallerIdentity(model)) identity.push(...returnErr(`${field}, err = callerIdentity(r.Context())`));
      else (asBody ? bodyChecks : queryLines).push(`\t// ${field}: la identidad del llamante no se lee de la petición (el diseño no autentica).`);
      continue;
    }
    // La página con persistencia: el Pageable de Spring Data (página, tamaño y orden), con el orden del diseño cuando
    // el cliente no pide uno. Los defaults y el tope: keel-core/gen/pagination.js.
    if (component.pageable) {
      plan.uses.add('pageableParam');
      const { defaultSize, maxSize, defaultSort } = pageableDefaults(model, operation);
      const sort = defaultSort.map((criterion) => `{Property: ${goString(criterion.property)}, Direction: domain.${criterion.direction === 'desc' ? 'SortDesc' : 'SortAsc'}}`);
      queryLines.push(`	${field} = pageableParam(r, ${defaultSize}, ${maxSize}, []domain.SortOrder{${sort.join(', ')}})`);
      continue;
    }
    // La página sin persistencia: dos enteros de la query con sus defaults (también con cuerpo).
    if (component.paging) {
      plan.uses.add('pageParam');
      const fallback = component.name === 'size' ? model.pagination?.defaultSize ?? 20 : 0;
      queryLines.push(...returnErr(`${field}, err = pageParam(r, ${goString(component.name)}, ${fallback})`));
      continue;
    }
    // El null de un PATCH sobre un campo que el dominio exige no vacía nada: es un 400 (keel-core/gen/model.js).
    const rules = component.patchNotNull ? [{ rule: 'notNull' }, ...(component.inputValidation ?? [])] : component.inputValidation ?? [];
    const each = component.list ? component.elementInputValidation ?? [] : [];
    const pointer = isPointer(operation, component);
    if (asBody) {
      // 2. Cuerpo: cada miembro presente sobre su campo, con el contrato del cable.
      const name = goString(component.name);
      if (isThreeState(operation, component)) {
        plan.uses.add('optionalMember');
        bodyLines.push(...returnErr(`err = optionalMember(fields, ${name}, &${field})`));
        bodyChecks.push(...threeStateChecks(component, { rules, each, field, sink: 'inBody', path: name, plan }));
        continue;
      }
      plan.uses.add('member');
      bodyLines.push(...returnErr(`err = member(fields, ${name}, &${field})`));
      const rounding = scaleRounding(operation, component, 'msg');
      if (rounding) bodyLines.push(rounding);
      if (!pointer) plan.uses.add('has');
      const present = pointer ? `${field} != nil` : `has(fields, ${name})`;
      bodyChecks.push(...componentChecks(component, { rules, each, present, value: pointer ? `*${field}` : field, sink: 'inBody', path: name, plan }));
      if (component.required && !pointer && !component.list) mustBePresent.push(component.name);
      continue;
    }
    // 3. Query.
    const name = goString(component.name);
    if (component.required && !pointer) {
      plan.uses.add('requireParam');
      queryRequired.push(...returnErr(`err = requireParam(r, ${name})`));
    }
    if (component.kind === 'composite') {
      plan.uses.add('unreadableParam');
      queryLines.push(...returnErr(`err = unreadableParam(r, ${name})`));
      continue;
    }
    let present;
    if (component.list) {
      plan.uses.add('listParam');
      queryLines.push(...returnErr(`${field}, err = listParam(r, ${name}, ${textReader(model, component, plan)})`));
      present = `${field} != nil`;
    } else if (pointer) {
      if (isText(component) && component.kind !== 'enum') {
        plan.uses.add('optionalText');
        queryLines.push(`\t${field} = optionalText(r, ${name})`);
      } else {
        plan.uses.add('optionalParam');
        queryLines.push(...returnErr(`${field}, err = optionalParam(r, ${name}, ${textReader(model, component, plan)})`));
      }
      present = `${field} != nil`;
    } else {
      if (isText(component) && component.kind !== 'enum') {
        plan.uses.add('queryValue');
        queryLines.push(`\t${field}, _ = queryValue(r, ${name})`);
      } else {
        plan.uses.add('requiredParam');
        queryLines.push(...returnErr(`${field}, err = requiredParam(r, ${name}, ${textReader(model, component, plan)})`));
      }
      present = null;
    }
    queryChecks.push(...componentChecks(component, { rules, each, present, value: pointer ? `*${field}` : field, sink: 'inParams', path: paramPath(component.name), plan }));
  }

  const out = [...pathLines];
  if (asBody) {
    plan.uses.add('readObject');
    out.push(`	fields, err := readObject(r, ${bodyRequired})`, '	if err != nil {', '		return msg, err', '	}', ...bodyLines);
    if (bodyChecks.some((line) => !line.startsWith('	//'))) {
      plan.uses.add('violations');
      out.push('	inBody := violations{}', ...bodyChecks, ...returnErr('err = inBody.err()'));
    } else out.push(...bodyChecks);
  }
  out.push(...queryRequired, ...queryLines);
  const paramChecks = [...pathChecks, ...queryChecks];
  if (paramChecks.length > 0) {
    plan.uses.add('violations');
    out.push('\tinParams := violations{params: true}', ...paramChecks, ...returnErr('err = inParams.err()'));
  }
  if (mustBePresent.length > 0) {
    // Lo que el diseño exige y no llegó sin una regla que lo diga: la petición no se puede leer (en keel-spring, el
    // constructor del record no admite el null).
    plan.uses.add('has');
    plan.uses.add('malformed');
    out.push(`\tif ${mustBePresent.map((name) => `!has(fields, ${goString(name)})`).join(' || ')} {`, '\t\treturn msg, malformed(nil)', '\t}');
  }
  out.push(...identity);
  return `// ${readerName(operation)} lee ${operation.route.method} ${model.api.routeBase}${operation.route.path} (${operation.name}) al mensaje de su caso de
// uso, en el orden del binding de keel-spring: la ruta, el cuerpo, la query y después sus reglas.
func ${readerName(operation)}(r *http.Request) (msg application.${message}, err error) {
${out.join('\n')}${out.length > 0 ? '\n' : ''}\treturn msg, nil
}`;
}

// ─── La tabla de rutas ──────────────────────────────────────────────────────────────────────────

/** La fila del contrato HTTP de una operación: lo que registra `routes` y compara la paridad. */
export function routeRow(model, operation) {
  const { asBody, bodyRequired } = requestShape(operation);
  // El Pageable viaja como los tres parámetros de Spring Data.
  const names = (c) => (c.pageable ? ['page', 'size', 'sort'] : [c.name]);
  const query = asBody
    ? messageComponents(operation, model).filter((c) => c.paging).flatMap(names)
    : messageComponents(operation, model)
        .filter((c) => !c.fromPath && !c.resolvedIdentity && !isFile(c))
        .flatMap(names);
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
  const { httpapi } = layout(model);
  const rows = servedRoutes(model).map(({ operation }) => {
    const row = routeRow(model, operation);
    const parts = [
      `Operation: ${goString(row.operation)}`,
      `Method: ${METHOD_CONSTANTS[row.method] ?? goString(row.method)}`,
      `Path: ${goString(row.path)}`,
      `Status: ${statusOf(row.status)}`,
      ...(row.location ? ['Location: true'] : []),
      ...(row.query.length > 0 ? [`Query: []string{${row.query.map(goString).join(', ')}}`] : []),
      ...(row.body ? [`Body: ${goString(row.body)}`] : []),
      `handle: (*api).${endpointName(operation)}`
    ];
    return `\t{${parts.join(', ')}},`;
  });
  const body = `
// Route es una fila del contrato HTTP del servicio: una operación con su ruta, su status de éxito y cómo viaja su
// entrada.
type Route struct {
	// Operation es la operación del diseño.
	Operation string
	// Method es el método HTTP.
	Method string
	// Path es la ruta completa, con sus parámetros entre llaves.
	Path string
	// Status es el status de éxito.
	Status int
	// Location dice si la respuesta lleva la cabecera Location.
	Location bool
	// Query son los parámetros que se leen de la query.
	Query []string
	// Body es "required" u "optional" si la operación lee un cuerpo JSON, o "" si no lo lee.
	Body string

	handle func(*api, http.ResponseWriter, *http.Request) error
}

// routes es el contrato HTTP del servicio como DATOS, una fila por operación con ruta en el orden del diseño. Es el
// único mapa de rutas: de aquí se registran todos los endpoints, y lo compara con keel-spring el test de paridad.
var routes = []Route{
${rows.join('\n')}
}

// Routes devuelve el contrato HTTP del servicio: una copia de la tabla de la que se registran los endpoints.
func Routes() []Route {
	return slices.Clone(routes)
}
`;
  return { path: `${httpapi.dir}/routes.go`, content: packageFile(model, httpapi, { imports: ['net/http', 'slices'], body }) };
}

/** Las constantes Go de los valores de un enum, para su lector de texto. */
export function enumValues(model, name) {
  const enumDef = (model.enums ?? []).find((e) => e.name === name);
  if (!enumDef) throw new Error(`keel-go: el enum ${name} no está en el modelo`);
  return enumDef.values.map((value) => `domain.${enumConstant(name, value.literal)}`);
}

