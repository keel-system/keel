// El adaptador DOCUMENTAL de cada raíz de agregado (incremento 12): implementa el MISMO puerto `<Raíz>Repository` que la
// rama relacional (repositories.js), en `internal/infrastructure/mongo`, sobre el documento de keel-core/gen/document.js.
//
// La diferencia de fondo cabe en una frase: el agregado ES el documento. La raíz es una colección; sus entidades internas
// van anidadas dentro de ella (también a varios niveles); un value object es un subdocumento; una referencia a OTRO
// agregado es su id en `<relación>_id`. Por eso leer un agregado es UNA lectura, sin consultas por hija.
//
// Tres decisiones que no son obvias:
//   · el mapeo va campo a campo, escrito por build: `encode<E>` arma el bson.D en el orden del contrato y `decode<E>` lee
//     el bson.Raw con los lectores de bson_values.go y rehidrata (`Rehydrate<E>`). El mapeo por reflexión del driver
//     decidiría nombres, omisiones y representaciones por su cuenta, y el otro servidor del diseño lee lo que este escribe;
//   · guardar es `$set` sobre el documento, nunca reemplazarlo: lo que el dominio no modela (la auditoría de la política,
//     created_* en `$setOnInsert`) se conserva. Con bloqueo optimista la versión va en el FILTRO, y no casar con ningún
//     documento es otra escritura que ganó (409); sin él, es un upsert. Lo guardado se RELEE en la misma transacción;
//   · un listado ordena por la RUTA del documento (`sortablePaths` de keel-core: `location.label`, no la columna aplanada
//     de la rama relacional), con el `_id` como desempate.

import { inverseFindersOf } from '@keel-system/keel-core/gen/inverse-collections';
import { idBatchReason } from '@keel-system/keel-core/gen/ref-targets';
import { DOCUMENT_ID, documentShape, sortablePaths } from '@keel-system/keel-core/gen/document';
import { claimOrderField, claimsForEntity, orderingFieldOf, persistedMembers, snakeCase } from '@keel-system/keel-core/gen';
import { SYSTEM_ACTOR } from '@keel-system/keel-core/gen/relational';
import { isPaginated, repositoryRoots, usesDocument } from '@keel-system/keel-core/gen/features';
import { enumConstant, goExported } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { isDeclaredLockVersion } from './entities.js';
import { entityFinders, finderMethod, finderParams, finderResult, fixedArg } from './finders.js';
import { docComment, goFileName, isOptional, layout, localName, packageFile } from './render.js';
import { declaredAuthorship, usesDeclaredAuthorship } from './audit-actor.js';
import { emitsEvents, usesGoOutbox } from './messaging.js';
import { claimDependencies, claimMethod, storedState } from './claim.js';
import { deadlineDependencies, documentArming, sweepPassSignal } from './timer.js';
import { documentReconciliationMethods, reconciliationDependencies } from './reconciliation-claim.js';
import { credentialFinders, keyFinders, naturalKeyBatchFinder, portName, rankedEnums } from './repositories.js';
import { BSON, MONGO_DRIVER, MONGO_OPTIONS } from './document-persistence.js';
import { parameterAccessor } from './service-parameters.js';
import { loadExpectingAdapter, loadsExpecting } from './conditional-writes.js';
import { documentGuardMethods } from './mail.js';

const ADAPTER_IMPORTS = [
  'cmp',
  'context',
  'encoding/json/jsontext',
  'errors',
  'fmt',
  'regexp',
  'slices',
  'time',
  'github.com/google/uuid',
  MONGO_DRIVER,
  BSON,
  MONGO_OPTIONS,
  'internal/application',
  'internal/domain',
  'internal/platform/textfold',
  'internal/platform/wire',
  'internal/infrastructure/messaging',
  'internal/infrastructure/timer'
];

const lower = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;

export function generate(model) {
  if (!usesDocument(model)) return [];
  const roots = repositoryRoots(model);
  if (roots.length === 0) return [];
  const { store } = layout(model);
  const files = [];
  const uses = new Set();
  for (const entity of roots) {
    files.push({ path: `${store.dir}/${goFileName(entity.name)}_repository.go`, content: packageFile(model, store, { imports: ADAPTER_IMPORTS, body: adapterBody(model, entity, uses) }) });
  }
  files.push({ path: `${store.dir}/documents.go`, content: packageFile(model, store, { imports: [...ADAPTER_IMPORTS, 'slices', 'strings'], body: documentsBody(model, uses) }) });
  return files;
}

// ─── Los valores: dominio ↔ BSON ─────────────────────────────────────────────────────────────────

/** El tipo Go de un valor del dominio tal como lo escribe un cierre (`func(v T) any`): un enum o un value object por su paquete. */
function domainType(field, element = false) {
  const base = element ? field.goType.replace(/^\[\]/, '') : field.goType;
  return field.kind === 'enum' || field.kind === 'composite' ? `domain.${base}` : base;
}

/** El lector de un valor (sin la opcionalidad), registrando en `uses` los enums que traduce. */
function reader(field, uses, element = false) {
  if (field.kind === 'enum') {
    const name = element ? field.goType.replace(/^\[\]/, '') : field.goType;
    uses.add(`enum:${name}`);
    return `asEnum(parse${name}Stored)`;
  }
  if (field.kind === 'composite') return `asSub(decode${element ? field.goType.replace(/^\[\]/, '') : field.goType})`;
  const base = element ? field.goType.replace(/^\[\]/, '') : field.goType;
  const readers = {
    string: 'asText',
    int32: 'asInt32',
    int64: 'asInt64',
    bool: 'asBool',
    'time.Time': 'asInstant',
    'uuid.UUID': 'asUUID',
    'wire.Decimal': 'asDecimal',
    'wire.Date': 'asDay',
    'jsontext.Value': 'asJSON'
  };
  if (!readers[base]) throw new Error(`keel-go no sabe leer de un documento el tipo ${base} del campo ${field.name}`);
  return readers[base];
}

