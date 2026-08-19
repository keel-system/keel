// Mecanismo de migraciones de esquema (Flyway) del proyecto generado. Es la
// pieza que hace desplegable el servicio: en develop/production Hibernate solo
// valida (`ddl-auto: validate`), así que el esquema tiene que ponerlo alguien.
//
// Frontera: aquí sale TODO lo transversal (dónde viven las migraciones, cómo se
// activan, cómo se exporta el baseline desde las entidades finales) pero NUNCA el
// SQL: el DDL depende del dialecto y de cómo el agente haya terminado de mapear
// las entidades (los `// TODO (agente)` de persistence-entities.js incluidos).
// El baseline lo produce el agente con `infra/export-schema.sh` en la fase de
// calidad, guiado por la skill keel-spring-database (references/migrations.md).
//
// Dos perfiles auxiliares, finos y aditivos (se activan como PROFILE=local,<perfil>):
//   schema-export  Hibernate escribe el DDL a un archivo y no toca la BD.
//   migrations     Flyway aplica db/migration/ y Hibernate solo valida.
// Existen para que ni el agente ni el operador tengan que editar YAML a mano.

import { uniqueConstraints, columnsFor, partialUniqueIndexes, indexName } from './persistence-entities.js';
import { persistedMembers } from './persistence-members.js';
import { quoteIdentifierFor } from '../lib/sql-reserved.js';

const MIGRATIONS_DIR = 'src/main/resources/db/migration';
const BASELINE_SQL = 'build/schema/baseline.sql';
const BASELINE_MIGRATION = 'V1__baseline_schema.sql';
// Appendix de DDL que Hibernate NO puede inferir de las entidades. Vive en el
// classpath (no en db/migration/) porque no es una migración: es el complemento
// del esquema, y lo consumen DOS caminos —la inicialización de los perfiles con
// ddl-auto (local, test) y el baseline que el pase de calidad exporta—. Una sola
// fuente, dos destinos: es el mismo trato que el realm de Keycloak.
const PARTIAL_INDEXES_SQL = 'src/main/resources/db/partial-indexes.sql';

export function generate(model) {
  // Todo este módulo es Flyway: en el modelo documental no hay esquema que migrar
  // ni baseline que exportar. Su equivalente —los índices— lo genera
  // document-indexes.js, y es determinista de punta a punta.
  if (!model.layersPresent.persistence || model.persistenceKind === 'document') return [];
  return [
    { path: `${MIGRATIONS_DIR}/README.md`, content: migrationsReadme(model) },
    { path: 'src/main/resources/application-schema-export.yaml', content: schemaExportYaml() },
    { path: 'src/main/resources/application-migrations.yaml', content: migrationsYaml() },
    { path: 'infra/export-schema.sh', content: exportSchemaScript(model) },
    { path: PARTIAL_INDEXES_SQL, content: partialIndexesSql(model) }
  ];
}

// ─── Índices únicos condicionados ────────────────────────────────────────────
//
// «Como máximo una versión activa por clave» no es una unicidad de columnas: es
// una unicidad CONDICIONADA al estado. Con una constraint normal sobre esas
// columnas no podrías tener nunca dos versiones; sin nada, dos publicaciones
// simultáneas dejan dos activas y el invariante que el diseño declaró no lo
// sostiene nadie — la comprobación previa del handler no cierra esa ventana.
//
// JPA no lo expresa (`@Index` no tiene predicado), así que sale por SQL. Y solo
// dos de los seis dialectos lo tienen de verdad; en los demás el archivo dice en
// voz alta que la garantía se queda en el caso de uso, en vez de generar un
// índice que prohibiría también las versiones históricas.
const PARTIAL_INDEX_DIALECTS = {
  postgresql: (spec) =>
    `CREATE UNIQUE INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${spec.columns}) WHERE ${spec.predicate};`,
  // SQL Server los llama índices filtrados y no admite IF NOT EXISTS: el guardia
  // va por sys.indexes, que es el idioma del motor.
  sqlserver: (spec) =>
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${spec.name}')\n` +
    `    CREATE UNIQUE INDEX ${spec.name} ON ${spec.table} (${spec.columns}) WHERE ${spec.predicate};`
};

