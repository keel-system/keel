// Los PASOS DE ESQUEMA del generador (PLAN-DSL-226-PLAZOS.md, incremento 2b): cómo llega una tabla del generador a una
// base ya desplegada.
//
// Hasta la 2.26 ninguno de los cuatro sabía hacerlo. El esquema de un proyecto nace en su baseline (la exporta el agente
// en keel-spring, keel-nest y keel-dotnet; la escribe build en keel-go) y después solo cambia por pasos, que escribe el
// agente cuando el DISEÑO cambia. Pero una tabla del generador —el outbox, la guarda de mensajes, el registro de
// idempotencia, la marca de reconciliación y, desde la 2.26, `keel_timer`— puede aparecer sin que el diseño cambie: basta
// con un generador nuevo. Con `build --refresh` su entidad llega, y en `develop` y `production` el arranque cae (el
// `validate` de Hibernate, el `MigrateAsync` de EF con cambios pendientes, la tabla ausente en keel-nest y keel-go).
//
// NEUTRAL: qué tablas faltan en la base desplegada, qué SQL las crea y cómo se llama el paso es la misma decisión para los
// cuatro. Cada generador pone tres cosas suyas: qué tablas del generador emite hoy, de qué archivos se deduce lo que la
// base ya tiene (sus migraciones, leídas ANTES de escribir) y cómo envuelve el SQL en un paso de su herramienta (un `.sql`
// de Flyway o de goose, una clase de TypeORM, una migración de EF con `migrationBuilder.Sql`).
//
// Tres reglas:
//   1. LO QUE LA BASE YA TIENE SE LEE DE LAS MIGRACIONES, no de un registro aparte. Una tabla que crea cualquier paso
//      —la baseline, un paso del agente, uno anterior del generador— está cubierta. Así un proyecto anterior al mecanismo
//      no recibe un paso que repita lo que su baseline ya creó, y no hay un segundo estado que pueda divergir del disco.
//   2. SIN BASELINE NO HAY PASO: un proyecto que todavía no migra por pasos no tiene base desplegada que proteger, y la
//      baseline que exporte el agente traerá la tabla.
//   3. UN PASO EMITIDO NO CAMBIA NUNCA. La herramienta guarda su suma (Flyway, EF) o simplemente no lo reaplica (goose,
//      TypeORM): reescribirlo rompería el arranque de toda base que ya lo aplicó. El generador vuelve a emitir cada paso
//      suyo tal como está en disco (si no, el manifiesto lo daría por huérfano), y el SQL es idempotente
//      (`IF NOT EXISTS`), porque en keel-go la baseline sí la reescribe build y una base nueva aplicaría las dos.
//
// Lo que no hace: cambiar la FORMA de una tabla que la base ya tiene (una columna nueva en `outbox_event`). Eso no se
// deduce del nombre de la tabla, y el día que pase es un `ALTER` con su propia medida.

import fs from 'node:fs';
import path from 'node:path';
import { OUTBOX_EVENT, PROCESSED_EVENT, storeColumns } from './messaging-stores.js';
import { IDEMPOTENCY_RECORD } from './request-idempotency.js';
import { RECONCILIATION_CLAIM } from './reconciliation-stores.js';
import { KEEL_TIMER } from './timer-store.js';

/** Las tablas del generador: mecánica de multi-instancia, no algo que el diseño declare. En orden de creación. */
export const GENERATOR_TABLES = Object.freeze([OUTBOX_EVENT, PROCESSED_EVENT, IDEMPOTENCY_RECORD, RECONCILIATION_CLAIM, KEEL_TIMER]);

/** El prefijo del nombre de un paso del generador: lo que lo distingue de los del agente. */
export const STEP_PREFIX = 'keel';

/** La marca que lleva todo paso del generador en su primera línea de comentario, con las tablas que crea. */
export const STEP_MARK = 'keel:generator-step';

// ─── El SQL ──────────────────────────────────────────────────────────────────

/** Los motores para los que hay pasos. Otro motor relacional no los tiene hasta que se mida: las tablas las lleva el agente. */
export const STEP_ENGINES = Object.freeze(['postgresql', 'mysql']);

/**
 * El tipo físico de una columna de las tablas del generador. Es el que dan a ese tipo los cuatro servidores —el que valida
 * Hibernate en keel-spring y el de la baseline de keel-go (`physicalType`, comparado en las pruebas)—, porque el paso tiene
 * que dejar la base igual que la habría dejado la baseline.
 */