/** La expresión que escribe un valor del dominio `v` (de tipo T), registrando los enums que traduce. */
function writer(field, v, uses, element = false) {
  const base = element ? field.goType.replace(/^\[\]/, '') : field.goType;
  if (field.kind === 'enum') {
    uses.add(`enum:${base}`);
    return `${lower(base)}Stored[${v}]`;
  }
  if (field.kind === 'composite') return `e.encode${base}(${v})`;
  switch (base) {
    case 'string':
    case 'int32':
    case 'int64':
    case 'bool':
      return v;
    case 'time.Time':
      return `instantValue(${v})`;
    case 'uuid.UUID':
      return `uuidValue(${v})`;
    case 'wire.Decimal':
      return `e.decimal(${v})`;
    case 'wire.Date':
      return `dayValue(${v})`;
    case 'jsontext.Value':
      return `jsonValue(${v})`;
    default:
      throw new Error(`keel-go no sabe escribir en un documento el tipo ${base} del campo ${field.name}`);
  }
}

/** Un cierre `func(v T) any` que escribe un valor: lo que reciben orNull y each. */
function writerFunc(field, uses, element = false) {
  return `func(v ${domainType(field, element)}) any { return ${writer(field, 'v', uses, element)} }`;
}

/** La escritura de un campo del dominio (`expr` del tipo que declara: T, *T o []T). */
function fieldWrite(field, expr, uses) {
  if (field.list) return `each(${expr}, ${writerFunc(field, uses, true)})`;
  if (isOptional(field)) return `orNull(${expr}, ${writerFunc(field, uses)})`;
  return writer(field, expr, uses);
}

/** La lectura de un campo del dominio: el lector que da el tipo que declara (T, *T o []T). */
function fieldRead(field, uses) {
  if (field.list) return `asList(${reader(field, uses, true)})`;
  if (isOptional(field)) return `optional(${reader(field, uses)})`;
  return reader(field, uses);
}

// ─── El documento de cada entidad ────────────────────────────────────────────────────────────────

/** Los campos del documento de una entidad, con cómo se escriben desde `x` y cómo se leen sobre `state`. */
function documentModel(model, entity) {
  const shape = documentShape(model, entity);
  const members = persistedMembers(model, entity);
  const fields = [];
  let version = null;
  const audit = [];
  for (const entry of shape) {
    if (entry.kind === 'id') {
      fields.push({ entry, key: DOCUMENT_ID, field: entry.field, method: goExported(entry.member), id: true });
    } else if (entry.kind === 'scalar') {
      if (isDeclaredLockVersion(entity, entry.field)) {
        // La versión declarada se guarda con el tipo de su campo: un `int` es Int32 en el contrato (documentShape).
        version = { key: entry.name, method: goExported(entry.member), goType: entry.field.goType };
        continue;
      }
      fields.push({ entry, key: entry.name, field: entry.field, method: goExported(entry.member) });
    } else if (entry.kind === 'folded') {
      const source = members.find((member) => member.kind === 'scalar' && member.name === entry.of);
      fields.push({ entry, key: entry.name, folded: { field: source.field, method: goExported(entry.of), accents: source.folded.accents } });
    } else if (entry.kind === 'rank') {
      const source = members.find((member) => member.kind === 'scalar' && member.name === entry.of);
      fields.push({ entry, key: entry.name, ranked: { field: source.field, method: goExported(entry.of), enum: entry.enum ?? source.field.goType } });
    } else if (entry.kind === 'subdocument' && entry.valueObject) {
      fields.push({ entry, key: entry.name, field: entry.field, method: goExported(entry.member) });
    } else if (entry.kind === 'subdocument' && entry.entity) {
      fields.push({ entry, key: entry.name, child: entry.entity, many: false, method: goExported(entry.member) });
    } else if (entry.kind === 'array' && entry.element.entity) {
      fields.push({ entry, key: entry.name, child: entry.element.entity, many: true, method: goExported(entry.member) });
    } else if (entry.kind === 'array') {
      fields.push({ entry, key: entry.name, field: entry.field, method: goExported(entry.member) });
    } else if (entry.kind === 'ref') {
      const target = model.entities.find((candidate) => candidate.name === entry.relation.entity);
      const idField = target?.idField ?? { goType: 'uuid.UUID', kind: 'scalar', name: 'id' };
      const ref = { ...idField, name: entry.member, required: entry.relation.required, isId: false, generated: false, list: false };
      fields.push({ entry, key: entry.name, field: ref, method: goExported(entry.member) });
    } else if (entry.kind === 'version') {
      version = { key: entry.name, method: goExported(entry.member), goType: 'int64' };
    } else if (entry.kind === 'audit') {
      audit.push({ key: entry.name, role: entry.role, storage: entry.storage });
    }
  }
  return { entity, fields, version, audit };
}

/**
 * La autoría DECLARADA (13g): el campo es del dominio, pero lo estampa el guardado como la de la política. Viaja en el $set,
 * así que `createdAuthor` es lo que lo conserva al reescribir: el agregado trae el que leyó, y vacío es ausente.
 */
function authoredValue(entity, f, x) {
  if (isOptional(f.field) || !declaredAuthorship(entity).includes(f.field.name)) return null;
  return f.field.name === 'createdBy' ? `createdAuthor(${x}.${f.method}(), e.actor)` : 'e.actor';
}

/** encode<E>: el documento de una entidad (sin el `_id` de la raíz, la versión ni la auditoría, que pone el guardado). */
function encodeFunction(model, doc, uses, root) {
  const name = doc.entity.name;
  const x = 'x';
  const elements = [];
  for (const f of doc.fields) {
    if (f.id && root) continue;
    let value;
    if (f.folded) {
      const fold = f.folded.accents ? 'textfold.CaseAndAccents' : 'textfold.Case';
      value = isOptional(f.folded.field) ? `orNull(${x}.${f.folded.method}(), func(v string) any { return ${fold}(v) })` : `${fold}(${x}.${f.folded.method}())`;
    } else if (f.ranked) {
      const rank = `${lower(f.ranked.enum)}Rank`;
      value = isOptional(f.ranked.field) ? `orNull(${x}.${f.ranked.method}(), func(v domain.${f.ranked.enum}) any { return ${rank}(v) })` : `${rank}(${x}.${f.ranked.method}())`;
    } else if (f.child) {
      value = f.many
        ? `each(${x}.${f.method}(), func(c *domain.${f.child}) any { return e.encode${f.child}(c) })`
        : `orNullChild(${x}.${f.method}(), e.encode${f.child})`;
      if (!f.many) uses.add('orNullChild');
    } else {
      value = authoredValue(doc.entity, f, x) ?? fieldWrite(f.field, `${x}.${f.method}()`, uses);
    }
    elements.push(`\t\t{Key: ${goString(f.key)}, Value: ${value}},`);
  }
  const what = root ? `el documento de ${name} sin su _id, su versión ni su auditoría (las pone el guardado)` : `el subdocumento de ${name}, con su _id`;
  return `// encode${name} escribe ${what}.
func (e *encoder) encode${name}(${x} *domain.${name}) bson.D {
	return bson.D{
${elements.join('\n')}
	}
}`;
}

