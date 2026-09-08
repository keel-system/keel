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
import { storedWhenValue } from './persistence-members.js';
import { persistedMembers } from './persistence-members.js';
import { quoteIdentifierFor } from '../lib/sql-reserved.js';
import { sqlContract } from './conditional-uniqueness.js';

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
// JPA no lo expresa (`@Index` no tiene predicado), así que sale por SQL. Y cada
// motor lo dice de una forma distinta; el que no tiene ninguna deja el archivo
// diciendo en voz alta que la garantía se queda en el caso de uso, en vez de
// generar un índice que prohibiría también las versiones históricas.
const PARTIAL_INDEX_DIALECTS = {
  postgresql: (spec) =>
    `CREATE UNIQUE INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${spec.columns}) WHERE ${spec.predicate};`,
  // SQL Server los llama índices filtrados y no admite IF NOT EXISTS: el guardia
  // va por sys.indexes, que es el idioma del motor.
  sqlserver: (spec) =>
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${spec.name}')\n` +
    `    CREATE UNIQUE INDEX ${spec.name} ON ${spec.table} (${spec.columns}) WHERE ${spec.predicate};`,
  mysql: mysqlPartialIndex
};

// ─── MySQL: el índice condicionado sin predicado ─────────────────────────────
//
// MySQL no tiene índices parciales, y durante mucho tiempo eso se tradujo aquí en una
// degradación anunciada: el índice no se creaba y el invariante se quedaba entero en el caso
// de uso, que no cierra la ventana de dos peticiones simultáneas.
//
// Sí tiene, en cambio, las dos piezas con las que se compone el mismo efecto:
//
//   1. una **parte funcional** de índice (8.0.13+): una key part puede ser una expresión entre
//      paréntesis, no solo una columna;
//   2. la regla de siempre de los índices únicos, que **no restringen las filas con NULL** en
//      cualquiera de sus partes.
//
// Juntas dan el discriminador: `(CASE WHEN status = 'ACTIVE' THEN 1 END)` vale 1 dentro de la
// condición y NULL fuera, así que el índice restringe exactamente las filas que la condición
// nombra y deja pasar todas las versiones históricas. La garantía resultante es la misma que la
// del índice parcial de PostgreSQL, contrato de ORDEN incluido: también se comprueba por fila y
// tampoco se puede diferir (ver sqlContract).
//
// El discriminador se materializa como **columna generada declarada**, y no como key part
// funcional (`... , (CASE WHEN … THEN 1 END)`) aunque las dos den el mismo índice. La forma
// funcional es más limpia de leer y no añade superficie al esquema, y por eso se eligió primero;
// la corrida `notification-mailer` sobre MySQL del 2026-09-08 midió lo que cuesta, y es demasiado:
//
//   · una key part funcional no tiene nombre de columna, y el driver la reporta con `COLUMN_NAME`
//     nulo. Con `ddl-auto: update`, Hibernate introspecciona TODOS los índices de la tabla al
//     reconciliar sus `@UniqueConstraint`, se encuentra ese nulo y **aborta la carga entera del
//     ApplicationContext** («null was passed as an object name») — no en el primer arranque, sino
//     en el segundo y en cada réplica nueva;
//   · y la única mitigación disponible, `hibernate.schema_update.unique_constraint_strategy: SKIP`,
//     es **peor que el fallo**: en MySQL los `@UniqueConstraint` NO se crean en el `CREATE TABLE`
//     sino por `ALTER TABLE` dentro de esa misma reconciliación, así que saltársela no los
//     conserva — impide que existan. Medido: con `SKIP`, `uk_<tabla>_natural` no aparece en la
//     base ni sobre un volumen recién creado. Se cambia un arranque que muere a gritos por la
//     pérdida SILENCIOSA de la unicidad de la clave natural del agregado, que es justo la clase de
//     defecto que este generador existe para no producir. Lo destapó `FL-TPL-001-E` (dos altas de
//     la misma versión a la vez: esperaba 1 fila, encontró 2).
//
// Con una columna declarada el índice deja de ser opaco: el driver devuelve su nombre, la
// introspección de Hibernate funciona, y no hace falta ningún ajuste global. El precio es la
// columna, que sí se ve en el esquema y en el baseline — y es un precio que se paga a la vista.
//
// El guardia es lo que cuesta. `CREATE INDEX` de MySQL no admite `IF NOT EXISTS`, y este
// appendix se ejecuta en CADA arranque con `continue-on-error: false` — o sea que sin guardia
// el segundo arranque del servicio muere. Y un bloque procedural tampoco vale: `spring.sql.init`
// parte el script por `;`, así que lo que se emita no puede llevar un `;` dentro. La salida son
// cuatro sentencias planas —consultar, componer, preparar, ejecutar— que MySQL corre sobre la
// MISMA conexión, que es lo que hace que la variable de usuario sobreviva de una a la siguiente.
/** La columna generada que discrimina. Cuelga del nombre del índice, que ya es único por tabla. */
export const discriminatorColumn = (spec) => `${spec.name}_flag`;

