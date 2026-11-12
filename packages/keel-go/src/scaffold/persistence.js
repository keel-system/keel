// La persistencia relacional: el ESQUEMA (la migración baseline de goose) y la página que pide un listado.
//
// En los otros tres el esquema SALE de un ORM (Hibernate, TypeORM, EF Core) que lee las anotaciones o el mapeo
// fluente; keel-go no tiene ORM (PLAN-KEEL-GO.md § 2), así que lo escribe build entero, en SQL, desde los mismos datos:
// tablas, columnas, cotas, constraints únicas, índices, FK y predicados salen de keel-core/gen/relational.js, y el
// esquema de los cuatro servidores del mismo diseño lleva los mismos nombres —que es lo que leen el traductor de
// errores, los scripts del arnés y `infra/fixtures.sql`—. `test/schema-parity.test.js` lo compara con lo que EMITE
// keel-spring.
//
// Lo único de aquí es el TIPO FÍSICO de cada columna, que en los otros tres lo pone el ORM: el que Hibernate da al
// mismo tipo Java en PostgreSQL (un texto sin cota es `varchar(255)`, un decimal sin escala declarada
// `numeric(38,2)`, un instante `timestamp(6) with time zone`, un enum su CONSTANTE en `varchar(255)`), para que la
// base de un servicio keel-go sea la de su gemelo de keel-spring. En MySQL, el de keel-dotnet (binary(16) para el
// uuid, `datetime(6)`, `tinyint(1)`), y la unicidad condicionada como columna generada (ver `schemaTables`).
//
// Tres decisiones que no son obvias:
//   · la unicidad de la clave natural y de un campo `unique` es una CONSTRAINT de tabla, como el @UniqueConstraint de
//     keel-spring; la de un índice declarado, un índice único con nombre. Las dos llegan al traductor igual: por el
//     NOMBRE que el motor pone en el error;
//   · las FK DENTRO del agregado (hija → padre, elemento → raíz) borran en cascada: el agregado se borra entero, como
//     el `DeleteBehavior.Cascade` de keel-dotnet. Las que van a OTRO agregado no (NO ACTION, la del baseline de
//     keel-spring): borrar la raíz referenciada es un conflicto que el diseño traduce, no un efecto que se propaga;
//   · las FK se añaden al final con ALTER TABLE, así que el orden de las tablas no importa (dos agregados pueden
//     referirse entre sí).

import {
  AUDIT_COLUMNS,
  DECIMAL_PRECISION,
  LOCK_VERSION,
  backReferenceTo,
  collectionIndexesOf,
  columnsFor,
  crossAggregateForeignKeys,
  elementTable,
  foreignKeyIndexColumns,
  foreignKeyIndexName,
  foreignKeyName,
  indexName,
  joinColumnOf,
  keyShadow,
  parentColumnOf,
  partialIndexSpecs,
  persistedMembers,
  uniqueFields
} from '@keel-system/keel-core/gen';
import { discriminatorColumn, isLogicallyDeleted } from '@keel-system/keel-core/gen/relational';
import { lifecycleMarks } from './data-lifecycle.js';
import { repositoryRoots, usesRelational } from '@keel-system/keel-core/gen/features';
import { GENERATED_HEADER, alignRows } from '../lib/go-source.js';
import { relationalEngine, sqlDialect } from '../lib/relational-engine.js';
import { applicationPath, domainPath, layout, packageFile } from './render.js';
import { IDEMPOTENCY_RECORD } from '@keel-system/keel-core/gen/request-idempotency';
import { storeTables } from './messaging-stores.js';
import { reconciliationTables } from './reconciliation-claim.js';
import { usesRequestIdempotency } from './request-idempotency.js';
import { GENERATOR_TABLES, schemaStepFiles } from '@keel-system/keel-core/gen/schema-steps';
import { KEEL_TIMER } from '@keel-system/keel-core/gen/timer-store';
import { usesTimer } from '@keel-system/keel-core/gen/timer-plan';

export { usesRelational };

/** La migración baseline: la primera de goose, con el esquema entero del diseño. */
export const BASELINE_FILE = '00001_baseline.sql';

