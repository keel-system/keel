// La persistencia DOCUMENTAL en ejecución (incremento 12b): el cliente de MongoDB configurado por perfil, la
// transacción del caso de uso que abre el mediator y que los adaptadores comparten sin verla, los índices que el
// servidor crea al arrancar, la traducción de los errores del motor al contrato y el registro en el contenedor.
//
// Emite los MISMOS nombres que la rama relacional (persistence-runtime.js) —DatabaseSettings, PersistenceTransactions,
// PersistenceErrors, PersistenceRegistration.AddPersistence/InitializeDatabase—, con la misma forma: el mediator,
// Program.cs y el middleware de errores no distinguen qué almacén tienen debajo. Lo de dentro es lo que hacen keel-spring
// y keel-nest sobre el mismo diseño:
//   · `DB_URL` es la URI de MongoDB de keel-spring tal cual —el mismo `.env` sirve a los tres servidores—;
//   · el agregado es el documento (keel-core/gen/document.js): las hijas van anidadas, un value object es un
//     subdocumento, decimal como Decimal128, uuid como binario estándar (subtipo 4), el mapeo escrito a mano sobre
//     BsonDocument (sin mapeo de clases del driver, que decidiría nombres, discriminadores y representaciones por su
//     cuenta);
//   · las transacciones multidocumento solo existen sobre un replica set, que es como arranca infra/ incluso en local;
//     dos escrituras sobre el mismo documento no esperan: la segunda aborta con un WriteConflict transitorio, que se
//     reintenta repitiendo la transacción entera y, agotado, es un 409;
//   · los índices los crea el servidor al ARRANCAR, con los nombres del diseño: el traductor de errores encuentra el
//     `code` declarado buscando ese nombre en el mensaje E11000;
//   · no hay tope de transacción ni 503: keel-spring no lo aplica en Mongo, y la transacción tiene el límite de vida
//     del servidor.
//
// El perfil `test` no tiene base de datos, como en la rama relacional.

import { constraintErrors, declaredConcurrencyError, CONCURRENT_MODIFICATION_MESSAGE, UNKNOWN_INTEGRITY_MESSAGE, TRANSACTION_TIMEOUT_MESSAGE } from '@keel-system/keel-core/gen';
import { WRITE_CONFLICT_ATTEMPTS } from '@keel-system/keel-core/gen/transactions';
import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { documentIndexes, documentValueObjects, exportIndexesScript } from '@keel-system/keel-core/gen/document';
import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { envFor } from '@keel-system/keel-core/gen/runtime-env';
import { enumMember } from '../lib/cs-projection.js';
import { csFile, csString, located, namespaceOf, typeUsings } from './render.js';
import { configNamespace } from './config.js';
import { usesDocument, persistedEntities, usesTextFold, textFoldFile } from './persistence.js';
import { auditActorFiles, usesAuthorship } from './persistence-runtime.js';
import { repositoryRoots, portClass, adapterClass, repositoriesNamespace } from './repositories.js';
import { idempotencyRegistration, idempotencyRegistrationUsings } from './request-idempotency.js';
import { usesSweepClaims } from './claim.js';
import { usesReconciliationClaims, usesReconciliationSettings } from './reconciliation-claim.js';
import { AFTER_COMMIT_REGISTRATION } from './after-commit.js';
import { localMongoUrl } from '@keel-system/keel-core/gen/infra-catalog';
export { localMongoUrl };

/** La pieza que crea los índices y la que traduce sus violaciones, como las nombra export-indexes.sh. */
const PLATFORM = { indexCreator: 'DocumentIndexes.cs', errorTranslator: 'PersistenceErrors' };

