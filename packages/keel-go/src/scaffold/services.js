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

import { ENTRY_GATES, carriesEntryGate, dispatchNote, entryGateNote, scheduleDispatch, usesEntryGate } from '@keel-system/keel-core/gen';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { textFilterNotes } from '@keel-system/keel-core/gen/text-filters';
import { finderNote } from '@keel-system/keel-core/gen/query-filters';
import { finderCall } from './finders.js';
import { followUpRejectionNote } from '@keel-system/keel-core/gen/rejection-notes';
import { isPartialUpdate, repositoryRoots } from '@keel-system/keel-core/gen/features';
import { naturalKeyFinder, repositoryParam } from './repositories.js';
import { deletedRootOf, logicalDeletionNote, restoreNote } from '@keel-system/keel-core/gen/data-lifecycle';
import { handlerDependencies, usesDependencies } from './use-cases.js';
import { goExported } from '../lib/go-projection.js';
import { alignRows, commentLines, goString } from '../lib/go-source.js';
import { dataImports, wireTag } from './dtos.js';
import { sentinelOf } from './errors.js';
import { idempotencyMethods, idempotencyNotes } from './request-idempotency.js';
import { appType, applicationPath, docComment, domainPath, goFileName, goTypeName, isOptional, layout, packageFile } from './render.js';
import { ownershipNotes } from '@keel-system/keel-core/gen/ownership';
import { optionalIdentityNote } from '@keel-system/keel-core/gen/read-scope';
import { compensationNote } from '@keel-system/keel-core/gen/compensation';
import { callerScopeNote } from './caller-scope.js';
import { CALLER_ROLES, roleCheckedOperation, usesCallerIdentity } from './security.js';
import { callMethod, clientParam, usesGoHttpClients } from './http-clients.js';
import { projectionNotes, replicaNote } from './projections.js';
import { mailNote } from './mail.js';
import { deadlineNotes } from './timer.js';
import { scheduledByTimer } from '@keel-system/keel-core/gen/timer-plan';
import { cacheHandlerNote } from './cache.js';
import { uploadHandlerNotes } from './storage.js';
import { READ_SCOPE_FIELD, readScopeHandlerNote } from './read-scope.js';
import { EXPECTED_VERSIONS, carriesExpectedVersions, conditionalHandlerNote, returnsVersioned, versionedType } from './conditional-writes.js';

export function generate(model) {
  const files = [];
  for (const operation of operations(model)) {
    files.push(renderMessage(model, operation));
    files.push(renderHandler(model, operation));
  }
  if (usesEntryGate(model)) files.push(...entryGateFiles(model));
  return files;
}

/** La constante Go de una puerta de keel-core (`HTTP` → `EntryGateHTTP`, `SUBSCRIPTION` → `EntryGateSubscription`). */
export function entryGateConstant(gate) {
  return gate === 'HTTP' ? 'EntryGateHTTP' : `EntryGate${gate[0]}${gate.slice(1).toLowerCase()}`;
}

/**
 * El campo de la puerta en el literal de un mensaje (`EntryGate: application.EntryGateSubscription`), o null si el mensaje
 * de esa operación no la lleva. La usan el reloj y la nota de la suscripción.
 */
export function entryGateField(model, operationName, gate, prefix = 'application.') {
  const operation = operations(model).find((candidate) => candidate.name === operationName);
  return operation && carriesEntryGate(model, operation) ? `EntryGate: ${prefix}${entryGateConstant(gate)}` : null;
}

/**
 * El handler de una operación que lleva su puerta, envuelto con `requireEntryGate`. En los otros tres el campo es
 * obligatorio al construir el mensaje y quien no lo dice no compila; Go no exige un campo en un literal, así que es el
 * despacho el que se niega a ejecutar un mensaje sin puerta, en voz alta.
 */
export function entryGateGuard(model, operation, handler) {
  if (!carriesEntryGate(model, operation)) return handler;
  const wrapper = contractOf(operation).kind === 'KindCommand' ? 'requireEntryGateCommand' : 'requireEntryGate';
  return `${wrapper}(${goString(operation.name)}, func(m ${messageType(operation)}) EntryGate { return m.EntryGate }, ${handler})`;
}

const ENTRY_GATE_DOCS = {
  HTTP: 'llegó por su endpoint, la única puerta que responde un error a quien llamó',
  SUBSCRIPTION: 'llegó por una suscripción a un mensaje',
  DISPATCH: 'la despachó otro caso de uso (use-cases.dispatches)',
  SCHEDULE: 'la disparó el reloj'
};