export function storeColumnType(column, engine) {
  const mysql = engine === 'mysql';
  switch (column.base) {
    case 'uuid':
      return mysql ? 'binary(16)' : 'uuid';
    case 'int':
      return mysql ? 'int' : 'integer';
    case 'timestamp':
      return mysql ? 'datetime(6)' : 'timestamp(6) with time zone';
    case 'text':
      return 'text';
    case 'string':
      return `varchar(${column.length ?? 255})`;
    default:
      throw new Error(`tipo de columna sin paso de esquema: ${column.base} (${column.name})`);
  }
}

/**
 * El SQL que crea unas tablas del generador, idempotente: aplicado sobre una base que ya las tiene no hace nada. La clave
 * primaria va sin nombre (PostgreSQL la llama `<tabla>_pkey`, como la de la baseline); la unicidad y los índices, con los
 * nombres de keel-core, que son contrato de los cuatro servidores. MySQL no tiene `CREATE INDEX IF NOT EXISTS`: allí los
 * índices van dentro del `CREATE TABLE`.
 */
export function schemaStepSql(engine, tables) {
  if (!STEP_ENGINES.includes(engine)) throw new Error(`motor sin pasos de esquema del generador: ${engine}`);
  const mysql = engine === 'mysql';
  const statements = [];
  for (const table of tables) {
    const columns = storeColumns(table, 'relational');
    const lines = columns.map((column) => `    ${column.name} ${storeColumnType(column, engine)}${column.nullable ? '' : ' NOT NULL'}`);
    lines.push(`    PRIMARY KEY (${columns.filter((column) => column.primary).map((column) => column.name).join(', ')})`);
    for (const unique of table.uniques ?? []) lines.push(`    CONSTRAINT ${unique.name} UNIQUE (${unique.columns.join(', ')})`);
    if (mysql) for (const index of table.indexes ?? []) lines.push(`    INDEX ${index.name} (${index.columns.join(', ')})`);
    statements.push(`CREATE TABLE IF NOT EXISTS ${table.table} (\n${lines.join(',\n')}\n)${mysql ? ' ENGINE=InnoDB' : ''};`);
    if (!mysql) {
      for (const index of table.indexes ?? []) {
        statements.push(`CREATE INDEX IF NOT EXISTS ${index.name} ON ${table.table} (${index.columns.join(', ')});`);
      }
    }
  }
  return statements.join('\n\n') + '\n';
}

/** La cabecera de un paso, como líneas de comentario SIN el prefijo del lenguaje: la primera es la marca. */
export function stepHeader(tables) {
  return [
    `${STEP_MARK} ${tables.map((table) => table.table).join(' ')}`,
    'Paso de esquema de build: crea las tablas del generador que la base desplegada no tiene.',
    'No lo edites ni lo renumeres: una base que ya lo aplicó no lo vuelve a leer. Tus pasos van después.'
  ];
}

/** El nombre del paso, sin versión ni extensión: `keel_outbox_event`, y `keel_timer` para `keel_timer` (el prefijo no se repite). */
export function stepSlug(tables) {
  return [STEP_PREFIX, ...tables.map((table) => table.table.replace(new RegExp(`^${STEP_PREFIX}_`), ''))].join('_');
}

// ─── Lo que la base ya tiene ─────────────────────────────────────────────────

