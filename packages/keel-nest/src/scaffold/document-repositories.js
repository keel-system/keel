// El ADAPTADOR documental de cada raíz de agregado (incremento 12): `<Raíz>RepositoryImpl` sobre el
// driver oficial de MongoDB, con el mapeo dominio ↔ documento escrito campo a campo. El PUERTO es el
// mismo que en la rama relacional (repositories.js): el dominio no sabe qué almacén hay debajo.
//
// El documento es el de keel-core/gen/document.js, el mismo que escribe keel-spring: el agregado es
// el documento, las hijas van anidadas dentro de la raíz, un value object es un subdocumento y una
// referencia a otro agregado es su id. Cada valor pasa por bson-values.ts, con la representación
// física del contrato.
//
// Lo que aquí escribe el adaptador porque el driver no lo hace:
//   · el BLOQUEO OPTIMISTA: la versión va en el filtro del UPDATE; cero coincidencias es otra escritura
//     que ganó (o un borrado), y sale como conflicto. Un agregado nuevo se INSERTA con la versión 0;
//   · la AUDITORÍA: `created_*` no cambia después de nacer —`$setOnInsert` con la política `all`, la
//     del dominio con `declared`— y `updated_*` se estampa en cada escritura, como el callback de
//     auditoría de Spring Data. Guardar es un `$set` del documento entero y no un reemplazo, para que
//     lo que el dominio no lleva (la auditoría de política) no se pierda.

import { persistedMembers, collectInternalEntities, LOCK_VERSION } from 'keel-core/gen';
import { documentShape, DOCUMENT_ID, storageOf } from 'keel-core/gen/document';
import { snakeCase } from 'keel-core/gen/naming';
import { DIRS, classPath, entityDir, tsModule, tsString } from './render.js';
import { domainMembers } from './entities.js';
import { TEXT_FOLD_TS } from './persistence-entities.js';
import { BSON_VALUES_TS } from './document-persistence.js';
import { PERSISTENCE_ERRORS_TS, PAGE_TS, TRANSACTION_CONTEXT_TS, adapterClass, adapterPath, portClass, portPath, isPaginated, naturalKeyFinder, occupantFinders } from './repositories.js';

// ─── Valores ─────────────────────────────────────────────────────────────────

/** La expresión que lleva un valor ESCALAR del dominio al documento (`expr` es el valor del dominio). */
function writeScalar(field, expr, use) {
  if (field.kind === 'enum') {
    use.enum(field.namedType);
    return use.helper('toEnumName', `${field.namedType}, ${expr}`);
  }
  switch (storageOf(field)) {
    case 'uuid':
      return use.helper('toUuid', expr);
    case 'decimal128':
      return use.helper('toDecimal128', expr);
    case 'long':
      return use.helper('toInt64', expr);
    case 'date':
      return field.base === 'date' ? use.helper('toDay', expr) : expr;
    default:
      return field.base === 'json' ? use.helper('toJsonText', expr) : expr;
  }
}

/** La expresión que lleva un valor ESCALAR del documento al dominio (`expr` es el valor guardado). */
function readScalar(field, expr, use, required) {
  if (field.kind === 'enum') {
    use.enum(field.namedType);
    return use.helper('fromEnumName', `${field.namedType}, ${expr}`);
  }
  switch (storageOf(field)) {
    case 'uuid':
      return use.helper('fromUuid', expr);
    case 'decimal128':
      return use.helper('fromDecimal128', expr);
    case 'long':
      return use.helper('fromInt64', expr);
    case 'date':
      if (field.base === 'date') return use.helper('fromDay', expr);
      return required ? expr : `${expr} ?? null`;
    default:
      if (field.base === 'json') return use.helper('fromJsonText', expr);
      // Un campo opcional ausente del documento (otro cliente no lo escribió) es null, no undefined.
      return required ? expr : `${expr} ?? null`;
  }
}

// ─── Value objects ───────────────────────────────────────────────────────────