/**
 * Una sentencia condicionada a que algo NO exista, en el único idioma que le sirve a MySQL.
 *
 * `ADD COLUMN` y `CREATE INDEX` no admiten `IF NOT EXISTS`, y este appendix se ejecuta en CADA
 * arranque con `continue-on-error: false` — sin guardia, el segundo arranque del servicio muere.
 * Un bloque procedural tampoco vale: `spring.sql.init` parte el script por `;`, así que nada de lo
 * que se emita puede llevar uno dentro. Quedan cuatro sentencias planas —consultar, componer,
 * preparar, ejecutar— que MySQL corre sobre la MISMA conexión, que es lo que hace que la variable
 * de usuario sobreviva de una a la siguiente.
 */
function guarded(existsQuery, ddl, tag) {
  return (
    `SET @keel_${tag}_exists = (${existsQuery});\n` +
    // DO 0 es el no-op de MySQL: PREPARE exige una sentencia, y no hay forma de no preparar nada.
    `SET @keel_${tag}_ddl = IF(@keel_${tag}_exists > 0, 'DO 0', ${mysqlStringLiteral(ddl)});\n` +
    `PREPARE keel_${tag}_stmt FROM @keel_${tag}_ddl;\n` +
    `EXECUTE keel_${tag}_stmt;\n` +
    `DEALLOCATE PREPARE keel_${tag}_stmt;`
  );
}

function mysqlPartialIndex(spec) {
  const flag = discriminatorColumn(spec);
  const tabla = sqlLiteral(spec.tableName);

  // STORED y no VIRTUAL: se comporta como una columna normal para todo el que la lea —el DDL
  // exportado, el driver, una consulta a mano— y la tabla está vacía cuando se añade, así que la
  // reconstrucción que exige no cuesta nada.
  const columna =
    `ALTER TABLE ${spec.table} ADD COLUMN \`${flag}\` TINYINT ` +
    `GENERATED ALWAYS AS (CASE WHEN ${spec.predicate} THEN 1 END) STORED`;
  const indice = `CREATE UNIQUE INDEX ${spec.name} ON ${spec.table} (${spec.columns}, \`${flag}\`)`;

  return [
    guarded(
      `SELECT COUNT(*) FROM information_schema.COLUMNS\n` +
        `    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tabla}\n` +
        `      AND COLUMN_NAME = ${sqlLiteral(flag)}`,
      columna,
      'flag'
    ),
    guarded(
      `SELECT COUNT(*) FROM information_schema.STATISTICS\n` +
        `    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tabla}\n` +
        `      AND INDEX_NAME = ${sqlLiteral(spec.name)}`,
      indice,
      'index'
    )
  ].join('\n\n');
}

/**
 * El DDL viaja DENTRO de una cadena de MySQL, así que sus comillas y sus barras se escapan una
 * vez más. La barra importa aunque hoy no aparezca: MySQL la trata como escape en las cadenas
 * (a diferencia del SQL estándar), y dejarla pasar convertiría un identificador con barra en
 * otra cosa sin que nada fallara al crearse.
 */
