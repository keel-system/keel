// La persistencia relacional en ejecución: la configuración de la base por perfil, la transacción del caso de uso
// que abre el mediator y que los adaptadores comparten sin verla, la traducción de los errores del motor al
// contrato y el registro en el contenedor.
//
// Todo con los MISMOS nombres y la misma semántica que los servidores de keel-spring y keel-nest del mismo diseño:
//   · las variables de entorno (DB_URL, DB_USERNAME, DB_PASSWORD, DB_POOL_MAX_SIZE, DB_POOL_CONNECTION_TIMEOUT_MS,
//     DB_POOL_MAX_LIFETIME_MS, DB_TRANSACTION_TIMEOUT) con su gradiente (keel-core/gen/runtime-env.js). DB_URL
//     admite la URL JDBC tal cual la escribe un despliegue de keel-spring: el mismo `.env` sirve para los tres;
//   · el esquema: en `local` lo crea EF desde el modelo; en develop y production lo gobiernan las migraciones;
//   · el tope de transacción → 503 TRANSACTION_TIMEOUT con Retry-After, el interbloqueo reintentado y, agotado,
//     409; la violación de una constraint con nombre → el error que el diseño declara para ella.
//
// El perfil `test` no tiene base de datos: las pruebas que build deja (el contrato HTTP, el cableado) arrancan sin
// infraestructura, y quien toque un repositorio recibe un error que lo dice. El esquema contra un motor real lo
// juzga `npm run db-check` de keel-dotnet.

import { idempotencyRegistration, idempotencyRegistrationUsings } from './request-idempotency.js';
import { usesSweepClaims } from './claim.js';
import { usesReconciliationClaims, usesReconciliationSettings } from './reconciliation-claim.js';
import { constraintErrors, declaredConcurrencyError, CONCURRENT_MODIFICATION_MESSAGE, UNKNOWN_INTEGRITY_MESSAGE, TRANSACTION_TIMEOUT_MESSAGE } from 'keel-core/gen';
import { WRITE_CONFLICT_ATTEMPTS } from 'keel-core/gen/transactions';
import { DATABASES } from 'keel-core/gen/infra-catalog';
import { envFor } from 'keel-core/gen/runtime-env';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { SYSTEM_ACTOR } from 'keel-core/gen/relational';
import { csFile, csString, located, namespaceOf, solution } from './render.js';
import { usesCorrelation } from './rest-support.js';
import { securityNamespace, usesHttpSecurity } from './security.js';
import { configNamespace } from './config.js';
import { usesRelational, dbContextClass, persistedEntities } from './persistence.js';
import { repositoryRoots, portClass, adapterClass, repositoriesNamespace } from './repositories.js';
import { AFTER_COMMIT_REGISTRATION } from './after-commit.js';

/** El historial de migraciones con nombre propio: infra/reset-db.sh lo respeta por nombre. */
export const MIGRATIONS_TABLE = 'ef_migrations_history';