/** Los índices condicionados del diseño, ya resueltos a tabla, columnas y predicado. */
export function partialIndexSpecs(model) {
  const specs = [];
  // El SQL de este appendix va DIRECTO al motor: no pasa por Hibernate, así que
  // el quoting tiene que ser el del dialecto y no el backtick que aquel traduce.
  const quote = (name) => quoteIdentifierFor(model.stack.database, name);
  for (const entity of model.entities.filter((e) => e.persisted)) {
    const members = persistedMembers(model, entity);
    for (const index of partialUniqueIndexes(entity)) {
      const columns = index.fields
        .flatMap((field) => columnsFor(model, entity, members, field, model.warnings))
        .map(quote)
        .join(', ');
      const [whenColumn] = columnsFor(model, entity, members, index.when.field, model.warnings);
      specs.push({
        entity: entity.name,
        name: indexName(entity, index),
        table: quote(entity.tableName),
        columns,
        predicate: `${quote(whenColumn)} = ${sqlLiteral(index.when.equals)}`,
        fields: index.fields,
        when: index.when
      });
    }
  }
  return specs;
}

/**
 * Si el diseño declara algún índice condicionado Y el motor elegido sabe crearlo.
 * Las dos mitades importan: sin la segunda, los perfiles con ddl-auto intentarían
 * ejecutar un archivo que solo contiene comentarios explicando por qué no hay nada.
 */
export function usesPartialIndexes(model) {
  if (model.persistenceKind === 'document') return false;
  return partialIndexSpecs(model).length > 0 && Boolean(PARTIAL_INDEX_DIALECTS[model.stack.database]);
}

