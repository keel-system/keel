// La identidad opcional (DSL 2.27, `level: optional`) en la prueba emitida `OptionalAuthTests`: OA-1 a OA-3 de
// keel-core/gen/read-scope.js contra el servidor en memoria (el mismo Program.cs, con su HttpSecurityMiddleware), con el
// mediator sustituido por un doble que registra lo que el endpoint despacha. La regla (`PermitAll`), el estampado
// (`CallerIdentity.ResolveOptional()`) y la nota del handler los escriben security.js, endpoints.js y services.js.
//
// La misma pieza que mide keel-spring con read-scope-check (MockMvc con su SecurityConfig) y keel-nest ejecutando su hook
// sobre Fastify; aquí la ejecuta cs-check, y los sabotajes oa-* de cs-check la falsan.

import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { FRAMEWORK_RESPONSES as FW } from '@keel-system/keel-core/gen/api-errors';
import { tokenContract } from '@keel-system/keel-core/gen/identity-providers';
import { csFile, csMember, csString, namespaceOf, solution } from './render.js';
import { messageComponents, messageNamespace } from './services.js';
import { usesTestCredential } from './test-credential.js';

const SUBJECT = 'oa-user';

/** Las operaciones con `level: optional` que reciben la identidad del llamante por HTTP: las que pide la prueba. */
export function optionalAuthOperations(model) {
  return (model.services ?? [])
    .flatMap((group) => group.operations)
    .filter((operation) => operation.optionalAuth && operation.route && messageComponents(operation, model).some((component) => component.resolvedIdentity));
}

export function generate(model) {
  const operations = optionalAuthOperations(model);
  if (operations.length === 0 || !usesTestCredential(model)) return [];
  const identity = model.security.callerIdentity;
  const claim = identity.source === 'claim' ? identity.claim : 'azp';
  // Con un proveedor que distingue el tipo de token (Cognito, `token_use`), un token sin ese claim es 401 y OA-2 no medía nada.
  const { accepted } = tokenContract(model.stack?.auth);
  const claims = JSON.stringify({ sub: SUBJECT, [claim]: SUBJECT, ...(accepted ? { [accepted.claim]: accepted.value } : {}) });
  const field = csMember(identity.field);
  const unauthenticated = FW.unauthenticated;
  const tests = operations.map((operation) => {
    const url = `${model.api.routeBase}${operation.route.path}`.replace(/\{[^}]+\}/g, 'oa1');
    const name = csMember(operation.name);
    const status = operation.route.status;
    const send = (token) => `await Send(${csString(operation.route.method)}, ${csString(url)}, ${token})`;
    return `    [Fact]
    public async Task OA1_${name}_SinTokenEntraAnonima()
    {
        using var response = ${send('null')};
        Assert.Equal(${status}, (int)response.StatusCode);
        Assert.Null(Sent<${operation.messageClass}>().${field});
    }

    [Fact]
    public async Task OA2_${name}_ConUnTokenValidoLlegaLaIdentidad()
    {
        using var response = ${send('TestCredential.TokenWith(Claims)')};
        Assert.Equal(${status}, (int)response.StatusCode);
        Assert.Equal(Subject, Sent<${operation.messageClass}>().${field});
    }

    [Fact]
    public async Task OA3_${name}_ConUnTokenInvalidoOCaducadoEs401()
    {
        foreach (var token in new[] { "no.es-un.token", TestCredential.TokenWith(Claims, DateTimeOffset.UtcNow.AddMinutes(-5)), TestCredential.ForgedWith(Claims) })
        {
            using var response = ${send('token')};
            Assert.Equal(${unauthenticated.status}, (int)response.StatusCode);
            using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
            Assert.Equal(${unauthenticated.status}, body.RootElement.GetProperty("status").GetInt32());
            Assert.Equal(${csString(unauthenticated.error)}, body.RootElement.GetProperty("error").GetString());
            Assert.Equal(${csString(FRAMEWORK_ERRORS.unauthenticated.code)}, body.RootElement.GetProperty("code").GetString());
            Assert.Equal(${csString(unauthenticated.message)}, body.RootElement.GetProperty("message").GetString());
        }
        // Rechazado en el borde: el caso de uso no se despacha, ni como anónimo.
        Assert.Empty(mediator.Sent);
    }`;
  });
  const sln = solution(model);
  const body = `/// <summary>
/// La identidad opcional (DSL 2.27, level: optional) en el borde: OA-1 a OA-3 de keel-core/gen/read-scope.js, los mismos
/// que ejecutan los otros generadores. El servidor en memoria con su middleware de seguridad y el mediator sustituido por
/// un doble que registra el mensaje: lo que se mide es lo que responde el servidor y lo que llega al caso de uso.
/// </summary>
public sealed class OptionalAuthTests : IClassFixture<InMemoryServer>, IDisposable
{
    private const string Subject = ${csString(SUBJECT)};
    private const string Claims = ${csString(claims)};

    private readonly RecordingMediator mediator = new();
    private readonly WebApplicationFactory<Program> app;

    public OptionalAuthTests(InMemoryServer server)
    {
        app = server.WithWebHostBuilder(builder => builder.ConfigureTestServices(services => services.AddSingleton<IUseCaseMediator>(mediator)));
    }

    public void Dispose() => app.Dispose();

${tests.join('\n\n')}

    private async Task<HttpResponseMessage> Send(string method, string url, string? token)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), new Uri(url, UriKind.Relative));
        if (token is not null)
        {
            request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
        }
        using var client = app.CreateClient();
        return await client.SendAsync(request, TestContext.Current.CancellationToken);
    }

    /// <summary>El único mensaje que el endpoint despachó.</summary>
    private TMessage Sent<TMessage>() => Assert.IsType<TMessage>(Assert.Single(mediator.Sent));

    /// <summary>Registra lo que se despacha y devuelve el valor por defecto: lo que hace el handler no es de esta prueba.</summary>
    private sealed class RecordingMediator : IUseCaseMediator
    {
        public List<object> Sent { get; } = [];

        public Task Dispatch(ICommand command, CancellationToken cancellationToken = default) => Record(command);

        public Task<TResult> Dispatch<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default) => Record<TResult>(command);

        public Task<TResult> Dispatch<TResult>(IQuery<TResult> query, CancellationToken cancellationToken = default) => Record<TResult>(query);

        public Task DispatchWithoutTransaction(ICommand command, CancellationToken cancellationToken = default) => Record(command);

        public Task<TResult> DispatchWithoutTransaction<TResult>(IReturningCommand<TResult> command, CancellationToken cancellationToken = default) => Record<TResult>(command);

        private Task Record(object message)
        {
            Sent.Add(message);
            return Task.CompletedTask;
        }

        private Task<TResult> Record<TResult>(object message)
        {
            Sent.Add(message);
            return Task.FromResult(default(TResult)!);
        }
    }
}`;
  const usings = [
    'System.Text.Json',
    'Microsoft.AspNetCore.Mvc.Testing',
    'Microsoft.AspNetCore.TestHost',
    'Microsoft.Extensions.DependencyInjection',
    'Xunit',
    namespaceOf(model, 'abstractions'),
    ...new Set(operations.map((operation) => messageNamespace(model, operation)))
  ];
  return [{ path: `${sln.unitTests.dir}/OptionalAuthTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) }];
}
