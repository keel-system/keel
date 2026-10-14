// Las SONDAS de `db-check`: un proyecto xUnit por sujeto, escrito a partir del modelo, que EJECUTA los adaptadores
// de repositorio y el DbContext que genera keel-dotnet contra un PostgreSQL real. Es C# de verdad compilado contra
// lo emitido, no una plantilla del proyecto generado: el agente nunca lo ve.
//
// Por raíz de agregado:
//   ida y vuelta  el adaptador guarda un agregado entero (value objects, decimales con su escala, enteros de 64
//                 bits, fechas, json, enums, listas y entidades hijas) y lo lee igual;
//   crudo         la fila guarda el enum por su CONSTANTE y el decimal con la escala de la columna;
//   versión       guardar dos veces la MISMA lectura: la segunda es el conflicto de concurrencia del contrato;
//   unicidad      otro agregado con la misma clave natural sale como el error que el diseño declara, con su mensaje;
//   cota          un texto más largo que su `maxLength` lo rechaza el MOTOR (22001);
//   página        List(pageable) con su total y el tamaño pedido; DeleteById borra el grafo.
//
// Con idempotencia de petición, el REGISTRO (idempotency_record): guardar y encontrar, el ámbito en la clave, la clave
// repetida y la CARRERA de dos transacciones como el conflicto con su code, la caducada sustituible y el rollback con el
// comando. Las mismas comprobaciones que el db-check de keel-nest.
//
// Las muestras respetan las cotas y los patrones del diseño (el texto de un patrón lo da `sampleFor`, el mismo de las
// sondas de keel-nest), y cada una es distinta: dos muestras no comparten clave natural.

import { randomUUID } from 'node:crypto';
import { constraintErrors, declaredConcurrencyError, idempotencyOutcomeCode, LOCK_VERSION, persistedMembers, partialUniqueIndexes, indexName } from 'keel-core/gen';
import { registryOperations } from 'keel-core/gen/request-idempotency';
import { idempotencyNamespace, usesRequestIdempotency } from '../../src/scaffold/request-idempotency.js';
import { messagingNamespace, usesBridge, usesDotnetOutbox, usesProcessedEvents } from '../../src/scaffold/messaging.js';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { sampleFor } from '../../../keel-nest/scripts/lib/samples.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { csLocal, csMember, csString, entityPlace, namespaceOf, solution, typeUsings } from '../../src/scaffold/render.js';
import { repositoryRoots, portClass, repositoriesNamespace, isPaginated } from '../../src/scaffold/repositories.js';
import { enumMember } from '../../src/lib/cs-projection.js';

/**
 * Las muestras distintas que necesita cada raíz: ida y vuelta, crudo, versión, la clave natural (×2), la cota, la página
 * (×3) y dos por cada índice único condicionado. Cada prueba usa las suyas: una muestra repetida chocaría en la PK.
 */
const SAMPLES = 16;

/** El proyecto de sondas de un sujeto: su .csproj y su clase de pruebas. */
export function probeProject(model) {
  const sln = solution(model);
  const name = `${sln.root}.DbProbes`;
  const dir = `tests/${name}`;
  const csproj = `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
    <ProjectReference Include="..\\..\\${sln.infrastructure.csproj.replaceAll('/', '\\')}" />
  </ItemGroup>

  <ItemGroup>
    <PackageReference Include="xunit.v3" />
  </ItemGroup>

</Project>
`;
  return { name, files: [{ path: `${dir}/${name}.csproj`, content: csproj }, { path: `${dir}/PersistenceProbes.cs`, content: probesCs(model, name) }] };
}

// ─── Muestras ────────────────────────────────────────────────────────────────────────────────────

/** Un contador por muestra: los enteros distintos entre elementos (una posición repetida es un empate). */
function counter() {
  let next = 0;
  let variant = 0;
  return { int: () => next++, variant: () => variant++ };
}

