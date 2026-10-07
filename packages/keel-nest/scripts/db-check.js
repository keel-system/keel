#!/usr/bin/env node
// La persistencia de keel-nest contra un MOTOR REAL: lo único que juzga si lo emitido sostiene lo que
// el diseño pidió. `ts-check` dice que compila; esto dice que el esquema que TypeORM crea es el del
// diseño y que el adaptador guarda y lee sin perder nada.
//
// Por motor (PostgreSQL y MySQL, en contenedor) y por sujeto (fixtures que cubren las formas del
// esquema: value objects aplanados, decimales con escala, enums, listas de escalares y de value
// objects, hijas uni y bidireccionales, sombras plegadas, claves naturales, bloqueo optimista):
//
//   esquema      el catálogo del motor (information_schema) contra keel-core/gen/relational.js:
//                cada columna con su nulabilidad, su cota de texto, su precisión y escala, y su
//                collation donde se fuerza; cada constraint única, índice y FK con SU NOMBRE, que es
//                lo que lee el traductor de errores;
//   cota         una escritura más larga que el `maxLength` del diseño la rechaza el MOTOR;
//   ida y vuelta el adaptador generado guarda un agregado entero y lo vuelve a leer igual (decimales
//                con su escala, enteros de 64 bits, uuid, fechas, enums por su constante, el orden de
//                las listas y de las hijas);
//   versión      guardar dos veces la MISMA lectura: la segunda es un conflicto de concurrencia;
//   unicidad     un segundo agregado con la misma clave natural sale como el error que el diseño
//                declara para ella (translatePersistenceError);
//   página       list(pageable) con su total; deleteById borra el grafo;
//   mensajería   el puente escribe el outbox en la transacción del cambio; el reclamo del relay (orden,
//                lote, lease, SKIP LOCKED), el backoff y la rendición; el registro de procesados (la
//                repetición, la transacción propia y la carrera). Lo que en keel-spring mide store-check.
//
//   node packages/keel-nest/scripts/db-check.js [--database=postgresql|mysql] [--keep]
//   npm run db-check --workspace packages/keel-nest
//
// Necesita podman o docker, y red la primera vez (npm instala TypeORM y los drivers).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadService } from 'keel-core';
import { DATABASES } from 'keel-core/gen/infra-catalog';
import { partialIndexSpecs, discriminatorColumn, orderingFieldOf, persistedMembers, uniqueConstraints, crossAggregateForeignKeys, elementTable, foreignKeyIndexColumns, foreignKeyIndexName, indexName, collectionIndexesOf, columnsFor, foreignKeyName, joinColumnOf, usesAuditableEntity, AUDIT_COLUMNS, LOCK_VERSION } from 'keel-core/gen';
import { planService } from '../src/scaffold/index.js';
import { DB_NAME, run, resolveRuntime, startDatabase } from './lib/database-container.js';
import { makeWorkspace, mountDesign, runCommand, FIXTURES_DIR, NEST_READY_DESIGN } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { AMQPLIB_VERSION, JOSE_VERSION } from '../src/lib/assets.js';
import { domainMembers } from '../src/scaffold/entities.js';
import { classPath, entityDir, DIRS } from '../src/scaffold/render.js';
import { repositoryRoots, adapterPath, adapterClass, naturalKeyFinder, occupantFinders, emitsDomainEvents } from '../src/scaffold/repositories.js';
import { claimsForEntity, claimOrderField, screamingSnake, rescueProbes, stallSql, missingClockCountSql } from 'keel-core/gen';
import { ormPath, ormClass, unidirectionalParents } from '../src/scaffold/persistence-entities.js';
import { usesRequestIdempotency, IDEMPOTENCY_STORE_IMPL_TS, IDEMPOTENCY_CONFLICT_TS } from '../src/scaffold/request-idempotency.js';
import { IDEMPOTENCY_RECORD } from 'keel-core/gen/request-idempotency';
import { OUTBOX_EVENT, PROCESSED_EVENT } from 'keel-core/gen/messaging-stores';
import { TABLE_PURGES_TS, tablePurges } from '../src/scaffold/purge.js';
import { IDEMPOTENCY_RECORD_ORM_TS } from '../src/scaffold/request-idempotency.js';
import {
  usesNestOutbox,
  usesProcessedEvents,
  bridgeClass,
  bridgePath,
  MESSAGING_SETTINGS_TS,
  OUTBOX_ORM_TS,
  PROCESSED_EVENT_ORM_TS,
  OUTBOX_RELAY_STORE_TS,
  IDEMPOTENCY_GUARD_TS
} from '../src/scaffold/messaging.js';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { effectiveErrorCode } from 'keel-core/gen';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const only = args.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? null;
const ENGINES = (only ? [only] : ['postgresql', 'mysql']).filter((engine) => DATABASES[engine]);
// Las formas del esquema que cubre cada sujeto (ver la cabecera).
const SUBJECTS = ['product-catalog', 'job-dispatch', 'job-dispatch-cycles', 'payout-runs', 'notification-mailer', 'catalog-extended'];
const results = [];

function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

// ─── Muestras ────────────────────────────────────────────────────────────────

/**
 * Un texto que casa con un patrón del diseño, para las formas habituales (literales, clases,
 * \d \w \s, cuantificadores, grupos con alternativas). Se comprueba al final: si no casa, null.
 */
function sampleFor(pattern, minLength = 0, maxLength = null, variant = 0) {
  const upper = String.fromCharCode(65 + (variant % 26));
  const lower = String.fromCharCode(97 + (variant % 26));
  const digit = String((7 + variant) % 10);
  const source = String(pattern).replace(/^\^/, '').replace(/\$$/, '');
  let index = 0;
  const pickClass = (body) => {
    const negated = body.startsWith('^');
    const content = negated ? body.slice(1) : body;
    if (negated) {
      for (const candidate of 'abcxyz019') if (!new RegExp(`[${body}]`).test(candidate) === false) return candidate;
      return 'a';
    }
    if (/^\\d/.test(content) || /0-9/.test(content)) return content.includes('A-Z') ? upper : content.includes('a-z') ? lower : digit;
    if (content.includes('A-Z')) return upper;
    if (content.includes('a-z')) return lower;
    const plain = content.replace(/\\./g, '').replace(/.-./g, '');
    return plain[0] ?? 'a';
  };
  const atom = () => {
    const char = source[index];
    if (char === '(') {
      let depth = 1;
      let end = index + 1;
      while (end < source.length && depth > 0) {
        if (source[end] === '\\') end += 1;
        else if (source[end] === '(') depth += 1;
        else if (source[end] === ')') depth -= 1;
        end += 1;
      }
      let inner = source.slice(index + 1, end - 1).replace(/^\?:/, '');
      inner = splitTop(inner)[0];
      index = end;
      return { text: sampleFor(inner) ?? '' };
    }
    if (char === '[') {
      let end = index + 1;
      while (end < source.length && source[end] !== ']') end += source[end] === '\\' ? 2 : 1;
      const body = source.slice(index + 1, end);
      index = end + 1;
      return { text: pickClass(body) };
    }
    if (char === '\\') {
      const next = source[index + 1];
      index += 2;
      return { text: next === 'd' ? digit : next === 'w' ? lower : next === 's' ? ' ' : next };
    }
    if (char === '.') {
      index += 1;
      return { text: 'a' };
    }
    index += 1;
    return { text: char };
  };
  const parts = [];
  if (splitTop(source).length > 1) return sampleFor(splitTop(source)[0], minLength, maxLength);
  while (index < source.length) {
    const { text } = atom();
    let times = 1;
    const quant = source[index];
    if (quant === '{') {
      const end = source.indexOf('}', index);
      const [min] = source.slice(index + 1, end).split(',');
      times = Math.max(Number(min) || 0, 1);
      index = end + 1;
    } else if (quant === '+') {
      index += 1;
    } else if (quant === '*' || quant === '?') {
      times = 0;
      index += 1;
    }
    parts.push(text.repeat(times));
  }
  let sample = parts.join('');
  while (sample.length < minLength) sample += sample.slice(-1) || 'a';
  if (maxLength != null && sample.length > maxLength) sample = sample.slice(0, maxLength);
  try {
    return new RegExp(`^(?:${pattern})$`).test(sample) ? sample : null;
  } catch {
    return null;
  }
}

