// El BASELINE DE MIGRACIONES del proyecto generado: cómo nace la primera migración y cómo se
// demuestra que crea el esquema que las entidades esperan.
//
// En `local` el esquema lo crea y altera TypeORM (`synchronize`); en `develop` y `production` lo
// crean las migraciones de `src/migrations/` al arrancar (`migrationsRun`). Sin baseline, el servicio
// compila y pasa sus escenarios —que corren en `local`— pero no es desplegable. El baseline solo se
// puede escribir cuando las entidades son definitivas, así que es del pase de calidad; lo que build
// le deja es el mecanismo, no el archivo:
//
//   · `bash infra/export-schema.sh` vacía el esquema de la base local (`reset-db.sh --schema`: en local
//     lo vuelve a crear synchronize al arrancar) y le pide a TypeORM el DDL COMPLETO de las entidades
//     (`createSchemaBuilder().log()` contra un esquema vacío) → `build/schema/baseline.sql` para
//     revisarlo y `build/schema/<migración>.ts`, la clase que se copia a `src/migrations/`.
//   · `bash infra/verify-baseline.sh` vacía el esquema, APLICA las migraciones (lo mismo que hace el
//     arranque en develop) y le pide a TypeORM la diferencia con las entidades: tiene que ser
//     ninguna. Es la prueba en vivo del baseline, y aquí sí se puede ejecutar dentro del pipeline: la
//     base local no tiene historial que proteger, y la siguiente pasada de la suite la recrea.
//
// En keel-spring la prueba en vivo del baseline queda PENDIENTE para el diseñador (Flyway en local
// exigiría borrar el volumen de la no-regresión); aquí no, porque synchronize recrea el esquema.

import { DATA_SOURCE_OPTIONS_TS } from './persistence-runtime.js';
import { usesRelational } from './persistence-entities.js';
import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { crossAggregateForeignKeys } from '@keel-system/keel-core/gen/relational';
import { GENERATOR_TABLES, STEP_PREFIX, createdTablesInSql, schemaStepFiles } from '@keel-system/keel-core/gen/schema-steps';

export const SCHEMA_BASELINE_TS = 'src/infrastructure/persistence/schema-baseline.ts';
export const MIGRATIONS_DIR = 'src/migrations';
/** El baseline va SIEMPRE primero: su marca de tiempo es fija y anterior a cualquier otra. */
export const BASELINE_CLASS = 'BaselineSchema1000000000000';
export const BASELINE_FILE = '1000000000000-baseline-schema.ts';

/** ¿Hay baseline que exportar? Persistencia relacional con un motor que sabe recrear su esquema. */
export function usesSchemaBaseline(model) {
  return usesRelational(model) && Boolean(DATABASES[model.stack.database]?.cliDropSchemaCmd);
}

export function generate(model) {
  if (!usesSchemaBaseline(model)) return [];
  return [
    { path: SCHEMA_BASELINE_TS, content: schemaBaselineTs(model) },
    { path: 'infra/export-schema.sh', content: script('export') },
    { path: 'infra/verify-baseline.sh', content: script('verify') },
    { path: `${MIGRATIONS_DIR}/README.md`, content: migrationsReadme(model) }
  ];
}

// ─── Los pasos de esquema de build ───────────────────────────────────────────
//
// Una tabla del generador (outbox, guarda de mensajes, idempotencia, reconciliación, cronómetro) que aparece en un
// proyecto con base desplegada llega como una migración de TypeORM que escribe build (keel-core/gen/schema-steps.js): el
// baseline ya se aplicó, `migrationsRun` no ve nada pendiente y la primera petición que toque la tabla cae. Qué falta se
// deduce de las migraciones de disco ANTES de escribir; sin ${BASELINE_FILE} no hay base desplegada y el baseline que
// exporte el agente la traerá.
//
// La versión es la marca de tiempo del nombre, la que TypeORM lee de los 13 últimos dígitos del nombre de la clase para
// ordenar: una más que la mayor de disco, nunca `Date.now()` (build tiene que ser determinista). Tras el baseline sale
// 1000000000001; los pasos del agente llevan `Date.now()`, así que el suyo siguiente va después de este.

const MIGRATION_FILE = /^(\d+)-.+\.ts$/;

