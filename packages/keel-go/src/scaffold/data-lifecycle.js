// El CICLO DE VIDA DEL DATO (DSL 2.28: `deletion: logical`, `restorableFor`/`restores` y `retention`) en keel-go:
// incremento 4 de PLAN-DSL-228-CICLO-DE-VIDA.md, con el reparto de keel-spring, keel-nest y keel-dotnet. Lo que decide QUÉ
// (qué raíces, la columna, las unicidades entre vivas, el sustituto, la aritmética de la ventana y del corte, los
// parámetros del barrido, las notas) es de keel-core (gen/data-lifecycle.js, gen/relational.js, gen/timer-plan.js); aquí
// solo se escribe en Go:
//
//   · `deleted_at` (y `anonymized_at`, D11) en la tabla, o `deletedAt`/`anonymizedAt` en el documento: los pone el
//     generador, no el dominio (D1), así que ningún Rehydrate los lee.
//   · Las lecturas VIVAS del adaptador: cada carga y cada listado suma `deleted_at IS NULL` (o `deletedAt: null`), y los
//     finders de búsqueda lo suman a su consulta DETRÁS del alcance (D2). `FindAllByID`, la lectura por referencia, NO lo
//     lleva (D3).
//   · `DeleteByID` MARCA la fila (D1), y `Restore`/`FindDeletedBy<Clave>` la devuelven a la vida dentro de la ventana (D6).
//     Con bloqueo optimista, marcar, restaurar y anonimizar SUBEN la versión, como el @Version de keel-spring: una
//     escritura que leyó antes (un handler en vuelo) sale como conflicto y no reescribe lo que la marca cambió.
//   · La retención: `<Raíz>Retention` en el paquete del almacén (qué ha vencido, por lotes, y qué se hace con cada uno,
//     cada agregado en su transacción) y su `Run`, que el arranque monta como recurrente del cronómetro en modo clúster
//     (D8, `timer.NewRecurring`), con su lote y su cron en `retention.yaml`.

import { ANONYMIZED_AT, DELETED_AT, LOCK_VERSION, backReferenceTo, isLogicallyDeleted, joinColumnOf, parentColumnOf, persistedMembers } from '@keel-system/keel-core/gen';
import { AGE_DELETION_ENGINES, AGE_DELETION_MISS, ANONYMOUS_PREFIX, ageDeletionStatement, deletedLookupOf, deletionAgingTargets, lifecycleRoots, retentionParameters } from '@keel-system/keel-core/gen/data-lifecycle';
import { ageDeletionScript } from '@keel-system/keel-core/gen/mongo-probes';
import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { usesRelational } from '@keel-system/keel-core/gen/features';
import { operationError } from '@keel-system/keel-core/gen/declared-errors';
import { retentionCaches } from '@keel-system/keel-core/gen/cache-plan';
import { documentShape } from '@keel-system/keel-core/gen/document';
import { cronWithDefault, envWithDefault } from '@keel-system/keel-core/gen/profile-values';
import { snakeCase } from '@keel-system/keel-core/gen/naming';
import { goExported } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { relationalEngine, sqlDialect } from '../lib/relational-engine.js';
import { sentinelOf } from './errors.js';
import { goFileName, layout, localName, packageFile } from './render.js';
import { PARAMETERS_VAR, parameterAccessor, parametersType } from './service-parameters.js';
import { cacheVar } from './cache.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

/** Lo que el modelo dice del ciclo de vida de una raíz (lifecycleRoots de keel-core), o null. */
export function lifecycleOf(model, entity) {
  return lifecycleRoots(model).find((root) => root.entity === entity?.name) ?? null;
}

/** Las raíces con retención: `[{ entity, root }]`. */
export function retentionRoots(model) {
  return lifecycleRoots(model)
    .filter((root) => root.retention)
    .map((root) => ({ entity: model.entities.find((candidate) => candidate.name === root.entity), root }));
}

/** El tipo Go de la retención de una raíz (`VerificationCodeRetention`), en el paquete del almacén. */
export const retentionType = (entityName) => `${entityName}Retention`;
/** La constante del kind de una retención en el paquete del cronómetro: `KindRetentionVerificationCode`. */
export const retentionKindConstant = (entityName) => `KindRetention${entityName}`;

/** Las marcas del generador en la fila o el documento: `[{ field, column }]`. Fuera del dominio y del contrato (D1, D11). */
export function lifecycleMarks(model, entity) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle) return [];
  return [...(lifecycle.logical ? [DELETED_AT] : []), ...(lifecycle.retention?.then === 'anonymize' ? [ANONYMIZED_AT] : [])];
}

const windowText = (restore) => (Number.isInteger(restore.days) ? `${restore.days} días` : `los días del parámetro ${restore.parameter}`);
const spanText = (span) => (span.days ? `${span.days} días` : span.years ? `${span.years} años` : `el parámetro ${span.parameter}`);

// ─── El predicado de vida ────────────────────────────────────────────────────────────────────────

/** La condición de vida en SQL, citada como el resto del adaptador. */
export function liveCondition(model) {
  return `${sqlDialect(model).quote(DELETED_AT.column)} IS NULL`;
}

/** Lo que se suma a un WHERE de una carga de una raíz con borrado lógico (` AND deleted_at IS NULL`), o ''. */
export function liveSuffix(model, entity) {
  return isLogicallyDeleted(entity) ? ` AND ${liveCondition(model)}` : '';
}

/** La línea con la que un finder relacional suma la vida a su consulta (D2), DETRÁS del alcance. */
export const RELATIONAL_LIVE_LINE = '\tf.alive()';

/** El filtro documental de lo vivo: `deletedAt: null` casa con el campo nulo y con el ausente (T1). */
export const DOCUMENT_ALIVE = `bson.E{Key: ${goString(DELETED_AT.field)}, Value: nil}`;

/** La línea con la que un finder documental suma la vida a sus condiciones (D2), detrás del alcance. */
export const DOCUMENT_LIVE_LINE = `\tconditions = append(conditions, bson.D{${DOCUMENT_ALIVE}})`;