function entryGateFiles(model) {
  const { application } = layout(model);
  const carrying = operations(model).filter((operation) => carriesEntryGate(model, operation));
  const commands = carrying.some((operation) => contractOf(operation).kind === 'KindCommand');
  const returning = carrying.some((operation) => contractOf(operation).kind !== 'KindCommand');
  const constants = ENTRY_GATES.flatMap((gate) => [
    { text: `\t// ${entryGateConstant(gate)}: ${ENTRY_GATE_DOCS[gate]}.` },
    { indent: '\t', cells: [entryGateConstant(gate), 'EntryGate', `= ${goString(gate)}`] }
  ]);
  const wrappers = [];
  const tests = [];
  if (returning) {
    wrappers.push(`// requireEntryGate envuelve el caso de uso de una operación que entra por HTTP y por otra puerta: un mensaje que no dice
// por cuál llegó no se despacha. En los otros tres generadores el campo es obligatorio y quien construye el mensaje sin
// él no compila; Go no exige un campo en un literal, así que falla aquí, en voz alta, en vez de decidir sin la puerta.
func requireEntryGate[M, R any](operation string, gate func(M) EntryGate, next Handler[M, R]) Handler[M, R] {
	return HandlerFunc[M, R](func(ctx context.Context, msg M) (R, error) {
		if err := gate(msg).check(operation); err != nil {
			var zero R
			return zero, err
		}
		return next.Handle(ctx, msg)
	})
}`);
    tests.push(`func TestRequireEntryGateRechazaUnMensajeSinPuerta(t *testing.T) {
	reached := false
	handler := requireEntryGate("probe", func(gate EntryGate) EntryGate { return gate }, HandlerFunc[EntryGate, string](func(context.Context, EntryGate) (string, error) {
		reached = true
		return "ok", nil
	}))
	if _, err := handler.Handle(t.Context(), ""); err == nil || !strings.Contains(err.Error(), "probe") {
		t.Fatalf("un mensaje sin puerta se despachó: %v", err)
	}
	if reached {
		t.Fatal("un mensaje sin puerta llegó al handler")
	}
	if got, err := handler.Handle(t.Context(), EntryGateHTTP); err != nil || got != "ok" {
		t.Fatalf("con su puerta = %q, %v; quería ok", got, err)
	}
}`);
  }
  if (commands) {
    wrappers.push(`// requireEntryGateCommand es requireEntryGate para un comando sin resultado.
func requireEntryGateCommand[M any](operation string, gate func(M) EntryGate, next CommandHandler[M]) CommandHandler[M] {
	return CommandHandlerFunc[M](func(ctx context.Context, cmd M) error {
		if err := gate(cmd).check(operation); err != nil {
			return err
		}
		return next.Handle(ctx, cmd)
	})
}`);
    tests.push(`func TestRequireEntryGateCommandRechazaUnMensajeSinPuerta(t *testing.T) {
	reached := false
	handler := requireEntryGateCommand("probe", func(gate EntryGate) EntryGate { return gate }, CommandHandlerFunc[EntryGate](func(context.Context, EntryGate) error {
		reached = true
		return nil
	}))
	if err := handler.Handle(t.Context(), "SIDEWAYS"); err == nil || !strings.Contains(err.Error(), "probe") || reached {
		t.Fatalf("un mensaje con una puerta que no existe se despachó: %v", err)
	}
	if err := handler.Handle(t.Context(), EntryGateSubscription); err != nil {
		t.Fatalf("con su puerta: %v", err)
	}
}`);
  }
  const body = `
// EntryGate es la puerta por la que llegó el mensaje de una operación que entra por HTTP y por alguna otra (una
// suscripción, un despacho, el reloj). HTTP es la única que puede responder un error a quien llamó: por las demás nadie
// espera la respuesta, y lo que por HTTP es un 422 tiene que quedar en el estado. Las reglas del diseño que distinguen
// las puertas («por HTTP…», «por la suscripción…») se deciden con ella, nunca deduciéndola de otra cosa. La fija quien
// construye el mensaje: el endpoint generado pone EntryGateHTTP; la suscripción, el despacho y el reloj, la suya.
type EntryGate string

const (
${alignRows(constants).join('\n')}
)

// check devuelve un error si g no es una de las puertas: el mensaje se construyó sin decirla.
func (g EntryGate) check(operation string) error {
	switch g {
	case ${ENTRY_GATES.map(entryGateConstant).join(', ')}:
		return nil
	}
	return fmt.Errorf("%s: el mensaje no dice por qué puerta llegó (EntryGate %q)", operation, string(g))
}

${wrappers.join('\n\n')}
`;
  const test = `
// Un mensaje sin su puerta no llega al handler: la envoltura lo rechaza nombrando la operación.

${tests.join('\n\n')}
`;
  const path = applicationPath(model, 'EntryGate');
  return [
    { path, content: packageFile(model, application, { imports: ['context', 'fmt'], body }) },
    { path: path.replace(/\.go$/, '_test.go'), content: packageFile(model, application, { imports: ['context', 'strings', 'testing'], body: test }) }
  ];
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

/**
 * El tipo del resultado de la operación, o null si no devuelve nada. Con el modelo, la lectura que da el ETag y la
 * escritura condicional que devuelve su raíz devuelven también la versión (D6 de PLAN-DSL-225-ESCRITURA-CONDICIONAL.md):
 * el compilador obliga al agente a darla.
 */
export function resultType(operation, model = null) {
  if (!operation.responseDto) return null;
  const dto = goTypeName(operation.responseDto.name);
  if (model && returnsVersioned(model, operation)) return versionedType(dto);
  // PagedResponse[T] ya envuelve la lista.
  if (operation.paginated) return `PagedResponse[${dto}]`;
  if (operation.returnsList) return `[]${dto}`;
  return dto;
}

/**
 * El contrato de la operación: la interfaz que implementa su handler y la clase de mensaje, que decide el log
 * (y, con la persistencia, la transacción: de lectura para una consulta).
 */
export function contractOf(operation, model = null) {
  const result = resultType(operation, model);
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

// La página que pide una consulta paginada sin persistencia: dos enteros de la consulta de la URL, no del cuerpo.
const PAGE_COMPONENTS = [
  { name: 'page', goType: 'int32', kind: 'base', base: 'int', required: true, goImports: [], paging: true },
  { name: 'size', goType: 'int32', kind: 'base', base: 'int', required: true, goImports: [], paging: true }
];

// Con persistencia, la página es el Pageable de Spring Data (página, tamaño y orden): `?page=&size=&sort=`, el mismo
// contrato que los otros tres. Lo lee el puerto del repositorio, así que su tipo es del dominio.
const PAGEABLE_COMPONENT = { name: 'pageable', goType: 'domain.Pageable', kind: 'base', required: true, goImports: [], paging: true, pageable: true };

/** ¿Lee esta operación la página como un Pageable? Con persistencia, como los otros tres generadores. */
export function usesPageable(model, operation) {
  return Boolean(operation.paginated) && model != null && repositoryRoots(model).length > 0;
}

/**
 * Los componentes del mensaje: parámetros de ruta (en el orden del path) + campos del cuerpo + paginación. Los
 * comparte el lector de la API (endpoints.js) para construir el mensaje.
 */
export function messageComponents(operation, model) {
  const path = (operation.pathParams ?? []).map((param) => ({ ...param, fromPath: true }));
  const paging = !operation.paginated ? [] : usesPageable(model, operation) ? [PAGEABLE_COMPONENT] : PAGE_COMPONENTS;
  return [...path, ...(operation.bodyFields ?? []), ...paging];
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
 * punto por el que pasa. `reject` no necesita nada aquí: lo dice el lector del borde. `target` es la variable del
 * mensaje: el lector de la API (endpoints.js) lee el cuerpo campo a campo y redondea con la misma línea.
 */
export function scaleRounding(operation, component, target = 'm') {
  const numeric = component.numeric;
  if (component.kind === 'composite' || component.list || !numeric?.decimal || numeric.scalePolicy !== 'round' || numeric.scale == null) return null;
  if (isThreeState(operation, component) || !fromBody(component)) return null;
  const field = `${target}.${goExported(component.name)}`;
  const rescale = (value) => `${value}.Rescale(${numeric.scale}, wire.RoundHalfUp)`;
  return componentType(operation, component).startsWith('*')
    ? `\tif ${field} != nil {\n\t\trounded := ${rescale(`(*${field})`)}\n\t\t${field} = &rounded\n\t}`
    : `\t${field} = ${rescale(field)}`;
}

function renderMessage(model, operation) {
  const { application } = layout(model);
  const name = messageType(operation);
  const components = messageComponents(operation, model);
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
  // La puerta por la que llegó (keel-core/gen/entry-gates.js). No viaja en el cuerpo: un cliente elegiría por dónde entra.
  if (carriesEntryGate(model, operation)) {
    const doc = 'La puerta por la que llegó este mensaje: la fija quien lo construye (el endpoint generado pone\nEntryGateHTTP), nunca el cliente. Un mensaje sin ella no se despacha.';
    rows.push(...commentLines(doc, '\t').map((text) => ({ text })));
    rows.push({ indent: '\t', cells: ['EntryGate', 'EntryGate', '`json:"-"`'] });
  }
  // La versión que el cliente leyó (api.concurrency): la estampa el endpoint desde If-Match; nil desde otra puerta.
  if (carriesExpectedVersions(model, operation)) {
    const doc =
      "Las versiones que valen, del If-Match de la petición (api.concurrency). Las estampa el endpoint\ngenerado; nil —sin cabecera, '*' u otra puerta— no compara, y una lista vacía no casa con ninguna.\nPásala tal cual a LoadExpecting.";
    rows.push(...commentLines(doc, '\t').map((text) => ({ text })));
    rows.push({ indent: '\t', cells: [EXPECTED_VERSIONS, '[]int64', '`json:"-"`'] });
  }
  // El alcance de una lectura acotada (DSL 2.27, D1): lo estampa el endpoint desde el token. No viaja en el cuerpo.
  if (operation.readScope) {
    const doc = 'Qué filas ve quien lee (lectura acotada, DSL 2.27): lo estampa el endpoint generado desde el\ntoken, nunca el cliente. Pásalo tal cual al puerto: el adaptador filtra con él. Su valor cero no ve nada.';
    rows.push(...commentLines(doc, '\t').map((text) => ({ text })));
    rows.push({ indent: '\t', cells:[READ_SCOPE_FIELD, 'domain.ReadScope', '`json:"-"`'] });
  }
  const struct =rows.length > 0 ? `struct {\n${alignRows(rows).join('\n')}\n}` : 'struct{}';
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
  // Con registro de idempotencia, su ámbito y su firma (request-idempotency.js).
  const idempotency = idempotencyMethods(model, operation, name, components, (component) => componentType(operation, component));
  if (idempotency) parts.push(idempotency.methods);
  const imports = [...dataImports(components), 'encoding/json/v2', 'encoding/json/jsontext', ...(idempotency?.imports ?? []), ...(operation.readScope ? ['internal/domain'] : [])];
  return { path: applicationPath(model, name), content: packageFile(model, application, { imports, body: `\n${parts.join('\n\n')}\n` }) };
}

/** Las notas de un componente que el diseño obliga a decir donde se ve. */
function componentNotes(model, component) {
  if (component.resolvedIdentity && usesCallerIdentity(model)) {
    return commentLines(
      'Lo resuelve el servidor desde la credencial (security.authentication.callerIdentity): no llega de la\npetición, lo estampa el lector del endpoint.',
      '\t'
    );
  }
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
  const contract = contractOf(operation, model);
  const message = messageType(operation);
  // Lo que recibe el handler y con qué lo cablea NewUseCases: una sola fuente (use-cases.js).
  const deps = handlerDependencies(model, operation);
  const fields = deps.length > 0
    ? `\n${deps
        .map((dep) => `\t// ${dep.doc}\n\t//\n\t//lint:ignore U1000 lo usa la lógica que escribe el agente (el TODO de Handle).\n\t${dep.name} ${dep.type}\n`)
        .join('\n')}`
    : '';
  const param = deps.map((dep) => `${dep.name} ${dep.type}`).join(', ');
  const init = deps.length > 0 ? `{${deps.map((dep) => `${dep.name}: ${dep.name}`).join(', ')}}` : '{}';
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
    content: packageFile(model, application, { imports: ['context', 'fmt', 'internal/domain'], body: body.replace(`struct {}`, 'struct{}'), generated: false })
  };
}

function handlerNotes(model, operation) {
  const notes = [];
  const dispatch = dispatchNote(model, operation, {
    call: (variant, target) => `h.useCases.${useCaseField(target)}.Handle(ctx, ${messageType(target)}{...})`,
    port: 'h.useCases, el despacho de los casos de uso del servicio que ya recibe el handler',
    withoutTransaction: 'WithoutTransaction(ctx) como contexto del despacho'
  });
  if (dispatch) notes.push(dispatch);
  const gate = entryGateNote(model, operation, { read: `${operation.messageKind === 'query' ? 'query' : 'cmd'}.EntryGate`, value: entryGateConstant });
  if (gate) notes.push(gate);
  // Los plazos (DSL 2.26): la nota de la operación que caduca y la de las que salen del estado. Neutrales, las mismas en los cuatro.
  notes.push(...deadlineNotes(model, operation));
  // La escritura condicional (api.concurrency): cargar con LoadExpecting y devolver la versión persistida.
  const root = operation.targetEntity ?? operation.responseDto?.entity ?? 'Raiz';
  const conditional = conditionalHandlerNote(model, operation, operation.messageKind === 'query' ? 'query' : 'cmd', repositoryParam({ name: root }));
  if (conditional) notes.push(conditional);
  // El ciclo de vida del dato (DSL 2.28): el borrado que marca y la restauración. Notas neutrales, las mismas en los cuatro.
  const deletedRoot = deletedRootOf(model, operation);
  const deletion = logicalDeletionNote(model, operation, { deleteCall: `h.${repositoryParam(deletedRoot ?? { name: 'Raiz' })}.DeleteByID(ctx, …)` });
  if (deletion) notes.push(deletion);
  if (operation.restores) {
    const restored = model.entities.find((candidate) => candidate.name === operation.restores);
    const port = `h.${repositoryParam(restored ?? { name: operation.restores })}`;
    const keyFinder = restored ? naturalKeyFinder(model, restored) : null;
    const byKey = keyFinder ? `${port}.${keyFinder.name.replace(/^FindBy/, 'FindDeletedBy')}(ctx, …)` : '<el id de la borrada>';
    const restore = restoreNote(model, operation, { findCall: byKey, restoreCall: `${port}.Restore(ctx, <su id>)` });
    if (restore) notes.push(restore);
  }
  // La búsqueda con finder (DSL 2.22) ya aplica sus filtros, plegado incluido: su nota sustituye a las de los filtros de texto.
  const finder = operation.finder;
  const entity = finder && model.entities.find((candidate) => candidate.name === finder.entity);
  const finderText = finderNote(operation, { call: finder ? finderCall(finder, repositoryParam(entity)) : '' });
  if (finderText) notes.push(finderText);
  // La lectura acotada (DSL 2.27): el adaptador ya filtra; la nota neutral dice qué pasar y que no se filtre a mano.
  const scopedRead = readScopeHandlerNote(model, operation, finder ? finderCall(finder, repositoryParam(entity)) : '');
  if (scopedRead) notes.push(scopedRead);
  if (!finder) for (const note of textFilterNotes(model, operation)) notes.push(note);
  notes.push(...idempotencyNotes(model, operation));
  // La autorización por propietario (security.ownership, DSL 2.23): la nota neutral de keel-core.
  const variable = operation.messageKind === 'query' ? 'query' : 'cmd';
  // La identidad opcional (DSL 2.27, R3c): el campo vacío es «anónimo», el token roto ya fue un 401 en el borde.
  const identityField = model.security?.callerIdentity?.field;
  const identity = operation.optionalAuth && identityField ? messageComponents(operation, model).find((component) => component.resolvedIdentity) : null;
  if (identity) notes.push(optionalIdentityNote(`${variable}.${goExported(identityField)}`, { none: componentType(operation, identity).startsWith('*') ? 'nil' : '""' }));
  notes.push(
    ...ownershipNotes(model, operation, {
      read: (field) => `${variable}.${goExported(field)}`,
      hasRole: usesDependencies(model) && roleCheckedOperation(model, operation) ? (role) => `h.${CALLER_ROLES.param}.HasRole(ctx, ${goString(role)})` : null
    })
  );
  const scope = usesDependencies(model) ? callerScopeNote(model, operation) : null;
  if (scope) notes.push(scope);
  notes.push(...scheduleNotes(model, operation));
  for (const text of operation.preconditions ?? []) notes.push(`Precondición: ${text}`);
  for (const text of operation.rules ?? []) notes.push(`Regla (en orden): ${text}`);
  // Lo que hace el handler cuando la pasarela contesta que NO (DSL 2.20): nota neutral, la de todos los generadores.
  const rejection = followUpRejectionNote(model.payments, operation.name);
  if (rejection) notes.push(rejection);
  for (const code of operation.errors ?? []) {
    const error = operationError(model, operation.name, code);
    // StatusErrorf recibe el status: es el de ESTA operación.
    const build = error?.dynamicStatus ? `domain.StatusErrorf(domain.${sentinelOf(code)}, ${error.http}, "…")` : `domain.Errorf(domain.${sentinelOf(code)}, "…")`;
    notes.push(
      `Error: devolver ${build} (${code}, HTTP ${error?.http ?? 400})${error?.when ? ` cuando: ${error.when}` : ''}` +
        ` — ${domainPath(model, 'errors')}`
    );
  }
  for (const transition of operation.transitions ?? []) {
    notes.push(
      `Transición: ${transition.entity} ${(transition.from ?? []).join('|')} → ${transition.to}. La aplica el método semántico ` +
        'del agregado (que llama a transitionTo), nunca el handler asignando el estado.'
    );
  }
  const mailing = mailNote(model, operation);
  if (mailing) notes.push(mailing);
  const caching = cacheHandlerNote(model, operation);
  if (caching) notes.push(caching);
  notes.push(...uploadHandlerNotes(model, operation));
  notes.push(...reconciliationNotes(model, operation));
  const compensation = compensationNote(operation);
  if (compensation) notes.push(compensation);
  for (const { dependency, need } of operation.dependencyNeeds ?? []) notes.push(needNote(model, dependency, need, operation));
  notes.push(...projectionNotes(model, operation));
  notes.push(...activationNotes(model, operation));
  for (const eventName of operation.emits ?? []) {
    const event = (model.events ?? []).find((e) => e.name === eventName);
    const emitters = [...new Set((event?.emittedBy ?? []).filter((e) => e.operation === operation.name && e.aggregate).map((e) => e.aggregate))];
    notes.push(
      `Emite: ${eventName} — lo hace ${emitters.length > 0 ? emitters.join(' o ') : 'el agregado'} con raise(New${event?.className ?? `${eventName}Event`}(...)) dentro del método de negocio; el handler no publica nada`
    );
  }
  return notes.flatMap((note) => wrap(note));
}

/**
 * La nota de una operación disparada por reloj: cómo la despacha su tarea (keel-core/gen/scheduling.js, la misma decisión
 * que keel-spring, keel-nest y keel-dotnet) y lo que eso le cambia al handler. El archivo de la tarea (`<grupo>_tasks.go`)
 * se compone aquí para no importar el reloj desde los mensajes.
 */
function scheduleNotes(model, operation) {
  if (!operation.schedule || !usesDependencies(model)) return [];
  const mode = scheduleDispatch(model, operation);
  const service = model.services.find((candidate) => candidate.operations.includes(operation));
  const where = `${layout(model).scheduler.dir}/${goFileName(`${service.className.replace(/Service$/, '')}Tasks`)}.go`;
  // Con el cronómetro (inc. 8 del plan 2.26) la dispara el recurrente de su tarea en UNA réplica por tick, al menos una
  // vez; y si el reclamo lo escribe el agente, es él quien avisa del lote lleno para que el tick drene.
  const agentClaims = (operation.claim ?? []).length === 0 && !(operation.reconciles ?? []).some((reconcile) => reconcile.claim);
  return [
    scheduledByTimer(model, operation.name)
      ? `Por reloj (cron ${operation.schedule.cron}): la dispara el cronómetro (su tarea de ${where}, montada con timer.NewSchedule) en UNA réplica por tick, pero AL MENOS UNA VEZ: si la réplica muere a mitad de la pasada, otra la repite al vencer el arriendo. Lo que ` +
        'actúa sobre lo que encuentra tiene que RECLAMARLO (marcar la fila y quedarse con las que esta réplica se llevó), no solo leerlo. ' +
        'El tick DRENA: repite la pasada mientras el lote salga lleno, así que no proceses más de un lote por pasada.' +
        (agentClaims && operation.sweep
          ? ' Si el lote lo reclamas tú, AVISA del lote lleno con SweepClaimed(ctx, reclamadas, lote) (internal/application; application.SweepClaimed desde el adaptador) justo después de reclamar; sin el aviso el tick hace una sola pasada.'
          : '')
      : `Por reloj (cron ${operation.schedule.cron}): la dispara ${where} en TODAS las réplicas a la vez. Lo que ` +
        'actúa sobre lo que encuentra tiene que RECLAMARLO (marcar la fila y quedarse con las que esta réplica se llevó), no solo leerlo.',
    mode.withoutTransaction
      ? 'SIN TRANSACCIÓN ABARCADORA: la tarea la despacha con application.WithoutTransaction(ctx), así que cada llamada al ' +
        'repositorio confirma la SUYA. El orden es el de los commits: reclamar y confirmar, actuar fuera de toda transacción, ' +
        'confirmar el desenlace. Un fallo en una fila no puede revertir las demás.'
      : 'Corre en UNA transacción, la del caso de uso: no llama a nadie en medio de su trabajo, así que todo o nada.',
    // El reclamo y el rescate ya los genera build (claim.js, tramo 10c): el handler los llama, no los reescribe.
    ...(operation.claim ?? []).map((claim) => {
      const call = `h.${repositoryParam({ name: claim.entity })}.${goExported(claim.method)}(ctx)`;
      return claim.stalled
        ? `EL RESCATE YA ESTÁ GENERADO: ${call} devuelve los ${claim.entity} que llevan atascados en ` +
            `${claim.stalled.state} más que su plazo y que ESTA réplica se llevó, SIGUIENDO en ${claim.stalled.state} con ${claim.stalled.stampField} ` +
            `renovado. La transición a ${claim.to} la haces TÚ con el método del agregado (fija los campos que ${claim.to} exige) y la guardas. ` +
            'No escribas otro rescate, ni un finder por estado, ni una cota propia. Un fallo en una fila NO corta el lote: cada Save se ' +
            'comprueba por separado, y un conflicto de versión es la carrera con quien saca la fila del estado a la vez (la ganó él): sigue ' +
            'con la siguiente. Sin eso, una sola fila que pierde la carrera deja las demás arrendadas sin rescatar hasta que vuelva a vencer su plazo.'
        : `EL RECLAMO YA ESTÁ GENERADO: toma el lote con ${call}, que devuelve SOLO los ${claim.entity} ` +
            `que ESTA réplica se llevó, ya en ${claim.to}${claim.stamps ? ` y con ${claim.stamps.field} estampado` : ''}. El tamaño del lote no se pasa: ` +
            `lo acota el adaptador con sweep.${claim.sweepKey}.batch-size. No escribas otro reclamo (ni un finder por estado ni un lock): ` +
            'un segundo mecanismo en paralelo no reclama nada. Actúa sobre cada fila y guárdala: un fallo en una no revierte las demás.';
    })
  ];
}

/**
 * La nota de un barrido de RECONCILIACIÓN (tramo 11c), la de los otros tres generadores con los nombres de Go. Dos formas:
 * con el reclamo generado no se le dice CÓMO reclamar —sería pedirle que reescriba lo que existe, y el camino de menor
 * resistencia es un segundo mecanismo en paralelo—; sin él, sí. Lo que es suyo en las dos (el ORDEN de los commits, la
 * carrera con el camino feliz, qué hacer con cada candidato) va en las dos. Lo de la transacción ya lo dice la nota del
 * reloj (scheduleNotes).
 */
function reconciliationNotes(model, operation) {
  return (operation.reconciles ?? []).map(({ dependency, activation, waiting, claim }) => {
    const head = `Reconciliación de ${dependency}.${activation.name}: barre los encargos que nunca recibieron desenlace — el evento que los cerraría puede no llegar nunca. `;
    const decide = `Decide qué hace con cada uno según el efecto declarado ("${activation.effect}"): reintentar el encargo o disparar la compensación. Si el diseño no lo dice, es designGap. `;
    const race =
      'CARRERA CON EL CAMINO FELIZ: mientras barres puede llegar el evento de desenlace. Si al mover el candidato lo encuentras ya fuera del estado de espera ' +
      '(la transición del agregado devuelve domain.ErrInvalidStateTransition, o el Save domain.ErrConcurrentModification: compruébalo con errors.Is), ganó el otro camino: ' +
      'es la carrera resuelta, no un fallo — no lo registres como error ni lo reintentes, y sigue con el siguiente. Cualquier OTRO error se devuelve: no lo tragues. ';
    const republish =
      'Y si lo que haces es reencargar publicando un evento, no lo absorbe nada: cada réplica hace su propio raise y estampa un metadata.eventId distinto, así que para el consumidor son N hechos. ';
    if (claim) {
      const call = `h.${repositoryParam({ name: claim.entity })}.${goExported(claim.method)}(ctx)`;
      return (
        head +
        `EL RECLAMO YA ESTÁ GENERADO: toma el lote con ${call}. Devuelve SOLO los candidatos que ESTA réplica se llevó —${scheduledByTimer(model, operation.name) ? 'el tick del cronómetro es al menos una vez y puede repetirse en otra réplica' : 'el barrido corre en todas a la vez'}— y ya trae dentro el umbral que declara el diseño, la cota del lote y la caducidad de la marca (config/parameters/<perfil>/reconciliation.yaml). NO escribas otro reclamo (ni un finder por estado, ni un lock, ni una marca propia en ${claim.entity}): un segundo mecanismo en paralelo al generado no reclama nada, solo reparte peor. ` +
        decide +
        reconciliationOrder(operation, activation, true) +
        'El reclamo no sustituye a la idempotencia saliente: lo que absorbe una llamada repetida al proveedor —tras una caducidad o un reintento— es solo esa. ' +
        republish +
        race +
        'Lo verifica infra/check-idempotency.sh, familia reconciliation'
      );
    }
    const { store } = layout(model);
    return (
      head +
      (waiting.length > 0 ? `Los candidatos son ${waiting.join(', ')} que llevan demasiado tiempo ahí. ` : 'Los candidatos son las entidades que quedaron esperando el desenlace. ') +
      `build NO pudo generar el reclamo (su aviso dice por qué), así que lo escribes tú, en el adaptador del repositorio y no aquí. DESDE CUÁNDO: la marca temporal la declara el diseño en awaitingSince${activation.awaitingSince ? ` (${activation.awaitingSince})` : ''}; NO uses createdAt ni un updatedAt de auditoría. ` +
      `Los tres números —umbral (del diseño), caducidad del reclamo y cota del lote— están en ReconciliationSettings.Windows[${goString(activation.name)}] (${store.dir}/reconciliation.go, que lee el arranque): léelos de ahí, no de una constante. ` +
      'CÓMO reclamar: con una marca persistida que caduca en reconciliation_claim, confirmada ANTES de llamar al proveedor; no con un lock, que solo aísla mientras dura su transacción. ' +
      decide +
      reconciliationOrder(operation, activation, false) +
      republish +
      race +
      'Lo verifica infra/check-idempotency.sh, familia reconciliation'
    );
  });
}

/**
 * El ORDEN de un barrido de reconciliación, el de los otros tres: si reintenta la misma activación, proveedor primero y
 * transición después; si llama a OTRA que DESHACE el encargo, la entidad se resuelve primero.
 */
function reconciliationOrder(operation, activation, claimGenerated) {
  const calls = (operation.dependencyActivations ?? []).filter(({ activation: called }) => called.http);
  const retries = calls.some(({ activation: called }) => called.name === activation.name);
  const undoes = calls.filter(({ activation: called }) => called.name !== activation.name);
  const first = claimGenerated ? '(1) el reclamo, que ya está hecho y confirmado' : '(1) marcar el reclamo y confirmar, que es lo que lo hace visible a las demás réplicas';
  if (undoes.length > 0 && !retries) {
    const names = undoes.map(({ dependency, activation: called }) => `${dependency}.${called.name}`).join(', ');
    return (
      `ORDEN: aquí el barrido no reintenta el encargo, lo DESHACE con ${names}, así que va al revés que un reintento — ` +
      `${first}; (2) transición al estado final y confirmar (Save); (3) después, fuera de toda transacción, llamar a ${names}. ` +
      'Llamar antes y morir antes de confirmar dejaría deshecho el trabajo del proveedor y la entidad todavía en espera. Si una regla del diseño fija el orden, manda la regla. '
    );
  }
  return (
    `ORDEN: son DOS commits y no se confunden — ${first}; (2) llamar al proveedor, FUERA de toda transacción; (3) transición al estado final y confirmar (Save). ` +
    'Si actúas y mueres antes de (3), la marca caduca y la pasada siguiente repite la llamada, que es lo que absorbe la idempotencia saliente. ' +
    'Al revés —confirmar el desenlace y luego actuar— si mueres en medio dejas la entidad resuelta y el trabajo vivo en el proveedor: un huérfano que no detecta nadie. Si una regla del diseño fija el orden, manda la regla. '
  );
}

/**
 * Las notas de las activaciones de esta operación (`dependencies.activations`) y el ORDEN de sus efectos: las de los otros
 * tres generadores, con los nombres de Go. En un barrido de reconciliación el orden es otro y lo dice su propia nota, así
 * que aquí no se da: dos órdenes opuestos en el mismo handler no son dos consejos, son uno que el agente elegiría al azar.
 */
function activationNotes(model, operation) {
  const notes = [];
  const sweep = Boolean(operation.schedule);
  const reconciles = (operation.reconciles ?? []).length > 0;
  for (const { dependency, activation } of operation.dependencyActivations ?? []) notes.push(activationNote(model, dependency, activation, sweep));
  const calls = (operation.dependencyActivations ?? []).filter(({ activation }) => activation.http);
  if ((operation.transitions ?? []).length === 0 || calls.length === 0 || reconciles) return notes;
  const fromKeys = operation.transitions.flatMap((t) => (t.from ?? []).map((state) => `${t.entity}::${state}`));
  const branches = fromKeys.some((key, index) => fromKeys.indexOf(key) !== index);
  const decided = branches ? calls.filter(({ activation }) => activation.awaits === 'outcome') : [];
  const decidedNames = new Set(decided.map(({ activation }) => activation.name));
  if (decided.length > 0) {
    notes.push(
      `ORDEN de los efectos: ${decided.map(({ dependency, activation }) => `${dependency}.${activation.name}`).join(', ')} es awaits: outcome y su resultado DECIDE la transición. ` +
        'Comprueba primero la precondición de estado SIN escribir nada, llama después y aplica la transición que corresponda al veredicto. ' +
        'Si una regla del diseño fija el orden, manda la regla'
    );
  }
  const outgoing = calls.filter(({ activation }) => !decidedNames.has(activation.name));
  if (outgoing.length > 0) {
    const guards = operation.transitions.map((t) => `${t.entity}: ${(t.from ?? []).join('|')} → ${t.to}`).join('; ');
    notes.push(
      `ORDEN de los efectos: aplica PRIMERO la transición de estado (${guards}) y solo después llama a ${outgoing.map(({ dependency, activation }) => `${dependency}.${activation.name}`).join(', ')}. ` +
        'La llamada saliente no es transaccional: si sale antes y la guarda del agregado rechaza el cambio, el rollback revierte la fila ' +
        'pero el trabajo ya está encargado en el otro servidor y nadie lo deshace'
    );
  }
  return notes;
}

/**
 * La nota de un dato que esta operación pide a otro servidor (`needs`): la de los otros tres generadores, con los nombres de
 * Go. La réplica se lee por su lector.
 */
function needNote(model, depId, need, operation) {
  const why = need.description ? ` — ${need.description}` : '';
  if (need.strategy !== 'on-demand') return replicaNote(model, depId, need, operation, why);
  if (!need.fetch) {
    return `Dependencia ${depId}.${need.name} (on-demand)${why}: el diseño no resuelve la llamada (fetchedFrom no apunta a ninguna de http-clients). No inventes el canal: dilo en el reporte`;
  }
  const client = (model.httpClients ?? []).find((candidate) => candidate.clientClass === need.fetch.clientClass);
  const call = client?.calls.find((candidate) => candidate.name === need.fetch.call);
  const port = client && usesGoHttpClients(model) ? `h.${clientParam(client)}` : `el cliente ${need.fetch.clientClass}`;
  const method = call ? callMethod(call) : need.fetch.call;
  const policy = need.onUnavailable
    ? ` Si ${depId} no responde, el fallback del adaptador ya aplica onUnavailable: ${need.onUnavailable.action}${need.onUnavailable.action === 'fail' || need.onUnavailable.error ? ' y su error se devuelve tal cual' : ''}; no lo conviertas en otra cosa.`
    : '';
  const exposed =
    need.exposedAs && need.dtoName
      ? ` El dato SALE en la respuesta: la función de mapeo pide un ${goTypeName(need.dtoName)} por parámetro y lo pone en el campo '${need.exposedAs}' — si no lo tienes, pásalo nil, que es lo que el contrato admite cuando el proveedor no responde.`
      : '';
  return (
    `Dependencia ${depId}.${need.name} (on-demand)${why}: pide el dato con ${port}.${method}(ctx, ...), que ya devuelve el resultado de dominio ` +
    `(domain.${goTypeName(need.fetch.resultType)}): el DTO del cable no cruza a la aplicación. El retry y el circuito ya están en el adaptador: no los repitas.${policy}${exposed}`
  );
}

/** La nota de una activación: el trabajo que esta operación delega en otro servidor (la de los otros tres generadores). */
function activationNote(model, depId, activation, sweep) {
  if (activation.event) {
    return `Activación ${depId}.${activation.name}: ${activation.effect} — se delega publicando ${activation.event.name}, que emite el agregado con raise(New${activation.event.className ?? '...'}(...)) dentro del método de negocio. El handler no publica nada, y no esperes respuesta: publicar un evento no devuelve resultado`;
  }
  if (!activation.http) {
    return `Activación ${depId}.${activation.name}: ${activation.effect} — el diseño no resuelve el canal (via.client/call no existe en http-clients). No inventes la llamada: dilo en el reporte`;
  }
  const awaits = {
    outcome: `awaits: outcome — el resultado que devuelve ${depId} condiciona el desenlace de esta operación: no basta con que la llamada no falle. Qué significa un desenlace negativo lo dice el diseño: si specs/decisions.yaml acepta OBL-OUTCOME-NEGATIVE-UNDECIDED, manda esa decisión (y puede que el cuerpo no importe).`,
    acknowledgement: `awaits: acknowledgement — basta con que ${depId} acuse recibo; no interpretes el cuerpo como parte del desenlace.`,
    nothing: sweep
      ? 'awaits: nothing — no se espera nada de vuelta, pero la llamada sigue siendo síncrona y su plazo bloquea la pasada del barrido.'
      : 'awaits: nothing — no se espera nada de vuelta, pero la llamada sigue siendo síncrona y ocurre DENTRO de la transacción del caso de uso: su plazo la mantiene abierta.'
  }[activation.awaits];
  const onFailure = activation.onFailure;
  const failure = {
    ignore: `onFailure: ignore — que ${depId} no responda no interrumpe esta operación; el fallback del adaptador ya lo absorbe, lo registra y devuelve el resultado vacío con err == nil. No lo reintentes aquí.`,
    fail: `onFailure: fail — si ${depId} no responde, esta operación falla con ${onFailure?.error ? `domain.${sentinelOf(onFailure.error)}` : 'el error del diseño'}; el fallback del adaptador ya lo devuelve. Devuélvelo tal cual, sin convertirlo en otra cosa.`,
    degrade: `onFailure: degrade — si ${depId} no responde, esta operación degrada y el resultado degradado lo escribes TÚ: ${onFailure?.degradedTo}`
  }[onFailure?.action];
  const client = (model.httpClients ?? []).find((candidate) => candidate.clientClass === activation.http.clientClass);
  const call = client?.calls.find((candidate) => candidate.name === activation.http.call);
  const port = client && usesGoHttpClients(model) ? `h.${clientParam(client)}` : `el cliente ${activation.http.clientClass}`;
  const method = call ? callMethod(call) : activation.http.call;
  return `Activación ${depId}.${activation.name}: ${activation.effect} — invoca ${port}.${method}(ctx, ...). El retry y el circuito ya están en el adaptador: no los repitas. ${awaits ?? ''} ${failure ?? ''}`.trim();
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