export function generate(model) {
  const files = [];
  if (repositoryRoots(model).length > 0) files.push(pageableFile(model), pageShapeTest(model));
  if (!usesRelational(model)) return files;
  const { store } = layout(model);
  const { label } = sqlDialect(model);
  files.push(
    {
      path: `${store.dir}/doc.go`,
      content: packageFile(model, store, {
        doc: `Package ${store.name} es el adaptador de ${label} del servicio: el esquema (las migraciones de goose, embebidas),\nlos repositorios, la transacción del caso de uso y la traducción de los errores del motor. Implementa los\npuertos del dominio y el application.Transactor.`,
        body: ''
      })
    },
    { path: `${store.dir}/migrations/${BASELINE_FILE}`, content: baselineSql(model) },
    { path: `${store.dir}/migrations.go`, content: migrationsGo(model) }
  );
  return files;
}

// ─── La página ───────────────────────────────────────────────────────────────────────────────────

// La forma de la página, en una prueba emitida (corrida catalog, 2026-11-02: FL-PRD-003-D). En application porque internal/domain
// no tiene pruebas propias, y go-check la falsa con el sabotaje empty-page.
function pageShapeTest(model) {
  return {
    path: applicationPath(model, 'page_shape').replace(/\.go$/, '_test.go'),
    content: packageFile(model, layout(model).application, { imports: ['testing', 'internal/domain'], body: PAGE_SHAPE_TEST })
  };
}

const PAGE_SHAPE_TEST = `
func TestLaPaginaVaciaEsCeroElementosYCeroPaginasTambienFueraDeRango(t *testing.T) {
	page := domain.NewPage[string](nil, domain.Pageable{Page: 5, Size: 2}, 3)
	if page.TotalElements != 0 || page.TotalPages != 0 || page.Number != 5 || page.Size != 2 {
		t.Fatalf("fuera de rango: %+v (quería 0 elementos, 0 páginas, page 5 y size 2)", page)
	}
}

func TestUnaPaginaConElementosLlevaSusTotales(t *testing.T) {
	page := domain.NewPage([]string{"a"}, domain.Pageable{Page: 1, Size: 2}, 3)
	if page.TotalElements != 3 || page.TotalPages != 2 {
		t.Fatalf("con elementos: %+v (quería 3 elementos y 2 páginas)", page)
	}
}
`;

function pageableFile(model) {
  const { domain } = layout(model);
  // Un comentario por constante: corta la alineación de gofmt, así que cada una es su propia sección.
  const constants = [
    '\t// SortAsc es el orden ascendente, el de un criterio que no dice dirección.',
    '\tSortAsc SortDirection = "ASC"',
    '\t// SortDesc es el orden descendente.',
    '\tSortDesc SortDirection = "DESC"'
  ];
  const sortFields = alignRows([
    { indent: '\t', cells: ['Property', 'string'] },
    { indent: '\t', cells: ['Direction', 'SortDirection'] }
  ]);
  const pageFields = alignRows([
    { indent: '\t', cells: ['Page', 'int32'] },
    { indent: '\t', cells: ['Size', 'int32'] },
    { indent: '\t', cells: ['Sort', '[]SortOrder'] }
  ]);
  const pageResultFields = alignRows([
    { indent: '\t', cells: ['Items', '[]T'] },
    { indent: '\t', cells: ['Number', 'int32'] },
    { indent: '\t', cells: ['Size', 'int32'] },
    { indent: '\t', cells: ['TotalElements', 'int64'] },
    { indent: '\t', cells: ['TotalPages', 'int32'] }
  ]);
  const body = `
// Pageable es la página que pide un listado: el Pageable de Spring Data (?page=&size=&sort=), con el mismo contrato en
// los cuatro generadores. La lee el borde HTTP con sus defaults y su tope, y la recibe el puerto del repositorio.
type Pageable struct {
${pageFields.join('\n')}
}

// Offset es la primera fila de la página.
func (p Pageable) Offset() int64 {
	return int64(p.Page) * int64(p.Size)
}

// Page es una página de resultados con sus totales: la Page de Spring Data.
type Page[T any] struct {
${pageResultFields.join('\n')}
}

// NewPage construye la página de items dentro de pageable, de un total de filas. Sin elementos es la página vacía del
// contrato: cero elementos y cero páginas, también fuera de rango, con el page y el size que se pidieron.
func NewPage[T any](items []T, pageable Pageable, total int64) Page[T] {
	if len(items) == 0 {
		return Page[T]{Items: items, Number: pageable.Page, Size: pageable.Size}
	}
	pages := int32(1)
	if pageable.Size > 0 {
		pages = int32((total + int64(pageable.Size) - 1) / int64(pageable.Size))
	}
	return Page[T]{Items: items, Number: pageable.Page, Size: pageable.Size, TotalElements: total, TotalPages: pages}
}

// MapPage es la misma página con sus elementos transformados (la del dominio → la del contrato).
func MapPage[T, R any](page Page[T], convert func(T) R) Page[R] {
	items := make([]R, len(page.Items))
	for i, item := range page.Items {
		items[i] = convert(item)
	}
	return Page[R]{Items: items, Number: page.Number, Size: page.Size, TotalElements: page.TotalElements, TotalPages: page.TotalPages}
}

// SortOrder es un criterio de orden: la propiedad del dominio y su dirección.
type SortOrder struct {
${sortFields.join('\n')}
}

// SortDirection es la dirección de un criterio de orden.
type SortDirection string

// Las dos direcciones de un orden.
const (
${constants.join('\n')}
)
`;
  return { path: domainPath(model, 'Pageable'), content: packageFile(model, domain, { body }) };
}

