// La capa de aplicación por operación: su MENSAJE (comando o consulta) y su HANDLER, que es donde el agente
// implementa la lógica. El mismo reparto que keel-spring, keel-nest y keel-dotnet, con la granularidad de Go: todo
// vive en el paquete `application` (PLAN-KEEL-GO.md § 2) y cada pieza es un archivo.
//
// El mensaje lo escribe build (cabecera de código generado) y el handler el agente (sin ella): en un solo archivo,
// refrescar el mensaje pisaría la lógica. El mensaje es también el cuerpo HTTP —no hay `XxxRequest`—, así que cada
// campo lleva el nombre del cable en su tag; lo que llega por la ruta o por la consulta (`page`, `size`) lleva
// `json:"-"`. Un opcional de PATCH es `wire.Optional[T]`: ausente (no se toca), null (se vacía) o con valor.
//
// El handler nace con las notas del diseño (precondiciones, reglas, errores, eventos, transiciones) y devuelve
// `ErrNotImplemented` envuelto con su operación: COMPILA y falla en ejecución nombrándola, como el
// UnsupportedOperationException de keel-spring. Un error se devuelve, no se lanza (§ 3.2). Lo que cuelga de capas
// que keel-go todavía no genera (el repositorio, la idempotencia, el correo, los clientes salientes) llega con su
// incremento: el handler de hoy solo recibe lo que existe.

import { dispatchNote } from '@keel-system/keel-core/gen';
import { textFilterNotes } from '@keel-system/keel-core/gen/text-filters';
import { followUpRejectionNote } from '@keel-system/keel-core/gen/rejection-notes';
import { isPartialUpdate } from '@keel-system/keel-core/gen/features';
import { goExported } from '../lib/go-projection.js';
import { alignRows, commentLines, goString } from '../lib/go-source.js';
import { dataImports, wireTag } from './dtos.js';
import { sentinelOf } from './errors.js';
import { appType, applicationPath, docComment, domainPath, goTypeName, isOptional, layout, packageFile } from './render.js';

export function generate(model) {
  const files = [];
  for (const operation of operations(model)) {
    files.push(renderMessage(model, operation));
    files.push(renderHandler(model, operation));
  }
  return files;
}

/** Las operaciones del diseño, en orden. */
export function operations(model) {
  return (model.services ?? []).flatMap((service) => service.operations ?? []);
}

/** El nombre Go del mensaje y del handler de una operación. */
export function messageType(operation) {
  return goTypeName(operation.messageClass);
}

export function handlerType(operation) {
  return goTypeName(operation.handlerClass);
}

/** El campo de `UseCases` por el que se despacha una operación: `createProduct` → `CreateProduct`. */
export function useCaseField(operation) {
  return goExported(operation.name);
}

/** El tipo del resultado de la operación, o null si no devuelve nada. */
export function resultType(operation) {
  if (!operation.responseDto) return null;
  const dto = goTypeName(operation.responseDto.name);
  // PagedResponse[T] ya envuelve la lista.
  if (operation.paginated) return `PagedResponse[${dto}]`;
  if (operation.returnsList) return `[]${dto}`;
  return dto;
}

/**
 * El contrato de la operación: la interfaz que implementa su handler y la clase de mensaje, que decide el log
 * (y, con la persistencia, la transacción: de lectura para una consulta).
 */
export function contractOf(operation) {
  const result = resultType(operation);
  const message = messageType(operation);
  if (operation.messageKind === 'query') {
    if (!result) throw new Error(`La consulta ${operation.name} no devuelve nada: el modelo no la deja así`);
    return { kind: 'KindQuery', handler: `Handler[${message}, ${result}]`, result };
  }
  if (operation.messageKind === 'returningCommand') {
    return { kind: 'KindReturningCommand', handler: `Handler[${message}, ${result}]`, result };
  }
  return { kind: 'KindCommand', handler: `CommandHandler[${message}]`, result: null };
}

// La página que pide una consulta paginada: viaja en la consulta de la URL, no en el cuerpo.
const PAGE_COMPONENTS = [
  { name: 'page', goType: 'int32', kind: 'base', base: 'int', required: true, goImports: [], paging: true },
  { name: 'size', goType: 'int32', kind: 'base', base: 'int', required: true, goImports: [], paging: true }
];

/**
 * Los componentes del mensaje: parámetros de ruta (en el orden del path) + campos del cuerpo + paginación. Los
 * comparte el lector de la API (incremento 5) para construir el mensaje.
 */
export function messageComponents(operation) {
  const path = (operation.pathParams ?? []).map((param) => ({ ...param, fromPath: true }));
  return [...path, ...(operation.bodyFields ?? []), ...(operation.paginated ? PAGE_COMPONENTS : [])];
}