/** El par de funciones de un value object: a subdocumento y de vuelta. Los anidados, por recursión. */
function valueObjectFunctions(model, voName, use, done = new Set()) {
  if (done.has(voName)) return [];
  done.add(voName);
  const vo = model.valueObjects.find((candidate) => candidate.name === voName);
  if (!vo) return [];
  use.import({ symbol: vo.name, from: classPath(DIRS.valueObjects, vo.name) });
  const out = [];
  const writes = [];
  const reads = [];
  for (const sub of vo.fields) {
    const key = snakeCase(sub.name);
    const value = `value.${sub.name}`;
    if (sub.kind === 'composite') {
      out.push(...valueObjectFunctions(model, sub.namedType, use, done));
      writes.push(`    ${key}: ${sub.required ? `toDocument${sub.namedType}(${value})` : `${value} == null ? null : toDocument${sub.namedType}(${value})`}`);
      reads.push(sub.required ? `toDomain${sub.namedType}(document.${key})` : `document.${key} == null ? null : toDomain${sub.namedType}(document.${key})`);
    } else {
      writes.push(`    ${key}: ${writeScalar(sub, value, use)}`);
      reads.push(readScalar(sub, `document.${key}`, use, sub.required));
    }
  }
  out.push(`/** ${vo.name} → su subdocumento. */
function toDocument${vo.name}(value: ${vo.name}): Document {
  return {
${writes.join(',\n')}
  };
}

/** Su subdocumento → ${vo.name}. */
function toDomain${vo.name}(document: Document): ${vo.name} {
  return new ${vo.name}(${reads.join(', ')});
}`);
  return out;
}

// ─── Entidades ───────────────────────────────────────────────────────────────

/** La clave del documento de un miembro del dominio, leída de la forma neutral. */
function keyOf(model, entity, memberName) {
  const shape = documentShape(model, entity);
  return shape.find((entry) => entry.member === memberName)?.name ?? snakeCase(memberName);
}

function entityFunctions(model, entity, use, vos) {
  const shape = documentShape(model, entity);
  const members = persistedMembers(model, entity);
  const writes = [];
  for (const entry of shape) {
    const value = `entity.${entry.member}`;
    if (entry.kind === 'id' || entry.kind === 'scalar') {
      writes.push(`    ${entry.name}: ${writeScalar(entry.field, value, use)}`);
    } else if (entry.kind === 'folded') {
      const folded = members.find((m) => m.kind === 'scalar' && m.name === entry.of)?.folded;
      use.import({ symbol: 'TextFold', from: TEXT_FOLD_TS });
      writes.push(`    ${entry.name}: TextFold.${folded?.accents ? 'foldCaseAndAccents' : 'foldCase'}(entity.${entry.of})`);
    } else if (entry.kind === 'ref') {
      writes.push(`    ${entry.name}: ${use.helper('toUuid', value)}`);
    } else if (entry.kind === 'subdocument' && entry.valueObject) {
      vos.add(entry.valueObject);
      writes.push(`    ${entry.name}: ${entry.field.required ? `toDocument${entry.valueObject}(${value})` : `${value} == null ? null : toDocument${entry.valueObject}(${value})`}`);
    } else if (entry.kind === 'subdocument' && entry.entity) {
      writes.push(`    ${entry.name}: ${value} == null ? null : toDocument${entry.entity}(${value})`);
    } else if (entry.kind === 'array' && entry.element.valueObject) {
      vos.add(entry.element.valueObject);
      writes.push(`    ${entry.name}: ${value}.map(toDocument${entry.element.valueObject})`);
    } else if (entry.kind === 'array' && entry.element.entity) {
      writes.push(`    ${entry.name}: ${value}.map(toDocument${entry.element.entity})`);
    } else if (entry.kind === 'array') {
      writes.push(`    ${entry.name}: ${value}.map((element) => ${writeScalar(entry.field, 'element', use)})`);
    }
    // `version` y `audit` no salen del dominio: los pone save().
  }

  const reads = [];
  for (const member of domainMembers(model, entity)) {
    const key = keyOf(model, entity, member.name);
    const source = `document.${key}`;
    if (member.kind === 'externalRef') {
      reads.push(`    ${member.name}: ${use.helper('fromUuid', source)}`);
    } else if (member.kind === 'relationMany') {
      reads.push(`    ${member.name}: ((${source} ?? []) as Document[]).map(toDomain${member.relation.entity})`);
    } else if (member.kind === 'relationOne') {
      reads.push(`    ${member.name}: ${source} == null ? null : toDomain${member.relation.entity}(${source})`);
    } else {
      const field = member.field;
      if (field.list && field.kind === 'composite') {
        vos.add(field.namedType);
        reads.push(`    ${member.name}: ((${source} ?? []) as Document[]).map(toDomain${field.namedType})`);
      } else if (field.list) {
        reads.push(`    ${member.name}: ((${source} ?? []) as Document[keyof Document][]).map((element) => ${readScalar(field, 'element', use, true)})`);
      } else if (field.kind === 'composite') {
        vos.add(field.namedType);
        reads.push(`    ${member.name}: ${field.required ? `toDomain${field.namedType}(${source})` : `${source} == null ? null : toDomain${field.namedType}(${source})`}`);
      } else {
        reads.push(`    ${member.name}: ${readScalar(field, source, use, field.required || field.isId || field.generated)}`);
      }
    }
  }
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) {
    reads.push(`    ${LOCK_VERSION.field}: document.${LOCK_VERSION.column} == null ? null : Number(document.${LOCK_VERSION.column})`);
  }
  use.import({ symbol: entity.name, from: classPath(entityDir(entity), entity.name) });
  return `/** ${entity.name} → su documento${entity.isAggregateRoot ? '' : ' (anidado dentro del de su raíz)'}. */
function toDocument${entity.name}(entity: ${entity.name}): Document {
  return {
${writes.join(',\n')}
  };
}

/** Su documento → ${entity.name}. */
function toDomain${entity.name}(document: Document): ${entity.name} {
  return new ${entity.name}({
${reads.join(',\n')}
  });
}`;
}

