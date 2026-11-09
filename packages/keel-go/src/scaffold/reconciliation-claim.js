// El reclamo del barrido de RECONCILIACIÓN (tramo 11c; sobre documentos, 13h-b): llevarse los encargos que llevan demasiado
// tiempo sin desenlace, de forma que dos réplicas no se lleven el mismo. El mismo mecanismo que keel-spring, keel-nest y
// keel-dotnet, sobre database/sql con PostgreSQL o MySQL y sobre el driver de MongoDB.
//
// Por qué NO es el reclamo de una cola (claim.js): allí la marca es el propio estado de destino; aquí el estado de espera
// es justo lo que el barrido busca y no se puede cambiar antes de saber el desenlace, y entre reclamar y actuar hay una
// llamada al proveedor —un lock solo aísla mientras dura su transacción—. De ahí la tabla propia `reconciliation_claim`,
// con una marca que SOBREVIVE AL COMMIT y CADUCA.
//
// La tabla, su purga, los tres números de cada barrido (clave, variable y default), su reconciliation.yaml y la regla de
// quién se lleva el candidato son de keel-core (`gen/reconciliation-stores.js`), los mismos que en los otros tres.
//
// Lo propio de cada motor, el reparto de keel-dotnet:
//   · PostgreSQL: la marca con UNA sentencia (`INSERT … ON CONFLICT DO UPDATE … WHERE claimed_at <= caducidad`). No se
//     captura una violación de clave para decidirlo: en PostgreSQL un error aborta la transacción entera, y el reclamo de
//     cada candidato va dentro de la de su tanda;
//   · MySQL: el UPDATE condicional sobre la marca caducada y, si no casó, `INSERT IGNORE`, donde la clave primaria deja
//     una sola réplica. go-sql-driver cuenta las filas CAMBIADAS (sin clientFoundRows), así que el UPDATE que renueva
//     cuenta 1 y el que no casa, 0;
//   · MongoDB: un solo upsert con la clave aplanada en el `_id` y el filtro sobre la marca CADUCADA, atómico por documento y
//     fuera de toda transacción: si la marca está viva no casa, intenta insertar y choca con el `_id`, y eso dice que el
//     candidato es de otra réplica.
// La lectura de candidatos excluye los de marca VIVA: sin eso, la cabeza de la cola —reclamada y aún sin resolver—
// ocuparía el lote de cada pasada hasta caducar (el defecto que destapó keel-dotnet en su 11c, cerrado en los tres).

import { RECONCILIATION_CLAIM, RECONCILIATION_PURGE, reconciledActivations, reconciliationClaims, reconciliationParameters, reconciliationYaml } from '@keel-system/keel-core/gen/reconciliation-stores';
import { screamingSnake, snakeCase } from '@keel-system/keel-core/gen';
import { storeDocumentKey } from '@keel-system/keel-core/gen/document';
import { usesDocument, usesRelational } from '@keel-system/keel-core/gen/features';
import { goExported } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { sqlDialect } from '../lib/relational-engine.js';
import { layout, packageFile } from './render.js';
import { usesDependencies } from './use-cases.js';
import { BSON, MONGO_DRIVER, MONGO_OPTIONS } from './document-persistence.js';
import { sweepPassSignal } from './timer.js';

/** ¿Hay barridos de reconciliación que leer? Los hay aunque build no pueda generar el reclamo (lo escribe el agente). */
export function usesReconciliationSettings(model) {
  return (usesRelational(model) || usesDocument(model)) && usesDependencies(model) && reconciledActivations(model).length > 0;
}

/** ¿Genera build algún reclamo de reconciliación? */
export function usesReconciliationClaims(model) {
  return usesReconciliationSettings(model) && reconciliationClaims(model).length > 0;
}

/** La tabla de las marcas, como la espera el baseline (persistence.js). */
export function reconciliationTables(model) {
  return usesReconciliationClaims(model) ? [RECONCILIATION_CLAIM] : [];
}

