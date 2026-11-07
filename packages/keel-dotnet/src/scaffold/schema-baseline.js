// El baseline de migraciones del proyecto generado: `infra/export-schema.sh` y `infra/verify-baseline.sh`.
//
// En `local` el esquema lo crea EF Core desde el modelo (EnsureCreated); en `develop` y `production`, SOLO las
// migraciones, que el arranque aplica. Sin ninguna, el servicio pasa todos sus escenarios (corren en local) y no es
// desplegable. El baseline es la primera migración y se escribe con el modelo ya definitivo: es del pase de calidad,
// con `dotnet ef migrations add` (herramienta local, versión fijada). Lo que build deja es el mecanismo para
// revisarlo y para VERIFICARLO, que es lo que no se puede dejar a criterio:
//
//   · export-schema.sh: el DDL que el modelo crearía (`dotnet ef dbcontext script`), sin base, para revisarlo;
//   · verify-baseline.sh: (1) hay migraciones; (2) el modelo no tiene cambios que ninguna recoja
//     (`has-pending-model-changes`); (3) aplicadas a una base VACÍA y aparte —la de los flujos no se toca— dejan el
//     MISMO esquema que el modelo: columnas, índices y constraints, comparados en el catálogo del motor. El tercero
//     es el que caza una migración editada a mano: el snapshot del modelo no cambia con ella, así que el segundo
//     no la ve.
//
// Sobre PostgreSQL y MySQL, los dos motores relacionales de keel-dotnet: lo que cambia es el cliente con el que se crean
// las bases aparte y el catálogo con el que se comparan (baselinePlatform).

import fs from 'node:fs';
import path from 'node:path';
import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { GENERATOR_TABLES, STEP_MARK, createdTablesInSql, isGeneratorStep, schemaStepFiles } from '@keel-system/keel-core/gen/schema-steps';
import { MIGRATIONS_TABLE } from './persistence-runtime.js';
import { dbContextClass, persistenceNamespace, usesRelational } from './persistence.js';
import { csFile, csString, solution } from './render.js';
import { MYSQL_GUID_FORMAT, relationalEngine, usesMySql } from './relational-engine.js';

export const EXPORT_SCHEMA_SH = 'infra/export-schema.sh';
export const VERIFY_BASELINE_SH = 'infra/verify-baseline.sh';
/** Dónde deja el pase de calidad las migraciones, dentro del proyecto Infrastructure. */
export const MIGRATIONS_DIR = 'Persistence/Migrations';

export function usesSchemaBaseline(model) {
  return usesRelational(model);
}

/** El comando que crea el baseline, el mismo en la skill, el agente de calidad y las redes del paquete. */
export function baselineCommand(model) {
  return `dotnet ef migrations add Baseline --project ${solution(model).infrastructure.dir} --output-dir ${MIGRATIONS_DIR}`;
}

export function generate(model) {
  if (!usesSchemaBaseline(model)) return [];
  return [
    { path: EXPORT_SCHEMA_SH, content: exportSchemaScript(model) },
    { path: VERIFY_BASELINE_SH, content: verifyBaselineScript(model) }
  ];
}