/**
 * Las hijas de un agregado en su orden: el de su campo de orden, si el diseño lo declara (`orderingFieldOf` de keel-core),
 * con el id de desempate y los vacíos al final, como la rama relacional. El array guarda el orden en que se escribió, que
 * no es contrato. Sin campo de orden, se queda como está.
 */
function childSort(model, f, uses) {
  const ordering = orderingFieldOf(model, f.child);
  if (!ordering) return [];
  const method = goExported(ordering.name);
  const decimal = ordering.base === 'decimal';
  const compareValues = decimal ? 'wire.Decimal.Cmp' : `cmp.Compare[${ordering.goType}]`;
  let byOrder;
  if (ordering.required) {
    byOrder = decimal ? `a.${method}().Cmp(b.${method}())` : `cmp.Compare(a.${method}(), b.${method}())`;
  } else {
    uses.add('compareOptional');
    byOrder = `compareOptional(a.${method}(), b.${method}(), ${compareValues})`;
  }
  const idField = model.entities.find((candidate) => candidate.name === f.child)?.idField;
  const idMethod = goExported(idField?.name ?? 'id');
  const idText = !idField || idField.goType === 'uuid.UUID' ? '.String()' : '';
  return [`\tslices.SortFunc(state.${f.method}, func(a, b *domain.${f.child}) int {\n\t\treturn cmp.Or(${byOrder}, cmp.Compare(a.${idMethod}()${idText}, b.${idMethod}()${idText}))\n\t})`];
}

/** decode<E>: lee el documento de una entidad y la rehidrata. */
function decodeFunction(model, doc, uses) {
  const name = doc.entity.name;
  const lines = [];
  for (const f of doc.fields) {
    if (f.folded || f.ranked) continue;
    let read;
    if (f.child) {
      read = f.many ? `asList(asSub(decode${f.child}))` : `optionalChild(decode${f.child})`;
      if (!f.many) uses.add('optionalChild');
    } else read = fieldRead(f.field, uses);
    lines.push(`\tif state.${f.method}, err = get(doc, ${goString(f.key)}, ${read}); err != nil {\n\t\treturn nil, err\n\t}`);
    if (f.child && f.many) lines.push(...childSort(model, f, uses));
  }
  if (doc.version) lines.push(`\tif state.${doc.version.method}, err = get(doc, ${goString(doc.version.key)}, optional(${doc.version.goType === 'int32' ? 'asInt32' : 'asInt64'})); err != nil {\n\t\treturn nil, err\n\t}`);
  return `// decode${name} lee el documento de ${name} y lo rehidrata.
func decode${name}(doc bson.Raw) (*domain.${name}, error) {
	var (
		state domain.${name}State
		err   error
	)
${lines.join('\n')}
	return domain.Rehydrate${name}(state), nil
}`;
}

/** encode<VO> y decode<VO>: el subdocumento de un value object, por sus accesores y su constructor. */
function valueObjectFunctions(vo, uses) {
  const elements = vo.fields.map((sub) => `\t\t{Key: ${goString(snakeCase(sub.name))}, Value: ${fieldWrite(sub, `v.${goExported(sub.name)}()`, uses)}},`);
  const reads = vo.fields.map((sub) => {
    const local = localName(sub.name);
    return `\t${local}, err := get(doc, ${goString(snakeCase(sub.name))}, ${fieldRead(sub, uses)})\n\tif err != nil {\n\t\treturn domain.${vo.name}{}, err\n\t}`;
  });
  return `// encode${vo.name} escribe el subdocumento de un ${vo.name}.
func (e *encoder) encode${vo.name}(v domain.${vo.name}) bson.D {
	return bson.D{
${elements.join('\n')}
	}
}

// decode${vo.name} lee el subdocumento de un ${vo.name} y lo construye con su constructor (que vuelve a comprobar sus guardas).
func decode${vo.name}(doc bson.Raw) (domain.${vo.name}, error) {
${reads.join('\n')}
	return domain.New${vo.name}(${vo.fields.map((sub) => localName(sub.name)).join(', ')})
}`;
}

/** Las entidades del agregado de una raíz: la raíz y sus hijas anidadas, a todo nivel. */
function aggregateEntities(model, root) {
  const out = [];
  const visit = (entity) => {
    if (out.includes(entity)) return;
    out.push(entity);
    for (const entry of documentShape(model, entity)) {
      const child = entry.entity ?? entry.element?.entity;
      if (child) visit(model.entities.find((candidate) => candidate.name === child));
    }
  };
  visit(root);
  return out;
}

// ─── Los filtros por clave ───────────────────────────────────────────────────────────────────────

/** El filtro de un finder por clave sobre el documento: `[ [ruta, valor] ]`, con las mismas claves que su firma. */
function keyFilter(model, entity, finder, uses) {
  const members = persistedMembers(model, entity);
  const pairs = [];
  for (const param of finder.params) {
    const member = members.find((m) => m.name === param.name || m.relation?.name === param.name);
    const local = localName(param.name);
    if (member.kind === 'externalRef') {
      const target = model.entities.find((candidate) => candidate.name === member.relation.entity);
      pairs.push([`${snakeCase(member.relation.name)}_id`, writer(target?.idField ?? { goType: 'uuid.UUID', name: 'id' }, local, uses)]);
    } else if (member.kind === 'vo') {
      for (const sub of member.subs) {
        if (sub.subKind === 'composite') {
          pairs.push([`${snakeCase(member.name)}.${snakeCase(sub.voAccessor)}`, `e.encode${sub.sub.goType}(${local}.${goExported(sub.voAccessor)}())`]);
        } else {
          pairs.push([`${snakeCase(member.name)}.${snakeCase(sub.voAccessor)}`, fieldWrite(sub.sub, `${local}.${goExported(sub.voAccessor)}()`, uses)]);
        }
      }
    } else {
      const shadow = member.folded && !member.folded.filterOnly ? member.folded : null;
      if (shadow) pairs.push([snakeCase(shadow.name), `${shadow.accents ? 'textfold.CaseAndAccents' : 'textfold.Case'}(${local})`]);
      else pairs.push([snakeCase(member.name), writer(member.field, local, uses)]);
    }
  }
  return pairs;
}

