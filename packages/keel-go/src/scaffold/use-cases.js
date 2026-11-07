// El patrón mediator de los otros tres generadores, dicho en Go y sin reflexión (PLAN-KEEL-GO.md § 3.4).
//
// En Spring, Nest y .NET un mediator resuelve el handler de un mensaje en tiempo de ejecución por su tipo. En Go
// eso sería reflexión en el camino de la petición; lo idiomático es lo contrario: el registro es un struct
// generado, `UseCases`, con UN CAMPO TIPADO POR OPERACIÓN (`Handler[CreateProductCommand, CreateProductResponseDto]`),
// y el compilador hace el trabajo del registro: un mensaje no puede llegar a otro handler, y una operación sin
// cablear no compila en `NewUseCases`. Lo que el mediator añadía por encima —el log de frontera de cada caso de
// uso y, con la persistencia, la transacción— es un decorador genérico (`observe`), como un middleware de
// net/http: `NewUseCases` envuelve cada handler al cablearlo.
//
//   · usecase.go — `Handler[M, R]`, `CommandHandler[M]`, sus adaptadores de función, `MessageKind`,
//     `ErrNotImplemented` y los decoradores con el log de frontera.
//   · use_cases.go — `UseCases` y `NewUseCases`, el ÚNICO sitio que cablea un handler por operación.
//   · use_cases_test.go — que cada operación queda cableada y que el decorador deja pasar el resultado y el
//     error tal cual, con el nivel de log que toca.

import { alignRows, goString } from '../lib/go-source.js';
import { frameworkSentinels, sentinelOf } from './errors.js';
import { IDEMPOTENCY_STORE, usesRegistry, usesRequestIdempotency } from './request-idempotency.js';
import { applicationPath, layout, packageFile } from './render.js';
import { usesCallerScope } from '@keel-system/keel-core/gen/features';
import { CALLER_SCOPE } from './caller-scope.js';
import { CALLER_ROLES, roleCheckedOperation, usesCallerIdentity, usesRoleCheck } from './security.js';
import { contractOf, entryGateGuard, handlerType, messageType, operations, useCaseField } from './services.js';
import { repositoryOf, repositoryRoots, usesPersistence } from '@keel-system/keel-core/gen/features';
import { goExported } from '../lib/go-projection.js';
import { credentialFinders, portName, repositoryParam } from './repositories.js';
import { isReplica, projectionDependencies } from './projections.js';
import { activationClients, clientField, clientParam, clientPort, needClients, usesGoHttpClients } from './http-clients.js';
import { orphanInternalOperations } from '@keel-system/keel-core/gen';
import { MAIL_SENDER, TEMPLATE_RENDERER, mailDependencies, usesGoMail, usesTemplating } from './mail.js';
import { parametersType, usesServiceParameters } from './service-parameters.js';
import { paymentDependencies, paymentDependencyRows, paymentUseCaseFields, paymentWiring } from './payments.js';
import { cacheDependencies, cacheDependencyRows, settlementWiring } from './cache.js';
import { storageDependencies, storageDependencyRows } from './storage.js';
import { responseNeedsStorage } from './mappers.js';
import { usesTelemetry } from '@keel-system/keel-core/gen/telemetry-vocabulary';

/** ¿Reciben los casos de uso adaptadores (Dependencies)? Con la persistencia relacional. */
export function usesDependencies(model) {
  return usesPersistence(model) && repositoryRoots(model).length > 0;
}

/**
 * Lo que recibe el constructor del handler de una operación, en orden: `name` y `type` del parámetro y del campo del
 * handler, `doc` para su comentario y `arg`, la expresión con que lo pasa `NewUseCases`. Es la fuente ÚNICA del handler
 * (services.js) y de su cableado: si dijeran cosas distintas, el proyecto no compilaría.
 *
 * En keel-spring, keel-nest y keel-dotnet el handler lo escribe el agente y la inyección de dependencias le da lo que
 * pida: añade un parámetro al constructor. En keel-go el cableado es de build (`NewUseCases` lleva la cabecera de
 * código generado), así que lo que no llegue aquí el agente no lo puede alcanzar. Por eso recibe los repositorios de
 * TODOS los agregados —una precondición sobre otro agregado («la aplicación está activa», «hay una plantilla
 * activa») está en prosa y build no la ve— y, si hay plantillas, el renderizador. Y si el diseño tiene operaciones
 * internas que nada dispara, los casos de uso para despacharlas: build sabe que alguien tiene que llamarlas, no
 * quién (lo dicen las reglas), como el CommandDispatcher de los otros tres. Corrida 12e, 2026-11-01.
 */