function splitTop(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') {
      current += char + (text[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (char === '|' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

let nextInt = 0;
let nextVariant = 0;

/** La expresión JS de un valor de muestra para un campo (o sub-campo) del dominio. */
function sampleValue(model, field, ctx, salt) {
  if (field.kind === 'enum') {
    const enumDef = model.enums.find((e) => e.name === field.namedType);
    ctx.imports.add(`${field.namedType}|${classPath(DIRS.enums, field.namedType)}`);
    const value = enumDef.values[enumDef.values.length > 1 ? 1 : 0];
    return `${field.namedType}.${value.constant}`;
  }
  if (field.kind === 'composite') {
    const vo = model.valueObjects.find((candidate) => candidate.name === field.namedType);
    if (!vo || vo.fields.some((sub) => sub.kind === 'composite')) return null;
    ctx.imports.add(`${vo.name}|${classPath(DIRS.valueObjects, vo.name)}`);
    const args = vo.fields.map((sub) => (sub.list ? `[${sampleValue(model, sub, ctx, `${salt}a`)}]` : sampleValue(model, sub, ctx, salt)));
    if (args.some((arg) => arg == null || arg === '[null]')) return null;
    return `new ${vo.name}(${args.join(', ')})`;
  }
  const text = field.text ?? {};
  const numeric = field.numeric ?? {};
  switch (field.base) {
    case 'uuid':
      return `'${randomUUID()}'`;
    case 'int':
      // Distintos entre elementos: una posición repetida es un empate, y entonces el orden es del motor.
      return String((numeric.min != null ? Number(numeric.min) : 7) + nextInt++);
    case 'long':
      return '9007199254740993n';
    case 'decimal': {
      const scale = numeric.scale ?? 2;
      ctx.imports.add(`Decimal|src/domain/support/decimal.ts`);
      const whole = numeric.min != null && Number(numeric.min) > 12 ? String(Math.ceil(Number(numeric.min))) : '12';
      // Con ceros a la derecha a propósito: la escala es lo que se pierde por el camino.
      return `Decimal.parse('${scale > 0 ? `${whole}.${'5'.padEnd(scale, '0')}` : whole}')`;
    }
    case 'boolean':
      return 'true';
    case 'date':
      return `'2026-03-14'`;
    case 'timestamp':
      return `new Date('2026-03-14T09:21:07.482Z')`;
    case 'json':
      ctx.imports.add(`RawJson|src/domain/support/raw-json.ts`);
      return `RawJson.of('{"a":[1,2.50]}')`;
    default: {
      const min = text.minLength ?? 0;
      const max = text.maxLength ?? 40;
      if (text.pattern) {
        // Distinta en cada llamada (dos agregados de muestra no pueden compartir clave natural), y la
        // forma básica si la variante no casa con el patrón.
        const sample = sampleFor(text.pattern, min, max, nextVariant++) ?? sampleFor(text.pattern, min, max);
        if (sample == null) {
          ctx.unsampled.push(`${field.name} (${text.pattern})`);
          return null;
        }
        return JSON.stringify(sample);
      }
      const base = `${field.name}-${salt}`;
      return JSON.stringify(base.length > max ? base.slice(0, max) : base.padEnd(min, 'x'));
    }
  }
}

/** La expresión JS de un agregado (o entidad interna) de muestra, con su estado completo. */
function sampleEntity(model, entity, ctx, salt, depth = 0) {
  ctx.imports.add(`${entity.name}|${classPath(entityDir(entity), entity.name)}`);
  const state = [];
  for (const member of domainMembers(model, entity)) {
    let value;
    if (member.kind === 'externalRef') value = `'${randomUUID()}'`;
    else if (member.kind === 'relationMany') {
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      value = depth > 2 || !child ? '[]' : `[${[1, 2].map((n) => sampleEntity(model, child, ctx, `${salt}${n}`, depth + 1)).join(', ')}]`;
    } else if (member.kind === 'relationOne') {
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      value = depth > 2 || !child ? 'null' : sampleEntity(model, child, ctx, `${salt}o`, depth + 1);
    } else if (member.field.list) {
      const values = [1, 2].map((n) => sampleValue(model, { ...member.field, list: false, kind: member.field.kind }, ctx, `${salt}${n}`));
      value = values.some((v) => v == null) ? '[]' : `[${values.join(', ')}]`;
    } else if (member.field.isId) {
      value = `'${randomUUID()}'`;
    } else {
      value = sampleValue(model, member.field, ctx, salt);
      if (value == null) value = 'null';
    }
    state.push(`${member.name}: ${value}`);
  }
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) state.push(`${LOCK_VERSION.field}: null`);
  return `new ${entity.name}({ ${state.join(', ')} })`;
}

// ─── Lo esperado del esquema ─────────────────────────────────────────────────

/** Las tablas, columnas, constraints e índices que el esquema neutral promete para el diseño. */
function expectedSchema(model, engine) {
  const tables = new Map();
  const collation = DATABASES[engine].caseSensitiveCollation ?? null;
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, { columns: new Map(), uniques: new Set(), indexes: new Set(), fks: new Set() });
    return tables.get(name);
  };
  const column = (tableName, spec, nullable = spec.nullable) => {
    table(tableName).columns.set(spec.name, {
      nullable,
      length: spec.long ? null : spec.length ?? (spec.textual && !spec.enum ? 255 : spec.enum ? 255 : null),
      scale: spec.base === 'decimal' ? spec.scale ?? 2 : null,
      collation: spec.collation ?? null
    });
  };
  for (const entity of model.entities.filter((candidate) => candidate.persisted)) {
    const t = table(entity.tableName);
    const members = persistedMembers(model, entity);
    for (const member of members) {
      if (member.kind === 'scalar') {
        column(entity.tableName, member.field.columns);
        if (member.folded) t.columns.set(member.folded.column, { nullable: !member.folded.required, length: member.folded.maxLength ?? 255, scale: null, collation: null });
      } else if (member.kind === 'vo') {
        for (const sub of member.subs) {
          if (sub.subKind === 'composite' || !sub.sub.columns) continue;
          column(entity.tableName, { ...sub.sub.columns, name: sub.column }, !(sub.ownerRequired && !sub.sub.columns.nullable));
        }
      } else if (member.kind === 'externalRef') {
        t.columns.set(member.column, { nullable: !member.relation.required, length: null, scale: null, collation: null });
      } else if (member.kind === 'relationOne') {
        t.columns.set(joinColumnOf(member.relation), { nullable: !member.relation.required, length: null, scale: null, collation: null });
        t.fks.add(foreignKeyName(entity.tableName, member.relation.name));
      } else if (member.kind === 'elementCollection') {
        const element = elementTable(entity, member);
        const et = table(element.table);
        et.fks.add(element.foreignKey);
        et.indexes.add(element.foreignKeyIndex);
        if (member.element.kind !== 'vo' && member.field.elementColumns) column(element.table, member.field.elementColumns);
        for (const index of collectionIndexesOf(entity, members).byMember.get(member.name) ?? []) (index.unique ? et.uniques : et.indexes).add(indexName(entity, index));
      }
    }
    for (const owner of unidirectionalParents(model, entity)) {
      t.columns.set(owner.column, { nullable: true, length: null, scale: null, collation: null });
      t.fks.add(owner.foreignKey);
    }
    if (entity.usesOptimisticLocking && !entity.declaresLockVersion) t.columns.set(LOCK_VERSION.column, { nullable: true, length: null, scale: null, collation: null });
    if (entity.auditTimestamps === 'all') for (const audit of AUDIT_COLUMNS.timestamps) t.columns.set(audit.column, { nullable: false, length: null, scale: null, collation: null });
    // Los condicionados: el índice con su nombre y, en MySQL, la columna que discrimina.
    for (const spec of partialIndexSpecs(model, engine).filter((candidate) => candidate.entity === entity.name)) {
      t.uniques.add(spec.name);
      if (engine === 'mysql') t.columns.set(discriminatorColumn(spec), { nullable: true, length: null, scale: null, collation: null });
    }
    for (const entry of uniqueConstraints(model).filter((u) => u.entity === entity.name && !u.when)) {
      // Los índices únicos de una LISTA viven en su tabla de elementos (arriba).
      if (collectionIndexesOf(entity, members).handled.has((entity.indexes ?? []).find((index) => indexName(entity, index) === entry.constraint))) continue;
      t.uniques.add(entry.constraint);
    }
    for (const index of (entity.indexes ?? []).filter((candidate) => !candidate.when && !candidate.unique)) {
      if (collectionIndexesOf(entity, members).handled.has(index)) continue;
      const probe = [];
      for (const name of index.fields) columnsFor(model, entity, members, name, probe);
      if (probe.length === 0) t.indexes.add(indexName(entity, index));
    }
    for (const fkColumn of foreignKeyIndexColumns(model, entity, members)) t.indexes.add(foreignKeyIndexName(entity.tableName, fkColumn));
  }
  return tables;
}

// ─── La sonda ────────────────────────────────────────────────────────────────

const distOf = (file) => `./dist/${file.replace(/^src\//, '').replace(/\.ts$/, '.js')}`;

function probeScript(model, engine, db, expected) {
  const roots = repositoryRoots(model);
  const ctx = { imports: new Set(), unsampled: [] };
  const blocks = roots.map((root, index) => rootBlock(model, engine, root, index, ctx));
  // Antes de listar los imports: sus valores de muestra también añaden alguno.
  const messagingCode = messagingBlock(model, engine, ctx);
  const claimCode = claimBlock(model, engine, ctx);
  const imports = [...ctx.imports].map((entry) => {
    const [symbol, file] = entry.split('|');
    return `import { ${symbol} } from '${distOf(file)}';`;
  });
  const adapters = roots.map((root) => `import { ${adapterClass(root)} } from '${distOf(adapterPath(root))}';`);
  const bounded = roots.map((root) => boundedColumn(model, root)).find(Boolean);
  // Las colecciones hijas SIN campo de orden: no prometen orden (tampoco en keel-spring, que no les
  // pone @OrderBy), así que se comparan como conjuntos. Las que lo tienen, en su orden.
  const unordered = [];
  for (const entity of model.entities) {
    for (const relation of entity.relations ?? []) {
      if (relation.internal && relation.cardinality === 'one-to-many' && !orderingFieldOf(model, relation.entity)) unordered.push(relation.name);
    }
  }
  return {
    unsampled: [...new Set(ctx.unsampled)],
    root: roots.map((root) => root.name).join(', '),
    script: `import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { databaseSettings } from './dist/infrastructure/persistence/data-source-options.js';
import { TransactionContext } from './dist/infrastructure/persistence/transaction-context.js';
import { translatePersistenceError, OptimisticLockConflict, isTransientWriteConflict } from './dist/infrastructure/persistence/persistence-errors.js';
${adapters.join('\n')}
${imports.join('\n')}

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail: String(detail) });
const UNORDERED = new Set(${JSON.stringify(unordered)});
const values = {
  'database.url': 'jdbc:${engine}://127.0.0.1:${db.port}/${DB_NAME}',
  'database.username': '${DB_NAME}',
  'database.password': '${db.password}',
  'database.synchronize': true,
  'database.transaction-timeout': '30s'
};
const settings = databaseSettings({ get: (key) => values[key], application: { name: 'db-check' } });
const dataSource = await new DataSource(settings.options).initialize();
await dataSource.synchronize(true);
const tx = new TransactionContext(dataSource, settings);
// Los adaptadores de una raíz que emite eventos los entregan al puente: aquí se miden la persistencia y
// sus tablas, así que reciben un sumidero; el puente de verdad lo mide el bloque de mensajería.
const eventSink = { publish: async () => {} };

// ── Esquema: el catálogo del motor contra lo que promete el esquema neutral.
const expected = ${JSON.stringify([...expected.entries()].map(([name, t]) => [name, { columns: [...t.columns.entries()], uniques: [...t.uniques], indexes: [...t.indexes], fks: [...t.fks] }]))};
const schema = ${engine === 'postgresql' ? "'public'" : `'${DB_NAME}'`};
for (const [table, want] of expected) {
  const columns = await dataSource.query(${engine === 'postgresql'
    ? "`SELECT column_name AS name, is_nullable AS nullable, character_maximum_length AS length, numeric_scale AS scale, collation_name AS collation FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`"
    : "`SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable, CHARACTER_MAXIMUM_LENGTH AS length, NUMERIC_SCALE AS scale, COLLATION_NAME AS collation, DATA_TYPE AS type FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`"}, [schema, table]);
  check(\`tabla \${table} existe\`, columns.length > 0);
  const byName = new Map(columns.map((c) => [c.name, c]));
  for (const [name, spec] of want.columns) {
    const got = byName.get(name);
    if (!got) { check(\`\${table}.\${name} existe\`, false); continue; }
    const problems = [];
    if ((got.nullable === 'YES') !== spec.nullable) problems.push(\`nullable \${got.nullable}\`);
    if (spec.length != null && Number(got.length) !== spec.length) problems.push(\`longitud \${got.length} (diseño \${spec.length})\`);
    if (spec.scale != null && Number(got.scale) !== spec.scale) problems.push(\`escala \${got.scale} (diseño \${spec.scale})\`);
    if (spec.collation != null && got.collation !== spec.collation) problems.push(\`collation \${got.collation} (forzada \${spec.collation})\`);
    check(\`\${table}.\${name} es la columna del diseño\`, problems.length === 0, problems.join(', '));
  }
${engine === 'postgresql'
    ? `  const indexes = (await dataSource.query('SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = $1 AND tablename = $2', [schema, table]));
  const constraints = (await dataSource.query('SELECT conname AS name, contype AS type FROM pg_constraint c JOIN pg_class t ON c.conrelid = t.oid WHERE t.relname = $1', [table]));
  const unique = new Set([...constraints.filter((c) => c.type === 'u').map((c) => c.name), ...indexes.filter((i) => /UNIQUE/i.test(i.def)).map((i) => i.name)]);
  const plain = new Set(indexes.map((i) => i.name));
  const fks = new Set(constraints.filter((c) => c.type === 'f').map((c) => c.name));`
    : `  const stats = await dataSource.query('SELECT DISTINCT INDEX_NAME AS name, NON_UNIQUE AS nonUnique FROM information_schema.statistics WHERE table_schema = ? AND table_name = ?', [schema, table]);
  const unique = new Set(stats.filter((s) => Number(s.nonUnique) === 0).map((s) => s.name));
  const plain = new Set(stats.map((s) => s.name));
  const fks = new Set((await dataSource.query("SELECT CONSTRAINT_NAME AS name FROM information_schema.table_constraints WHERE table_schema = ? AND table_name = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'", [schema, table])).map((r) => r.name));`}
  for (const name of want.uniques) check(\`\${table}: unicidad \${name} con su nombre\`, unique.has(name), [...unique].join(', '));
  for (const name of want.indexes) check(\`\${table}: índice \${name}\`, plain.has(name), [...plain].join(', '));
  for (const name of want.fks) check(\`\${table}: FK \${name}\`, fks.has(name), [...fks].join(', '));
}
${bounded ? `
// ── Cota: lo que el diseño declara imposible lo rechaza el motor, no solo la validación de entrada.
try {
  await dataSource.query(${JSON.stringify(`INSERT INTO ${bounded.table} (${bounded.columns.join(', ')}) VALUES (${bounded.values.join(', ')})`)});
  check('${bounded.table}.${bounded.column} rechaza un texto más largo que ${bounded.max}', false, 'el motor lo aceptó');
} catch (error) {
  check('${bounded.table}.${bounded.column} rechaza un texto más largo que ${bounded.max}', /too long|Data too long|22001|1406/i.test(String(error?.driverError?.code ?? '') + String(error?.message)), error?.message);
}
` : ''}
${blocks.join('\n')}
${concurrencyBlock(model, engine, roots[0], ctx)}
${idempotencyBlock(model, engine)}
${messagingCode}
${claimCode}
${purgeBlock(model)}

await dataSource.destroy();
console.log('@@RESULTS@@' + JSON.stringify(results));

/** La fila tal como la guarda el motor, sin pasar por el ORM. */
async function rawRow(table, id) {
  ${engine === 'postgresql'
    ? "const rows = await dataSource.query(`SELECT * FROM \"${table}\" WHERE id = $1`, [id]);"
    : "const rows = await dataSource.query(`SELECT * FROM \\`${table}\\` WHERE id = UUID_TO_BIN(?)`, [id]);"}
  return rows[0] ?? null;
}

function stateOf(entity) {
  const out = {};
  let proto = Object.getPrototypeOf(entity);
  while (proto && proto !== Object.prototype) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (descriptor.get && !(key in out)) out[key] = entity[key];
    }
    proto = Object.getPrototypeOf(proto);
  }
  return out;
}