/** Un literal C# de un valor de muestra para un campo (o sub-campo) del dominio; null si no se sabe muestrear. */
function sampleValue(model, field, ctx, salt) {
  if (field.kind === 'enum') {
    const enumDef = model.enums.find((e) => e.name === field.namedType);
    ctx.usings.push(...typeUsings(model, [enumDef.name]));
    const value = enumDef.values[enumDef.values.length > 1 ? 1 : 0];
    return `${enumDef.name}.${enumMember(value.literal)}`;
  }
  if (field.kind === 'composite') {
    const vo = model.valueObjects.find((candidate) => candidate.name === field.namedType);
    // Un value object dentro de otro: build no lo mapea a columnas (deja un TODO al agente), así que no se muestrea.
    if (!vo || vo.fields.some((sub) => sub.kind === 'composite')) return null;
    ctx.usings.push(...typeUsings(model, [vo.name]));
    const args = vo.fields.map((sub) => {
      const value = sub.list ? listOf(model, sub, ctx, `${salt}a`) : sampleValue(model, sub, ctx, salt);
      return value == null ? null : `${csLocal(sub.name)}: ${value}`;
    });
    return args.some((arg) => arg == null) ? null : `new ${vo.name}(${args.join(', ')})`;
  }
  const text = field.text ?? {};
  const numeric = field.numeric ?? {};
  switch (field.base) {
    case 'uuid':
      return `Guid.Parse("${randomUUID()}")`;
    case 'int': {
      const min = numeric.min != null ? Number(numeric.min) : 7;
      const value = min + ctx.counter.int();
      return String(numeric.max != null && value > Number(numeric.max) ? min : value);
    }
    case 'long':
      return '9007199254740993L';
    case 'decimal': {
      const scale = numeric.scale ?? 2;
      let whole = numeric.min != null && Number(numeric.min) > 12 ? Math.ceil(Number(numeric.min)) : 12;
      if (numeric.max != null && whole > Number(numeric.max)) whole = Math.max(0, Math.floor(Number(numeric.max)) - 1);
      // Con ceros a la derecha a propósito: la escala es lo que se pierde por el camino.
      return `${scale > 0 ? `${whole}.${'5'.padEnd(scale, '0')}` : whole}m`;
    }
    case 'boolean':
      return 'true';
    case 'date':
      return 'new DateOnly(2026, 3, 14)';
    case 'timestamp':
      return 'new DateTimeOffset(2026, 3, 14, 9, 21, 7, 482, TimeSpan.Zero)';
    case 'json':
      ctx.usings.push('System.Text.Json');
      return `JsonDocument.Parse(${csString('{"a":[1,2.50]}')}).RootElement.Clone()`;
    default: {
      const min = text.minLength ?? 0;
      const max = text.maxLength ?? 40;
      if (text.pattern) {
        const sample = sampleFor(text.pattern, min, max, ctx.counter.variant()) ?? sampleFor(text.pattern, min, max);
        if (sample == null) {
          ctx.unsampled.push(`${field.name} (${text.pattern})`);
          return null;
        }
        return csString(sample);
      }
      const base = `${field.name}-${salt}`;
      return csString(base.length > max ? base.slice(-max) : base.padEnd(min, 'x'));
    }
  }
}

function listOf(model, field, ctx, salt) {
  const values = [1, 2].map((n) => sampleValue(model, { ...field, list: false }, ctx, `${salt}${n}`));
  return values.some((value) => value == null) ? '[]' : `[${values.join(', ')}]`;
}

/**
 * El estado de muestra de una entidad, como inicializador de `<Entidad>State`. Las referencias OBLIGATORIAS a otra
 * raíz son parámetros (`refs`): su FK existe en el esquema, así que apuntan a un agregado guardado de verdad. Las
 * opcionales van a null.
 */
function sampleState(model, entity, ctx, salt, depth = 0) {
  ctx.usings.push(namespaceOf(model, entityPlace(entity)));
  const lines = [];
  for (const member of domainMembers(model, entity)) {
    let value;
    if (member.kind === 'externalRef') {
      // Toda referencia a OTRA raíz apunta a una guardada de verdad (su FK existe), también la opcional: una clave
      // natural que la incluye con null no choca nunca (en PostgreSQL dos NULL no son iguales en un índice único).
      // La autorreferencia, a null: guardarla exigiría la raíz antes que ella misma.
      const linked = member.relation.entity !== entity.name;
      value = linked ? csLocal(`${member.relation.entity}Id`) : 'null';
      if (linked) ctx.refs.add(member.relation.entity);
    } else if (member.kind === 'relationMany') {
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      value = depth > 2 || !child ? '[]' : `[${[1, 2].map((n) => `new ${child.name}(${sampleState(model, child, ctx, `${salt}${n}`, depth + 1)})`).join(', ')}]`;
    } else if (member.kind === 'relationOne') {
      value = 'null!';
    } else if (member.field.list) {
      value = listOf(model, member.field, ctx, salt);
    } else if (member.field.isId) {
      value = member.field.base === 'uuid' || member.field.csType === 'Guid' ? `Guid.Parse("${randomUUID()}")` : csString(`id-${salt}`);
    } else {
      value = sampleValue(model, member.field, ctx, salt) ?? (member.type.endsWith('?') ? 'null' : 'default!');
    }
    lines.push(`${csMember(member.name)} = ${value},`);
  }
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) lines.push(`${csMember(LOCK_VERSION.field)} = null,`);
  return `new ${entity.name}State\n        {\n            ${lines.join('\n            ')}\n        }`;
}

// ─── Las sondas ──────────────────────────────────────────────────────────────────────────────────

/** El campo de texto acotado con el que se prueba la cota del motor: sin patrón, fuera de la clave natural. */
function boundedText(entity) {
  return entity.fields.find(
    (field) =>
      !field.list &&
      !field.isId &&
      field.kind !== 'composite' &&
      field.kind !== 'enum' &&
      ['string', 'file'].includes(field.base) &&
      field.columns?.length != null &&
      !field.text?.pattern &&
      !(entity.naturalKey ?? []).includes(field.name) &&
      !field.fold
  );
}