export function handlerDependencies(model, operation) {
  const deps = [];
  if (usesDependencies(model)) {
    const own = repositoryOf(model, operation);
    // Menos el de una réplica: la copia se lee por su lector y se escribe por su proyector, y sin el repositorio delante no
    // hay un camino más corto.
    const roots = repositoryRoots(model).filter((root) => root === own || !isReplica(model, root));
    for (const root of own ? [own, ...roots.filter((candidate) => candidate !== own)] : roots) {
      deps.push({
        name: repositoryParam(root),
        type: `domain.${portName(root)}`,
        doc:
          root === own
            ? `${repositoryParam(root)} es el repositorio del agregado ${root.name}.`
            : `${repositoryParam(root)} es el repositorio del agregado ${root.name}, para lo que esta operación consulte de él (una precondición sobre otro agregado).`,
        arg: `deps.${goExported(repositoryParam(root))}`
      });
    }
  }
  if (usesRegistry(model, operation)) {
    deps.push({ name: IDEMPOTENCY_STORE.param, type: IDEMPOTENCY_STORE.port, doc: `${IDEMPOTENCY_STORE.param} es el registro de idempotencia de la operación (idempotency del diseño).`, arg: `deps.${IDEMPOTENCY_STORE.field}` });
  }
  // A todas: un listado se acota por su regla, en prosa, sin declarar el error del alcance (filtra, no responde 403), y
  // NewUseCases es de build: sin el puerto delante, el agente no tiene cómo cumplirla (corrida asset-vault, 2026-11-02).
  if (usesDependencies(model) && usesCallerScope(model)) {
    deps.push({
      name: CALLER_SCOPE.param,
      type: CALLER_SCOPE.port,
      doc: `${CALLER_SCOPE.param} es el alcance por recurso del llamante (security.authentication.scoping). Si una regla acota esta operación: Covers para un recurso; en un listado, IsExempt y ScopedValues con un finder acotado que escribes tú.`,
      arg: `deps.${CALLER_SCOPE.field}`
    });
  }
  if (usesDependencies(model) && roleCheckedOperation(model, operation)) {
    deps.push({ name: CALLER_ROLES.param, type: CALLER_ROLES.port, doc: `${CALLER_ROLES.param} dice los roles del llamante: los exentos de la regla de propiedad (security.ownership).`, arg: `deps.${CALLER_ROLES.field}` });
  }
  // El trabajo que el diseño le atribuye a esta operación en otro servidor (dependencies.activations, por triggeredBy):
  // el puerto del cliente se inyecta, o el camino de menor resistencia es no llamarlo.
  // Y el dato que PIDE a otro servidor bajo demanda (dependencies.needs, por usedBy): sin el puerto delante, no lo pide.
  for (const client of new Set([...activationClients(model, operation), ...needClients(model, operation)])) {
    deps.push({ name: clientParam(client), type: `domain.${clientPort(client)}`, doc: `${clientParam(client)} es el cliente saliente ${client.id} (http-clients), con su resiliencia ya puesta.`, arg: `deps.${clientField(client)}` });
  }
  // La copia local de un dato de otro servidor: el lector a quien la lee y el proyector a quien la mantiene.
  if (usesDependencies(model)) deps.push(...projectionDependencies(model, operation));
  // La salida por correo (mail.sentBy es el único enlace del DSL entre un caso de uso y el correo): sin el puerto delante,
  // el camino de menor resistencia es no mandarlo, y no lo detecta nada. El renderizador, a cualquier operación: el
  // asunto interpolado que se congela al aceptar una petición también es una plantilla.
  const mail = mailDependencies(model, operation);
  if (usesTemplating(model) && !mail.includes(TEMPLATE_RENDERER)) mail.push(TEMPLATE_RENDERER);
  for (const port of mail) {
    deps.push({
      name: port.param,
      type: port.port,
      doc: `${port.param} es ${port === MAIL_SENDER ? 'la salida de correo (mail.sentBy): el adaptador SMTP ya escrito' : 'el renderizador de las plantillas del correo, ya escrito'}.`,
      arg: `deps.${port.field}`
    });
  }
  // La pasarela de pago (capa payments): el puerto y el aplicador de desenlaces a las acciones sobre un cobro, y la consulta
  // al barrido. Sin ellos delante, el camino de menor resistencia es escribir el cobro sin pasarela.
  deps.push(...paymentDependencies(model, operation));
  // La caché de lectura de la operación (use-cases.<op>.cache): la consulta la pone el agente, después de lo que dependa
  // de quién llama; sin la caché delante, el camino de menor resistencia es no consultarla.
  deps.push(...cacheDependencies(model, operation));
  // El almacenamiento de binarios (capa storage): la política y el puerto a la subida, y el puerto a la que devuelve la
  // URL de un bucket público (la compone su mapeo). Sin ellos delante, el camino de menor resistencia es guardar sin subir.
  if (usesDependencies(model)) deps.push(...storageDependencies(model, operation, { publicUrl: responseNeedsStorage(model, operation) }));
  if (handlersReadParameters(model)) {
    deps.push({
      name: SERVICE_PARAMETERS.param,
      type: `domain.${parametersType(model)}`,
      doc: `${SERVICE_PARAMETERS.param} son los parámetros de despliegue del servicio (service.parameters), ya validados al arrancar.`,
      arg: `deps.${SERVICE_PARAMETERS.field}`
    });
  }
  const orphans = orphanInternalOperations(model).filter((candidate) => candidate !== operation);
  if ((operation.dispatches ?? []).length > 0) {
    deps.push({ name: 'useCases', type: '*UseCases', doc: 'useCases despacha las operaciones que esta declara en use-cases.dispatches.', arg: 'uc' });
  } else if (orphans.length > 0) {
    deps.push({
      name: 'useCases',
      type: '*UseCases',
      doc:
        `useCases despacha las operaciones internas que nada dispara (${orphans.map((candidate) => candidate.name).join(', ')}), ` +
        'si las reglas de esta dicen que las invoca. Con WithoutTransaction(ctx) cuando la invocada hace E/S externa.',
      arg: 'uc'
    });
  }
  return deps;
}