/**
 * ¿Es un opcional de TRES estados? En un PATCH, un opcional del cuerpo distingue AUSENTE (conserva el valor) de
 * PRESENTE CON NULL (vacía el campo). También una lista: ausente no la toca, y null o [] la vacían
 * (list-never-null), como el JsonNullable de keel-spring.
 */
export function isThreeState(operation, component) {
  return isPartialUpdate(operation) && !component.fromPath && !component.paging && !component.required && !component.isId;
}

/** El tipo con el que el mensaje DECLARA un componente. */
export function componentType(operation, component) {
  if (isThreeState(operation, component)) {
    const inner = appType({ ...component, required: true });
    return `wire.Optional[${inner}]`;
  }
  // Un campo con default puede no llegar (la entrada no exige su presencia): en el mensaje es un puntero, y el
  // default lo aplica el dominio.
  const type = appType(component);
  if (component.initializer != null && !component.generated && !component.list && !isOptional(component)) return `*${type}`;
  return type;
}

/** ¿Se lee del cuerpo JSON? Lo de la ruta, la página y una subida binaria llegan por otro sitio. */
function fromBody(component) {
  return !component.fromPath && !component.paging && component.goType !== 'FileUpload';
}

/**
 * `constraints.scalePolicy: round` (DSL 2.14): el decimal escalar se redondea a su escala al ENTRAR. No tiene tipo
 * propio donde normalizarse —el de un compuesto lo pone su value object—, así que va en el mensaje, el primer
 * punto por el que pasa. `reject` no necesita nada aquí: lo dice el lector del borde.
 */
export function scaleRounding(operation, component) {
  const numeric = component.numeric;
  if (component.kind === 'composite' || component.list || !numeric?.decimal || numeric.scalePolicy !== 'round' || numeric.scale == null) return null;
  if (isThreeState(operation, component) || !fromBody(component)) return null;
  const field = `m.${goExported(component.name)}`;
  const rescale = (value) => `${value}.Rescale(${numeric.scale}, wire.RoundHalfUp)`;
  return componentType(operation, component).startsWith('*')
    ? `\tif ${field} != nil {\n\t\trounded := ${rescale(`(*${field})`)}\n\t\t${field} = &rounded\n\t}`
    : `\t${field} = ${rescale(field)}`;
}