// ─── Las migraciones embebidas ──────────────────────────────────────────────────────────────────

function migrationsGo(model) {
  const { store } = layout(model);
  const body = `
// Migrations son las migraciones de goose del esquema, embebidas en el binario: el servicio no depende del directorio
// de trabajo para crear su base. La primera (${BASELINE_FILE}) la escribe build con el esquema entero del diseño.
//
//go:embed migrations/*.sql
var Migrations embed.FS
`;
  return packageFile(model, store, { imports: ['embed'], body });
}

// ─── El DDL ──────────────────────────────────────────────────────────────────────────────────────

/**
 * El tipo físico de una columna (`columnSpec` de relational.js) en cada motor. En PostgreSQL, el que Hibernate da al
 * mismo tipo Java; en MySQL, el de keel-dotnet sobre el mismo motor (Hibernate escribe `bit` para un booleano, y
 * database/sql no lo lee como bool: `tinyint(1)`, el BOOLEAN de MySQL, sí). El enum va por el NOMBRE de su constante;
 * el `json` embebido, como el texto que llegó. El uuid de MySQL es binary(16) con los bytes del texto.
 */
export function physicalType(spec, engine = 'postgresql') {
  const mysql = engine === 'mysql';
  if (spec.enum) return 'varchar(255)';
  if (spec.long) return mysql ? 'longtext' : 'text';
  switch (spec.base) {
    case 'uuid':
      return mysql ? 'binary(16)' : 'uuid';
    case 'int':
      return mysql ? 'int' : 'integer';
    case 'long':
      return 'bigint';
    case 'boolean':
      return mysql ? 'tinyint(1)' : 'boolean';
    case 'decimal':
      return `${mysql ? 'decimal' : 'numeric'}(${spec.scale != null ? DECIMAL_PRECISION : 38},${spec.scale ?? 2})`;
    case 'date':
      return 'date';
    case 'timestamp':
      return mysql ? 'datetime(6)' : 'timestamp(6) with time zone';
    // Texto sin cota: el payload del outbox (keel-core, OUTBOX_EVENT). Es el `columnDefinition = "text"` de keel-spring y el
    // HasColumnType("text") de keel-dotnet, en los dos motores; con varchar(255) un evento real no cabía.
    case 'text':
      return 'text';
    default:
      return `varchar(${spec.length ?? 255})`;
  }
}

/**
 * Una línea de columna del CREATE TABLE. La columna GENERADA (el discriminador de un índice condicionado en MySQL)
 * lleva su expresión en vez de tipo y nulabilidad: vale 1 dentro de la condición y NULL fuera.
 */