/** El bloque de `filters` (values.go) que suma la vida, para los finders de una raíz con borrado lógico. */
export function aliveFilterBlock(d) {
  return `// alive deja fuera las filas borradas lógicamente (DSL 2.28): la vida se SUMA a lo que el finder ya lleva.
func (f *filters) alive() {
	f.conditions = append(f.conditions, ${goString(`${d.quote(DELETED_AT.column)} IS NULL`)})
}`;
}

// ─── El puerto ───────────────────────────────────────────────────────────────────────────────────

/** El finder de la borrada más reciente por la clave natural (D6): `{ name, finder }`, o null. */
export function deletedFinder(entity, keyFinder) {
  if (!keyFinder || !deletedLookupOf(entity)) return null;
  return { name: keyFinder.name.replace(/^FindBy/, 'FindDeletedBy'), finder: keyFinder };
}

/** La documentación de `DeleteByID` en el puerto: con borrado lógico dice que marca. */
export function deletePortDoc(model, entity) {
  if (!lifecycleOf(model, entity)?.logical) return 'borra el agregado entero; no hace nada si no existe.';
  return `borrado LÓGICO (persistence.${entity.name}.deletion: logical, DSL 2.28): marca la fila y no la elimina. Desde ese momento ninguna lectura de este puerto la ve —salvo FindAllByID, la lectura por referencia— y sus claves únicas quedan libres. Sobre una fila ya borrada o inexistente no hace nada.`;
}

/** Los métodos de restauración del puerto (D6), como `[doc, firma]`. `keyFinder` es el de la clave natural. */
export function restorePortMethods(model, entity, id, keyFinder) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.restore) return [];
  const methods = [];
  const deleted = deletedFinder(entity, keyFinder);
  if (deleted) {
    methods.push([
      'la fila BORRADA más reciente con esta clave, la única que tiene sentido restaurar (la clave queda libre al borrar, así que puede haber varias). Las cargas normales no la ven; found es false si no hay ninguna.',
      `${deleted.name}(ctx context.Context, ${keyFinder.params.map((p) => `${localName(p.name)} ${p.type.replace(/^domain\./, '')}`).join(', ')}) (*${entity.name}, bool, error)`
    ]);
  }
  methods.push([
    `devuelve a la vida una fila borrada (restores: ${entity.name}); found es false si no hay ninguna borrada con ese id. Fuera de la ventana (${windowText(lifecycle.restore)} desde el borrado) es el error ${lifecycle.restore.error}; si otra fila viva ocupa ya su clave única, la unicidad salta al restaurarla, con el 409 de esa unicidad.`,
    `Restore(ctx context.Context, ${id.name} ${id.type}) (*${entity.name}, bool, error)`
  ]);
  return methods;
}

/** Lo que el adaptador recibe para el ciclo de vida: los parámetros, si la ventana los lee. */
export function lifecycleDependencies(model, entity) {
  const restore = lifecycleOf(model, entity)?.restore;
  if (!restore?.parameter) return [];
  return [{ field: 'parameters', type: `domain.${parametersType(model)}` }];
}

/** La operación que restaura una raíz: la que declara `restores`. */
function restoringOperationOf(model, entity) {
  return (model.services ?? []).flatMap((group) => group.operations ?? []).find((operation) => operation.restores === entity.name)?.name;
}

/** La duración de la ventana en Go: el literal o el parámetro del servicio. */
function windowDuration(model, restore) {
  if (Number.isInteger(restore.days)) return `${restore.days} * 24 * time.Hour`;
  const parameter = (model.service.parameters ?? []).find((candidate) => candidate.name === restore.parameter);
  return `time.Duration(r.parameters.${parameterAccessor(parameter ?? { name: restore.parameter })}()) * 24 * time.Hour`;
}

/** El error de la ventana, con el mensaje que comparten los cuatro. */
function windowError(model, entity, restore) {
  const error = operationError(model, restoringOperationOf(model, entity), restore.error);
  const message = goString(`${entity.name} borrado hace más de ${windowText(restore)}: ya no se puede restaurar.`);
  return error?.dynamicStatus
    ? `domain.StatusErrorf(domain.${sentinelOf(restore.error)}, ${error.http ?? 409}, ${message})`
    : `domain.Errorf(domain.${sentinelOf(restore.error)}, ${message})`;
}

// ─── El adaptador relacional ─────────────────────────────────────────────────────────────────────

/**
 * `DeleteByID` que marca, `FindDeletedBy<Clave>` y `Restore` sobre database/sql, o null si la raíz se borra
 * físicamente. `root` es el modelo de la tabla de la raíz (repositories.js: `table`, `idColumn`, `version`); `keyFinder`
 * el de la clave natural, con sus condiciones (`where`).
 */