/**
 * Los parámetros de despliegue (service.parameters) en los handlers: el campo de Dependencies y el parámetro del
 * handler. A TODOS, como los repositorios: qué regla lee un parámetro lo dice la prosa del diseño (la moneda de un cobro,
 * payments.charge.currency, es la referencia que sí lo dice), y build no la ve.
 */
export const SERVICE_PARAMETERS = { field: 'Parameters', param: 'parameters' };

/** ¿Reciben los handlers los parámetros de despliegue? Con parámetros y con los casos de uso cableados. */
export function handlersReadParameters(model) {
  return usesServiceParameters(model) && usesDependencies(model);
}

/** Los argumentos con que NewUseCases construye el handler de una operación. */
export function handlerArgs(model, operation) {
  return handlerDependencies(model, operation).map((dep) => dep.arg);
}

/**
 * La llamada a NewUseCases con un logger, con telemetría el `observer` (nil en las pruebas) y, si hacen falta, unas
 * Dependencies (`deps`, o vacías en las pruebas).
 */
export function newUseCasesCall(model, logger, deps = 'application.Dependencies{}', prefix = 'application.', observer = 'nil') {
  return `${prefix}NewUseCases(${logger}${usesTelemetry(model) ? `, ${observer}` : ''}${usesDependencies(model) ? `, ${deps}` : ''})`;
}