/** La purga de la tabla, para purge.js: las marcas viejas ya no protegen nada. La misma que keel-nest y keel-dotnet. */
export function reconciliationPurge(model) {
  if (!usesReconciliationClaims(model)) return null;
  return {
    field: 'ReconciliationClaim',
    what: RECONCILIATION_CLAIM.table,
    constructor: 'NewReconciliationClaimPurge',
    table: RECONCILIATION_CLAIM.table,
    column: 'claimed_at',
    predicate: null,
    prefix: 'reconciliation.purge',
    cron: RECONCILIATION_PURGE.cron,
    retentionDays: RECONCILIATION_PURGE.retentionDays
  };
}

/** El método Go de un reclamo: `ClaimForReconcileReservationsReserveStock`. */
export const reconciliationMethod = (claim) => goExported(claim.method);

export function generate(model) {
  if (!usesReconciliationSettings(model)) return [];
  const { store } = layout(model);
  const claims = usesReconciliationClaims(model);
  const imports = ['fmt', 'strconv', 'strings', 'time', 'internal/platform/config'];
  const document = usesDocument(model);
  if (claims) imports.push('context', 'github.com/google/uuid', ...(document ? [MONGO_DRIVER, BSON, MONGO_OPTIONS] : ['database/sql']));
  return [
    { path: `${store.dir}/reconciliation.go`, content: packageFile(model, store, { imports, body: `${settingsBody(model)}${claims ? (document ? documentClaimBody() : claimBody(model)) : ''}` }) },
    { path: `${store.dir}/reconciliation_test.go`, content: packageFile(model, store, { test: true, imports: ['strings', 'testing', 'testing/fstest', 'time', store.dir, 'internal/platform/config'], body: settingsTest(model) }) },
    // Los mismos perfiles que los otros tres: en test valen los defaults del código.
    ...['local', 'develop', 'production'].map((profile) => ({ path: `config/parameters/${profile}/reconciliation.yaml`, content: reconciliationYaml(model, profile) }))
  ];
}

// ─── La configuración ────────────────────────────────────────────────────────────────────────────

function settingsBody(model) {
  const entries = reconciledActivations(model).map(({ activation, sweeper }) => {
    const parameters = reconciliationParameters(activation, sweeper);
    return { indent: '\t\t\t', cells: [`${goString(activation.name)}:`, `{UnansweredAfterSeconds: ${parameters.unansweredAfterSeconds.default}, ClaimTimeoutMs: ${parameters.claimTimeoutMs.default}, BatchSize: ${parameters.batchSize.default}},`] };
  });
  const keys = reconciledActivations(model).map(({ activation, sweeper }) => {
    const parameters = reconciliationParameters(activation, sweeper);
    const prefix = parameters.batchSize.key.replace(/\.batch-size$/, '');
    return { indent: '\t', cells: [`${goString(activation.name)}:`, `${goString(prefix)},`] };
  });
  return `
// ReconciliationWindow son los tres números de un barrido de reconciliación, y NO son la misma clase de decisión: el
// silencio tolerado lo declara el diseño (unansweredAfterSeconds de la activación); la caducidad del reclamo y la cota del
// lote son del generador (mecánica y capacidad).
type ReconciliationWindow struct {
	// UnansweredAfterSeconds es cuánto silencio del proveedor se tolera antes de que el encargo sea candidato.
	UnansweredAfterSeconds int
	// ClaimTimeoutMs es cuánto retiene un candidato la réplica que lo reclamó: cubre la pasada entera.
	ClaimTimeoutMs int
	// BatchSize es la cota del lote de una pasada.
	BatchSize int
}

// UnansweredAfter es el umbral del silencio como duración.
func (w ReconciliationWindow) UnansweredAfter() time.Duration {
	return time.Duration(w.UnansweredAfterSeconds) * time.Second
}

// ClaimTimeout es la caducidad del reclamo como duración.
func (w ReconciliationWindow) ClaimTimeout() time.Duration {
	return time.Duration(w.ClaimTimeoutMs) * time.Millisecond
}

// ReconciliationSettings son los barridos de reconciliación del perfil activo
// (config/parameters/<perfil>/reconciliation.yaml), por activación, con las claves y los defaults de los servidores de
// keel-spring, keel-nest y keel-dotnet.
type ReconciliationSettings struct {
	// Windows son los tres números de cada barrido, por el nombre de la activación.
	Windows map[string]ReconciliationWindow
}

// reconciliationKeys es el prefijo de configuración de cada activación.
var reconciliationKeys = map[string]string{
${alignRows(keys).join('\n')}
}

// DefaultReconciliationSettings son los barridos sin configuración: los defaults de los cuatro servidores.
func DefaultReconciliationSettings() ReconciliationSettings {
	return ReconciliationSettings{
		Windows: map[string]ReconciliationWindow{
${alignRows(entries).join('\n')}
		},
	}
}

// ReconciliationSettingsFrom lee los barridos del perfil al ARRANCAR: un valor que no es un entero positivo no deja
// arrancar.
func ReconciliationSettingsFrom(cfg *config.Config) (ReconciliationSettings, error) {
	settings := DefaultReconciliationSettings()
	for activation, window := range settings.Windows {
		prefix := reconciliationKeys[activation]
		fields := []struct {
			leaf  string
			value *int
		}{
			{"unanswered-after-seconds", &window.UnansweredAfterSeconds},
			{"claim-timeout-ms", &window.ClaimTimeoutMs},
			{"batch-size", &window.BatchSize},
		}
		for _, field := range fields {
			name := prefix + "." + field.leaf
			value, ok := cfg.Value(name)
			if !ok || strings.TrimSpace(value) == "" {
				continue
			}
			n, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil || n <= 0 {
				return ReconciliationSettings{}, fmt.Errorf("%s tiene que ser un entero positivo: %q (default %d)", name, value, *field.value)
			}
			*field.value = n
		}
		settings.Windows[activation] = window
	}
	return settings, nil
}
`;
}