export function relationalAdapterMethods(model, entity, { type, port, root, id, keyFinder }) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.logical) return null;
  const d = sqlDialect(model);
  const deletedAt = d.quote(DELETED_AT.column);
  const bump = root.version ? `, ${root.version.column} = ${root.version.column} + 1` : '';
  const methods = [`// DeleteByID implementa domain.${port}. Borrado LÓGICO (DSL 2.28, D1): marca la fila y no la elimina. Deja de verse
// en toda lectura del puerto y su clave única queda libre (los índices únicos de la tabla solo cuentan las filas vivas). Una
// ya borrada no se vuelve a marcar: la ventana de restauración cuenta desde el primer borrado.
func (r *${type}) DeleteByID(ctx context.Context, ${id.name} ${id.type}) error {
	return r.tx.write(ctx, func(q DBTX) error {
		_, err := q.ExecContext(ctx, ${goString(`UPDATE ${root.table} SET ${deletedAt} = ${d.param(1)}${bump} WHERE ${root.idColumn} = ${d.param(2)} AND ${deletedAt} IS NULL`)}, time.Now().UTC(), ${id.name})
		return err
	})
}`];
  if (!lifecycle.restore) return methods;
  const deleted = deletedFinder(entity, keyFinder);
  if (deleted) {
    const conditions = [];
    const args = [];
    for (const param of keyFinder.params) {
      for (const where of param.where) {
        args.push(where.arg);
        conditions.push(`${where.column} = ${d.param(args.length)}`);
      }
    }
    methods.push(`// ${deleted.name} implementa domain.${port}: la borrada más reciente con esa clave.
func (r *${type}) ${deleted.name}(ctx context.Context, ${keyFinder.params.map((p) => `${localName(p.name)} ${p.type}`).join(', ')}) (*domain.${entity.name}, bool, error) {
	found, err := r.load(ctx, ${goString(`WHERE ${conditions.join(' AND ')} AND ${deletedAt} IS NOT NULL ORDER BY ${deletedAt} DESC LIMIT 1`)}, ${args.join(', ')})
	if err != nil || len(found) == 0 {
		return nil, false, err
	}
	return found[0], true, nil
}`);
  }
  methods.push(`// Restore implementa domain.${port}.
func (r *${type}) Restore(ctx context.Context, ${id.name} ${id.type}) (*domain.${entity.name}, bool, error) {
	var restored *domain.${entity.name}
	err := r.tx.write(ctx, func(q DBTX) error {
		var deletedAt time.Time
		err := q.QueryRowContext(ctx, ${goString(`SELECT ${deletedAt} FROM ${root.table} WHERE ${root.idColumn} = ${d.param(1)} AND ${deletedAt} IS NOT NULL`)}, ${id.name}).Scan(&deletedAt)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		// La ventana (restorableFor, D6): restaurable mientras ${DELETED_AT.field} + ${windowText(lifecycle.restore)} sea posterior a ahora.
		if !deletedAt.Add(${windowDuration(model, lifecycle.restore)}).After(time.Now()) {
			return ${windowError(model, entity, lifecycle.restore)}
		}
		// Si una fila viva ocupa ya su clave, la unicidad entre vivas salta AQUÍ, con su nombre: el 409 que la traduce.
		if _, err := q.ExecContext(ctx, ${goString(`UPDATE ${root.table} SET ${deletedAt} = NULL${bump} WHERE ${root.idColumn} = ${d.param(1)}`)}, ${id.name}); err != nil {
			return err
		}
		states, err := query${entity.name}(ctx, q, ${goString(`WHERE ${root.idColumn} = ${d.param(1)}`)}, ${id.name})
		if err != nil {
			return err
		}
		if len(states) == 0 {
			return fmt.Errorf("${root.table.replaceAll('"', '').replaceAll('`', '')}: la fila restaurada no se pudo releer")
		}
		restored = domain.Rehydrate${entity.name}(states[0])
		return nil
	})
	if err != nil || restored == nil {
		return nil, false, err
	}
	return restored, true, nil
}`);
  return methods;
}

// ─── El adaptador documental ─────────────────────────────────────────────────────────────────────

/**
 * `DeleteByID` que marca, `FindDeletedBy<Clave>` y `Restore` sobre el driver de MongoDB, o null. `filterOf(keyFinder)`
 * da `{ prelude, filter }` del filtro por la clave natural (document-repositories.js); `version` es la del documento.
 */
export function documentAdapterMethods(model, entity, { type, port, constant, id, idWrite, keyFinder, keyFilter, version }) {
  const lifecycle = lifecycleOf(model, entity);
  if (!lifecycle?.logical) return null;
  const field = goString(DELETED_AT.field);
  const bump = version ? `, {Key: "$inc", Value: bson.D{{Key: ${goString(version.key)}, Value: ${version.goType}(1)}}}` : '';
  const methods = [`// DeleteByID implementa domain.${port}. Borrado LÓGICO (DSL 2.28, D1): marca el documento y no lo elimina. Deja de
// verse en toda lectura del puerto y su clave única queda libre (los índices únicos solo cuentan los documentos con
// deletedAt nulo). Uno ya borrado no se vuelve a marcar: la ventana de restauración cuenta desde el primer borrado.
func (r *${type}) DeleteByID(ctx context.Context, ${id.name} ${id.type}) error {
	return r.tx.write(ctx, func(ctx context.Context) error {
		documents, err := r.tx.collection(${constant})
		if err != nil {
			return err
		}
		_, err = documents.UpdateOne(ctx, bson.D{{Key: "_id", Value: ${idWrite}}, ${DOCUMENT_ALIVE}}, bson.D{{Key: "$set", Value: bson.D{{Key: ${field}, Value: instantValue(time.Now().UTC())}}}${bump}})
		return err
	})
}`];
  if (!lifecycle.restore) return methods;
  const deleted = deletedFinder(entity, keyFinder);
  if (deleted) {
    methods.push(`// ${deleted.name} implementa domain.${port}: la borrada más reciente con esa clave.
func (r *${type}) ${deleted.name}(ctx context.Context, ${keyFinder.params.map((p) => `${localName(p.name)} ${p.type}`).join(', ')}) (*domain.${entity.name}, bool, error) {
${keyFilter.prelude}	filter := append(${keyFilter.filter}, bson.E{Key: ${field}, Value: bson.D{{Key: "$ne", Value: nil}}})
	found, err := r.find(ctx, filter, options.Find().SetSort(bson.D{{Key: ${field}, Value: -1}}).SetLimit(1))
	if err != nil || len(found) == 0 {
		return nil, false, err
	}
	return found[0], true, nil
}`);
  }
  methods.push(`// Restore implementa domain.${port}.