function renderMessage(model, operation) {
  const { application } = layout(model);
  const name = messageType(operation);
  const components = messageComponents(operation);
  const rows = [];
  for (const component of components) {
    const notes = componentNotes(model, component);
    for (const text of notes) rows.push({ text });
    if (component.description) {
      for (const text of docComment(goExported(component.name), component.description, null, '\t').trimEnd().split('\n')) rows.push({ text });
    }
    const tag = fromBody(component) ? wireTag(model, component, { omit: false }) : '`json:"-"`';
    const type = componentType(operation, component);
    rows.push({ indent: '\t', cells: [goExported(component.name), type, type.startsWith('wire.Optional[') ? tag.replace(/"`$/, ',omitzero"`') : tag] });
  }
  const struct = rows.length > 0 ? `struct {\n${alignRows(rows).join('\n')}\n}` : 'struct{}';
  const parts = [`${docComment(name, operation.description, `el mensaje de ${operation.name}`)}type ${name} ${struct}`];
  const rounding = components.map((component) => scaleRounding(operation, component)).filter(Boolean);
  if (rounding.length > 0) {
    parts.push(`// UnmarshalJSONFrom lee ${name} del cable y redondea a su escala los decimales con scalePolicy: round.
func (m *${name}) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	type plain ${name}
	if err := json.UnmarshalDecode(dec, (*plain)(m)); err != nil {
		return err
	}
${rounding.join('\n')}
	return nil
}`);
  }
  const imports = [...dataImports(components), 'encoding/json/v2', 'encoding/json/jsontext'];
  return { path: applicationPath(model, name), content: packageFile(model, application, { imports, body: `\n${parts.join('\n\n')}\n` }) };
}

/** Las notas de un componente que el diseño obliga a decir donde se ve. */
function componentNotes(model, component) {
  if (component.fromPath || component.list) return [];
  const inherited = component.inheritedPattern;
  if (!inherited || !(model.formatTypes ?? []).some((type) => type.name === component.typeName)) return [];
  const text = [
    `El formato del value type ${component.typeName} (${inherited}) se valida YA en la entrada: mal formado`,
    'es un 400 antes que cualquier precondición. No lo valides otra vez al principio del handler.',
    `El dominio lo repite con ${component.typeName}Format.Validate(...) (${domainPath(model, `${component.typeName}Format`)})`,
    'en el constructor o el método de negocio de la entidad que recibe el valor: es lo que cubre lo que no entra por',
    'la API (un evento, una operación interna), y lo exige el gate check-domain-guards.sh.'
  ].join('\n');
  return commentLines(text, '\t');
}

function renderHandler(model, operation) {
  const { application } = layout(model);
  const name = handlerType(operation);
  const contract = contractOf(operation);
  const message = messageType(operation);
  const dispatches = (operation.dispatches ?? []).length > 0;
  // El despacho de otro caso de uso (use-cases.dispatches, DSL 2.21): recibe los casos de uso del servicio, ya
  // envueltos con su log de frontera, y despacha por ellos. Nunca a un handler directamente.
  const fields = dispatches
    ? `
	// useCases despacha las operaciones que esta declara en use-cases.dispatches.
	//
	//lint:ignore U1000 lo usa la lógica que escribe el agente (el TODO de Handle).
	useCases *UseCases
`
    : '';
  const param = dispatches ? 'useCases *UseCases' : '';
  const init = dispatches ? '{useCases: useCases}' : '{}';
  const variable = operation.messageKind === 'query' ? 'query' : 'cmd';
  const returns = contract.result ? `(${contract.result}, error)` : 'error';
  const failure = `fmt.Errorf("%w: %s", ErrNotImplemented, ${goString(operation.name)})`;
  const zero = contract.result ? `${contract.result.startsWith('[]') ? 'nil' : `${contract.result}{}`}, ` : '';
  const notes = handlerNotes(model, operation).map((line) => `\t// ${line}`.trimEnd());
  const body = `
${docComment(name, operation.description, `el caso de uso ${operation.name}`)}type ${name} struct {${fields}}

// New${name} construye el caso de uso ${operation.name}.
func New${name}(${param}) *${name} {
	return &${name}${init}
}

// Handle ejecuta ${operation.name}.
func (h *${name}) Handle(ctx context.Context, ${variable} ${message}) ${returns} {
	// TODO (agente): implementar la lógica de negocio de esta operación.
${notes.join('\n')}${notes.length > 0 ? '\n' : ''}	return ${zero}${failure}
}
`;
  return {
    path: applicationPath(model, name),
    content: packageFile(model, application, { imports: ['context', 'fmt'], body: body.replace(`struct {}`, 'struct{}'), generated: false })
  };
}

function handlerNotes(model, operation) {
  const notes = [];
  const dispatch = dispatchNote(model, operation, {
    call: (variant, target) => `h.useCases.${useCaseField(target)}.Handle(ctx, ${messageType(target)}{...})`,
    port: 'h.useCases, el despacho de los casos de uso del servicio que ya recibe el handler',
    withoutTransaction: 'la variante sin transacción (llega con la persistencia, incremento 6)'
  });
  if (dispatch) notes.push(dispatch);
  for (const note of textFilterNotes(model, operation)) notes.push(note);
  for (const text of operation.preconditions ?? []) notes.push(`Precondición: ${text}`);
  for (const text of operation.rules ?? []) notes.push(`Regla (en orden): ${text}`);
  // Lo que hace el handler cuando la pasarela contesta que NO (DSL 2.20): nota neutral, la de todos los generadores.
  const rejection = followUpRejectionNote(model.payments, operation.name);
  if (rejection) notes.push(rejection);
  for (const code of operation.errors ?? []) {
    const error = model.errors.find((e) => e.code === code);
    const build = error?.dynamicStatus ? 'domain.StatusErrorf' : 'domain.Errorf';
    notes.push(
      `Error: devolver ${build}(domain.${sentinelOf(code)}, "…") (${code}, HTTP ${error?.http ?? 400})${error?.when ? ` cuando: ${error.when}` : ''}` +
        ` — ${domainPath(model, 'errors')}`
    );
  }
  for (const transition of operation.transitions ?? []) {
    notes.push(
      `Transición: ${transition.entity} ${(transition.from ?? []).join('|')} → ${transition.to}. La aplica el método semántico ` +
        'del agregado (que llama a transitionTo), nunca el handler asignando el estado.'
    );
  }
  for (const eventName of operation.emits ?? []) {
    const event = (model.events ?? []).find((e) => e.name === eventName);
    const emitters = [...new Set((event?.emittedBy ?? []).filter((e) => e.operation === operation.name && e.aggregate).map((e) => e.aggregate))];
    notes.push(
      `Emite: ${eventName} — lo hace ${emitters.length > 0 ? emitters.join(' o ') : 'el agregado'} con raise(New${event?.className ?? `${eventName}Event`}(...)) dentro del método de negocio; el handler no publica nada`
    );
  }
  return notes.flatMap((note) => wrap(note));
}

/** Parte una nota larga en líneas de comentario legibles. */
function wrap(text, width = 100) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = `  ${word}`;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