// Con telemetría: el puerto por el que la aplicación se observa (la aplicación no ve la plataforma) y sus dos decoradores,
// por FUERA del asentamiento: el span y la serie cuentan lo que vio quien llamó, lo que espera al commit incluido. El log
// de frontera queda dentro, así que sus líneas llevan los ids de la traza.
const OBSERVER_BODY = `
// Observer observa cada caso de uso: un span y su histograma con la operación y el desenlace. rejected dice qué error es un
// desenlace esperado (un rechazo del dominio, un 4xx) y no un fallo. Lo implementa la telemetría de la plataforma.
type Observer interface {
	ObserveUseCase(ctx context.Context, operation string, rejected func(error) bool, run func(ctx context.Context) error) error
}

// isRejection dice si un error es un rechazo del dominio.
func isRejection(err error) bool {
	var rejected *domain.Error
	return errors.As(err, &rejected)
}

// traced observa un caso de uso con resultado; sin observer, lo deja tal cual.
func traced[M, R any](observer Observer, operation string, next Handler[M, R]) Handler[M, R] {
	if observer == nil {
		return next
	}
	return HandlerFunc[M, R](func(ctx context.Context, msg M) (R, error) {
		var result R
		err := observer.ObserveUseCase(ctx, operation, isRejection, func(ctx context.Context) error {
			var err error
			result, err = next.Handle(ctx, msg)
			return err
		})
		return result, err
	})
}

// tracedCommand es traced para un comando sin resultado.
func tracedCommand[M any](observer Observer, operation string, next CommandHandler[M]) CommandHandler[M] {
	if observer == nil {
		return next
	}
	return CommandHandlerFunc[M](func(ctx context.Context, cmd M) error {
		return observer.ObserveUseCase(ctx, operation, isRejection, func(ctx context.Context) error {
			return next.Handle(ctx, cmd)
		})
	})
}
`;

export function generate(model) {
  const ops = operations(model);
  if (ops.length === 0) return [];
  const { application } = layout(model);
  // La prueba es INTERNA al paquete (no `application_test`): mide los decoradores, que no se exportan.
  const file = (name, body, imports = [], { test = false } = {}) => ({
    path: test ? applicationPath(model, name).replace(/\.go$/, '_test.go') : applicationPath(model, name),
    content: packageFile(model, application, { imports, body })
  });
  return [
    file('usecase', usesTelemetry(model) ? USECASE_BODY + OBSERVER_BODY : USECASE_BODY, ['context', 'errors', 'fmt', 'log/slog', 'time', 'internal/domain']),
    file('use_cases', useCasesBody(model, ops), ['context', 'fmt', 'log/slog', 'internal/domain']),
    file('use_cases', useCasesTest(model, ops), ['bytes', 'context', 'errors', 'log/slog', 'strings', 'testing', 'internal/domain'], { test: true })
  ];
}