export function generate(model) {
  if (!usesDocument(model)) return [];
  const dbName = model.service.name.replace(/-/g, '_');
  const file = (name, usings, body) => {
    const { namespace, path } = located(model, 'persistence', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const files = [
    ...['local', 'develop', 'production', 'test'].map((profile) => ({ path: `config/parameters/${profile}/db.yaml`, content: dbYaml(profile, dbName) })),
    file('DatabaseSettings', ['MongoDB.Driver', configNamespace(model)], databaseSettingsBody()),
    file('DocumentDatabase', ['MongoDB.Bson', 'MongoDB.Driver'], documentDatabaseBody()),
    file('BsonValues', ['System.Text.Json', 'MongoDB.Bson'], bsonValuesBody()),
    file('DocumentIndexes', ['MongoDB.Bson', 'MongoDB.Driver'], documentIndexesBody(model)),
    file('PersistenceTransactions', ['MongoDB.Bson', 'MongoDB.Driver', 'Microsoft.Extensions.Logging', namespaceOf(model, 'useCaseInfra')], transactionsBody()),
    file('PersistenceErrors', ['MongoDB.Driver', namespaceOf(model, 'errors')], errorsBody(model)),
    file(
      'PersistenceRegistration',
      [
        'MongoDB.Bson',
        'MongoDB.Driver',
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
    { path: 'infra/export-indexes.sh', content: exportIndexesScript(model, PLATFORM) }
  ];
  const enums = documentEnums(model);
  if (enums.length > 0) files.push(file('EnumColumns', typeUsings(model, enums.map((e) => e.name)), enumColumnsBody(enums)));
  if (usesTextFold(model)) files.push(textFoldFile(model));
  if (usesAuthorship(model)) files.push(...auditActorFiles(model));
  return files;
}

// ─── Configuración ───────────────────────────────────────────────────────────────────────────────

function dbYaml(profile, dbName) {
  if (profile === 'test') {
    return `# El perfil test no tiene base de datos: las pruebas de build arrancan sin infraestructura, y un
# repositorio usado aquí falla diciéndolo. Los documentos contra un MongoDB real los juzga doc-check.
database:
  enabled: false
`;
  }
  return `database:
  # La URI de MongoDB de keel-spring vale tal cual: el mismo .env sirve para los tres servidores del diseño. Toda la
  # configuración de la conexión viaja en ella (credenciales, replica set o conexión directa).
  url: ${envFor('DB_URL', profile, localMongoUrl(dbName))}
  # Los índices los crea el servidor al arrancar, derivados enteros de persistence.keel.yaml y con los nombres del
  # diseño (Infrastructure/Persistence/DocumentIndexes.cs). Verificarlos contra los vivos: bash infra/export-indexes.sh.
`;
}

function databaseSettingsBody() {
  return `/// <summary>
/// La configuración del almacén del perfil activo, ya resuelta y validada. Una URI que no es de MongoDB, o sin base en
/// su ruta, no deja arrancar: conectaría a otra cosa o escribiría en la base <c>test</c> del servidor, lejos de la causa.
/// </summary>
public sealed record DatabaseSettings(bool Enabled, MongoUrl? Url, string? Database, string ApplicationName)
{
    /// <summary>Sin base de datos: el perfil test.</summary>
    public static DatabaseSettings Disabled { get; } = new(false, null, null, string.Empty);

    public static DatabaseSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var url = configuration.Get("database:url");
        if (string.Equals(configuration.Get("database:enabled"), "false", StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(url))
        {
            return Disabled;
        }
        var text = url.Trim();
        if (!text.StartsWith("mongodb://", StringComparison.OrdinalIgnoreCase) && !text.StartsWith("mongodb+srv://", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"database.url no es una URI de MongoDB: '{url}' (usa mongodb://usuario:clave@host:27017/base)");
        }
        var parsed = MongoUrl.Create(text);
        if (string.IsNullOrEmpty(parsed.DatabaseName))
        {
            throw new InvalidOperationException($"database.url no nombra la base del servicio en su ruta: '{url}'");
        }
        return new DatabaseSettings(true, parsed, parsed.DatabaseName, configuration.ApplicationName);
    }
}`;
}

function documentDatabaseBody() {
  return `/// <summary>
/// El cliente de MongoDB del proceso (uno: lleva el pool de conexiones) y la base del servicio. Construirlo no conecta;
/// el primer uso sí, y <c>InitializeDatabase</c> lo provoca al arrancar. Sin base en el perfil (test), usarlo es un error
/// que lo dice.
/// </summary>
public sealed class DocumentDatabase : IDisposable
{
    private const string Disabled = "Sin base de datos en este perfil (database.enabled: false): el perfil test no la tiene.";

    private readonly MongoClient? client;
    private readonly IMongoDatabase? database;

    public DocumentDatabase(DatabaseSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        if (!settings.Enabled || settings.Url is null)
        {
            return;
        }
        var clientSettings = MongoClientSettings.FromUrl(settings.Url);
        // El nombre del servicio en los registros del servidor (db.currentOp): con el de por defecto, dos servicios en
        // el mismo backend no se distinguen.
        clientSettings.ApplicationName = string.IsNullOrEmpty(settings.ApplicationName) ? null : settings.ApplicationName;
        client = new MongoClient(clientSettings);
        database = client.GetDatabase(settings.Database);
    }

    public IMongoClient Client => client ?? throw new InvalidOperationException(Disabled);

    public IMongoDatabase Database => database ?? throw new InvalidOperationException(Disabled);

    /// <summary>Una colección de la base del servicio, como documentos sin mapeo: el mapeo lo escribe cada adaptador.</summary>
    public IMongoCollection<BsonDocument> Collection(string name) => Database.GetCollection<BsonDocument>(name);

    public void Dispose() => client?.Dispose();
}`;
}

// ─── Valores BSON ────────────────────────────────────────────────────────────────────────────────

function bsonValuesBody() {
  return `/// <summary>
/// Lo que lleva cada valor entre el dominio y el documento sin perder nada por el camino, con la representación física
/// del contrato (keel-core/gen/document.js) —la que escriben y leen también los servidores de keel-spring y keel-nest
/// del mismo diseño—:
/// <list type="bullet">
/// <item>uuid como binario de subtipo 4 (estándar), no el subtipo 3 heredado ni texto;</item>
/// <item>decimal como Decimal128 con su escala (<c>2.50</c> sigue siendo <c>2.50</c>), nunca un double;</item>
/// <item>un instante como fecha BSON (milisegundos desde la época, en UTC);</item>
/// <item>una fecha sin hora como la medianoche UTC de ese día: el día no tiene zona;</item>
/// <item>un <c>json</c> embebido como su texto, y un enum por el NOMBRE de su constante (EnumColumns).</item>
/// </list>
/// Escribir es estricto; leer acepta lo que otro cliente pudo escribir sin cambiar el valor (un entero de 32 bits donde
/// se espera uno de 64). Un null donde el dominio no lo admite es un dato roto: se dice qué campo.
/// </summary>
public static class BsonValues
{
    // ─── Escribir ───────────────────────────────────────────────────────────────

    public static BsonValue Of(Guid value) => new BsonBinaryData(value, GuidRepresentation.Standard);

    public static BsonValue Of(Guid? value) => value is { } present ? Of(present) : BsonNull.Value;

    public static BsonValue Of(string? value) => value is null ? BsonNull.Value : new BsonString(value);

    public static BsonValue Of(int value) => new BsonInt32(value);

    public static BsonValue Of(int? value) => value is { } present ? Of(present) : BsonNull.Value;

    public static BsonValue Of(long value) => new BsonInt64(value);

    public static BsonValue Of(long? value) => value is { } present ? Of(present) : BsonNull.Value;

    public static BsonValue Of(bool value) => value ? BsonBoolean.True : BsonBoolean.False;

    public static BsonValue Of(bool? value) => value is { } present ? Of(present) : BsonNull.Value;

    /// <summary>Decimal128 desde el decimal de .NET: los dos guardan coeficiente y escala, así que la escala viaja entera.</summary>
    public static BsonValue Of(decimal value) => new BsonDecimal128(new Decimal128(value));

    public static BsonValue Of(decimal? value) => value is { } present ? Of(present) : BsonNull.Value;

    /// <summary>Un instante, con la precisión de la fecha BSON: el milisegundo (la de keel-spring y keel-nest).</summary>
    public static BsonValue Of(DateTimeOffset value) => new BsonDateTime(value.ToUnixTimeMilliseconds());

    public static BsonValue Of(DateTimeOffset? value) => value is { } present ? Of(present) : BsonNull.Value;

    /// <summary>Un día como la medianoche UTC de ese día.</summary>
    public static BsonValue Day(DateOnly value) => new BsonDateTime(new DateTimeOffset(value.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero).ToUnixTimeMilliseconds());

    public static BsonValue Day(DateOnly? value) => value is { } present ? Day(present) : BsonNull.Value;

    /// <summary>El json embebido como su texto, tal cual llegó.</summary>
    public static BsonValue Json(JsonElement value) => new BsonString(value.GetRawText());

    public static BsonValue Json(JsonElement? value) => value is { } present ? Json(present) : BsonNull.Value;

    /// <summary>Un enum por el nombre de su constante.</summary>
    public static BsonValue Enum<T>(T value, Func<T, string> constant)
        where T : struct, System.Enum => new BsonString(constant(value));

    public static BsonValue Enum<T>(T? value, Func<T, string> constant)
        where T : struct, System.Enum => value is { } present ? Enum(present, constant) : BsonNull.Value;

    /// <summary>Un subdocumento (un value object o una hija uno-a-uno), o null.</summary>
    public static BsonValue Optional<T>(T? value, Func<T, BsonDocument> write)
        where T : class => value is null ? BsonNull.Value : write(value);

    /// <summary>Una lista como array, en su orden. Una lista nunca es null: sin elementos es un array vacío.</summary>
    public static BsonArray Array<T>(IEnumerable<T> values, Func<T, BsonValue> write) => new(values.Select(write));

    // ─── Leer ───────────────────────────────────────────────────────────────────

    /// <summary>El valor de un campo; ausente es null (otro cliente pudo no escribirlo).</summary>
    public static BsonValue Field(BsonDocument document, string name) => document.GetValue(name, BsonNull.Value);

    public static Guid Uuid(BsonValue value, string field) => UuidOrNull(value, field) ?? throw Missing(field);

    public static Guid? UuidOrNull(BsonValue value, string field) =>
        value switch
        {
            BsonNull => null,
            BsonBinaryData { SubType: BsonBinarySubType.UuidStandard } binary => binary.ToGuid(GuidRepresentation.Standard),
            _ => throw Unexpected(field, value, "un uuid (binario de subtipo 4)")
        };

    public static string Text(BsonValue value, string field) => TextOrNull(value, field) ?? throw Missing(field);

    public static string? TextOrNull(BsonValue value, string field) =>
        value switch
        {
            BsonNull => null,
            BsonString text => text.Value,
            _ => throw Unexpected(field, value, "un texto")
        };

    public static int Int32(BsonValue value, string field) => Int32OrNull(value, field) ?? throw Missing(field);

    public static int? Int32OrNull(BsonValue value, string field) =>
        value switch
        {
            BsonNull => null,
            BsonInt32 number => number.Value,
            BsonInt64 number when number.Value is >= int.MinValue and <= int.MaxValue => (int)number.Value,
            _ => throw Unexpected(field, value, "un entero de 32 bits")
        };

    public static long Int64(BsonValue value, string field) => Int64OrNull(value, field) ?? throw Missing(field);

    public static long? Int64OrNull(BsonValue value, string field) =>
        value switch
        {
            BsonNull => null,
            BsonInt64 number => number.Value,
            BsonInt32 number => number.Value,
            _ => throw Unexpected(field, value, "un entero de 64 bits")
        };

    public static bool Bool(BsonValue value, string field) => BoolOrNull(value, field) ?? throw Missing(field);

    public static bool? BoolOrNull(BsonValue value, string field) =>
        value switch
        {
            BsonNull => null,
            BsonBoolean flag => flag.Value,
            _ => throw Unexpected(field, value, "un booleano")
        };

    public static decimal Decimal(BsonValue value, string field) => DecimalOrNull(value, field) ?? throw Missing(field);

    public static decimal? DecimalOrNull(BsonValue value, string field) =>
        value switch
        {
            BsonNull => null,
            BsonDecimal128 number => Decimal128.ToDecimal(number.Value),
            BsonInt32 number => number.Value,
            BsonInt64 number => number.Value,
            _ => throw Unexpected(field, value, "un Decimal128")
        };

    public static DateTimeOffset Instant(BsonValue value, string field) => InstantOrNull(value, field) ?? throw Missing(field);

    public static DateTimeOffset? InstantOrNull(BsonValue value, string field) =>
        value switch
        {
            BsonNull => null,
            BsonDateTime date => DateTimeOffset.FromUnixTimeMilliseconds(date.MillisecondsSinceEpoch),
            _ => throw Unexpected(field, value, "una fecha BSON")
        };

    public static DateOnly DayOf(BsonValue value, string field) => DayOrNull(value, field) ?? throw Missing(field);

    public static DateOnly? DayOrNull(BsonValue value, string field) =>
        InstantOrNull(value, field) is { } instant ? DateOnly.FromDateTime(instant.UtcDateTime) : null;

    public static JsonElement JsonOf(BsonValue value, string field) => JsonOrNull(value, field) ?? throw Missing(field);

    public static JsonElement? JsonOrNull(BsonValue value, string field)
    {
        if (TextOrNull(value, field) is not { } text)
        {
            return null;
        }
        using var parsed = JsonDocument.Parse(text);
        return parsed.RootElement.Clone();
    }

    public static T EnumOf<T>(BsonValue value, string field, Func<string, T> of)
        where T : struct, System.Enum => of(Text(value, field));

    public static T? EnumOrNull<T>(BsonValue value, string field, Func<string, T> of)
        where T : struct, System.Enum => TextOrNull(value, field) is { } constant ? of(constant) : null;

    /// <summary>Un subdocumento obligatorio.</summary>
    public static T Required<T>(BsonValue value, string field, Func<BsonDocument, T> read) =>
        value switch
        {
            BsonDocument document => read(document),
            BsonNull => throw Missing(field),
            _ => throw Unexpected(field, value, "un subdocumento")
        };

    /// <summary>Un subdocumento opcional: ausente o null es null.</summary>
    public static T? OptionalOf<T>(BsonValue value, string field, Func<BsonDocument, T> read)
        where T : class =>
        value switch
        {
            BsonDocument document => read(document),
            BsonNull => null,
            _ => throw Unexpected(field, value, "un subdocumento")
        };

    /// <summary>Un array, en su orden; ausente o null es una lista vacía (una lista nunca es null).</summary>
    public static List<T> List<T>(BsonValue value, string field, Func<BsonValue, T> read) =>
        value switch
        {
            BsonArray array => [.. array.Select(read)],
            BsonNull => [],
            _ => throw Unexpected(field, value, "un array")
        };

    /// <summary>
    /// Los subdocumentos de un camino dentro del documento (<c>sections</c>, <c>sections.items</c>), recorriendo los arrays:
    /// donde se estampa la auditoría declarada de una hija anidada.
    /// </summary>
    public static IReadOnlyList<BsonDocument> Nodes(BsonDocument root, params string[] path)
    {
        List<BsonDocument> current = [root];
        foreach (var key in path)
        {
            var next = new List<BsonDocument>();
            foreach (var node in current)
            {
                var value = node.GetValue(key, BsonNull.Value);
                if (value is BsonArray array)
                {
                    next.AddRange(array.OfType<BsonDocument>());
                }
                else if (value is BsonDocument child)
                {
                    next.Add(child);
                }
            }
            current = next;
        }
        return current;
    }

    /// <summary>
    /// Estampa <paramref name="key"/> solo si el documento no lo tiene todavía: <c>created_*</c> no cambia después de nacer.
    /// «No lo tiene» es ausente, null o el valor por defecto del dominio (el instante cero de .NET, el texto vacío): un
    /// campo declarado que el factory no fijó, como el <c>== default</c> de la rama relacional.
    /// </summary>
    public static void StampCreated(BsonDocument node, string key, BsonValue value)
    {
        var current = node.GetValue(key, BsonNull.Value);
        if (current.IsBsonNull || current is BsonString { Value: "" } || current is BsonDateTime date && date.MillisecondsSinceEpoch == DefaultInstant)
        {
            node[key] = value;
        }
    }

    private static readonly long DefaultInstant = DateTimeOffset.MinValue.ToUnixTimeMilliseconds();

    /// <summary>Un elemento de un array que tiene que ser un subdocumento.</summary>
    public static BsonDocument Document(BsonValue value, string field) =>
        value as BsonDocument ?? throw Unexpected(field, value, "un subdocumento");

    private static InvalidOperationException Missing(string field) => new($"El campo {field} es null y el dominio no lo admite");

    private static InvalidOperationException Unexpected(string field, BsonValue value, string expected) =>
        new($"El campo {field} guarda {value.BsonType} y el contrato pide {expected}");
}`;
}

/** Los enums que aparecen en algún documento: los campos de las entidades persistidas y los de sus value objects, a todo nivel. */
export function documentEnums(model) {
  const names = new Set();
  const add = (field) => {
    if (field?.kind === 'enum') names.add(field.namedType ?? field.csType);
  };
  for (const entity of persistedEntities(model)) for (const field of entity.fields ?? []) add(field);
  for (const vo of documentValueObjects(model)) for (const field of vo.fields ?? []) add(field);
  return (model.enums ?? []).filter((enumDef) => names.has(enumDef.name));
}

function enumColumnsBody(enums) {
  const blocks = enums.map((enumDef) => {
    const name = enumDef.name;
    const toConstant = enumDef.values.map((value) => `            ${name}.${enumMember(value.literal)} => ${csString(value.constant)},`);
    const fromConstant = enumDef.values.map((value) => `            ${csString(value.constant)} => ${name}.${enumMember(value.literal)},`);
    return `    /// <summary>${name} → el nombre de su constante.</summary>
    public static string ${name}Constant(${name} value) =>
        value switch
        {
${toConstant.join('\n')}
            _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Valor de ${name} sin constante")
        };

    /// <summary>El nombre de una constante → ${name}. Uno que el enum no tiene es un dato que no casa con el diseño.</summary>
    public static ${name} ${name}Of(string constant) =>
        constant switch
        {
${fromConstant.join('\n')}
            _ => throw new InvalidOperationException($"Valor de enum desconocido en la base para ${name}: '{constant}'")
        };`;
  });
  return `/// <summary>
/// Cada enum se guarda por el NOMBRE de su constante (<c>ACTIVE</c>), como el @Enumerated(STRING) de keel-spring y el
/// documento de keel-nest: el miembro de C# (<c>Active</c>) y el valor del cable (<c>active</c>) son otra cosa. El mismo
/// nombre y la misma API que en la rama relacional.
/// </summary>
public static class EnumColumns
{
${blocks.join('\n\n')}
}`;
}

// ─── Índices ─────────────────────────────────────────────────────────────────────────────────────

/** Un literal C# del valor guardado de un filtro parcial (la constante de un enum, un booleano o un número). */
function filterLiteral(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return csString(String(value));
}

function documentIndexesBody(model) {
  const entries = documentIndexes(model, model.warnings).map(({ collection, specs }) => {
    const indexes = specs.map((spec) => {
      const keys = spec.paths.map((path) => `{ ${csString(path)}, 1 }`).join(', ');
      const options = [`Name = ${csString(spec.name)}`];
      if (spec.unique) options.push('Unique = true');
      if (spec.partialFilter) options.push(`PartialFilterExpression = new BsonDocument(${csString(spec.partialFilter.path)}, ${filterLiteral(spec.partialFilter.equals)})`);
      return `                new(new BsonDocument { ${keys} }, new CreateIndexOptions<BsonDocument> { ${options.join(', ')} })`;
    });
    return `            [${csString(collection)}] =\n            [\n${indexes.join(',\n')}\n            ]`;
  });
  return `/// <summary>
/// Los índices de las colecciones del servicio, derivados de persistence.keel.yaml (clave natural, campos únicos e
/// índices declarados, con su filtro parcial si el diseño los condiciona al estado) y de los almacenes del generador. Son
/// los MISMOS, con los MISMOS nombres, que crean los servidores de keel-spring y keel-nest del diseño
/// (keel-core/gen/document.js): el traductor de errores encuentra el <c>code</c> declarado buscando el nombre
/// <c>uk_*</c> en el mensaje E11000 del motor.
/// </summary>
/// <remarks>
/// Se crean al ARRANCAR y fuera de toda transacción. Crear un índice que ya existe igual no hace nada; si un índice
/// cambia de forma hay que borrarlo antes: el motor rechaza recrear el mismo nombre con otras claves, y el arranque
/// falla diciéndolo (<c>bash infra/reset-db.sh --schema</c>). Verificarlos contra los vivos: <c>bash infra/export-indexes.sh</c>.
/// </remarks>
public static class DocumentIndexes
{
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<CreateIndexModel<BsonDocument>>> ByCollection =
        new Dictionary<string, IReadOnlyList<CreateIndexModel<BsonDocument>>>(StringComparer.Ordinal)
        {
${entries.join(',\n')}
        };

    public static async Task Ensure(IMongoDatabase database, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(database);
        foreach (var (collection, indexes) in ByCollection)
        {
            await database.GetCollection<BsonDocument>(collection).Indexes.CreateManyAsync(indexes, cancellationToken);
        }
    }
}`;
}

// ─── La transacción ──────────────────────────────────────────────────────────────────────────────

function transactionsBody() {
  return `/// <summary>
/// La transacción del caso de uso sobre una sesión de MongoDB: la abre el UseCaseMediator (las consultas en solo
/// lectura) y los adaptadores de repositorio se UNEN a ella sin verla, tomando su sesión de <see cref="Session"/>. Una
/// escritura sin transacción abarcadora (un barrido despachado sin ella) abre la suya. Es lo que hace el
/// MongoTransactionManager de keel-spring.
/// </summary>
/// <remarks>
/// <para>
/// Las transacciones multidocumento solo existen sobre un replica set (infra/ lo arranca así incluso en local): es lo
/// que hace que el documento del agregado y lo que se escribe con él confirmen juntos.
/// </para>
/// <para>
/// Dos transacciones que tocan el mismo documento no se esperan: el motor aborta a la segunda con un WriteConflict
/// (código 112, etiqueta TransientTransactionError). Se arregla repitiendo la transacción ENTERA —el caso de uso otra
/// vez, que ve lo que la otra confirmó— hasta ${WRITE_CONFLICT_ATTEMPTS} intentos; agotados, es el 409 de concurrencia. No se
/// usa el WithTransaction del driver, que reintentaría durante dos minutos. Un conflicto de versión NO se repite.
/// </para>
/// </remarks>
public sealed partial class PersistenceTransactions(DocumentDatabase database, ILogger<PersistenceTransactions> logger) : IUseCaseTransactions
{
    /// <summary>Intentos de una transacción de escritura que pierde un conflicto transitorio (keel-core/gen/transactions.js).</summary>
    public const int WriteConflictAttempts = ${WRITE_CONFLICT_ATTEMPTS};

    /// <summary>Lo que espera al commit de la transacción abierta (null: no hay ninguna abierta por esta instancia).</summary>
    private List<Func<Task>>? afterCommit;

    /// <summary>La sesión de la transacción abierta por esta instancia, o null.</summary>
    public IClientSessionHandle? Session { get; private set; }

    /// <summary>Una colección de la base del servicio. Sus operaciones toman la sesión de <see cref="Session"/>.</summary>
    public IMongoCollection<BsonDocument> Collection(string name) => database.Collection(name);

    public Task<T> Run<T>(Func<Task<T>> work, bool readOnly, CancellationToken cancellationToken) => InTransaction(work, readOnly, cancellationToken);

    /// <summary>
    /// Ejecuta <paramref name="action"/> DESPUÉS de que la transacción abierta confirme (el afterCommit de Spring): un
    /// aborto la descarta. Sin transacción abierta, se ejecuta ya. Un fallo de la acción no deshace nada —el cambio ya
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
    /// defecto de Spring) o una nueva, que confirma si termina y aborta si lanza. Los fallos del motor salen ya
    /// traducidos al contrato (PersistenceErrors).
    /// </summary>
    public async Task<T> InTransaction<T>(Func<Task<T>> work, bool readOnly, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(work);
        if (Session is not null)
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
                LogRetry(attempt, error.GetType().Name);
            }
            catch (Exception error) when (PersistenceErrors.IsTransientWriteConflict(error))
            {
                throw PersistenceErrors.Translate(new WriteConflictExhaustedException(attempt, error))!;
            }
            catch (Exception error) when (PersistenceErrors.Translate(error) is { } translated)
            {
                throw translated;
            }
        }
    }

    private async Task<T> Once<T>(Func<Task<T>> work, bool readOnly, CancellationToken cancellationToken)
    {
        using var session = await database.Client.StartSessionAsync(cancellationToken: cancellationToken);
        // Una lectura también va en transacción, como el @Transactional(readOnly = true) de keel-spring sobre Mongo: todas
        // sus lecturas ven el mismo instante, y en el primario.
        session.StartTransaction(readOnly ? new TransactionOptions(readPreference: ReadPreference.Primary) : null);
        // Lo que espera al commit es de ESTE intento: uno que aborta (y se repite) no deja nada pendiente.
        var pending = new List<Func<Task>>();
        afterCommit = pending;
        Session = session;
        try
        {
            var result = await work();
            await session.CommitTransactionAsync(cancellationToken);
            Session = null;
            afterCommit = null;
            await RunAfterCommit(pending);
            return result;
        }
        catch
        {
            if (session.IsInTransaction)
            {
                try
                {
                    await session.AbortTransactionAsync(CancellationToken.None);
                }
                catch (MongoException abort)
                {
                    // El aborto que falla no tapa la causa: el servidor la descarta solo al caducar la transacción.
                    LogAbortFailed(abort);
                }
            }
            throw;
        }
        finally
        {
            Session = null;
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

    [LoggerMessage(Level = LogLevel.Warning, Message = "No se pudo abortar la transacción")]
    private partial void LogAbortFailed(Exception error);
}`;
}

// ─── Errores del motor ───────────────────────────────────────────────────────────────────────────

function errorsBody(model) {
  // En el documento no hay claves ajenas: solo unicidad.
  const entries = constraintErrors(model).filter((entry) => !entry.reference);
  const concurrency = declaredConcurrencyError(model);
  const build = (declared, message, code) => {
    if (!declared) return `new ConflictException(${csString(message)}, code: ${csString(code)}, httpStatus: 409)`;
    return declared.dynamicStatus ? `new ${declared.exceptionClass}(${csString(message)}, 409)` : `new ${declared.exceptionClass}(${csString(message)})`;
  };
  const concurrencyError = concurrency
    ? build(concurrency, CONCURRENT_MODIFICATION_MESSAGE)
    : `new ConflictException(${csString(CONCURRENT_MODIFICATION_MESSAGE)}, code: ${csString(FRAMEWORK_ERRORS.concurrency.code)}, httpStatus: 409, details: [], cause: error)`;
  const rows = entries.map((entry) => {
    const why = entry.named
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

/// <summary>Un conflicto de escritura transitorio (WriteConflict) que agotó sus reintentos: sale como 409.</summary>
public sealed class WriteConflictExhaustedException(int attempts, Exception cause)
    : Exception($"Conflicto de escritura concurrente tras {attempts} intentos", cause);

/// <summary>
/// El tope de transacción: la forma común con la rama relacional. En el modelo documental no lo produce nadie —keel-spring
/// no lo aplica en Mongo—, pero el middleware de errores lo nombra.
/// </summary>
public sealed class TransactionTimeoutException(Exception cause) : Exception(DefaultMessage, cause)
{
    public const string Code = ${csString(FRAMEWORK_ERRORS.transactionTimeout.code)};

    public const int Status = ${FRAMEWORK_ERRORS.transactionTimeout.http};

    public const string DefaultMessage = ${csString(TRANSACTION_TIMEOUT_MESSAGE)};
}

/// <summary>Una violación de unicidad que no casa con ningún índice conocido (el <c>_id</c>): 409 sin <c>code</c>, como keel-spring.</summary>
public sealed class IntegrityViolationException(Exception cause) : Exception(DefaultMessage, cause)
{
    public const string DefaultMessage = ${csString(UNKNOWN_INTEGRITY_MESSAGE)};
}

/// <summary>
/// Traduce un fallo de la persistencia al contrato. Los nombres de los índices los pone keel-core/gen/document.js y el
/// error, con su mensaje, keel-core/gen/constraint-errors.js: los tres servidores del diseño traducen la misma violación
/// al mismo error. El nombre viaja en el mensaje del motor: <c>E11000 duplicate key error collection: … index: uk_… dup key: …</c>.
/// </summary>
public static class PersistenceErrors
{
    private static readonly Dictionary<string, Func<DomainException>> ConstraintToError = new(StringComparer.Ordinal)
    {
${rows.join('\n')}
    };

    /// <summary>
    /// ¿Un conflicto de escritura transitorio? Dos transacciones que tocan el mismo documento a la vez: el motor aborta a
    /// la segunda en vez de hacerla esperar. En el reintento ve lo que la otra confirmó y falla con el error que el diseño
    /// declara, o pasa.
    /// </summary>
    public static bool IsTransientWriteConflict(Exception error)
    {
        for (Exception? cause = error; cause is not null; cause = cause.InnerException)
        {
            if (cause is MongoException mongo && mongo.HasErrorLabel("TransientTransactionError"))
            {
                return true;
            }
            if (cause is MongoCommandException { Code: 112 } || cause is MongoWriteException { WriteError.Code: 112 })
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>El mensaje del motor de una violación de unicidad (E11000) de la cadena de causas, o null.</summary>
    public static string? DuplicateKeyMessage(Exception error)
    {
        for (Exception? cause = error; cause is not null; cause = cause.InnerException)
        {
            switch (cause)
            {
                case MongoWriteException { WriteError.Category: ServerErrorCategory.DuplicateKey } write:
                    return write.WriteError.Message;
                case MongoBulkWriteException bulk when bulk.WriteErrors.FirstOrDefault(e => e.Category == ServerErrorCategory.DuplicateKey) is { } first:
                    return first.Message;
                case MongoCommandException { Code: 11000 or 11001 } command:
                    return command.ErrorMessage;
            }
        }
        return null;
    }

    /// <summary>
    /// El error del contrato de un fallo de persistencia, o null si no es de persistencia:
    /// conflicto de versión o conflicto transitorio agotado → 409 de concurrencia (el del diseño si lo declara); violación
    /// de un índice único conocido → su error; desconocido (el <c>_id</c>) → 409 sin code.
    /// </summary>
    public static Exception? Translate(Exception error)
    {
        ArgumentNullException.ThrowIfNull(error);
        if (error is OptimisticLockConflict or WriteConflictExhaustedException)
        {
            return ${concurrencyError};
        }
        if (DuplicateKeyMessage(error) is { } message)
        {
            var detail = message.ToLowerInvariant();
            foreach (var (index, build) in ConstraintToError)
            {
                // El nombre entero: uk_jobs_natural no puede casar dentro de uk_jobs_natural_x.
                var at = detail.IndexOf("index: " + index, StringComparison.Ordinal);
                if (at >= 0 && (at + 7 + index.Length == detail.Length || detail[at + 7 + index.Length] == ' '))
                {
                    return build();
                }
            }
            return new IntegrityViolationException(error);
        }
        return null;
    }
}`;
}

// ─── El registro ─────────────────────────────────────────────────────────────────────────────────

function registrationBody(model) {
  const repositories = repositoryRoots(model).map((entity) => `        services.AddScoped<${portClass(entity)}, ${adapterClass(entity)}>();`);
  // Lo mismo que la rama relacional (persistence-runtime.js): el registro de idempotencia, los defaults de los barridos y de
  // la reconciliación si nadie registró antes los del perfil, y la tienda del reclamo (aquí, un singleton: no hay contexto
  // por ámbito, y la marca no va en la sesión del caso de uso).
  const idempotency = idempotencyRegistration(model);
  if (idempotency) repositories.push(idempotency);
  if (usesSweepClaims(model)) repositories.unshift('        services.TryAddSingleton(SweepSettings.Defaults);');
  if (usesReconciliationSettings(model)) repositories.unshift('        services.TryAddSingleton(ReconciliationSettings.Defaults);');
  if (usesReconciliationClaims(model)) repositories.push('        services.AddSingleton<ReconciliationClaimStore>();');
  return `/// <summary>
/// La persistencia documental en el contenedor: el cliente del perfil (uno por proceso), la transacción del caso de uso
/// y un adaptador por puerto. El ÚNICO sitio que registra los repositorios.
/// </summary>
public static class PersistenceRegistration
{
    public static IServiceCollection AddPersistence(this IServiceCollection services, DatabaseSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        services.AddSingleton(settings);
        services.AddSingleton<DocumentDatabase>();
        services.AddScoped<PersistenceTransactions>();
        // El mediator abre la transacción de cada caso de uso con ESTA implementación.
        services.Replace(ServiceDescriptor.Scoped<IUseCaseTransactions>(provider => provider.GetRequiredService<PersistenceTransactions>()));
${AFTER_COMMIT_REGISTRATION}
${repositories.join('\n')}
        return services;
    }

    /// <summary>
    /// Conecta y crea los índices al ARRANCAR, antes de atender nada: un MongoDB inalcanzable, o un índice que ya existe
    /// con otra forma, tumban el arranque y no la primera petición.
    /// </summary>
    public static async Task InitializeDatabase(this IServiceProvider services, CancellationToken cancellationToken = default)
    {
        var settings = services.GetRequiredService<DatabaseSettings>();
        if (!settings.Enabled)
        {
            return;
        }
        var database = services.GetRequiredService<DocumentDatabase>().Database;
        await database.RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1), cancellationToken: cancellationToken);
        await DocumentIndexes.Ensure(database, cancellationToken);
    }
}`;
}