const filterLiteral = (pairs) => `bson.D{${pairs.map(([key, value]) => `{Key: ${goString(key)}, Value: ${value}}`).join(', ')}}`;

// ─── El adaptador ────────────────────────────────────────────────────────────────────────────────

function adapterBody(model, entity, uses) {
  const name = entity.name;
  const type = `${name}Repository`;
  const id = { type: entity.idField?.goType ?? 'uuid.UUID', name: localName(entity.idField?.name ?? 'id'), method: goExported(entity.idField?.name ?? 'id') };
  const collection = entity.collectionName;
  const constant = `${lower(name)}Collection`;
  const idWrite = writer(entity.idField ?? { goType: 'uuid.UUID', name: 'id' }, id.name, uses);
  const parts = [];

  const events = emitsEvents(model, entity);
  const outbox = events && usesGoOutbox(model);
  const eventsDoc = events
    ? ` Al guardar, entrega al puente de la mensajería los eventos que drena del agregado: ${outbox ? 'sus documentos del outbox van en la MISMA transacción del cambio' : 'se publican DESPUÉS del commit'}.`
    : '';
  const deps = [
    { field: 'tx', type: '*Transactions' },
    ...(events ? [{ field: 'events', type: '*messaging.Bridge' }] : []),
    ...claimDependencies(model, entity),
    ...reconciliationDependencies(model, entity),
    ...deadlineDependencies(model, entity)
  ];
  const built = [
    events ? ' y el puente de la mensajería' : '',
    deps.some((dep) => dep.field === 'sweeps') ? ', con los barridos del perfil' : '',
    deps.some((dep) => dep.field === 'parameters') ? ' y los parámetros de despliegue que lee su rescate' : '',
    deps.some((dep) => dep.field === 'reconciliation') ? ', con los barridos de reconciliación del perfil' : '',
    deps.some((dep) => dep.field === 'deadlines') ? ', con los plazos vigentes con los que arma sus temporizadores' : ''
  ].join('');
  parts.push(`// ${constant} es la colección de los documentos de ${name}.
const ${constant} = ${goString(collection)}

${docComment(type, `el adaptador de domain.${portName(entity)} sobre MongoDB: el agregado es UN documento de la colección ${collection}, con sus entidades internas anidadas, y el mapeo va campo a campo, sin reflexión. Se une a la transacción que abrió el caso de uso; sin ella, cada lectura va sola y cada escritura abre la suya.${eventsDoc}`)}type ${type} struct {
${alignRows(deps.map((dep) => ({ indent: '\t', cells: [dep.field, dep.type] }))).join('\n')}
}

// New${type} construye el adaptador sobre las transacciones del servicio${built}.
func New${type}(${deps.map((dep) => `${dep.field} ${dep.type}`).join(', ')}) *${type} {
	return &${type}{${deps.map((dep) => `${dep.field}: ${dep.field}`).join(', ')}}
}

var _ domain.${portName(entity)} = (*${type})(nil)`);

  // ─── Lecturas
  const one = (method, signature, filter, prelude = '') =>
    parts.push(`// ${method} implementa domain.${portName(entity)}.
func (r *${type}) ${signature} (*domain.${name}, bool, error) {
${prelude}	found, err := r.find(ctx, ${filter}, options.Find().SetLimit(1))
	if err != nil || len(found) == 0 {
		return nil, false, err
	}
	return found[0], true, nil
}`);
  one('FindByID', `FindByID(ctx context.Context, ${id.name} ${id.type})`, `bson.D{{Key: "_id", Value: ${idWrite}}}`);
  // La carga que compara la versión (api.concurrency, D4), la misma que la del adaptador relacional.
  if (loadsExpecting(model, entity)) parts.push(loadExpectingAdapter(entity, type, portName(entity), id));
  if (idBatchReason(model, entity)) {
    parts.push(`// FindAllByID implementa domain.${portName(entity)}.
func (r *${type}) FindAllByID(ctx context.Context, ids []${id.type}) ([]*domain.${name}, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	return r.find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: each(ids, ${writerFunc(entity.idField ?? { goType: 'uuid.UUID', name: 'id' }, uses)})}}}})
}`);
  }
  for (const inverse of inverseFindersOf(model, name)) {
    const owner = model.entities.find((candidate) => candidate.name === inverse.owner);
    const param = localName(`${inverse.relation}Id`);
    const ownerId = owner?.idField ?? { goType: 'uuid.UUID', name: 'id' };
    parts.push(`// ${goExported(inverse.finder)} implementa domain.${portName(entity)}.
func (r *${type}) ${goExported(inverse.finder)}(ctx context.Context, ${param} ${ownerId.goType}) ([]*domain.${name}, error) {
	return r.find(ctx, bson.D{{Key: ${goString(`${snakeCase(inverse.relation)}_id`)}, Value: ${writer(ownerId, param, uses)}}})
}`);
  }
  for (const finder of keyFinders(model, entity)) {
    const pairs = keyFilter(model, entity, finder, uses);
    const encodes = pairs.some(([, value]) => value.includes('e.'));
    const prelude = encodes ? '\te := &encoder{}\n\tfilter := ' + filterLiteral(pairs) + '\n\tif e.err != nil {\n\t\treturn nil, false, e.err\n\t}\n' : '';
    one(finder.name, `${finder.name}(ctx context.Context, ${finder.params.map((p) => `${localName(p.name)} ${p.type}`).join(', ')})`, encodes ? 'filter' : filterLiteral(pairs), prelude);
  }
  // resolvedBy: la credencial es UNO de los elementos del array; MongoDB casa un array por cualquiera de sus elementos.
  for (const credential of credentialFinders(model, entity)) {
    const element = credential.field.goType.replace(/^\[\]/, '');
    one(
      credential.name,
      `${credential.name}(ctx context.Context, ${credential.param} ${element})`,
      `bson.D{{Key: ${goString(snakeCase(credential.field.name))}, Value: ${writer(credential.field, credential.param, uses, true)}}}`
    );
  }
  const batch = naturalKeyBatchFinder(model, entity);
  if (batch) {
    const field = entity.fields.find((candidate) => candidate.name === batch.param.name);
    parts.push(`// ${batch.name} implementa domain.${portName(entity)}.
func (r *${type}) ${batch.name}(ctx context.Context, ${batch.plural} []${batch.param.type}) ([]*domain.${name}, error) {
	if len(${batch.plural}) == 0 {
		return nil, nil
	}
	return r.find(ctx, bson.D{{Key: ${goString(snakeCase(field.name))}, Value: bson.D{{Key: "$in", Value: each(${batch.plural}, ${writerFunc(field, uses)})}}}})
}`);
  }
  if (isPaginated(model, entity) || entityFinders(model, entity).length > 0) parts.push(sortableMap(model, entity));
  if (isPaginated(model, entity)) parts.push(listMethod(entity, type, constant));
  parts.push(...documentFinderMethods(model, entity, type, constant, uses));
  parts.push(...claimMethods(model, entity, type, constant, uses));
  parts.push(...documentReconciliationMethods(model, entity, type));
  parts.push(...documentGuardMethods(model, entity, type, constant, idWrite));

  // ─── Escrituras
  parts.push(saveMethod(model, entity, type, constant, id, idWrite, uses));
  parts.push(`// DeleteByID implementa domain.${portName(entity)}. Las entidades internas van dentro del documento: caen con él.
func (r *${type}) DeleteByID(ctx context.Context, ${id.name} ${id.type}) error {
	return r.tx.write(ctx, func(ctx context.Context) error {
		documents, err := r.tx.collection(${constant})
		if err != nil {
			return err
		}
		_, err = documents.DeleteOne(ctx, bson.D{{Key: "_id", Value: ${idWrite}}})
		return err
	})
}`);

  // ─── La lectura del agregado
  parts.push(`// find lee los documentos que casan con filter y rehidrata cada agregado.
func (r *${type}) find(ctx context.Context, filter bson.D, opts ...options.Lister[options.FindOptions]) ([]*domain.${name}, error) {
	documents, err := r.tx.collection(${constant})
	if err != nil {
		return nil, err
	}
	cursor, err := documents.Find(ctx, filter, opts...)
	if err != nil {
		return nil, translate(err)
	}
	defer cursor.Close(ctx)
	var found []*domain.${name}
	for cursor.Next(ctx) {
		aggregate, err := decode${name}(cursor.Current)
		if err != nil {
			return nil, fmt.Errorf("%s %v: %w", ${constant}, cursor.Current.Lookup("_id"), err)
		}
		found = append(found, aggregate)
	}
	return found, translate(cursor.Err())
}`);

  for (const member of aggregateEntities(model, entity)) {
    const doc = documentModel(model, member);
    parts.push(encodeFunction(model, doc, uses, member === entity), decodeFunction(model, doc, uses));
  }
  return `\n${parts.join('\n\n')}\n`;
}