function sqlLiteral(value) {
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

function partialIndexesSql(model) {
  const specs = partialIndexSpecs(model);
  const dialect = PARTIAL_INDEX_DIALECTS[model.stack.database];
  const header = `-- Índices únicos condicionados, derivados de specs/persistence.keel.yaml.
-- Generado por keel-spring build: NO se edita a mano (se regenera en cada build).
--
-- Hibernate no puede inferirlos de las entidades porque JPA no tiene predicado en
-- @Index, así que este archivo es su única fuente. Lo consumen dos caminos:
--   * los perfiles con ddl-auto (local, test), vía spring.sql.init;
--   * el baseline de migraciones, al que infra/export-schema.sh lo añade.
-- Por eso cada sentencia es idempotente: se ejecuta en cada arranque.
`;

  if (specs.length === 0) {
    return `${header}
-- El diseño no declara ningún índice condicionado (persistence.entities.<E>.indexes
-- con 'when'). El archivo existe igualmente para que spring.sql.init tenga qué leer.
`;
  }

  if (!dialect) {
    // El diseño declaró un invariante que este motor no puede sostener. Es aviso y
    // no error porque la mayoría de los diseños toleran la ventana de dos peticiones
    // simultáneas; lo que no se tolera es no saber que existe.
    model.warnings.push(
      `persistence.indexes con 'when' (${specs.map((spec) => `${spec.entity}.[${spec.fields.join(', ')}]`).join(', ')}): ` +
        `${model.stack.database} no tiene índices parciales, así que esos índices NO se crean y la unicidad ` +
        `condicionada queda entera en el caso de uso, que no cierra la ventana de dos peticiones simultáneas. ` +
        `db/partial-indexes.sql lo dice en voz alta y enumera las salidas del motor. Con PostgreSQL o SQL Server sí se generan.`
    );
    const lines = specs.map(
      (spec) =>
        `--   ${spec.name}: UNIQUE (${spec.fields.join(', ')}) donde ${spec.when.field} = ${spec.when.equals}` +
        ` [entidad ${spec.entity}]`
    );
    return `${header}
-- ATENCIÓN: ${model.stack.database} no tiene índices parciales, así que estos índices
-- NO se crean y la garantía se queda ENTERA en el caso de uso — que no cierra la
-- ventana de dos peticiones simultáneas. Los invariantes afectados:
${lines.join('\n')}
--
-- Si esa ventana importa, las salidas del motor son una columna generada que valga
-- NULL fuera de la condición (MySQL/MariaDB, Oracle) con una constraint única
-- encima, o un bloqueo explícito en el caso de uso que publica. Ninguna de las dos
-- la elige el generador: son decisiones con coste que se toman a la vista.
`;
  }

  return `${header}
${specs.map((spec) => `-- ${spec.entity}: como máximo una fila por (${spec.fields.join(', ')}) con ${spec.when.field} = ${spec.when.equals}.
${dialect(spec)}`).join('\n\n')}
`;
}

// README del directorio de migraciones: no es .sql, así que Flyway lo ignora y a
// la vez mantiene el directorio en git (que vacío no viajaría).
function migrationsReadme(model) {
  return `# Migraciones de esquema (Flyway)

Cada archivo \`.sql\` de este directorio es una migración versionada que Flyway
aplica **en orden** al arrancar el servicio, y que queda registrada en la tabla
\`flyway_schema_history\`. Es la fuente de verdad del esquema en \`develop\` y
\`production\`, donde Hibernate solo valida (\`ddl-auto: validate\`).

## Convención de nombres

| Patrón | Para qué |
|---|---|
| \`V<n>__<snake_case>.sql\` | Migración versionada; se aplica una vez. \`V1__baseline_schema.sql\`, \`V2__add_product_sku_index.sql\`. |
| \`R__<snake_case>.sql\` | Repeatable: se reaplica cuando cambia su contenido. Solo para datos de referencia idempotentes o vistas. |

## El baseline (V1)

No se escribe a mano: se **exporta** de las entidades JPA ya finales, para que el
esquema y el mapeo no puedan divergir.

\`\`\`bash
bash infra/up.sh                    # el export necesita la BD arriba
bash infra/export-schema.sh                         # → ${BASELINE_SQL}
\`\`\`

Revisa el SQL exportado (nombres de constraint e índices, tipos del dialecto) y
cópialo como \`${BASELINE_MIGRATION}\`. Eso lo produce el **pase de calidad** del
flujo de generación, que además lo verifica en estático: \`diff\` contra el DDL
exportado y contraste con las entidades \`Jpa\` y el diseño.

**La prueba en vivo es tuya**, antes del primer despliegue: el baseline solo está
probado si ha creado el esquema **desde cero** —contra una BD que Hibernate ya
pobló con \`ddl-auto: update\`, el \`validate\` pasaría sin ejercitar nada—.

\`\`\`bash
bash infra/down.sh --volumes               # borra el volumen: BD sin esquema
bash infra/up.sh
PROFILE=local,migrations ./gradlew bootRun # Flyway crea, Hibernate valida
\`\`\`

El pipeline no la ejecuta a propósito: borrar el volumen destruiría la base de datos
sobre la que corren los escenarios \`FL-*\`. El procedimiento completo y su checklist
están en \`references/migrations.md\` de la skill \`keel-spring-database\`.

## Reglas duras

- **Nunca edites una migración ya aplicada** en cualquier ambiente: Flyway guarda
  su checksum y el arranque fallará. Los cambios van en una \`V<n+1>\` nueva.
- **Nunca \`flyway clean\`**: borra el esquema. Está deshabilitado en \`production\`.
- El esquema que describan estas migraciones debe respetar el snapshot del diseño
  en \`specs/\` (claves naturales e índices de \`persistence.keel.yaml\`); el diseño manda.
`;
}

// Perfil schema-export: Hibernate escribe el DDL de las entidades a un archivo y
// no toca la BD (ni crea, ni valida). Se activa junto a otro perfil, que es quien
// aporta el datasource: PROFILE=local,schema-export.
function schemaExportYaml() {
  return `# Perfil schema-export: exporta el DDL de las entidades JPA a un archivo.
# No modifica la base de datos. Se activa SOBRE otro perfil (que aporta el
# datasource) y lo usa infra/export-schema.sh:
#   PROFILE=local,schema-export ./gradlew bootRun
spring:
  jpa:
    hibernate:
      # Hibernate no toca el esquema: solo lo describe.
      ddl-auto: none
    properties:
      jakarta.persistence.schema-generation.scripts.action: create
      jakarta.persistence.schema-generation.scripts.create-target: ${BASELINE_SQL}
      # Sin delimitador las sentencias salen sin ';' y el SQL no es ejecutable.
      hibernate.hbm2ddl.delimiter: ";"
  flyway:
    # Se exporta el esquema que describen las entidades, no el que ya haya aplicado.
    enabled: false
`;
}

// Perfil migrations: lo que ocurre en develop/production, reproducible en local.
// Lo usa el diseñador para probar el baseline a mano antes del primer despliegue
// (el pase de calidad lo entrega verificado en estático, no probado: arrancar con
// este perfil exige una BD sin esquema, y borrar ese volumen se llevaría por delante
// la base sobre la que corren los escenarios).
function migrationsYaml() {
  return `# Perfil migrations: el esquema lo gobiernan las migraciones de db/migration/
# y Hibernate solo valida — igual que en develop/production. Se activa SOBRE otro
# perfil (que aporta el datasource):
#   PROFILE=local,migrations ./gradlew bootRun
# Úsalo contra una base de datos SIN esquema para comprobar que el baseline lo
# crea completo: si Hibernate ya lo había creado con ddl-auto: update, el validate
# pasaría sin haber ejercitado la migración.
spring:
  jpa:
    hibernate:
      ddl-auto: validate
  flyway:
    enabled: true
`;
}

// export-schema.sh: exporta el DDL de las entidades JPA finales al archivo del
// perfil schema-export. Hibernate lo escribe al construir el EntityManagerFactory,
// así que el script arranca la app en segundo plano, espera el archivo y la para.
// Vive en infra/ porque necesita el contenedor de BD arriba (el datasource del
// perfil local se conecta al arrancar), junto a validate-infra.sh y reset-db.sh.
function exportSchemaScript(model) {
  return `#!/usr/bin/env bash
# export-schema.sh — exporta el DDL de las entidades JPA de ${model.service.name}.
# Produce ${BASELINE_SQL} con el dialecto real del stack, para revisarlo y
# copiarlo como src/main/resources/db/migration/${BASELINE_MIGRATION}.
# Requiere la infraestructura de prueba arriba (el perfil local conecta a la BD).
# Uso (desde la raíz del proyecto):
#   bash infra/up.sh && bash infra/export-schema.sh
set -u

TARGET="${BASELINE_SQL}"
TIMEOUT="\${EXPORT_TIMEOUT:-180}"

if [ ! -x ./gradlew ] && [ ! -f ./gradlew ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró ./gradlew)." >&2
  exit 2
fi

rm -f "$TARGET"
mkdir -p "$(dirname "$TARGET")"

echo "Exportando el esquema con PROFILE=local,schema-export…"
PROFILE=local,schema-export ./gradlew bootRun --console=plain >build/schema/export.log 2>&1 &
pid=$!

elapsed=0
while [ ! -s "$TARGET" ]; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "La aplicación terminó sin exportar el esquema. Revisa build/schema/export.log." >&2
    exit 1
  fi
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    kill "$pid" 2>/dev/null
    echo "Timeout ($TIMEOUT s) esperando $TARGET. ¿Está la infraestructura arriba? Revisa build/schema/export.log." >&2
    exit 1
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

# El archivo aparece al construir el EntityManagerFactory; la app ya no hace falta.
sleep 2
kill "$pid" 2>/dev/null
wait "$pid" 2>/dev/null

echo "Esquema exportado en $TARGET."
${partialIndexAppend(model)}${constraintCheck(model)}
echo "Revísalo (constraints, índices, tipos del dialecto) y cópialo como:"
echo "  src/main/resources/db/migration/${BASELINE_MIGRATION}"
echo "Después, doble check estático: diff contra este archivo y contraste con las entidades y el diseño."
echo "La prueba en vivo (PROFILE=local,migrations sobre una BD sin esquema) la hace el diseñador:"
echo "  borra el volumen de la BD, que es la misma sobre la que corren los escenarios."
`;
}

// Los índices condicionados no están en el DDL exportado y no pueden estarlo:
// Hibernate los desconoce. Se añaden aquí, al exportar, para que el baseline que
// el pase de calidad copia ya los lleve — pedírselos al agente como un paso más
// sería pedirle que recordara algo que build ya sabe, y su olvido no lo detecta
// nadie hasta que dos peticiones simultáneas dejan dos filas activas.
function partialIndexAppend(model) {
  if (partialIndexSpecs(model).length === 0) return '';
  if (!PARTIAL_INDEX_DIALECTS[model.stack.database]) return '';
  return `
if [ -f "${PARTIAL_INDEXES_SQL}" ]; then
  echo "" >> "$TARGET"
  cat "${PARTIAL_INDEXES_SQL}" >> "$TARGET"
  echo "Añadidos al DDL los índices condicionados de ${PARTIAL_INDEXES_SQL} (Hibernate no los infiere)."
fi
`;
}

// El exporter de Hibernate vuelca algunas constraints únicas como \`unique (…)\`
// inline, sin su nombre. ApiExceptionHandler traduce la violación POR NOMBRE de
// constraint, así que un baseline sin ellos degrada el error declarado del
// diseño a un 409 genérico. Se comprueba aquí, que es cuando aún se puede
// renombrar a mano antes de copiar el archivo.
function constraintCheck(model) {
  const constraints = uniqueConstraints(model).map((entry) => entry.constraint);
  if (constraints.length === 0) return '';

  return `
missing=""
for constraint in ${constraints.join(' ')}; do
  grep -qi "$constraint" "$TARGET" || missing="$missing $constraint"
done
if [ -n "$missing" ]; then
  echo ""
  echo "AVISO: el DDL exportado no nombra estas constraints:$missing"
  echo "  Hibernate las vuelca como 'unique (...)' inline. Renómbralas en $TARGET"
  echo "  antes de copiarlo: ApiExceptionHandler traduce la violación por nombre y,"
  echo "  sin él, el error declarado del diseño se degrada a un 409 genérico."
  echo ""
fi`;
}