function columnLine(spec, d) {
  if (spec.generatedAs) return { name: d.quote(spec.name), type: `tinyint GENERATED ALWAYS AS (${spec.generatedAs}) STORED`, rest: '' };
  const collation = spec.collation ? (d.mysql ? ` COLLATE ${spec.collation}` : ` COLLATE "${spec.collation}"`) : '';
  return { name: d.quote(spec.name), type: `${physicalType(spec, d.engine)}${collation}`, rest: spec.nullable ? '' : 'NOT NULL' };
}

/** La columna del id de una entidad, con otro nombre: la de una FK que apunta a ella. */
function idColumn(model, entityName, name, nullable) {
  const target = model.entities.find((candidate) => candidate.name === entityName);
  const spec = target?.idField?.columns ?? { base: 'uuid' };
  return { ...spec, name, nullable, collation: null };
}

/** Las columnas de auditoría que la política `all` pone sin que el dominio las nombre. */
function auditColumns(entity) {
  return [
    ...(entity.auditTimestamps === 'all' ? AUDIT_COLUMNS.timestamps : []),
    ...(entity.auditAuthorship === 'all' ? AUDIT_COLUMNS.authorship : [])
  ];
}

/** Las tablas del esquema, como datos: lo que escribe el SQL y lo que relee la prueba de su forma. */
export function schemaTables(model) {
  const engine = relationalEngine(model);
  const entities = model.entities.filter((entity) => entity.persisted);
  const tables = [];
  const foreignKeys = [];
  const indexes = [];
  for (const entity of entities) {
    const members = persistedMembers(model, entity);
    const columns = [];
    const constraints = [];
    const notes = [];
    if (entity.idField?.columns) columns.push(entity.idField.columns);
    for (const member of members) {
      if (member.kind === 'scalar') {
        const { field } = member;
        if (field.isId || !field.columns) continue;
        columns.push(field.columns);
        if (member.folded) columns.push({ name: member.folded.column, base: 'string', textual: true, length: member.folded.maxLength ?? 255, nullable: !member.folded.required });
        if (member.ranked) columns.push({ name: member.ranked.column, base: 'int', nullable: !member.ranked.required });
      } else if (member.kind === 'vo') {
        for (const sub of member.subs) {
          if (sub.subKind === 'composite' || !sub.sub.columns) {
            notes.push(`${member.field.namedType}.${sub.voAccessor} es un value object anidado: no tiene columnas (lo mapea el agente).`);
            continue;
          }
          // La columna aplanada: las cotas del sub-campo, NOT NULL solo si el value object entero es obligatorio.
          columns.push({ ...sub.sub.columns, name: sub.column, nullable: !(sub.ownerRequired && !sub.sub.columns.nullable) });
        }
      } else if (member.kind === 'externalRef') {
        columns.push(idColumn(model, member.relation.entity, member.column, !member.relation.required));
      } else if (member.kind === 'relationOne') {
        const column = joinColumnOf(member.relation);
        columns.push(idColumn(model, member.relation.entity, column, !member.relation.required));
        if (!member.relation.backReference) {
          const target = model.entities.find((candidate) => candidate.name === member.relation.entity);
          foreignKeys.push({ name: foreignKeyName(entity.tableName, member.relation.name), table: entity.tableName, column, refTable: target?.tableName, refColumn: target?.idField?.columns?.name ?? 'id', cascade: true });
        }
      } else if (member.kind === 'relationMany') {
        const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
        if (member.relation.cardinality === 'many-to-many' || !child) {
          notes.push(`${member.name} es many-to-many dentro del agregado: su tabla de unión la escribe el agente.`);
          continue;
        }
        const back = backReferenceTo(model, child.name, entity.name);
        foreignKeys.push({
          name: foreignKeyName(child.tableName, back ?? entity.name),
          table: child.tableName,
          column: back ? joinColumnOf({ name: back }) : parentColumnOf(entity.name),
          refTable: entity.tableName,
          refColumn: entity.idField?.columns?.name ?? 'id',
          cascade: true
        });
      } else if (member.kind === 'elementCollection') {
        tables.push(elementTableSpec(model, entity, member, foreignKeys, indexes));
      }
    }
    // La FK sintética de un one-to-many UNIDIRECCIONAL del padre: el dominio no la nombra y es nula, como la crea
    // Hibernate para un one-to-many con @JoinColumn.
    for (const parent of entities) {
      for (const relation of parent.relations ?? []) {
        if (!relation.internal || relation.cardinality !== 'one-to-many' || relation.entity !== entity.name) continue;
        if (backReferenceTo(model, entity.name, parent.name)) continue;
        columns.push(idColumn(model, parent.name, parentColumnOf(parent.name), true));
      }
    }
    if (entity.usesOptimisticLocking && !entity.declaresLockVersion) columns.push({ name: LOCK_VERSION.column, base: 'long', nullable: true });
    for (const column of auditColumns(entity)) {
      const timestamp = column.field.endsWith('At');
      columns.push({ name: column.column, base: timestamp ? 'timestamp' : 'string', textual: !timestamp, length: 255, nullable: false });
    }
    // Las marcas del ciclo de vida del dato (DSL 2.28): deleted_at y anonymized_at, del generador y fuera del dominio.
    for (const mark of lifecycleMarks(model, entity)) columns.push({ name: mark.column, base: 'timestamp', nullable: true });
    // Con borrado lógico (DSL 2.28, D4) ninguna unicidad sin condición es de toda la tabla: se evalúa solo entre filas
    // vivas, y eso es un índice parcial (abajo, con partialIndexSpecs), con el MISMO nombre.
    const live = isLogicallyDeleted(entity);

    // La unicidad: la clave natural y los campos `unique`, como constraints de tabla con su nombre. La sombra de un
    // FILTRO (`filterOnly`) no lleva la unicidad del campo: ese se compara exacto.
    const shadowOf = (name) => keyShadow(members.find((m) => m.kind === 'scalar' && m.name === name)?.field);
    if (!live && entity.naturalKey?.length > 0) {
      const keyColumns = entity.naturalKey.flatMap((name) => (shadowOf(name) ? [shadowOf(name).column] : columnsFor(model, entity, members, name)));
      constraints.push({ name: `uk_${entity.tableName}_natural`, columns: keyColumns });
    }
    for (const field of live ? [] : uniqueFields(entity)) {
      constraints.push({ name: `uk_${entity.tableName}_${field.columns?.name}`, columns: [shadowOf(field.name)?.column ?? field.columns?.name] });
    }
    // Los índices declarados (el de una lista va en su tabla de elementos), los condicionados con su predicado y el
    // de cada FK que no encabeza ya otro índice.
    const { handled } = collectionIndexesOf(entity, members);
    for (const index of entity.indexes ?? []) {
      if (index.when || handled.has(index) || (live && index.unique)) continue;
      const probe = [];
      const indexColumns = index.fields.flatMap((name) => columnsFor(model, entity, members, name, probe));
      // Un índice sobre lo que no es columna de esta tabla rompería el esquema: lo avisa el modelo.
      if (probe.length > 0) continue;
      indexes.push({ name: indexName(entity, index), table: entity.tableName, columns: indexColumns, unique: Boolean(index.unique) });
    }
    // MySQL no tiene índices parciales: el predicado va en una columna GENERADA `<índice>_flag` (1 dentro de la
    // condición, NULL fuera) al final del índice único, que no restringe las filas con NULL. Es la forma de keel-spring
    // y keel-dotnet sobre el mismo motor, con el mismo nombre de columna (discriminatorColumn de keel-core).
    for (const spec of partialIndexSpecs(model, engine).filter((candidate) => candidate.entity === entity.name)) {
      // La de un borrado lógico sin `when` trae sus columnas ya resueltas (la sombra plegada incluida): las de keel-core.
      const indexColumns = spec.when ? spec.fields.flatMap((name) => columnsFor(model, entity, members, name)) : spec.columnList.map((column) => column.replace(/^["`]|["`]$/g, ''));
      if (engine === 'mysql') {
        const flag = discriminatorColumn(spec);
        columns.push({ name: flag, generatedAs: `CASE WHEN ${spec.predicate} THEN 1 END` });
        indexes.push({ name: spec.name, table: entity.tableName, columns: [...indexColumns, flag], unique: true });
      } else {
        indexes.push({ name: spec.name, table: entity.tableName, columns: indexColumns, unique: true, predicate: spec.predicate });
      }
    }
    for (const column of foreignKeyIndexColumns(model, entity, members)) {
      indexes.push({ name: foreignKeyIndexName(entity.tableName, column), table: entity.tableName, columns: [column], unique: false });
    }
    const idName = entity.idField?.columns?.name ?? 'id';
    tables.push({ name: entity.tableName, entity: entity.name, columns, primaryKey: { name: `${entity.tableName}_pkey`, columns: [idName] }, constraints, notes });
  }
  // Las tablas en el orden del diseño: cada entidad antes que sus tablas de elementos.
  tables.sort((a, b) => order(a) - order(b));
  function order(table) {
    const index = entities.findIndex((entity) => entity.tableName === (table.owner ?? table.name));
    return index * 2 + (table.owner ? 1 : 0);
  }
  for (const fk of crossAggregateForeignKeys(model)) foreignKeys.push({ ...fk, cascade: false });
  // El registro de idempotencia de petición (request-idempotency.js): la tabla neutral de keel-core, la misma de los
  // otros tres generadores, con su clave primaria compuesta y el índice de la purga.
  // El registro de idempotencia de petición (request-idempotency.js), los almacenes de la mensajería
  // (messaging-stores.js: outbox_event y processed_event) y la marca del reclamo de reconciliación
  // (reconciliation-claim.js, tramo 11c): las tablas neutrales de keel-core, las mismas de los otros tres generadores,
  // con su clave primaria, su unicidad y los índices de la purga. Las mismas que crea un paso de esquema de build.
  const stores = [...(usesRequestIdempotency(model) ? [IDEMPOTENCY_RECORD] : []), ...storeTables(model), ...reconciliationTables(model), ...(usesTimer(model) ? [KEEL_TIMER] : [])];
  for (const store of stores) {
    tables.push({
      name: store.table,
      columns: store.columns.map((column) => ({ name: column.name, base: column.base, length: column.length, nullable: column.nullable })),
      primaryKey: { name: `${store.table}_pkey`, columns: store.columns.filter((column) => column.primary).map((column) => column.name) },
      constraints: (store.uniques ?? []).map((unique) => ({ name: unique.name, columns: unique.columns })),
      notes: []
    });
    for (const index of store.indexes) indexes.push({ name: index.name, table: store.table, columns: index.columns, unique: false });
  }
  return { tables, foreignKeys, indexes };
}

/** La tabla de elementos de una lista: clave (raíz, posición), el valor y la FK a la raíz. */
function elementTableSpec(model, entity, member, foreignKeys, indexes) {
  const table = elementTable(entity, member);
  const idName = entity.idField?.columns?.name ?? 'id';
  const columns = [idColumn(model, entity.name, table.joinColumn, false), { name: table.orderColumn, base: 'int', nullable: false }];
  const notes = [];
  if (member.element.kind === 'vo') {
    const vo = model.valueObjects.find((candidate) => candidate.name === member.field.namedType);
    for (const sub of vo?.fields ?? []) {
      if (sub.kind === 'composite' || !sub.columns) {
        notes.push(`${vo.name}.${sub.name} es un value object anidado: no tiene columnas (lo mapea el agente).`);
        continue;
      }
      columns.push(sub.columns);
    }
  } else if (member.field.elementColumns) {
    columns.push(member.field.elementColumns);
  }
  foreignKeys.push({ name: table.foreignKey, table: table.table, column: table.joinColumn, refTable: entity.tableName, refColumn: idName, cascade: true });
  // El índice que el diseño declara sobre esta lista (valor primero, FK detrás) y, SIEMPRE, el de la FK a la raíz:
  // cargar la lista de una raíz es un WHERE sobre esa columna.
  const { byMember } = collectionIndexesOf(entity, persistedMembers(model, entity));
  for (const index of byMember.get(member.name) ?? []) {
    indexes.push({ name: indexName(entity, index), table: table.table, columns: [table.valueColumn, table.joinColumn], unique: Boolean(index.unique) });
  }
  indexes.push({ name: table.foreignKeyIndex, table: table.table, columns: [table.joinColumn], unique: false });
  return {
    name: table.table,
    owner: entity.tableName,
    columns,
    primaryKey: { name: `${table.table}_pkey`, columns: [table.joinColumn, table.orderColumn] },
    constraints: [],
    notes
  };
}

function createTable(table, d) {
  const rows = table.columns.map((spec) => {
    const line = columnLine(spec, d);
    return [line.name, line.type, line.rest];
  });
  // Alineado a mano: el SQL no pasa por gofmt, pero se lee y se revisa en un diff.
  const widths = [0, 1].map((col) => Math.max(...rows.map((row) => row[col].length)));
  const lines = rows.map((row) => `    ${row[0].padEnd(widths[0])} ${row[2] ? `${row[1].padEnd(widths[1])} ${row[2]}` : row[1]}`.trimEnd());
  // En MySQL la clave primaria se llama siempre PRIMARY: el nombre se escribe igual, y el motor lo ignora.
  lines.push(`    CONSTRAINT ${table.primaryKey.name} PRIMARY KEY (${table.primaryKey.columns.map(d.quote).join(', ')})`);
  for (const constraint of table.constraints) lines.push(`    CONSTRAINT ${constraint.name} UNIQUE (${constraint.columns.map(d.quote).join(', ')})`);
  const notes = table.notes.map((note) => `-- ${note}\n`).join('');
  return `${notes}CREATE TABLE ${d.quote(table.name)} (\n${lines.join(',\n')}\n);`;
}

function createIndex(index, d) {
  const where = index.predicate ? ` WHERE ${index.predicate}` : '';
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${index.name} ON ${d.quote(index.table)} (${index.columns.map(d.quote).join(', ')})${where};`;
}

function addForeignKey(fk, d) {
  const onDelete = fk.cascade ? ' ON DELETE CASCADE' : '';
  return `ALTER TABLE ${d.quote(fk.table)} ADD CONSTRAINT ${fk.name}\n    FOREIGN KEY (${d.quote(fk.column)}) REFERENCES ${d.quote(fk.refTable)} (${d.quote(fk.refColumn)})${onDelete};`;
}

/**
 * La vuelta atrás: las tablas en orden inverso. En MySQL una FK de otro agregado impide borrar la tabla a la que
 * apunta, y DROP no tiene CASCADE: se apagan las comprobaciones durante el Down, en la misma conexión (goose lo ejecuta
 * en una transacción).
 */
function downSql(tables, d) {
  const drops = [...tables].reverse().map((table) => `DROP TABLE IF EXISTS ${d.quote(table.name)}${d.mysql ? '' : ' CASCADE'};`);
  return d.mysql ? ['SET FOREIGN_KEY_CHECKS = 0;', ...drops, 'SET FOREIGN_KEY_CHECKS = 1;'] : drops;
}

/**
 * La migración baseline de goose: el esquema entero, y su vuelta atrás. `without` quita unas tablas (con sus índices):
 * es la baseline que build habría escrito sin ellas, con la que evolution.js mide si lo único que cambió en la baseline
 * son las tablas del generador que ya crea un paso de esquema.
 */
export function baselineSql(model, { without = [] } = {}) {
  const d = sqlDialect(model);
  const schema = schemaTables(model);
  const tables = schema.tables.filter((table) => !without.includes(table.name));
  const indexes = schema.indexes.filter((index) => !without.includes(index.table));
  const { foreignKeys } = schema;
  const up = [
    ...tables.map((table) => createTable(table, d)),
    ...indexes.map((index) => createIndex(index, d)),
    ...[...foreignKeys].sort((a, b) => a.name.localeCompare(b.name)).map((fk) => addForeignKey(fk, d))
  ];
  return `-- ${GENERATED_HEADER.replace(/^\/\/ /, '')}
--
-- El esquema de ${model.service.name} en ${d.label}: tablas, constraints, índices y FK con los nombres de
-- keel-core/gen/relational.js, los mismos que los otros tres generadores. Lo aplica goose al arrancar.

-- +goose Up
${up.join('\n\n')}

-- +goose Down
${downSql(tables, d).join('\n')}
`;
}

// ─── Los pasos de esquema de build ──────────────────────────────────────────────────────────────
//
// Una tabla del generador (outbox, guarda de mensajes, idempotencia, reconciliación, cronómetro) que aparece en un
// proyecto que ya tiene base desplegada no llega con la baseline: goose no reaplica una migración de su historial, así
// que la baseline reescrita no se vuelve a ejecutar y el servidor caería en la primera consulta que toque la tabla.
// Llega como un PASO de goose que escribe build (keel-core/gen/schema-steps.js, el mismo mecanismo de los otros tres):
// `<NNNNN>_keel_<tablas>.sql`, con el número siguiente al último paso que hay en disco.
//
// Lo que la base ya tiene se lee de las migraciones de disco ANTES de escribir: en keel-go build reescribe la baseline
// si nadie la tocó, así que la de disco es todavía la que aplicó la base desplegada. El SQL del paso es idempotente
// (IF NOT EXISTS): una base NUEVA aplica la baseline nueva, que ya trae la tabla, y después el paso, que no hace nada;
// una DESPLEGADA se salta la baseline (ya la tiene) y el paso le crea la tabla. Las dos acaban con el mismo esquema.

/** Un paso de goose por su nombre: `00002_add_product_weight.sql`. La versión es la parte numérica. */
const GOOSE_STEP = /^(\d+)_.+\.sql$/;

/** El ancho de la versión, el de la baseline (`00001`): goose ordena por el número, pero el directorio se lee mejor así. */
const VERSION_WIDTH = BASELINE_FILE.indexOf('_');

/**
 * Las tablas del generador que este proyecto emite: las que lleva su baseline. Es el mismo predicado que la escribe
 * (`schemaTables`), así que no puede haber una tabla en la baseline sin paso posible ni al revés.
 */
export function generatorTables(model) {
  if (!usesRelational(model)) return [];
  const names = new Set(schemaTables(model).tables.map((table) => table.name));
  return GENERATOR_TABLES.filter((table) => names.has(table.table));
}

/**
 * El paso de goose que envuelve el SQL de `schemaStepSql`, sin tocarlo: el `Up` es ese SQL byte a byte (goose separa las
 * sentencias por el `;` del final de línea, y ninguna lleva `;` dentro, así que no hace falta `StatementBegin`). Lleva la
 * marca del generador y no la cabecera de código generado de Go: es SQL, y su regla es otra (no se edita nunca, tampoco
 * por build). El `Down` borra las tablas del paso, en orden inverso, con IF EXISTS: es la vuelta exacta en una base
 * desplegada; en una nueva, la tabla era también de la baseline, y volver a subir el paso la recrea.
 */
export function gooseStep({ sql, header, tables }) {
  const drops = [...tables].reverse().map((table) => `DROP TABLE IF EXISTS ${table.table};`);
  return `${header.map((line) => `-- ${line}`).join('\n')}\n\n-- +goose Up\n${sql}\n-- +goose Down\n${drops.join('\n')}\n`;
}

/**
 * Los pasos de goose que build emite en esta pasada (los suyos de antes, tal cual, y el nuevo si hace falta), con lo
 * que EVOLUTION.md tiene que decir y las tablas que crea el nuevo (`tables`, para evolution.js). Vacío en el modelo
 * documental: allí los índices los asegura el arranque. Sin la baseline en disco (la primera generación) no hay base
 * desplegada que proteger, y nada.
 */
export function schemaSteps(model, projectDir) {
  if (!usesRelational(model)) return { files: [], added: [], work: [], tables: [] };
  let created = [];
  const result = schemaStepFiles({
    projectDir,
    dir: `${layout(model).store.dir}/migrations`,
    tables: generatorTables(model),
    engine: relationalEngine(model),
    isMigration: (name) => GOOSE_STEP.test(name),
    isBaseline: (name) => name === BASELINE_FILE,
    versionOf: (name) => GOOSE_STEP.exec(name)?.[1] ?? null,
    renderStep: (step) => {
      created = step.tables.map((table) => table.table);
      return { name: `${String(step.version).padStart(VERSION_WIDTH, '0')}_${step.slug}.sql`, content: gooseStep(step) };
    }
  });
  return { ...result, tables: created };
}