func (r *${type}) Restore(ctx context.Context, ${id.name} ${id.type}) (*domain.${entity.name}, bool, error) {
	var restored *domain.${entity.name}
	err := r.tx.write(ctx, func(ctx context.Context) error {
		documents, err := r.tx.collection(${constant})
		if err != nil {
			return err
		}
		raw, err := documents.FindOne(ctx, bson.D{{Key: "_id", Value: ${idWrite}}, {Key: ${field}, Value: bson.D{{Key: "$ne", Value: nil}}}}).Raw()
		if errors.Is(err, mongodriver.ErrNoDocuments) {
			return nil
		}
		if err != nil {
			return err
		}
		// La ventana (restorableFor, D6): restaurable mientras ${DELETED_AT.field} + ${windowText(lifecycle.restore)} sea posterior a ahora.
		deletedAt, err := asInstant(raw.Lookup(${field}))
		if err != nil {
			return err
		}
		if !deletedAt.Add(${windowDuration(model, lifecycle.restore)}).After(time.Now()) {
			return ${windowError(model, entity, lifecycle.restore)}
		}
		// Si un documento vivo ocupa ya su clave, el índice único parcial salta AQUÍ, con su nombre (E11000).
		if _, err := documents.UpdateOne(ctx, bson.D{{Key: "_id", Value: ${idWrite}}}, bson.D{{Key: "$set", Value: bson.D{{Key: ${field}, Value: nil}}}${bump}}); err != nil {
			return err
		}
		found, err := r.find(ctx, bson.D{{Key: "_id", Value: ${idWrite}}})
		if err != nil {
			return err
		}
		if len(found) == 0 {
			return fmt.Errorf("%s: el documento restaurado no se pudo releer", ${constant})
		}
		restored = found[0]
		return nil
	})
	if err != nil || restored == nil {
		return nil, false, err
	}
	return restored, true, nil
}`);
  return methods;
}

/** El filtro parcial de un índice del documento: la condición del diseño y, con borrado lógico, la vida (T1). */
export function partialFilterEntries(spec, literal) {
  return [
    ...(spec.partialFilter ? [`{Key: ${goString(spec.partialFilter.path)}, Value: ${literal(spec.partialFilter.equals)}}`] : []),
    ...(spec.live ? [`{Key: ${goString(spec.live.path)}, Value: nil}`] : [])
  ];
}

// ─── La retención ────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que la anonimización toca, por miembro (D9): `{ root: [{ target, value, fold? }], children: [{ relation, entity, parent, sets }] }`.
 * Un opcional va a null; un obligatorio, al sustituto `anon-<id>` de la RAÍZ. Una sombra plegada (T7) se reescribe con el
 * valor plegado del sustituto, o a null. `target` es la columna (relacional) o la clave del documento.
 */
export function anonymizePlan(model, root, { document }) {
  const entity = model.entities.find((candidate) => candidate.name === root.entity);
  const byEntity = new Map(root.retention.anonymize.map((member) => [member.entity, member.fields]));
  const keyOf = (owner, name) => documentShape(model, owner).find((entry) => entry.member === name)?.name ?? snakeCase(name);
  const setsOf = (owner) => {
    const members = persistedMembers(model, owner);
    const sets = [];
    for (const { name, required } of byEntity.get(owner.name) ?? []) {
      const member = members.find((candidate) => candidate.name === name);
      if (member?.kind === 'vo') {
        // Un value object personal: todas sus columnas (o el subdocumento entero) a null.
        if (document) sets.push({ target: keyOf(owner, name), value: null });
        else for (const sub of member.subs) sets.push({ target: sub.column, value: null });
        continue;
      }
      const folded = member?.folded;
      sets.push({
        target: document ? keyOf(owner, name) : member?.field?.columns?.name ?? snakeCase(name),
        value: required ? 'substitute' : null,
        fold: folded ? { target: document ? snakeCase(folded.name) : folded.column, accents: Boolean(folded.accents) } : null
      });
    }
    return sets;
  };
  const children = persistedMembers(model, entity)
    .filter((member) => member.kind === 'relationMany' && byEntity.has(member.relation.entity))
    .map((member) => {
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      const back = backReferenceTo(model, child.name, entity.name);
      return {
        relation: document ? keyOf(entity, member.name) : member.name,
        entity: child,
        parent: back ? joinColumnOf({ name: back }) : parentColumnOf(entity.name),
        sets: setsOf(child)
      };
    });
  return { entity, root: setsOf(entity), children };
}

/**
 * Lo que keel-go no sabe anonimizar (miembros que no son escalares ni value objects, o entidades que no son la raíz ni
 * una hija uno-a-muchos): el mismo criterio que los otros tres.
 */
export function anonymizeGaps(model) {
  const gaps = [];
  for (const { root, entity } of retentionRoots(model)) {
    if (root.retention.then !== 'anonymize') continue;
    const reachable = new Set([entity.name, ...persistedMembers(model, entity).filter((m) => m.kind === 'relationMany').map((m) => m.relation.entity)]);
    for (const member of root.retention.anonymize) {
      if (!reachable.has(member.entity)) gaps.push(`${member.entity} (no es la raíz ni una hija uno-a-muchos de ${entity.name})`);
      const owner = model.entities.find((candidate) => candidate.name === member.entity);
      const members = persistedMembers(model, owner);
      for (const field of member.fields) {
        const kind = members.find((candidate) => candidate.name === field.name)?.kind;
        if (kind !== 'scalar' && kind !== 'vo') gaps.push(`${member.entity}.${field.name} (${kind ?? 'sin columna'})`);
      }
    }
  }
  return gaps;
}

/**
 * Lo que el ciclo de vida del dato no puede generar con este stack, o []. La unicidad entre vivas siempre tiene forma (el
 * índice parcial de PostgreSQL, la columna generada de MySQL, el filtro parcial de MongoDB); lo que queda es lo que no sabe
 * anonimizar. A medias, un dato personal sobreviviría a su retención sin que nada lo dijera.
 */
export function lifecycleStackErrors(model) {
  return anonymizeGaps(model).map(
    (gap) => `persistence: retention con then: anonymize (DSL 2.28): keel-go no sabe anonimizar ${gap}. Márcalo sin personal o usa then: delete.`
  );
}

/** El texto del sustituto en Go, según el tipo del id. */
function substituteExpression(entity, idName) {
  const type = entity.idField?.goType ?? 'uuid.UUID';
  const text = type === 'uuid.UUID' ? `${idName}.String()` : type === 'string' ? idName : `strconv.FormatInt(int64(${idName}), 10)`;
  return `${goString(ANONYMOUS_PREFIX)} + ${text}`;
}

/** El valor Go de una escritura de la anonimización: el sustituto, su pliegue o nil. */
function anonymizedValue(set) {
  return set.value === 'substitute' ? 'substitute' : 'nil';
}
function foldedValue(set) {
  return set.value === 'substitute' ? `${set.fold.accents ? 'textfold.CaseAndAccents' : 'textfold.Case'}(substitute)` : 'nil';
}

/** El corte de una retención en Go: la aritmética de `retentionCutoffMs` de keel-core. */
function cutoffExpression(model, span) {
  if (span.days) return `now.Add(-${span.days} * 24 * time.Hour)`;
  if (span.years) return `yearsBefore(now, ${span.years})`;
  const parameter = (model.service.parameters ?? []).find((candidate) => candidate.name === span.parameter);
  const value = `r.parameters.${parameterAccessor(parameter ?? { name: span.parameter })}()`;
  return span.unit === 'years' ? `yearsBefore(now, int(${value}))` : `now.Add(-time.Duration(${value}) * 24 * time.Hour)`;
}

const usesYears = (span) => Boolean(span.years) || span.unit === 'years';

/** Los archivos de la retención: un `<raíz>_retention.go` por raíz y la configuración de los barridos con su yaml. */
export function generate(model) {
  const roots = retentionRoots(model);
  if (roots.length === 0) return [];
  const { store } = layout(model);
  const document = model.persistenceKind === 'document';
  const imports = document
    ? ['context', 'errors', 'fmt', 'strconv', 'time', 'github.com/google/uuid', 'go.mongodb.org/mongo-driver/v2/bson', 'go.mongodb.org/mongo-driver/v2/mongo/options', 'internal/domain', 'internal/platform/textfold', 'internal/infrastructure/timer']
    : ['context', 'fmt', 'strconv', 'time', 'github.com/google/uuid', 'internal/domain', 'internal/platform/textfold', 'internal/infrastructure/timer'];
  return [
    ...roots.map(({ entity, root }) => ({
      path: `${store.dir}/${goFileName(entity.name)}_retention.go`,
      content: packageFile(model, store, { imports, body: document ? documentRetention(model, entity, root) : relationalRetention(model, entity, root) })
    })),
    { path: `${store.dir}/retention.go`, content: packageFile(model, store, { imports: ['fmt', 'strconv', 'strings', 'time', 'internal/platform/config'], body: retentionSettingsBody(model) }) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/retention.yaml`, content: retentionYaml(model, profile) }))
  ];
}