export function generate(model) {
  if (!usesRelational(model)) return [];
  const dbName = model.service.name.replace(/-/g, '_');
  const file = (name, usings, body) => {
    const { namespace, path } = located(model, 'persistence', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  return [
    ...['local', 'develop', 'production', 'test'].map((profile) => ({ path: `config/parameters/${profile}/db.yaml`, content: dbYaml(model, profile, dbName) })),
    file('DatabaseSettings', ['System.Globalization', 'System.Text.RegularExpressions', 'Npgsql', configNamespace(model)], databaseSettingsBody(model)),
    file(
      'PersistenceTransactions',
      ['System.Globalization', 'Microsoft.EntityFrameworkCore', 'Microsoft.Extensions.Logging', namespaceOf(model, 'useCaseInfra')],
      transactionsBody(model)
    ),
    file('PersistenceErrors', ['Microsoft.EntityFrameworkCore', 'Npgsql', namespaceOf(model, 'errors')], errorsBody(model)),
    file(
      'PersistenceRegistration',
      [
        'System.Data.Common',
        'Microsoft.EntityFrameworkCore',
        'Microsoft.EntityFrameworkCore.Diagnostics',
        'Microsoft.Extensions.DependencyInjection',
        'Microsoft.Extensions.DependencyInjection.Extensions',
        namespaceOf(model, 'useCaseInfra'),
        repositoriesNamespace(model),
        namespaceOf(model, 'repositoryAdapters'),
        namespaceOf(model, 'ports'),
        ...idempotencyRegistrationUsings(model)
      ],
      registrationBody(model)
    ),
    ...(usesAuthorship(model) ? auditActorFiles(model) : []),
    file('DesignTimeDbContextFactory', ['Microsoft.EntityFrameworkCore', 'Microsoft.EntityFrameworkCore.Design'], designTimeFactoryBody(model))
  ];
}

/**
 * Lo que usa `dotnet ef` para construir el contexto SIN arrancar el servidor: generar una migración compara el modelo
 * con la última, no necesita base. La cadena de conexión no se usa para conectar; el historial sí tiene que ser el
 * mismo nombre que en ejecución.
 */
function designTimeFactoryBody(model) {
  const context = dbContextClass(model);
  return `/// <summary>
/// El ${context} para las herramientas de diseño (<c>dotnet ef migrations add</c>), sin pasar por Program.cs: no hace
/// falta configuración del perfil ni base de datos para comparar el modelo con la última migración. El baseline lo
/// crea el pase de calidad: <c>dotnet ef migrations add Baseline --project src/${model.service.rootNamespace}.Infrastructure</c>.
/// </summary>
public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<${context}>
{
    public ${context} CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<${context}>()
            .UseNpgsql("Host=localhost;Database=design_time", npgsql => npgsql.MigrationsHistoryTable(${csString(MIGRATIONS_TABLE)}))
            .Options;
        return new ${context}(options);
    }
}`;
}

/** ¿Alguna entidad registra QUIÉN escribe, por política o en campos declarados? */
export function usesAuthorship(model) {
  return persistedEntities(model).some((entity) => entity.auditAuthorship === 'all' || entity.auditAuthorship === 'declared');
}

/**
 * La AUTORÍA de las escrituras (`persistence.audit.authorship`, incremento 13h): el AuditorAware de keel-spring y el
 * `currentActor()` de keel-nest, con la misma regla, porque lo que queda en `created_by`/`updated_by` es contrato de los
 * datos —lo lee quien audita, con cualquiera de los tres servidores—:
 *   · con un token, el SUJETO (`sub`): el identificador estable, no el nombre del principal, que es para mostrar y puede
 *     cambiar; el nombre solo si el token no trae `sub`;
 *   · con una clave de API, el cliente que autenticó;
 *   · sin petición autenticada detrás (un listener, un barrido, el relay): el centinela `system`, con la correlación si la
 *     hay (`system:<correlationId>`), que dice la verdad en vez de un null que obligue a adivinarlo.
 */
export function auditActorFile(model) {
  const { namespace, path } = located(model, 'persistence', 'AuditActor');
  // La correlación la abren la entrada HTTP y la mensajería: un listener sin API también la tiene.
  const correlation = usesCorrelation(model);
  const security = usesHttpSecurity(model);
  const fallback = correlation ? 'CorrelationContext.Get() is { } correlationId ? $"{System}:{correlationId}" : System' : 'System';
  const current = security
    ? `    public static string Current()
    {
        if (SecurityContext.Get() is { } principal)
        {
            // Con un token, el sujeto; con una clave de API, el cliente que la presentó.
            return principal.Kind == PrincipalKind.Token && ClaimValues.Text(principal.Claims, "sub") is { Length: > 0 } subject ? subject : principal.Name;
        }
        // Escritura sin petición autenticada detrás: no hay actor, pero sí traza.
        return ${fallback};
    }`
    : `    /// <remarks>Sin capa de seguridad no hay principal: toda escritura es del sistema.</remarks>
    public static string Current() => ${fallback};`;
  const body = `/// <summary>Quién escribe, para created_by y updated_by: la regla del AuditorAware de keel-spring. Nunca vacío: las columnas son NOT NULL.</summary>
public static class AuditActor
{
    /// <summary>El autor de las escrituras que no nacen de una petición autenticada.</summary>
    public const string System = ${csString(SYSTEM_ACTOR)};

${current}
}`;
  const usings = [...(correlation ? [namespaceOf(model, 'correlation')] : []), ...(security ? [securityNamespace(model)] : [])];
  return { path, content: csFile({ namespace, usings, body }) };
}

/** El actor y su prueba emitida: lo que cada rama de persistencia añade con autoría. */
export function auditActorFiles(model) {
  return [auditActorFile(model), auditActorTestsFile(model)];
}

/**
 * `AuditActorTests`: la regla del actor EJECUTADA, caso a caso, con lo que el servicio tiene (seguridad, correlación).
 * Es lo que en keel-nest mide audit-actor.test.js transpilando el actor; aquí corre en `dotnet test`.
 */
function auditActorTestsFile(model) {
  const sln = solution(model);
  const correlation = usesCorrelation(model);
  const security = usesHttpSecurity(model);
  const tests = [];
  if (security) {
    tests.push(`    [Fact]
    public void ConUnTokenEsElSujetoNoElNombre()
    {
        using var _ = SecurityContext.Open(Token("nombre-visible", """{"sub":"sujeto-estable"}"""));
        Assert.Equal("sujeto-estable", AuditActor.Current());
    }

    [Fact]
    public void ConUnTokenSinSujetoEsElNombre()
    {
        using var _ = SecurityContext.Open(Token("nombre-visible", """{"name":"x"}"""));
        Assert.Equal("nombre-visible", AuditActor.Current());
    }

    [Fact]
    public void ConUnaClaveDeApiEsElCliente()
    {
        using var _ = SecurityContext.Open(new Principal(PrincipalKind.Key, "cliente-de-la-clave", new HashSet<string>(), new Dictionary<string, JsonElement>()));
        Assert.Equal("cliente-de-la-clave", AuditActor.Current());
    }

    private static Principal Token(string name, string claims) =>
        new(PrincipalKind.Token, name, new HashSet<string>(), JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(claims)!);`);
  }
  if (correlation) {
    tests.push(`    [Fact]
    public void SinPrincipalEsElSistemaConLaCorrelacion()
    {
        using var _ = CorrelationContext.Open("pedido-42");
        Assert.Equal("system:pedido-42", AuditActor.Current());
    }`);
  }
  tests.push(`    [Fact]
    public void SinPrincipalNiCorrelacionEsElSistemaNuncaVacio() => Assert.Equal(AuditActor.System, AuditActor.Current());`);
  const body = `/// <summary>Quién queda en created_by y updated_by: la regla del AuditorAware de keel-spring, ejecutada.</summary>
public sealed class AuditActorTests
{
${tests.join('\n\n')}
}`;
  const usings = [
    'Xunit',
    namespaceOf(model, 'persistence'),
    ...(correlation ? [namespaceOf(model, 'correlation')] : []),
    ...(security ? ['System.Text.Json', securityNamespace(model)] : [])
  ];
  return { path: `${sln.unitTests.dir}/AuditActorTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) };
}

export function persistenceRuntimeNamespace(model) {
  return namespaceOf(model, 'persistence');
}

// ─── Configuración ───────────────────────────────────────────────────────────────────────────────

/** La URL de conexión de local: la JDBC que escribe keel-spring para el mismo motor. */
export function localDatabaseUrl(engine, dbName) {
  return `jdbc:${engine}://localhost:${DATABASES[engine].port}/${dbName}`;
}

function dbYaml(model, profile, dbName) {
  const engine = 'postgresql';
  const db = DATABASES[engine];
  if (profile === 'test') {
    return `# El perfil test no tiene base de datos: las pruebas de build arrancan sin infraestructura, y un
# repositorio usado aquí falla diciéndolo. El esquema contra un motor real lo juzga db-check.
database:
  enabled: false
`;
  }
  return `database:
  # La URL JDBC de keel-spring vale tal cual (jdbc:${engine}://host:puerto/base): el mismo .env sirve para los
  # tres servidores del diseño.
  url: ${envFor('DB_URL', profile, localDatabaseUrl(engine, dbName))}
  username: ${envFor('DB_USERNAME', profile, db.user(dbName))}
  password: ${envFor('DB_PASSWORD', profile, db.password)}
  pool:
    # El nombre de la aplicación en pg_stat_activity: con el de por defecto, dos servicios en el mismo backend no
    # se distinguen.
    name: ${model.service.name}-pool
    max-size: ${envFor('DB_POOL_MAX_SIZE', profile)}
    # Cuánto espera una petición a que haya conexión libre: fallar rápido con el pool agotado en vez de acumular
    # peticiones que el cliente ya abandonó.
    connection-timeout-ms: ${envFor('DB_POOL_CONNECTION_TIMEOUT_MS', profile)}
    # Vida máxima de una conexión: menor que cualquier corte de ociosas entre el servicio y la base.
    max-lifetime-ms: ${envFor('DB_POOL_MAX_LIFETIME_MS', profile)}
  # Tope de cada transacción; lo cancelado sale como 503 TRANSACTION_TIMEOUT.
  transaction-timeout: ${envFor('DB_TRANSACTION_TIMEOUT', profile)}
  # ${profile === 'local' ? 'Solo para iterar: en local EF crea el esquema desde el modelo si la base está vacía (infra/reset-db.sh --schema lo rehace).' : 'Al arrancar se aplican las migraciones pendientes del proyecto Infrastructure (el baseline lo crea el pase de calidad).'}
  schema: ${profile === 'local' ? 'create' : 'migrate'}
`;
}

function databaseSettingsBody(model) {
  const engine = DATABASES.postgresql;
  return `/// <summary>Cómo se gobierna el esquema al arrancar.</summary>
public enum SchemaMode
{
    /// <summary>Nada: el perfil no tiene base o el esquema lo pone otro.</summary>
    None,

    /// <summary>EF crea el esquema desde el modelo si la base está vacía (solo local).</summary>
    Create,

    /// <summary>Se aplican las migraciones pendientes del proyecto Infrastructure.</summary>
    Migrate
}

/// <summary>
/// La configuración de la base del perfil activo, ya resuelta y validada. Una URL que no es de ${engine.label} no deja
/// arrancar: conectaría a otra cosa o fallaría en la primera petición, lejos de la causa.
/// </summary>
public sealed partial record DatabaseSettings(bool Enabled, string? ConnectionString, TimeSpan TransactionTimeout, SchemaMode Schema)
{
    /// <summary>Sin base de datos: el perfil test.</summary>
    public static DatabaseSettings Disabled { get; } = new(false, null, TimeSpan.FromSeconds(30), SchemaMode.None);

    public static DatabaseSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var url = configuration.Get("database:url");
        var timeout = ServiceConfiguration.ToDuration(configuration.Get("database:transaction-timeout") ?? "30s");
        if (string.Equals(configuration.Get("database:enabled"), "false", StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(url))
        {
            return Disabled with { TransactionTimeout = timeout };
        }
        var match = DatabaseUrl().Match(url.Trim());
        if (!match.Success)
        {
            throw new InvalidOperationException($"database.url no es una URL de ${engine.label}: '{url}' (usa jdbc:postgresql://host:puerto/base)");
        }
        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = match.Groups["host"].Value,
            Port = match.Groups["port"].Success ? int.Parse(match.Groups["port"].Value, CultureInfo.InvariantCulture) : ${engine.port},
            Database = Uri.UnescapeDataString(match.Groups["database"].Value),
            Username = configuration.Get("database:username"),
            Password = configuration.Get("database:password"),
            ApplicationName = configuration.Get("database:pool:name") ?? configuration.ApplicationName,
            MaxPoolSize = Positive(configuration.Get("database:pool:max-size"), 10),
            // Npgsql mide en segundos: la espera por una conexión libre del pool y la vida máxima de una conexión.
            Timeout = Seconds(Positive(configuration.Get("database:pool:connection-timeout-ms"), 5000)),
            ConnectionLifetime = Seconds(Positive(configuration.Get("database:pool:max-lifetime-ms"), 1800000))
        };
        var schema = configuration.Get("database:schema") switch
        {
            "create" => SchemaMode.Create,
            "migrate" => SchemaMode.Migrate,
            _ => SchemaMode.None
        };
        return new DatabaseSettings(true, builder.ConnectionString, timeout, schema);
    }

    private static int Positive(string? value, int fallback) =>
        int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed > 0 ? parsed : fallback;

    private static int Seconds(int milliseconds) => Math.Max(1, (milliseconds + 999) / 1000);

    /// <summary><c>jdbc:postgresql://host:puerto/base?…</c> o <c>postgresql://host:puerto/base</c>. Los parámetros de la URL no se trasladan: los que importan tienen su propia variable.</summary>
    [GeneratedRegex(@"^(?:jdbc:)?(?:postgresql|postgres)://(?<host>[^/:?]+)(?::(?<port>\\d+))?/(?<database>[^?;]+)", RegexOptions.IgnoreCase)]
    private static partial Regex DatabaseUrl();
}`;
}

// ─── La transacción ──────────────────────────────────────────────────────────────────────────────

function transactionsBody(model) {
  const context = dbContextClass(model);
  return `/// <summary>
/// La transacción del caso de uso sobre el DbContext del ámbito: la abre el UseCaseMediator (las consultas en solo
/// lectura) y los adaptadores de repositorio se UNEN a ella sin verla. Una escritura sin transacción abarcadora (un
/// barrido despachado sin ella) abre la suya.
/// </summary>
/// <remarks>
/// <para>
/// El tope: <c>SET LOCAL statement_timeout</c> con DB_TRANSACTION_TIMEOUT, al abrir. Es por SENTENCIA (espera de bloqueo
/// incluida), no por la transacción entera, como el setQueryTimeout de Hibernate; lo cortado sale como 503.
/// </para>
/// <para>
/// Un interbloqueo o un fallo de serialización se arreglan repitiendo la transacción ENTERA —el caso de uso otra vez,
/// sobre el estado nuevo— hasta ${WRITE_CONFLICT_ATTEMPTS} intentos; agotados, son el 409 de concurrencia. Un conflicto de
/// versión NO se repite: reaplicar la intención del cliente sobre un estado que no vio escondería la actualización
/// perdida.
/// </para>
/// </remarks>
public sealed partial class PersistenceTransactions(${context} db, DatabaseSettings settings, ILogger<PersistenceTransactions> logger) : IUseCaseTransactions
{
    /// <summary>Intentos de una transacción de escritura que pierde un conflicto transitorio (keel-core/gen/transactions.js).</summary>
    public const int WriteConflictAttempts = ${WRITE_CONFLICT_ATTEMPTS};

    /// <summary>Lo que espera al commit de la transacción abierta (null: no hay ninguna abierta por esta instancia).</summary>
    private List<Func<Task>>? afterCommit;

    private readonly string statementTimeout = string.Create(
        CultureInfo.InvariantCulture,
        $"SET LOCAL statement_timeout = {(long)settings.TransactionTimeout.TotalMilliseconds}");

    public Task<T> Run<T>(Func<Task<T>> work, bool readOnly, CancellationToken cancellationToken) => InTransaction(work, readOnly, cancellationToken);

    /// <summary>
    /// Ejecuta <paramref name="action"/> DESPUÉS de que la transacción abierta confirme (el afterCommit de Spring): un
    /// rollback la descarta. Sin transacción abierta, se ejecuta ya. Un fallo de la acción no deshace nada —el cambio ya
    /// está confirmado—: se registra y se sigue.
    /// </summary>
    public void AfterCommit(Func<Task> action)
    {
        ArgumentNullException.ThrowIfNull(action);
        if (afterCommit is null)
        {
            _ = RunAfterCommit([action]);
            return;
        }
        afterCommit.Add(action);
    }

    /// <summary>
    /// Como <see cref="AfterCommit"/>, pero sin transacción abierta la ESPERA en vez de lanzarla: lo que lo llama necesita
    /// que haya ocurrido al volver (la caché vaciada antes de responder, o la siguiente lectura serviría el valor viejo).
    /// Con transacción abierta, queda para tras el commit, como <see cref="AfterCommit"/>.
    /// </summary>
    public Task AfterCommitOrNow(Func<Task> action)
    {
        ArgumentNullException.ThrowIfNull(action);
        if (afterCommit is null)
        {
            return RunAfterCommit([action]);
        }
        afterCommit.Add(action);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Ejecuta <paramref name="work"/> en una transacción: la ABIERTA si la hay (se une a ella, como la propagación por
    /// defecto de Spring) o una nueva, que confirma si termina y revierte si lanza. Los fallos del motor salen ya
    /// traducidos al contrato (PersistenceErrors).
    /// </summary>
    public async Task<T> InTransaction<T>(Func<Task<T>> work, bool readOnly, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(work);
        if (db.Database.CurrentTransaction is not null)
        {
            return await work();
        }
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await Once(work, readOnly, cancellationToken);
            }
            catch (Exception error) when (!readOnly && attempt < WriteConflictAttempts && PersistenceErrors.IsTransientWriteConflict(error))
            {
                // Lo que la transacción revertida dejó en el contexto ya no es verdad: el intento siguiente lee de nuevo.
                db.ChangeTracker.Clear();
                LogRetry(attempt, error.GetType().Name);
            }
            catch (Exception error) when (PersistenceErrors.IsTransientWriteConflict(error))
            {
                db.ChangeTracker.Clear();
                throw PersistenceErrors.Translate(new WriteConflictExhaustedException(attempt, error))!;
            }
            catch (Exception error) when (PersistenceErrors.Translate(error) is { } translated)
            {
                db.ChangeTracker.Clear();
                throw translated;
            }
        }
    }

    private async Task<T> Once<T>(Func<Task<T>> work, bool readOnly, CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        // Lo que espera al commit es de ESTE intento: uno que se revierte (y se repite) no deja nada pendiente.
        var pending = new List<Func<Task>>();
        afterCommit = pending;
        try
        {
            // Solo lectura primero: SET TRANSACTION tiene que ir antes de cualquier consulta.
            if (readOnly)
            {
                await db.Database.ExecuteSqlRawAsync("SET TRANSACTION READ ONLY", cancellationToken);
            }
            await db.Database.ExecuteSqlRawAsync(statementTimeout, cancellationToken);
            var result = await work();
            await transaction.CommitAsync(cancellationToken);
            afterCommit = null;
            await RunAfterCommit(pending);
            return result;
        }
        finally
        {
            afterCommit = null;
        }
    }

    private async Task RunAfterCommit(IReadOnlyList<Func<Task>> actions)
    {
        foreach (var action in actions)
        {
            try
            {
                await action();
            }
            catch (Exception error)
            {
                LogAfterCommitFailed(error);
            }
        }
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Lo que esperaba al commit falló; el cambio ya estaba confirmado")]
    private partial void LogAfterCommitFailed(Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Conflicto de escritura transitorio en el intento {Attempt} ({Type}): se repite la transacción")]
    private partial void LogRetry(int attempt, string type);
}`;
}

// ─── Errores del motor ───────────────────────────────────────────────────────────────────────────

function errorsBody(model) {
  const entries = constraintErrors(model);
  const concurrency = declaredConcurrencyError(model);
  const build = (declared, message, code) => {
    if (!declared) return `new ConflictException(${csString(message)}, code: ${csString(code)}, httpStatus: 409)`;
    return declared.dynamicStatus ? `new ${declared.exceptionClass}(${csString(message)}, 409)` : `new ${declared.exceptionClass}(${csString(message)})`;
  };
  const concurrencyError = concurrency
    ? build(concurrency, CONCURRENT_MODIFICATION_MESSAGE)
    : // `details: []` y no null: es lo que responde el handler de keel-spring para este conflicto.
      `new ConflictException(${csString(CONCURRENT_MODIFICATION_MESSAGE)}, code: ${csString(FRAMEWORK_ERRORS.concurrency.code)}, httpStatus: 409, details: [], cause: error)`;
  const rows = entries.map((entry) => {
    const why = entry.reference
      ? `Referencia entre agregados (${entry.reference.table}.${entry.reference.column} → ${entry.reference.refTable}): el desenlace de negocio de borrar el padre.`
      : entry.named
        ? `Unicidad de ${entry.entity}.${entry.fields.join(', ')}: el error que el diseño NOMBRA para ella.`
        : entry.raceOnly
          ? `Unicidad de ${entry.entity}.${entry.fields.join(', ')}: solo una carrera la rompe, así que es conflicto de concurrencia.`
          : entry.declared
            ? `Unicidad de ${entry.entity}.${entry.fields.join(', ')}: el error que el diseño declara para ella.`
            : `Unicidad de ${entry.entity}.${entry.fields.join(', ')}: el diseño no nombra un error para ella, así que sale con el code CANÓNICO de la familia uniqueness (docs/framework-errors.md).`;
    return `        // ${why}\n        [${csString(entry.constraint.toLowerCase())}] = () => ${build(entry.declared, entry.message, entry.code)},`;
  });
  return `/// <summary>
/// Conflicto de bloqueo optimista: otra escritura subió la versión del agregado (o lo borró) entre que este lo leyó y
/// lo guardó. Es un 409 y NO se reintenta.
/// </summary>
public sealed class OptimisticLockConflict(string entity, string id)
    : Exception($"{entity} {id}: la versión cambió desde que se leyó");

/// <summary>Un conflicto de escritura transitorio (interbloqueo) que agotó sus reintentos: sale como 409.</summary>
public sealed class WriteConflictExhaustedException(int attempts, Exception cause)
    : Exception($"Conflicto de escritura concurrente tras {attempts} intentos", cause);

/// <summary>El motor cortó la transacción por su tope: transitorio, y la transacción revirtió entera (503 con Retry-After).</summary>
public sealed class TransactionTimeoutException(Exception cause) : Exception(DefaultMessage, cause)
{
    public const string Code = ${csString(FRAMEWORK_ERRORS.transactionTimeout.code)};

    public const int Status = ${FRAMEWORK_ERRORS.transactionTimeout.http};

    public const string DefaultMessage = ${csString(TRANSACTION_TIMEOUT_MESSAGE)};
}

/// <summary>Una violación de integridad que no casa con ninguna constraint conocida: 409 sin <c>code</c>, como keel-spring.</summary>
public sealed class IntegrityViolationException(Exception cause) : Exception(DefaultMessage, cause)
{
    public const string DefaultMessage = ${csString(UNKNOWN_INTEGRITY_MESSAGE)};
}

/// <summary>
/// Traduce un fallo de la persistencia al contrato. Los nombres de constraint los pone el esquema
/// (keel-core/gen/relational.js) y el error, con su mensaje, keel-core/gen/constraint-errors.js: los tres servidores
/// del diseño traducen la misma violación al mismo error.
/// </summary>
public static class PersistenceErrors
{
    private static readonly Dictionary<string, Func<DomainException>> ConstraintToError = new(StringComparer.Ordinal)
    {
${rows.join('\n')}
    };

    /// <summary>El error de PostgreSQL de la cadena de causas, o null.</summary>
    public static PostgresException? EngineError(Exception error)
    {
        for (Exception? cause = error; cause is not null; cause = cause.InnerException)
        {
            if (cause is PostgresException engine)
            {
                return engine;
            }
        }
        return null;
    }

    /// <summary>¿Un interbloqueo o un fallo de serialización? Se arregla repitiendo la transacción entera.</summary>
    public static bool IsTransientWriteConflict(Exception error) =>
        EngineError(error)?.SqlState is PostgresErrorCodes.DeadlockDetected or PostgresErrorCodes.SerializationFailure;

    /// <summary>
    /// El error del contrato de un fallo de persistencia, o null si no es de persistencia:
    /// conflicto de versión o interbloqueo agotado → 409 de concurrencia (el del diseño si lo declara); violación de
    /// una constraint conocida → su error; desconocida → 409 sin code; tope de transacción → 503.
    /// </summary>
    public static Exception? Translate(Exception error)
    {
        ArgumentNullException.ThrowIfNull(error);
        if (error is OptimisticLockConflict or WriteConflictExhaustedException or DbUpdateConcurrencyException)
        {
            return ${concurrencyError};
        }
        var engine = EngineError(error);
        if (engine is null)
        {
            return null;
        }
        // Sentencia cancelada por statement_timeout (también la espera de un bloqueo).
        if (engine.SqlState is PostgresErrorCodes.QueryCanceled or PostgresErrorCodes.LockNotAvailable)
        {
            return new TransactionTimeoutException(error);
        }
        // Clase 23: violaciones de integridad (unicidad, FK, NOT NULL, CHECK).
        if (engine.SqlState.StartsWith("23", StringComparison.Ordinal))
        {
            var constraint = engine.ConstraintName?.ToLowerInvariant();
            return constraint is not null && ConstraintToError.TryGetValue(constraint, out var build) ? build() : new IntegrityViolationException(error);
        }
        return null;
    }
}`;
}

// ─── El registro ─────────────────────────────────────────────────────────────────────────────────

function registrationBody(model) {
  const context = dbContextClass(model);
  const repositories = repositoryRoots(model).map((entity) => `        services.AddScoped<${portClass(entity)}, ${adapterClass(entity)}>();`);
  const idempotency = idempotencyRegistration(model);
  if (idempotency) repositories.push(idempotency);
  // Los barridos: los defaults si nadie registró antes los del perfil (Program.cs lo hace con SweepSettings.From).
  if (usesSweepClaims(model)) repositories.unshift('        services.TryAddSingleton(SweepSettings.Defaults);');
  // Los barridos de reconciliación, igual (Program.cs registra los del perfil), y la tienda de su reclamo: una por ámbito,
  // sobre el DbContext del ámbito.
  if (usesReconciliationSettings(model)) repositories.unshift('        services.TryAddSingleton(ReconciliationSettings.Defaults);');
  if (usesReconciliationClaims(model)) repositories.push('        services.AddScoped<ReconciliationClaimStore>();');
  return `/// <summary>
/// La persistencia relacional en el contenedor: el DbContext del perfil (uno por ámbito), la transacción del caso de
/// uso y un adaptador por puerto. El ÚNICO sitio que registra los repositorios.
/// </summary>
public static class PersistenceRegistration
{
    public static IServiceCollection AddPersistence(this IServiceCollection services, DatabaseSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        services.AddSingleton(settings);
        services.AddDbContext<${context}>(options => Configure(options, settings));
        services.AddScoped<PersistenceTransactions>();
        // El mediator abre la transacción de cada caso de uso con ESTA implementación.
        services.Replace(ServiceDescriptor.Scoped<IUseCaseTransactions>(provider => provider.GetRequiredService<PersistenceTransactions>()));
${AFTER_COMMIT_REGISTRATION}
${repositories.join('\n')}
        return services;
    }

    /// <summary>
    /// Pone el esquema al ARRANCAR, antes de atender nada: una base inalcanzable o un esquema que no casa tumban el
    /// arranque, no la primera petición. En local lo crea EF; fuera, se aplican las migraciones.
    /// </summary>
    public static async Task InitializeDatabase(this IServiceProvider services, CancellationToken cancellationToken = default)
    {
        var settings = services.GetRequiredService<DatabaseSettings>();
        if (!settings.Enabled || settings.Schema == SchemaMode.None)
        {
            return;
        }
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<${context}>();
        if (settings.Schema == SchemaMode.Create)
        {
            await db.Database.EnsureCreatedAsync(cancellationToken);
        }
        else
        {
            await db.Database.MigrateAsync(cancellationToken);
        }
    }

    private static void Configure(DbContextOptionsBuilder options, DatabaseSettings settings)
    {
        if (!settings.Enabled)
        {
            // Sin base en este perfil: el contexto se construye (los handlers se resuelven) y falla al conectar,
            // diciéndolo.
            options.UseNpgsql("Host=database-disabled").AddInterceptors(new DisabledDatabase());
            return;
        }
        options.UseNpgsql(
            settings.ConnectionString,
            npgsql => npgsql
                // Las colecciones del agregado en consultas aparte: con un JOIN, cada hija multiplicaría las filas.
                .UseQuerySplittingBehavior(QuerySplittingBehavior.SplitQuery)
                .MigrationsHistoryTable(${csString(MIGRATIONS_TABLE)}));
    }

    /// <summary>El perfil sin base de datos: abrir una conexión es un error que lo dice.</summary>
    private sealed class DisabledDatabase : DbConnectionInterceptor
    {
        private const string Reason = "Sin base de datos en este perfil (database.enabled: false): el perfil test no la tiene.";

        public override InterceptionResult ConnectionOpening(DbConnection connection, ConnectionEventData eventData, InterceptionResult result) =>
            throw new InvalidOperationException(Reason);

        public override ValueTask<InterceptionResult> ConnectionOpeningAsync(
            DbConnection connection,
            ConnectionEventData eventData,
            InterceptionResult result,
            CancellationToken cancellationToken = default) =>
            throw new InvalidOperationException(Reason);
    }
}`;
}
