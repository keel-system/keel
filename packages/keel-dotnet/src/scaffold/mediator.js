// El patrón mediator de keel-spring y keel-nest, en C# y sin MediatR (licencia comercial desde la 13).
//
//   · Application/Abstractions — ICommand, IQuery<TResult>, IReturningCommand<TResult>, sus handlers e
//     IUseCaseMediator. C# conserva los genéricos al compilar, así que el tipo del mensaje ya dice qué devuelve
//     y qué handler lo atiende: no hace falta el @Handles de keel-nest ni el registro por reflexión de
//     keel-spring.
//   · Application/Ports — ICommandDispatcher, el puerto con el que un handler despacha OTRO caso de uso.
//   · Infrastructure/UseCase — UseCaseMediator (la fachada de despacho y el log de frontera de cada caso de
//     uso), el adaptador del dispatcher y UseCaseRegistration, el ÚNICO sitio que registra handlers y mappers
//     en el contenedor de dependencias. Es código generado y explícito: lo que no está ahí no se despacha, y
//     el contenedor lo dice al arrancar (ValidateOnBuild), no en la primera petición.
//
// La frontera transaccional la pone el mediator a través de IUseCaseTransactions: las Query en solo lectura, los
// Command en escritura, y `DispatchWithoutTransaction` sin abarcar nada. Sin persistencia la implementación es un
// paso directo; con ella (incremento 6), la de EF Core (PersistenceTransactions), que también traduce los fallos del
// motor al contrato.

import { orphanInternalOperations, dispatchingOperations, usesCommandDispatcher } from 'keel-core/gen';
import { csFile, located, namespaceOf, solution, typeUsings } from './render.js';
import { usesRelational } from './persistence.js';
import { mapperClasses } from './mappers.js';
import { contractOf, messageNamespace } from './services.js';
import { securityNamespace, usesCallerScope } from './security.js';

/** ¿Hay casos de uso que despachar? Sin operaciones no se genera nada de esto. */
export function usesMediator(model) {
  return (model.services ?? []).some((service) => (service.operations ?? []).length > 0);
}