/** El primer enum escalar (obligatorio) de la raíz: el que se mira en crudo. */
function storedEnum(model, entity) {
  const field = entity.fields.find((candidate) => !candidate.list && candidate.kind === 'enum' && candidate.columns && !candidate.columns.nullable);
  if (!field) return null;
  const enumDef = model.enums.find((e) => e.name === field.namedType);
  return { field, constant: enumDef.values[enumDef.values.length > 1 ? 1 : 0].constant };
}

function probesCs(model, namespace) {
  const roots = repositoryRoots(model);
  const ctx = { usings: [], refs: new Set(), unsampled: [], counter: counter() };
  const concurrency = declaredConcurrencyError(model)?.code ?? FRAMEWORK_ERRORS.concurrency.code;
  const errors = constraintErrors(model);
  const blocks = [];
  const samples = [];
  for (const root of roots) {
    const refsBefore = new Set(ctx.refs);
    ctx.refs.clear();
    const states = [];
    for (let n = 1; n <= SAMPLES; n++) states.push(sampleState(model, root, ctx, `${root.name.toLowerCase()}${n}`));
    const refs = [...ctx.refs];
    for (const ref of refsBefore) ctx.refs.add(ref);
    const params = refs.map((ref) => `Guid ${csLocal(`${ref}Id`)}`).join(', ');
    const args = refs.map((ref) => `await Ensure${ref}(services)`).join(', ');
    states.forEach((state, index) => {
      samples.push(`    private static ${root.name}State ${root.name}State${index + 1}(${params}) =>\n        ${state};`);
    });
    const port = portClass(root);
    const id = csMember(root.idField?.name ?? 'id');
    const repo = `services.GetRequiredService<${port}>()`;
    const tests = [];
    const state = (n) => `${root.name}State${n}(${args})`;

    tests.push(`    [Fact]
    public async Task ${root.name}_IdaYVuelta() =>
        await InScope(async services =>
        {
            var sample = new ${root.name}(${state(1)});
            var saved = await ${repo}.Save(sample, Cancel);
            var read = await InScope(other => other.GetRequiredService<${port}>().FindById(sample.${id}, Cancel));
            Assert.NotNull(read);
            Assert.Equal(Normalize(sample), Normalize(read));
            Assert.Equal(Normalize(saved), Normalize(read));
        });`);

    const stored = storedEnum(model, root);
    if (stored) {
      tests.push(`    [Fact]
    public async Task ${root.name}_LaFilaGuardaElEnumPorSuConstante() =>
        await InScope(async services =>
        {
            var sample = new ${root.name}(${state(2)});
            await ${repo}.Save(sample, Cancel);
            var db = services.GetRequiredService<${dbContext(model)}>();
            var stored = await db.Database.SqlQuery<string>($"SELECT ${stored.field.columns.name}::text AS \\"Value\\" FROM ${root.tableName} WHERE ${root.idField?.columns?.name ?? 'id'} = {sample.${id}}").SingleAsync(Cancel);
            Assert.Equal(${csString(stored.constant)}, stored);
        });`);
    }

    if (root.usesOptimisticLocking) {
      tests.push(`    [Fact]
    public async Task ${root.name}_GuardarUnaLecturaObsoletaEsConflictoDeConcurrencia() =>
        await InScope(async services =>
        {
            var sample = new ${root.name}(${state(3)});
            await ${repo}.Save(sample, Cancel);
            var read = await InScope(other => other.GetRequiredService<${port}>().FindById(sample.${id}, Cancel));
            Assert.NotNull(read);
            await InScope(other => other.GetRequiredService<${port}>().Save(read, Cancel));
            var conflict = await Assert.ThrowsAnyAsync<DomainException>(() => InScope(other => other.GetRequiredService<${port}>().Save(read, Cancel)));
            Assert.Equal(${csString(concurrency)}, conflict.Code);
            Assert.Equal(409, conflict.HttpStatus);
        });`);
    }

    // Dos agregados que chocan en `keys` (los miembros de `first`; el resto, de `second`), con algunos miembros
    // forzados en los dos (`both`) o solo en el que choca (`onClash`). El choque tiene que salir como `entry`.
    const members = domainMembers(model, root);
    const allNames = [...members.map((m) => m.name), ...(root.usesOptimisticLocking && !root.declaresLockVersion ? [LOCK_VERSION.field] : [])];
    const memberOf = (key) => members.find((m) => m.name === key || m.relation?.name === key)?.name;
    const clashTest = (title, keys, entry, { both = {}, onClash = {}, samples = [4, 5] } = {}) => {
      const keyMembers = new Set(keys.map(memberOf).filter(Boolean));
      const build = (source, overrides) =>
        allNames.map((name) => `${csMember(name)} = ${overrides[name] ?? `${typeof source === 'function' ? source(name) : source}.${csMember(name)}`},`).join('\n                ');
      tests.push(`    [Fact]
    public async Task ${root.name}_${title}() =>
        await InScope(async services =>
        {
            var one = ${state(samples[0])};
            var two = ${state(samples[1])};
            var first = new ${root.name}State
            {
                ${build('one', both)}
            };
            await ${repo}.Save(new ${root.name}(first), Cancel);
            var clash = new ${root.name}State
            {
                ${build((name) => (keyMembers.has(name) ? 'first' : 'two'), { ...both, ...onClash })}
            };
            var error = await Assert.ThrowsAnyAsync<DomainException>(() => InScope(other => other.GetRequiredService<${port}>().Save(new ${root.name}(clash), Cancel)));
            Assert.Equal(${csString(entry.code)}, error.Code);
            Assert.Equal(${csString(entry.message)}, error.GivenMessage);
        });`);
    };
    // El valor de un enum, dentro o fuera de la condición de un índice condicionado.
    const enumValue = (fieldName, inside, equals) => {
      const field = root.fields.find((candidate) => candidate.name === fieldName);
      const enumDef = field?.kind === 'enum' ? model.enums.find((e) => e.name === field.namedType) : null;
      const value = enumDef?.values.find((candidate) => (candidate.literal === equals) === inside);
      return value ? `${enumDef.name}.${enumMember(value.literal)}` : null;
    };
    const conditional = partialUniqueIndexes(root).filter((index) => index.when?.field && !index.when.field.includes('.'));

    const natural = errors.find((entry) => entry.constraint === `uk_${root.tableName}_natural`);
    if (natural && (root.naturalKey ?? []).length > 0) {
      // Fuera de toda condición: si no, el choque viola también la unicidad condicionada y el motor nombra esa.
      const outside = {};
      for (const index of conditional) {
        const value = enumValue(index.when.field, false, index.when.equals);
        if (value && !root.naturalKey.includes(index.when.field)) outside[index.when.field] = value;
      }
      clashTest('LaClaveNaturalRepetidaEsElErrorDelDiseño', root.naturalKey, natural, { onClash: outside });
    }
    // La unicidad CONDICIONADA: dos en el estado de la condición con las mismas columnas.
    conditional.slice(0, 3).forEach((index, position) => {
      const entry = errors.find((candidate) => candidate.constraint === indexName(root, index));
      const inside = enumValue(index.when.field, true, index.when.equals);
      if (!entry || !inside) return;
      clashTest(`LaUnicidadCondicionada${position + 1}EsElErrorDelDiseño`, index.fields, entry, {
        both: { [index.when.field]: inside },
        samples: [10 + position * 2, 11 + position * 2]
      });
    });

    const bounded = boundedText(root);
    if (bounded) {
      tests.push(`    [Fact]
    public async Task ${root.name}_ElMotorRechazaUnTextoPorEncimaDeSuCota() =>
        await InScope(async services =>
        {
            var base_ = ${state(9)};
            var tooLong = new ${root.name}State
            {
                ${[...domainMembers(model, root).map((m) => m.name), ...(root.usesOptimisticLocking && !root.declaresLockVersion ? [LOCK_VERSION.field] : [])]
                  .map((name) => `${csMember(name)} = ${name === bounded.name ? `new string('x', ${bounded.columns.length + 1})` : `base_.${csMember(name)}`},`)
                  .join('\n                ')}
            };
            var error = await Assert.ThrowsAnyAsync<Exception>(() => ${repo}.Save(new ${root.name}(tooLong), Cancel));
            Assert.Equal("22001", PersistenceErrors.EngineError(error)?.SqlState);
        });`);
    }

    if (isPaginated(model, root)) {
      tests.push(`    [Fact]
    public async Task ${root.name}_UnaPaginaYElBorradoDelGrafo() =>
        await InScope(async services =>
        {
            var samples = new[] { new ${root.name}(${state(6)}), new ${root.name}(${state(7)}), new ${root.name}(${state(8)}) };
            foreach (var sample in samples)
            {
                await InScope(other => other.GetRequiredService<${port}>().Save(sample, Cancel));
            }
            var page = await ${repo}.List(new Pageable(0, 2, []), Cancel);
            Assert.Equal(2, page.Items.Count);
            Assert.True(page.TotalElements >= 3, $"total {page.TotalElements}");
            Assert.Equal(0, page.Number);
            await InScope(other => other.GetRequiredService<${port}>().DeleteById(samples[0].${id}, Cancel));
            Assert.Null(await InScope(other => other.GetRequiredService<${port}>().FindById(samples[0].${id}, Cancel)));
        });`);
    }
    blocks.push(`    // ─── ${root.name} ───\n\n${tests.join('\n\n')}`);
  }

  if (usesRequestIdempotency(model)) blocks.push(idempotencyBlock(model));
  if (usesDotnetOutbox(model)) blocks.push(outboxBlock(model));
  if (usesProcessedEvents(model)) blocks.push(guardBlock());

  // Las raíces a las que apunta una referencia obligatoria: se guarda UNA de cada, y su id vale para todas las sondas.
  const ensures = [];
  const ensured = new Set();
  const queue = [...ctx.refs];
  while (queue.length > 0) {
    const name = queue.shift();
    if (ensured.has(name)) continue;
    ensured.add(name);
    const target = model.entities.find((entity) => entity.name === name);
    const inner = { usings: ctx.usings, refs: new Set(), unsampled: ctx.unsampled, counter: ctx.counter };
    const stateText = sampleState(model, target, inner, `${name.toLowerCase()}ref`);
    const refs = [...inner.refs].filter((ref) => ref !== name);
    queue.push(...refs);
    const lets = refs.map((ref) => `        var ${csLocal(`${ref}Id`)} = await Ensure${ref}(services);`).join('\n');
    ensures.push(`    private static Guid? saved${name};

    private static async Task<Guid> Ensure${name}(IServiceProvider services)
    {
        if (saved${name} is { } known)
        {
            return known;
        }
${lets ? `${lets}\n` : ''}        var sample = new ${name}(${stateText});
        await InScope(other => other.GetRequiredService<${portClass(target)}>().Save(sample, Cancel));
        saved${name} = sample.${csMember(target.idField?.name ?? 'id')};
        return sample.${csMember(target.idField?.name ?? 'id')};
    }`);
  }

  const usings = [
    'System.Text.Json',
    'System.Text.Json.Nodes',
    'Microsoft.EntityFrameworkCore',
    'Microsoft.Extensions.DependencyInjection',
    'Npgsql',
    'Xunit',
    repositoriesNamespace(model),
    namespaceOf(model, 'persistence'),
    namespaceOf(model, 'errors'),
    namespaceOf(model, 'appSupport'),
    ...(usesRequestIdempotency(model) ? [idempotencyNamespace(model)] : []),
    ...(usesBridge(model) || usesProcessedEvents(model) ? [messagingNamespace(model)] : []),
    ...(usesDotnetOutbox(model) ? [namespaceOf(model, 'outbox'), namespaceOf(model, 'rows')] : []),
    ...(usesProcessedEvents(model) ? [namespaceOf(model, 'messageIdempotency')] : []),
    ...ctx.usings
  ];
  const body = `/// <summary>La base del sujeto: una propia en el motor, con el esquema que crea EF desde el modelo.</summary>
public sealed class PersistenceFixture : IAsyncLifetime
{
    public ServiceProvider Services { get; private set; } = null!;

    public async ValueTask InitializeAsync()
    {
        var admin = Environment.GetEnvironmentVariable("DB_CHECK_CONNECTION")
            ?? throw new InvalidOperationException("DB_CHECK_CONNECTION: la cadena de conexión de la base de administración");
        const string Database = ${csString(databaseOf(model))};
        await using (var connection = new NpgsqlConnection(admin))
        {
            await connection.OpenAsync();
            await using var drop = new NpgsqlCommand("DROP DATABASE IF EXISTS " + Database + " WITH (FORCE)", connection);
            await drop.ExecuteNonQueryAsync();
            // Los sujetos crean su base a la vez, y PostgreSQL no copia template1 mientras otro lo está copiando
            // (55006): se reintenta.
            for (var attempt = 1; ; attempt++)
            {
                try
                {
                    await using var create = new NpgsqlCommand("CREATE DATABASE " + Database, connection);
                    await create.ExecuteNonQueryAsync();
                    break;
                }
                catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.ObjectInUse && attempt < 20)
                {
                    await Task.Delay(250 * attempt);
                }
            }
        }
        var target = new NpgsqlConnectionStringBuilder(admin) { Database = Database };
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddPersistence(new DatabaseSettings(true, target.ConnectionString, TimeSpan.FromSeconds(30), SchemaMode.Create));${usesBridge(model) ? `
        // Los adaptadores de las raíces que emiten eventos los entregan al puente (incremento 9).
        services.AddDomainEvents(MessagingSettings.Defaults);` : ''}${usesDotnetOutbox(model) ? `
        services.AddSingleton<OutboxRelayStore>();` : ''}${usesProcessedEvents(model) ? `
        services.AddSingleton<IdempotencyGuard>();` : ''}
        Services = services.BuildServiceProvider();
        await Services.InitializeDatabase();
    }

    public async ValueTask DisposeAsync() => await Services.DisposeAsync();
}

/// <summary>Los adaptadores generados contra el motor: cada prueba, en su propio ámbito (una petición).</summary>
public sealed class PersistenceProbes : IClassFixture<PersistenceFixture>
{
    private static IServiceProvider root = null!;

    public PersistenceProbes(PersistenceFixture fixture)
    {
        ArgumentNullException.ThrowIfNull(fixture);
        root = fixture.Services;
    }

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<T> InScope<T>(Func<IServiceProvider, Task<T>> work)
    {
        await using var scope = root.CreateAsyncScope();
        return await work(scope.ServiceProvider);
    }

    private static async Task InScope(Func<IServiceProvider, Task> work)
    {
        await using var scope = root.CreateAsyncScope();
        await work(scope.ServiceProvider);
    }

${blocks.join('\n\n')}

    // ─── Muestras ───

${samples.join('\n\n')}

${ensures.join('\n\n')}

    // ─── Comparación ───

    /// <summary>Lo que pone la persistencia y no quien guarda: la versión y la última modificación.</summary>
    private static readonly HashSet<string> Ignored = new(StringComparer.Ordinal) { "lockVersion", "updatedAt", "updatedBy" };

    /// <summary>El estado observable de un agregado con el contrato del cable; las hijas sin orden propio, por id.</summary>
    private static string Normalize(object? entity) => Clean(JsonSerializer.SerializeToNode(entity, entity?.GetType() ?? typeof(object), WireJson.Options))?.ToJsonString() ?? "null";

    private static JsonNode? Clean(JsonNode? node) => node switch
    {
        JsonObject obj => new JsonObject(obj.Where(pair => !Ignored.Contains(pair.Key)).OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => KeyValuePair.Create(pair.Key, Clean(pair.Value)))),
        JsonArray array when array.All(item => item is JsonObject child && child.ContainsKey("id")) =>
            new JsonArray([.. array.OrderBy(item => item!["id"]!.ToJsonString(), StringComparer.Ordinal).Select(Clean)]),
        JsonArray array => new JsonArray([.. array.Select(Clean)]),
        _ => node?.DeepClone()
    };
}`;
  if (ctx.unsampled.length > 0) console.warn(`  (db-check) sin muestra para ${[...new Set(ctx.unsampled)].join(', ')}`);
  return csFileLike(namespace, usings, body);
}