/** El struct, el constructor y el tick de una retención: lo común de los dos almacenes. */
function retentionHead(model, entity, root) {
  const type = retentionType(entity.name);
  const retention = root.retention;
  const caches = retentionCaches(model, entity.name);
  const fields = [
    ['tx', '*Transactions'],
    ['batchSize', 'int'],
    ...(retention.span.parameter ? [['parameters', `domain.${parametersType(model)}`]] : []),
    ...(caches.length > 0 ? [['swept', 'func(ctx context.Context)']] : [])
  ];
  const doc = `// ${type} es la retención de ${entity.name} (persistence.${entity.name}.retention, DSL 2.28): ${retention.fromDeleted ? 'desde el borrado lógico' : `desde ${retention.from}`},
// ${spanText(retention.span)}, y después ${retention.then === 'delete' ? 'se BORRA' : 'se ANONIMIZA'}. La dispara su recurrente del cronómetro en modo clúster (D8): cada tick
// lo ejecuta UNA réplica, la que gana su fila en keel_timer, FUERA de toda transacción.
//
// Por lotes y cada agregado en su transacción: una tabla grande no se recorre en una sola sentencia que bloquee la tabla y
// reviente el tope de transacción. Una fila con ${retention.from} nulo no vence nunca.`;
  const sweptDoc = caches.length > 0 ? ` swept vacía las cachés de las lecturas de ${entity.name} (T5): lo vencido ya no es lo que guardan.` : '';
  return `${doc}
type ${type} struct {
${alignRows(fields.map(([name, kind]) => ({ indent: '\t', cells: [name, kind] }))).join('\n')}
}

// New${type} construye la retención sobre las transacciones del servicio, con el lote de su barrido.${sweptDoc}
func New${type}(${fields.map(([name, kind]) => `${name} ${kind}`).join(', ')}) *${type} {
	return &${type}{${fields.map(([name]) => `${name}: ${name}`).join(', ')}}
}

// Recurring es la retención como recurrente del cronómetro en modo clúster (D8): su kind es el de keel-core, el MISMO en
// todas las réplicas, así que cada tick lo ejecuta una sola, la que gana su fila en keel_timer.
func (r *${type}) Recurring(spec string) (timer.Recurring, error) {
	return timer.NewRecurring(timer.${retentionKindConstant(entity.name)}, spec, r.Run)
}

// Run es un tick del recurrente: el corte lo calcula el servidor (${spanText(retention.span)} antes de ahora${usesYears(retention.span) ? ', en años de calendario UTC' : ''}), lo que
// venció EN el corte también se va, y el lote se repite mientras salga lleno.
func (r *${type}) Run(ctx context.Context) error {
	now := time.Now().UTC()
	cutoff := ${cutoffExpression(model, retention.span)}${caches.length > 0 ? '\n\tprocessed := 0' : ''}
	for {
		due, err := r.due(ctx, cutoff)
		if err != nil {
			return fmt.Errorf("la retención de ${entity.name}: %w", err)
		}
		for _, id := range due {
			if err := r.apply(ctx, id); err != nil {
				return fmt.Errorf("la retención de ${entity.name} %v: %w", id, err)
			}
		}${caches.length > 0 ? '\n\t\tprocessed += len(due)' : ''}
		if len(due) < r.batchSize {
			break
		}
	}${caches.length > 0 ? `
	if processed > 0 && r.swept != nil {
		r.swept(ctx)
	}` : ''}
	return nil
}`;
}

/** La función de los años de calendario (keel-core `retentionCutoffMs`): un 29 de febrero sin equivalente cae en el 28. */
const YEARS_BEFORE = `
// yearsBefore es el mismo instante years años de calendario antes, en UTC; un 29 de febrero sin equivalente cae en el 28
// (time.AddDate lo llevaría al 1 de marzo).
func yearsBefore(now time.Time, years int) time.Time {
	target := time.Date(now.Year()-years, now.Month(), 1, now.Hour(), now.Minute(), now.Second(), now.Nanosecond(), time.UTC)
	last := target.AddDate(0, 1, -1).Day()
	return target.AddDate(0, 0, min(now.Day(), last)-1)
}`;