export function generate(model) {
  if (!usesMediator(model)) return [];
  const abstractions = (name, body) => {
    const { namespace, path } = located(model, 'abstractions', name);
    return { path, content: csFile({ namespace, body }) };
  };
  const infra = (name, body, usings) => {
    const { namespace, path } = located(model, 'useCaseInfra', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const files = [
    abstractions('Messages', messagesBody()),
    abstractions('Handlers', handlersBody()),
    abstractions('IUseCaseMediator', mediatorPortBody()),
    infra('IUseCaseTransactions', transactionsPortBody(), []),
    infra('UseCaseMediator', mediatorBody(), [
      'System.Collections.Concurrent',
      'System.Diagnostics',
      'Microsoft.Extensions.DependencyInjection',
      'Microsoft.Extensions.Logging',
      namespaceOf(model, 'abstractions'),
      namespaceOf(model, 'errors')
    ]),
    infra('UseCaseRegistration', registrationBody(model), registrationUsings(model))
  ];
  files.push(useCasesTest(model));
  if (usesCommandDispatcher(model)) {
    const { namespace, path } = located(model, 'ports', 'ICommandDispatcher');
    files.push({ path, content: csFile({ namespace, usings: [namespaceOf(model, 'abstractions')], body: dispatcherPortBody(model) }) });
    files.push(infra('CommandDispatcherAdapter', dispatcherAdapterBody(), [namespaceOf(model, 'abstractions'), namespaceOf(model, 'ports')]));
  }
  return files;
}

function messagesBody() {
  return `/// <summary>Un mensaje que despacha el mediator: un comando o una consulta.</summary>
public interface IMessage;

/// <summary>Un comando que cambia estado y no devuelve nada.</summary>
public interface ICommand : IMessage;

/// <summary>Un comando que cambia estado y devuelve <typeparamref name="TResult"/> (el recurso creado, por ejemplo).</summary>
public interface IReturningCommand<TResult> : IMessage;

/// <summary>Una consulta: no cambia estado y devuelve <typeparamref name="TResult"/>.</summary>
public interface IQuery<TResult> : IMessage;`;
}

function handlersBody() {
  return `/// <summary>El caso de uso de un comando sin resultado. Uno por comando, y solo uno.</summary>
public interface ICommandHandler<in TCommand>
    where TCommand : ICommand
{
    Task Handle(TCommand command, CancellationToken cancellationToken);
}

/// <summary>El caso de uso de un comando con resultado.</summary>
public interface IReturningCommandHandler<in TCommand, TResult>
    where TCommand : IReturningCommand<TResult>
{
    Task<TResult> Handle(TCommand command, CancellationToken cancellationToken);
}

/// <summary>El caso de uso de una consulta.</summary>
public interface IQueryHandler<in TQuery, TResult>
    where TQuery : IQuery<TResult>
{
    Task<TResult> Handle(TQuery query, CancellationToken cancellationToken);
}`;
}

function mediatorPortBody() {
  return `/// <summary>
/// Fachada única de despacho de casos de uso. Los controladores, los listeners y el reloj dependen solo de
/// ella, nunca de un handler.
/// </summary>
public interface IUseCaseMediator
{
    Task Dispatch(ICommand command, CancellationToken cancellationToken = default);

    Task<TResult> Dispatch<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default);

    Task<TResult> Dispatch<TResult>(IQuery<TResult> query, CancellationToken cancellationToken = default);

    /// <summary>
    /// Despacha SIN transacción abarcadora: las abre el adaptador de repositorio en cada llamada, así que
    /// quien despacha controla dónde cae cada commit. Es para los barridos que llaman a un proveedor EN MEDIO
    /// de su trabajo. Sin persistencia es el mismo despacho que <see cref="Dispatch(ICommand, CancellationToken)"/>.
    /// </summary>
    Task DispatchWithoutTransaction(ICommand command, CancellationToken cancellationToken = default);

    Task<TResult> DispatchWithoutTransaction<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default);
}`;
}

function transactionsPortBody() {
  return `/// <summary>
/// La frontera transaccional de un caso de uso: el mediator envuelve en ella cada despacho, en solo lectura las
/// consultas. Una transacción ya abierta se REUTILIZA (un caso de uso que despacha otro con Dispatch se une a la
/// del llamante).
/// </summary>
public interface IUseCaseTransactions
{
    Task<T> Run<T>(Func<Task<T>> work, bool readOnly, CancellationToken cancellationToken);
}

/// <summary>Sin persistencia no hay transacción que abrir: el trabajo se ejecuta tal cual.</summary>
public sealed class PassThroughUseCaseTransactions : IUseCaseTransactions
{
    public Task<T> Run<T>(Func<Task<T>> work, bool readOnly, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(work);
        return work();
    }
}`;
}

function mediatorBody() {
  return `/// <summary>
/// Fachada única de despacho de casos de uso: resuelve el handler del mensaje en el contenedor y lo invoca.
/// </summary>
/// <remarks>
/// Es también el único punto por el que pasan TODAS las operaciones —las peticiones HTTP, los barridos
/// programados y los mensajes consumidos—, y por eso es aquí donde vive el LOG DE FRONTERA de cada caso de
/// uso: operación, resultado y duración. Solo nombres y códigos, nunca los valores del mensaje: un comando
/// lleva datos de quien llama. Niveles fijos: Debug si salió bien, Information si el dominio lo rechazó —un
/// 4xx es un resultado esperado— y Error si falló. La pila de un fallo NO va aquí: la imprime el adaptador
/// por el que entró, y con las dos cada fallo saldría duplicado.
/// </remarks>
public sealed partial class UseCaseMediator(IServiceProvider services, IUseCaseTransactions transactions, ILogger<UseCaseMediator> logger) : IUseCaseMediator
{
    // Un envoltorio por tipo de mensaje, construido una vez: cierra los genéricos del handler a partir del tipo
    // concreto del mensaje, que el método solo conoce como su interfaz.
    private static readonly ConcurrentDictionary<Type, object> Wrappers = new();

    public Task Dispatch(ICommand command, CancellationToken cancellationToken = default) =>
        Run(command, () => transactions.Run(() => Handled(command, cancellationToken), readOnly: false, cancellationToken));

    public Task<TResult> Dispatch<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default) =>
        Run(command, () => transactions.Run(() => Handled(command, cancellationToken), readOnly: false, cancellationToken));

    public Task<TResult> Dispatch<TResult>(IQuery<TResult> query, CancellationToken cancellationToken = default) =>
        Run(query, () => transactions.Run(() => Wrapper<ResultWrapper<TResult>>(typeof(QueryWrapper<,>), query, typeof(TResult)).Handle(query, services, cancellationToken), readOnly: true, cancellationToken));

    public Task DispatchWithoutTransaction(ICommand command, CancellationToken cancellationToken = default) =>
        Run(command, () => Handled(command, cancellationToken));

    public Task<TResult> DispatchWithoutTransaction<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default) =>
        Run(command, () => Handled(command, cancellationToken));

    private async Task<bool> Handled(ICommand command, CancellationToken cancellationToken)
    {
        await Wrapper<CommandWrapper>(typeof(CommandWrapper<>), command).Handle(command, services, cancellationToken);
        return true;
    }

    private Task<TResult> Handled<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken) =>
        Wrapper<ResultWrapper<TResult>>(typeof(ReturningCommandWrapper<,>), command, typeof(TResult)).Handle(command, services, cancellationToken);

    private static T Wrapper<T>(Type open, IMessage message, Type? result = null)
    {
        ArgumentNullException.ThrowIfNull(message);
        var type = message.GetType();
        return (T)Wrappers.GetOrAdd(type, _ => Activator.CreateInstance(open.MakeGenericType(result is null ? [type] : [type, result]))!);
    }

    private async Task Run(IMessage message, Func<Task> work) =>
        await Run(message, async () =>
        {
            await work();
            return true;
        });

    private async Task<T> Run<T>(IMessage message, Func<Task<T>> work)
    {
        var operation = message.GetType().Name;
        var started = Stopwatch.GetTimestamp();
        try
        {
            var result = await work();
            LogOk(operation, Elapsed(started));
            return result;
        }
        catch (DomainException error)
        {
            LogRejected(operation, error.Code ?? error.GetType().Name, Elapsed(started));
            throw;
        }
        catch (Exception error)
        {
            LogFailed(operation, error.GetType().Name, Elapsed(started));
            throw;
        }
    }

    private static long Elapsed(long started) => (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds;

    [LoggerMessage(Level = LogLevel.Debug, Message = "Caso de uso {Operation}: ok ({Elapsed} ms)")]
    private partial void LogOk(string operation, long elapsed);

    [LoggerMessage(Level = LogLevel.Information, Message = "Caso de uso {Operation}: rechazado ({Code}, {Elapsed} ms)")]
    private partial void LogRejected(string operation, string code, long elapsed);

    [LoggerMessage(Level = LogLevel.Error, Message = "Caso de uso {Operation}: falló con {Type} ({Elapsed} ms)")]
    private partial void LogFailed(string operation, string type, long elapsed);

    private abstract class CommandWrapper
    {
        public abstract Task Handle(IMessage command, IServiceProvider services, CancellationToken cancellationToken);
    }

    private abstract class ResultWrapper<TResult>
    {
        public abstract Task<TResult> Handle(IMessage message, IServiceProvider services, CancellationToken cancellationToken);
    }

    private sealed class CommandWrapper<TCommand> : CommandWrapper
        where TCommand : ICommand
    {
        public override Task Handle(IMessage command, IServiceProvider services, CancellationToken cancellationToken) =>
            services.GetRequiredService<ICommandHandler<TCommand>>().Handle((TCommand)command, cancellationToken);
    }

    private sealed class ReturningCommandWrapper<TCommand, TResult> : ResultWrapper<TResult>
        where TCommand : IReturningCommand<TResult>
    {
        public override Task<TResult> Handle(IMessage message, IServiceProvider services, CancellationToken cancellationToken) =>
            services.GetRequiredService<IReturningCommandHandler<TCommand, TResult>>().Handle((TCommand)message, cancellationToken);
    }

    private sealed class QueryWrapper<TQuery, TResult> : ResultWrapper<TResult>
        where TQuery : IQuery<TResult>
    {
        public override Task<TResult> Handle(IMessage message, IServiceProvider services, CancellationToken cancellationToken) =>
            services.GetRequiredService<IQueryHandler<TQuery, TResult>>().Handle((TQuery)message, cancellationToken);
    }
}`;
}

/** Las operaciones del diseño, cada una con su contrato C#. */
function operations(model) {
  return (model.services ?? []).flatMap((service) => service.operations ?? []);
}

function registrationUsings(model) {
  const usings = ['Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.DependencyInjection.Extensions', namespaceOf(model, 'abstractions'), namespaceOf(model, 'useCases')];
  if (mapperClasses(model).length > 0) usings.push(namespaceOf(model, 'mappers'));
  if (usesCommandDispatcher(model)) usings.push(namespaceOf(model, 'ports'));
  for (const operation of operations(model)) {
    usings.push(messageNamespace(model, operation));
    if (operation.responseDto) usings.push(...typeUsings(model, [operation.responseDto.name, 'PagedResponse']));
  }
  return usings;
}

function registrationBody(model) {
  // La transacción: un paso directo salvo que la persistencia ponga la suya (AddPersistence la reemplaza).
  const lines = ['services.TryAddScoped<IUseCaseTransactions, PassThroughUseCaseTransactions>();', 'services.AddScoped<IUseCaseMediator, UseCaseMediator>();'];
  if (usesCommandDispatcher(model)) lines.push('services.AddScoped<ICommandDispatcher, CommandDispatcherAdapter>();');
  for (const mapper of mapperClasses(model)) lines.push(`services.AddScoped<${mapper}>();`);
  for (const operation of operations(model)) lines.push(`services.AddScoped<${contractOf(operation).handler}, ${operation.handlerClass}>();`);
  return `/// <summary>
/// El ÚNICO sitio que registra los casos de uso en el contenedor: el mediator, los mappers y un handler por
/// operación del diseño, con el contrato que lo ata a SU mensaje. Lo genera build; si una operación no está
/// aquí, no se despacha.
/// </summary>
public static class UseCaseRegistration
{
    public static IServiceCollection AddUseCases(this IServiceCollection services)
    {
${lines.map((line) => `        ${line}`).join('\n')}
        return services;
    }
}`;
}

/**
 * La prueba del cableado: cada mensaje del diseño llega a SU handler por el contenedor real, que se construye
 * entero (ValidateOnBuild: una dependencia sin registrar sale aquí, no en la primera petición), y el mediator
 * despacha las tres clases de mensaje. Se escribe para que siga valiendo cuando el agente implemente los
 * handlers: no afirma que fallen con su TODO, sino que el mediator los encuentra.
 */
function useCasesTest(model) {
  const sln = solution(model);
  const rows = operations(model).map((operation) => `    [InlineData(typeof(${contractOf(operation).handler}), typeof(${operation.handlerClass}))]`);
  const persistence = usesRelational(model);
  const usings = [
    ...registrationUsings(model),
    'Microsoft.Extensions.DependencyInjection',
    'Xunit',
    namespaceOf(model, 'useCaseInfra'),
    namespaceOf(model, 'errors'),
    ...(persistence ? [namespaceOf(model, 'persistence')] : [])
  ];
  // Con persistencia, los handlers reciben su repositorio: el contenedor la registra SIN base (el perfil test), que
  // se construye entera y solo falla si algo intenta conectar.
  const persistenceLine = persistence ? '\n        services.AddPersistence(DatabaseSettings.Disabled);' : '';
  // Con alcance por recurso, los handlers que declaran su error lo reciben: el registro real, sin la entrada HTTP.
  const scope = usesCallerScope(model);
  if (scope) usings.push(securityNamespace(model));
  const scopeLine = scope ? '\n        services.AddCallerScope();' : '';
  const passThrough = persistence
    ? `
            // Sin base: la transacción de este despacho es el paso directo, no la de EF.
            services.Replace(ServiceDescriptor.Scoped<IUseCaseTransactions, PassThroughUseCaseTransactions>());`
    : '';
  const body = `public sealed class UseCasesTests
{
    private static ServiceProvider Provider(Action<IServiceCollection>? extra = null)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddUseCases();${persistenceLine}${scopeLine}
        extra?.Invoke(services);
        return services.BuildServiceProvider(new ServiceProviderOptions { ValidateOnBuild = true, ValidateScopes = true });
    }

    [Fact]
    public void ElContenedorConstruyeTodosLosCasosDeUso()
    {
        using var provider = Provider();
        using var scope = provider.CreateScope();
        Assert.NotNull(scope.ServiceProvider.GetRequiredService<IUseCaseMediator>());
    }

    [Theory]
${rows.join('\n')}
    public void CadaMensajeLlegaASuHandler(Type contract, Type handler)
    {
        using var provider = Provider();
        using var scope = provider.CreateScope();
        Assert.IsType(handler, scope.ServiceProvider.GetRequiredService(contract));
    }

    public sealed class Ping : IQuery<string>
    {
        public required string Text { get; init; }
    }

    public sealed class PingHandler : IQueryHandler<Ping, string>
    {
        public Task<string> Handle(Ping query, CancellationToken cancellationToken) => Task.FromResult($"{query.Text}-pong");
    }

    public sealed class Create : IReturningCommand<int>;

    public sealed class CreateHandler : IReturningCommandHandler<Create, int>
    {
        public Task<int> Handle(Create command, CancellationToken cancellationToken) => Task.FromResult(42);
    }

    public sealed class Touch : ICommand;

    public sealed class TouchHandler : ICommandHandler<Touch>
    {
        public int Count { get; private set; }

        public Task Handle(Touch command, CancellationToken cancellationToken)
        {
            Count++;
            return Task.CompletedTask;
        }
    }

    public sealed class Refuse : ICommand;

    public sealed class RefuseHandler : ICommandHandler<Refuse>
    {
        public Task Handle(Refuse command, CancellationToken cancellationToken) => throw new ConflictException("ya existe", code: "ALREADY_EXISTS");
    }

    [Fact]
    public async Task ElMediatorDespachaLasTresClasesDeMensajeYDejaPasarElRechazoDelDominio()
    {
        var touch = new TouchHandler();
        using var provider = Provider(services =>
        {
            services.AddScoped<IQueryHandler<Ping, string>, PingHandler>();
            services.AddScoped<IReturningCommandHandler<Create, int>, CreateHandler>();
            services.AddSingleton<ICommandHandler<Touch>>(touch);
            services.AddScoped<ICommandHandler<Refuse>, RefuseHandler>();${passThrough}
        });
        using var scope = provider.CreateScope();
        var mediator = scope.ServiceProvider.GetRequiredService<IUseCaseMediator>();
        var cancellation = TestContext.Current.CancellationToken;
        Assert.Equal("x-pong", await mediator.Dispatch(new Ping { Text = "x" }, cancellation));
        Assert.Equal(42, await mediator.Dispatch(new Create(), cancellation));
        await mediator.Dispatch(new Touch(), cancellation);
        await mediator.DispatchWithoutTransaction(new Touch(), cancellation);
        Assert.Equal(2, touch.Count);
        var error = await Assert.ThrowsAsync<ConflictException>(() => mediator.Dispatch(new Refuse(), cancellation));
        Assert.Equal("ALREADY_EXISTS", error.Code);
    }
}`;
  return { path: `${sln.unitTests.dir}/UseCasesTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) };
}

function dispatcherPortBody(model) {
  const orphans = orphanInternalOperations(model);
  const dispatching = dispatchingOperations(model);
  const reasons = [
    orphans.length > 0
      ? `el diseño declara ${orphans.length === 1 ? 'una operación interna' : 'operaciones internas'} sin disparador propio (${orphans.map((o) => o.name).join(', ')}): solo otro caso de uso puede ejecutarla${orphans.length === 1 ? '' : 's'}`
      : null,
    dispatching.length > 0
      ? `el diseño declara despachos entre casos de uso (use-cases.dispatches: ${dispatching.map((o) => `${o.name} → ${o.dispatches.join(', ')}`).join('; ')})`
      : null,
    orphans.length === 0 && dispatching.length === 0 ? 'la capa payments despacha la operación que aplica cada desenlace' : null
  ]
    .filter(Boolean)
    .join(', y porque ');
  const irreversible = orphans.filter((operation) => operation.guardClaim);
  const irreversibleNote = irreversible.length
    ? `
/// <para>
/// Aquí ${irreversible.length === 1 ? 'la hay' : 'las hay'}: ${irreversible.map((o) => o.name).join(', ')} produce${irreversible.length === 1 ? '' : 'n'} un efecto que no se deshace. Su guarda
/// contra la repetición es un reclamo con transacción propia (${irreversible.map((o) => `${o.guardClaim.method}()`).join(', ')}), así que está a
/// salvo con cualquiera de las dos variantes — pero el argumento del pool sigue en pie.
/// </para>`
    : '';
  return `/// <summary>
/// Puerto de despacho de OTRO caso de uso desde un handler. Un handler nunca invoca a otro handler
/// directamente: despacha su mensaje por este puerto, que implementa un adaptador de infraestructura sobre el
/// mediator.
/// </summary>
/// <remarks>
/// <para>Existe porque ${reasons}.</para>
/// <para>
/// Las dos variantes no son intercambiables. <c>Dispatch</c>: la operación invocada se une a la transacción del
/// llamante; es lo correcto cuando todo el trabajo es de base de datos y tiene que ser atómico con el del
/// llamante. <c>DispatchWithoutTransaction</c>: la operación invocada abre sus propias transacciones; es lo
/// correcto cuando hace I/O externo (un correo, una llamada a un proveedor): bajo la transacción del llamante,
/// una tanda de N elementos retiene una conexión durante N latencias de un tercero.
/// </para>${irreversibleNote}
/// </remarks>
public interface ICommandDispatcher
{
    Task Dispatch(ICommand command, CancellationToken cancellationToken = default);

    Task<TResult> Dispatch<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default);

    Task DispatchWithoutTransaction(ICommand command, CancellationToken cancellationToken = default);

    Task<TResult> DispatchWithoutTransaction<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default);
}`;
}

function dispatcherAdapterBody() {
  return `/// <summary>
/// El puerto ICommandDispatcher sobre el mediator. Vive en infraestructura porque es aquí donde se conoce el
/// mediator; la capa de aplicación solo ve el puerto. No hay ciclo en el contenedor: el mediator resuelve los
/// handlers al despachar, no al construirse.
/// </summary>
public sealed class CommandDispatcherAdapter(IUseCaseMediator mediator) : ICommandDispatcher
{
    public Task Dispatch(ICommand command, CancellationToken cancellationToken = default) => mediator.Dispatch(command, cancellationToken);

    public Task<TResult> Dispatch<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default) =>
        mediator.Dispatch(command, cancellationToken);

    public Task DispatchWithoutTransaction(ICommand command, CancellationToken cancellationToken = default) =>
        mediator.DispatchWithoutTransaction(command, cancellationToken);

    public Task<TResult> DispatchWithoutTransaction<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default) =>
        mediator.DispatchWithoutTransaction(command, cancellationToken);
}`;
}