// ─── Consultas ───────────────────────────────────────────────────────────────

/**
 * El filtro de un finder por clave (la clave natural o la de un índice condicionado) en rutas del
 * documento, con cada valor convertido como se guarda. Los parámetros son los del PUERTO
 * (repositories.js): mismo nombre, mismo tipo.
 */
function keyFilter(model, entity, finder, use) {
  const members = persistedMembers(model, entity);
  const conditions = [];
  for (const param of finder.params) {
    const member = members.find((m) => m.name === param.name || (m.kind === 'externalRef' && m.name === param.name));
    if (member?.kind === 'externalRef') {
      conditions.push(`${tsString(member.column)}: ${use.helper('toUuid', param.name)}`);
    } else if (member?.kind === 'vo') {
      const vo = member.vo;
      for (const sub of vo?.fields ?? []) {
        if (sub.kind === 'composite') continue;
        conditions.push(`${tsString(`${snakeCase(member.name)}.${snakeCase(sub.name)}`)}: ${writeScalar(sub, `${param.name}.${sub.name}`, use)}`);
      }
    } else if (member?.kind === 'scalar') {
      conditions.push(`${tsString(keyOf(model, entity, member.name))}: ${writeScalar(member.field, param.name, use)}`);
    } else {
      conditions.push(`${tsString(snakeCase(param.name))}: ${param.name}`);
    }
  }
  return `{ ${conditions.join(', ')} }`;
}

/**
 * Las propiedades por las que se puede ordenar un listado, con su ruta en el documento. En el modelo
 * documental la propiedad es la RUTA del espejo, la que acepta el `?sort=` de keel-spring sobre su
 * `XxxDocument` y la que el modelo neutral pone en el orden por defecto del diseño: un value object es
 * `location.label` (no el `locationLabel` aplanado de la rama relacional) y una hija anidada también
 * se puede recorrer (`sections.status`). Cada segmento va a su clave del documento: `sections.id` es
 * `sections._id`.
 */
