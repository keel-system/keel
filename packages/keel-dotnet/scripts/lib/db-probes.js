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
//   página        List(pageable) con su total y el tamaño pedido; DeleteById borra el grafo;
//   plegado       la clave natural con `compare` en MAYÚSCULAS es la misma clave, y la sombra de un filtro guarda el
//                 valor plegado por TextFold sin llevar la unicidad del campo.
//
// Por sujeto, la CONCURRENCIA: un interbloqueo real entre dos transacciones se repite hasta que las dos terminan, y uno
// que agota sus intentos sale como el 409 de concurrencia.
//
// Con idempotencia de petición, el REGISTRO (idempotency_record): guardar y encontrar, el ámbito en la clave, la clave
// repetida y la CARRERA de dos transacciones como el conflicto con su code, la caducada sustituible y el rollback con el
// comando. Las mismas comprobaciones que el db-check de keel-nest.
//
// Las muestras respetan las cotas y los patrones del diseño (el texto de un patrón lo da `sampleFor`, el mismo de las
// sondas de keel-nest), y cada una es distinta: dos muestras no comparten clave natural.

import { randomUUID } from 'node:crypto';
import { constraintErrors, declaredConcurrencyError, foldedShadow, idempotencyOutcomeCode, LOCK_VERSION, persistedMembers, partialUniqueIndexes, indexName } from 'keel-core/gen';
import { registryOperations } from 'keel-core/gen/request-idempotency';
import { idempotencyNamespace, usesRequestIdempotency } from '../../src/scaffold/request-idempotency.js';
import { messagingNamespace, usesBridge, usesDotnetOutbox, usesProcessedEvents } from '../../src/scaffold/messaging.js';
import { purgeNamespace, tablePurges } from '../../src/scaffold/purge.js';
import { claimOrderField, claimsForEntity, rescueProbes, screamingSnake, snakeCase, sweepClaims, sweepConfig } from 'keel-core/gen';
import { guardClaimsFor, storedState, usesSweepClaims } from '../../src/scaffold/claim.js';
import { usesReconciliationClaims, usesReconciliationSettings } from '../../src/scaffold/reconciliation-claim.js';
import { reconciledActivations, reconciliationClaims, reconciliationParameters } from 'keel-core/gen/reconciliation-stores';
import { parametersNamespace, parametersTestInstance, usesServiceParameters } from '../../src/scaffold/service-parameters.js';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { sampleFor } from '../../../keel-nest/scripts/lib/samples.js';
import { domainMembers } from '../../src/scaffold/entities.js';
import { csLocal, csMember, csString, entityPlace, namespaceOf, solution, typeUsings } from '../../src/scaffold/render.js';
import { repositoryRoots, portClass, repositoriesNamespace, isPaginated, credentialFinders } from '../../src/scaffold/repositories.js';
import { enumMember } from '../../src/lib/cs-projection.js';
import { securityNamespace, usesHttpSecurity } from '../../src/scaffold/security.js';
import { usesCorrelation } from '../../src/scaffold/rest-support.js';
import { projectionNamespace } from '../../src/scaffold/projections.js';
import { naturalKeyBatchFinder } from '../../src/scaffold/repositories.js';
import { occurredAtField } from 'keel-core/gen/replica';
import { idBatchReason } from 'keel-core/gen/ref-targets';
import { FINDER_PROBE_TEXT, findersOf, finderTextProbes } from 'keel-core/gen/query-filters';

/**
 * Las muestras distintas que necesita cada raíz: ida y vuelta, crudo, versión, la clave natural (×2), la cota, la página
 * (×3) y dos por cada índice único condicionado. Cada prueba usa las suyas: una muestra repetida chocaría en la PK.
 */
const SAMPLES = 17;

/** El proyecto de sondas de un sujeto: su .csproj y su clase de pruebas. */
export function probeProject(model, { files = [] } = {}) {
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
  return { name, files: [{ path: `${dir}/${name}.csproj`, content: csproj }, { path: `${dir}/PersistenceProbes.cs`, content: probesCs(model, name, emittedRescues(files)) }] };
}

/**
 * Las sentencias del rescate que EMITE el arnés (`Support/FlowTest.cs`), leídas del texto emitido: el diccionario
 * `Rescues` (operación → Stall, Put, Missing) y el `IdLiteral` con el que se pega el id, como lista de piezas (un literal,
 * o `null` donde va el id). Null si no hay arnés. Leerlas de lo emitido, y no recalcularlas desde keel-core, es lo que
 * deja falsar la sentencia del arnés: con el recálculo, db-check medía la función de keel-core y no lo que ejecuta un
 * flujo.
 */
export function emittedRescues(files) {
  const flow = files.find((file) => /IntegrationTests\/Support\/FlowTest\.cs$/.test(file.path));
  if (!flow) return null;
  const literal = String.raw`"((?:[^"\\]|\\.)*)"`;
  const unescape = (text) => text.replace(/\\(.)/g, '$1');
  const rescues = new Map();
  for (const match of flow.content.matchAll(new RegExp(String.raw`\[${literal}\] = \(${literal}, ${literal}, ${literal}\),`, 'g'))) {
    rescues.set(unescape(match[1]), { stall: unescape(match[2]), put: unescape(match[3]), missing: unescape(match[4]) });
  }
  const body = /static string IdLiteral\(string id\) =>\s*Guid\.TryParseExact\(id, "D", out _\)\s*\?\s*([\s\S]*?)\s*:\s*throw/.exec(flow.content)?.[1];
  const idLiteral = body
    ? body.split(/\s*\+\s*/).map((piece) => (piece === 'id' ? null : new RegExp(`^${literal}$`).test(piece) ? unescape(piece.slice(1, -1)) : undefined))
    : null;
  return { rescues, idLiteral: idLiteral && !idLiteral.includes(undefined) ? idLiteral : null };
}

// ─── Muestras ────────────────────────────────────────────────────────────────────────────────────

/** Un contador por muestra: los enteros distintos entre elementos (una posición repetida es un empate). */
export function counter() {
  let next = 0;
  let variant = 0;
  return { int: () => next++, variant: () => variant++ };
}