function relationalRetention(model, entity, root) {
  const d = sqlDialect(model);
  const q = (name) => d.quote(name);
  const type = retentionType(entity.name);
  const retention = root.retention;
  const table = q(entity.tableName);
  const idColumn = q(entity.idField?.columns?.name ?? 'id');
  const idType = entity.idField?.goType ?? 'uuid.UUID';
  const fromColumn = q(retention.fromDeleted ? DELETED_AT.column : persistedMembers(model, entity).find((member) => member.name === retention.from)?.field?.columns?.name ?? snakeCase(retention.from));
  const pending = retention.then === 'anonymize' ? ` AND ${q(ANONYMIZED_AT.column)} IS NULL` : '';
  const version = entity.usesOptimisticLocking ? q(entity.declaresLockVersion ? entity.fields.find((field) => field.name === LOCK_VERSION.field)?.columns?.name ?? LOCK_VERSION.column : LOCK_VERSION.column) : null;
  let apply;
  if (retention.then === 'delete') {
    apply = `	// then: delete. Las filas de las hijas y de las listas caen con la raíz (ON DELETE CASCADE, T3).
	return r.tx.write(ctx, func(q DBTX) error {
		_, err := q.ExecContext(ctx, ${goString(`DELETE FROM ${table} WHERE ${idColumn} = ${d.param(1)}`)}, id)
		return err
	})`;
  } else {
    const plan = anonymizePlan(model, root, { document: false });
    const statement = (tableName, sets, where, extra = []) => {
      const assignments = [];
      const args = [];
      for (const set of sets) {
        assignments.push(`${q(set.target)} = ${d.param(args.length + 1)}`);
        args.push(anonymizedValue(set));
        if (set.fold) {
          assignments.push(`${q(set.fold.target)} = ${d.param(args.length + 1)}`);
          args.push(foldedValue(set));
        }
      }
      for (const [assignment, arg] of extra) {
        assignments.push(arg ? `${assignment}${d.param(args.length + 1)}` : assignment);
        if (arg) args.push(arg);
      }
      args.push('id');
      return `		if _, err := q.ExecContext(ctx, ${goString(`UPDATE ${tableName} SET ${assignments.join(', ')} WHERE ${where} = ${d.param(args.length)}`)}, ${args.join(', ')}); err != nil {
			return err
		}`;
    };
    const substitutes = [...plan.root, ...plan.children.flatMap((child) => child.sets)].some((set) => set.value === 'substitute');
    const lines = [
      ...(substitutes ? [`		substitute := ${substituteExpression(entity, 'id')}`] : []),
      statement(table, plan.root, idColumn, [[`${q(ANONYMIZED_AT.column)} = `, 'time.Now().UTC()'], ...(version ? [[`${version} = ${version} + 1`, null]] : [])]),
      ...plan.children.filter((child) => child.sets.length > 0).map((child) => statement(q(child.entity.tableName), child.sets, q(child.parent)))
    ];
    apply = `	// then: anonymize (D9). Un campo personal opcional queda a NULL y uno obligatorio recibe ${ANONYMOUS_PREFIX}<id>, que no deriva
	// del valor y conserva la unicidad. La marca ${ANONYMIZED_AT.column} lo saca del siguiente barrido (D11).
	return r.tx.write(ctx, func(q DBTX) error {
${lines.join('\n')}
		return nil
	})`;
  }
  return `
${retentionHead(model, entity, root)}

// due son los ids que han vencido en cutoff (vence EN el corte), los más antiguos primero, como mucho un lote.
func (r *${type}) due(ctx context.Context, cutoff time.Time) ([]${idType}, error) {
	q, err := r.tx.conn(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, ${goString(`SELECT ${idColumn} FROM ${table} WHERE ${fromColumn} <= ${d.param(1)}${pending} ORDER BY ${fromColumn} LIMIT ${d.param(2)}`)}, cutoff, r.batchSize)
	if err != nil {
		return nil, translate(err)
	}
	var ids []${idType}
	for rows.Next() {
		var id ${idType}
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, closeRows(rows)
}

// apply es lo que la retención hace con un agregado vencido, en su propia transacción.
func (r *${type}) apply(ctx context.Context, id ${idType}) error {
${apply}
}
${usesYears(retention.span) ? YEARS_BEFORE : ''}`;
}