function sortablePaths(model, entity) {
  const paths = [];
  const visitValueObject = (voName, property, path, seen) => {
    const vo = model.valueObjects.find((candidate) => candidate.name === voName);
    if (!vo || seen.has(voName)) return;
    for (const sub of vo.fields) {
      const subProperty = `${property}.${sub.name}`;
      const subPath = `${path}.${snakeCase(sub.name)}`;
      if (sub.kind === 'composite') visitValueObject(sub.namedType, subProperty, subPath, new Set([...seen, voName]));
      else paths.push([subProperty, subPath]);
    }
  };
  const visit = (current, prefix, pathPrefix, seen) => {
    for (const entry of documentShape(model, current)) {
      if (entry.kind === 'audit' && entry.role !== 'createdDate' && entry.role !== 'lastModifiedDate') continue;
      const property = prefix ? `${prefix}.${entry.member}` : entry.member;
      const path = pathPrefix ? `${pathPrefix}.${entry.name}` : entry.name;
      if (entry.kind === 'subdocument' && entry.valueObject) visitValueObject(entry.valueObject, property, path, new Set());
      else if ((entry.kind === 'subdocument' || entry.kind === 'array') && (entry.entity ?? entry.element?.entity)) {
        const child = model.entities.find((candidate) => candidate.name === (entry.entity ?? entry.element.entity));
        if (child && !seen.has(child.name)) visit(child, property, path, new Set([...seen, child.name]));
      } else if (entry.kind !== 'array' && entry.kind !== 'version') paths.push([property, path]);
    }
  };
  visit(entity, '', '', new Set([entity.name]));
  return paths;
}

// ─── El adaptador ────────────────────────────────────────────────────────────

/** El camino de una hija dentro del documento de la raíz: los nombres de los campos que la anidan. */
function nestedPath(model, from, target, seen = new Set()) {
  for (const relation of from.relations ?? []) {
    if (!relation.internal || relation.backReference || seen.has(relation.entity)) continue;
    const next = model.entities.find((candidate) => candidate.name === relation.entity);
    if (!next) continue;
    const toMany = relation.cardinality === 'one-to-many' || relation.cardinality === 'many-to-many';
    const step = { key: snakeCase(relation.name), toMany };
    if (next === target) return [step];
    const rest = nestedPath(model, next, target, new Set([...seen, from.name]));
    if (rest) return [step, ...rest];
  }
  return null;
}

/** Las líneas que estampan la auditoría DECLARADA (campos del dominio) en la raíz y sus hijas. */
function declaredAuditStamps(model, entity) {
  const lines = [];
  for (const candidate of collectInternalEntities(model, entity).filter((c) => c.persisted)) {
    if (candidate.auditTimestamps !== 'declared') continue;
    const created = candidate.fields.some((field) => field.name === 'createdAt');
    const updated = candidate.fields.some((field) => field.name === 'updatedAt');
    const stamps = [created ? 'node.created_at ??= now;' : null, updated ? 'node.updated_at = now;' : null].filter(Boolean).join(' ');
    if (!stamps) continue;
    if (candidate === entity) {
      lines.push(stamps.replaceAll('node.', 'document.'));
      continue;
    }
    const path = nestedPath(model, entity, candidate);
    if (!path) continue;
    const nodes = path.reduce(
      (expr, { key, toMany }) => `${expr}.flatMap((node: Document) => ${toMany ? `(node.${key} ?? []) as Document[]` : `[node.${key}].filter((child) => child != null) as Document[]`})`,
      '[document]'
    );
    lines.push(`for (const node of ${nodes}) { ${stamps} }`);
  }
  return lines;
}