/** El estado observable de un valor: getters del agregado, campos de un value object, texto de un decimal. */
function snapshot(value) {
  if (value == null) return value;
  if (typeof value === 'bigint') return \`\${value}n\`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(snapshot);
  if (typeof value === 'object') {
    if (value.constructor?.name === 'Decimal') return \`D:\${value.toString()}\`;
    if (value.constructor?.name === 'RawJson') return \`J:\${value.text}\`;
    const getters = stateOf(value);
    const own = Object.keys(getters).length > 0 ? getters : { ...value };
    const out = {};
    // La versión y la última modificación las pone la persistencia, no quien guarda.
    for (const key of Object.keys(own).sort()) {
      if (key === 'lockVersion' || key === 'updatedAt' || key === 'updatedBy') continue;
      const item = snapshot(own[key]);
      out[key] = UNORDERED.has(key) && Array.isArray(item) ? [...item].sort((a, b) => String(a?.id).localeCompare(String(b?.id))) : item;
    }
    return out;
  }
  return value;
}

function differences(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((key) => differences(a[key], b[key], at ? \`\${at}.\${key}\` : key));
  }
  return [\`\${at}: \${JSON.stringify(a)} → \${JSON.stringify(b)}\`];
}
`
  };
}

/** Lo que se comprueba de una raíz: ida y vuelta, la fila en crudo, versión, unicidad, página y borrado. */
function rootBlock(model, engine, root, index, ctx) {
  const first = sampleEntity(model, root, ctx, `${index}a`);
  const second = sampleEntity(model, root, ctx, `${index}b`);
  const finder = naturalKeyFinder(model, root);
  const name = root.name;
  const paginated = model.services.some((group) => group.entity === root.name && group.operations.some((op) => op.paginated));
  // Lo que solo se ve en la fila cruda: el enum por su CONSTANTE y el decimal con su escala.
  const raw = [];
  for (const member of persistedMembers(model, root)) {
    if (member.kind === 'scalar' && member.field.kind === 'enum') {
      ctx.imports.add(`${member.field.namedType}|${classPath(DIRS.enums, member.field.namedType)}`);
      raw.push(`  check('${name}.${member.name}: el motor guarda la CONSTANTE del enum', row?.['${member.field.columns.name}'] === Object.entries(${member.field.namedType}).find(([, v]) => v === original.${member.name})?.[0], row?.['${member.field.columns.name}']);`);
    } else if (member.kind === 'scalar' && member.field.base === 'decimal') {
      raw.push(`  check('${name}.${member.name}: el motor guarda el decimal con su escala', String(row?.['${member.field.columns.name}']) === original.${member.name}?.toString(), row?.['${member.field.columns.name}']);`);
    } else if (member.kind === 'vo') {
      for (const sub of member.subs.filter((s) => s.sub.base === 'decimal')) {
        raw.push(`  check('${name}.${member.name}.${sub.voAccessor}: el motor guarda el decimal con su escala', String(row?.['${sub.column}']) === original.${member.name}?.${sub.voAccessor}?.toString(), row?.['${sub.column}']);`);
      }
    }
  }
  return `
// ═══ ${name} ═══
{
  const repository = new ${adapterClass(root)}(tx, eventSink);
  const original = ${first};
  await repository.save(original);
  const loaded = await repository.findById(original.id);
  check('${name}: findById devuelve lo que se guardó', loaded != null);
  const diff = differences(snapshot(original), snapshot(loaded));
  check('${name}: ida y vuelta sin perder nada (escala, uuid, fechas, enums, orden)', diff.length === 0, diff.slice(0, 6).join(' | '));
  const row = await rawRow('${root.tableName}', original.id);
  check('${name}: la fila está en ${root.tableName}', row != null);
${raw.join('\n')}
${root.usesOptimisticLocking ? `  check('${name}: nace con la versión 0', loaded?.lockVersion === 0, loaded?.lockVersion);
  // La misma lectura guardada dos veces: la segunda escribe sobre una versión que ya no existe.
  await repository.save(loaded);
  try {
    await repository.save(loaded);
    check('${name}: guardar una lectura obsoleta es un conflicto de concurrencia', false, 'se guardó');
  } catch (error) {
    const translated = translatePersistenceError(error);
    check('${name}: guardar una lectura obsoleta es un conflicto de concurrencia', error instanceof OptimisticLockConflict && translated?.httpStatus === 409, translated?.code ?? error?.message);
  }` : ''}
${finder ? `  const found = await repository.${finder.name}(${finder.params.map((param) => `original.${param.name}`).join(', ')});
  check('${name}: el finder de la clave natural encuentra el agregado', found?.id === original.id);
  const rival = ${second};
  const clash = new ${name}({ ...stateOf(rival), ${finder.params.map((param) => `${param.name}: original.${param.name}`).join(', ')} });
  try {
    await repository.save(clash);
    check('${name}: la clave natural duplicada la rechaza el motor', false, 'se guardó');
  } catch (error) {
    const translated = translatePersistenceError(error);
    check('${name}: la clave natural duplicada sale como el error del diseño', translated && translated !== 'integrity' && translated !== 'timeout' && translated.httpStatus === 409, translated?.code ?? translated ?? error?.message);
  }` : ''}
${foldedBlock(model, root, index, ctx, finder)}
${conditionalBlock(model, root, index, ctx)}
${paginated ? `  const page = await repository.list({ page: 0, size: 5, sort: [] });
  check('${name}: list devuelve la página con su total', page.totalElements >= 1 && page.items.length >= 1 && page.totalPages >= 1, JSON.stringify({ total: page.totalElements, n: page.items.length }));` : ''}
  await repository.deleteById(original.id);
  check('${name}: deleteById borra el agregado y su grafo', (await repository.findById(original.id)) == null);
}`;
}