// ─── Los pasos de esquema de build (inc. 2b del plan 2.26) ───────────────────────────────────────
//
// Una tabla del generador (outbox, guarda de mensajes, idempotencia, reconciliación, cronómetro) que aparece en un
// proyecto con base desplegada llega como una migración de EF que escribe build (keel-core/gen/schema-steps.js): el
// baseline ya se aplicó, y sin el paso la tabla no existiría fuera de `local`. Qué falta se deduce de las migraciones de
// disco ANTES de escribir: un `migrationBuilder.CreateTable(name: …)` de las de `dotnet ef` o el SQL de un paso anterior
// de build. Sin ninguna migración no hay base desplegada, y el baseline que cree el pase de calidad traerá la tabla.
//
// El paso es una clase `Migration` con sus dos atributos y el SQL de `schemaStepSql` en `migrationBuilder.Sql`, una
// llamada por sentencia y sin cambiar un byte: es el mismo SQL que los pasos de los otros tres. No lleva `.Designer.cs`
// (el modelo de destino es del modelo entero, que build no conoce) ni toca el `ModelSnapshot`, que es de `dotnet ef`.
//
// Lo que NO resuelve build, y por eso es trabajo de la evolución: desde EF 9, `MigrateAsync` compara el modelo con el
// SNAPSHOT y lanza `PendingModelChangesWarning` si este no recoge una entidad; y el siguiente `migrations add` volvería a
// crear la tabla. El snapshot solo lo escribe `dotnet ef`, así que el agente añade una migración que solo lo sincroniza
// (Up y Down vacíos: la tabla ya la crea el paso). Mientras el snapshot no nombre la tabla, EVOLUTION.md lo pide y
// `--check` sale en rojo (`snapshotWork`).