function settingsTest(model) {
  const { store } = layout(model);
  const [{ activation, sweeper }] = reconciledActivations(model);
  const parameters = reconciliationParameters(activation, sweeper);
  const prefix = parameters.batchSize.key.replace(/\.batch-size$/, '');
  const [root, leaf, ...rest] = prefix.split('.');
  if (rest.length > 0) throw new Error(`La clave de reconciliación ${prefix} tiene más de dos niveles`);
  const fragment = (value) => `${root}:\n  ${leaf}:\n    batch-size: ${value}\n`;
  return `
// load es la configuración con application.yaml y un fragmento del perfil por defecto con fragment dentro.
func load(t *testing.T, fragment string) *config.Config {
	t.Helper()
	fsys := fstest.MapFS{
		"application.yaml":                     {Data: []byte("server:\\n  port: 8080\\n")},
		"parameters/local/reconciliation.yaml": {Data: []byte(fragment)},
	}
	cfg, err := config.Load(fsys, func(string) string { return "" })
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return cfg
}

func TestReconciliationSettingsFromReadsTheProfile(t *testing.T) {
	settings, err := ${store.name}.ReconciliationSettingsFrom(load(t, ${goString(fragment(7))}))
	if err != nil {
		t.Fatalf("ReconciliationSettingsFrom = %v", err)
	}
	window := settings.Windows[${goString(activation.name)}]
	if window.BatchSize != 7 {
		t.Errorf("BatchSize = %d, quiero 7", window.BatchSize)
	}
	// Lo que el perfil no dice conserva el default: el umbral es el del diseño.
	if got := window.UnansweredAfter(); got != ${parameters.unansweredAfterSeconds.default}*time.Second {
		t.Errorf("UnansweredAfter = %v, quiero el del diseño (${parameters.unansweredAfterSeconds.default} s)", got)
	}
	if got := window.ClaimTimeout(); got != ${parameters.claimTimeoutMs.default}*time.Millisecond {
		t.Errorf("ClaimTimeout = %v, quiero el default (${parameters.claimTimeoutMs.default} ms)", got)
	}
}

func TestReconciliationSettingsFromRefusesANonPositiveValue(t *testing.T) {
	_, err := ${store.name}.ReconciliationSettingsFrom(load(t, ${goString(fragment(0))}))
	if err == nil || !strings.Contains(err.Error(), ${goString(`${prefix}.batch-size`)}) {
		t.Errorf("ReconciliationSettingsFrom = %v, quiero el error de ${prefix}.batch-size", err)
	}
}
`;
}