function saveMethod(model, entity, use) {
  const idName = entity.idField?.name ?? 'id';
  const versioned = entity.usesOptimisticLocking;
  const policyTimestamps = model.audit?.timestamps === 'all';
  const lines = [`      const document = toDocument${entity.name}(entity);`];
  const declared = declaredAuditStamps(model, entity);
  if (declared.length > 0 || policyTimestamps) lines.push('      const now = new Date();');
  lines.push(...declared.map((line) => `      ${line}`));
  lines.push(`      const { ${DOCUMENT_ID}: id, ...fields } = document;`);
  if (policyTimestamps) lines.push('      // La auditoría de política: `updated_at` en cada escritura, `created_at` solo al nacer.', '      fields.updated_at = now;');
  const creation = policyTimestamps ? ', $setOnInsert: { created_at: now }' : '';
  if (versioned) {
    use.import({ symbol: 'OptimisticLockConflict', from: PERSISTENCE_ERRORS_TS });
    const versionProp = entity.declaresLockVersion ? 'lockVersion' : LOCK_VERSION.field;
    lines.push(`      const expected = entity.${versionProp};
      if (expected == null) {
        // Agregado nuevo: nace con la versión 0, como el @Version de Spring Data al insertar. Un id que ya
        // existe es una violación del _id, que sale como conflicto de integridad.
        fields.${LOCK_VERSION.column} = 0n;${policyTimestamps ? '\n        fields.created_at = now;' : ''}
        await this.collection.insertOne({ ${DOCUMENT_ID}: id, ...fields }, { session });
      } else {
        // La versión va en el FILTRO: si otra escritura la subió (o borró el documento) no casa nada, y
        // reaplicar esta reharía en silencio una intención obsoleta.
        fields.${LOCK_VERSION.column} = BigInt(Number(expected) + 1);
        const updated = await this.collection.updateOne(
          { ${DOCUMENT_ID}: id, ${LOCK_VERSION.column}: BigInt(Number(expected)) },
          { $set: fields${creation} },
          { session }
        );
        if (updated.matchedCount === 0) throw new OptimisticLockConflict(${tsString(entity.name)}, String(entity.${idName}));
      }`);
  } else {
    lines.push(`      await this.collection.updateOne({ ${DOCUMENT_ID}: id }, { $set: fields${creation} }, { upsert: true, session });`);
  }
  const emitsEvents = (model.events ?? []).some((event) => event.aggregates.includes(entity.name));
  // Sin mensajería sobre el documento todavía (incremento 12c) nadie los escucha, pero se vacían igual
  // para que el buffer no crezca con cada escritura.
  if (emitsEvents) lines.push('      entity.pullDomainEvents();');
  lines.push(`      return toDomain${entity.name}({ ${DOCUMENT_ID}: id, ...fields });`);
  return `  async save(entity: ${entity.name}): Promise<${entity.name}> {
    return this.transactions.inTransaction(async (session) => {
${lines.join('\n')}
    });
  }`;
}

