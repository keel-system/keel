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
import { DATABASES } from 'keel-core/gen/infra-catalog';

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
    { path: SCHEMA_BASELINE_TS, content: schemaBaselineTs() },
    { path: 'infra/export-schema.sh', content: script('export') },
    { path: 'infra/verify-baseline.sh', content: script('verify') },
    { path: `${MIGRATIONS_DIR}/README.md`, content: migrationsReadme(model) }
  ];
}

function schemaBaselineTs() {
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

function sqlOf(statements: readonly Statement[]): string {
  for (const statement of statements) {
    if (statement.parameters && statement.parameters.length > 0) {
      throw new Error(\`Una sentencia del esquema lleva parámetros y no se puede escribir como SQL: \${statement.query}\`);
    }
  }
  return statements.map((statement) => \`\${statement.query.trim()};\`).join('\\n');
}

function migrationOf(up: readonly Statement[], down: readonly Statement[]): string {
  const calls = (statements: readonly Statement[]) =>
    statements.map((statement) => \`    await queryRunner.query(\${JSON.stringify(statement.query.trim())});\`).join('\\n');
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

async function exportBaseline(dataSource: DataSource): Promise<number> {
  await assertEmptySchema(dataSource);
  const sql = await dataSource.driver.createSchemaBuilder().log();
  if (sql.upQueries.length === 0) throw new Error('TypeORM no devolvió ninguna sentencia: ¿hay entidades?');
  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT, 'baseline.sql'), \`\${sqlOf(sql.upQueries)}\\n\`);
  // El down deshace en orden inverso, como el de una migración generada por TypeORM.
  fs.writeFileSync(path.join(OUTPUT, MIGRATION_FILE), migrationOf(sql.upQueries, [...sql.downQueries].reverse()));
  console.log(\`baseline: \${sql.upQueries.length} sentencia(s) → \${path.join(OUTPUT, 'baseline.sql')}\`);
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
  const diff = await dataSource.driver.createSchemaBuilder().log();
  if (diff.upQueries.length > 0) {
    console.error(\`baseline: KO — tras aplicar \${applied.map((migration) => migration.name).join(', ')}, el esquema NO es el de las entidades.\`);
    console.error('Lo que el ORM tendría que cambiar todavía:');
    for (const statement of diff.upQueries) console.error(\`  \${statement.query.trim()};\`);
    return 1;
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
`;
}
