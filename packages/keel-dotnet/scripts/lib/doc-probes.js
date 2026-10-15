// Las SONDAS de `doc-check`: un proyecto xUnit por sujeto documental, escrito a partir del modelo, que EJECUTA los
// adaptadores de repositorio y la transacción que genera keel-dotnet contra un MongoDB real (miembro de un replica set).
// Es C# de verdad compilado contra lo emitido, no una plantilla del proyecto generado: el agente nunca lo ve.
//
// Por raíz de agregado:
//   ida y vuelta  el adaptador guarda un agregado entero (value objects anidados, decimales con su escala, enteros de 64
//                 bits, fechas, json, enums, listas e hijas anidadas) y lo lee igual;
//   crudo         el documento CRUDO contra la forma neutral (keel-core/gen/document.js), campo a campo y a todo nivel:
//                 cada clave del contrato con su tipo BSON —uuid binario de subtipo 4, Decimal128, Int64, fechas, el día a
//                 medianoche UTC— y NINGUNA de más; el enum por su constante;
//   versión       guardar dos veces la MISMA lectura: la segunda es el conflicto de concurrencia del contrato;
//   unicidad      la clave natural repetida y el índice condicionado salen como el error que el diseño declara;
//   carrera       dos transacciones que escriben el mismo documento: la del driver es un conflicto TRANSITORIO para el
//                 clasificador, y la del adaptador, reintentada y agotada, el 409 de concurrencia (no un 500);
//   auditoría     created_at no cambia al reescribir; updated_at sí;
//   página        List(pageable) con su total, el orden pedido y una propiedad que no existe; DeleteById borra.
//
// Las muestras son las de db-check (db-probes.js), con los value objects anidados y las hijas uno-a-uno que solo existen
// en el documento.

import { constraintErrors, declaredConcurrencyError, LOCK_VERSION, partialUniqueIndexes, indexName } from 'keel-core/gen';
import { documentShape, documentValueObjects, valueObjectShape } from 'keel-core/gen/document';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { domainMembers } from '../../src/scaffold/entities.js';
import { csMember, csString, namespaceOf, solution, typeUsings } from '../../src/scaffold/render.js';
import { repositoryRoots, portClass, repositoriesNamespace, isPaginated } from '../../src/scaffold/repositories.js';
import { isNullable } from '../../src/scaffold/render.js';
import { enumMember } from '../../src/lib/cs-projection.js';
import { counter, sampleState } from './db-probes.js';

/** Las muestras distintas que necesita cada raíz (cada prueba usa las suyas: una repetida chocaría en el _id). */
const SAMPLES = 20;

/** La base de un sujeto: una propia en el servidor, con el nombre del servicio. */
export function documentDatabaseOf(model) {
  return `doc_check_${model.service.name.replace(/-/g, '_')}`;
}

export function docProbeProject(model) {
  const sln = solution(model);
  const name = `${sln.root}.DocProbes`;
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
  return { name, files: [{ path: `${dir}/${name}.csproj`, content: csproj }, { path: `${dir}/DocumentProbes.cs`, content: probesCs(model, name) }] };
}

// ─── La forma esperada, como datos ───────────────────────────────────────────────────────────────

/** La regla de un valor escalar: su tipo BSON (el día, aparte: medianoche UTC) y si admite null. */
function scalarRule(field, nullable) {
  if (field?.kind === 'enum') return { t: 'string', nullable };
  if (field?.base === 'date') return { t: 'day', nullable };
  const storage = { string: 'string', text: 'string', json: 'string', file: 'string', int: 'int', long: 'long', decimal: 'decimal128', boolean: 'bool', uuid: 'uuid', date: 'date', timestamp: 'date' }[field?.base] ?? 'string';
  return { t: storage, nullable };
}