/**
 * Lo que el motor hace con dos transacciones que se pisan, y cómo lo CLASIFICA lo emitido. Es lo que
 * se rompe en silencio: con un código equivocado el interbloqueo no se reintenta nunca y el tope sale
 * como 500. Se fabrican los dos de verdad con el TransactionContext generado:
 *   · interbloqueo: dos transacciones bloquean dos filas en orden inverso; el motor aborta a una, y
 *     tiene que salir como conflicto transitorio (el que el mediator reintenta);
 *   · tope: una transacción espera una fila que otra tiene bloqueada más allá de su tope, y tiene que
 *     salir como tope de transacción (503), no como conflicto ni como 500.
 */
function concurrencyBlock(model, engine, root, ctx) {
  if (!root) return '';
  const pick = engine === 'postgresql' ? `SELECT id FROM "${root.tableName}" WHERE id = $1 FOR UPDATE` : `SELECT id FROM \`${root.tableName}\` WHERE id = UUID_TO_BIN(?) FOR UPDATE`;
  return `
// ═══ Concurrencia: interbloqueo y tope de transacción ═══
{
  const repository = new ${adapterClass(root)}(tx, eventSink);
  const a = ${sampleEntity(model, root, ctx, 'xa')};
  const b = ${sampleEntity(model, root, ctx, 'xb')};
  await repository.save(a);
  await repository.save(b);
  const lock = (manager, id) => manager.query(${JSON.stringify(pick)}, [id]);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Interbloqueo: T1 toma a y luego b; T2 toma b y luego a.
  const outcomes = await Promise.allSettled([
    tx.inTransaction(async (manager) => { await lock(manager, a.id); await pause(400); await lock(manager, b.id); }),
    new TransactionContext(dataSource, settings).inTransaction(async (manager) => { await lock(manager, b.id); await pause(400); await lock(manager, a.id); })
  ]);
  const lost = outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason);
  check('interbloqueo: el motor aborta una de las dos', lost.length === 1, lost.map((error) => error?.message).join(' | '));
  check('interbloqueo: sale como conflicto transitorio (el mediator lo reintenta)', lost.length === 1 && isTransientWriteConflict(lost[0]), lost[0]?.driverError?.code ?? lost[0]?.message);

  // Tope: una transacción con tope de 1 s espera una fila que otra retiene 4 s.
  const hurried = new TransactionContext(dataSource, { ...settings, transactionTimeoutMs: 1000 });
  let release;
  const holder = tx.inTransaction(async (manager) => { await lock(manager, a.id); await new Promise((resolve) => { release = resolve; setTimeout(resolve, 4000); }); });
  await pause(300);
  const waited = await hurried.inTransaction((manager) => lock(manager, a.id)).then(() => null, (error) => error);
  release?.();
  await holder;
  check('tope: la espera de bloqueo se corta', waited != null, 'la sentencia esperó más que su tope');
  check('tope: sale como tope de transacción (503), no como conflicto', waited != null && translatePersistenceError(waited) === 'timeout' && !isTransientWriteConflict(waited), waited?.driverError?.code ?? waited?.message);
}`;
}

/**
 * El REGISTRO de la idempotencia de petición contra el motor: la tabla es la del esquema neutral (la de
 * keel-spring), el adaptador guarda y encuentra, el ámbito forma parte de la clave, una clave repetida
 * y una CARRERA de dos transacciones salen como el conflicto con su code, una clave caducada se
 * sustituye, y el registro revierte con la transacción del comando.
 */
function idempotencyBlock(model, engine) {
  if (!usesRequestIdempotency(model)) return '';
  // El code de la carrera: el canónico, o el que el diseño declare de su familia (catalog-extended).
  const race = { code: effectiveErrorCode(model, FRAMEWORK_ERRORS.idempotencyRace), http: FRAMEWORK_ERRORS.idempotencyRace.http };
  const schema = engine === 'postgresql' ? "'public'" : `'${DB_NAME}'`;
  const columnsQuery = engine === 'postgresql'
    ? 'SELECT column_name AS name, is_nullable AS nullable, character_maximum_length AS length FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2'
    : 'SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable, CHARACTER_MAXIMUM_LENGTH AS length FROM information_schema.columns WHERE table_schema = ? AND table_name = ?';
  const indexQuery = engine === 'postgresql'
    ? 'SELECT indexname AS name FROM pg_indexes WHERE schemaname = $1 AND tablename = $2'
    : 'SELECT DISTINCT INDEX_NAME AS name FROM information_schema.statistics WHERE table_schema = ? AND table_name = ?';
  return `
// ═══ Idempotencia de petición: el registro idempotency_record ═══
{
  const { IdempotencyStoreImpl } = await import('${distOf(IDEMPOTENCY_STORE_IMPL_TS)}');
  const { IdempotencyConflictException } = await import('${distOf(IDEMPOTENCY_CONFLICT_TS)}');
  const spec = ${JSON.stringify(IDEMPOTENCY_RECORD)};
  const columns = await dataSource.query(${JSON.stringify(columnsQuery)}, [${schema}, spec.table]);
  for (const want of spec.columns) {
    const got = columns.find((column) => (column.name ?? column.NAME) === want.name);
    const length = got?.length ?? got?.LENGTH;
    const nullable = (got?.nullable ?? got?.NULLABLE) === 'YES';
    check(\`\${spec.table}.\${want.name} es la columna del esquema neutral\`, got != null && nullable === want.nullable && (want.length == null || Number(length) === want.length), JSON.stringify(got));
  }
  const indexes = (await dataSource.query(${JSON.stringify(indexQuery)}, [${schema}, spec.table])).map((row) => row.name ?? row.NAME);
  check(\`\${spec.table}: índice \${spec.indexes[0].name}\`, indexes.includes(spec.indexes[0].name), indexes.join(', '));

  const store = new IdempotencyStoreImpl(tx);
  const key = randomUUID();
  check('idempotencia: una clave nueva no tiene registro', (await tx.inTransaction(() => store.find('createThing', key))) == null);
  await tx.inTransaction(() => store.save('createThing', key, 'firma-a', 'recurso-1', 3600));
  const stored = await tx.inTransaction(() => store.find('createThing', key));
  check('idempotencia: guarda y encuentra la firma y el recurso', stored?.signature === 'firma-a' && stored?.resourceId === 'recurso-1', JSON.stringify(stored));
  check('idempotencia: el ámbito forma parte de la clave', (await tx.inTransaction(() => store.find('otherThing', key))) == null);
  const repeated = await tx.inTransaction(() => store.save('createThing', key, 'firma-b', 'recurso-2', 3600)).then(() => null, (error) => error);
  check('idempotencia: la misma clave otra vez es el conflicto de clave en curso', repeated instanceof IdempotencyConflictException && repeated.code === '${race.code}' && repeated.httpStatus === ${race.http}, repeated?.code ?? repeated?.message ?? 'se guardó');

  const reverted = randomUUID();
  await tx.inTransaction(async () => { await store.save('createThing', reverted, 'firma', 'recurso', 3600); throw new Error('el comando falla'); }).catch(() => null);
  check('idempotencia: el registro revierte con la transacción del comando', (await tx.inTransaction(() => store.find('createThing', reverted))) == null);

  const expired = randomUUID();
  await tx.inTransaction(() => store.save('createThing', expired, 'firma-vieja', 'recurso-viejo', 0));
  check('idempotencia: una clave caducada es como si no estuviera', (await tx.inTransaction(() => store.find('createThing', expired))) == null);
  const reused = await tx.inTransaction(() => store.save('createThing', expired, 'firma-nueva', 'recurso-nuevo', 3600)).then(() => null, (error) => error);
  const renewed = await tx.inTransaction(() => store.find('createThing', expired));
  check('idempotencia: la clave caducada se puede volver a usar', reused == null && renewed?.signature === 'firma-nueva', reused?.message ?? JSON.stringify(renewed));

  // La CARRERA: dos transacciones registran la misma clave nueva a la vez; la primera tarda en confirmar.
  const contested = randomUUID();
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const outcomes = await Promise.allSettled([
    tx.inTransaction(async () => { await store.save('createThing', contested, 'firma', 'r1', 3600); await pause(800); }),
    (async () => { await pause(200); const other = new TransactionContext(dataSource, settings); return other.inTransaction(() => new IdempotencyStoreImpl(other).save('createThing', contested, 'firma', 'r2', 3600)); })()
  ]);
  const lost = outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason);
  check('idempotencia: en una carrera gana UNA', lost.length === 1, outcomes.map((outcome) => outcome.status).join(', '));
  check('idempotencia: la que pierde la carrera sale como el conflicto de clave en curso', lost.length === 1 && lost[0] instanceof IdempotencyConflictException && lost[0].code === '${race.code}', lost[0]?.code ?? lost[0]?.message);
}`;
}

/**
 * Los ALMACENES DE LA MENSAJERÍA contra el motor (incremento 9), lo que en keel-spring mide store-check:
 *   · las tablas outbox_event y processed_event son las de keel-core/gen/messaging-stores.js;
 *   · el puente escribe la fila del outbox DENTRO de la transacción del cambio: si revierte, no queda;
 *   · el reclamo del relay: en orden de llegada, con su tamaño de lote, sin las filas que el lease retiró,
 *     SIN ESPERAR a una fila bloqueada por otra transacción (SKIP LOCKED), sin las publicadas;
 *   · el desenlace: el backoff aplaza la fila, la rendición la retira y la cuenta countDeadLettered;
 *   · el registro de procesados: la repetición y la carrera las arbitra la clave primaria, el registro
 *     sobrevive al rollback del handler (su transacción es propia) y dos consumidores no se pisan.
 */