/** Una migración de EF por su nombre de archivo: `<yyyyMMddHHmmss>_<Nombre>.cs`, sin el `.Designer.cs` ni el snapshot. */
const EF_MIGRATION = /^(\d{14})_(\w+)\.cs$/;
const EF_CREATE_TABLE = /\.CreateTable\(\s*name:\s*"(\w+)"/g;

/** El directorio de las migraciones, relativo al proyecto generado. */
export function migrationsDir(model) {
  return `${solution(model).infrastructure.dir}/${MIGRATIONS_DIR}`;
}

/** Las tablas del generador que este proyecto emite: las que tienen su fila mapeada con `row.ToTable` entre los archivos de build. */
export function generatorTables(files) {
  const contents = files.map((file) => (typeof file.content === 'string' ? file.content : ''));
  return GENERATOR_TABLES.filter((table) => contents.some((content) => content.includes(`row.ToTable(${csString(table.table)})`)));
}

/** Las tablas que crea una migración: las de `dotnet ef` (`CreateTable`) y las del SQL de un paso de build. */
export function createdTablesInMigration(content) {
  return [...[...String(content).matchAll(EF_CREATE_TABLE)].map((match) => match[1].toLowerCase()), ...createdTablesInSql(content)];
}

const pad = (value, width = 2) => String(value).padStart(width, '0');
const stamp = (date) =>
  `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;

/**
 * La marca del paso: un segundo después de la mayor de las migraciones de disco. `nextStepVersion` da la mayor más uno
 * como ENTERO, y `…59` + 1 no es una hora; aquí se suma el segundo en el calendario. Determinista (build no mira el
 * reloj) y anterior a cualquier `migrations add` posterior, que usa la hora de verdad. Una marca de disco que no sea una
 * fecha se respeta como número: el orden de EF es el del texto, y el entero siguiente sigue siendo mayor.
 */
export function stepTimestamp(version) {
  const previous = pad(version - 1, 14);
  const [, y, mo, d, h, mi, s] = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(previous) ?? [];
  const date = y ? new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))) : null;
  if (!date || Number.isNaN(date.getTime()) || stamp(date) !== previous) return pad(version, 14);
  return stamp(new Date(date.getTime() + 1000));
}

/** `keel_idempotency_record` → `KeelIdempotencyRecord`: el nombre de la clase y del id de la migración. */
const pascalOf = (slug) => slug.replace(/(^|_)([a-z0-9])/g, (_m, _s, c) => c.toUpperCase());

/** Las sentencias de `schemaStepSql`, sin tocarlas: unidas otra vez con una línea en blanco devuelven el mismo texto. */
export function stepStatements(sql) {
  return sql.replace(/\n$/, '').split('\n\n');
}

/** Un literal verbatim de C#: el texto byte a byte, saltos de línea incluidos. */
const verbatim = (text) => `@"${text.replaceAll('"', '""')}"`;

function renderStep(model, { version, slug, sql, header }) {
  const className = pascalOf(slug);
  const id = `${stepTimestamp(version)}_${className}`;
  const context = dbContextClass(model);
  const body = `/// <summary>
/// Paso de esquema de build: crea tablas del generador que la base desplegada no tenía. Sin modelo de destino
/// (.Designer.cs): el snapshot lo sincroniza una migración de dotnet ef con Up y Down vacíos.
/// </summary>
[DbContext(typeof(${context}))]
[Migration(${csString(id)})]
public partial class ${className} : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
${stepStatements(sql).map((statement) => `        migrationBuilder.Sql(${verbatim(statement)});`).join('\n')}
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        // Build no deshace sus pasos: el SQL es idempotente y una tabla del generador no se retira con un rollback.
    }
}`;
  return {
    name: `${id}.cs`,
    content: csFile({
      namespace: `${persistenceNamespace(model)}.Migrations`,
      usings: ['Microsoft.EntityFrameworkCore.Infrastructure', 'Microsoft.EntityFrameworkCore.Migrations'],
      header: header.map((line) => `// ${line}`).join('\n'),
      body
    })
  };
}

const STEP_TABLES = new RegExp(`${STEP_MARK} ([\\w ]+)`);

/**
 * Las tablas de los pasos de build que el ModelSnapshot de disco todavía no nombra (`.ToTable("<tabla>"`), con el paso que
 * las crea. Es trabajo del agente hasta que lo sincronice, y se deriva de disco en cada pasada: nada que arrastrar.
 */
export function snapshotGaps(projectDir, dir, steps) {
  const absolute = path.join(projectDir, dir);
  const snapshots = fs.existsSync(absolute) ? fs.readdirSync(absolute).filter((name) => name.endsWith('ModelSnapshot.cs')) : [];
  const snapshot = snapshots.map((name) => fs.readFileSync(path.join(absolute, name), 'utf8')).join('\n');
  return steps.flatMap((step) => {
    const tables = (STEP_TABLES.exec(step.content)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
    const missing = tables.filter((table) => !snapshot.includes(`.ToTable(${csString(table)}`));
    return missing.length > 0 ? [{ step: step.path, tables: missing }] : [];
  });
}

/** El nombre de la migración que sincroniza el snapshot: `SyncIdempotencyRecordSnapshot`. Sin el prefijo de los de build. */
export function syncMigrationName(tables) {
  return `Sync${tables.map((table) => pascalOf(table.replace(/^keel_/, ''))).join('')}Snapshot`;
}

/** Lo que dice EVOLUTION.md de un snapshot sin sincronizar. */
export function snapshotNote(model, { step, tables }) {
  const infrastructure = solution(model).infrastructure.dir;
  return (
    `**El ModelSnapshot de EF no recoge ${tables.map((table) => `\`${table}\``).join(', ')}**, que crea el paso de build ` +
    `\`${step}\`: hasta que lo haga, EF ve el modelo por delante (\`PendingModelChangesWarning\`; medido con ` +
    '`dotnet ef database update`: en PostgreSQL sale en rojo, en MySQL avisa y aplica) y el siguiente `migrations add` volvería a crear la tabla. El snapshot solo lo escribe ' +
    `\`dotnet ef\`: \`dotnet ef migrations add ${syncMigrationName(tables)} --project ${infrastructure} --output-dir ${MIGRATIONS_DIR}\`, ` +
    'VACÍA los cuerpos de `Up` y `Down` de la migración que crea (la tabla ya la crea el paso; el `.Designer.cs` y el ' +
    'snapshot se quedan como los deja) y `bash infra/verify-baseline.sh` en `OK`. Detalle en `references/migrations.md` ' +
    'de la skill `keel-dotnet-database`.'
  );
}

/**
 * Los pasos de EF que build emite en esta pasada (los suyos de antes, tal cual, y el nuevo si hace falta), con lo que
 * EVOLUTION.md tiene que decir: `added` los nombra y `work` lleva lo que no tiene paso y el snapshot sin sincronizar.
 * Vacío en el modelo documental: allí no hay migraciones.
 */