function documentRetention(model, entity, root) {
  const type = retentionType(entity.name);
  const retention = root.retention;
  const idType = entity.idField?.goType ?? 'uuid.UUID';
  const keyOf = (name) => documentShape(model, entity).find((entry) => entry.member === name)?.name ?? snakeCase(name);
  const fromKey = retention.fromDeleted ? DELETED_AT.field : keyOf(retention.from);
  const pending = retention.then === 'anonymize' ? `, {Key: ${goString(ANONYMIZED_AT.field)}, Value: nil}` : '';
  const collection = goString(entity.collectionName);
  const idValue = idType === 'uuid.UUID' ? 'uuidValue(id)' : 'id';
  const read = `${{ 'uuid.UUID': 'asUUID', string: 'asText', int64: 'asInt64', int32: 'asInt32' }[idType] ?? 'asUUID'}(cursor.Current.Lookup("_id"))`;
  let apply;
  if (retention.then === 'delete') {
    apply = `		// then: delete. El agregado es el documento: sus entidades internas se van con él.
		_, err = documents.DeleteOne(ctx, bson.D{{Key: "_id", Value: ${idValue}}})
		return err`;
  } else {
    const plan = anonymizePlan(model, root, { document: true });
    const version = entity.usesOptimisticLocking ? (entity.declaresLockVersion ? keyOf(LOCK_VERSION.field) : LOCK_VERSION.column) : null;
    const entries = (sets, prefix = '') =>
      sets.flatMap((set) => [
        `{Key: ${goString(`${prefix}${set.target}`)}, Value: ${anonymizedValue(set)}}`,
        ...(set.fold ? [`{Key: ${goString(`${prefix}${set.fold.target}`)}, Value: ${foldedValue(set)}}`] : [])
      ]);
    const substitutes = [...plan.root, ...plan.children.flatMap((child) => child.sets)].some((set) => set.value === 'substitute');
    const rootSet = [...entries(plan.root), `{Key: ${goString(ANONYMIZED_AT.field)}, Value: instantValue(time.Now().UTC())}`];
    const inc = version ? `, {Key: "$inc", Value: bson.D{{Key: ${goString(version)}, Value: int64(1)}}}` : '';
    const children = plan.children
      .filter((child) => child.sets.length > 0)
      .map(
        (child) => `		// Las ${child.entity.name} del documento: \`$[]\` exige que el array exista, así que solo donde lo hay.
		if _, err := documents.UpdateOne(ctx, bson.D{{Key: "_id", Value: ${idValue}}, {Key: ${goString(child.relation)}, Value: bson.D{{Key: "$type", Value: "array"}}}}, bson.D{{Key: "$set", Value: bson.D{${entries(child.sets, `${child.relation}.$[].`).join(', ')}}}}); err != nil {
			return err
		}`
      );
    apply = `		// then: anonymize (D9). Un campo personal opcional queda a null y uno obligatorio recibe ${ANONYMOUS_PREFIX}<id>, que no deriva
		// del valor y conserva la unicidad. La marca ${ANONYMIZED_AT.field} lo saca del siguiente barrido (D11).
${substitutes ? `		substitute := ${substituteExpression(entity, 'id')}\n` : ''}		if _, err := documents.UpdateOne(ctx, bson.D{{Key: "_id", Value: ${idValue}}}, bson.D{{Key: "$set", Value: bson.D{${rootSet.join(', ')}}}${inc}}); err != nil {
			return err
		}
${children.length > 0 ? `${children.join('\n')}\n` : ''}		return nil`;
  }
  return `
${retentionHead(model, entity, root)}

// due son los ids que han vencido en cutoff (vence EN el corte), los más antiguos primero, como mucho un lote.
func (r *${type}) due(ctx context.Context, cutoff time.Time) ([]${idType}, error) {
	documents, err := r.tx.collection(${collection})
	if err != nil {
		return nil, err
	}
	filter := bson.D{{Key: ${goString(fromKey)}, Value: bson.D{{Key: "$lte", Value: instantValue(cutoff)}}}${pending}}
	cursor, err := documents.Find(ctx, filter, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}).SetSort(bson.D{{Key: ${goString(fromKey)}, Value: 1}}).SetLimit(int64(r.batchSize)))
	if err != nil {
		return nil, translate(err)
	}
	defer cursor.Close(ctx)
	var ids []${idType}
	for cursor.Next(ctx) {
		id, err := ${read}
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, translate(cursor.Err())
}

// apply es lo que la retención hace con un agregado vencido, en su propia transacción.
func (r *${type}) apply(ctx context.Context, id ${idType}) error {
	return r.tx.write(ctx, func(ctx context.Context) error {
		documents, err := r.tx.collection(${collection})
		if err != nil {
			return err
		}
${apply}
	})
}
${usesYears(retention.span) ? YEARS_BEFORE : ''}`;
}

/** La configuración de los barridos: el cron y el lote de cada raíz, con las claves y los defaults de keel-core. */
function retentionSettingsBody(model) {
  const roots = retentionRoots(model);
  const fields = alignRows(roots.map(({ entity }) => ({ indent: '\t', cells: [entity.name, 'RetentionSweep'] })));
  const reads = roots.map(({ entity }) => {
    const parameters = retentionParameters(entity.name);
    return `	if settings.${entity.name}, err = retentionSweep(cfg, ${goString(parameters.cron.key)}, ${goString(parameters.cron.default)}, ${goString(parameters.batchSize.key)}, ${parameters.batchSize.default}); err != nil {
		return RetentionSettings{}, err
	}`;
  });
  return `
// RetentionSweep es un barrido de retención: su cron (seis campos, con segundos, en UTC) y los agregados por lote.
type RetentionSweep struct {
	Cron      string
	BatchSize int
}

// RetentionSettings son los barridos de retención (DSL 2.28) del perfil activo (config/parameters/<perfil>/retention.yaml),
// con las claves y los defaults de keel-core (retentionParameters), los mismos que leen keel-spring, keel-nest y keel-dotnet.
type RetentionSettings struct {
${fields.join('\n')}
}

// RetentionSettingsFrom lee los barridos al ARRANCAR: un lote que no es un entero positivo no deja arrancar.
func RetentionSettingsFrom(cfg *config.Config) (RetentionSettings, error) {
	var (
		settings RetentionSettings
		err      error
	)
${reads.join('\n')}
	return settings, nil
}

// retentionSweep lee el cron y el lote de un barrido, con sus defaults.
func retentionSweep(cfg *config.Config, cronKey, cronDefault, batchKey string, batchDefault int) (RetentionSweep, error) {
	sweep := RetentionSweep{Cron: cronDefault, BatchSize: batchDefault}
	if value, ok := cfg.Value(cronKey); ok && strings.TrimSpace(value) != "" {
		sweep.Cron = strings.TrimSpace(value)
	}
	if value, ok := cfg.Value(batchKey); ok && strings.TrimSpace(value) != "" {
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || n <= 0 {
			return RetentionSweep{}, fmt.Errorf("%s tiene que ser un entero positivo: %q (default %d)", batchKey, value, batchDefault)
		}
		sweep.BatchSize = n
	}
	return sweep, nil
}
`;
}

/** `config/parameters/<perfil>/retention.yaml`: las claves y variables de keel-core, las mismas en los cuatro. */
export function retentionYaml(model, profile) {
  const lines = ['# Los barridos de retención (DSL 2.28): un recurrente del cronómetro por raíz, en modo clúster.', 'retention:'];
  for (const { entity } of retentionRoots(model)) {
    const parameters = retentionParameters(entity.name);
    const [, kebab] = parameters.cron.key.split('.');
    lines.push(
      `  ${kebab}:`,
      `    cron: ${cronWithDefault(profile, parameters.cron.env, parameters.cron.default)}`,
      `    batch-size: ${envWithDefault(profile, parameters.batchSize.env, parameters.batchSize.default)}`
    );
  }
  return `${lines.join('\n')}\n`;
}