/**
 * Las sondas del registro de idempotencia, sobre el puerto y la transacción generados. El ámbito es el de la primera
 * operación que lo usa: así el code que se afirma es el que esa operación declara (o el canónico).
 */
function idempotencyBlock(model) {
  const scope = registryOperations(model)[0].name;
  const race = idempotencyOutcomeCode(model, scope, FRAMEWORK_ERRORS.idempotencyRace);
  const store = 'other.GetRequiredService<IIdempotencyStore>()';
  return `    // ─── El registro de idempotencia ───

    private static string NewKey() => Guid.NewGuid().ToString();

    [Fact]
    public async Task Idempotencia_GuardaYEncuentraConSuFirmaYSuRecurso_YElAmbitoEsParteDeLaClave()
    {
        var key = NewKey();
        await InScope(other => ${store}.Save(${csString(scope)}, key, "firma-1", "recurso-1", 3600, Cancel));
        var found = await InScope(other => ${store}.Find(${csString(scope)}, key, Cancel));
        Assert.Equal(new StoredRequest("firma-1", "recurso-1"), found);
        // La misma clave en OTRO ámbito es otra petición.
        Assert.Null(await InScope(other => ${store}.Find(${csString(`${scope}:otro`)}, key, Cancel)));
        await InScope(other => ${store}.Save(${csString(`${scope}:otro`)}, key, "firma-2", null, 3600, Cancel));
        Assert.Equal(new StoredRequest("firma-2", null), await InScope(other => ${store}.Find(${csString(`${scope}:otro`)}, key, Cancel)));
    }

    [Fact]
    public async Task Idempotencia_LaClaveRepetidaEsElConflictoDelContrato()
    {
        var key = NewKey();
        await InScope(other => ${store}.Save(${csString(scope)}, key, "firma", "r", 3600, Cancel));
        var error = await Assert.ThrowsAsync<IdempotencyConflictException>(() => InScope(other => ${store}.Save(${csString(scope)}, key, "firma", "r", 3600, Cancel)));
        Assert.Equal(${csString(race)}, error.Code);
        Assert.Equal(409, error.HttpStatus);
    }

    [Fact]
    public async Task Idempotencia_LaCarreraDeDosTransaccionesLaGanaUnaYLaOtraEsElConflicto()
    {
        var key = NewKey();
        var claimed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        // La primera reclama la clave DENTRO de su transacción y no confirma hasta que la segunda está esperando.
        var first = InScope(other => other.GetRequiredService<PersistenceTransactions>().InTransaction(async () =>
        {
            await ${store}.Save(${csString(scope)}, key, "firma", "r1", 3600, Cancel);
            claimed.SetResult();
            await release.Task;
            return true;
        }, readOnly: false, Cancel));
        await claimed.Task;
        // La segunda no ve la fila sin confirmar: la encuentra la clave primaria, que la hace esperar y luego chocar.
        var second = InScope(other => other.GetRequiredService<PersistenceTransactions>().InTransaction(async () =>
        {
            Assert.Null(await ${store}.Find(${csString(scope)}, key, Cancel));
            await ${store}.Save(${csString(scope)}, key, "firma", "r2", 3600, Cancel);
            return true;
        }, readOnly: false, Cancel));
        await Task.Delay(500, Cancel);
        release.SetResult();
        Assert.True(await first);
        var error = await Assert.ThrowsAsync<IdempotencyConflictException>(() => second);
        Assert.Equal(${csString(race)}, error.Code);
        Assert.Equal(new StoredRequest("firma", "r1"), await InScope(other => ${store}.Find(${csString(scope)}, key, Cancel)));
    }

    [Fact]
    public async Task Idempotencia_UnaClaveCaducadaNoSeEncuentraYSePuedeVolverAUsar()
    {
        var key = NewKey();
        await InScope(other => ${store}.Save(${csString(scope)}, key, "vieja", "r1", 0, Cancel));
        Assert.Null(await InScope(other => ${store}.Find(${csString(scope)}, key, Cancel)));
        await InScope(other => ${store}.Save(${csString(scope)}, key, "nueva", "r2", 3600, Cancel));
        Assert.Equal(new StoredRequest("nueva", "r2"), await InScope(other => ${store}.Find(${csString(scope)}, key, Cancel)));
    }

    [Fact]
    public async Task Idempotencia_ElRegistroRevierteConElComando()
    {
        var key = NewKey();
        await Assert.ThrowsAsync<InvalidOperationException>(() => InScope(other => other.GetRequiredService<PersistenceTransactions>().InTransaction<bool>(async () =>
        {
            await ${store}.Save(${csString(scope)}, key, "firma", "r", 3600, Cancel);
            throw new InvalidOperationException("el comando falla después de reclamar");
        }, readOnly: false, Cancel)));
        Assert.Null(await InScope(other => ${store}.Find(${csString(scope)}, key, Cancel)));
    }`;
}