export function schemaSteps(model, files, projectDir) {
  if (!usesSchemaBaseline(model)) return { files: [], added: [], work: [] };
  const dir = migrationsDir(model);
  const isMigration = (name) => EF_MIGRATION.test(name);
  const steps = schemaStepFiles({
    projectDir,
    dir,
    tables: generatorTables(files),
    engine: relationalEngine(model),
    isMigration,
    // Toda migración de EF que no sea de build es del baseline en adelante: la base desplegada existe.
    isBaseline: (name) => isMigration(name) && !isGeneratorStep(fs.readFileSync(path.join(projectDir, dir, name), 'utf8')),
    versionOf: (name) => EF_MIGRATION.exec(name)?.[1] ?? null,
    renderStep: (step) => renderStep(model, step),
    createdTables: createdTablesInMigration
  });
  const gaps = snapshotGaps(projectDir, dir, steps.files);
  return { ...steps, work: [...steps.work, ...gaps.map((gap) => snapshotNote(model, gap))] };
}

function exportSchemaScript(model) {
  const infrastructure = solution(model).infrastructure.dir;
  return `#!/usr/bin/env bash
# export-schema.sh — el DDL que el modelo de EF Core de ${model.service.name} crearía, para REVISARLO
# antes de escribir el baseline de migraciones. No necesita base: lo deriva del modelo.
#
# Uso (desde la raíz del proyecto):
#   bash infra/export-schema.sh      → build/schema/model.sql
# Después, el baseline (pase de calidad):
#   ${baselineCommand(model)}
#   bash infra/verify-baseline.sh
set -u
cd "$(dirname "$0")/.."
mkdir -p build/schema

if ! dotnet tool restore >build/schema/tool-restore.log 2>&1; then
  echo "dotnet tool restore falló (¿red, o el SDK?):" >&2
  tail -20 build/schema/tool-restore.log >&2
  exit 1
fi
if ! dotnet ef dbcontext script --project ${infrastructure} --output build/schema/model.sql >build/schema/export.log 2>&1; then
  echo "dotnet ef no pudo derivar el DDL del modelo (¿compila la solución?):" >&2
  tail -30 build/schema/export.log >&2
  exit 1
fi
echo "DDL del modelo → build/schema/model.sql"
`;
}

/**
 * Lo que el script necesita de cada motor: el cliente con el que habla con la base dentro del contenedor, la base
 * desde la que crea y borra las de prueba, la cadena de conexión de `dotnet ef` y el CATÁLOGO del esquema en UNA columna
 * ordenada: columnas (tipo, cota, escala, nulabilidad; en MySQL también la collation y la expresión de una columna
 * generada), índices (columnas, unicidad y, en PostgreSQL, predicado) y constraints. El historial de migraciones no es
 * del modelo: fuera de los dos catálogos.
 */