/** Un literal C# de un valor de muestra para un campo (o sub-campo) del dominio; null si no se sabe muestrear. */
export function sampleValue(model, field, ctx, salt) {
  if (field.kind === 'enum') {
    const enumDef = model.enums.find((e) => e.name === field.namedType);
    ctx.usings.push(...typeUsings(model, [enumDef.name]));
    const value = enumDef.values[enumDef.values.length > 1 ? 1 : 0];
    return `${enumDef.name}.${enumMember(value.literal)}`;
  }
  if (field.kind === 'composite') {
    const vo = model.valueObjects.find((candidate) => candidate.name === field.namedType);
    // Un value object dentro de otro: build no lo mapea a columnas (deja un TODO al agente), así que no se muestrea. En
    // un documento sí: es un subdocumento dentro de otro (`ctx.document`, las sondas de doc-check).
    if (!vo || (!ctx.document && vo.fields.some((sub) => sub.kind === 'composite'))) return null;
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
        // Las variantes de sampleFor salen de UN carácter (26 valores): pasada la vigésimo sexta, la muestra se alarga para
        // que siga siendo distinta (las sondas documentales guardan más de 26 de la misma raíz, y una clave natural con
        // patrón chocaba consigo misma). Si el patrón no admite otra longitud, la variante de siempre.
        // Se alarga sobre la longitud NATURAL de la muestra (la que fija el patrón), no sobre el mínimo declarado: con
        // `{3,19}` y sin minLength, alargar «hasta 2» no cambiaba nada y la vigésimo séptima repetía la primera (lo destapó
        // catalog-extended en db-check al pasar sus muestras de Product de 26).
        const variant = ctx.counter.variant();
        const base = sampleFor(text.pattern, min, max, variant);
        const longer = variant >= 26 && base != null ? matching(text.pattern, sampleFor(text.pattern, base.length + Math.floor(variant / 26), max, variant)) : null;
        const sample = longer ?? base ?? sampleFor(text.pattern, min, max);
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

/** La muestra, si casa con el patrón (el del diseño, leído como expresión de JavaScript); si no, null. */
function matching(pattern, sample) {
  try {
    return sample != null && new RegExp(pattern).test(sample) ? sample : null;
  } catch {
    return null;
  }
}

export function listOf(model, field, ctx, salt) {
  const values = [1, 2].map((n) => sampleValue(model, { ...field, list: false }, ctx, `${salt}${n}`));
  return values.some((value) => value == null) ? '[]' : `[${values.join(', ')}]`;
}

/**
 * El estado de muestra de una entidad, como inicializador de `<Entidad>State`. Las referencias OBLIGATORIAS a otra
 * raíz son parámetros (`refs`): su FK existe en el esquema, así que apuntan a un agregado guardado de verdad. Las
 * opcionales van a null.
 */
export function sampleState(model, entity, ctx, salt, depth = 0) {
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
      // En relacional build no la mapea (TODO del agente); en un documento es un subdocumento: se muestrea si es obligatoria.
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      value = ctx.document && child && depth <= 2 ? (member.relation.required ? `new ${child.name}(${sampleState(model, child, ctx, `${salt}o`, depth + 1)})` : 'null') : 'null!';
    } else if (member.declaredLock) {
      // El lockVersion declarado: null hasta la primera escritura, como el que añade build. Con un número, el
      // adaptador tomaría la muestra por un agregado ya guardado.
      value = 'null';
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

function probesCs(model, namespace, harness = null) {
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
    // Las muestras comunes y, por encima, las de los reclamos de esta raíz: cada sonda de reclamo guarda las suyas.
    // Las muestras de la réplica, las ÚLTIMAS de su raíz: añadirlas en medio movería las de las demás sondas.
    const beforeReplica = SAMPLES + claimSampleCount(model, root) + reconciliationSampleCount(model, root) + guardSampleCount(model, root);
    // Y las de la lectura por lote por id, las últimas de todas.
    const beforeBatch = beforeReplica + (root.replicaOf ? 2 : 0);
    // Las del plegado y, en la primera raíz, las del interbloqueo: después de todas, para no mover ninguna.
    const beforeFold = beforeBatch + (idBatchReason(model, root) ? 2 : 0);
    const beforeDeadlock = beforeFold + foldSampleCount(root);
    // Las de los finders (DSL 2.22), las últimas de todas.
    const beforeFinders = beforeDeadlock + (root === roots[0] ? 2 : 0);
    const total = beforeFinders + finderSampleCount(model, root);
    for (let n = 1; n <= total; n++) states.push(sampleState(model, root, ctx, `${root.name.toLowerCase()}${n}`));
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
    const clashTest = (title, keys, entry, { both = {}, onClash = {}, samples = [4, 5], precondition = null } = {}) => {
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
${precondition ? `            ${precondition}\n` : ''}            var error = await Assert.ThrowsAnyAsync<DomainException>(() => InScope(other => other.GetRequiredService<${port}>().Save(new ${root.name}(clash), Cancel)));
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
      // El PLEGADO (`compare`): la misma clave con sus campos plegados en MAYÚSCULAS es la MISMA clave, y solo la sombra lo
      // sabe. Si el adaptador no plegara, las dos convivirían.
      const folded = foldedKeyMembers(root);
      if (folded.length > 0) {
        const upper = Object.fromEntries(folded.map((name) => [name, `first.${csMember(name)}.ToUpperInvariant()`]));
        clashTest('LaClaveNaturalEnMayusculasEsLaMismaClave', root.naturalKey, natural, {
          onClash: { ...outside, ...upper },
          samples: [beforeFold + 1, beforeFold + 2],
          precondition: folded.map((name) => `Assert.NotEqual(first.${csMember(name)}, clash.${csMember(name)});`).join(' ')
        });
      }
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
    tests.push(...filterFoldProbes(model, root, { state, first: beforeFold + 1 + (foldedKeyMembers(root).length > 0 ? 2 : 0), port, members: allNames, id }));
    if (root === roots[0]) tests.push(...deadlockProbes(model, root, { state, first: beforeDeadlock + 1, port, id, concurrency }));
    tests.push(...finderProbes(model, root, { state, first: beforeFinders + 1, port, members: allNames, id, usings: ctx.usings }));
    tests.push(...credentialProbes(model, root, { state, sample: 16, port }));
    tests.push(...authorshipProbe(model, root, {
      state,
      sample: 17,
      port,
      usings: ctx.usings,
      raw: (id) =>
        ['createdBy', 'updatedBy']
          .map((name) => `            var ${name} = await InScope(other => other.GetRequiredService<${dbContext(model)}>().Database.SqlQuery<string>($"SELECT ${snakeCase(name)} AS \\"Value\\" FROM ${root.tableName} WHERE ${root.idField?.columns?.name ?? 'id'} = {${id}}").SingleAsync(Cancel));`)
          .join('\n')
    }));
    tests.push(...replicaProbes(model, root, { state, first: beforeReplica + 1, port, usings: ctx.usings }));
    tests.push(...idBatchProbe(model, root, { state, first: beforeBatch + 1, port }));
    tests.push(...claimProbes(model, root, { state, first: SAMPLES + 1, port, context: dbContext(model), harness }));
    tests.push(...reconciliationProbes(model, root, { state, first: SAMPLES + 1 + claimSampleCount(model, root), port, context: dbContext(model) }));
    // La guarda de un efecto que no se deshace (mail.sentBy), con sus muestras por encima de las de los reclamos.
    const stateColumn = snakeCase(root.lifecycle?.field ?? 'status');
    const sql = (text) => `await InScope(other => other.GetRequiredService<${dbContext(model)}>().Database.${text})`;
    tests.push(
      ...guardProbes(model, root, {
        state,
        first: SAMPLES + 1 + claimSampleCount(model, root) + reconciliationSampleCount(model, root),
        port,
        seed: (row, stateName) => `${sql(`ExecuteSqlAsync($"UPDATE ${root.tableName} SET ${stateColumn} = '${storedState(model, root, stateName)}' WHERE id = {${row}}", Cancel)`)};`,
        stateOf: (row) => sql(`SqlQuery<string>($"SELECT ${stateColumn}::text AS \\"Value\\" FROM ${root.tableName} WHERE id = {${row}}").SingleAsync(Cancel)`),
        stampOf: (row) => {
          const claim = guardClaimsFor(model, root.name).find((candidate) => candidate.stampField);
          return sql(`SqlQuery<bool>($"SELECT ${snakeCase(claim?.stampField ?? 'id')} IS NOT NULL AS \\"Value\\" FROM ${root.tableName} WHERE id = {${row}}").SingleAsync(Cancel)`);
        }
      })
    );
    blocks.push(`    // ─── ${root.name} ───\n\n${tests.join('\n\n')}`);
  }

  if (usesRequestIdempotency(model)) blocks.push(idempotencyBlock(model));
  if (usesDotnetOutbox(model)) blocks.push(outboxBlock(model));
  if (usesProcessedEvents(model)) blocks.push(guardBlock());
  if (usesReconciliationClaims(model)) blocks.push(reconciliationStoreBlock(model));
  const purges = tablePurges(model);
  if (purges.length > 0) blocks.push(purgeBlock(model, purges));

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
    ...(purges.length > 0 ? [purgeNamespace(model), namespaceOf(model, 'rows'), 'Microsoft.Extensions.Logging.Abstractions'] : []),
    ...(usesServiceParameters(model) ? [parametersNamespace(model)] : []),
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
        services.AddLogging();${usesSweepClaims(model) ? `
        // Los barridos con lotes de DOS: con tres filas, dos pasadas. AddPersistence no pisa estos (TryAdd).
        services.AddSingleton(${probeSweepSettings(model)});` : ''}${usesReconciliationSettings(model) ? `
        // Los barridos de reconciliación con lotes de DOS (con tres candidatos, dos pasadas); AddPersistence no los pisa.
        services.AddSingleton(${probeReconciliationSettings(model)});` : ''}${usesServiceParameters(model) ? `
        services.AddSingleton(${parametersTestInstance(model)});` : ''}
        services.AddPersistence(new DatabaseSettings(true, target.ConnectionString, TimeSpan.FromSeconds(30), SchemaMode.Create));${usesBridge(model) ? `
        // Los adaptadores de las raíces que emiten eventos los entregan al puente (incremento 9).
        services.AddDomainEvents(MessagingSettings.Defaults);` : ''}${usesDotnetOutbox(model) ? `
        services.AddSingleton<OutboxRelayStore>();` : ''}${usesProcessedEvents(model) ? `
        services.AddSingleton<IdempotencyGuard>();` : ''}${purges.length > 0 ? `
        // Las purgas con lotes de DOS: con cinco filas caducadas, varios lotes por pasada.
        services.AddSingleton(${purgeSettings(purges, 2, 50)});
        services.AddSingleton<TablePurges>();` : ''}
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

/** Los campos de la clave natural que declaran `compare` (su unicidad va sobre la sombra plegada), si son texto. */
function foldedKeyMembers(root) {
  return (root.naturalKey ?? []).filter((key) => {
    const field = root.fields.find((candidate) => candidate.name === key);
    return field?.fold && field.kind === 'base';
  });
}

/** Los campos de texto con la sombra de un FILTRO (`filterFold`): la sombra se estampa, pero no lleva la unicidad. */
function filterFoldFields(root) {
  return root.fields.filter((field) => field.filterFold && !field.fold && field.kind === 'base');
}

/** Las muestras del plegado de una raíz: dos para la clave natural plegada y dos por cada sombra de filtro. */
function foldSampleCount(root) {
  return (foldedKeyMembers(root).length > 0 ? 2 : 0) + 2 * filterFoldFields(root).length;
}

/**
 * La sombra de un FILTRO contra el motor: el adaptador guarda en ella el valor plegado por TextFold —el mismo que
 * estampan keel-spring y keel-nest—, y la sombra NO lleva la unicidad del campo: el mismo nombre en mayúsculas convive.
 * Un TextFold que no plegara (o que no quitara los acentos) dejaría la sombra con otro valor y el filtro sin casar.
 */
function filterFoldProbes(model, root, { state, first, port, members, id }) {
  return filterFoldFields(root).map((field, index) => {
    const { column, accents } = foldedShadow(field);
    // NFD descompone la Ñ y las vocales acentuadas (la marca se quita); Æ y Ø no se descomponen: solo bajan.
    const expected = accents ? 'nandu ærø portatil' : 'ñandú ærø portátil';
    const build = (source, value) =>
      members.map((name) => `${csMember(name)} = ${name === field.name ? csString(value) : `${source}.${csMember(name)}`},`).join('\n                ');
    const [a, b] = [first + index * 2, first + index * 2 + 1];
    return `    [Fact]
    public async Task ${root.name}_${csMember(field.name)}LaSombraDelFiltroGuardaElValorPlegadoYNoEsUnica() =>
        await InScope(async services =>
        {
            var one = ${state(a)};
            var two = ${state(b)};
            var named = new ${root.name}State
            {
                ${build('one', 'Ñandú Ærø Portátil')}
            };
            await InScope(other => other.GetRequiredService<${port}>().Save(new ${root.name}(named), Cancel));
            var shadow = await InScope(other => other.GetRequiredService<${dbContext(model)}>().Database.SqlQuery<string>($"SELECT ${column} AS \\"Value\\" FROM ${root.tableName} WHERE ${root.idField?.columns?.name ?? 'id'} = {named.${id}}").SingleAsync(Cancel));
            Assert.Equal(${csString(expected)}, shadow);
            var twin = new ${root.name}State
            {
                ${build('two', 'ÑANDÚ ÆRØ PORTÁTIL')}
            };
            // Sin unicidad: el mismo nombre en mayúsculas convive (la sombra del filtro no es la clave del campo).
            await InScope(other => other.GetRequiredService<${port}>().Save(new ${root.name}(twin), Cancel));
        });`;
  });
}

/**
 * El INTERBLOQUEO, de verdad y contra el motor: dos ámbitos, cada uno con su PersistenceTransactions, bloquean dos filas
 * en orden inverso; el motor aborta a uno (40P01) y la transacción lo tiene que repetir ENTERA hasta que las dos
 * terminan —tres intentos en total—. Y uno que agota sus intentos sale como el 409 de concurrencia, no como un 500.
 * Con un clasificador equivocado el interbloqueo no se reintenta nunca, y nada más lo dice.
 */
function deadlockProbes(model, root, { state, first, port, id, concurrency }) {
  const idColumn = root.idField?.columns?.name ?? 'id';
  const lock = (variable) => `await db.Database.SqlQuery<Guid>($"SELECT ${idColumn} AS \\"Value\\" FROM ${root.tableName} WHERE ${idColumn} = {${variable}} FOR UPDATE").ToListAsync(Cancel);`;
  return [
    `    [Fact]
    public async Task Concurrencia_ElInterbloqueoSeRepiteHastaQueLasDosTransaccionesTerminan()
    {
        var a = new ${root.name}(${state(first)});
        var b = new ${root.name}(${state(first + 1)});
        await InScope(other => other.GetRequiredService<${port}>().Save(a, Cancel));
        await InScope(other => other.GetRequiredService<${port}>().Save(b, Cancel));
        var attempts = 0;
        async Task Cross(Guid firstId, Guid secondId)
        {
            await using var scope = root.CreateAsyncScope();
            var transactions = scope.ServiceProvider.GetRequiredService<PersistenceTransactions>();
            var db = scope.ServiceProvider.GetRequiredService<${dbContext(model)}>();
            await transactions.InTransaction(
                async () =>
                {
                    Interlocked.Increment(ref attempts);
                    ${lock('firstId')}
                    await Task.Delay(400, Cancel);
                    ${lock('secondId')}
                    return true;
                },
                readOnly: false,
                Cancel);
        }
        // T1 toma a y luego b; T2, b y luego a. El motor aborta a una, y su transacción se repite tras el commit de la otra.
        await Task.WhenAll(Cross(a.${id}, b.${id}), Cross(b.${id}, a.${id}));
        Assert.Equal(3, attempts);
    }`,
    `    [Fact]
    public async Task Concurrencia_ElInterbloqueoAgotadoEsElConflictoDeConcurrencia() =>
        await InScope(async services =>
        {
            var transactions = services.GetRequiredService<PersistenceTransactions>();
            var attempts = 0;
            var error = await Assert.ThrowsAnyAsync<DomainException>(() => transactions.InTransaction<bool>(
                () =>
                {
                    attempts++;
                    throw new PostgresException("deadlock detected", "ERROR", "ERROR", PostgresErrorCodes.DeadlockDetected);
                },
                readOnly: false,
                Cancel));
            Assert.Equal(PersistenceTransactions.WriteConflictAttempts, attempts);
            Assert.Equal(${csString(concurrency)}, error.Code);
            Assert.Equal(409, error.HttpStatus);
        });`
  ];
}

/**
 * El finder por credencial (resolvedBy, 12e): el agregado se resuelve por CUALQUIERA de sus credenciales —también la que
 * no es la primera— y una credencial ajena no resuelve nada. Lo comparten db-check y doc-check: solo usa el puerto.
 */
/**
 * La AUTORÍA de política (`persistence.audit.authorship: all`, incremento 13h) contra la base real: quien crea queda en
 * created_by y no cambia al reescribir; quien escribe la última vez, en updated_by. El actor es el de AuditActor: con
 * seguridad, el `sub` del token que abre la sonda; sin ella, el sistema con la correlación (o sin ella). `raw` lee los dos
 * valores crudos de la fila o del documento (`createdBy`, `updatedBy`). Lo usan db-check y doc-check.
 */
export function authorshipProbe(model, root, { state, sample, port, raw, usings }) {
  if (root.auditAuthorship !== 'all') return [];
  const security = usesHttpSecurity(model);
  const correlation = usesCorrelation(model);
  usings.push(namespaceOf(model, 'persistence'));
  if (security) usings.push(securityNamespace(model), 'System.Text.Json');
  else if (correlation) usings.push(namespaceOf(model, 'correlation'));
  const writer = security
    ? 'SecurityContext.Open(new Principal(PrincipalKind.Token, "nombre-" + who, new HashSet<string>(), new Dictionary<string, JsonElement> { ["sub"] = JsonSerializer.SerializeToElement(who) }))'
    : correlation
      ? 'CorrelationContext.Open(who)'
      : 'new MemoryStream()';
  const expected = security ? 'who' : correlation ? 'AuditActor.System + ":" + who' : 'AuditActor.System';
  const id = csMember(root.idField?.name ?? 'id');
  return [`    [Fact]
    public async Task ${root.name}_CreatedByEsDeQuienCreaYUpdatedByDelUltimoQueEscribe() =>
        await InScope(async services =>
        {
            static IDisposable Writer(string who) => ${writer};
            static string Expected(string who) => ${expected};
            var sample = new ${root.name}(${state(sample)});
            using (Writer("autor-que-crea"))
            {
                await InScope(other => other.GetRequiredService<${port}>().Save(sample, Cancel));
            }
            var read = await InScope(other => other.GetRequiredService<${port}>().FindById(sample.${id}, Cancel));
            Assert.NotNull(read);
            using (Writer("autor-que-modifica"))
            {
                await InScope(other => other.GetRequiredService<${port}>().Save(read, Cancel));
            }
${raw(`sample.${id}`)}
            Assert.Equal(Expected("autor-que-crea"), createdBy);
            Assert.Equal(Expected("autor-que-modifica"), updatedBy);
        });`];
}

/**
 * La RÉPLICA (`needs` replicado, 13j) contra la base real: el proyector crea la copia, deja sin efecto un hecho del mismo
 * instante y aplica uno más nuevo; la copia se guarda en su PROPIA transacción (sobrevive a la de quien la escribe, que se
 * revierte); y el lector lee por lote. Lo usa db-check (doc-check, si una réplica es documental).
 */
/**
 * La lectura POR LOTE por id (keel-core/gen/ref-targets.js: los embebidos de una página, o la query que recibe la lista de
 * ids): FindAllById trae los que existen, en UNA consulta, y un id que no existe no aparece. Lo usan db-check y doc-check.
 */
// ─── Los finders de las búsquedas (DSL 2.22) ─────────────────────────────────────────────────────

/** Dos muestras por finder: la que cumple su `where` y la que no. */
export function finderSampleCount(model, root) {
  return findersOf(model, root.name).length * 2;
}

// El texto de la sonda y lo que lo encuentra o no: el vocabulario de keel-core/gen/query-filters.js, el mismo que mide
// keel-nest. Lleva `%`, `_` y `.`: si el adaptador no tratara el buscado como LITERAL, los de fuera lo encontrarían.
const FINDER_TEXT = FINDER_PROBE_TEXT;

/**
 * El FINDER de cada búsqueda contra el motor: una fila que cumple su `where`, releída tras guardarla (la precisión con
 * que el motor guarda un instante no es la de la muestra), y por cada criterio dos llamadas, una que la encuentra y otra
 * que no — los extremos de gte/lte incluidos, los de gt/lt fuera, y el texto como literal. Otra fila que no cumple el
 * `where` no sale nunca. Solo habla con el puerto: vale para los dos modelos de persistencia.
 */
export function finderProbes(model, root, { state, first, port, members, id, usings }) {
  const finders = findersOf(model, root.name);
  if (finders.length > 0) usings.push(repositoriesNamespace(model));
  return finders.map((finder, index) => {
    const [a, b] = [first + index * 2, first + index * 2 + 1];
    const textCriteria = finder.criteria.filter((criterion) => criterion.match !== 'exact' && (criterion.target.field.textMaxLength ?? Infinity) > FINDER_TEXT.length);
    const enumOf = (field) => model.enums.find((candidate) => candidate.name === field.namedType);
    const fixedLiteral = (entry) =>
      entry.field.kind === 'enum' ? `${enumOf(entry.field).name}.${enumMember(entry.value)}` : typeof entry.value === 'string' ? csString(entry.value) : String(entry.value);
    const otherThan = (field, expr) =>
      field.kind === 'enum' ? `Enum.GetValues<${enumOf(field).name}>().First(value => value != ${expr})` : field.base === 'boolean' ? `!${expr}` : `${expr} + "-otro"`;
    // La fila de fuera lleva otro texto: si el campo es único (una clave natural), el mismo chocaría al guardarla.
    const overrides = (extra, text = FINDER_TEXT) => Object.fromEntries([...textCriteria.map((criterion) => [criterion.target.field.name, csString(text)]), ...extra]);
    const build = (source, values) => members.map((name) => `${csMember(name)} = ${values[name] ?? `${source}.${csMember(name)}`},`).join('\n                ');
    const inside = overrides(finder.fixed.map((entry) => [entry.name, fixedLiteral(entry)]));
    const outside = overrides(finder.fixed.map((entry) => [entry.name, otherThan(entry.field, fixedLiteral(entry))]), `${FINDER_TEXT}2`);

    // El valor guardado de lo que restringe un criterio, leído de la fila releída.
    const stored = (criterion) => {
      const { target } = criterion;
      if (target.kind === 'relation') return `s.${csMember(`${target.relation.name}Id`)}`;
      if (target.kind === 'vo') return `s.${csMember(target.field.name)}${target.field.required ? '' : '!'}.${csMember(target.sub.name)}`;
      return `s.${csMember(target.field.name)}`;
    };
    const base = (criterion) => (criterion.target.kind === 'vo' ? criterion.target.sub : criterion.target.field)?.base;
    const shift = (criterion, value, sign) => {
      const kind = base(criterion);
      if (kind === 'timestamp' || kind === 'date') return `${value}.AddDays(${sign})`;
      return `${value} ${sign > 0 ? '+' : '-'} 1${kind === 'decimal' ? 'm' : ''}`;
    };
    // Cada criterio: el valor que encuentra la fila y los que no. Los demás filtros, a null (o al que encuentra si es obligatorio).
    const locals = [];
    const cases = finder.criteria.map((criterion, position) => {
      const local = `v${position}`;
      if (criterion.match !== 'exact') {
        if (!textCriteria.includes(criterion)) return null;
        const { hit, misses } = finderTextProbes(criterion);
        return { criterion, local: null, hits: [csString(hit)], misses: misses.map((text) => csString(text)) };
      }
      const field = criterion.target.kind === 'vo' ? criterion.target.sub : criterion.target.field;
      // `?? throw` solo sobre lo que puede venir a null: sobre un Guid o un instante obligatorios no compila.
      const member = domainMembers(model, root).find((candidate) => candidate.name === (criterion.target.kind === 'relation' ? `${criterion.target.relation.name}Id` : criterion.target.field.name));
      const nullable = criterion.target.kind === 'vo' ? !field.required : Boolean(member?.type.endsWith('?'));
      locals.push(`            var ${local} = ${stored(criterion)}${nullable ? ` ?? throw new InvalidOperationException("la muestra no tiene ${criterion.target.path}")` : ''};`);
      if (criterion.target.kind === 'relation' || field?.base === 'uuid') return { criterion, local, hits: [local], misses: ['Guid.CreateVersion7()'] };
      if (criterion.op === 'eq') {
        const textual = ['string', 'text'].includes(field?.base);
        const hit = textual && criterion.compare !== 'exact' ? `${local}.ToUpperInvariant()` : local;
        return { criterion, local, hits: [hit], misses: [otherThan(field, local)] };
      }
      const plus = shift(criterion, local, 1);
      const minus = shift(criterion, local, -1);
      const table = { gte: [[local], [plus]], gt: [[minus], [local]], lte: [[local], [minus]], lt: [[plus], [local]] };
      const [hits, misses] = table[criterion.op];
      return { criterion, local, hits, misses };
    }).filter(Boolean);

    const filterOf = (probed, value) =>
      `new ${finder.filterType}(${finder.criteria
        .map((criterion, position) => (criterion === probed ? value : criterion.required ? `v${position}` : 'null'))
        .join(', ')})`;
    const call = (filter) =>
      finder.result === 'page'
        ? `(await InScope(other => other.GetRequiredService<${port}>().${csMember(finder.method)}(${filter ? `${filter}, ` : ''}new Pageable(0, 1000, []), Cancel))).Items`
        : `await InScope(other => other.GetRequiredService<${port}>().${csMember(finder.method)}(${filter ? `${filter}, ` : ''}Cancel))`;
    const finds = (filter, target) => `(${call(filter)}).Any(found => found.${id} == ${target}.${id})`;
    const noFilter = finder.criteria.length > 0 ? filterOf(null, null) : null;
    const assertions = [`            Assert.True(${finds(noFilter, 's')}, "sin filtros no encuentra la fila");`];
    for (const { criterion, hits, misses } of cases) {
      for (const hit of hits) assertions.push(`            Assert.True(${finds(filterOf(criterion, hit), 's')}, ${csString(`${criterion.name} = ${hit} no la encuentra`)});`);
      for (const miss of misses) assertions.push(`            Assert.False(${finds(filterOf(criterion, miss), 's')}, ${csString(`${criterion.name} = ${miss} la encuentra`)});`);
    }
    // El where: la fila que no lo cumple no sale. Con un filtro obligatorio, lo aislaría también ese filtro: no se afirma.
    const requiredCriteria = finder.criteria.some((criterion) => criterion.required);
    if (finder.fixed.length > 0 && !requiredCriteria) assertions.push(`            Assert.False(${finds(noFilter, 'outside')}, "la fila que no cumple el where sale");`);
    return `    [Fact]
    public async Task ${root.name}_ElFinder${csMember(finder.method)}AplicaLosFiltrosDelDiseño() =>
        await InScope(async services =>
        {
            var one = ${state(a)};
            var two = ${state(b)};
            var inside = new ${root.name}(new ${root.name}State
            {
                ${build('one', inside)}
            });
            var outside = new ${root.name}(new ${root.name}State
            {
                ${build('two', outside)}
            });
            await InScope(other => other.GetRequiredService<${port}>().Save(inside, Cancel));
            await InScope(other => other.GetRequiredService<${port}>().Save(outside, Cancel));
            var s = await InScope(other => other.GetRequiredService<${port}>().FindById(inside.${id}, Cancel)) ?? throw new InvalidOperationException("la fila guardada no se relee");
${locals.join('\n')}${locals.length > 0 ? '\n' : ''}${assertions.join('\n')}
        });`;
  });
}

export function idBatchProbe(model, root, { state, first, port }) {
  if (!idBatchReason(model, root)) return [];
  const id = csMember(root.idField?.name ?? 'id');
  return [`    [Fact]
    public async Task ${root.name}_FindAllByIdTraeLosQueExistenEnUnaConsulta() =>
        await InScope(async services =>
        {
            var first = new ${root.name}(${state(first)});
            var second = new ${root.name}(${state(first + 1)});
            await InScope(other => other.GetRequiredService<${port}>().Save(first, Cancel));
            await InScope(other => other.GetRequiredService<${port}>().Save(second, Cancel));
            var found = await InScope(other => other.GetRequiredService<${port}>().FindAllById(new[] { first.${id}, second.${id}, first.${id}, Guid.CreateVersion7() }, Cancel));
            Assert.Equal(new[] { first.${id}, second.${id} }.OrderBy(value => value), found.Select(root => root.${id}).OrderBy(value => value));
            Assert.Empty(await InScope(other => other.GetRequiredService<${port}>().FindAllById(Array.Empty<Guid>(), Cancel)));
        });`];
}

export function replicaProbes(model, root, { state, first, port, usings }) {
  const replica = (model.dependencies ?? []).flatMap((dependency) => dependency.needs ?? []).find((need) => need.replica?.entityName === root.name)?.replica;
  if (!replica) return [];
  const ordering = occurredAtField(root);
  const keyField = root.fields.find((field) => field.name === replica.keyField);
  const projected = root.fields.filter((field) => !field.isId && field.name !== replica.keyField && !field.generated);
  if (!ordering || !keyField) return [];
  usings.push(projectionNamespace(model), namespaceOf(model, 'persistence'));
  const key = csMember(replica.keyField);
  const at = csMember(ordering.name);
  const snapshot = (seed) => `new ${root.name}Snapshot(${[keyField, ...projected].map((field) => `${seed}.${csMember(field.name)}`).join(', ')})`;
  const batch = naturalKeyBatchFinder(model, root);
  const byKeys = batch?.reason === 'replica-listing'
    ? `
            var reader = new ${replica.readerClass}(${['repository', ...(replica.onMiss.action === 'fetch' ? ['null!'] : [])].join(', ')});
            var read = await reader.ByKeys(new[] { snapshot.${key}, "no-replicado" }, Cancel);
            Assert.Equal(new[] { snapshot.${key} }, read.Keys);`
    : '';
  return [`    [Fact]
    public async Task ${root.name}_ElProyectorCreaIgnoraElMismoInstanteYAplicaUnoMasNuevo() =>
        await InScope(async services =>
        {
            var repository = services.GetRequiredService<${port}>();
            var seed = new ${root.name}(${state(first)});
            var snapshot = ${snapshot('seed')};
            await new ${replica.projectorClass}(repository).Apply(snapshot, Cancel);
            var created = await InScope(other => other.GetRequiredService<${port}>().FindBy${key}(snapshot.${key}, Cancel));
            Assert.NotNull(created);
            Assert.Equal(snapshot.${at}, created.${at});
            // El mismo instante (una reentrega) no pisa nada; uno anterior, tampoco.
            await new ${replica.projectorClass}(repository).Apply(snapshot with { ${at} = snapshot.${at} }, Cancel);
            await new ${replica.projectorClass}(repository).Apply(snapshot with { ${at} = snapshot.${at}.AddMinutes(-5) }, Cancel);
            Assert.Equal(snapshot.${at}, (await InScope(other => other.GetRequiredService<${port}>().FindBy${key}(snapshot.${key}, Cancel)))!.${at});
            // Uno más nuevo, sí.
            await new ${replica.projectorClass}(repository).Apply(snapshot with { ${at} = snapshot.${at}.AddMinutes(5) }, Cancel);
            var updated = await InScope(other => other.GetRequiredService<${port}>().FindBy${key}(snapshot.${key}, Cancel));
            Assert.Equal(snapshot.${at}.AddMinutes(5), updated!.${at});
            Assert.Equal(created.Id, updated.Id);${byKeys}
        });

    [Fact]
    public async Task ${root.name}_LaCopiaSeGuardaEnSuPropiaTransaccionYSobreviveALaQueSeRevierte()
    {
        var snapshot = await InScope(async services =>
        {
            var seed = new ${root.name}(${state(first + 1)});
            await Task.CompletedTask;
            return ${snapshot('seed')};
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() => InScope(services => services.GetRequiredService<PersistenceTransactions>().InTransaction<bool>(
            async () =>
            {
                await new ${replica.projectorClass}(services.GetRequiredService<${port}>()).Apply(snapshot, Cancel);
                throw new InvalidOperationException("quien escribe la copia revierte la suya");
            },
            readOnly: false,
            Cancel)));
        Assert.NotNull(await InScope(other => other.GetRequiredService<${port}>().FindBy${key}(snapshot.${key}, Cancel)));
    }`];
}

export function credentialProbes(model, root, { state, sample, port }) {
  const id = csMember(root.idField?.name ?? 'id');
  return credentialFinders(model, root).map(
    (credential) => `    [Fact]
    public async Task ${root.name}_${credential.name}_ResuelvePorCualquierCredencialYUnaAjenaNoResuelve() =>
        await InScope(async services =>
        {
            var sample = new ${root.name}(${state(sample)});
            Assert.True(sample.${csMember(credential.field.name)}.Count >= 2, "la muestra necesita dos credenciales");
            await services.GetRequiredService<${port}>().Save(sample, Cancel);
            // La SEGUNDA: buscar solo la primera (o por la clave natural) resolvería una sola.
            var found = await InScope(other => other.GetRequiredService<${port}>().${credential.name}(sample.${csMember(credential.field.name)}[1], Cancel));
            Assert.NotNull(found);
            Assert.Equal(sample.${id}, found.${id});
            Assert.Null(await InScope(other => other.GetRequiredService<${port}>().${credential.name}("ajena-" + Guid.NewGuid().ToString("N"), Cancel)));
        });`
  );
}

/**
 * Las sondas del registro de idempotencia, sobre el puerto y la transacción generados. El ámbito es el de la primera
 * operación que lo usa: así el code que se afirma es el que esa operación declara (o el canónico).
 */
export function idempotencyBlock(model) {
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

export function guardBlock() {
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

// ─── Las purgas por lotes (incremento 10b) ────────────────────────────────────────────────────────

/** Unas PurgeSettings con el lote y el tope indicados y el cron y la retención de los defaults. */
export function purgeSettings(purges, batchSize, maxBatches) {
  const schedules = purges.map(
    (purge) => `new PurgeSchedule(${csString(purge.cron.default)}, ${purge.retentionDays ? purge.retentionDays.default : 'null'}, ${batchSize}, ${maxBatches})`
  );
  return `new PurgeSettings(${schedules.join(', ')})`;
}

/**
 * Cómo se siembra cada tabla para su purga: una fila por instante con la marca de la sonda, y qué instante está
 * caducado y cuál vigente con la retención de los defaults (7 días el outbox, 14 los procesados; el registro de
 * idempotencia, por su propia caducidad).
 */
const PURGE_SEEDS = {
  Outbox: {
    // Lo vigente se creó también hace 30 días: cortar por created_at en vez de published_at se lo llevaría.
    row: (at) =>
      `new OutboxEventRow { Id = Guid.CreateVersion7(), Destination = "probe.events", RoutingKey = "probe.k", EventType = marker, Payload = "{}", CreatedAt = now.AddDays(-30), PublishedAt = ${at}, Attempts = 1 }`,
    expired: (i) => `now.AddDays(-20).AddSeconds(${i})`,
    live: 'now.AddDays(-1)',
    count: (context) => `other.GetRequiredService<${context}>().Set<OutboxEventRow>().CountAsync(r => r.EventType == marker, Cancel)`
  },
  ProcessedEvent: {
    row: (at) => `new ProcessedEventRow { HandlerId = marker, EventId = Guid.NewGuid().ToString(), ProcessedAt = ${at} }`,
    expired: (i) => `now.AddDays(-30).AddSeconds(${i})`,
    live: 'now.AddDays(-1)',
    count: (context) => `other.GetRequiredService<${context}>().Set<ProcessedEventRow>().CountAsync(r => r.HandlerId == marker, Cancel)`
  },
  // La marca del reclamo de reconciliación: 7 días de retención, como en keel-nest.
  ReconciliationClaim: {
    row: (at) => `new ReconciliationClaimRow { Activation = marker, EntityId = Guid.NewGuid(), ClaimedAt = ${at} }`,
    expired: (i) => `now.AddDays(-30).AddSeconds(${i})`,
    live: 'now.AddDays(-1)',
    count: (context) => `other.GetRequiredService<${context}>().Set<ReconciliationClaimRow>().CountAsync(r => r.Activation == marker, Cancel)`
  },
  IdempotencyRecord: {
    row: (at) =>
      `new IdempotencyRecordRow { OperationScope = marker, IdempotencyKey = Guid.NewGuid().ToString(), Signature = "probe", CreatedAt = now.AddDays(-2), ExpiresAt = ${at} }`,
    expired: (i) => `now.AddDays(-1).AddSeconds(${i})`,
    live: 'now.AddDays(1)',
    count: (context) => `other.GetRequiredService<${context}>().Set<IdempotencyRecordRow>().CountAsync(r => r.OperationScope == marker, Cancel)`
  }
};

function purgeBlock(model, purges) {
  const context = dbContext(model);
  const tests = purges.map((purge) => {
    const seed = PURGE_SEEDS[purge.key];
    // Cinco caducadas, dos de ellas con el MISMO instante (caen en el mismo lote), y una vigente.
    const expired = [0, 0, 1, 2, 3].map((i) => seed.row(seed.expired(i)));
    const pending =
      purge.key === 'Outbox'
        ? `
            // Pendiente desde hace 30 días: no se purga nunca, por vieja que sea.
            db.Add(new OutboxEventRow { Id = Guid.CreateVersion7(), Destination = "probe.events", RoutingKey = "probe.k", EventType = marker, Payload = "{}", CreatedAt = now.AddDays(-30), Attempts = 0 });`
        : '';
    const survivors = purge.key === 'Outbox' ? 2 : 1;
    return `    [Fact]
    public async Task Purga_${purge.key}_PorLotesSeLlevaLoCaducadoConInstantesRepetidosYDejaLoVigente()
    {
        var marker = "purge-" + Guid.NewGuid().ToString("N")[..12];
        var now = TruncatedNow();
        await InScope(async other =>
        {
            var db = other.GetRequiredService<${context}>();
${expired.map((row) => `            db.Add(${row});`).join('\n')}
            db.Add(${seed.row(seed.live)});${pending}
            return await db.SaveChangesAsync(Cancel);
        });
        var deleted = await root.GetRequiredService<TablePurges>().${purge.method}(now, Cancel);
        Assert.Equal(5, deleted);
        Assert.Equal(${survivors}, await InScope(other => ${seed.count(context)}));
        // La pasada siguiente no encuentra nada más que purgar.
        Assert.Equal(0, await root.GetRequiredService<TablePurges>().${purge.method}(now, Cancel));
    }`;
  });
  // El tope, sobre la primera purga: un lote por pasada deja el resto para la siguiente.
  const first = purges[0];
  const seed = PURGE_SEEDS[first.key];
  tests.push(`    [Fact]
    public async Task Purga_AlLlegarAlTopeAvisaYLaPasadaSiguienteSigue()
    {
        var marker = "purge-" + Guid.NewGuid().ToString("N")[..12];
        var now = TruncatedNow();
        await InScope(async other =>
        {
            var db = other.GetRequiredService<${context}>();
${[0, 1, 2, 3, 4].map((i) => `            db.Add(${seed.row(seed.expired(i))});`).join('\n')}
            return await db.SaveChangesAsync(Cancel);
        });
        var capped = new TablePurges(root.GetRequiredService<IServiceScopeFactory>(), ${purgeSettings(purges, 2, 1)}, root.GetRequiredService<DatabaseSettings>(), NullLogger<TablePurges>.Instance);
        Assert.Equal(2, await capped.${first.method}(now, Cancel));
        Assert.Equal(3, await InScope(other => ${seed.count(context)}));
        Assert.Equal(3, await root.GetRequiredService<TablePurges>().${first.method}(now, Cancel));
        Assert.Equal(0, await InScope(other => ${seed.count(context)}));
    }

    /// <summary>Ahora, a segundos enteros: el motor guarda microsegundos y la comparación de instantes tiene que ser exacta.</summary>
    private static DateTimeOffset TruncatedNow()
    {
        var now = DateTimeOffset.UtcNow;
        return new DateTimeOffset(now.Year, now.Month, now.Day, now.Hour, now.Minute, now.Second, TimeSpan.Zero);
    }`);
  return `    // ─── Las purgas por lotes ───

${tests.join('\n\n')}`;
}

// ─── Los reclamos de barrido (incremento 10c) ─────────────────────────────────────────────────────

/** Cuántas muestras propias necesitan los reclamos de una raíz: cada sonda guarda las suyas, que no se reutilizan. */
export function claimSampleCount(model, root) {
  return claimsForEntity(model, root.name).reduce((total, claim) => total + (claim.stalled ? 5 : 9), 0);
}

/** Las SweepSettings de las sondas: lotes de DOS (con tres filas, dos pasadas) y los plazos de los defaults. */
export function probeSweepSettings(model) {
  const config = sweepConfig(model);
  const entries = (kind, value) =>
    config.flatMap(({ key, entries: list }) => list.filter((entry) => entry.kind === kind).map((entry) => `[${csString(key)}] = ${value(entry)}`));
  return `new SweepSettings(new Dictionary<string, int>(StringComparer.Ordinal) { ${entries('batch', () => 2).join(', ')} }, new Dictionary<string, int>(StringComparer.Ordinal) { ${entries('stalled', (entry) => entry.default).join(', ')} })`;
}

/**
 * Las sondas de los reclamos de una raíz. `state(n)` es la muestra n (las de los reclamos van por encima de las
 * comunes, a partir de `first`); `repo` y `port`, el puerto en el ámbito de la sonda.
 */
function claimProbes(model, root, { state, first, port, context, harness }) {
  const claims = claimsForEntity(model, root.name);
  if (claims.length === 0) return [];
  const enumDef = model.enums.find((candidate) => candidate.name === root.lifecycle.enumType);
  const constant = (state) => screamingSnake(state);
  const table = root.tableName;
  const stateColumn = snakeCase(root.lifecycle.field);
  const id = csMember(root.idField?.name ?? 'id');
  const touched = new Set(claims.flatMap((claim) => [...claim.from, ...(claim.stalled ? [claim.stalled.state] : [])]));
  // El aparcamiento: un estado que ningún reclamo mira. Ahí van las filas que otras sondas dejaron en un estado de partida.
  const park = enumDef.values.map((value) => value.literal).find((literal) => !touched.has(literal));
  let next = first;
  const take = (count) => Array.from({ length: count }, () => next++);
  const tests = [];
  const parkSql = (states) => `UPDATE ${table} SET ${stateColumn} = '${constant(park)}' WHERE ${stateColumn} IN (${states.map((s) => `'${constant(s)}'`).join(', ')})`;
  // Guarda las muestras y las deja en `stateName` con `column` = el instante de cada una (o sin tocar el reloj).
  const seed = (samples, stateName, column, at) => `            var ids = new List<Guid>();
            var instants = new List<DateTimeOffset>();
${samples
  .map(
    (n, i) => `            var sample${i} = new ${root.name}(${state(n)});
            await InScope(other => other.GetRequiredService<${port}>().Save(sample${i}, Cancel));
            ids.Add(sample${i}.${id});
            instants.Add(${at(i)});`
  )
  .join('\n')}
            for (var i = 0; i < ids.Count; i++)
            {
                var row = ids[i];
                var instant = instants[i];
                await InScope(other => other.GetRequiredService<${context}>().Database.ExecuteSqlAsync($"UPDATE ${table} SET ${stateColumn} = '${constant(stateName)}'${column ? `, ${column} = {instant}` : ''} WHERE id = {row}", Cancel));
            }`;
  const stateOf = `            async Task<string> StateOf(Guid row) => await InScope(other => other.GetRequiredService<${context}>().Database.SqlQuery<string>($"SELECT ${stateColumn}::text AS \\"Value\\" FROM ${table} WHERE id = {row}").SingleAsync(Cancel));`;
  const claimVia = (method) => `InScope(other => other.GetRequiredService<${port}>().${method}(Cancel))`;

  for (const claim of claims) {
    const method = csMember(claim.method);
    if (claim.stalled) {
      const clock = snakeCase(claim.stalled.stampField);
      const [stale1, stale2, fresh] = take(3);
      tests.push(`    [Fact]
    public async Task Rescate_${method}_SoloLoAbandonadoYLoArriendaSinCambiarElEstado() =>
        await InScope(async services =>
        {
            await InScope(other => other.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync(${csString(parkSql([claim.stalled.state]))}, Cancel));
            var now = DateTimeOffset.UtcNow;
${seed([stale1, stale2, fresh], claim.stalled.state, clock, (i) => (i < 2 ? `now.AddDays(-10).AddSeconds(${i})` : 'now'))}
${stateOf}
            var rescued = await ${claimVia(method)};
            // Solo los abandonados, el más atascado primero; el recién entrado en vuelo no se toca.
            Assert.Equal(ids.Take(2), rescued.Select(r => r.${id}));
            foreach (var row in ids)
            {
                Assert.Equal(${csString(constant(claim.stalled.state))}, await StateOf(row));
            }
            var clocks = await InScope(other => other.GetRequiredService<${context}>().Database.SqlQuery<DateTimeOffset>($"SELECT ${clock} AS \\"Value\\" FROM ${table} WHERE id = {ids[2]}").SingleAsync(Cancel));
            Assert.True(Math.Abs((clocks - now).TotalSeconds) < 1, "el fresco conserva su reloj");
            var renewed = await InScope(other => other.GetRequiredService<${context}>().Database.SqlQuery<DateTimeOffset>($"SELECT ${clock} AS \\"Value\\" FROM ${table} WHERE id = {ids[0]}").SingleAsync(Cancel));
            Assert.True(renewed >= now.AddSeconds(-1), "el rescatado lleva el reloj renovado: está arrendado");
            // Arrendado: la pasada siguiente no vuelve a llevárselo.
            Assert.Empty(await ${claimVia(method)});
        });`);
      const rescue = rescueProbes(model).find((probe) => probe.operation === sweepClaims(model).find((entry) => entry.claim === claim)?.operation.name);
      if (rescue) {
        const [stalled, put] = take(2);
        // Las sentencias TAL COMO LAS EMITE el arnés (Support/FlowTest.cs), no recalculadas desde keel-core: si no, una
        // sentencia rota en el arnés no la veía nadie (las celdas harness-db-probes y harness-sql-literals de la matriz).
        const emitted = harness?.rescues.get(rescue.operation);
        if (!emitted || !harness.idLiteral) {
          tests.push(`    [Fact]
    public void Rescate_${method}_ElArnesEmiteSusSentencias() =>
        Assert.Fail(${csString(`el arnés emitido no trae ${emitted ? 'IdLiteral' : `el rescate de ${rescue.operation}`} en Support/FlowTest.cs`)});`);
          continue;
        }
        const { stall, put: fresh, missing } = emitted;
        const idSql = (variable) => harness.idLiteral.map((piece) => (piece === null ? `${variable}.${id}` : csString(piece))).join(' + ');
        tests.push(`    [Fact]
    public async Task Rescate_${method}_LasSentenciasDelArnesFabricanSuPrecondicion() =>
        await InScope(async services =>
        {
            await InScope(other => other.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync(${csString(parkSql([claim.stalled.state]))}, Cancel));
            var stalled = new ${root.name}(${state(stalled)});
            var put = new ${root.name}(${state(put)});
            await InScope(other => other.GetRequiredService<${port}>().Save(stalled, Cancel));
            await InScope(other => other.GetRequiredService<${port}>().Save(put, Cancel));
            // Las sentencias que StallInFlight y PutInFlight del arnés EMITIDO ejecutan, montadas como las monta su
            // IdLiteral (el id es un Guid, no texto de fuera).
            var stallSql = ${csString(stall)} + ${idSql('stalled')};
            var putSql = ${csString(fresh)} + ${idSql('put')};
            await InScope(other => other.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync(stallSql, Cancel));
            await InScope(other => other.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync(putSql, Cancel));
            // Y la de InFlightWithoutClock, emitida: ninguna fila en vuelo sin reloj.
            Assert.Equal(0L, await InScope(other => other.GetRequiredService<${context}>().Database.SqlQueryRaw<long>(${csString(`SELECT (${missing}) AS "Value"`)}).SingleAsync(Cancel)));
            Assert.Equal([stalled.${id}], (await ${claimVia(method)}).Select(r => r.${id}));
        });`);
      }
      continue;
    }
    const order = snakeCase(claimOrderField(root, claim));
    const [a, b, c] = take(3);
    const stamp = claim.stamps
      ? `
            // El reloj que vigila el rescate, estampado en el MISMO UPDATE que el cambio de estado.
            Assert.Equal(0L, await InScope(other => other.GetRequiredService<${context}>().Database.SqlQuery<long>($"SELECT COUNT(*) AS \\"Value\\" FROM ${table} WHERE id = ANY({ids.Take(2).ToArray()}) AND ${snakeCase(claim.stamps.field)} IS NULL").SingleAsync(Cancel)));`
      : '';
    tests.push(`    [Fact]
    public async Task Reclamo_${method}_SeLlevaElLoteEnOrdenAlDestinoYLaPasadaSiguienteSigue() =>
        await InScope(async services =>
        {
            await InScope(other => other.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync(${csString(parkSql(claim.from))}, Cancel));
            var origin = DateTimeOffset.UtcNow.AddHours(-1);
${seed([a, b, c], claim.from[0], order === 'id' ? null : order, (i) => `origin.AddSeconds(${i})`)}
${stateOf}
            var first = await ${claimVia(method)};
            Assert.Equal(ids.Take(2), first.Select(r => r.${id}));
            Assert.Equal(${csString(constant(claim.to))}, await StateOf(ids[0]));
            Assert.Equal(${csString(constant(claim.from[0]))}, await StateOf(ids[2]));${stamp}
            Assert.Equal([ids[2]], (await ${claimVia(method)}).Select(r => r.${id}));
            Assert.Empty(await ${claimVia(method)});
        });`);
    const race = take(4);
    tests.push(`    [Fact]
    public async Task Reclamo_${method}_DosReplicasALaVezSeRepartenElLoteSinRepetir() =>
        await InScope(async services =>
        {
            await InScope(other => other.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync(${csString(parkSql(claim.from))}, Cancel));
            var origin = DateTimeOffset.UtcNow.AddHours(-1);
${seed(race, claim.from[0], order === 'id' ? null : order, (i) => `origin.AddSeconds(${i})`)}
            var replicas = await Task.WhenAll(Task.Run(() => ${claimVia(method)}), Task.Run(() => ${claimVia(method)}));
            var taken = replicas.SelectMany(batch => batch.Select(r => r.${id})).ToList();
            Assert.Equal(taken.Count, taken.Distinct().Count());
            Assert.Equal(ids.OrderBy(row => row), taken.OrderBy(row => row));
        });`);
    const [held, free] = take(2);
    tests.push(`    [Fact]
    public async Task Reclamo_${method}_ConOtraReplicaReteniendoUnaFilaSeLlevaLasDemasSinEsperar() =>
        await InScope(async services =>
        {
            await InScope(other => other.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync(${csString(parkSql(claim.from))}, Cancel));
            var origin = DateTimeOffset.UtcNow.AddHours(-1);
${seed([held, free], claim.from[0], order === 'id' ? null : order, (i) => `origin.AddSeconds(${i})`)}
            var locked = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var holder = InScope(other => other.GetRequiredService<PersistenceTransactions>().InTransaction(async () =>
            {
                await other.GetRequiredService<${context}>().Database.ExecuteSqlAsync($"SELECT 1 FROM ${table} WHERE id = {ids[0]} FOR UPDATE", Cancel);
                locked.SetResult();
                await release.Task;
                return true;
            }, readOnly: false, Cancel));
            await locked.Task;
            try
            {
                // SKIP LOCKED: se lleva la otra al momento en vez de esperar al lock (con FOR UPDATE a secas, esperaría).
                var claimed = await ${claimVia(method)}.WaitAsync(TimeSpan.FromSeconds(5), Cancel);
                Assert.Equal([ids[1]], claimed.Select(r => r.${id}));
            }
            finally
            {
                release.SetResult();
                await holder;
            }
        });`);
  }
  const firstMethod = csMember(claims[0].method);
  tests.push(`    [Fact]
    public async Task Reclamo_${root.name}_NoCorreDentroDeOtraTransaccion() =>
        await InScope(async services =>
        {
            var error = await Assert.ThrowsAsync<InvalidOperationException>(() => services.GetRequiredService<PersistenceTransactions>().InTransaction(
                async () => await services.GetRequiredService<${port}>().${firstMethod}(Cancel),
                readOnly: false,
                Cancel));
            Assert.Contains("DispatchWithoutTransaction", error.Message, StringComparison.Ordinal);
        });`);
  return tests;
}

// ─── El reclamo de reconciliación (incremento 11c) ──────────────────────────────────────────────

const reconciliationClaimsOf = (model, root) => (usesReconciliationClaims(model) ? reconciliationClaims(model).filter((claim) => claim.entity === root.name) : []);

/** Las muestras propias de los reclamos de reconciliación de una raíz: cuatro para la pasada, dos para la caducidad y cuatro para la carrera. */
export function reconciliationSampleCount(model, root) {
  return reconciliationClaimsOf(model, root).length * 10;
}

/** Las ReconciliationSettings de las sondas: lotes de DOS, y el umbral y la caducidad de los defaults de keel-core. */
export function probeReconciliationSettings(model) {
  const entries = reconciledActivations(model).map(({ activation, sweeper }) => {
    const parameters = reconciliationParameters(activation, sweeper);
    return `[${csString(activation.name)}] = new ReconciliationWindow(${parameters.unansweredAfterSeconds.default}, ${parameters.claimTimeoutMs.default}, 2)`;
  });
  return `new ReconciliationSettings(new Dictionary<string, ReconciliationWindow>(StringComparer.Ordinal) { ${entries.join(', ')} })`;
}

/**
 * La TIENDA de la marca, sola: la regla de keel-core (reconciliationClaimReference). Sin marca se inserta; con la marca
 * viva, no; caducada (claimed_at <= la caducidad, el MISMO `<=`), se renueva; por activación; y de tres réplicas a la vez
 * sobre el mismo candidato, gana una.
 */
function reconciliationStoreBlock(model) {
  return `    // ─── La tienda del reclamo de reconciliación ───

    private static Task<bool> ClaimMark(string activation, Guid entity, DateTimeOffset now, DateTimeOffset expiredBefore) =>
        InScope(other => other.GetRequiredService<ReconciliationClaimStore>().Claim(activation, entity, now, expiredBefore, Cancel));

    [Fact]
    public async Task Reconciliacion_LaMarcaSeInsertaRespetaLaVivaYRenuevaLaCaducada()
    {
        var activation = "probe-" + Guid.NewGuid().ToString("N")[..12];
        var entity = Guid.NewGuid();
        var now = TruncatedNow();
        Assert.True(await ClaimMark(activation, entity, now, now.AddMinutes(-5)), "sin marca, la inserción es el reclamo");
        Assert.False(await ClaimMark(activation, entity, now.AddSeconds(1), now.AddMinutes(-5)), "con la marca viva, no");
        // Caducada justo en el límite: claimed_at <= la caducidad.
        Assert.True(await ClaimMark(activation, entity, now.AddSeconds(2), now), "la marca en el límite de la caducidad ya caducó");
        Assert.Equal(now.AddSeconds(2), await InScope(other => other.GetRequiredService<${dbContext(model)}>().Database
            .SqlQuery<DateTimeOffset>($"SELECT claimed_at AS \\"Value\\" FROM reconciliation_claim WHERE activation = {activation} AND entity_id = {entity}")
            .SingleAsync(Cancel)));
        // Por activación: la misma entidad esperando otro desenlace tiene su propia marca.
        Assert.True(await ClaimMark(activation + "-otra", entity, now, now.AddMinutes(-5)));
    }

    [Fact]
    public async Task Reconciliacion_TresReplicasALaVezSobreElMismoCandidatoGanaUna()
    {
        var activation = "probe-" + Guid.NewGuid().ToString("N")[..12];
        var entity = Guid.NewGuid();
        var now = TruncatedNow();
        var won = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => Task.Run(() => ClaimMark(activation, entity, now, now.AddMinutes(-5)))));
        Assert.Single(won, value => value);
    }`;
}

/**
 * El RECLAMO de reconciliación del adaptador de una raíz: los candidatos que llevan en espera más que el umbral, el que
 * más lleva primero, en lotes, con su marca; el estado intacto; la marca viva los esconde y la caducada los devuelve; y
 * dos réplicas a la vez no repiten ninguno.
 */
function reconciliationProbes(model, root, { state, first, port, context }) {
  const claims = reconciliationClaimsOf(model, root);
  if (claims.length === 0) return [];
  const table = root.tableName;
  const stateColumn = snakeCase(root.lifecycle.field);
  const id = csMember(root.idField?.name ?? 'id');
  const enumDef = model.enums.find((candidate) => candidate.name === root.lifecycle.enumType);
  const waiting = new Set(claims.flatMap((claim) => claim.states));
  const park = enumDef.values.map((value) => value.literal).find((literal) => !waiting.has(literal));
  const parkSql = (states) => `UPDATE ${table} SET ${stateColumn} = '${screamingSnake(park)}' WHERE ${stateColumn} IN (${states.map((s) => `'${screamingSnake(s)}'`).join(', ')})`;
  let next = first;
  const take = (count) => Array.from({ length: count }, () => next++);
  const tests = [];
  for (const claim of claims) {
    const method = csMember(claim.method);
    const awaiting = snakeCase(claim.awaitingField);
    const waitState = screamingSnake(claim.states[0]);
    const claimVia = `InScope(other => other.GetRequiredService<${port}>().${method}(Cancel))`;
    // Guarda las muestras y las deja en espera desde el instante de cada una.
    const seed = (samples, at) => `            var ids = new List<Guid>();
${samples
  .map(
    (n, i) => `            var sample${i} = new ${root.name}(${state(n)});
            await InScope(other => other.GetRequiredService<${port}>().Save(sample${i}, Cancel));
            ids.Add(sample${i}.${id});
            var since${i} = ${at(i)};
            await InScope(other => other.GetRequiredService<${context}>().Database.ExecuteSqlAsync($"UPDATE ${table} SET ${stateColumn} = '${waitState}', ${awaiting} = {since${i}} WHERE id = {sample${i}.${id}}", Cancel));`
  )
  .join('\n')}`;
    const park = `            await InScope(other => other.GetRequiredService<${context}>().Database.ExecuteSqlRawAsync(${csString(parkSql(claim.states))}, Cancel));`;
    const pass = take(4);
    tests.push(`    [Fact]
    public async Task Reconciliacion_${method}_SoloLoQueSuperaElUmbralEnOrdenPorLotesYSinTocarElEstado() =>
        await InScope(async services =>
        {
${park}
            var now = DateTimeOffset.UtcNow;
            // Tres que llevan horas sin desenlace (el umbral de los defaults es de ${claim.unansweredAfterSeconds} s) y uno recién encargado.
${seed(pass, (i) => (i < 3 ? `now.AddSeconds(-${claim.unansweredAfterSeconds} - 3600 + ${i})` : 'now'))}
            async Task<string> StateOf(Guid row) => await InScope(other => other.GetRequiredService<${context}>().Database.SqlQuery<string>($"SELECT ${stateColumn}::text AS \\"Value\\" FROM ${table} WHERE id = {row}").SingleAsync(Cancel));
            var first = await ${claimVia};
            Assert.Equal(ids.Take(2), first.Select(r => r.${id}));
            // El reclamo marca, no mueve: siguen esperando el desenlace.
            foreach (var row in ids)
            {
                Assert.Equal(${csString(waitState)}, await StateOf(row));
            }
            Assert.Equal(2L, await InScope(other => other.GetRequiredService<${context}>().Database.SqlQuery<long>($"SELECT COUNT(*) AS \\"Value\\" FROM reconciliation_claim WHERE activation = ${"'"}${claim.activation}${"'"} AND entity_id = ANY({ids.Take(2).ToArray()})").SingleAsync(Cancel)));
            // La pasada siguiente: el tercero; los marcados no vuelven y el recién encargado no ha superado el umbral.
            Assert.Equal([ids[2]], (await ${claimVia}).Select(r => r.${id}));
            Assert.Empty(await ${claimVia});
        });`);
    const [old1, old2] = take(2);
    tests.push(`    [Fact]
    public async Task Reconciliacion_${method}_LaMarcaCaducadaDevuelveElCandidato() =>
        await InScope(async services =>
        {
${park}
            var now = DateTimeOffset.UtcNow;
${seed([old1, old2], (i) => `now.AddSeconds(-${claim.unansweredAfterSeconds} - 3600 + ${i})`)}
            Assert.Equal(ids, (await ${claimVia}).Select(r => r.${id}));
            Assert.Empty(await ${claimVia});
            // La réplica que se los llevó murió: su marca envejece más que la caducidad (${claim.claimTimeoutMs} ms).
            var expired = DateTimeOffset.UtcNow.AddMilliseconds(-${claim.claimTimeoutMs}).AddSeconds(-1);
            await InScope(other => other.GetRequiredService<${context}>().Database.ExecuteSqlAsync($"UPDATE reconciliation_claim SET claimed_at = {expired} WHERE entity_id = {ids[0]}", Cancel));
            Assert.Equal([ids[0]], (await ${claimVia}).Select(r => r.${id}));
        });`);
    const race = take(4);
    tests.push(`    [Fact]
    public async Task Reconciliacion_${method}_DosReplicasALaVezNoRepitenCandidato() =>
        await InScope(async services =>
        {
${park}
            var now = DateTimeOffset.UtcNow;
${seed(race, (i) => `now.AddSeconds(-${claim.unansweredAfterSeconds} - 3600 + ${i})`)}
            var replicas = await Task.WhenAll(Task.Run(() => ${claimVia}), Task.Run(() => ${claimVia}));
            var taken = replicas.SelectMany(batch => batch.Select(r => r.${id})).ToList();
            Assert.NotEmpty(taken);
            Assert.Equal(taken.Count, taken.Distinct().Count());
            Assert.All(taken, row => Assert.Contains(row, ids));
        });`);
  }
  // Si la raíz no tiene reclamo de barrido, su sonda de «no corre dentro de otra transacción» va aquí.
  if (claimsForEntity(model, root.name).length === 0) {
    tests.push(`    [Fact]
    public async Task Reconciliacion_${root.name}_NoCorreDentroDeOtraTransaccion() =>
        await InScope(async services =>
        {
            var error = await Assert.ThrowsAsync<InvalidOperationException>(() => services.GetRequiredService<PersistenceTransactions>().InTransaction(
                async () => await services.GetRequiredService<${port}>().${csMember(claims[0].method)}(Cancel),
                readOnly: false,
                Cancel));
            Assert.Contains("DispatchWithoutTransaction", error.Message, StringComparison.Ordinal);
        });`);
  }
  return tests;
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


/**
 * Las sondas de la GUARDA de un efecto que no se deshace (`ClaimFor<Op>`, mail.sentBy): pasa a su estado en vuelo
 * solo desde los de partida, estampa su reloj, CONFIRMA aunque la transacción de quien la llama se deshaga (es lo que la
 * hace una guarda), y de dos a la vez gana una. Lo que cambia entre relacional y documental —cómo se siembra un estado
 * y cómo se lee el guardado— lo pone quien llama: `seed(row, estado)`, `stateOf(row)` y `stampOf(row)` son C#.
 */
export function guardProbes(model, root, { state, first, port, seed, stateOf, stampOf }) {
  const id = csMember(root.idField?.name ?? 'id');
  let next = first;
  return guardClaimsFor(model, root.name).map((claim) => {
    const method = csMember(claim.method);
    const [single, rolledBack, raced] = [next++, next++, next++];
    const to = csString(storedState(model, root, claim.to));
    const sample = (n, name) => `            var ${name} = new ${root.name}(${state(n)});
            await InScope(other => other.GetRequiredService<${port}>().Save(${name}, Cancel));
            ${seed(`${name}.${id}`, claim.from[0])}`;
    const guard = (row) => `InScope(other => other.GetRequiredService<${port}>().${method}(${row}, Cancel))`;
    return `    [Fact]
    public async Task Guarda_${method}_PasaAEnVueloConfirmadaYSoloUnaVez() =>
        await InScope(async services =>
        {
            // CONFIRMA aunque la transacción del caso de uso se deshaga: la marca tiene que existir antes del efecto externo.
${sample(rolledBack, 'rolledBack')}
            await Assert.ThrowsAsync<InvalidOperationException>(() => InScope(other => other.GetRequiredService<PersistenceTransactions>().InTransaction<bool>(async () =>
            {
                Assert.NotNull(await other.GetRequiredService<${port}>().${method}(rolledBack.${id}, Cancel));
                throw new InvalidOperationException("el caso de uso falla después de reclamar");
            }, readOnly: false, Cancel)));
            Assert.Equal(${to}, ${stateOf(`rolledBack.${id}`)});

${sample(single, 'single')}
            var claimed = await ${guard(`single.${id}`)};
            Assert.NotNull(claimed);
            Assert.Equal(single.${id}, claimed.${id});
            Assert.Equal(${to}, ${stateOf(`single.${id}`)});${claim.stampField ? `\n            Assert.True(${stampOf(`single.${id}`)}, "la guarda estampa ${claim.stampField}");` : ''}
            // Ya en vuelo: la segunda ejecución no se la lleva.
            Assert.Null(await ${guard(`single.${id}`)});

            // Dos a la vez sobre la misma fila: gana una, la otra recibe null.
${sample(raced, 'raced')}
            var both = await Task.WhenAll(${guard(`raced.${id}`)}, ${guard(`raced.${id}`)});
            Assert.Equal(1, both.Count(result => result is not null));
        });`;
  });
}

export function guardSampleCount(model, root) {
  return guardClaimsFor(model, root.name).length * 3;
}
