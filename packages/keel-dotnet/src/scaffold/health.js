// Sondas de vida y de disponibilidad, y el apagado ordenado.
//
// El contrato es el de los servidores de keel-spring y keel-nest del mismo diseño: `GET /livez` y
// `GET /readyz` en el puerto principal, con cuerpo `{"status":"UP"}`; mientras el servicio drena tras un
// SIGTERM, `/readyz` responde 503 con `{"status":"OUT_OF_SERVICE"}`, que es lo que saca la instancia del
// balanceador antes de que deje de aceptar conexiones. Un orquestador o un HEALTHCHECK escritos contra uno
// de los tres servidores sirven para los otros.
//
// En .NET el host ya sabe apagarse en orden: al recibir la señal dispara `ApplicationStopping` (aquí empieza
// el drenaje), para el servidor HTTP y espera a las peticiones en vuelo como máximo `HostOptions.ShutdownTimeout`,
// que sale de `server.shutdown-timeout`. Lo único del proyecto es el estado de drenaje.

import { solution, csFile } from './render.js';

export function healthNamespace(model) {
  return `${solution(model).infrastructure.name}.Health`;
}

export function generate(model) {
  const dir = `${solution(model).infrastructure.dir}/Health`;
  return [
    { path: `${dir}/GracefulShutdown.cs`, content: gracefulShutdownCs(model) },
    { path: `${dir}/HealthEndpoints.cs`, content: healthEndpointsCs(model) }
  ];
}

function gracefulShutdownCs(model) {
  return csFile({
    namespace: healthNamespace(model),
    usings: ['Microsoft.Extensions.Hosting', 'Microsoft.Extensions.Logging'],
    body: `
/// <summary>
/// El estado del apagado ordenado. En cuanto el host empieza a pararse, el servicio deja de estar
/// disponible (<c>/readyz</c> responde 503) aunque siga atendiendo lo que ya tenía en vuelo.
/// </summary>
public sealed class GracefulShutdown
{
    private int draining;

    /// <summary>¿Ha empezado el apagado?</summary>
    public bool Draining => Volatile.Read(ref draining) == 1;

    /// <summary>Deja de aceptar tráfico: <c>/readyz</c> pasa a 503. Separado de la señal para poder probarlo sin ella.</summary>
    public void StartDraining() => Interlocked.Exchange(ref draining, 1);

    /// <summary>Empieza a drenar cuando el host empieza a pararse, y lo deja escrito con el margen que tiene.</summary>
    public void Watch(IHostApplicationLifetime lifetime, ILogger logger, TimeSpan timeout)
    {
        lifetime.ApplicationStopping.Register(() =>
        {
            StartDraining();
            logger.LogInformation("Apagado ordenado: margen de {Timeout} para las peticiones en vuelo", timeout);
        });
    }
}
`
  });
}

function healthEndpointsCs(model) {
  return csFile({
    namespace: healthNamespace(model),
    usings: ['Microsoft.AspNetCore.Builder', 'Microsoft.AspNetCore.Http', 'Microsoft.AspNetCore.Routing'],
    body: `
/// <summary>El cuerpo de las dos sondas: <c>{"status":"UP"}</c> u <c>{"status":"OUT_OF_SERVICE"}</c>.</summary>
public sealed record HealthStatus(string Status);

/// <summary>Las sondas del servicio, con el contrato de los otros dos servidores del mismo diseño.</summary>
public static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        // El proceso está vivo. No consulta dependencias: si fallara por ellas, el orquestador lo reiniciaría sin motivo.
        endpoints.MapGet("/livez", () => Results.Json(new HealthStatus("UP")));
        // El proceso acepta tráfico. Deja de hacerlo en cuanto empieza el apagado ordenado.
        endpoints.MapGet("/readyz", (GracefulShutdown shutdown) => shutdown.Draining
            ? Results.Json(new HealthStatus("OUT_OF_SERVICE"), statusCode: StatusCodes.Status503ServiceUnavailable)
            : Results.Json(new HealthStatus("UP")));
        return endpoints;
    }
}
`
  });
}