function baselinePlatform(model, dbName) {
  const entry = DATABASES[relationalEngine(model)];
  if (usesMySql(model)) {
    // Con root: crear y borrar bases no es del usuario del servicio, que solo tiene la suya. La contraseña de root es la
    // del compose del catálogo.
    const password = entry.composeService(dbName).environment.MYSQL_ROOT_PASSWORD;
    const catalog = [
      'SELECT x FROM (',
      "  SELECT CONCAT('column ', table_name, '.', column_name, ' ', column_type, ' ', is_nullable, ' ', COALESCE(collation_name, '-'), ' ', COALESCE(NULLIF(generation_expression, ''), '-')) AS x",
      `    FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name <> '${MIGRATIONS_TABLE}'`,
      "  UNION ALL SELECT CONCAT('index ', table_name, ' ', index_name, ' ', IF(non_unique = 0, 'unique', 'non-unique'), ' (', GROUP_CONCAT(column_name ORDER BY seq_in_index), ')')",
      `    FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name <> '${MIGRATIONS_TABLE}' GROUP BY table_name, index_name, non_unique`,
      "  UNION ALL SELECT CONCAT('constraint ', table_name, ' ', constraint_name, ' ', constraint_type)",
      `    FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name <> '${MIGRATIONS_TABLE}'`,
      "  UNION ALL SELECT CONCAT('reference ', table_name, ' ', constraint_name, ' ', referenced_table_name, ' ', delete_rule)",
      '    FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE()',
      ') catalog ORDER BY x'
    ].join(' ');
    return {
      client: `db_in() {
  local database="$1"
  shift
  if [ -n "$database" ]; then set -- "$@" "$database"; fi
  "$RUNTIME" exec -i "$CONTAINER" mysql -h db -u root -p'${password}' -N -B "$@"
}`,
      admin: 'db_in ""',
      onDatabase: (database) => `db_in "${database}"`,
      execute: (sql) => `-e "${sql}"`,
      applyFile: '',
      connection: `Server=localhost;Port=${entry.port};Database=$FROM_MIGRATIONS;User ID=root;Password=${password};GuidFormat=${MYSQL_GUID_FORMAT}`,
      errorPattern: 'error|exception',
      catalog
    };
  }
  const user = entry.user(dbName);
  const password = entry.password;
  const catalog = [
    'SELECT x FROM (',
    "  SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || coalesce('(' || character_maximum_length || ')', '') || coalesce(' ' || numeric_precision || ',' || numeric_scale, '') || ' ' || is_nullable AS x",
    `    FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '${MIGRATIONS_TABLE}'`,
    "  UNION ALL SELECT 'index ' || indexdef",
    `    FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '${MIGRATIONS_TABLE}'`,
    "  UNION ALL SELECT 'constraint ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)",
    `    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text <> '${MIGRATIONS_TABLE}'`,
    ') catalog ORDER BY x'
  ].join(' ');
  return {
    client: `db_in() {
  local database="$1"
  shift
  "$RUNTIME" exec -i "$CONTAINER" env PGPASSWORD='${password}' psql -h db -U '${user}' -d "$database" -v ON_ERROR_STOP=1 -q -t -A "$@"
}`,
    admin: 'db_in postgres',
    onDatabase: (database) => `db_in "${database}"`,
    execute: (sql) => `-c "${sql}"`,
    applyFile: ' -f -',
    connection: `Host=localhost;Port=${entry.port};Database=$FROM_MIGRATIONS;Username=${user};Password=${password}`,
    errorPattern: 'error|exception|42[0-9A-Z]{3}',
    catalog
  };
}