function voRules(model, voName, seen = new Set()) {
  const vo = model.valueObjects.find((candidate) => candidate.name === voName);
  if (!vo || seen.has(voName)) return {};
  const rules = {};
  for (const entry of valueObjectShape(vo)) {
    const field = entry.field;
    if (field.list) {
      const element = entry.kind === 'subdocument' ? { t: 'doc', of: voRules(model, entry.valueObject, new Set([...seen, voName])), nullable: false } : scalarRule(field, false);
      rules[entry.name] = { t: 'array', of: element, nullable: false };
    } else if (entry.kind === 'subdocument') {
      rules[entry.name] = { t: 'doc', of: voRules(model, entry.valueObject, new Set([...seen, voName])), nullable: isNullable(field) };
    } else {
      rules[entry.name] = scalarRule(field, isNullable(field));
    }
  }
  return rules;
}

/** Las reglas del documento de una entidad: una por clave del contrato, ninguna de más. */
export function documentRules(model, entity, seen = new Set([entity.name])) {
  const rules = {};
  const child = (name) => {
    const target = model.entities.find((candidate) => candidate.name === name);
    return target && !seen.has(name) ? documentRules(model, target, new Set([...seen, name])) : {};
  };
  for (const entry of documentShape(model, entity)) {
    switch (entry.kind) {
      case 'id':
        rules[entry.name] = scalarRule(entry.field, false);
        break;
      case 'scalar':
        rules[entry.name] = scalarRule(entry.field, isNullable(entry.field));
        break;
      case 'folded':
        rules[entry.name] = { t: 'string', nullable: true };
        break;
      case 'ref':
        rules[entry.name] = { t: 'uuid', nullable: !entry.relation.required };
        break;
      case 'version':
        rules[entry.name] = { t: 'long', nullable: false };
        break;
      case 'audit':
        rules[entry.name] = { t: entry.storage, nullable: false };
        break;
      case 'subdocument':
        rules[entry.name] = entry.valueObject
          ? { t: 'doc', of: voRules(model, entry.valueObject), nullable: isNullable(entry.field) }
          : { t: 'doc', of: child(entry.entity), nullable: !entry.relation?.required };
        break;
      case 'array': {
        const element = entry.element.entity
          ? { t: 'doc', of: child(entry.element.entity), nullable: false }
          : entry.element.valueObject
            ? { t: 'doc', of: voRules(model, entry.element.valueObject), nullable: false }
            : scalarRule(entry.field, false);
        rules[entry.name] = { t: 'array', of: element, nullable: false };
        break;
      }
    }
  }
  return rules;
}

// ─── Las sondas ──────────────────────────────────────────────────────────────────────────────────

/** El primer enum escalar obligatorio de la raíz: el que se mira en crudo por su constante. */
function storedEnum(model, entity) {
  const field = entity.fields.find((candidate) => !candidate.list && candidate.kind === 'enum' && !isNullable(candidate));
  if (!field) return null;
  const enumDef = model.enums.find((e) => e.name === field.namedType);
  const key = documentShape(model, entity).find((entry) => entry.member === field.name)?.name;
  return key ? { field, key, constant: enumDef.values[enumDef.values.length > 1 ? 1 : 0].constant } : null;
}

/** Una propiedad por la que ordenar la página: la primera escalar de la raíz que no sea el id. */
function sortProperty(model, entity) {
  return documentShape(model, entity).find((entry) => entry.kind === 'scalar' && !entry.field.list)?.member ?? null;
}