const USECASE_BODY = `
// Handler es un caso de uso que devuelve un resultado: una consulta, o un comando que devuelve el recurso que
// crea o cambia. Uno por operación del diseño.
type Handler[M, R any] interface {
	Handle(ctx context.Context, msg M) (R, error)
}

// CommandHandler es un caso de uso que cambia estado y no devuelve nada.
type CommandHandler[M any] interface {
	Handle(ctx context.Context, cmd M) error
}

// HandlerFunc adapta una función a Handler, como http.HandlerFunc.
type HandlerFunc[M, R any] func(ctx context.Context, msg M) (R, error)

// Handle llama a f.
func (f HandlerFunc[M, R]) Handle(ctx context.Context, msg M) (R, error) {
	return f(ctx, msg)
}

// CommandHandlerFunc adapta una función a CommandHandler.
type CommandHandlerFunc[M any] func(ctx context.Context, cmd M) error

// Handle llama a f.
func (f CommandHandlerFunc[M]) Handle(ctx context.Context, cmd M) error {
	return f(ctx, cmd)
}

// MessageKind es la clase de mensaje que atiende un caso de uso. Con la persistencia decide la transacción: de
// lectura para una consulta, de escritura para un comando.
type MessageKind string

const (
	// KindCommand es un comando sin resultado.
	KindCommand MessageKind = "command"
	// KindReturningCommand es un comando que devuelve un resultado.
	KindReturningCommand MessageKind = "returningCommand"
	// KindQuery es una consulta: no cambia estado.
	KindQuery MessageKind = "query"
)

// ErrNotImplemented es lo que devuelve lo que build no sabe escribir y el agente tiene que completar: un caso de uso
// recién generado, o un campo que un mapeo no puede derivar. Compila y falla en ejecución nombrando qué falta, en
// vez de dejar pasar un valor inventado; la API lo responde como un 500.
var ErrNotImplemented = errors.New("sin implementar")

// Transactor abre la transacción de un caso de uso: de solo lectura para una consulta y de escritura para un comando.
// Lo implementa el adaptador de persistencia, y los repositorios se unen a la transacción que viaja en el contexto sin
// verla. Si fn devuelve un error, la transacción revierte.
type Transactor interface {
	Within(ctx context.Context, kind MessageKind, fn func(ctx context.Context) error) error
}

// noTransaction es el Transactor de un servicio sin persistencia: ejecuta el caso de uso tal cual.
type noTransaction struct{}

// Within llama a fn.
func (noTransaction) Within(ctx context.Context, _ MessageKind, fn func(ctx context.Context) error) error {
	return fn(ctx)
}

// withoutTransactionKey marca un contexto despachado sin transacción abarcadora.
type withoutTransactionKey struct{}

// WithoutTransaction devuelve ctx marcado para que el caso de uso que se despache con él NO se una a la transacción
// abierta ni abra una propia: cada escritura de sus repositorios confirma la suya. Es para despachar un caso de uso que
// hace E/S externa (un correo, una llamada a un proveedor) sin retener la transacción ni la conexión mientras espera.
func WithoutTransaction(ctx context.Context) context.Context {
	return context.WithValue(ctx, withoutTransactionKey{}, true)
}

// TransactionDetached dice si ctx viene de WithoutTransaction. Lo consulta el adaptador de persistencia.
func TransactionDetached(ctx context.Context) bool {
	detached, _ := ctx.Value(withoutTransactionKey{}).(bool)
	return detached
}

// observe envuelve un caso de uso con su TRANSACCIÓN y su LOG DE FRONTERA. Todas las operaciones pasan por aquí —las
// peticiones HTTP, los barridos programados y los mensajes consumidos—, así que es el único sitio que los pone:
// operación, resultado y duración. Solo nombres y códigos, nunca los valores del mensaje, que lleva datos de quien
// llama. El log va FUERA de la transacción: cuenta lo que vio el cliente, confirmación incluida.
func observe[M, R any](logger *slog.Logger, tx Transactor, operation string, kind MessageKind, next Handler[M, R]) Handler[M, R] {
	return HandlerFunc[M, R](func(ctx context.Context, msg M) (R, error) {
		started := time.Now()
		var result R
		err := tx.Within(ctx, kind, func(ctx context.Context) error {
			var err error
			result, err = next.Handle(ctx, msg)
			return err
		})
		logOutcome(ctx, logger, operation, kind, started, err)
		if err != nil {
			// Lo que el caso de uso devolvió antes de que la transacción fallara no se confirmó: no sale.
			var zero R
			return zero, err
		}
		return result, nil
	})
}

// observeCommand es observe para un comando sin resultado.
func observeCommand[M any](logger *slog.Logger, tx Transactor, operation string, next CommandHandler[M]) CommandHandler[M] {
	return CommandHandlerFunc[M](func(ctx context.Context, cmd M) error {
		started := time.Now()
		err := tx.Within(ctx, KindCommand, func(ctx context.Context) error {
			return next.Handle(ctx, cmd)
		})
		logOutcome(ctx, logger, operation, KindCommand, started, err)
		return err
	})
}

// logOutcome escribe el resultado de un caso de uso con niveles fijos: Debug si salió bien, Info si el dominio lo
// rechazó —un 4xx es un resultado esperado— y Error si falló. El error en sí lo registra el borde por el que
// entró (§ 3.2: se registra o se devuelve, no las dos cosas); aquí va solo su tipo.
func logOutcome(ctx context.Context, logger *slog.Logger, operation string, kind MessageKind, started time.Time, err error) {
	elapsed := slog.Int64("elapsedMs", time.Since(started).Milliseconds())
	attrs := []any{slog.String("operation", operation), slog.String("kind", string(kind)), elapsed}
	var rejected *domain.Error
	switch {
	case err == nil:
		logger.DebugContext(ctx, "caso de uso: ok", attrs...)
	case errors.As(err, &rejected):
		logger.InfoContext(ctx, "caso de uso: rechazado", append(attrs, slog.String("code", rejected.Code()))...)
	default:
		logger.ErrorContext(ctx, "caso de uso: falló", append(attrs, slog.String("errorType", errorType(err)))...)
	}
}

// errorType nombra el error más interno de la cadena: el envoltorio de fmt.Errorf no dice nada.
func errorType(err error) string {
	for {
		inner := errors.Unwrap(err)
		if inner == nil {
			return typeName(err)
		}
		err = inner
	}
}

func typeName(err error) string {
	if errors.Is(err, ErrNotImplemented) {
		return "ErrNotImplemented"
	}
	return fmt.Sprintf("%T", err)
}
`;