function mysqlStringLiteral(sql) {
  return `'${sql.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

// ─── Por qué NO hay ningún ajuste de Hibernate que acompañe a este índice ────
//
// Lo hubo, durante unas horas del 2026-09-08, y fue un error que conviene dejar escrito porque el
// razonamiento que lo justificaba parecía sólido.
//
// Con la forma anterior del índice (una key part FUNCIONAL) el índice era OPACO a
// `DatabaseMetaData#getIndexInfo` —esa key part no tiene nombre de columna—, y con
// `ddl-auto: update` Hibernate lo introspecciona al reconciliar sus `@UniqueConstraint` y aborta
// la carga del ApplicationContext. La mitigación disponible es
// `hibernate.schema_update.unique_constraint_strategy: SKIP`, y se emitió con este argumento: «la
// constraint se sigue creando en el CREATE TABLE inicial; ese camino no pasa por aquí».
//
// **Es falso en MySQL, y se midió.** Ahí los `@UniqueConstraint` no salen inline en el
// `CREATE TABLE`: los añade un `ALTER TABLE` dentro de esa misma reconciliación. Saltársela no los
// conserva — impide que existan, también sobre un volumen recién creado. Con `SKIP`,
// `uk_<tabla>_natural` no aparece en la base, y la unicidad de la clave natural del agregado deja
// de existir sin que nada lo diga.
//
// La lección no es sobre Hibernate: es que la mitigación cambiaba un fallo RUIDOSO (un arranque
// que muere nombrando su excepción) por uno SILENCIOSO (una garantía que ya no está). Esa permuta
// es siempre mala, y aquí además tapaba lo que había que arreglar, que era la FORMA del índice.
//
// Lo destapó `FL-TPL-001-E` —dos altas de la misma versión a la vez: esperaba una fila, encontró
// dos—, y no lo habría destapado sobre el volumen de una corrida anterior, donde la constraint ya
// estaba creada de antes. Por eso el escenario de carrera vale y la lectura del YAML no.

/**
 * Los motores que saben emitir un índice condicionado, o sea los que llegan a tener uno que
 * INTROSPECCIONAR. Lo consume `index-probes.js` para exigir que cada uno declare si su forma puede
 * ser opaca a `DatabaseMetaData#getIndexInfo` — se exporta el derivado y no la tabla entera para no
 * abrir el emisor de SQL a quien solo necesita saber quiénes son.
 */
export const enginesWithPartialIndex = () => Object.keys(PARTIAL_INDEX_DIALECTS);

/** Los índices condicionados del diseño, ya resueltos a tabla, columnas y predicado. */
export function partialIndexSpecs(model) {
  const specs = [];
  // El SQL de este appendix va DIRECTO al motor: no pasa por Hibernate, así que
  // el quoting tiene que ser el del dialecto y no el backtick que aquel traduce.
  const quote = (name) => quoteIdentifierFor(model.stack.database, name);
  for (const entity of model.entities.filter((e) => e.persisted)) {
    const members = persistedMembers(model, entity);
    for (const index of partialUniqueIndexes(entity)) {
      const columnList = index.fields
        .flatMap((field) => columnsFor(model, entity, members, field, model.warnings))
        .map(quote);
      const columns = columnList.join(', ');
      const [whenColumn] = columnsFor(model, entity, members, index.when.field, model.warnings);
      // El valor con el que compara la columna, NO el literal del diseño: un enum se guarda
      // por su constante. Ver persistence-members.js § storedWhenValue.
      const stored = storedWhenValue(model, entity, index.when);
      specs.push({
        entity: entity.name,
        name: indexName(entity, index),
        table: quote(entity.tableName),
        // El nombre CRUDO, además del citado: `information_schema` guarda el identificador, no
        // su forma citada, así que un guardia que preguntara por `` `key` `` no encontraría nunca
        // la tabla `key` — y su índice se intentaría crear en cada arranque.
        tableName: entity.tableName,
        columns,
        // Las mismas columnas sueltas. Las consume `index-probes.js` para levantar el sustrato
        // sobre el que mide el índice: derivarlas por su cuenta sería medir una copia de sí mismo.
        columnList,
        whenColumn: quote(whenColumn),
        predicate: `${quote(whenColumn)} = ${sqlLiteral(stored)}`,
        // Se conserva junto al literal para que la prosa pueda decir los dos cuando difieren:
        // el comentario habla el idioma del diseño y la sentencia el del motor.
        stored,
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

// El diseño dice `active` y la columna guarda `ACTIVE`. La prosa habla el idioma del
// diseñador —es su invariante— pero callar la diferencia deja un comentario que contradice
// a la sentencia de debajo, y eso invita a "corregir" la sentencia.
function storedNote(spec) {
  return String(spec.stored) === String(spec.when.equals) ? '' : ` (almacenado como ${sqlLiteral(spec.stored)})`;
}

export function sqlLiteral(value) {
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
    // El AVISO no se escribe aquí: lo deriva `engine-limits.js` de la matriz de paridad, que es
    // donde vive el dato de qué motor sostiene qué. Dos copias del mismo aviso divergen a la
    // primera, y la que se queda atrás es siempre la que alguien lee. Lo que sí es de este
    // archivo es el texto del .sql de abajo: ahí el aviso está EN el artefacto que lo sufre.
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

  return `${header}${sqlContract(model)}
${specs.map((spec) => `-- ${spec.entity}: como máximo una fila por (${spec.fields.join(', ')}) con ${spec.when.field} = ${spec.when.equals}${storedNote(spec)}.
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