/** Las tablas del generador que este proyecto emite: las que tienen su entidad TypeORM entre los archivos de build. */
export function generatorTables(files) {
  const contents = files.map((file) => (typeof file.content === 'string' ? file.content : ''));
  return GENERATOR_TABLES.filter((table) => contents.some((content) => content.includes(`@Entity({ name: '${table.table}' })`)));
}

/**
 * Las tablas que crea una migración de TypeORM: su SQL va en literales de cadena, y el baseline exportado lo escribe con
 * `JSON.stringify`, que escapa las comillas dobles de los identificadores de PostgreSQL (`\"outbox_event\"`). Se quitan
 * esos escapes antes de leer el SQL.
 */
export function createdTablesInMigration(content) {
  return createdTablesInSql(String(content).replace(/\\(["'`])/g, '$1'));
}

/**
 * Los pasos de TypeORM que build emite en esta pasada (los suyos de antes, tal cual, y el nuevo si hace falta), con lo
 * que EVOLUTION.md tiene que decir. Vacío en el modelo documental: allí los índices los asegura el arranque.
 */
export function schemaSteps(model, files, projectDir) {
  if (!usesRelational(model)) return { files: [], added: [], work: [] };
  return schemaStepFiles({
    projectDir,
    dir: MIGRATIONS_DIR,
    tables: generatorTables(files),
    engine: model.stack.database,
    isMigration: (name) => MIGRATION_FILE.test(name),
    isBaseline: (name) => name === BASELINE_FILE,
    versionOf: (name) => MIGRATION_FILE.exec(name)?.[1] ?? null,
    renderStep: renderSchemaStep,
    createdTables: createdTablesInMigration
  });
}

/**
 * Las sentencias de un SQL de `schemaStepSql`, una por llamada: mysql2 sin `multipleStatements` rechaza varias en un solo
 * `queryRunner.query`. Cada una conserva su texto, con su `;`: unidas como las une keel-core son ese SQL byte a byte, que
 * es lo que deja el mismo esquema en los cuatro servidores.
 */
export function stepStatements(sql) {
  const statements = sql.replace(/\n$/, '').split('\n\n');
  if (`${statements.join('\n\n')}\n` !== sql || statements.some((statement) => !statement.endsWith(';'))) {
    throw new Error('el SQL del paso de esquema no se trocea por sentencias sin cambiarlo');
  }
  return statements;
}

/** El paso como migración de TypeORM: `<versión>-keel-<tablas>.ts`, con la clase `Keel<Tablas><versión>`. */
export function renderSchemaStep({ version, slug, sql, header }) {
  const statements = stepStatements(sql);
  // El SQL va tal cual en template literals: no puede traer nada que un template literal interprete.
  if (statements.some((statement) => /[`\\]|\$\{/.test(statement))) throw new Error('el SQL del paso de esquema no cabe en un template literal');
  const className = `${slug.split('_').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}${version}`;
  const content = `${header.map((line) => `// ${line}`).join('\n')}
import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Una sentencia por llamada: mysql2 sin multipleStatements no admite varias en un queryRunner.query. */
const STATEMENTS: readonly string[] = [
${statements.map((statement) => `  \`${statement}\``).join(',\n')}
];

export class ${className} implements MigrationInterface {
  name = '${className}';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of STATEMENTS) await queryRunner.query(statement);
  }

  async down(): Promise<void> {
    // No se deshace a propósito: borrar estas tablas perdería los eventos pendientes del outbox o reabriría duplicados
    // que la guarda ya había visto. El SQL es idempotente: volver a aplicar el paso tras un revert no hace nada.
  }
}
`;
  return { name: `${version}-${slug.replaceAll('_', '-')}.ts`, content };
}

function schemaBaselineTs(model) {
  // Las FK ENTRE agregados: la entidad solo guarda el id de la otra raíz, sin asociación, así que TypeORM no las
  // ve y el DDL de las entidades no las trae. Van en el baseline, como el apéndice de export-schema.sh de
  // keel-spring, con los MISMOS nombres (`crossAggregateForeignKeys` de keel-core): el esquema de los dos
  // servidores es el mismo. Hasta la corrida catalog de keel-nest (2026-10-11) solo lo decía un comentario.
  const foreignKeys = crossAggregateForeignKeys(model).map(({ name, table, column, refTable, refColumn }) => ({ name, table, column, refTable, refColumn }));
  const dataSourceOptions = `./${DATA_SOURCE_OPTIONS_TS.split('/').pop().replace(/\.ts$/, '.js')}`;
  return `/**
 * Exporta y verifica el baseline de migraciones contra la base LOCAL (infra/). No es parte del
 * servidor: lo ejecutan infra/export-schema.sh e infra/verify-baseline.sh, que antes vacían el
 * esquema. Ver ${MIGRATIONS_DIR}/README.md.
 *
 *   node dist/infrastructure/persistence/schema-baseline.js export   # DDL de las entidades
 *   node dist/infrastructure/persistence/schema-baseline.js verify   # migraciones == entidades
 *
 * Lo generó keel-nest build: no se edita.
 */
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import { loadConfiguration } from '../config/configuration.js';
import { databaseSettings } from '${dataSourceOptions}';

const OUTPUT = path.join('build', 'schema');
const MIGRATION_CLASS = '${BASELINE_CLASS}';
const MIGRATION_FILE = '${BASELINE_FILE}';

/** Las FK entre agregados, que las entidades no declaran (crossAggregateForeignKeys de keel-core). */
const CROSS_AGGREGATE_FOREIGN_KEYS: readonly { name: string; table: string; column: string; refTable: string; refColumn: string }[] = ${JSON.stringify(foreignKeys)};

interface Statement {
  readonly query: string;
  readonly parameters?: unknown[];
}

async function open(): Promise<DataSource> {
  const configuration = loadConfiguration({ ...process.env, PROFILE: process.env.PROFILE ?? 'local' });
  const settings = databaseSettings(configuration);
  if (!settings.options) throw new Error('El perfil activo no tiene base de datos: usa PROFILE=local con infra/ arriba.');
  // Ni synchronize ni migraciones al abrir: este script decide qué se aplica.
  const options = { ...settings.options, synchronize: false, migrationsRun: false, logging: ['error'] } as DataSourceOptions;
  return new DataSource(options).initialize();
}

/** El esquema tiene que estar vacío: si no, el ORM devolvería una DIFERENCIA y no el esquema entero. */
async function assertEmptySchema(dataSource: DataSource): Promise<void> {
  const runner = dataSource.createQueryRunner();
  try {
    // Solo las tablas de las entidades: sin nombres, el motor devuelve también las del sistema.
    const tables = await runner.getTables(dataSource.entityMetadatas.map((metadata) => metadata.tablePath));
    if (tables.length > 0) {
      throw new Error(
        \`El esquema no está vacío (\${tables.map((table) => table.name).join(', ')}). \` +
          'Ejecuta este paso con infra/export-schema.sh o infra/verify-baseline.sh, que lo vacían antes.'
      );
    }
  } finally {
    await runner.release();
  }
}

/** Un parámetro como literal SQL, solo para el archivo de revisión: la migración los pasa aparte. */
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return \`'\${String(value).replaceAll("'", "''")}'\`;
}

// Con una columna GENERADA (el discriminador de un índice condicionado en MySQL), TypeORM registra su expresión en
// typeorm_metadata con un INSERT parametrizado. Antes el export lo rechazaba y el baseline no se podía escribir.
function sqlOf(statements: readonly Statement[]): string {
  return statements
    .map((statement) => {
      const parameters = [...(statement.parameters ?? [])];
      const query = parameters.length > 0 ? statement.query.trim().replace(/\\?|\\$\\d+/g, () => literal(parameters.shift())) : statement.query.trim();
      return \`\${query};\`;
    })
    .join('\\n');
}

function migrationOf(up: readonly Statement[], down: readonly Statement[]): string {
  const calls = (statements: readonly Statement[]) =>
    statements
      .map((statement) =>
        statement.parameters && statement.parameters.length > 0
          ? \`    await queryRunner.query(\${JSON.stringify(statement.query.trim())}, \${JSON.stringify(statement.parameters)});\`
          : \`    await queryRunner.query(\${JSON.stringify(statement.query.trim())});\`
      )
      .join('\\n');
  return \`import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline del esquema: lo exportó infra/export-schema.sh desde las entidades finales y lo verifica
 * infra/verify-baseline.sh (las migraciones crean exactamente el esquema que las entidades esperan).
 * Los nombres de constraints, índices y FK son contrato: el filtro de errores traduce por ellos.
 */
export class \${MIGRATION_CLASS} implements MigrationInterface {
  name = '\${MIGRATION_CLASS}';

  async up(queryRunner: QueryRunner): Promise<void> {
\${calls(up)}
  }

  async down(queryRunner: QueryRunner): Promise<void> {
\${calls(down)}
  }
}
\`;
}

/** Las sentencias que crean y retiran las FK entre agregados, con el escapado y la sintaxis del motor. */
function crossAggregateStatements(dataSource: DataSource): { up: Statement[]; down: Statement[] } {
  const q = (name: string) => dataSource.driver.escape(name);
  const mysql = dataSource.options.type === 'mysql' || dataSource.options.type === 'mariadb';
  return {
    up: CROSS_AGGREGATE_FOREIGN_KEYS.map((fk) => ({
      query: \`ALTER TABLE \${q(fk.table)} ADD CONSTRAINT \${q(fk.name)} FOREIGN KEY (\${q(fk.column)}) REFERENCES \${q(fk.refTable)} (\${q(fk.refColumn)})\`
    })),
    down: CROSS_AGGREGATE_FOREIGN_KEYS.map((fk) => ({
      query: \`ALTER TABLE \${q(fk.table)} DROP \${mysql ? 'FOREIGN KEY' : 'CONSTRAINT'} \${q(fk.name)}\`
    }))
  };
}

/** ¿Es esta sentencia del ORM el borrado de una FK entre agregados? Las entidades no la declaran, así que la querría quitar. */
function dropsCrossAggregateKey(statement: Statement): boolean {
  return /\\bDROP\\s+(CONSTRAINT|FOREIGN\\s+KEY)\\b/i.test(statement.query) && CROSS_AGGREGATE_FOREIGN_KEYS.some((fk) => statement.query.includes(fk.name));
}

async function exportBaseline(dataSource: DataSource): Promise<number> {
  await assertEmptySchema(dataSource);
  const sql = await dataSource.driver.createSchemaBuilder().log();
  if (sql.upQueries.length === 0) throw new Error('TypeORM no devolvió ninguna sentencia: ¿hay entidades?');
  const foreign = crossAggregateStatements(dataSource);
  const up = [...sql.upQueries, ...foreign.up];
  // El down deshace en orden inverso, como el de una migración generada por TypeORM: primero las FK añadidas.
  const down = [...foreign.down.reverse(), ...[...sql.downQueries].reverse()];
  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT, 'baseline.sql'), \`\${sqlOf(up)}\\n\`);
  fs.writeFileSync(path.join(OUTPUT, MIGRATION_FILE), migrationOf(up, down));
  console.log(\`baseline: \${up.length} sentencia(s), \${foreign.up.length} de ellas FK entre agregados → \${path.join(OUTPUT, 'baseline.sql')}\`);
  console.log(\`migración candidata → \${path.join(OUTPUT, MIGRATION_FILE)} (revisarla y copiarla a ${MIGRATIONS_DIR}/)\`);
  return 0;
}

async function verifyBaseline(dataSource: DataSource): Promise<number> {
  await assertEmptySchema(dataSource);
  const applied = await dataSource.runMigrations({ transaction: 'all' });
  if (applied.length === 0) {
    console.error('baseline: KO — no hay migraciones que aplicar (¿están en ${MIGRATIONS_DIR}/ y compiladas con npm run build?).');
    return 1;
  }
  const log = await dataSource.driver.createSchemaBuilder().log();
  // El ORM querría quitar las FK entre agregados (las entidades no las declaran): esas no son diferencia.
  const diff = log.upQueries.filter((statement) => !dropsCrossAggregateKey(statement));
  if (diff.length > 0) {
    console.error(\`baseline: KO — tras aplicar \${applied.map((migration) => migration.name).join(', ')}, el esquema NO es el de las entidades.\`);
    console.error('Lo que el ORM tendría que cambiar todavía:');
    for (const statement of diff) console.error(\`  \${statement.query.trim()};\`);
    return 1;
  }
  // Y las que el ORM no ve, que existan: es el contrato que comparte con keel-spring.
  const runner = dataSource.createQueryRunner();
  try {
    const missing: string[] = [];
    for (const fk of CROSS_AGGREGATE_FOREIGN_KEYS) {
      const table = await runner.getTable(fk.table);
      if (!table?.foreignKeys.some((key) => key.name === fk.name)) missing.push(fk.name);
    }
    if (missing.length > 0) {
      console.error(\`baseline: KO — faltan las FK entre agregados \${missing.join(', ')} (el baseline tiene que añadirlas: infra/export-schema.sh las escribe).\`);
      return 1;
    }
  } finally {
    await runner.release();
  }
  console.log(\`baseline: OK — \${applied.map((migration) => migration.name).join(', ')} crea exactamente el esquema de las entidades.\`);
  return 0;
}

const mode = process.argv[2];
if (mode !== 'export' && mode !== 'verify') {
  console.error('Uso: node dist/infrastructure/persistence/schema-baseline.js export|verify');
  process.exit(2);
}
let code = 1;
const dataSource = await open();
try {
  code = mode === 'export' ? await exportBaseline(dataSource) : await verifyBaseline(dataSource);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  code = 1;
} finally {
  await dataSource.destroy();
}
process.exit(code);
`;
}

function script(mode) {
  const what =
    mode === 'export'
      ? `exporta el DDL de las entidades finales: build/schema/baseline.sql para revisarlo y
# build/schema/${BASELINE_FILE}, la migración candidata que se copia a ${MIGRATIONS_DIR}/.`
      : `aplica las migraciones de ${MIGRATIONS_DIR}/ sobre un esquema vacío —lo mismo que hace el
# arranque en develop y production— y exige que TypeORM no vea ninguna diferencia con las entidades.`;
  return `#!/usr/bin/env bash
# ${mode === 'export' ? 'export-schema.sh' : 'verify-baseline.sh'} — ${what}
#
# Uso (desde la raíz, con la infraestructura arriba: bash infra/up.sh):
#   bash infra/${mode === 'export' ? 'export-schema.sh' : 'verify-baseline.sh'}
#
# VACÍA el esquema de la base LOCAL (reset-db.sh --schema). Es inocuo: en local el esquema lo
# recrea synchronize en el siguiente arranque y los flujos parten de datos limpios igualmente.
# Sale con 0 si ${mode === 'export' ? 'el export se escribió' : 'el baseline crea exactamente el esquema de las entidades'}, y con 1 si no.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p build/schema

bash infra/reset-db.sh --schema
echo "Compilando (npm run build)…"
if ! npm run build >build/schema/build.log 2>&1; then
  echo "La compilación falló: build/schema/build.log" >&2
  exit 1
fi
PROFILE=local node dist/infrastructure/persistence/schema-baseline.js ${mode}
`;
}

function migrationsReadme(model) {
  return `# Migraciones de esquema

En el perfil \`local\` el esquema lo crea y altera TypeORM (\`database.synchronize: true\`, el
\`ddl-auto: update\` de keel-spring): el ciclo de generación itera sobre las entidades y no puede
pararse a escribir una migración por cambio.

En \`develop\` y \`production\` el ORM no toca el esquema: lo crean las migraciones de este directorio
al arrancar (\`database.migrations-run\`), registradas en la tabla \`typeorm_migrations\`. Sin
ninguna, el servicio arranca contra una base vacía y falla en la primera petición.

El **baseline** lo produce el pase de calidad desde las entidades ya finales:

\`\`\`bash
bash infra/export-schema.sh     # build/schema/baseline.sql + build/schema/${BASELINE_FILE}
cp build/schema/${BASELINE_FILE} ${MIGRATIONS_DIR}/
bash infra/verify-baseline.sh   # aplica las migraciones y exige que no quede diferencia
\`\`\`

Los nombres de tablas, columnas, constraints, índices y FK son los MISMOS que los del servidor de
keel-spring del diseño ${model.service.name}: los fija keel-core/gen y los traduce el filtro de errores.
Un cambio posterior del esquema es una migración nueva, con una marca de tiempo mayor; el baseline no
se reescribe una vez desplegado.

Las migraciones \`<marca>-${STEP_PREFIX}-*.ts\` las escribe build: crean las tablas del generador (outbox,
idempotencia, reconciliación, cronómetro) que una base ya desplegada no tenía. No las edites ni las
renumeres, y no repitas sus tablas en una migración tuya: la tuya va después, con \`Date.now()\` como
marca, que siempre es mayor.
`;
}