/** Con telemetría, el caso de uso dentro de su decorador de observación. */
function observedCall(model, decorator, name, call) {
  return usesTelemetry(model) ? `${decorator}(observer, ${name}, ${call})` : call;
}

function useCasesBody(model, ops) {
  const fieldRows = [];
  for (const operation of ops) {
    fieldRows.push({ text: `\t// ${useCaseField(operation)} es ${operation.name}.` });
    fieldRows.push({ indent: '\t', cells: [useCaseField(operation), contractOf(operation, model).handler] });
  }
  const roots = repositoryRoots(model);
  const persistent = usesDependencies(model);
  const resolution = persistent ? callerResolution(model) : null;
  fieldRows.push(...paymentUseCaseFields(model));
  if (resolution) {
    fieldRows.push({ text: `	// callers resuelve la credencial del llamante al ${resolution.entity.name} al que pertenece (resolvedBy).` });
    fieldRows.push({ indent: '	', cells: ['callers', `domain.${portName(resolution.entity)}`] });
  }
  const wiring = ops.map((operation) => {
    const contract = contractOf(operation, model);
    const handler = entryGateGuard(model, operation, `New${handlerType(operation)}(${handlerArgs(model, operation).join(', ')})`);
    const name = goString(messageType(operation));
    // Cada operación va además dentro de su asentamiento (settle): lo que espera al commit, los afterCommit de su handler y
    // el vaciado de las cachés que invalida (keel-core/gen/cache-plan.js) incluidos.
    return contract.kind === 'KindCommand'
      ? `\tuc.${useCaseField(operation)} = ${observedCall(model, 'tracedCommand', name, settlementWiring(model, operation, `observeCommand(logger, tx, ${name}, ${handler})`, { command: true }))}`
      : `\tuc.${useCaseField(operation)} = ${observedCall(model, 'traced', name, settlementWiring(model, operation, `observe(logger, tx, ${name}, ${contract.kind}, ${handler})`, { command: false }))}`;
  });
  const dependencies = persistent
    ? `
// Dependencies son los adaptadores que reciben los casos de uso: la transacción y el repositorio de cada agregado.
// Los construye el arranque (cmd/server) y solo él.
type Dependencies struct {
${alignRows([
  { text: '\t// Transactor abre la transacción de cada caso de uso; nil, ninguna (las pruebas sin base).' },
  { indent: '\t', cells: ['Transactor', 'Transactor'] },
  ...roots.flatMap((root) => [
    { text: `\t// ${goExported(repositoryParam(root))} es el repositorio del agregado ${root.name}.` },
    { indent: '\t', cells: [goExported(repositoryParam(root)), `domain.${portName(root)}`] }
  ]),
  ...(usesRequestIdempotency(model)
    ? [
        { text: '\t// IdempotencyStore es el registro de idempotencia de las operaciones que lo declaran.' },
        { indent: '\t', cells: [IDEMPOTENCY_STORE.field, IDEMPOTENCY_STORE.port] }
      ]
    : []),
  ...(usesCallerScope(model)
    ? [
        { text: `\t// ${CALLER_SCOPE.field} es el alcance por recurso del llamante de la petición en curso (security.authentication.scoping).` },
        { indent: '\t', cells: [CALLER_SCOPE.field, CALLER_SCOPE.port] }
      ]
    : []),
  ...(usesRoleCheck(model)
    ? [
        { text: `\t// ${CALLER_ROLES.field} dice los roles del llamante de la petición en curso (los exentos de security.ownership).` },
        { indent: '\t', cells: [CALLER_ROLES.field, CALLER_ROLES.port] }
      ]
    : []),
  ...(usesGoMail(model)
    ? [
        { text: '\t// MailSender es la salida de correo (mail.sentBy).' },
        { indent: '\t', cells: [MAIL_SENDER.field, MAIL_SENDER.port] },
        ...(usesTemplating(model) ? [{ text: '\t// TemplateRenderer interpola las plantillas del correo.' }, { indent: '\t', cells: [TEMPLATE_RENDERER.field, TEMPLATE_RENDERER.port] }] : [])
      ]
    : []),
  ...paymentDependencyRows(model),
  ...cacheDependencyRows(model),
  ...storageDependencyRows(model),
  ...(handlersReadParameters(model)
    ? [
        { text: '	// Parameters son los parámetros de despliegue del servicio (service.parameters), validados al arrancar.' },
        { indent: '	', cells: [SERVICE_PARAMETERS.field, `domain.${parametersType(model)}`] }
      ]
    : []),
  ...(usesGoHttpClients(model)
    ? model.httpClients.flatMap((client) => [
        { text: `\t// ${clientField(client)} es el cliente saliente ${client.id} (http-clients): su adaptador HTTP, con su resiliencia.` },
        { indent: '\t', cells: [clientField(client), `domain.${clientPort(client)}`] }
      ])
    : [])
]).join('\n')}
}
`
    : '';
  const prelude = persistent
    ? `	var tx Transactor = noTransaction{}
	if deps.Transactor != nil {
		tx = deps.Transactor
	}