// ─── La marca ────────────────────────────────────────────────────────────────────────────────────

/** Las sentencias con que cada motor dice quién se lleva la marca, con sus argumentos en orden. */
export function reconciliationClaimStatements(model) {
  const d = sqlDialect(model);
  const table = RECONCILIATION_CLAIM.table;
  if (d.mysql) {
    return {
      renew: `UPDATE ${table} SET claimed_at = ? WHERE activation = ? AND entity_id = ? AND claimed_at <= ?`,
      renewArgs: ['now', 'activation', 'entityID', 'expiredBefore'],
      insert: `INSERT IGNORE INTO ${table} (activation, entity_id, claimed_at) VALUES (?, ?, ?)`,
      insertArgs: ['activation', 'entityID', 'now']
    };
  }
  return {
    upsert: `INSERT INTO ${table} (activation, entity_id, claimed_at) VALUES ($1, $2, $3) ON CONFLICT (activation, entity_id) DO UPDATE SET claimed_at = EXCLUDED.claimed_at WHERE ${table}.claimed_at <= $4`,
    upsertArgs: ['activation', 'entityID', 'now', 'expiredBefore']
  };
}

function claimBody(model) {
  const sql = reconciliationClaimStatements(model);
  const statement = sqlDialect(model).mysql
    ? `	// La marca caducada se renueva (1 = cambiada, y es mía)…
	renewed, err := affected(q.ExecContext(ctx, ${goString(sql.renew)}, ${sql.renewArgs.join(', ')}))
	if err != nil || renewed == 1 {
		return renewed == 1, err
	}
	// …y sin marca, la inserción es el reclamo: si otra réplica la tiene (viva o recién puesta), no inserta nada.
	inserted, err := affected(q.ExecContext(ctx, ${goString(sql.insert)}, ${sql.insertArgs.join(', ')}))
	return inserted == 1, err`
    : `	won, err := affected(q.ExecContext(ctx, ${goString(sql.upsert)}, ${sql.upsertArgs.join(', ')}))
	return won == 1, err`;
  const how = sqlDialect(model).mysql
    ? `// Dos sentencias: el UPDATE de la marca caducada y, si no casó, INSERT IGNORE. ON DUPLICATE KEY UPDATE no diría quién
// ganó con la misma claridad. La clave primaria deja una sola réplica: la otra espera su commit y no inserta nada.`
    : `// UNA sentencia: INSERT … ON CONFLICT DO UPDATE … WHERE. Una fila afectada = la marca es mía; cero = otra réplica la
// tiene viva. No se captura una violación de clave para decidirlo: en PostgreSQL un error aborta la transacción entera, y
// este reclamo va dentro de la de su tanda.`;
  return `
// claimReconciliation dice si ESTA réplica se lleva el candidato entityID del barrido de activation: la regla de
// keel-core (reconciliationClaimReference), la misma que en keel-spring, keel-nest y keel-dotnet. Sin marca, la inserción
// es el reclamo; con marca, solo si CADUCÓ (claimed_at <= expiredBefore). Y si dos réplicas van a la vez a por el mismo
// candidato, la clave primaria deja una sola.
//
${how}
//
// Corre en la transacción q del reclamo: la marca existe para las demás réplicas cuando esa transacción confirma, ANTES
// de llamar al proveedor.
func claimReconciliation(ctx context.Context, q DBTX, activation string, entityID uuid.UUID, now, expiredBefore time.Time) (bool, error) {
	now, expiredBefore = now.UTC(), expiredBefore.UTC()
${statement}
}

// affected son las filas que tocó una sentencia.
func affected(result sql.Result, err error) (int64, error) {
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
`;
}

// ─── La marca sobre documentos ───────────────────────────────────────────────────────────────────