function messagingBlock(model, engine, ctx) {
  const outbox = usesNestOutbox(model);
  const processed = usesProcessedEvents(model);
  if (!outbox && !processed) return '';
  const schema = engine === 'postgresql' ? "'public'" : `'${DB_NAME}'`;
  const columnsQuery = engine === 'postgresql'
    ? 'SELECT column_name AS name, is_nullable AS nullable, character_maximum_length AS length FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2'
    : 'SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable, CHARACTER_MAXIMUM_LENGTH AS length FROM information_schema.columns WHERE table_schema = ? AND table_name = ?';
  const indexQuery = engine === 'postgresql'
    ? 'SELECT indexname AS name FROM pg_indexes WHERE schemaname = $1 AND tablename = $2'
    : 'SELECT DISTINCT INDEX_NAME AS name FROM information_schema.statistics WHERE table_schema = ? AND table_name = ?';
  const tables = [outbox ? OUTBOX_EVENT : null, processed ? PROCESSED_EVENT : null].filter(Boolean);
  const schemaChecks = `
  for (const spec of ${JSON.stringify(tables)}) {
    const columns = await dataSource.query(${JSON.stringify(columnsQuery)}, [${schema}, spec.table]);
    for (const want of spec.columns.filter((column) => !column.onlyIn || column.onlyIn === 'relational')) {
      const got = columns.find((column) => (column.name ?? column.NAME) === want.name);
      const length = got?.length ?? got?.LENGTH;
      const nullable = (got?.nullable ?? got?.NULLABLE) === 'YES';
      check(\`\${spec.table}.\${want.name} es la columna de keel-core\`, got != null && nullable === want.nullable && (want.length == null || Number(length) === want.length), JSON.stringify(got));
    }
    check(\`\${spec.table} no tiene columnas de más\`, columns.length === spec.columns.filter((column) => !column.onlyIn || column.onlyIn === 'relational').length, columns.map((column) => column.name ?? column.NAME).join(', '));
    const indexes = (await dataSource.query(${JSON.stringify(indexQuery)}, [${schema}, spec.table])).map((row) => row.name ?? row.NAME);
    for (const index of spec.indexes) check(\`\${spec.table}: índice \${index.name}\`, indexes.includes(index.name), indexes.join(', '));
  }`;
  let bridge = '';
  if (outbox) {
    const event = model.events[0];
    const args = event.fields.map((field) => (field.list ? '[]' : sampleValue(model, field, ctx, 'ev') ?? 'null'));
    bridge = `
  // ── El puente: la fila del outbox en la transacción del cambio.
  const { ${bridgeClass(model)}: Bridge } = await import('${distOf(bridgePath(model))}');
  const { ${event.className}: DomainEventClass } = await import('${distOf(classPath(DIRS.events, event.className))}');
  const { messagingSettings } = await import('${distOf(MESSAGING_SETTINGS_TS)}');
  const messaging = messagingSettings({ get: () => undefined });
  const bridge = new Bridge(tx, messaging);
  const kept = DomainEventClass.of(${args.join(', ')});
  await tx.inTransaction(() => bridge.publish([kept]));
  const rows = await dataSource.getRepository(OutboxEventOrm).find();
  const row = rows.find((candidate) => JSON.parse(candidate.payload).metadata.eventId === kept.metadata.eventId);
  check('outbox: el puente escribe la fila del evento', row != null, rows.length);
  check('outbox: la fila lleva el destino, la routing key y el NOMBRE del evento', row?.destination === messaging.destination && row?.routingKey === messaging.routingKeys[${JSON.stringify(event.name)}] && row?.eventType === ${JSON.stringify(event.name)}, JSON.stringify(row && { destination: row.destination, routingKey: row.routingKey, eventType: row.eventType }));
  check('outbox: el payload es la envoltura (metadata + data)', row != null && JSON.stringify(Object.keys(JSON.parse(row.payload))) === '["metadata","data"]', row?.payload);
  const lost = DomainEventClass.of(${args.join(', ')});
  await tx.inTransaction(async () => { await bridge.publish([lost]); throw new Error('el cambio revierte'); }).catch(() => null);
  const after = await dataSource.getRepository(OutboxEventOrm).find();
  check('outbox: si el cambio revierte, la fila tampoco queda', !after.some((candidate) => JSON.parse(candidate.payload).metadata.eventId === lost.metadata.eventId), after.length);`;
  }
  const relay = outbox
    ? `
  // ── El reclamo del relay.
  const { OutboxRelayStore } = await import('${distOf(OUTBOX_RELAY_STORE_TS)}');
  const store = new OutboxRelayStore(tx);
  await dataSource.getRepository(OutboxEventOrm).clear();
  const base = Date.now() - 60_000;
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const id = randomUUID();
    ids.push(id);
    await dataSource.getRepository(OutboxEventOrm).insert({ id, destination: 'd', routingKey: 'k', eventType: 'E', payload: '{}', createdAt: new Date(base + i * 1000), publishedAt: null, attempts: 0, nextAttemptAt: null, lastError: null });
  }
  const first = await store.claimBatch(10, 2, 60_000);
  check('relay: reclama en orden de llegada y con su tamaño de lote', JSON.stringify(first.map((r) => r.id)) === JSON.stringify(ids.slice(0, 2)), JSON.stringify(first.map((r) => r.id)));
  const second = await store.claimBatch(10, 10, 60_000);
  check('relay: el lease retira las reclamadas de la pasada siguiente', JSON.stringify(second.map((r) => r.id)) === JSON.stringify(ids.slice(2)), JSON.stringify(second.map((r) => r.id)));
  // SKIP LOCKED: con una fila bloqueada por OTRA transacción, el reclamo sigue sin ella y sin esperar.
  await dataSource.createQueryBuilder().update(OutboxEventOrm).set({ nextAttemptAt: null }).where('1 = 1').execute();
  const holder = new TransactionContext(dataSource, settings);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  // Como la retendría otra réplica: UNA fila por su id y en READ COMMITTED. Con un predicado sin índice en
  // REPEATABLE READ, InnoDB bloquea todas las filas que recorre, y eso no lo hace ningún relay.
  const locking = holder.inTransaction(async (manager) => {
    await manager.findOne(OutboxEventOrm, { where: { id: ids[0] }, lock: { mode: 'pessimistic_write' } });
    await held;
  }, { isolation: 'READ COMMITTED' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const started = Date.now();
  const skipping = await store.claimBatch(10, 10, 60_000);
  const waited = Date.now() - started;
  release();
  await locking;
  check('relay: no espera a una fila bloqueada por otra réplica (SKIP LOCKED)', waited < 5_000 && skipping.length === 3 && !skipping.some((r) => r.id === ids[0]), \`\${skipping.length} filas en \${waited} ms\`);
  // El desenlace.
  await dataSource.createQueryBuilder().update(OutboxEventOrm).set({ nextAttemptAt: null }).where('1 = 1').execute();
  await store.markPublished(ids[0]);
  const failedOnce = await store.markFailed(ids[1], 'broker caído', 3, 1000, 60_000);
  const delayed = await dataSource.getRepository(OutboxEventOrm).findOneBy({ id: ids[1] });
  const delay = delayed.nextAttemptAt.getTime() - Date.now();
  check('relay: un fallo cuenta el intento y aplaza la fila según el backoff', failedOnce.attempts === 1 && !failedOnce.deadLettered && delay > 500 && delay <= 1_000 && delayed.lastError === 'broker caído', \`\${JSON.stringify(failedOnce)} \${delay} ms\`);
  await store.markFailed(ids[2], 'x', 2, 1000, 60_000);
  const surrendered = await store.markFailed(ids[2], 'x', 2, 1000, 60_000);
  check('relay: al alcanzar el máximo la fila se rinde', surrendered.deadLettered && surrendered.attempts === 2, JSON.stringify(surrendered));
  check('relay: countDeadLettered la cuenta', (await store.countDeadLettered(2)) === 1);
  await dataSource.getRepository(OutboxEventOrm).update({ id: ids[1] }, { nextAttemptAt: null });
  const remaining = await store.claimBatch(2, 10, 60_000);
  check('relay: ni la publicada ni la rendida vuelven a reclamarse', JSON.stringify(remaining.map((r) => r.id).sort()) === JSON.stringify([ids[1], ids[3]].sort()), JSON.stringify(remaining.map((r) => r.id)));`
    : '';
  const guard = processed
    ? `
  // ── El registro de mensajes procesados.
  const { IdempotencyGuard } = await import('${distOf(IDEMPOTENCY_GUARD_TS)}');
  const guard = new IdempotencyGuard(tx);
  const eventId = randomUUID();
  check('consumo: un mensaje nuevo no está procesado', !(await guard.alreadyProcessed('ListenerA', eventId)));
  check('consumo: record lo registra', await guard.record('ListenerA', eventId));
  check('consumo: la repetición la arbitra la clave (record da false)', !(await guard.record('ListenerA', eventId)));
  check('consumo: alreadyProcessed lo ve', await guard.alreadyProcessed('ListenerA', eventId));
  check('consumo: otro consumidor del mismo mensaje no se pisa', await guard.tryRecord('ListenerB', eventId));
  const survivor = randomUUID();
  await tx.inTransaction(async () => { await guard.record('ListenerA', survivor); throw new Error('el handler falla'); }).catch(() => null);
  check('consumo: el registro sobrevive al rollback del handler (su transacción es propia)', await guard.alreadyProcessed('ListenerA', survivor));
  const contested = randomUUID();
  const outcomes = await Promise.all([guard.record('ListenerC', contested), new IdempotencyGuard(new TransactionContext(dataSource, settings)).record('ListenerC', contested)]);
  check('consumo: en una carrera registra UNA entrega', outcomes.filter(Boolean).length === 1, JSON.stringify(outcomes));
  check('consumo: handler_id admite ${PROCESSED_EVENT.columns[0].length} caracteres y event_id ${PROCESSED_EVENT.columns[1].length}', await guard.record('h'.repeat(${PROCESSED_EVENT.columns[0].length}), 'e'.repeat(${PROCESSED_EVENT.columns[1].length})));`
    : '';
  return `
// ═══ Mensajería: el outbox y el registro de procesados ═══
{${outbox ? `\n  const { OutboxEventOrm } = await import('${distOf(OUTBOX_ORM_TS)}');` : ''}${schemaChecks}${bridge}${relay}${guard}
}`;
}