function saveMethod(model, entity, type, constant, id, idWrite, uses) {
  const name = entity.name;
  const doc = documentModel(model, entity);
  const local = localName(lower(name));
  const events = emitsEvents(model, entity);
  const outbox = events && usesGoOutbox(model);
  const created = doc.audit.filter((a) => a.role === 'createdDate' || a.role === 'createdBy');
  const updated = doc.audit.filter((a) => a.role === 'lastModifiedDate' || a.role === 'lastModifiedBy');
  const auditValue = (a) => (a.storage === 'date' ? 'instantValue(now)' : 'actor');
  const prelude = [];
  if (doc.audit.some((a) => a.storage === 'date')) prelude.push('\t\tnow := time.Now().UTC()');
  if (doc.audit.some((a) => a.storage !== 'date')) prelude.push('\t\tactor := auditActor(ctx)');
  const appendAll = (list, target) => list.map((a) => `\t\t${target} = append(${target}, bson.E{Key: ${goString(a.key)}, Value: ${auditValue(a)}})`);
  const idExpr = `${local}.${id.method}()`;
  const filterId = writer(entity.idField ?? { goType: 'uuid.UUID', name: 'id' }, idExpr, uses);
  // El armado de los plazos (DSL 2.26), en la sesión de la transacción: el documento de antes y, tras releer, el temporizador.
  const arming = entity.lifecycle ? documentArming(model, entity, local, filterId) : null;
  let statement;
  if (doc.version) {
    statement = `${appendAll(updated, 'fields').join('\n')}
		version := ${local}.${doc.version.method}()
		if version == nil {
			inserted := append(bson.D{{Key: "_id", Value: ${filterId}}}, fields...)
			inserted = append(inserted, bson.E{Key: ${goString(doc.version.key)}, Value: ${doc.version.goType}(0)})
${appendAll(created, 'inserted').map((line) => `\t${line}`).join('\n')}
			if _, err := documents.InsertOne(ctx, inserted); err != nil {
				return err
			}
		} else {
			// La versión va en el FILTRO: no casar con ningún documento es otra escritura que subió la versión (o borró
			// el agregado) desde que este se leyó.
			fields = append(fields, bson.E{Key: ${goString(doc.version.key)}, Value: *version + 1})
			result, err := documents.UpdateOne(ctx, bson.D{{Key: "_id", Value: ${filterId}}, {Key: ${goString(doc.version.key)}, Value: *version}}, bson.D{{Key: "$set", Value: fields}})
			if err != nil {
				return err
			}
			if result.MatchedCount == 0 {
				return errStaleVersion
			}
		}`;
  } else {
    const onInsert = created.length > 0 ? `, {Key: "$setOnInsert", Value: bson.D{${created.map((a) => `{Key: ${goString(a.key)}, Value: ${auditValue(a)}}`).join(', ')}}}` : '';
    statement = `${appendAll(updated, 'fields').join('\n')}
		// $set, nunca reemplazar: lo que el dominio no modela (created_* de la auditoría) se conserva.
		if _, err := documents.UpdateOne(ctx, bson.D{{Key: "_id", Value: ${filterId}}}, bson.D{{Key: "$set", Value: fields}${onInsert}}, options.UpdateOne().SetUpsert(true)); err != nil {
			return err
		}`;
  }
  return `// Save implementa domain.${portName(entity)}: escribe el documento del agregado entero en una transacción (la abierta,
// o una suya) y lo relee en ella.${outbox ? ' Los documentos del outbox de sus eventos van en esa misma transacción.' : events ? ' Sus eventos se publican cuando esa transacción confirma.' : ''}
func (r *${type}) Save(ctx context.Context, ${local} *domain.${name}) (*domain.${name}, error) {${events ? `
	events := ${local}.PullEvents()` : ''}
	var saved *domain.${name}
	err := r.tx.write(ctx, func(ctx context.Context) error {
		documents, err := r.tx.collection(${constant})
		if err != nil {
			return err
		}
		e := &encoder{${usesDeclaredAuthorship(model) ? 'actor: auditActor(ctx)' : ''}}
		fields := e.encode${name}(${local})
		if e.err != nil {
			return e.err
		}
${arming ? `${arming.before}\n` : ''}${prelude.join('\n')}${prelude.length > 0 ? '\n' : ''}${statement}${outbox ? `
		records, err := r.events.Route(ctx, events)
		if err != nil {
			return err
		}
		if err := appendOutbox(ctx, r.tx, records); err != nil {
			return err
		}` : ''}
		found, err := r.find(ctx, bson.D{{Key: "_id", Value: ${filterId}}})
		if err != nil {
			return err
		}
		if len(found) == 0 {
			return fmt.Errorf("%s: el documento guardado no se pudo releer", ${constant})
		}
		saved = found[0]${arming ? `\n${arming.after}` : ''}
		return nil
	})
	if err != nil {
		return nil, err
	}${outbox ? `
	if len(events) > 0 {
		// Las filas del outbox ya confirmaron (o confirman con el caso de uso): el relay de esta réplica sale ya.
		r.tx.relayWake(ctx)
	}` : ''}${events && !outbox ? `
	if len(events) > 0 {
		r.tx.afterCommit(ctx, func(ctx context.Context) {
			r.events.Deliver(ctx, events)
		})
	}` : ''}
	return saved, nil
}`;
}