function probesCs(model, namespace) {
  const roots = repositoryRoots(model);
  const ctx = { usings: [], refs: new Set(), unsampled: [], counter: counter(), document: true };
  const concurrency = declaredConcurrencyError(model)?.code ?? FRAMEWORK_ERRORS.concurrency.code;
  const errors = constraintErrors(model);
  const blocks = [];
  const samples = [];
  const shapes = [];
  for (const root of roots) {
    const refsBefore = new Set(ctx.refs);
    ctx.refs.clear();
    const states = [];
    for (let n = 1; n <= SAMPLES; n++) states.push(sampleState(model, root, ctx, `${root.name.toLowerCase()}${n}`));
    const refs = [...ctx.refs];
    for (const ref of refsBefore) ctx.refs.add(ref);
    const params = refs.map((ref) => `Guid ${ref[0].toLowerCase()}${ref.slice(1)}Id`).join(', ');
    const args = refs.map((ref) => `await Ensure${ref}(services)`).join(', ');
    states.forEach((state, index) => {
      samples.push(`    private static ${root.name}State ${root.name}State${index + 1}(${params}) =>\n        ${state};`);
    });
    const port = portClass(root);
    const id = csMember(root.idField?.name ?? 'id');
    const repo = `services.GetRequiredService<${port}>()`;
    const collection = csString(root.collectionName);
    const state = (n) => `${root.name}State${n}(${args})`;
    const idValue = (expr) => (root.idField?.base === 'uuid' || root.idField?.csType === 'Guid' ? `BsonValues.Of(${expr})` : `BsonValues.Of(${expr})`);
    const tests = [];
    shapes.push(`    private const string ${root.name}Shape = ${csString(JSON.stringify(documentRules(model, root)))};`);

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
    tests.push(`    [Fact]
    public async Task ${root.name}_ElDocumentoCrudoEsElDelContrato() =>
        await InScope(async services =>
        {
            var sample = new ${root.name}(${state(2)});
            await ${repo}.Save(sample, Cancel);
            var raw = await Raw(services, ${collection}, ${idValue(`sample.${id}`)});
            var problems = new List<string>();
            CheckShape(raw, JsonNode.Parse(${root.name}Shape)!.AsObject(), ${collection}, problems);
            Assert.True(problems.Count == 0, string.Join("; ", problems));${stored ? `
            Assert.Equal(${csString(stored.constant)}, raw[${csString(stored.key)}].AsString);` : ''}
        });`);

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

    // Dos agregados que chocan en `keys`: el segundo tiene que salir como `entry`, con su mensaje.
    const members = domainMembers(model, root);
    const allNames = [...members.map((m) => m.name), ...(root.usesOptimisticLocking && !root.declaresLockVersion ? [LOCK_VERSION.field] : [])];
    const memberOf = (key) => members.find((m) => m.name === key || m.relation?.name === key)?.name;
    const clashTest = (title, keys, entry, { both = {}, onClash = {}, samples: pair = [4, 5] } = {}) => {
      const keyMembers = new Set(keys.map(memberOf).filter(Boolean));
      const build = (source, overrides) =>
        allNames.map((name) => `${csMember(name)} = ${overrides[name] ?? `${typeof source === 'function' ? source(name) : source}.${csMember(name)}`},`).join('\n                ');
      tests.push(`    [Fact]
    public async Task ${root.name}_${title}() =>
        await InScope(async services =>
        {
            var one = ${state(pair[0])};
            var two = ${state(pair[1])};
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
    const enumValue = (fieldName, inside, equals) => {
      const field = root.fields.find((candidate) => candidate.name === fieldName);
      const enumDef = field?.kind === 'enum' ? model.enums.find((e) => e.name === field.namedType) : null;
      const value = enumDef?.values.find((candidate) => (candidate.literal === equals) === inside);
      return value ? `${enumDef.name}.${enumMember(value.literal)}` : null;
    };
    const conditional = partialUniqueIndexes(root).filter((index) => index.when?.field && !index.when.field.includes('.'));
    const natural = errors.find((entry) => entry.constraint === `uk_${root.collectionName}_natural`);
    if (natural && (root.naturalKey ?? []).length > 0) {
      const outside = {};
      for (const index of conditional) {
        const value = enumValue(index.when.field, false, index.when.equals);
        if (value && !root.naturalKey.includes(index.when.field)) outside[index.when.field] = value;
      }
      clashTest('LaClaveNaturalRepetidaEsElErrorDelDiseño', root.naturalKey, natural, { onClash: outside });
    }
    conditional.slice(0, 3).forEach((index, position) => {
      const entry = errors.find((candidate) => candidate.constraint === indexName(root, index));
      const inside = enumValue(index.when.field, true, index.when.equals);
      if (!entry || !inside) return;
      clashTest(`LaUnicidadCondicionada${position + 1}EsElErrorDelDiseño`, index.fields, entry, {
        both: { [index.when.field]: inside },
        samples: [10 + position * 2, 11 + position * 2]
      });
    });

    // La carrera: dos transacciones sobre el MISMO documento. La segunda no espera: el motor la aborta con un conflicto
    // transitorio, que el clasificador reconoce; por el adaptador, la transacción se repite, sigue chocando con la que
    // está abierta y, agotada, es el 409 de concurrencia.
    tests.push(`    [Fact]
    public async Task ${root.name}_DosTransaccionesSobreElMismoDocumentoSonUnConflictoTransitorio() =>
        await InScope(async services =>
        {
            var sample = new ${root.name}(${state(16)});
            await ${repo}.Save(sample, Cancel);
            var database = services.GetRequiredService<DocumentDatabase>();
            var documents = database.Collection(${collection});
            var filter = new BsonDocument("_id", ${idValue(`sample.${id}`)});
            using var holder = await database.Client.StartSessionAsync(cancellationToken: Cancel);
            holder.StartTransaction();
            await documents.UpdateOneAsync(holder, filter, new BsonDocument("$set", new BsonDocument("doc_check_marker", 1)), cancellationToken: Cancel);
            try
            {
                using var other = await database.Client.StartSessionAsync(cancellationToken: Cancel);
                other.StartTransaction();
                var raw = await Assert.ThrowsAnyAsync<MongoException>(() =>
                    documents.UpdateOneAsync(other, filter, new BsonDocument("$set", new BsonDocument("doc_check_marker", 2)), cancellationToken: Cancel));
                Assert.True(PersistenceErrors.IsTransientWriteConflict(raw), $"no es transitorio: {raw.GetType().Name} {raw.Message}");
                await other.AbortTransactionAsync(Cancel);
                var read = await InScope(scope => scope.GetRequiredService<${port}>().FindById(sample.${id}, Cancel));
                Assert.NotNull(read);
                var conflict = await Assert.ThrowsAnyAsync<DomainException>(() => InScope(scope => scope.GetRequiredService<${port}>().Save(read, Cancel)));
                Assert.Equal(${csString(concurrency)}, conflict.Code);
                Assert.Equal(409, conflict.HttpStatus);
            }
            finally
            {
                await holder.AbortTransactionAsync(Cancel);
            }
        });`);

    const audited = documentShape(model, root).some((entry) => entry.name === 'created_at');
    const updated = documentShape(model, root).some((entry) => entry.name === 'updated_at');
    if (audited) {
      tests.push(`    [Fact]
    public async Task ${root.name}_ReescribirNoCambiaCreatedAt${updated ? 'YSiUpdatedAt' : ''}() =>
        await InScope(async services =>
        {
            var sample = new ${root.name}(${state(17)});
            await ${repo}.Save(sample, Cancel);
            var before = await Raw(services, ${collection}, ${idValue(`sample.${id}`)});
            await Task.Delay(20, Cancel);
            var read = await InScope(other => other.GetRequiredService<${port}>().FindById(sample.${id}, Cancel));
            Assert.NotNull(read);
            await InScope(other => other.GetRequiredService<${port}>().Save(read, Cancel));
            var after = await Raw(services, ${collection}, ${idValue(`sample.${id}`)});
            Assert.Equal(before["created_at"], after["created_at"]);${updated ? `
            Assert.True(after["updated_at"].ToUniversalTime() > before["updated_at"].ToUniversalTime(), "updated_at no avanzó");` : ''}
        });`);
    }

    if (isPaginated(model, root)) {
      const property = sortProperty(model, root);
      tests.push(`    [Fact]
    public async Task ${root.name}_UnaPaginaOrdenadaYElBorrado() =>
        await InScope(async services =>
        {
            var samples = new[] { new ${root.name}(${state(6)}), new ${root.name}(${state(7)}), new ${root.name}(${state(8)}) };
            foreach (var sample in samples)
            {
                await InScope(other => other.GetRequiredService<${port}>().Save(sample, Cancel));
            }
            var page = await ${repo}.List(new Pageable(0, 2, ${property ? `[new SortOrder(${csString(property)}, ${repositoriesNamespace(model)}.SortDirection.Desc)]` : '[]'}), Cancel);
            Assert.Equal(2, page.Items.Count);
            Assert.True(page.TotalElements >= 3, $"total {page.TotalElements}");
            Assert.Equal(0, page.Number);
            var unknown = await Assert.ThrowsAnyAsync<InvalidOperationException>(() => InScope(other => other.GetRequiredService<${port}>().List(new Pageable(0, 2, [new SortOrder("doesNotExist", ${repositoriesNamespace(model)}.SortDirection.Asc)]), Cancel)));
            Assert.Contains("doesNotExist", unknown.Message, StringComparison.Ordinal);
            await InScope(other => other.GetRequiredService<${port}>().DeleteById(samples[0].${id}, Cancel));
            Assert.Null(await InScope(other => other.GetRequiredService<${port}>().FindById(samples[0].${id}, Cancel)));
        });`);
    }
    blocks.push(`    // ─── ${root.name} ───\n\n${tests.join('\n\n')}`);
  }

  // Las raíces a las que apunta una referencia: se guarda UNA de cada, y su id vale para todas las sondas.
  const ensures = [];
  const ensured = new Set();
  const queue = [...ctx.refs];
  while (queue.length > 0) {
    const name = queue.shift();
    if (ensured.has(name)) continue;
    ensured.add(name);
    const target = model.entities.find((entity) => entity.name === name);
    const inner = { ...ctx, refs: new Set() };
    const stateText = sampleState(model, target, inner, `${name.toLowerCase()}ref`);
    const refs = [...inner.refs].filter((ref) => ref !== name);
    queue.push(...refs);
    const lets = refs.map((ref) => `        var ${ref[0].toLowerCase()}${ref.slice(1)}Id = await Ensure${ref}(services);`).join('\n');
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
    'Microsoft.Extensions.DependencyInjection',
    'MongoDB.Bson',
    'MongoDB.Driver',
    'Xunit',
    repositoriesNamespace(model),
    namespaceOf(model, 'persistence'),
    namespaceOf(model, 'errors'),
    namespaceOf(model, 'appSupport'),
    ...typeUsings(model, roots.map((root) => root.name)),
    ...ctx.usings
  ];
  const body = `/// <summary>La base del sujeto: una propia en el servidor, vacía al empezar; los índices los crea el arranque.</summary>
public sealed class DocumentFixture : IAsyncLifetime
{
    public ServiceProvider Services { get; private set; } = null!;

    public async ValueTask InitializeAsync()
    {
        // La URL con la forma de la de keel-spring (con uuidRepresentation=standard): la misma DB_URL sirve a los tres.
        var url = Environment.GetEnvironmentVariable("DOC_CHECK_URL")
            ?? throw new InvalidOperationException("DOC_CHECK_URL: la URI del MongoDB de la sonda, con {database} en la ruta");
        const string Database = ${csString(documentDatabaseOf(model))};
        var target = url.Replace("{database}", Database, StringComparison.Ordinal);
        using (var admin = new MongoClient(target))
        {
            await admin.DropDatabaseAsync(Database);
        }
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddPersistence(new DatabaseSettings(true, MongoUrl.Create(target), Database, "doc-check"));
        Services = services.BuildServiceProvider();
        // Dos veces: crear los índices sobre una base que ya los tiene no puede fallar (es lo que pasa en cada arranque).
        await Services.InitializeDatabase();
        await Services.InitializeDatabase();
    }

    public async ValueTask DisposeAsync() => await Services.DisposeAsync();
}

/// <summary>Los adaptadores generados contra el motor: cada prueba, en su propio ámbito (una petición).</summary>
public sealed class DocumentProbes : IClassFixture<DocumentFixture>
{
    private static IServiceProvider root = null!;

    public DocumentProbes(DocumentFixture fixture)
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

    /// <summary>El documento tal como quedó en la base, sin pasar por el adaptador.</summary>
    private static async Task<BsonDocument> Raw(IServiceProvider services, string collection, BsonValue id) =>
        await services.GetRequiredService<DocumentDatabase>().Collection(collection).Find(new BsonDocument("_id", id)).SingleAsync(Cancel);

${blocks.join('\n\n')}

    // ─── La forma del contrato (keel-core/gen/document.js) ───

${shapes.join('\n')}

    private static void CheckShape(BsonDocument document, JsonObject rules, string at, List<string> problems)
    {
        foreach (var element in document)
        {
            if (!rules.ContainsKey(element.Name))
            {
                problems.Add($"{at}.{element.Name}: sobra (el contrato no la tiene)");
            }
        }
        foreach (var (key, rule) in rules)
        {
            if (!document.Contains(key))
            {
                problems.Add($"{at}.{key}: falta");
                continue;
            }
            CheckValue(document[key], rule!.AsObject(), $"{at}.{key}", problems);
        }
    }

    private static void CheckValue(BsonValue value, JsonObject rule, string at, List<string> problems)
    {
        var type = (string)rule["t"]!;
        if (value.IsBsonNull)
        {
            if (!(bool)rule["nullable"]!)
            {
                problems.Add($"{at}: null y el contrato no lo admite");
            }
            return;
        }
        var ok = type switch
        {
            "uuid" => value is BsonBinaryData { SubType: BsonBinarySubType.UuidStandard },
            "string" => value is BsonString,
            "int" => value is BsonInt32,
            "long" => value is BsonInt64,
            "decimal128" => value is BsonDecimal128,
            "bool" => value is BsonBoolean,
            "date" => value is BsonDateTime,
            "day" => value is BsonDateTime day && day.MillisecondsSinceEpoch % 86_400_000 == 0,
            "doc" => value is BsonDocument,
            "array" => value is BsonArray,
            _ => false
        };
        if (!ok)
        {
            problems.Add($"{at}: guarda {value.BsonType} ({value}) y el contrato pide {type}");
            return;
        }
        if (type == "doc")
        {
            CheckShape(value.AsBsonDocument, rule["of"]!.AsObject(), at, problems);
        }
        else if (type == "array")
        {
            var index = 0;
            foreach (var element in value.AsBsonArray)
            {
                CheckValue(element, rule["of"]!.AsObject(), $"{at}[{index++}]", problems);
            }
        }
    }

    // ─── Muestras ───

${samples.join('\n\n')}

${ensures.join('\n\n')}

    // ─── Comparación ───

    /// <summary>Lo que pone la persistencia y no quien guarda: la versión y la última modificación.</summary>
    private static readonly HashSet<string> Ignored = new(StringComparer.Ordinal) { "lockVersion", "updatedAt", "updatedBy" };

    /// <summary>
    /// El estado observable de un agregado con el contrato del cable; las hijas sin orden propio, por id. Un instante,
    /// truncado al milisegundo: es la precisión de la fecha BSON, la misma en los tres servidores.
    /// </summary>
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
  if (ctx.unsampled.length > 0) console.warn(`  (doc-check) sin muestra para ${[...new Set(ctx.unsampled)].join(', ')}`);
  return `namespace ${namespace};\n\n${[...new Set(usings)].sort().map((u) => `using ${u};`).join('\n')}\n\n${body}\n`;
}
