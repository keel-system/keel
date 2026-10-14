// El arranque del servidor (`Program.cs` del proyecto Api): el único sitio que crea la aplicación y la
// cablea. Usa las APIs mínimas de ASP.NET Core: sin controladores ni Startup, un mapa de rutas.
//
// El orden importa y es el de keel-nest: la configuración se carga y se valida ANTES de crear la
// aplicación, así que una variable obligatoria sin valor deja el proceso parado con la lista de las que
// faltan, en vez de arrancar a medias.

import { solution, namespaceOf } from './render.js';
import { usesMediator } from './mediator.js';
import { configNamespace } from './config.js';
import { healthNamespace } from './health.js';
import { wireNamespace } from './wire.js';
import { restNamespace, usesApi } from './rest-support.js';
import { usesRelational } from './persistence.js';
import { usesIdempotencyHeader } from './request-idempotency.js';

export function generate(model) {
  return [{ path: `${solution(model).api.dir}/Program.cs`, content: programCs(model) }];
}

function programCs(model) {
  const useCases = usesMediator(model);
  const persistence = usesRelational(model);
  const usings = [
    wireNamespace(model),
    configNamespace(model),
    healthNamespace(model),
    ...(useCases ? [namespaceOf(model, 'useCaseInfra')] : []),
    ...(persistence ? [namespaceOf(model, 'persistence')] : []),
    ...(usesApi(model) ? [restNamespace(model)] : [])
  ];
  const registration = useCases
    ? `
// Los casos de uso del diseño: el mediator, los handlers y los mappers (UseCaseRegistration, generado).
builder.Services.AddUseCases();`
    : '';
  const database = persistence
    ? `
// La persistencia relacional del perfil: el DbContext, la transacción del caso de uso y los repositorios.
builder.Services.AddPersistence(DatabaseSettings.From(configuration));`
    : '';
  // El esquema se pone al ARRANCAR: una base inalcanzable tumba el arranque, no la primera petición.
  const schema = persistence ? '\nawait app.Services.InitializeDatabase();' : '';
  const api = usesApi(model);
  // La correlación envuelve todo (también el cuerpo de error); el middleware de errores, todo lo que va después.
  // La cabecera Idempotency-Key, detrás de la correlación y de los errores: un rechazo sigue llevando su correlationId.
  const idempotency = api && usesIdempotencyHeader(model) ? '\napp.UseMiddleware<IdempotencyKeyMiddleware>();' : '';
  const pipeline = api ? `\napp.UseMiddleware<CorrelationMiddleware>();\napp.UseMiddleware<ApiErrorMiddleware>();${idempotency}` : '';
  // Las rutas del diseño: un solo mapa (ApiRoutes, generado).
  const routes = api ? '\napp.MapApiRoutes();' : '';
  return `${usings.map((using) => `using ${using};`).join('\n')}

// La configuración del perfil activo (PROFILE), cargada y validada antes de crear la aplicación: una
// variable obligatoria sin valor no deja arrancar, y se listan todas las que faltan.
var configuration = ServiceConfiguration.Load();

var builder = WebApplication.CreateBuilder(args);
// El resto de la aplicación lee la configuración ya resuelta por la vía estándar de ASP.NET Core.
builder.Configuration.AddInMemoryCollection(configuration.Values);
builder.WebHost.UseUrls($"http://{configuration.Server.Address}:{configuration.Server.Port}");
builder.Services.AddSingleton(configuration);
builder.Services.AddSingleton<GracefulShutdown>();
// El margen del apagado ordenado: lo que el host espera a las peticiones en vuelo tras la señal.
builder.Services.Configure<HostOptions>(options => options.ShutdownTimeout = configuration.Server.ShutdownTimeout);
// El contrato del cable: todo cuerpo JSON que la API lee o escribe pasa por estas opciones (WireJson).
builder.Services.ConfigureHttpJsonOptions(options => WireJson.Configure(options.SerializerOptions));${registration}${database}

var app = builder.Build();
app.Services.GetRequiredService<GracefulShutdown>().Watch(app.Lifetime, app.Logger, configuration.Server.ShutdownTimeout);${schema}${pipeline}
app.MapHealthEndpoints();${routes}
app.Run();

/// <summary>Visible para las pruebas, que levantan el servidor en memoria (WebApplicationFactory).</summary>
public partial class Program;
`;
}