function documentClaimBody() {
  const key = storeDocumentKey(RECONCILIATION_CLAIM);
  if (key.kind !== 'flattened') throw new Error(`${RECONCILIATION_CLAIM.table}: se esperaba la clave aplanada`);
  const [activationField, entityField] = key.columns;
  return `
// reconciliationCollection es la colección de las marcas del reclamo.
const reconciliationCollection = ${goString(RECONCILIATION_CLAIM.table)}

// heldReconciliations son los candidatos de activation con una marca VIVA (posterior a expiredBefore): lo que la lectura de
// candidatos excluye, para que la cabeza de la cola —reclamada y aún sin resolver— no ocupe el lote de cada pasada hasta
// caducar. Nunca es nil: un \$nin sin lista es un error del servidor.
func heldReconciliations(ctx context.Context, tx *Transactions, activation string, expiredBefore time.Time) (bson.A, error) {
	documents, err := tx.collection(reconciliationCollection)
	if err != nil {
		return nil, err
	}
	cursor, err := documents.Find(ctx, bson.D{{Key: ${goString(activationField)}, Value: activation}, {Key: "claimed_at", Value: bson.D{{Key: "\$gt", Value: instantValue(expiredBefore)}}}}, options.Find().SetProjection(bson.D{{Key: ${goString(entityField)}, Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	held := bson.A{}
	for cursor.Next(ctx) {
		id, err := get(cursor.Current, ${goString(entityField)}, asUUID)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", reconciliationCollection, err)
		}
		held = append(held, uuidValue(id))
	}
	return held, cursor.Err()
}

// claimReconciliation dice si ESTA réplica se lleva el candidato entityID del barrido de activation: la regla de keel-core
// (reconciliationClaimReference), la misma que en keel-spring, keel-nest y keel-dotnet. Sin marca, la inserción es el reclamo;
// con marca, solo si CADUCÓ (claimed_at <= expiredBefore).
//
// Un solo upsert hace las dos mitades y es atómico por documento: el filtro pide la marca CADUCADA, así que si está viva no
// casa con nada y MongoDB intenta insertar: choca con el _id, y la clave duplicada dice que el candidato es de otra réplica.
// Ceder de más es benigno: la pasada siguiente lo recoge. El _id es la clave aplanada <activación>${key.separator}<entidad>, y las dos
// columnas van además como campos. Fuera de toda transacción: la marca tiene que existir para las demás réplicas ANTES de
// llamar al proveedor.
func claimReconciliation(ctx context.Context, tx *Transactions, activation string, entityID uuid.UUID, now, expiredBefore time.Time) (bool, error) {
	documents, err := tx.collection(reconciliationCollection)
	if err != nil {
		return false, err
	}
	filter := bson.D{{Key: "_id", Value: activation + ${goString(key.separator)} + entityID.String()}, {Key: "claimed_at", Value: bson.D{{Key: "\$lte", Value: instantValue(expiredBefore)}}}}
	update := bson.D{
		{Key: "\$set", Value: bson.D{{Key: "claimed_at", Value: instantValue(now)}}},
		{Key: "\$setOnInsert", Value: bson.D{{Key: ${goString(activationField)}, Value: activation}, {Key: ${goString(entityField)}, Value: uuidValue(entityID)}}},
	}
	_, err = documents.UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true))
	if mongodriver.IsDuplicateKeyError(err) {
		return false, nil
	}
	return err == nil, err
}
`;
}

/**
 * Los métodos de reclamo de reconciliación del adaptador documental: los candidatos, el que más lleva primero, y la marca de
 * cada uno. Sin transacción y con el estado de la raíz intacto.
 */