function verifyBaselineScript(model) {
  const infrastructure = solution(model).infrastructure.dir;
  const dbName = model.service.name.replaceAll('-', '_');
  const container = `${model.service.name}-db`;
  const platform = baselinePlatform(model, dbName);
  return `#!/usr/bin/env bash
# verify-baseline.sh — comprueba que las migraciones de EF Core de ${model.service.name} crean EXACTAMENTE el
# esquema del modelo, que es lo que el arranque aplica en develop y production.
#
#   1. hay migraciones (${infrastructure}/${MIGRATIONS_DIR});
#   2. el modelo no tiene cambios que ninguna migración recoja (dotnet ef … has-pending-model-changes);
#   3. aplicadas a una base VACÍA dejan el mismo catálogo (columnas, índices, constraints) que el DDL del
#      modelo. Es lo que caza una migración editada a mano: el snapshot no cambia con ella y el paso 2 no la ve.
#
# Trabaja sobre dos bases APARTE en el contenedor de la base de prueba (las crea y las borra): la de los flujos
# no se toca. Necesita la infraestructura arriba (bash infra/up.sh).
#
# Sale con 0 y «baseline: OK», o con 1 y «baseline: KO» y la diferencia.
set -u
cd "$(dirname "$0")/.."
mkdir -p build/schema

RUNTIME="\${CONTAINER_RUNTIME:-}"
if [ -z "$RUNTIME" ]; then
  if docker --version >/dev/null 2>&1; then RUNTIME=docker; else RUNTIME=podman; fi
fi
CONTAINER="${container}"
MIGRATIONS="${infrastructure}/${MIGRATIONS_DIR}"
FROM_MIGRATIONS="${dbName}_baseline_migrations"
FROM_MODEL="${dbName}_baseline_model"

ko() {
  echo "baseline: KO — $1"
  shift
  for line in "$@"; do echo "  $line"; done
  drop_scratch
  exit 1
}

${platform.client}

drop_scratch() {
  ${platform.admin} ${platform.execute('DROP DATABASE IF EXISTS $FROM_MIGRATIONS')} >/dev/null 2>&1
  ${platform.admin} ${platform.execute('DROP DATABASE IF EXISTS $FROM_MODEL')} >/dev/null 2>&1
}

if ! ls "$MIGRATIONS"/*.cs >/dev/null 2>&1; then
  echo "baseline: KO — no hay migraciones en $MIGRATIONS: créalas con"
  echo "  ${baselineCommand(model)}"
  exit 1
fi
if ! dotnet tool restore >build/schema/tool-restore.log 2>&1; then
  echo "baseline: KO — dotnet tool restore falló:"
  tail -20 build/schema/tool-restore.log | sed 's/^/  /'
  exit 1
fi

# 2. Ningún cambio del modelo sin migración.
if ! dotnet ef migrations has-pending-model-changes --project ${infrastructure} >build/schema/pending.log 2>&1; then
  echo "baseline: KO — el modelo tiene cambios que ninguna migración recoge (o no compila):"
  grep -v '^Build' build/schema/pending.log | tail -20 | sed 's/^/  /'
  exit 1
fi

# 3. En vivo: las migraciones sobre una base vacía, y el DDL del modelo sobre otra.
if ! ${platform.admin} ${platform.execute('SELECT 1')} >/dev/null 2>&1; then
  echo "baseline: KO — la base de prueba no responde: bash infra/up.sh && bash infra/validate-infra.sh"
  exit 1
fi
drop_scratch
${platform.admin} ${platform.execute('CREATE DATABASE $FROM_MIGRATIONS')} >/dev/null || ko "no se pudo crear la base $FROM_MIGRATIONS"
${platform.admin} ${platform.execute('CREATE DATABASE $FROM_MODEL')} >/dev/null || ko "no se pudo crear la base $FROM_MODEL"

connection="${platform.connection}"
if ! dotnet ef database update --project ${infrastructure} --connection "$connection" >build/schema/update.log 2>&1; then
  ko "las migraciones no se aplican sobre una base vacía:" "$(grep -iE '${platform.errorPattern}' build/schema/update.log | head -10)"
fi
if ! dotnet ef dbcontext script --project ${infrastructure} --output build/schema/model.sql >build/schema/export.log 2>&1; then
  ko "dotnet ef no pudo derivar el DDL del modelo" "$(tail -10 build/schema/export.log)"
fi
if ! ${platform.onDatabase('$FROM_MODEL')}${platform.applyFile} <build/schema/model.sql >build/schema/model-apply.log 2>&1; then
  ko "el DDL del modelo no se aplica:" "$(tail -10 build/schema/model-apply.log)"
fi

CATALOG="${platform.catalog}"
${platform.onDatabase('$FROM_MIGRATIONS')} ${platform.execute('$CATALOG')} | tr -d '\\r' >build/schema/catalog-migrations.txt
${platform.onDatabase('$FROM_MODEL')} ${platform.execute('$CATALOG')} | tr -d '\\r' >build/schema/catalog-model.txt
if ! diff -u build/schema/catalog-model.txt build/schema/catalog-migrations.txt >build/schema/catalog.diff; then
  echo "baseline: KO — las migraciones no crean el esquema del modelo (- modelo, + migraciones):"
  grep -E '^[-+][^-+]' build/schema/catalog.diff | head -30 | sed 's/^/  /'
  drop_scratch
  exit 1
fi
drop_scratch
echo "baseline: OK — $(wc -l <build/schema/catalog-model.txt | tr -d ' ') elementos del esquema, los mismos en el modelo y en las migraciones."
`;
}