/**
 * Los RECLAMOS de barrido (incremento 10c) contra el motor, lo que en keel-spring mide claim-check:
 *   · la COLA: el lote sale del más antiguo al más nuevo, con su tamaño, ya en el estado de destino (y con el
 *     reloj estampado si un rescate lo lee); la pasada siguiente se lleva el resto y nada más;
 *   · SKIP LOCKED: una fila bloqueada por otra réplica no se espera, se salta;
 *   · la CARRERA: dos réplicas a la vez se reparten el lote sin llevarse ninguna fila dos veces;
 *   · el RESCATE: solo lo abandonado (más viejo que su plazo), sin cambiarle el estado y renovando el reloj,
 *     así que la pasada siguiente ya no lo ve; lo recién entrado en vuelo no se toca.
 * Antes de cada caso se aparcan las filas de la tabla en un estado que ningún reclamo lee.
 */
function claimBlock(model, engine, ctx) {
  const blocks = [];
  for (const root of repositoryRoots(model)) {
    const claims = claimsForEntity(model, root.name);
    if (claims.length === 0) continue;
    const { enumType, field } = root.lifecycle;
    const enumDef = model.enums.find((candidate) => candidate.name === enumType);
    const read = new Set(claims.flatMap((claim) => claim.from));
    const parked = enumDef.values.find((value) => !read.has(value.literal));
    if (!parked) continue;
    ctx.imports.add(`${enumType}|${classPath(DIRS.enums, enumType)}`);
    ctx.imports.add(`${ormClass(root.name)}|${ormPath(root.name)}`);
    const orm = ormClass(root.name);
    const samples = Array.from({ length: 24 }, (_, i) => `() => ${sampleEntity(model, root, ctx, `claim${i}`)}`);
    const stalledParameters = claims.filter((claim) => claim.stalled?.parameter).map((claim) => claim.stalled.parameter.name);
    // Los argumentos del constructor, en su orden: la transacción, el puente si la raíz emite, la
    // configuración de los barridos y los parámetros si un rescate lee de ellos su plazo. Plazo de un minuto.
    const args = ['context', emitsDomainEvents(model, root) ? 'eventSink' : null, 'sweeps(batch)', stalledParameters.length > 0 ? `{ ${stalledParameters.map((name) => `${name}: 1`).join(', ')} }` : null].filter(Boolean);
    const stalledSettings = claims.filter((claim) => claim.stalled && !claim.stalled.parameter).map((claim) => `${JSON.stringify(claim.stalled.configKey)}: 60`);
    const batchKeys = [...new Set(claims.map((claim) => claim.sweepKey))];
    // Las sentencias con las que el ARNÉS fabrica la precondición del rescate (stallInFlight, putInFlight,
    // inFlightWithoutClock), con los literales del motor: tienen que CASAR, o el escenario del rescate sale
    // verde sin haber atascado nada.
    const harnessProbe = (claim) => {
      const entry = DATABASES[engine];
      const probe = rescueProbes(model).find((candidate) => candidate.table === root.tableName && candidate.state === screamingSnake(claim.stalled.state));
      if (!probe || !entry?.staleTimestamp || !entry?.uuidLiteral) return '';
      const label = `${root.name}.${claim.method}`;
      const stall = JSON.stringify(stallSql({ ...probe, clockSql: entry.staleTimestamp }));
      const put = JSON.stringify(stallSql({ ...probe, clockSql: entry.nowTimestamp ?? 'CURRENT_TIMESTAMP' }));
      const literal = (id) => `${JSON.stringify(entry.uuidLiteral.prefix)} + ${id} + ${JSON.stringify(entry.uuidLiteral.suffix)}`;
      return `

    // El arnés: stallInFlight y putInFlight sobre dos filas creadas por el adaptador, aparcadas fuera de vuelo.
    await park();
    const [stalledRow, currentRow] = await seed(2, ${enumType}.${screamingSnake(parked.literal)}, () => ({}));
    await dataSource.query(${stall} + ${literal('stalledRow')});
    await dataSource.query(${put} + ${literal('currentRow')});
    const viaHarness = await adapter(10).${claim.method}();
    check('${label}: stallInFlight deja una fila que el rescate se lleva, y putInFlight una que no', same(viaHarness.map((e) => e.id), [stalledRow]), JSON.stringify(viaHarness.map((e) => e.id)));
    const withoutClock = async () => Number(Object.values((await dataSource.query(${JSON.stringify(missingClockCountSql(probe))}))[0])[0]);
    check('${label}: inFlightWithoutClock cuenta cero con todo el reloj estampado', (await withoutClock()) === 0);
    await dataSource.createQueryBuilder().update(${orm}).set({ ${claim.stalled.stampField}: null }).where({ id: currentRow }).execute();
    check('${label}: inFlightWithoutClock ve la fila en vuelo sin reloj', (await withoutClock()) === 1);`;
    };
    const cases = claims.map((claim) => {
      const label = `${root.name}.${claim.method}`;
      if (claim.stalled) {
        const stamp = claim.stalled.stampField;
        return `
  {
    await park();
    const state = ${enumType}.${screamingSnake(claim.stalled.state)};
    const stale = await seed(3, state, (i) => ({ ${stamp}: new Date(Date.now() - 7_200_000 - i * 1000) }));
    const fresh = await seed(2, state, () => ({ ${stamp}: new Date(Date.now() - 5_000) }));
    const before = new Date(Date.now() - 1_000);
    const rescued = await adapter(10).${claim.method}();
    check('${label}: el rescate se lleva SOLO lo abandonado', same(rescued.map((e) => e.id), stale), JSON.stringify(rescued.map((e) => e.id)));
    check('${label}: no cambia el estado: lo arrienda', rescued.every((e) => e.${field} === state), rescued.map((e) => e.${field}).join(','));
    check('${label}: y renueva el reloj en el mismo UPDATE', rescued.every((e) => e.${stamp} != null && e.${stamp}.getTime() >= before.getTime()), rescued.map((e) => e.${stamp}?.toISOString()).join(','));
    check('${label}: la pasada siguiente ya no lo ve (el reloj renovado no está atascado)', (await adapter(10).${claim.method}()).length === 0);
    const untouched = await dataSource.getRepository(${orm}).findBy(fresh.map((id) => ({ id })));
    check('${label}: lo recién entrado en vuelo no se toca', untouched.length === 2 && untouched.every((row) => Date.now() - row.${stamp}.getTime() >= 4_000), untouched.map((row) => row.${stamp}?.toISOString()).join(','));${harnessProbe(claim)}
  }`;
      }
      const order = claimOrderField(root, claim);
      const ordered = order !== 'id';
      return `
  {
    await park();
    const from = ${enumType}.${screamingSnake(claim.from[0])};
    // Instantes al revés del orden de inserción: el más antiguo es el último insertado.
    const ids = await seed(5, from, (i) => (${ordered ? `{ ${order}: new Date(Date.now() - 60_000 - i * 1000) }` : '{}'}));
    const before = new Date(Date.now() - 1_000);
    const first = await adapter(2).${claim.method}();
    ${ordered ? `check('${label}: el lote sale del más antiguo al más nuevo, con su tamaño', JSON.stringify(first.map((e) => e.id)) === JSON.stringify([ids[4], ids[3]]), JSON.stringify({ got: first.map((e) => e.id), ids, at: (await dataSource.getRepository(${orm}).findBy(ids.map((id) => ({ id })))).map((row) => [row.id, row.${order}]) }));` : `check('${label}: el lote tiene su tamaño', first.length === 2, first.length);`}
    check('${label}: lo reclamado sale ya en ${claim.to}', first.every((e) => e.${field} === ${enumType}.${screamingSnake(claim.to)}), first.map((e) => e.${field}).join(','));${claim.stamps ? `
    check('${label}: con ${claim.stamps.field} estampado en el mismo UPDATE', first.every((e) => e.${claim.stamps.field} != null && e.${claim.stamps.field}.getTime() >= before.getTime()), first.map((e) => e.${claim.stamps.field}?.toISOString()).join(','));` : ''}
    const rest = await adapter(10).${claim.method}();
    check('${label}: la pasada siguiente se lleva el resto', same(rest.map((e) => e.id), ids.slice(0, 3)), JSON.stringify(rest.map((e) => e.id)));
    check('${label}: y la tercera, nada', (await adapter(10).${claim.method}()).length === 0);

    // La CARRERA: dos réplicas reclaman a la vez; ninguna fila sale dos veces y ninguna se queda.
    await park();
    const raced = await seed(6, from, () => ({}));
    const replica = () => new ${adapterClass(root)}(${args.map((arg) => (arg === 'context' ? 'new TransactionContext(dataSource, settings)' : arg)).join(', ').replace('sweeps(batch)', 'sweeps(6)')});
    const [a, b] = await Promise.all([replica().${claim.method}(), replica().${claim.method}()]);
    const both = [...a, ...b].map((e) => e.id);
    check('${label}: dos réplicas a la vez no se llevan la misma fila', new Set(both).size === both.length && same(both, raced), \`\${a.length} + \${b.length}\`);

    // SKIP LOCKED: con una fila bloqueada por otra réplica, el reclamo sigue sin ella y sin esperar.
    await park();
    const locked = await seed(3, from, () => ({}));
    const holder = new TransactionContext(dataSource, settings);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const locking = holder.inTransaction(async (manager) => {
      await manager.findOne(${orm}, { where: { id: locked[0] }, lock: { mode: 'pessimistic_write' } });
      await held;
    }, { isolation: 'READ COMMITTED' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    // Sin SKIP LOCKED el reclamo se queda esperando a esa fila hasta el tope de la transacción: es un fallo
    // de esta comprobación, no de la sonda.
    const skipping = await adapter(10).${claim.method}().catch((error) => ({ error }));
    const waited = Date.now() - started;
    release();
    await locking;
    check('${label}: no espera a una fila bloqueada por otra réplica (SKIP LOCKED)', waited < 5_000 && Array.isArray(skipping) && same(skipping.map((e) => e.id), locked.slice(1)), skipping.error ? skipping.error.message : \`\${skipping.length} filas en \${waited} ms\`);
  }`;
    });
    blocks.push(`
// ═══ Reclamos de barrido: ${root.name} ═══
{
  const SAMPLES = [
    ${samples.join(',\n    ')}
  ];
  let next = 0;
  const context = tx;
  const sweeps = (batch) => ({ batchSize: { ${batchKeys.map((key) => `${JSON.stringify(key)}: batch`).join(', ')} }, stalledAfterSeconds: { ${stalledSettings.join(', ')} } });
  const adapter = (batch) => new ${adapterClass(root)}(${args.join(', ')});
  const same = (got, want) => got.length === want.length && [...got].sort().join() === [...want].sort().join();
  // Aparca toda fila de la tabla en un estado que ningún reclamo lee: cada caso empieza sin candidatos.
  const park = () => dataSource.createQueryBuilder().update(${orm}).set({ ${field}: ${enumType}.${screamingSnake(parked.literal)} }).where('1 = 1').execute();
  // Los instantes se escriben en SQL crudo: una columna como created_at es update: false (el updatable =
  // false de JPA) y el ORM la salta en silencio. Tabla, columnas, marcadores y el id, desde los metadatos.
  const meta = dataSource.getMetadata(${orm});
  const rawSet = async (id, values) => {
    const entries = Object.entries(values);
    if (entries.length === 0) return;
    const idColumn = meta.primaryColumns[0];
    const params = { id: idColumn.transformer ? idColumn.transformer.to(id) : id };
    const sets = entries.map(([property, value], i) => {
      params[\`v\${i}\`] = value;
      return \`\${dataSource.driver.escape(meta.findColumnWithPropertyName(property).databaseName)} = :v\${i}\`;
    });
    const [sql, bound] = dataSource.driver.escapeQueryWithParameters(
      \`UPDATE \${dataSource.driver.escape(meta.tableName)} SET \${sets.join(', ')} WHERE \${dataSource.driver.escape(idColumn.databaseName)} = :id\`,
      params,
      {}
    );
    await dataSource.query(sql, bound);
  };
  // Crea filas por el adaptador (como las crearía un caso de uso) y las pone en el estado y con los
  // instantes del caso. Cada muestra se usa una sola vez: la clave natural es única.
  const seed = async (count, state, at) => {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const saved = await adapter(10).save(SAMPLES[next++]());
      await dataSource.createQueryBuilder().update(${orm}).set({ ${field}: state }).where({ id: saved.id }).execute();
      await rawSet(saved.id, at(i));
      ids.push(saved.id);
    }
    return ids;
  };${cases.join('')}
}`);
  }
  return blocks.join('\n');
}