export function documentReconciliationMethods(model, entity, type) {
  const idMethod = goExported(entity.idField?.name ?? 'id');
  return claimsFor(model, entity.name).map((claim) => {
    const method = reconciliationMethod(claim);
    const states = claim.states.map((state) => goString(storedStateOf(model, entity, state))).join(', ');
    const awaiting = goString(snakeCase(claim.awaitingField));
    return `// ${method} implementa domain.${entity.name}Repository (reconciliación).
func (r *${type}) ${method}(ctx context.Context) ([]*domain.${entity.name}, error) {
	if openTx(ctx) != nil {
		return nil, fmt.Errorf("%s confirma por su cuenta y hay una transacción abierta: despacha la operación con application.WithoutTransaction (el reloj ya lo hace)", ${goString(method)})
	}
	ctx = outside(ctx)
	window := r.reconciliation.Windows[${goString(claim.activation)}]
	// Los dos cortes, sobre el MISMO instante: lleva demasiado sin desenlace, y el reclamo ajeno ya caducó.
	now := time.Now().UTC()
	unansweredBefore := now.Add(-window.UnansweredAfter())
	claimExpiredBefore := now.Add(-window.ClaimTimeout())
	// Los que ya tienen una marca VIVA no son candidatos: sin excluirlos, la cabeza de la cola ocuparía el lote de cada pasada
	// hasta caducar, y los de detrás no se reconciliarían antes. El estado NO se toca.
	held, err := heldReconciliations(ctx, r.tx, ${goString(claim.activation)}, claimExpiredBefore)
	if err != nil {
		return nil, translate(err)
	}
	filter := bson.D{
		{Key: ${goString(snakeCase(entity.lifecycle.field))}, Value: bson.D{{Key: "\$in", Value: bson.A{${states}}}}},
		{Key: ${awaiting}, Value: bson.D{{Key: "\$lt", Value: instantValue(unansweredBefore)}}},
		{Key: "_id", Value: bson.D{{Key: "\$nin", Value: held}}},
	}
	candidates, err := r.find(ctx, filter, options.Find().SetSort(bson.D{{Key: ${awaiting}, Value: 1}, {Key: "_id", Value: 1}}).SetLimit(int64(window.BatchSize)))
	if err != nil {
		return nil, err
	}
	var claimed []*domain.${entity.name}
	for _, candidate := range candidates {
		// true = la marca es mía; false = otra réplica la tiene y aún no ha caducado.
		won, err := claimReconciliation(ctx, r.tx, ${goString(claim.activation)}, candidate.${idMethod}(), now, claimExpiredBefore)
		if err != nil {
			return claimed, translate(err)
		}
		if won {
			claimed = append(claimed, candidate)
		}
	}
${sweepPassSignal(model, claim, 'len(candidates)', 'window.BatchSize')}	return claimed, nil
}`;
  });
}

// ─── El puerto y el adaptador de la raíz que espera ──────────────────────────────────────────────

const claimsFor = (model, entityName) => (usesReconciliationClaims(model) ? reconciliationClaims(model).filter((claim) => claim.entity === entityName) : []);

function describe(claim) {
  return (
    `reclama los ${claim.entity} que encargaron trabajo a ${claim.dependency}.${claim.activation} y llevan demasiado tiempo sin desenlace (${claim.awaitingField} más viejo que el umbral que declara el diseño). ` +
    'Reclama, no lee: puede correr a la vez en varias réplicas (con el cronómetro, cuando un tick se repite al vencer su arriendo), y la lista son SOLO los candidatos que ESTA se llevó. La marca va en reconciliation_claim, confirmada antes de volver, así que las demás réplicas dejan de verlos; y CADUCA (claim-timeout-ms), porque sobrevive también a la réplica que muera con el candidato en vuelo. ' +
    'No recibe el lote: los tres números —umbral, caducidad y cota— salen de config/parameters/<perfil>/reconciliation.yaml y los lee el adaptador. No cambia el estado. Actúa sobre lo que devuelve FUERA de esta llamada. ' +
    'Confirma en SU PROPIA transacción, así que no corre dentro de otra: la tarea del reloj despacha su operación con application.WithoutTransaction, y llamarlo con una transacción abierta devuelve un error en vez de unirse a ella.'
  );
}

/** Parte una prosa larga en líneas de comentario legibles (el docComment las prefija con `// `). */
function wrap(text, width = 110) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/** Los métodos de reclamo de reconciliación del puerto `<Raíz>Repository`, como [doc, firma]. */
export function portReconciliationMethods(model, entity) {
  return claimsFor(model, entity.name).map((claim) => [wrap(describe(claim)), `${reconciliationMethod(claim)}(ctx context.Context) ([]*${entity.name}, error)`]);
}

/** Lo que el adaptador de una raíz recibe para reclamar: los barridos de reconciliación del perfil. */
export function reconciliationDependencies(model, entity) {
  if (claimsFor(model, entity.name).length === 0) return [];
  return [{ field: 'reconciliation', type: 'ReconciliationSettings', arg: 'reconciliation' }];
}

