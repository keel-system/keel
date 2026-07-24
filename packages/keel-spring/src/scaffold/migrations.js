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

const MIGRATIONS_DIR = 'src/main/resources/db/migration';
const BASELINE_SQL = 'build/schema/baseline.sql';
const BASELINE_MIGRATION = 'V1__baseline_schema.sql';

export function generate(model) {
  if (!model.layersPresent.persistence) return [];
  return [
    { path: `${MIGRATIONS_DIR}/README.md`, content: migrationsReadme(model) },
    { path: 'src/main/resources/application-schema-export.yaml', content: schemaExportYaml() },
    { path: 'src/main/resources/application-migrations.yaml', content: migrationsYaml() },
    { path: 'infra/export-schema.sh', content: exportSchemaScript(model) }
  ];
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
docker compose -f infra/docker-compose.yaml up -d   # el export necesita la BD arriba
bash infra/export-schema.sh                         # → ${BASELINE_SQL}
\`\`\`

Revisa el SQL exportado (nombres de constraint e índices, tipos del dialecto) y
cópialo como \`${BASELINE_MIGRATION}\`. Luego pruébalo sobre una BD sin
esquema, con las migraciones gobernando de verdad:

\`\`\`bash
PROFILE=local,migrations ./gradlew bootRun
\`\`\`

El procedimiento completo y su checklist están en
\`.claude/skills/keel-spring-database/references/migrations.md\`.

## Reglas duras

- **Nunca edites una migración ya aplicada** en cualquier ambiente: Flyway guarda
  su checksum y el arranque fallará. Los cambios van en una \`V<n+1>\` nueva.
- **Nunca \`flyway clean\`**: borra el esquema. Está deshabilitado en \`production\`.
- El esquema que describan estas migraciones debe respetar \`specs/${model.service.name}\`
  (claves naturales e índices de \`persistence.keel.yaml\`); el diseño manda.
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
// Sirve para probar el baseline antes de commitearlo.
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
#   docker compose -f infra/docker-compose.yaml up -d && bash infra/export-schema.sh
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
echo "Revísalo (constraints, índices, tipos del dialecto) y cópialo como:"
echo "  src/main/resources/db/migration/${BASELINE_MIGRATION}"
echo "Después pruébalo sobre una BD sin esquema: PROFILE=local,migrations ./gradlew bootRun"
`;
}
