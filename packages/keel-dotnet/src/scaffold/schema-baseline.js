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
// Solo PostgreSQL, como la frontera de la persistencia relacional de keel-dotnet.

import { DATABASES } from 'keel-core/gen/infra-catalog';
import { MIGRATIONS_TABLE } from './persistence-runtime.js';
import { usesRelational } from './persistence.js';
import { solution } from './render.js';

export const EXPORT_SCHEMA_SH = 'infra/export-schema.sh';
export const VERIFY_BASELINE_SH = 'infra/verify-baseline.sh';
/** Dónde deja el pase de calidad las migraciones, dentro del proyecto Infrastructure. */
export const MIGRATIONS_DIR = 'Persistence/Migrations';

export function usesSchemaBaseline(model) {
  return usesRelational(model) && (model.stack?.database ?? 'postgresql') === 'postgresql';
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

function verifyBaselineScript(model) {
  const infrastructure = solution(model).infrastructure.dir;
  const entry = DATABASES.postgresql;
  const dbName = model.service.name.replaceAll('-', '_');
  const user = entry.user(dbName);
  const password = entry.password;
  const container = `${model.service.name}-db`;
  // El catálogo del esquema, en UNA columna ordenada: columnas (tipo, cota, escala, nulabilidad), índices (su
  // definición entera: columnas, unicidad y predicado) y constraints (PK, FK, CHECK y UNIQUE con su definición).
  // El historial de migraciones no es del modelo: fuera.
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

psql_in() {
  local database="$1"
  shift
  "$RUNTIME" exec -i "$CONTAINER" env PGPASSWORD='${password}' psql -h db -U '${user}' -d "$database" -v ON_ERROR_STOP=1 -q -t -A "$@"
}

drop_scratch() {
  psql_in postgres -c "DROP DATABASE IF EXISTS $FROM_MIGRATIONS" >/dev/null 2>&1
  psql_in postgres -c "DROP DATABASE IF EXISTS $FROM_MODEL" >/dev/null 2>&1
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
if ! psql_in postgres -c "SELECT 1" >/dev/null 2>&1; then
  echo "baseline: KO — la base de prueba no responde: bash infra/up.sh && bash infra/validate-infra.sh"
  exit 1
fi
drop_scratch
psql_in postgres -c "CREATE DATABASE $FROM_MIGRATIONS" >/dev/null || ko "no se pudo crear la base $FROM_MIGRATIONS"
psql_in postgres -c "CREATE DATABASE $FROM_MODEL" >/dev/null || ko "no se pudo crear la base $FROM_MODEL"

connection="Host=localhost;Port=${entry.port};Database=$FROM_MIGRATIONS;Username=${user};Password=${password}"
if ! dotnet ef database update --project ${infrastructure} --connection "$connection" >build/schema/update.log 2>&1; then
  ko "las migraciones no se aplican sobre una base vacía:" "$(grep -iE 'error|exception|42[0-9A-Z]{3}' build/schema/update.log | head -10)"
fi
if ! dotnet ef dbcontext script --project ${infrastructure} --output build/schema/model.sql >build/schema/export.log 2>&1; then
  ko "dotnet ef no pudo derivar el DDL del modelo" "$(tail -10 build/schema/export.log)"
fi
if ! psql_in "$FROM_MODEL" -f - <build/schema/model.sql >build/schema/model-apply.log 2>&1; then
  ko "el DDL del modelo no se aplica:" "$(tail -10 build/schema/model-apply.log)"
fi

CATALOG="${catalog}"
psql_in "$FROM_MIGRATIONS" -c "$CATALOG" | tr -d '\\r' >build/schema/catalog-migrations.txt
psql_in "$FROM_MODEL" -c "$CATALOG" | tr -d '\\r' >build/schema/catalog-model.txt
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