// ─── El cronómetro y el arranque ─────────────────────────────────────────────────────────────────

/** Las filas de las constantes del paquete del cronómetro (kinds.go): una por retención. */
export function retentionKindRows(model) {
  return retentionRoots(model).flatMap(({ entity, root }) => [
    { text: `\t// ${retentionKindConstant(entity.name)} es la retención de ${entity.name} (DSL 2.28): un recurrente en modo clúster.` },
    { indent: '\t', cells: [retentionKindConstant(entity.name), `= ${goString(root.retention.kind)}`] }
  ]);
}

/** ¿Vacía la retención de alguna raíz una caché? Entonces el arranque necesita la caché en una variable. */
export function retentionClearsCaches(model) {
  return retentionRoots(model).some(({ entity }) => retentionCaches(model, entity.name).length > 0);
}

/**
 * Los recurrentes de las retenciones en el arranque, tras la purga del cronómetro: `{ code, variables }`. `store` es el
 * paquete del almacén.
 */
export function retentionWiring(model, store) {
  const roots = retentionRoots(model);
  if (roots.length === 0) return { code: '', variables: [] };
  const variables = [];
  const lines = [`	retention, err := ${store.name}.RetentionSettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("los barridos de retención: %w", err)
	}
`];
  for (const { entity, root } of roots) {
    const variable = `retention${entity.name}`;
    variables.push(variable);
    const caches = retentionCaches(model, entity.name);
    const args = [
      'transactions',
      `retention.${entity.name}.BatchSize`,
      ...(root.retention.span.parameter ? [PARAMETERS_VAR] : []),
      ...(caches.length > 0 ? [`func(ctx context.Context) {\n${caches.map((cache) => `\t\toperationCache.Clear(ctx, application.${cacheVar(cache.operation)})`).join('\n')}\n\t}`] : [])
    ];
    lines.push(`	// La retención de ${entity.name} (DSL 2.28): UNA réplica por tick, la que gana su fila.
	${variable}, err := ${store.name}.New${retentionType(entity.name)}(${args.join(', ')}).Recurring(retention.${entity.name}.Cron)
	if err != nil {
		return fmt.Errorf("la retención de ${entity.name}: %w", err)
	}
`);
  }
  return { code: lines.join(''), variables };
}

// ─── El arnés de flujos: AgeDeletion ─────────────────────────────────────────────────────────────

function deletionAgingDoc(targets, via) {
  const known = targets.map((target) => target.entity).join(', ');
  return `// deletionAging son las sentencias que envejecen el borrado lógico de cada entidad que lo tiene: ${known}.
//
// AgeDeletion envejece el borrado lógico de la fila id de entity: retrasa su marca de borrado days días (por ${via}), para
// que un escenario de la ventana de restauración o de la purga no espere a que pase el tiempo. Solo envejece una fila YA
// borrada, y falla si no envejeció ninguna: un id equivocado, o la llamada antes del DELETE. La tabla y la columna salen
// del modelo, no de un SQL escrito a mano. No purga nada: la purga la hace el barrido de la retención en su próxima
// pasada, que se adelanta con FireTimer.
//
//	s.AgeDeletion(${goString(targets[0].entity)}, id, 31)`;
}

/** El cuerpo común de AgeDeletion: valida, busca la entrada del mapa y exige que la salida diga 1. */
function deletionAgingFunc(targets, call) {
  const known = targets.map((target) => target.entity).join(', ');
  return String.raw`func (s *Scenario) AgeDeletion(entity, id string, days int) {
	s.Helper()
	if days <= 0 {
		s.Fatalf("los días tienen que ser un entero positivo: %d", days)
	}
	statement, ok := deletionAging[entity]
	if !ok {
		s.Fatalf("no hay borrado lógico en la entidad %q. Las que lo tienen: ${known}", entity)
	}
	lines := strings.Split(strings.TrimSpace(${call}), "\n")
	if strings.TrimSpace(lines[len(lines)-1]) != "1" {
		s.Fatalf("AgeDeletion: %s %s ${AGE_DELETION_MISS}.", entity, id)
	}
}`;
}

/**
 * `AgeDeletion(entity, id, days)` en el arnés relacional: la sentencia de keel-core (`ageDeletionStatement`) con los días y
 * el `idLiteral` del motor. Sin borrado lógico, o en un motor sin la sentencia, no se emite.
 */
export function relationalDeletionAgingMembers(model) {
  if (!usesRelational(model)) return [];
  const engine = relationalEngine(model);
  const targets = deletionAgingTargets(model);
  if (targets.length === 0 || !AGE_DELETION_ENGINES.includes(engine) || !DATABASES[engine]?.uuidLiteral) return [];
  const rows = targets.map((target) => ({
    indent: '\t',
    cells: [`${goString(target.entity)}:`, `${goString(ageDeletionStatement(engine, target).replace(':days', '%[1]d').replace(':entityId', '%[2]s'))},`]
  }));
  return [`${deletionAgingDoc(targets, 'Db')}
var deletionAging = map[string]string{
${alignRows(rows).join('\n')}
}

${deletionAgingFunc(targets, 's.Db(fmt.Sprintf(statement, days, idLiteral(id)))')}`];
}

/** `AgeDeletion` sobre documentos, con el script de keel-core (`ageDeletionScript`). */
export function documentDeletionAgingMembers(model) {
  if (usesRelational(model)) return [];
  const targets = deletionAgingTargets(model);
  if (targets.length === 0) return [];
  const rows = targets.map((target) => ({ indent: '\t', cells: [`${goString(target.entity)}:`, `${goString(ageDeletionScript({ collection: target.collection }))},`] }));
  return [`${deletionAgingDoc(targets, 'MongoEval')}
var deletionAging = map[string]string{
${alignRows(rows).join('\n')}
}

${deletionAgingFunc(targets, 's.MongoEval(strings.NewReplacer("{id}", s.documentID(id), "{ms}", strconv.FormatInt(int64(days)*86_400_000, 10)).Replace(statement))')}`];
}