// ─── Los almacenes de la mensajería (incremento 9) ───────────────────────────────────────────────

function outboxBlock(model) {
  const context = dbContext(model);
  return `    // ─── El outbox ───

    /// <summary>
    /// Deja el outbox sin pendientes ajenas (las que escribió el puente al guardar en otras sondas) y mete las suyas: el
    /// reclamo es por orden de llegada sobre TODA la tabla.
    /// </summary>
    private static async Task<List<Guid>> SeedOutbox(int count)
    {
        var ids = new List<Guid>();
        await InScope(async other =>
        {
            var db = other.GetRequiredService<${context}>();
            await db.Database.ExecuteSqlRawAsync("UPDATE outbox_event SET published_at = now() WHERE published_at IS NULL", Cancel);
            for (var i = 0; i < count; i++)
            {
                var id = Guid.CreateVersion7();
                ids.Add(id);
                db.Set<OutboxEventRow>().Add(new OutboxEventRow
                {
                    Id = id,
                    Destination = "probe.events",
                    RoutingKey = "probe.k",
                    EventType = "Probe",
                    Payload = "{}",
                    CreatedAt = DateTimeOffset.UtcNow.AddSeconds(-60 + i),
                    Attempts = 0
                });
            }
            return await db.SaveChangesAsync(Cancel);
        });
        return ids;
    }

    private static OutboxRelayStore Relay => root.GetRequiredService<OutboxRelayStore>();

    [Fact]
    public async Task Outbox_ElReclamoEsPorOrdenDeLlegadaYElLeaseLasRetiraDeLaPasadaSiguiente()
    {
        var ids = await SeedOutbox(3);
        var first = await Relay.ClaimBatch(maxAttempts: 10, batchSize: 2, claimTimeoutMs: 60000, Cancel);
        Assert.Equal(ids.Take(2), first.Select(row => row.Id));
        // Las dos reclamadas tienen el lease puesto: la pasada siguiente solo ve la tercera.
        var second = await Relay.ClaimBatch(maxAttempts: 10, batchSize: 10, claimTimeoutMs: 60000, Cancel);
        Assert.Equal([ids[2]], second.Select(row => row.Id));
        Assert.Empty(await Relay.ClaimBatch(maxAttempts: 10, batchSize: 10, claimTimeoutMs: 60000, Cancel));
    }

    [Fact]
    public async Task Outbox_ConOtraTransaccionReteniendoUnaFilaElReclamoSeLlevaLasDemasSinEsperar()
    {
        var ids = await SeedOutbox(2);
        var locked = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        // Otra réplica a mitad de su reclamo: la primera fila bloqueada y sin confirmar.
        var holder = InScope(other => other.GetRequiredService<PersistenceTransactions>().InTransaction(async () =>
        {
            var db = other.GetRequiredService<${context}>();
            await db.Database.ExecuteSqlRawAsync("SELECT 1 FROM outbox_event WHERE id = {0} FOR UPDATE", [ids[0]], Cancel);
            locked.SetResult();
            await release.Task;
            return true;
        }, readOnly: false, Cancel));
        await locked.Task;
        try
        {
            // SKIP LOCKED: se lleva la otra al momento en vez de esperar al lock (con FOR UPDATE a secas, esperaría).
            var claimed = await Relay.ClaimBatch(maxAttempts: 10, batchSize: 10, claimTimeoutMs: 60000, Cancel).WaitAsync(TimeSpan.FromSeconds(5), Cancel);
            Assert.Equal([ids[1]], claimed.Select(row => row.Id));
        }
        finally
        {
            release.SetResult();
            await holder;
        }
    }

    [Fact]
    public async Task Outbox_UnFalloCuentaElIntentoConSuBackoffYAlAgotarseLaFilaSeRinde()
    {
        var ids = await SeedOutbox(1);
        await Relay.ClaimBatch(maxAttempts: 2, batchSize: 1, claimTimeoutMs: 60000, Cancel);
        var before = DateTimeOffset.UtcNow;
        var first = await Relay.MarkFailed(ids[0], "broker caído", maxAttempts: 2, backoffInitialMs: 60000, backoffMaxMs: 120000, Cancel);
        Assert.Equal(new MarkFailedOutcome(1, false), first);
        var row = await InScope(other => other.GetRequiredService<${context}>().Set<OutboxEventRow>().AsNoTracking().SingleAsync(r => r.Id == ids[0], Cancel));
        Assert.Equal("broker caído", row.LastError);
        Assert.True(row.NextAttemptAt >= before.AddMilliseconds(59000), "el backoff del primer fallo es el inicial");
        Assert.Equal(0, await Relay.CountDeadLettered(maxAttempts: 2, Cancel));
        Assert.Equal(new MarkFailedOutcome(2, true), await Relay.MarkFailed(ids[0], "otra vez", maxAttempts: 2, backoffInitialMs: 60000, backoffMaxMs: 120000, Cancel));
        Assert.Equal(1, await Relay.CountDeadLettered(maxAttempts: 2, Cancel));
        // Rendida: no se reclama nunca más, ni con el backoff vencido.
        await InScope(other => other.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync("UPDATE outbox_event SET next_attempt_at = NULL", Cancel));
        Assert.Empty(await Relay.ClaimBatch(maxAttempts: 2, batchSize: 10, claimTimeoutMs: 60000, Cancel));
        await InScope(other => other.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync("UPDATE outbox_event SET published_at = now() WHERE published_at IS NULL", Cancel));
    }

    [Fact]
    public async Task Outbox_LaPublicadaNoSeVuelveAReclamar()
    {
        var ids = await SeedOutbox(1);
        await Relay.ClaimBatch(maxAttempts: 10, batchSize: 1, claimTimeoutMs: 0, Cancel);
        await Relay.MarkPublished(ids[0], Cancel);
        Assert.Empty(await Relay.ClaimBatch(maxAttempts: 10, batchSize: 10, claimTimeoutMs: 60000, Cancel));
    }`;
}