/**
 * Las PURGAS por lotes de las tablas del generador (incremento 10b), lo que en keel-spring mide store-check
 * con BatchedPurge: borran lo caducado y solo eso (lo pendiente del outbox nunca), en lotes —con lotes de
 * DOS filas e instantes repetidos en la frontera—, y con el tope alcanzado dejan el resto a la pasada
 * siguiente, que lo termina.
 */
function purgeBlock(model) {
  const purges = tablePurges(model);
  if (purges.length === 0) return '';
  const ORM = {
    outbox_event: ['OutboxEventOrm', OUTBOX_ORM_TS],
    processed_event: ['ProcessedEventOrm', PROCESSED_EVENT_ORM_TS],
    idempotency_record: ['IdempotencyRecordOrm', IDEMPOTENCY_RECORD_ORM_TS]
  };
  // Cada tabla: cómo es una fila caducada, una vigente y (en el outbox) una pendiente antigua.
  const ROWS = {
    outbox_event: {
      expired: "(at) => ({ id: randomUUID(), destination: 'd', routingKey: 'k', eventType: 'E', payload: '{}', createdAt: at, publishedAt: at, attempts: 1, nextAttemptAt: null, lastError: null })",
      kept: "(at) => ({ id: randomUUID(), destination: 'd', routingKey: 'k', eventType: 'E', payload: '{}', createdAt: at, publishedAt: at, attempts: 1, nextAttemptAt: null, lastError: null })",
      pending: "(at) => ({ id: randomUUID(), destination: 'd', routingKey: 'k', eventType: 'E', payload: '{}', createdAt: at, publishedAt: null, attempts: 3, nextAttemptAt: null, lastError: 'x' })",
      old: 'old(8)',
      recent: 'old(1)'
    },
    processed_event: {
      expired: "(at) => ({ handlerId: 'H', eventId: randomUUID(), processedAt: at })",
      kept: "(at) => ({ handlerId: 'H', eventId: randomUUID(), processedAt: at })",
      old: 'old(15)',
      recent: 'old(1)'
    },
    idempotency_record: {
      expired: "(at) => ({ operationScope: 'op', idempotencyKey: randomUUID(), signature: 's', resourceId: null, createdAt: old(2), expiresAt: at })",
      kept: "(at) => ({ operationScope: 'op', idempotencyKey: randomUUID(), signature: 's', resourceId: null, createdAt: now, expiresAt: at })",
      old: 'old(1)',
      recent: 'new Date(now.getTime() + 3_600_000)'
    }
  };
  const imports = purges.map((purge) => `  const { ${ORM[purge.table][0]} } = await import('${distOf(ORM[purge.table][1])}');`).join('\n');
  const checks = purges
    .map((purge) => {
      const rows = ROWS[purge.table];
      const orm = ORM[purge.table][0];
      return `
  {
    const repository = dataSource.getRepository(${orm});
    await repository.clear();
    const at = ${rows.old};
    // Cinco caducadas, tres con el MISMO instante (caen en el mismo lote), y dos vigentes${rows.pending ? '; y dos pendientes antiguas' : ''}.
    const expired = [at, at, at, new Date(at.getTime() - 1000), new Date(at.getTime() - 2000)].map(${rows.expired});
    const kept = [${rows.recent}, ${rows.recent}].map(${rows.kept});
    ${rows.pending ? `const pending = [old(30), old(30)].map(${rows.pending});
    await repository.insert([...expired, ...kept, ...pending]);` : 'await repository.insert([...expired, ...kept]);'}
    const capped = new TablePurges(scheduling, settings({ batchSize: 2, maxBatches: 1 }), dataSource, tx);
    const first = await capped.${purge.method}(now);
    check('${purge.what}: con el tope alcanzado, la pasada borra un lote y deja el resto', first >= 2 && first < 5 && (await repository.count()) === ${rows.pending ? 9 : 7} - first, \`\${first} borradas\`);
    const purger = new TablePurges(scheduling, settings({ batchSize: 2, maxBatches: 100 }), dataSource, tx);
    const second = await purger.${purge.method}(now);
    check('${purge.what}: la pasada siguiente borra lo que quedaba, en lotes', first + second === 5, \`\${first} + \${second}\`);
    check('${purge.what}: lo vigente no se toca', (await repository.count()) === ${rows.pending ? 4 : 2}, await repository.count());${rows.pending ? `
    check('outbox_event: lo PENDIENTE no se toca nunca, por antiguo que sea', (await repository.countBy({ publishedAt: IsNull() })) === 2);` : ''}
    check('${purge.what}: sin nada caducado, la purga no borra nada', (await purger.${purge.method}(now)) === 0);
  }`;
    })
    .join('');
  return `
// ═══ Purgas por lotes: ${purges.map((purge) => purge.what).join(', ')} ═══
{
  const { TablePurges } = await import('${distOf(TABLE_PURGES_TS)}');
  const { IsNull } = await import('typeorm');
${imports}
  // El reloj no corre aquí: la sonda llama a las purgas a mano, con el mismo DataSource y la misma transacción.
  const scheduling = { register: () => {} };
  const settings = (batch) => ({ outbox: { cron: 'x', retentionDays: 7, ...batch }, processedEvent: { cron: 'x', retentionDays: 14, ...batch }, idempotencyRecord: { cron: 'x', ...batch } });
  const now = new Date();
  const old = (days) => new Date(now.getTime() - days * 86_400_000);${checks}
}`;
}

/**
 * El PLEGADO de un campo con `compare` dentro de la clave natural: el mismo valor en MAYÚSCULAS es la
 * misma clave para el diseño, y solo la sombra plegada lo sabe. Si el adaptador no plegara, las dos
 * filas convivirían.
 */
function foldedBlock(model, root, index, ctx, finder) {
  if (!finder) return '';
  const folded = finder.params.map((param) => root.fields.find((field) => field.name === param.name && field.fold)).filter(Boolean);
  if (folded.length === 0) return '';
  const keys = finder.params.map((param) => `${param.name}: original.${param.name}`);
  const shout = folded.map((field) => `${field.name}: original.${field.name}.toUpperCase()`);
  return `  {
    const shouted = new ${root.name}({ ...stateOf(${sampleEntity(model, root, ctx, `${index}f`)}), ${keys.join(', ')}, ${shout.join(', ')} });
    const rejected = await repository.save(shouted).then(() => null, (error) => error);
    check('${root.name}: ${folded.map((field) => field.name).join(', ')} en mayúsculas es la MISMA clave (compare)', rejected != null && translatePersistenceError(rejected)?.httpStatus === 409, rejected?.message ?? 'se guardó');
  }`;
}

/**
 * La unicidad CONDICIONADA, preguntada al motor: dos filas con la misma clave en el estado de la
 * condición no conviven (y la violación sale traducida), una tercera con la misma clave en OTRO estado
 * sí, y el finder del ocupante encuentra la que está. Es el invariante entero; un índice que se crea sin
 * error y no casa con ninguna fila (el predicado con el literal del diseño) deja pasar la segunda.
 */