function sortableMap(model, entity) {
  const rows = alignRows(sortablePaths(model, entity).map(([property, path]) => ({ indent: '\t', cells: [`${goString(property)}:`, `${goString(path)},`] })));
  return `// ${lower(entity.name)}Sortable son las propiedades por las que se puede ordenar, con el nombre del contrato, y su ruta en el
// documento. Es una lista blanca: el orden nunca lleva un texto de la petición.
var ${lower(entity.name)}Sortable = map[string]string{
${rows.join('\n')}
}`;
}

// ─── Los finders de las búsquedas (DSL 2.22) ─────────────────────────────────────────────────────

const RANGE_OPERATOR = { gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' };

/** La clave del documento que restringe un criterio, y su valor escrito como se guarda. */
function criterionTarget(model, entity, criterion, value, uses) {
  const { target, shadow } = criterion;
  if (shadow) return { key: snakeCase(shadow.name), value: `${shadow.accents ? 'textfold.CaseAndAccents' : 'textfold.Case'}(${value})` };
  if (target.kind === 'relation') {
    const owner = model.entities.find((candidate) => candidate.name === target.relation.entity);
    return { key: `${snakeCase(target.relation.name)}_id`, value: writer(owner?.idField ?? { goType: 'uuid.UUID', name: 'id' }, value, uses) };
  }
  const key = documentShape(model, entity).find((entry) => entry.member === target.field.name)?.name ?? snakeCase(target.field.name);
  if (target.kind === 'vo') return { key: `${key}.${snakeCase(target.sub.name)}`, value: writer(target.sub, value, uses) };
  return { key, value: writer(target.field, value, uses) };
}

/** La condición de un criterio. El texto buscado es LITERAL: se escapa antes de componer la expresión. */
function criterionCondition(model, entity, criterion, value, uses) {
  const { key, value: written } = criterionTarget(model, entity, criterion, value, uses);
  const condition = (operand) => `bson.D{{Key: ${goString(key)}, Value: ${operand}}}`;
  if (criterion.match === 'contains') return condition(`bson.Regex{Pattern: regexp.QuoteMeta(${written})}`);
  if (criterion.match === 'prefix') return condition(`bson.Regex{Pattern: "^" + regexp.QuoteMeta(${written})}`);
  if (RANGE_OPERATOR[criterion.op]) return condition(`bson.D{{Key: ${goString(RANGE_OPERATOR[criterion.op])}, Value: ${written}}}`);
  return condition(written);
}

/** Los métodos del adaptador: los filtros del diseño sobre el documento, y solo esos. */
function documentFinderMethods(model, entity, type, constant, uses) {
  const name = entity.name;
  const idName = entity.idField?.name ?? 'id';
  return entityFinders(model, entity).map((finder) => {
    uses.add('matching');
    const page = finder.result === 'page';
    const zero = page ? `domain.Page[*domain.${name}]{}` : 'nil';
    const lines = ['\tvar conditions bson.A'];
    for (const entry of finder.fixed) {
      const key = documentShape(model, entity).find((candidate) => candidate.member === entry.field.name)?.name ?? snakeCase(entry.field.name);
      lines.push(`\tconditions = append(conditions, bson.D{{Key: ${goString(key)}, Value: ${fixedArg(model, entry)}}})`);
    }
    for (const criterion of finder.criteria) {
      const member = `filter.${goExported(criterion.name)}`;
      if (criterion.required) {
        lines.push(`\tconditions = append(conditions, ${criterionCondition(model, entity, criterion, member, uses)})`);
      } else {
        const local = localName(criterion.name);
        lines.push(`\tif ${member} != nil {`, `\t\t${local} := *${member}`, `\t\tconditions = append(conditions, ${criterionCondition(model, entity, criterion, local, uses)})`, '\t}');
      }
    }
    const encodes = lines.some((line) => line.includes('e.decimal('));
    const prelude = encodes ? '\te := &encoder{}\n' : '';
    const encoded = encodes ? `\n\tif e.err != nil {\n\t\treturn ${zero}, e.err\n\t}` : '';
    const sort = finder.sort.map((criterion) => `{Property: ${goString(criterion.property)}, Direction: domain.${criterion.direction === 'desc' ? 'SortDesc' : 'SortAsc'}}`);
    const signature = `func (r *${type}) ${finderMethod(finder)}(${['ctx context.Context', ...finderParams(finder, 'domain.')].join(', ')}) ${finderResult(finder, entity, 'domain.')}`;
    const tail = page
      ? `	order, err := sortOf(pageable.Sort, ${lower(name)}Sortable, ${goString(idName)})
	if err != nil {
		return ${zero}, fmt.Errorf("%s: %w", ${constant}, err)
	}
	documents, err := r.tx.collection(${constant})
	if err != nil {
		return ${zero}, err
	}
	query := matching(conditions)
	total, err := documents.CountDocuments(ctx, query)
	if err != nil {
		return ${zero}, translate(err)
	}
	found, err := r.find(ctx, query, options.Find().SetSort(order).SetSkip(pageable.Offset()).SetLimit(int64(pageable.Size)))
	if err != nil {
		return ${zero}, err
	}
	return domain.NewPage(found, pageable, total), nil`
      : `	order, err := sortOf([]domain.SortOrder{${sort.join(', ')}}, ${lower(name)}Sortable, ${goString(idName)})
	if err != nil {
		return nil, fmt.Errorf("%s: %w", ${constant}, err)
	}
	return r.find(ctx, matching(conditions), options.Find().SetSort(order))`;
    return `// ${finderMethod(finder)} implementa domain.${portName(entity)}.
${signature} {
${prelude}${lines.join('\n')}${encoded}
${tail}
}`;
  });
}

function listMethod(entity, type, constant) {
  const name = entity.name;
  const idName = entity.idField?.name ?? 'id';
  return `// List implementa domain.${portName(entity)}.
func (r *${type}) List(ctx context.Context, pageable domain.Pageable) (domain.Page[*domain.${name}], error) {
	order, err := sortOf(pageable.Sort, ${lower(name)}Sortable, ${goString(idName)})
	if err != nil {
		return domain.Page[*domain.${name}]{}, fmt.Errorf("%s: %w", ${constant}, err)
	}
	documents, err := r.tx.collection(${constant})
	if err != nil {
		return domain.Page[*domain.${name}]{}, err
	}
	total, err := documents.CountDocuments(ctx, bson.D{})
	if err != nil {
		return domain.Page[*domain.${name}]{}, translate(err)
	}
	found, err := r.find(ctx, bson.D{}, options.Find().SetSort(order).SetSkip(pageable.Offset()).SetLimit(int64(pageable.Size)))
	if err != nil {
		return domain.Page[*domain.${name}]{}, err
	}
	return domain.NewPage(found, pageable, total), nil
}`;
}

// ─── Los reclamos de barrido ─────────────────────────────────────────────────────────────────────

/**
 * Los reclamos de barrido del adaptador documental (los de claim.js). Sin SKIP LOCKED y sin necesidad: FindOneAndUpdate
 * filtra y marca en la MISMA operación atómica por documento, así que dos réplicas nunca se llevan el mismo. Uno por
 * documento hasta el lote, en el orden del barrido y SIN la sesión del caso de uso: la marca confirma al volver.
 */
function claimMethods(model, entity, type, constant, uses) {
  return claimsForEntity(model, entity.name).map((claim) => {
    const method = claimMethod(claim);
    const stateKey = snakeCase(entity.lifecycle.field);
    const states = claim.from.map((state) => goString(storedState(model, entity, state))).join(', ');
    const setup = [`\tbatch := r.sweeps.BatchSize[${goString(claim.sweepKey)}]`];
    const filter = [`{Key: ${goString(stateKey)}, Value: bson.D{{Key: "$in", Value: bson.A{${states}}}}}`];
    if (claim.stalled) {
      const seconds = claim.stalled.parameter
        ? `time.Duration(r.parameters.${parameterAccessor({ name: claim.stalled.parameter.name })}()) * ${claim.stalled.parameter.unitSeconds} * time.Second`
        : `time.Duration(r.sweeps.StalledAfterSeconds[${goString(claim.stalled.configKey)}]) * time.Second`;
      setup.push('\t// La cota del rescate: solo lo que lleva atascado más que el plazo, la misma para todo el lote.', `\tstaleBefore := time.Now().UTC().Add(-${seconds})`);
      filter.push(`{Key: ${goString(snakeCase(claim.stalled.stampField))}, Value: bson.D{{Key: "$lt", Value: instantValue(staleBefore)}}}`);
    }
    if (claim.due) {
      setup.push(`\t// Solo lo que ya venció (${claim.due.field} <= ahora).`, '\tnow := time.Now().UTC()');
      filter.push(`{Key: ${goString(snakeCase(claim.due.field))}, Value: bson.D{{Key: "$lte", Value: instantValue(now)}}}`);
    }
    if (claim.stamps || claim.stalled) setup.push('\tclaimedAt := time.Now().UTC()');
    const set = [];
    if (claim.stalled) set.push(`{Key: ${goString(snakeCase(claim.stalled.stampField))}, Value: instantValue(claimedAt)}`);
    else {
      set.push(`{Key: ${goString(stateKey)}, Value: ${goString(storedState(model, entity, claim.to))}}`);
      if (claim.stamps) set.push(`{Key: ${goString(snakeCase(claim.stamps.field))}, Value: instantValue(claimedAt)}`);
    }
    const order = snakeCase(claimOrderField(entity, claim));
    const what = claim.stalled ? `renueva ${claim.stalled.stampField} SOLO si el documento sigue atascado en ${claim.stalled.state}; el estado no se toca` : `pasa el documento a ${claim.to} SOLO si sigue en su estado de partida`;
    return `// ${method} implementa domain.${entity.name}Repository (${claim.stalled ? 'rescate' : 'cola'}).
func (r *${type}) ${method}(ctx context.Context) ([]*domain.${entity.name}, error) {
	if openTx(ctx) != nil {
		return nil, fmt.Errorf("%s confirma por su cuenta y hay una transacción abierta: despacha la operación con application.WithoutTransaction (el reloj ya lo hace)", ${goString(method)})
	}
	documents, err := r.tx.collection(${constant})
	if err != nil {
		return nil, err
	}
	ctx = outside(ctx)
${setup.join('\n')}
	filter := bson.D{${filter.join(', ')}}
	update := bson.D{{Key: "$set", Value: bson.D{${set.join(', ')}}}}
	claim := options.FindOneAndUpdate().SetSort(bson.D{{Key: ${goString(order)}, Value: 1}, {Key: "_id", Value: 1}}).SetReturnDocument(options.After)
	var claimed []*domain.${entity.name}
	for range batch {
		// El reclamo: ${what}, en la misma operación atómica que lo elige. Nada que casar = no queda ninguno.
		raw, err := documents.FindOneAndUpdate(ctx, filter, update, claim).Raw()
		if errors.Is(err, mongodriver.ErrNoDocuments) {
			break
		}
		if err != nil {
			return claimed, translate(err)
		}
		aggregate, err := decode${entity.name}(raw)
		if err != nil {
			return claimed, fmt.Errorf("%s: %w", ${constant}, err)
		}
		claimed = append(claimed, aggregate)
	}
${sweepPassSignal(model, claim, 'len(claimed)', 'batch')}	return claimed, nil
}`;
  });
}

// ─── Lo común de los adaptadores ─────────────────────────────────────────────────────────────────

/** documents.go: los enums por su constante, los rangos, el orden y los auxiliares que algún adaptador usa. */
function documentsBody(model, uses) {
  const blocks = [];
  blocks.push(`// sortOf traduce el orden pedido a rutas del documento desde una lista blanca, con el _id como último criterio si no
// está ya: sin desempate, dos páginas consecutivas pueden repetir un documento y omitir otro. Una propiedad que no existe
// es un error, como la PropertyReferenceException de Spring Data.
func sortOf(sort []domain.SortOrder, paths map[string]string, idProperty string) (bson.D, error) {
	var order bson.D
	var seen []string
	for _, criterion := range sort {
		path, ok := paths[criterion.Property]
		if !ok {
			return nil, fmt.Errorf("no existe la propiedad %q para ordenar", criterion.Property)
		}
		if slices.Contains(seen, criterion.Property) {
			continue
		}
		seen = append(seen, criterion.Property)
		direction := 1
		if criterion.Direction == domain.SortDesc {
			direction = -1
		}
		order = append(order, bson.E{Key: path, Value: direction})
	}
	if !slices.Contains(seen, idProperty) {
		order = append(order, bson.E{Key: "_id", Value: 1})
	}
	return order, nil
}`);
  if (uses.has('matching')) {
    blocks.push(`// matching es el filtro de un finder: todas sus condiciones, o el documento vacío sin ninguna. Con $and, porque un rango
// restringe dos veces la misma clave.
func matching(conditions bson.A) bson.D {
	if len(conditions) == 0 {
		return bson.D{}
	}
	return bson.D{{Key: "$and", Value: conditions}}
}`);
  }
  if (uses.has('compareOptional')) {
    blocks.push(`// compareOptional compara dos valores opcionales, con los vacíos al final.
func compareOptional[T any](a, b *T, compare func(T, T) int) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return 1
	case b == nil:
		return -1
	}
	return compare(*a, *b)
}`);
  }
  if (uses.has('orNullChild')) {
    blocks.push(`// orNullChild escribe una entidad anidada uno-a-uno: null si no hay ninguna.
func orNullChild[T any](child *T, write func(*T) bson.D) any {
	if child == nil {
		return nil
	}
	return write(child)
}`);
  }
  if (uses.has('optionalChild')) {
    blocks.push(`// optionalChild lee una entidad anidada uno-a-uno: nil si es null.
func optionalChild[T any](decode func(bson.Raw) (*T, error)) func(bson.RawValue) (*T, error) {
	return func(v bson.RawValue) (*T, error) {
		if isNull(v) {
			return nil, nil
		}
		return asSub(decode)(v)
	}
}`);
  }
  const ranked = rankedEnums(model);
  for (const name of ranked) uses.add(`enum:${name}`);
  for (const name of [...uses].filter((use) => use.startsWith('enum:')).map((use) => use.slice(5)).sort()) {
    const values = (model.enums ?? []).find((candidate) => candidate.name === name)?.values ?? [];
    const rows = alignRows(values.map((value) => ({ indent: '\t', cells: [`domain.${enumConstant(name, value.literal)}:`, `${goString(value.constant)},`] })));
    blocks.push(`// ${lower(name)}Stored es lo que se guarda de cada ${name}: el nombre de su constante, como en los otros tres generadores.
var ${lower(name)}Stored = map[domain.${name}]string{
${rows.join('\n')}
}

// parse${name}Stored lee un ${name} de su valor guardado: solo admite las constantes del diseño.
func parse${name}Stored(text string) (domain.${name}, error) {
	for value, stored := range ${lower(name)}Stored {
		if stored == text {
			return value, nil
		}
	}
	return "", fmt.Errorf("${name} desconocido en la base de datos: %q", text)
}`);
  }
  for (const name of ranked) {
    const values = (model.enums ?? []).find((candidate) => candidate.name === name)?.values ?? [];
    const order = values.map((value) => `domain.${enumConstant(name, value.literal)}`);
    blocks.push(`// ${lower(name)}Rank es la posición de un ${name} en su declaración: la sombra de rango por la que se ordena.
func ${lower(name)}Rank(value domain.${name}) int32 {
	return int32(slices.Index([]domain.${name}{${order.join(', ')}}, value))
}`);
  }
  for (const vo of documentValueObjectsOf(model)) blocks.push(valueObjectFunctions(vo, uses));
  // Los enums que solo usa un value object, registrados al escribir sus funciones: se emiten aquí detrás.
  const late = [...uses].filter((use) => use.startsWith('enum:')).map((use) => use.slice(5)).filter((name) => !blocks.some((block) => block.includes(`var ${lower(name)}Stored`)));
  for (const name of late.sort()) {
    const values = (model.enums ?? []).find((candidate) => candidate.name === name)?.values ?? [];
    const rows = alignRows(values.map((value) => ({ indent: '\t', cells: [`domain.${enumConstant(name, value.literal)}:`, `${goString(value.constant)},`] })));
    blocks.push(`// ${lower(name)}Stored es lo que se guarda de cada ${name}: el nombre de su constante, como en los otros tres generadores.
var ${lower(name)}Stored = map[domain.${name}]string{
${rows.join('\n')}
}

// parse${name}Stored lee un ${name} de su valor guardado: solo admite las constantes del diseño.
func parse${name}Stored(text string) (domain.${name}, error) {
	for value, stored := range ${lower(name)}Stored {
		if stored == text {
			return value, nil
		}
	}
	return "", fmt.Errorf("${name} desconocido en la base de datos: %q", text)
}`);
  }
  return `\n${blocks.join('\n\n')}\n`;
}

/** Los value objects con subdocumento, en el orden estable de keel-core. */
function documentValueObjectsOf(model) {
  const reached = new Set();
  const byName = new Map((model.valueObjects ?? []).map((vo) => [vo.name, vo]));
  const visit = (name) => {
    const vo = byName.get(name);
    if (!vo || reached.has(vo)) return;
    reached.add(vo);
    for (const sub of vo.fields ?? []) if (sub.kind === 'composite') visit(sub.namedType ?? sub.goType.replace(/^\[\]/, ''));
  };
  for (const entity of (model.entities ?? []).filter((e) => e.persisted)) {
    for (const field of entity.fields ?? []) if (field.kind === 'composite') visit(field.namedType ?? field.goType.replace(/^\[\]/, ''));
  }
  return [...reached];
}