`
    : '	tx := noTransaction{}\n';
  return `${dependencies}
// UseCases son los casos de uso del servicio, uno por operación del diseño, ya envueltos con su transacción y su log
// de frontera. Es la ÚNICA puerta de despacho: la API, los consumidores y el reloj llaman a un campo de aquí, nunca a
// un handler. Cada campo está tipado con su mensaje y su resultado, así que un mensaje no puede llegar a otro caso de
// uso: lo impide el compilador, no una tabla en tiempo de ejecución.
type UseCases struct {
${alignRows(fieldRows).join('\n')}
}

// NewUseCases cablea cada operación con su handler. Es el registro explícito de los casos de uso y lo genera
// build: lo que no está aquí no se despacha. Un handler que despacha otra operación (use-cases.dispatches)
// recibe el propio UseCases, ya completo cuando se le llama.
func NewUseCases(logger *slog.Logger${usesTelemetry(model) ? ', observer Observer' : ''}${persistent ? ', deps Dependencies' : ''}) *UseCases {
${prelude}	uc := &UseCases{${resolution ? `callers: deps.${goExported(repositoryParam(resolution.entity))}` : ''}}
${paymentWiring(model)}${wiring.join('\n')}
	return uc
}
${resolution ? resolveCallerMethod(resolution) : ''}`;
}

/**
 * Cuándo la identidad del llamante se RESUELVE al recurso y no se pasa en crudo: con `from.resolvedBy` el valor del token es
 * UNA de las credenciales del recurso, no su clave natural. La misma decisión que los otros tres: el lector del endpoint pasa
 * la clave natural (vacía si la credencial no es de nadie, y la operación responde con el error que el diseño declare), y lo
 * mismo hace el listener por el canal de eventos. Solo con una clave natural de UN campo: una compuesta no cabe en el campo
 * de identidad.
 */
export function callerResolution(model) {
  const resolvedBy = model.security?.callerIdentity?.resolvedBy;
  if (!resolvedBy || !usesCallerIdentity(model) || !usesDependencies(model)) return null;
  const entity = model.entities.find((candidate) => candidate.name === resolvedBy.entity);
  if (!entity || (entity.naturalKey ?? []).length !== 1) return null;
  const finder = credentialFinders(model, entity).find((candidate) => candidate.field.name === resolvedBy.field);
  if (!finder) return null;
  return { entity, field: resolvedBy.field, keyField: entity.naturalKey[0], finder: finder.name };
}

function resolveCallerMethod(resolution) {
  const key = goExported(resolution.keyField);
  const keyField = resolution.entity.fields.find((field) => field.name === resolution.keyField);
  const value = keyField?.goType === 'string' ? `found.${key}()` : `fmt.Sprint(found.${key}())`;
  return `
