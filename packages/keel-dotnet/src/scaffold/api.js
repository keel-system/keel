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
import { securityNamespace, usesHttpSecurity } from './security.js';
import { messagingNamespace, usesMessaging } from './messaging.js';
import { schedulingNamespace, usesScheduling } from './scheduling.js';
import { usesServiceParameters } from './service-parameters.js';
import { usesSweepClaims } from './claim.js';
import { clientAdaptersNamespace, usesHttpClients } from './http-clients.js';

// Los barridos del perfil, antes de la persistencia: AddPersistence solo pone los defaults si nadie registró estos.
const SWEEPS = `
// Los barridos del perfil (sweep.yaml): el lote de cada reclamo y el plazo de cada rescate.
builder.Services.AddSingleton(SweepSettings.From(configuration));`;

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
    ...(usesApi(model) ? [restNamespace(model)] : []),
    ...(usesHttpSecurity(model) ? [securityNamespace(model)] : []),
    ...(usesMessaging(model) ? [messagingNamespace(model)] : []),
    ...(usesScheduling(model) ? [schedulingNamespace(model)] : []),
    ...(usesHttpClients(model) ? [clientAdaptersNamespace(model)] : [])
  ];
  const registration = useCases
    ? `
// Los casos de uso del diseño: el mediator, los handlers y los mappers (UseCaseRegistration, generado).
builder.Services.AddUseCases();`
    : '';
  const database = persistence
    ? `
// La persistencia relacional del perfil: el DbContext, la transacción del caso de uso y los repositorios.${usesSweepClaims(model) ? SWEEPS : ''}
builder.Services.AddPersistence(DatabaseSettings.From(configuration));
// Cada sentencia SQL no es un evento del servicio: solo sus avisos y errores, como Hibernate sin show-sql en keel-spring y
// TypeORM sin logging en keel-nest. A nivel Information, un relay que sondea cada segundo inundaba el log.
builder.Logging.AddFilter("Microsoft.EntityFrameworkCore.Database.Command", LogLevel.Warning);`
    : '';
  // La seguridad del diseño (capa security): los autenticadores, CORS y el alcance por recurso (SecurityRegistration).
  const security = usesHttpSecurity(model)
    ? `
// La seguridad del diseño: autenticadores, CORS y alcance por recurso (SecurityRegistration, generado).
builder.Services.AddHttpSecurity(configuration);`
    : '';
  const messaging = usesMessaging(model)
    ? `
// La mensajería del diseño: el puente de eventos, el outbox, el registro de procesados y la conexión con el broker
// (MessagingRegistration, generado). Lo que escribe el agente para el broker entra por BrokerBindings.cs.
builder.Services.AddMessaging(configuration);`
    : '';
  // Los parámetros de despliegue, antes que nada: un valor mal puesto no deja arrancar (ServiceParametersRegistration).
  const parameters = usesServiceParameters(model)
    ? `
// Los parámetros de despliegue del diseño (service.parameters), validados al arrancar.
builder.Services.AddServiceParameters(configuration);`
    : '';
  // Los clientes salientes del diseño, antes de los casos de uso que los inyectan (la URL obligatoria no deja arrancar sin ella).
  const clients = usesHttpClients(model)
    ? `
// Los clientes HTTP salientes del diseño (http-clients): la configuración del perfil, los adaptadores y su resiliencia.
builder.Services.AddOutboundClients(HttpClientsSettings.From(configuration));`
    : '';
  // El reloj va el último: despacha por los casos de uso y purga con la persistencia.
  const clock = usesScheduling(model)
    ? `
// El reloj: los barridos del diseño (schedule) y las purgas de las tablas del generador (SchedulingRegistration, generado).
builder.Services.AddScheduling(configuration);`
    : '';
  // El esquema se pone al ARRANCAR: una base inalcanzable tumba el arranque, no la primera petición.
  const schema = persistence ? '\nawait app.Services.InitializeDatabase();' : '';
  const api = usesApi(model);
  // La correlación envuelve todo (también el cuerpo de error); el middleware de errores, todo lo que va después.
  // La cabecera Idempotency-Key, detrás de la correlación y de los errores: un rechazo sigue llevando su correlationId.
  const idempotency = api && usesIdempotencyHeader(model) ? '\napp.UseMiddleware<IdempotencyKeyMiddleware>();' : '';
  // La seguridad, detrás de la correlación y de los errores (el 401 lleva su correlationId; un proveedor caído es el 500
  // del contrato) y delante de los endpoints: decide también sobre un camino que no existe, como Spring Security.
  const securityMiddleware = api && usesHttpSecurity(model) ? '\napp.UseMiddleware<HttpSecurityMiddleware>();' : '';
  const pipeline = api ? `\napp.UseMiddleware<CorrelationMiddleware>();\napp.UseMiddleware<ApiErrorMiddleware>();${idempotency}${securityMiddleware}` : '';
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
builder.Services.AddSingleton(configuration);${parameters}
builder.Services.AddSingleton<GracefulShutdown>();
// El margen del apagado ordenado: lo que el host espera a las peticiones en vuelo tras la señal.
builder.Services.Configure<HostOptions>(options => options.ShutdownTimeout = configuration.Server.ShutdownTimeout);
// El contrato del cable: todo cuerpo JSON que la API lee o escribe pasa por estas opciones (WireJson).
builder.Services.ConfigureHttpJsonOptions(options => WireJson.Configure(options.SerializerOptions));${registration}${clients}${database}${security}${messaging}${clock}

var app = builder.Build();
app.Services.GetRequiredService<GracefulShutdown>().Watch(app.Lifetime, app.Logger, configuration.Server.ShutdownTimeout);${schema}${pipeline}
app.MapHealthEndpoints();${routes}
app.Run();

/// <summary>Visible para las pruebas, que levantan el servidor en memoria (WebApplicationFactory).</summary>
public partial class Program;
`;
}