function conditionalBlock(model, root, index, ctx) {
  const blocks = [];
  for (const occupant of occupantFinders(model, root)) {
    const whenIndex = (root.indexes ?? []).find((candidate) => candidate.unique && candidate.when?.equals === occupant.state);
    const field = root.fields.find((candidate) => candidate.name === whenIndex?.when.field);
    if (field?.kind !== 'enum') continue;
    const enumDef = model.enums.find((candidate) => candidate.name === field.namedType);
    const inside = enumDef.values.find((value) => value.literal === occupant.state);
    const outside = enumDef.values.find((value) => value !== inside);
    const keys = occupant.params.filter((param) => param.name !== field.name);
    // Si la clave natural cabe entera en la del índice, la segunda fila chocaría por ella antes.
    const natural = new Set((root.naturalKey ?? []).map((key) => keys.find((param) => param.name === key || param.name === `${key}Id`)?.name ?? key));
    if (!inside || !outside || (root.naturalKey?.length > 0 && [...natural].every((key) => keys.some((param) => param.name === key)))) continue;
    ctx.imports.add(`${enumDef.name}|${classPath(DIRS.enums, enumDef.name)}`);
    const state = (constant) => `${field.name}: ${enumDef.name}.${constant}`;
    const sameKeys = keys.map((param) => `${param.name}: first.${param.name}`).join(', ');
    blocks.push(`  {
    const first = new ${root.name}({ ...stateOf(${sampleEntity(model, root, ctx, `${index}c`)}), ${state(inside.constant)} });
    await repository.save(first);
    const second = new ${root.name}({ ...stateOf(${sampleEntity(model, root, ctx, `${index}d`)}), ${sameKeys}, ${state(inside.constant)} });
    try {
      await repository.save(second);
      check('${root.name}: dos con la misma clave en ${occupant.state} no conviven', false, 'el motor aceptó la segunda');
    } catch (error) {
      const translated = translatePersistenceError(error);
      check('${root.name}: dos con la misma clave en ${occupant.state} no conviven, y sale el error del diseño', translated && translated !== 'integrity' && translated.httpStatus === 409, translated?.code ?? translated ?? error?.message);
    }
    const third = new ${root.name}({ ...stateOf(${sampleEntity(model, root, ctx, `${index}e`)}), ${sameKeys}, ${state(outside.constant)} });
    // Sin la condición (la unicidad normal, el invariante CONTRARIO) es esta la que el motor rechaza.
    const kept = await repository.save(third).then(() => null, (error) => error);
    check('${root.name}: la misma clave en otro estado (${outside.literal}) sí convive', kept == null && (await repository.findById(third.id)) != null, kept?.message);
    const occupant = await repository.${occupant.name}(${keys.map((param) => `first.${param.name}`).join(', ')}, ${enumDef.name}.${inside.constant});
    check('${root.name}: ${occupant.name} encuentra la que ocupa ${occupant.state}', occupant?.id === first.id, occupant?.id);
  }`);
  }
  return blocks.join('\n');
}

/** Una columna de texto acotada de la raíz y una fila mínima que la desborda. */
function boundedColumn(model, root) {
  const members = persistedMembers(model, root);
  const bounded = members.find((m) => m.kind === 'scalar' && !m.field.isId && m.field.columns?.length != null && m.field.columns.length < 1000 && !m.field.columns.enum && !m.folded);
  if (!bounded) return null;
  // Solo si las demás columnas obligatorias se pueden rellenar con un literal neutro.
  const required = [];
  for (const member of members) {
    if (member.kind === 'scalar') {
      const spec = member.field.columns;
      if (member === bounded) continue;
      if (spec.nullable && !member.field.isId) continue;
      const literal = literalFor(spec, member, model);
      if (literal == null) return null;
      required.push([spec.name, literal]);
      if (member.folded && member.folded.required) required.push([member.folded.column, `'x'`]);
    } else if (member.kind === 'vo') {
      for (const sub of member.subs) {
        if (!sub.sub.columns || sub.sub.columns.nullable || !sub.ownerRequired) continue;
        const literal = literalFor(sub.sub.columns, { field: sub.sub }, model);
        if (literal == null) return null;
        required.push([sub.column, literal]);
      }
    } else if (member.kind === 'externalRef' && member.relation.required) {
      required.push([member.column, uuidLiteral(model)]);
    }
  }
  if (root.auditTimestamps === 'all') for (const audit of AUDIT_COLUMNS.timestamps) required.push([audit.column, 'CURRENT_TIMESTAMP']);
  const max = bounded.field.columns.length;
  return {
    table: root.tableName,
    column: bounded.field.columns.name,
    max,
    columns: [bounded.field.columns.name, ...required.map(([name]) => name)].map((name) => quoted(model, name)),
    values: [`'${'x'.repeat(max + 1)}'`, ...required.map(([, value]) => value)]
  };
}

function quoted(model, name) {
  return model.stack?.database === 'mysql' ? `\`${name}\`` : `"${name}"`;
}

function uuidLiteral(model) {
  const literal = DATABASES[model.stack?.database ?? 'postgresql'].uuidLiteral;
  return `${literal.prefix}${randomUUID()}${literal.suffix}`;
}

function literalFor(spec, member, model) {
  if (spec.enum) {
    const enumDef = model.enums.find((e) => e.name === member.field.namedType);
    return `'${enumDef?.values?.[0]?.constant ?? 'X'}'`;
  }
  switch (spec.base) {
    case 'uuid':
      return uuidLiteral(model);
    case 'int':
    case 'long':
    case 'decimal':
      return '1';
    case 'boolean':
      return 'true';
    case 'date':
      return `'2026-03-14'`;
    case 'timestamp':
      return 'CURRENT_TIMESTAMP';
    default:
      return `'x'`;
  }
}

// ─── Orquestación ────────────────────────────────────────────────────────────

const runtime = resolveRuntime();
if (!runtime) {
  console.error('No hay podman ni docker en marcha: este check los necesita; el resto de la suite no.');
  process.exit(2);
}

// Un proyecto real para el node_modules (TypeORM y los DOS drivers), que comparten todos los sujetos.
const workspace = makeWorkspace('keel-nest-db-check-');
mountDesign(workspace, NEST_READY_DESIGN.name, NEST_READY_DESIGN);
const generated = await runCommand(workspace, build, `specs/${NEST_READY_DESIGN.name}`, { defaults: true, acceptUnready: true });
const projectDir = path.join(workspace, 'services', `${NEST_READY_DESIGN.name}-nest`);
if (!step('build genera el proyecto de referencia', generated.exitCode === undefined, generated.output.slice(0, 400))) process.exit(1);
const install = run('npm', ['install', '--no-audit', '--no-fund', 'mysql2', 'pg', `amqplib@${AMQPLIB_VERSION}`, `jose@${JOSE_VERSION}`], { cwd: projectDir });
if (!step('npm install (TypeORM y los drivers)', install.status === 0, install.status === 0 ? '' : install.stderr.slice(-800))) process.exit(1);
const tsc = path.join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc');

for (const engine of ENGINES) {
  let db;
  try {
    db = await startDatabase(runtime, engine);
    step(`${engine}: el motor arranca (${DATABASES[engine].image})`, true, `puerto ${db.port}`);
  } catch (error) {
    step(`${engine}: el motor arranca`, false, error.message);
    continue;
  }
  try {
    for (const subject of SUBJECTS) {
      const { manifest, layers } = loadService(path.join(FIXTURES_DIR, subject));
      // Con mensajería, sobre RabbitMQ: el broker que keel-nest genera.
      const { files, model } = planService({ manifest, layers, workspace, stack: { database: engine, ...(layers.messaging ? { broker: 'rabbitmq' } : {}) } });
      if (repositoryRoots(model).length === 0) continue;
      const dir = path.join(workspace, 'db-check', engine, subject);
      for (const file of files) {
        const out = path.join(dir, file.path);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, file.content);
      }
      fs.symlinkSync(path.join(projectDir, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
      const compiled = run(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: dir });
      if (!step(`${engine} · ${subject}: compila`, compiled.status === 0, compiled.stdout.slice(0, 600))) continue;
      const expected = expectedSchema(model, engine);
      const probe = probeScript(model, engine, db, expected);
      fs.writeFileSync(path.join(dir, 'db-probe.mjs'), probe.script);
      // Cada sujeto sobre un esquema limpio: la sonda sincroniza con drop.
      const result = run(process.execPath, ['db-probe.mjs'], { cwd: dir, timeout: 180_000 });
      const marker = result.stdout.split('@@RESULTS@@')[1];
      if (!marker) {
        step(`${engine} · ${subject}: la sonda corre`, false, (result.stderr || result.stdout).slice(-3000));
        continue;
      }
      const checks = JSON.parse(marker);
      const failed = checks.filter((check) => !check.ok);
      for (const check of failed) console.log(`        ✘ ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
      step(
        `${engine} · ${subject} (${probe.root}): esquema, cota, ida y vuelta, versión, unicidad`,
        failed.length === 0,
        `${checks.length - failed.length}/${checks.length}${probe.unsampled.length > 0 ? `; sin muestra: ${probe.unsampled.join(', ')}` : ''}`
      );
    }
  } finally {
    if (!keep) run(runtime, ['rm', '-f', db.name]);
    else console.log(`(contenedor conservado: ${db.name}, puerto ${db.port})`);
  }
}

if (keep) {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-nest-db-check-'));
  fs.cpSync(path.join(workspace, 'db-check'), kept, { recursive: true, filter: (source) => !source.includes('node_modules') });
  console.log(`Sujetos conservados en ${kept}`);
}
const failedSteps = results.filter((result) => !result.ok).length;
console.log(failedSteps === 0 ? `\ndb-check: ${results.length}/${results.length} en verde.` : `\ndb-check: ${failedSteps} paso(s) en rojo.`);
process.exit(failedSteps === 0 ? 0 : 1);