// ResolveCaller es la identidad del llamante resuelta al ${resolution.entity.name} al que pertenece su credencial: el diseño
// declara que un mismo ${resolution.entity.name} tiene varias (resolvedBy: ${resolution.entity.name}.${resolution.field}), así que el valor
// del token no es su clave natural. Se busca con ${resolution.finder} y se devuelve la clave natural (${resolution.keyField}), que es lo
// que el campo de identidad significa en el diseño. Vacía si la credencial no es de ninguno: que el recurso no exista es una
// precondición de la operación, y es ella la que responde con el error que el diseño declare, con su precedencia.
func (uc *UseCases) ResolveCaller(ctx context.Context, credential string) (string, error) {
	if credential == "" {
		return "", nil
	}
	found, ok, err := uc.callers.${resolution.finder}(ctx, credential)
	if err != nil || !ok {
		return "", err
	}
	return ${value}, nil
}
`;
}

/** Un error de dominio con el que probar el rechazo, o null si el diseño no tiene ninguno. */
function sampleSentinel(model) {
  const framework = frameworkSentinels(model)[0];
  if (framework) return framework.name;
  const declared = (model.errors ?? []).find((error) => !error.dynamicStatus);
  return declared ? sentinelOf(declared.code) : null;
}

function useCasesTest(model, ops) {
  const rows = ops.map((operation) => `\t\t{${goString(operation.name)}, uc.${useCaseField(operation)} != nil},`);
  const sentinel = sampleSentinel(model);
  const rejected = sentinel
    ? `

func TestObserveRegistraElRechazoDelDominioConSuCode(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	refused := domain.Errorf(domain.${sentinel}, "rechazado")
	handler := observeCommand(logger, noTransaction{}, "Refuse", CommandHandlerFunc[string](func(context.Context, string) error {
		return refused
	}))
	if err := handler.Handle(t.Context(), "dato-sensible"); !errors.Is(err, domain.${sentinel}) {
		t.Fatalf("el decorador cambió el error del dominio: %v", err)
	}
	line := logs.String()
	if !strings.Contains(line, \`"level":"INFO"\`) || !strings.Contains(line, \`"msg":"caso de uso: rechazado"\`) {
		t.Fatalf("un rechazo del dominio se registra en Info: %s", line)
	}
	if strings.Contains(line, "dato-sensible") {
		t.Fatalf("el log de frontera escribió el valor del mensaje: %s", line)
	}
}`
    : '';
  return `
// La prueba del cableado: cada operación del diseño tiene su caso de uso en UseCases, y el decorador del log de
// frontera deja pasar el resultado y el error tal cual. Se escribe para que siga valiendo cuando el agente
// implemente los handlers: no afirma que fallen, sino que existen y que el decorador no se interpone.

func TestNewUseCasesCableaCadaOperacion(t *testing.T) {
	uc := ${newUseCasesCall(model, 'slog.New(slog.DiscardHandler)', 'Dependencies{}', '')}
	for _, tc := range []struct {
		operation string
		wired     bool
	}{
${rows.join('\n')}
	} {
		if !tc.wired {
			t.Errorf("%s: sin caso de uso en UseCases", tc.operation)
		}
	}
}

func TestObserveDejaPasarResultadoYError(t *testing.T) {
	logger := slog.New(slog.DiscardHandler)
	ping := observe(logger, noTransaction{}, "Ping", KindQuery, HandlerFunc[string, string](func(_ context.Context, text string) (string, error) {
		return text + "-pong", nil
	}))
	got, err := ping.Handle(t.Context(), "x")
	if err != nil || got != "x-pong" {
		t.Fatalf("Ping = %q, %v; quería x-pong", got, err)
	}
	broken := errors.New("roto")
	fail := observeCommand(logger, noTransaction{}, "Fail", CommandHandlerFunc[int](func(context.Context, int) error {
		return broken
	}))
	if err := fail.Handle(t.Context(), 1); !errors.Is(err, broken) {
		t.Fatalf("el decorador cambió el error: %v", err)
	}
}${rejected}
`;
}