/** El adaptador documental de una raíz. Lo llama repositories.js con el modelo `document`. */
export function renderDocumentAdapter(model, entity) {
  const file = adapterPath(entity);
  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'ClientSession', from: 'mongodb', type: true },
    { symbol: 'Collection', from: 'mongodb', type: true },
    { symbol: 'Document', from: 'mongodb', type: true },
    { symbol: 'StoredDocument', from: BSON_VALUES_TS, type: true },
    { symbol: portClass(entity), from: portPath(entity) },
    { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS }
  ];
  const helpers = new Set();
  const use = {
    helper: (name, args) => {
      helpers.add(name);
      return `${name}(${args})`;
    },
    enum: (name) => imports.push({ symbol: name, from: classPath(DIRS.enums, name) }),
    import: (imp) => imports.push(imp)
  };

  const involved = collectInternalEntities(model, entity).filter((candidate) => candidate.persisted);
  const vos = new Set();
  const entityFns = involved.map((candidate) => entityFunctions(model, candidate, use, vos));
  const voFns = [];
  const done = new Set();
  for (const vo of vos) voFns.push(...valueObjectFunctions(model, vo, use, done));

  const id = entity.idField;
  const idName = id?.name ?? 'id';
  const idType = id?.tsType ?? 'string';
  const idFilter = `{ ${DOCUMENT_ID}: ${id ? writeScalar(id, idName, use) : idName} }`;
  const methods = [];
  methods.push(`  async findById(${idName}: ${idType}): Promise<${entity.name} | null> {
    const found = await this.collection.findOne(${idFilter}, { session: this.session });
    return found == null ? null : toDomain${entity.name}(found);
  }`);

  const finders = [naturalKeyFinder(model, entity), ...occupantFinders(model, entity)].filter(Boolean);
  for (const finder of finders) {
    for (const param of finder.params) imports.push(...param.imports);
    // El finder de un índice condicionado recibe también el estado (es un parámetro más del puerto).
    const filter = keyFilter(model, entity, finder, use);
    methods.push(`  async ${finder.name}(${finder.params.map((p) => `${p.name}: ${p.type}`).join(', ')}): Promise<${entity.name} | null> {
    const found = await this.collection.findOne(${filter}, { session: this.session });
    return found == null ? null : toDomain${entity.name}(found);
  }`);
  }

  if (isPaginated(model, entity)) {
    imports.push({ symbol: 'Page', from: PAGE_TS, type: true }, { symbol: 'Pageable', from: PAGE_TS, type: true });
    imports.push({ symbol: 'Sort', from: 'mongodb', type: true });
    methods.push(`  async list(pageable: Pageable): Promise<Page<${entity.name}>> {
    // Una tras otra y no en paralelo: dentro de una transacción el driver no admite operaciones
    // concurrentes sobre la misma sesión.
    const documents = await this.collection
      .find({}, { session: this.session })
      .sort(withStableOrder(pageable))
      .skip(pageable.page * pageable.size)
      .limit(pageable.size)
      .toArray();
    const total = await this.collection.countDocuments({}, { session: this.session });
    return {
      items: documents.map(toDomain${entity.name}),
      page: pageable.page,
      size: pageable.size,
      totalElements: total,
      totalPages: Math.ceil(total / pageable.size)
    };
  }`);
  }

  methods.push(saveMethod(model, entity, use));
  methods.push(`  async deleteById(${idName}: ${idType}): Promise<void> {
    // El agregado es el documento: borrarlo borra también sus hijas, que van dentro.
    await this.transactions.inTransaction((session) => this.collection.deleteOne(${idFilter}, { session }));
  }`);

  for (const name of helpers) imports.push({ symbol: name, from: BSON_VALUES_TS });
  const paginated = isPaginated(model, entity) ? stableOrderHelper(model, entity) : '';
  const body = `/** La colección del agregado: el documento de la raíz, con sus hijas dentro. */
const COLLECTION = ${tsString(entity.collectionName)};

${paginated}/**
 * Adaptador del puerto ${portClass(entity)} sobre el driver de MongoDB. Toma la sesión de la
 * transacción abierta (la abre el UseCaseMediator); sin ella, cada lectura va sola y cada escritura
 * abre la suya.
 */
@Injectable()
export class ${adapterClass(entity)} extends ${portClass(entity)} {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {
    super();
  }

  private get collection(): Collection<StoredDocument> {
    return this.transactions.collection(COLLECTION);
  }

  private get session(): ClientSession | undefined {
    return this.transactions.session();
  }

${methods.join('\n\n')}
}

// ─── Mapeo dominio ↔ documento ───────────────────────────────────────────────

${[...entityFns, ...voFns].join('\n\n')}`;
  return { path: file, content: tsModule(file, imports, body) };
}

function stableOrderHelper(model, entity) {
  const paths = sortablePaths(model, entity);
  return `/** Las propiedades por las que se puede ordenar, con su ruta en el documento. */
const SORTABLE = new Map<string, string>([
${paths.map(([property, path]) => `  [${tsString(property)}, ${tsString(path)}]`).join(',\n')}
]);

/**
 * El orden pedido más el \`_id\` como último criterio si no está ya: sin desempate, dos páginas
 * consecutivas pueden repetir un documento y omitir otro. Una propiedad que no existe es un error,
 * como la PropertyReferenceException de Spring Data.
 */
function withStableOrder(pageable: Pageable): Sort {
  const order: Record<string, 1 | -1> = {};
  for (const { property, direction } of pageable.sort) {
    const path = SORTABLE.get(property);
    if (path == null) throw new Error(\`No existe la propiedad '\${property}' para ordenar ${entity.name}\`);
    order[path] ??= direction === 'desc' ? -1 : 1;
  }
  order['${DOCUMENT_ID}'] ??= 1;
  return order;
}

`;
}