// Las comillas pueden venir escapadas: una migración de TypeORM lleva su SQL dentro de un literal (`\"x\"`).
const QUOTE = String.raw`(?:\\?[\x60"[\]])?`;
const CREATE_TABLE = new RegExp(String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?(?:${QUOTE}\w+${QUOTE}\.)?${QUOTE}(\w+)`, 'gi');

/** Las tablas que crea un texto SQL (un paso de Flyway o goose, o el SQL dentro de una migración de TypeORM). */
export function createdTablesInSql(text) {
  return [...String(text).matchAll(CREATE_TABLE)].map((match) => match[1].toLowerCase());
}

/** Si un archivo es un paso del generador: lleva la marca en su cabecera. */
export function isGeneratorStep(content) {
  return String(content).includes(STEP_MARK);
}

/**
 * La siguiente versión entera de una serie de pasos: una más que la mayor. `versionOf` saca la versión de un nombre (o
 * null si el archivo no es un paso); la parte entera manda, así que tras un `V2_1` de Flyway viene un `3`.
 */
export function nextStepVersion(names, versionOf) {
  const versions = names.map(versionOf).filter((version) => version != null).map((version) => Math.floor(Number(version)));
  return versions.length > 0 ? Math.max(...versions) + 1 : 1;
}

/**
 * El plan de pasos de esta pasada de build.
 *
 *   tables      las tablas del generador que el proyecto emite hoy (de GENERATOR_TABLES);
 *   migrations  los archivos de migraciones que hay en disco ANTES de escribir: `{ name, content }`;
 *   baseline    si entre ellos está la baseline (sin ella no hay base desplegada que proteger, regla 2);
 *   engine      el motor relacional elegido;
 *   createdTables  cómo sacar las tablas que crea un archivo (por defecto, leyendo su SQL).
 *
 * Devuelve los pasos del generador que ya existen (para volver a emitirlos tal cual, regla 3), las tablas que la base no
 * tiene y, si hay alguna, si el motor tiene pasos (`unsupported` cuando no: entonces las lleva el agente).
 */
export function planSchemaSteps({ tables, migrations, baseline, engine, createdTables = createdTablesInSql }) {
  const existing = migrations.filter((file) => isGeneratorStep(file.content));
  if (!baseline) return { existing, missing: [], unsupported: false };
  const covered = new Set(migrations.flatMap((file) => createdTables(file.content)));
  const missing = GENERATOR_TABLES.filter((table) => tables.includes(table) && !covered.has(table.table));
  return { existing, missing, unsupported: missing.length > 0 && !STEP_ENGINES.includes(engine) };
}

/** Lo que dice EVOLUTION.md de un motor sin pasos del generador: trabajo del agente, con las tablas nombradas. */
export function unsupportedStepNote(engine, missing) {
  return (
    `**Tablas del generador sin paso de esquema** (${missing.map((table) => `\`${table.table}\``).join(', ')}): el motor ` +
    `\`${engine}\` no tiene pasos del generador medidos. Si hay una base desplegada, el paso que las crea lo escribe el ` +
    'agente, con el DDL que da la baseline exportada.'
  );
}

// ─── El cableado en `build`, el mismo para los cuatro ────────────────────────

/**
 * Los archivos de los pasos del generador de esta pasada, leyendo las migraciones del proyecto ANTES de escribir.
 *
 *   dir          el directorio de las migraciones, relativo al proyecto (`src/main/resources/db/migration`);
 *   isMigration  qué nombres de ese directorio son pasos (no el README);
 *   isBaseline   cuál es la baseline;
 *   versionOf    la versión de un paso por su nombre (`nextStepVersion`);
 *   renderStep   `({ version, slug, sql, header, tables }) → { name, content }`: el paso con la forma de su herramienta.
 *
 * Devuelve `files` (los pasos que ya existían, tal cual, y el nuevo, si hace falta), `added` (las rutas nuevas, para
 * EVOLUTION.md) y `work` (la nota de un motor sin pasos). Lo que hay en disco es el estado de la base desplegada: por eso
 * se lee antes de que `materializeProject` toque nada.
 */
export function schemaStepFiles({ projectDir, dir, tables, engine, isMigration, isBaseline, versionOf, renderStep, createdTables }) {
  const absolute = path.join(projectDir, dir);
  const names = fs.existsSync(absolute) ? fs.readdirSync(absolute).filter(isMigration).sort() : [];
  const migrations = names.map((name) => ({ name, content: fs.readFileSync(path.join(absolute, name), 'utf8') }));
  const plan = planSchemaSteps({ tables, migrations, baseline: names.some(isBaseline), engine, createdTables });
  const files = plan.existing.map((file) => ({ path: `${dir}/${file.name}`, content: file.content }));
  if (plan.missing.length === 0) return { files, added: [], work: [] };
  if (plan.unsupported) return { files, added: [], work: [unsupportedStepNote(engine, plan.missing)] };
  const step = renderStep({
    version: nextStepVersion(names, versionOf),
    slug: stepSlug(plan.missing),
    sql: schemaStepSql(engine, plan.missing),
    header: stepHeader(plan.missing),
    tables: plan.missing
  });
  const relative = `${dir}/${step.name}`;
  return { files: [...files, { path: relative, content: step.content }], added: [relative], work: [] };
}