function guardBlock() {
  return `    // ─── El registro de mensajes procesados ───

    private static IdempotencyGuard Guard => root.GetRequiredService<IdempotencyGuard>();

    [Fact]
    public async Task Procesados_ElRegistroSeVeYLaSegundaVezEsDuplicado_YElConsumidorEsParteDeLaClave()
    {
        var eventId = Guid.NewGuid().ToString();
        Assert.False(await Guard.AlreadyProcessed("ProbeListener", eventId, Cancel));
        Assert.True(await Guard.Record("ProbeListener", eventId, Cancel));
        Assert.True(await Guard.AlreadyProcessed("ProbeListener", eventId, Cancel));
        Assert.False(await Guard.TryRecord("ProbeListener", eventId, Cancel));
        // Otro consumidor del mismo evento no se deduplica con este.
        Assert.True(await Guard.TryRecord("OtherListener", eventId, Cancel));
    }

    [Fact]
    public async Task Procesados_DosEntregasALaVezLaGanaUna()
    {
        var eventId = Guid.NewGuid().ToString();
        var outcomes = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => Task.Run(() => Guard.Record("RaceListener", eventId, Cancel))));
        Assert.Equal(1, outcomes.Count(won => won));
    }`;
}

/** La base del sujeto en el motor: un identificador sin guiones. */
export function databaseOf(model) {
  return `probe_${model.service.name.replace(/-/g, '_')}`;
}

function dbContext(model) {
  return `${model.service.rootNamespace}DbContext`;
}

function csFileLike(namespace, usings, body) {
  const unique = [...new Set(usings)].sort((a, b) => a.localeCompare(b));
  return [`namespace ${namespace};`, '', ...unique.map((using) => `using ${using};`), '', body.trim(), ''].join('\n');
}