/** La lectura de los candidatos de un reclamo, con sus argumentos en orden. La comparten el adaptador y las sondas. */
export function reconciliationCandidates(model, entity, claim) {
  const d = sqlDialect(model);
  const q = (column) => d.quote(column);
  const p = d.param;
  const states = claim.states.map((state) => `'${storedStateOf(model, entity, state)}'`).join(', ');
  const idColumn = q(snakeCase(entity.idField?.name ?? 'id'));
  const awaiting = q(snakeCase(claim.awaitingField));
  return {
    sql:
      `SELECT e.${idColumn} FROM ${q(entity.tableName)} e WHERE e.${q(snakeCase(entity.lifecycle.field))} IN (${states}) AND e.${awaiting} < ${p(1)} ` +
      `AND NOT EXISTS (SELECT 1 FROM ${RECONCILIATION_CLAIM.table} c WHERE c.activation = '${claim.activation}' AND c.entity_id = e.${idColumn} AND c.claimed_at > ${p(2)}) ` +
      `ORDER BY e.${awaiting} LIMIT ${p(3)} FOR UPDATE OF e SKIP LOCKED`,
    args: ['unansweredBefore', 'claimExpiredBefore', 'window.BatchSize'],
    reload: `WHERE ${idColumn} = ${p(1)}`
  };
}

/** El valor GUARDADO de un estado: la constante de su enum (como claim.js). */
function storedStateOf(model, entity, state) {
  const enumDef = (model.enums ?? []).find((candidate) => candidate.name === entity.lifecycle?.enumType);
  return enumDef?.values.find((value) => value.literal === state)?.constant ?? screamingSnake(state);
}

/** Los métodos de reclamo de reconciliación del adaptador, sobre `load` y las transacciones del propio adaptador. */
export function adapterReconciliationMethods(model, entity, type) {
  const idType = entity.idField?.goType ?? 'uuid.UUID';
  return claimsFor(model, entity.name).map((claim) => {
    const method = reconciliationMethod(claim);
    const candidates = reconciliationCandidates(model, entity, claim);
    return `// ${method} implementa domain.${entity.name}Repository (reconciliación).
func (r *${type}) ${method}(ctx context.Context) ([]*domain.${entity.name}, error) {
	if err := ownTransaction(ctx, ${goString(method)}); err != nil {
		return nil, err
	}
	window := r.reconciliation.Windows[${goString(claim.activation)}]
	// Los dos cortes, sobre el MISMO instante: lleva demasiado sin desenlace, y el reclamo ajeno ya caducó.
	now := time.Now().UTC()
	unansweredBefore := now.Add(-window.UnansweredAfter())
	claimExpiredBefore := now.Add(-window.ClaimTimeout())
	var claimed []*domain.${entity.name}
	err := r.tx.fresh(ctx, claimOptions, func(ctx context.Context, q DBTX) error {
		// Un conflicto transitorio repite la transacción entera: lo reclamado en el intento fallido se revirtió.
		claimed = nil
		// Los candidatos, el que más lleva primero. SKIP LOCKED reparte entre réplicas; quién se queda cada uno lo decide
		// la marca de abajo, no esta consulta. El estado NO se toca. Los que ya tienen una marca VIVA no son candidatos:
		// sin excluirlos, la cabeza de la cola —reclamada y aún sin resolver— ocuparía el lote de cada pasada hasta
		// caducar, y los que esperan detrás no se reconciliarían antes.
		ids, err := claimCandidates[${idType}](ctx, q, ${goString(candidates.sql)}, ${candidates.args.join(', ')})
		if err != nil {
			return err
		}
		for _, id := range ids {
			// true = la marca es mía; false = otra réplica la tiene y aún no ha caducado.
			won, err := claimReconciliation(ctx, q, ${goString(claim.activation)}, id, now, claimExpiredBefore)
			if err != nil {
				return err
			}
			if !won {
				continue
			}
			found, err := r.load(ctx, ${goString(candidates.reload)}, id)
			if err != nil {
				return err
			}
			claimed = append(claimed, found...)
		}
${sweepPassSignal(model, claim, 'len(ids)', 'window.BatchSize', '		')}		return nil
	})
	if err != nil {
		return nil, err
	}
	return claimed, nil
}`;
  });
}
