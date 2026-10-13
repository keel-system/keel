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

export function generate(model) {
  return [{ path: `${solution(model).api.dir}/Program.cs`, content: programCs(model) }];
}

function programCs(model) {
  const useCases = usesMediator(model);
  const usings = [wireNamespace(model), configNamespace(model), healthNamespace(model), ...(useCases ? [namespaceOf(model, 'useCaseInfra')] : [])];
  const registration = useCases
    ? `
// Los casos de uso del diseño: el mediator, los handlers y los mappers (UseCaseRegistration, generado).
builder.Services.AddUseCases();`
    : '';
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
builder.Services.ConfigureHttpJsonOptions(options => WireJson.Configure(options.SerializerOptions));${registration}

var app = builder.Build();
app.Services.GetRequiredService<GracefulShutdown>().Watch(app.Lifetime, app.Logger, configuration.Server.ShutdownTimeout);
app.MapHealthEndpoints();
app.Run();

/// <summary>Visible para las pruebas, que levantan el servidor en memoria (WebApplicationFactory).</summary>
public partial class Program;
`;
}
