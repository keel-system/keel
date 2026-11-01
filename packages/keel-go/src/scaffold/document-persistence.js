// La persistencia DOCUMENTAL en ejecución (incremento 12): la conexión del perfil, los índices que el servidor crea al
// arrancar, la transacción del caso de uso, la traducción de los errores del motor y los valores BSON del contrato. Los
// adaptadores de repositorio (document-repositories.js) y los almacenes del generador (document-stores.js) escriben
// sobre esto.
//
// Emite los MISMOS nombres que la rama relacional (persistence-runtime.js) en su propio paquete
// (`internal/infrastructure/mongo`): Settings, SettingsFrom, Open, Transactions con Within, el traductor `translate` y
// los constructores New<Raíz>Repository. El arranque, los casos de uso y el borde HTTP solo cambian dos líneas (qué abre
// la conexión y qué crea el esquema). Lo de dentro es lo que hacen keel-spring, keel-nest y keel-dotnet sobre el mismo
// diseño:
//   · `DB_URL` es la URI de MongoDB de keel-spring tal cual —el mismo `.env` sirve a los cuatro servidores—;
//   · el agregado es el documento (keel-core/gen/document.js): las hijas anidadas, un value object como subdocumento,
//     decimal como Decimal128 con su escala, uuid como binario de subtipo 4, el instante al milisegundo, el día a
//     medianoche UTC, el enum por su CONSTANTE. El mapeo lo escribe build campo a campo sobre bson.D y bson.Raw: el
//     mapeo por reflexión del driver decidiría nombres y representaciones por su cuenta;
//   · las transacciones multidocumento solo existen sobre un replica set, que es como arranca infra/ también en local.
//     Dos transacciones sobre el mismo documento no se esperan: la segunda aborta con un WriteConflict transitorio
//     (112, TransientTransactionError), que se arregla repitiendo la transacción ENTERA hasta WRITE_CONFLICT_ATTEMPTS
//     (keel-core/gen/transactions.js); agotado, es el 409 de concurrencia. No se usa el WithTransaction del driver, que
//     reintentaría durante dos minutos;
//   · los índices los crea el servidor al ARRANCAR, con los nombres de keel-core: el traductor de errores encuentra el
//     `code` declarado buscando ese nombre en el mensaje E11000;
//   · no hay tope de transacción ni 503: keel-spring no lo aplica en Mongo, y la transacción tiene el límite de vida del
//     servidor.
//
// La sesión de la transacción viaja en el contexto (mongo.NewSessionContext): un repositorio que recibe ese contexto se
// une a la transacción sin verla, como la propagación por defecto de Spring. Lo que tiene que confirmar APARTE (el relay
// del outbox, la guarda de un mensaje, un reclamo) usa `outside(ctx)`, que la quita.

import { CONCURRENT_MODIFICATION_MESSAGE, UNKNOWN_INTEGRITY_MESSAGE, constraintErrors, declaredConcurrencyError } from '@keel-system/keel-core/gen/constraint-errors';
import { WRITE_CONFLICT_ATTEMPTS } from '@keel-system/keel-core/gen/transactions';
import { documentIndexes, exportIndexesScript } from '@keel-system/keel-core/gen/document';
import { localMongoUrl } from '@keel-system/keel-core/gen/infra-catalog';
import { envFor } from '@keel-system/keel-core/gen/runtime-env';
import { usesDocument } from '@keel-system/keel-core/gen/features';
import { alignRows, goString } from '../lib/go-source.js';
import { sentinelOf } from './errors.js';
import { layout, packageFile } from './render.js';
import { usesBestEffort } from './messaging.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

/** El driver se importa con otro nombre: su paquete se llama como el del adaptador. */
export const MONGO_DRIVER = { path: 'go.mongodb.org/mongo-driver/v2/mongo', name: 'mongodriver' };
export const BSON = 'go.mongodb.org/mongo-driver/v2/bson';
export const MONGO_OPTIONS = 'go.mongodb.org/mongo-driver/v2/mongo/options';
const READPREF = 'go.mongodb.org/mongo-driver/v2/mongo/readpref';

/** La pieza que crea los índices y la que traduce sus violaciones, como las nombra export-indexes.sh. */
const PLATFORM = { indexCreator: 'indexes.go (EnsureIndexes)', errorTranslator: 'traductor de errores.go' };

export { usesDocument };

const TRANSACTIONS_TEST = `
// La marca de application.WithoutTransaction la aplica Within UNA vez, quitando del contexto la transacción del llamante;
// la que el caso de uso abra después bajo la marca (la del Save de un repositorio) es suya, y tienen que verla su outbox y
// sus ganchos de confirmación. Corrida 12e: openTx miraba también la marca, y el outbox del envío que despacha un barrido
// no encontraba la transacción del Save.
func TestSinTransaccionOcultaLaDelLlamanteYVeLaSuya(t *testing.T) {
	caller := context.WithValue(t.Context(), txKey{}, &txState{})
	err := (&Transactions{}).Within(application.WithoutTransaction(caller), application.KindCommand, func(ctx context.Context) error {
		if openTx(ctx) != nil {
			t.Error("el caso de uso despachado sin transacción ve la del llamante")
		}
		if openTx(context.WithValue(ctx, txKey{}, &txState{})) == nil {
			t.Error("la transacción de una escritura abierta bajo la marca no se ve: el outbox de su Save no la encontraría")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
`;

export function generate(model) {
  if (!usesDocument(model)) return [];
  const { store } = layout(model);
  const dbName = model.service.name.replace(/-/g, '_');
  return [
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/db.yaml`, content: dbYaml(profile, dbName) })),
    {
      path: `${store.dir}/doc.go`,
      content: packageFile(model, store, {
        doc: `Package ${store.name} es el adaptador de MongoDB del servicio: la conexión, los índices que crea al arrancar, los\nrepositorios (el agregado es el documento), la transacción del caso de uso y la traducción de los errores del motor.\nImplementa los puertos del dominio y el application.Transactor.`,
        body: ''
      })
    },
    { path: `${store.dir}/database.go`, content: packageFile(model, store, { imports: ['context', 'errors', 'fmt', 'log/slog', 'strings', 'time', MONGO_DRIVER, BSON, MONGO_OPTIONS, 'internal/platform/config'], body: databaseBody(model) }) },
    { path: `${store.dir}/indexes.go`, content: packageFile(model, store, { imports: ['context', 'fmt', 'log/slog', MONGO_DRIVER, BSON, MONGO_OPTIONS], body: indexesBody(model) }) },
    {
      path: `${store.dir}/transactions.go`,
      content: packageFile(model, store, { imports: ['context', 'errors', 'log/slog', 'time', MONGO_DRIVER, MONGO_OPTIONS, READPREF, 'internal/application'], body: transactionsBody(model) })
    },
    // INTERNA al paquete (no `mongo_test`): mide openTx y la clave de la transacción, que no se exportan.
    { path: `${store.dir}/transactions_test.go`, content: packageFile(model, store, { imports: ['context', 'testing', 'internal/application'], body: TRANSACTIONS_TEST }) },
    { path: `${store.dir}/errors.go`, content: packageFile(model, store, { imports: ['errors', 'strings', MONGO_DRIVER, 'internal/domain'], body: errorsBody(model) }) },
    {
      path: `${store.dir}/bson_values.go`,
      content: packageFile(model, store, { imports: ['encoding/json/jsontext', 'errors', 'fmt', 'math', 'time', 'github.com/google/uuid', BSON, 'internal/platform/wire'], body: bsonValuesBody() })
    },
    { path: 'infra/export-indexes.sh', content: exportIndexesScript(model, PLATFORM) }
  ];
}

// ─── Configuración ───────────────────────────────────────────────────────────────────────────────

function dbYaml(profile, dbName) {
  if (profile === 'test') {
    return `# El perfil test no tiene base de datos: las pruebas de build arrancan sin infraestructura, y un
# repositorio usado aquí falla diciéndolo. Los documentos contra un MongoDB real los juzga doc-check.
database:
  enabled: false
`;
  }
  return `database:
  # La URI de MongoDB de keel-spring vale tal cual: el mismo .env sirve para los cuatro servidores del diseño. Toda la
  # configuración de la conexión viaja en ella (credenciales, replica set o conexión directa).
  url: ${envFor('DB_URL', profile, localMongoUrl(dbName))}
  # Los índices los crea el servidor al arrancar, derivados enteros de persistence.keel.yaml y con los nombres del
  # diseño (internal/infrastructure/mongo/indexes.go). Verificarlos contra los vivos: bash infra/export-indexes.sh.
`;
}

// ─── database.go ─────────────────────────────────────────────────────────────────────────────────

function databaseBody(model) {
  return `
// connectTimeout es cuánto espera el arranque a que el replica set conteste: sin base, el servicio no arranca, y antes
// de decirlo no se queda esperando el medio minuto por defecto del driver.
const connectTimeout = 10 * time.Second

// Settings es la conexión a la base de datos del perfil (config/parameters/<perfil>/db.yaml).
type Settings struct {
	// Enabled es false en el perfil test: el servicio arranca sin base, y un repositorio usado falla diciéndolo.
	Enabled bool
	// URL es la URI de MongoDB de keel-spring (mongodb://usuario:clave@host:27017/base?…).
	URL string
	// Database es la base del servicio, la de la ruta de la URI.
	Database string
}

// SettingsFrom lee database.* de la configuración del perfil. Una URI que no es de MongoDB, o sin base en su ruta, no
// deja arrancar: conectaría a otra cosa o escribiría en la base «test» del servidor, lejos de la causa.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	if enabled, _ := cfg.Value("database.enabled"); enabled == "false" {
		return Settings{}, nil
	}
	url, _ := cfg.Value("database.url")
	url = strings.TrimSpace(url)
	if !strings.HasPrefix(url, "mongodb://") && !strings.HasPrefix(url, "mongodb+srv://") {
		return Settings{}, fmt.Errorf("database.url no es una URI de MongoDB: %q (usa mongodb://usuario:clave@host:27017/base)", url)
	}
	name := databaseOf(url)
	if name == "" {
		return Settings{}, fmt.Errorf("database.url no nombra la base del servicio en su ruta: %q", url)
	}
	if err := options.Client().ApplyURI(url).Validate(); err != nil {
		return Settings{}, fmt.Errorf("database.url: %w", err)
	}
	return Settings{Enabled: true, URL: url, Database: name}, nil
}

// databaseOf es la base de la ruta de una URI de MongoDB: lo que va entre la primera barra tras los hosts y las
// opciones. La lista de hosts admite comas, así que no se lee como una URL.
func databaseOf(url string) string {
	rest := url[strings.Index(url, "://")+3:]
	slash := strings.Index(rest, "/")
	if slash < 0 {
		return ""
	}
	path := rest[slash+1:]
	if query := strings.Index(path, "?"); query >= 0 {
		path = path[:query]
	}
	return path
}

// Database es el cliente de MongoDB del proceso (uno: lleva el pool de conexiones) y la base del servicio.
type Database struct {
	client   *mongodriver.Client
	database *mongodriver.Database
}

// Open conecta y comprueba que el servidor contesta: sin base, el servicio no arranca.
func Open(ctx context.Context, s Settings) (*Database, error) {
	// El nombre del servicio en los registros del servidor (db.currentOp): con el de por defecto, dos servicios en el mismo
	// backend no se distinguen.
	client, err := mongodriver.Connect(options.Client().ApplyURI(s.URL).SetAppName(${goString(model.service.name)}).SetServerSelectionTimeout(connectTimeout))
	if err != nil {
		return nil, fmt.Errorf("conectar con la base de datos: %w", err)
	}
	db := &Database{client: client, database: client.Database(s.Database)}
	pingCtx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	if err := db.database.RunCommand(pingCtx, bson.D{{Key: "ping", Value: 1}}).Err(); err != nil {
		return nil, errors.Join(fmt.Errorf("conectar con la base de datos: %w", err), db.Close(ctx))
	}
	return db, nil
}

// Close desconecta el cliente. Se llama al apagar, con el contexto del proceso ya cancelado: la desconexión tiene su
// propio plazo.
func (d *Database) Close(ctx context.Context) error {
	closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), connectTimeout)
	defer cancel()
	return d.client.Disconnect(closeCtx)
}

// Collection es una colección de la base del servicio.
func (d *Database) Collection(name string) *mongodriver.Collection {
	return d.database.Collection(name)
}

// Migrate crea los índices del diseño al arrancar (EnsureIndexes): es el «esquema» de MongoDB. Lleva el nombre de la rama
// relacional para que el arranque no distinga el almacén.
func Migrate(ctx context.Context, db *Database, logger *slog.Logger) error {
	return EnsureIndexes(ctx, db, logger)
}
`;
}

// ─── indexes.go ──────────────────────────────────────────────────────────────────────────────────

/** Un literal Go del valor guardado de un filtro parcial (la constante de un enum, un booleano o un número). */
function filterLiteral(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? `int32(${value})` : String(value);
  return goString(String(value));
}

/** Los índices del servidor como datos: lo que emite indexes.go y lo que relee doc-check. */
export function indexEntries(model) {
  return documentIndexes(model, model.warnings);
}

function indexesBody(model) {
  const entries = indexEntries(model).map(({ collection, specs }) => {
    const models = specs.map((spec) => {
      const keys = spec.paths.map((path) => `{Key: ${goString(path)}, Value: 1}`).join(', ');
      const options = [`SetName(${goString(spec.name)})`];
      if (spec.unique) options.push('SetUnique(true)');
      if (spec.partialFilter) options.push(`SetPartialFilterExpression(bson.D{{Key: ${goString(spec.partialFilter.path)}, Value: ${filterLiteral(spec.partialFilter.equals)}}})`);
      return `\t\t{Keys: bson.D{${keys}}, Options: options.Index().${options.join('.')}},`;
    });
    return `\t${goString(collection)}: {\n${models.join('\n')}\n\t},`;
  });
  return `
// collectionIndexes son los índices de cada colección del servicio, derivados de persistence.keel.yaml (clave natural,
// campos únicos e índices declarados, con su filtro parcial si el diseño los condiciona al estado) y de los almacenes del
// generador. Son los MISMOS, con los MISMOS nombres, que crean los servidores de keel-spring, keel-nest y keel-dotnet del
// diseño (keel-core/gen/document.js): el traductor de errores encuentra el code declarado buscando el nombre uk_* en el
// mensaje E11000 del motor.
var collectionIndexes = map[string][]mongodriver.IndexModel{${entries.length > 0 ? `\n${entries.join('\n')}\n` : ''}}

// EnsureIndexes crea los índices al ARRANCAR y fuera de toda transacción. Crear uno que ya existe igual no hace nada; si
// cambia de forma hay que borrarlo antes (bash infra/reset-db.sh --schema): el motor rechaza recrear el mismo nombre con
// otras claves, y el arranque falla diciéndolo. Verificarlos contra los vivos: bash infra/export-indexes.sh.
func EnsureIndexes(ctx context.Context, db *Database, logger *slog.Logger) error {
	created := 0
	for collection, indexes := range collectionIndexes {
		if _, err := db.Collection(collection).Indexes().CreateMany(ctx, indexes); err != nil {
			return fmt.Errorf("crear los índices de %s: %w", collection, err)
		}
		created += len(indexes)
	}
	logger.InfoContext(ctx, "índices asegurados", "indexes", created)
	return nil
}
`;
}

// ─── transactions.go ─────────────────────────────────────────────────────────────────────────────

function transactionsBody(model) {
  const afterCommit = usesBestEffort(model);
  const hooks = afterCommit
    ? `

// afterCommit ejecuta fn cuando confirma la transacción abierta en ctx, o ya si no hay ninguna (la escritura que acaba de
// terminar confirmó la suya). Si la transacción aborta, fn no se ejecuta.
func (t *Transactions) afterCommit(ctx context.Context, fn func(context.Context)) {
	if state := openTx(ctx); state != nil {
		state.pending = append(state.pending, fn)
		return
	}
	fn(ctx)
}`
    : '';
  return `
// writeConflictAttempts son los intentos de una transacción de escritura que pierde un conflicto transitorio
// (keel-core/gen/transactions.js).
const writeConflictAttempts = ${WRITE_CONFLICT_ATTEMPTS}

// conflictPause es la pausa entre dos intentos de una transacción que perdió un conflicto, multiplicada por el intento.
const conflictPause = 25 * time.Millisecond

// errDisabled es lo que devuelve un repositorio en un perfil sin base de datos (database.enabled: false).
var errDisabled = errors.New("la base de datos no está configurada en este perfil (database.enabled: false)")

// txState es la transacción abierta en el contexto${afterCommit ? ', con lo que espera a que confirme' : ''}.
type txState struct${afterCommit ? ' {\n\tpending []func(context.Context)\n}' : '{}'}

// txKey es la clave de la transacción abierta en el contexto.
type txKey struct{}

// Transactions abre la transacción de cada caso de uso sobre una sesión de MongoDB y la deja en el contexto, donde la
// encuentran los repositorios. Con la persistencia, es el application.Transactor del servicio.
//
// Las transacciones multidocumento solo existen sobre un replica set (infra/ lo arranca así incluso en local): es lo que
// hace que el documento del agregado y lo que se escribe con él (el outbox, el registro de idempotencia) confirmen juntos.
type Transactions struct {
	db     *Database
	logger *slog.Logger
}

var _ application.Transactor = (*Transactions)(nil)

// NewTransactions construye las transacciones sobre la base. Con db nil (el perfil test), todo lo que necesite la base
// falla con errDisabled.
func NewTransactions(db *Database, logger *slog.Logger) *Transactions {
	return &Transactions{db: db, logger: logger}
}

// Within implementa application.Transactor: las consultas en una transacción de solo lectura (todas sus lecturas ven el
// mismo instante, en el primario) y los comandos en una de escritura. Un caso de uso despachado con
// application.WithoutTransaction no abre ninguna: cada escritura de sus repositorios es atómica por documento.
func (t *Transactions) Within(ctx context.Context, kind application.MessageKind, fn func(context.Context) error) error {
	if application.TransactionDetached(ctx) {
		return fn(outside(ctx))
	}
	return t.within(ctx, kind == application.KindQuery, fn)
}

// write ejecuta una escritura de un repositorio en la transacción abierta o, sin ella, en una suya.
func (t *Transactions) write(ctx context.Context, fn func(context.Context) error) error {
	return t.within(ctx, false, fn)
}

// collection es una colección de la base, o errDisabled en un perfil sin ella.
func (t *Transactions) collection(name string) (*mongodriver.Collection, error) {
	if t.db == nil {
		return nil, errDisabled
	}
	return t.db.Collection(name), nil
}

// openTx es la transacción abierta en ctx, o nil. No mira la marca de application.WithoutTransaction: Within ya quitó la
// del llamante (outside), y una que se abra después bajo la marca es la del Save de un repositorio, que su outbox tiene que
// encontrar.
func openTx(ctx context.Context) *txState {
	state, _ := ctx.Value(txKey{}).(*txState)
	return state
}

// outside es ctx sin la transacción abierta ni su sesión: lo que tiene que confirmar APARTE del caso de uso (el relay del
// outbox, la guarda de un mensaje, un reclamo) va con él, y cada operación es atómica por documento.
func outside(ctx context.Context) context.Context {
	return context.WithValue(mongodriver.NewSessionContext(ctx, nil), txKey{}, (*txState)(nil))
}

// within ejecuta fn en la transacción ABIERTA si la hay (se une a ella) o en una nueva, que confirma si fn termina bien y
// aborta si no. Un conflicto transitorio repite la transacción nueva entera; los errores del motor salen ya traducidos al
// contrato.
func (t *Transactions) within(ctx context.Context, readOnly bool, fn func(context.Context) error) error {
	if openTx(ctx) != nil {
		return translate(fn(ctx))
	}
	if t.db == nil {
		return errDisabled
	}
	for attempt := 1; ; attempt++ {
		err := t.once(ctx, readOnly, fn)
		if err == nil || readOnly || !transient(err) {
			return translate(err)
		}
		if attempt == writeConflictAttempts {
			return translate(errors.Join(errConflictExhausted, err))
		}
		t.logger.WarnContext(ctx, "conflicto de escritura transitorio: se repite la transacción", "attempt", attempt)
		// MongoDB no hace esperar al perdedor (el motor relacional sí, con su bloqueo): sin una pausa, el reintento puede
		// llegar antes de que el ganador confirme, chocar otra vez y agotar los intentos en microsegundos.
		pause := time.NewTimer(time.Duration(attempt) * conflictPause)
		select {
		case <-ctx.Done():
			pause.Stop()
			return ctx.Err()
		case <-pause.C:
		}
	}
}

// once es un intento: abre la sesión y la transacción, ejecuta y confirma; cualquier fallo aborta.
func (t *Transactions) once(ctx context.Context, readOnly bool, fn func(context.Context) error) error {
	session, err := t.db.client.StartSession()
	if err != nil {
		return err
	}
	defer session.EndSession(context.WithoutCancel(ctx))
	transaction := options.Transaction()
	if readOnly {
		transaction.SetReadPreference(readpref.Primary())
	}
	if err := session.StartTransaction(transaction); err != nil {
		return err
	}
	state := &txState{}
	if err := fn(context.WithValue(mongodriver.NewSessionContext(ctx, session), txKey{}, state)); err != nil {
		// Abortar es lo que pide el fallo; si abortar también falla, el servidor la descarta al caducar la transacción, y
		// el error que importa es el de fn.
		_ = session.AbortTransaction(context.WithoutCancel(ctx))
		return err
	}
	if err := session.CommitTransaction(ctx); err != nil {
		return err
	}${afterCommit ? `
	for _, hook := range state.pending {
		hook(ctx)
	}` : ''}
	return nil
}${hooks}

// transient dice si err es un conflicto de escritura transitorio: dos transacciones tocaron el mismo documento y el motor
// abortó a esta en vez de hacerla esperar. Repetida, ve lo que la otra confirmó.
func transient(err error) bool {
	var server mongodriver.ServerError
	return errors.As(err, &server) && (server.HasErrorLabel("TransientTransactionError") || server.HasErrorCode(112))
}
`;
}

// ─── errors.go ───────────────────────────────────────────────────────────────────────────────────

function errorsBody(model) {
  // En el documento no hay claves ajenas: solo unicidad. Un índice único declarado sobre un campo `unique` es el MISMO
  // índice (keel-core no lo crea dos veces): gana la entrada que lleva el error que el diseño le da.
  const byIndex = new Map();
  for (const entry of constraintErrors(model).filter((candidate) => !candidate.reference)) {
    const name = entry.constraint.toLowerCase();
    if (!byIndex.has(name) || (entry.declared && !byIndex.get(name).declared)) byIndex.set(name, entry);
  }
  const entries = [...byIndex.values()];
  const concurrency = declaredConcurrencyError(model);
  const concurrencySentinel = concurrency ? sentinelOf(concurrency.code) : 'ErrConcurrentModification';
  const build = (declared, code, message) => {
    if (declared?.dynamicStatus) return `domain.StatusErrorf(domain.${sentinelOf(declared.code)}, 409, ${goString(message)})`;
    return `domain.Errorf(domain.${sentinelOf(declared ? declared.code : code)}, ${goString(message)})`;
  };
  const rows = [];
  for (const entry of entries) {
    const why = entry.raceOnly ? `unicidad de ${entry.entity}.${entry.fields.join(', ')}: solo una carrera la rompe` : `unicidad de ${entry.entity}.${entry.fields.join(', ')}`;
    rows.push({ text: `\t// ${why}.` });
    rows.push({ indent: '\t', cells: [`${goString(entry.constraint.toLowerCase())}:`, `${build(entry.declared, entry.code, entry.message)},`] });
  }
  return `
// errStaleVersion es el guardado con versión que no casó con ningún documento: otra escritura ganó entre la lectura y el
// guardado (o borró el agregado).
var errStaleVersion = errors.New("la versión del agregado cambió desde que se leyó")

// errConflictExhausted es un conflicto de escritura transitorio que agotó sus reintentos.
var errConflictExhausted = errors.New("conflicto de escritura concurrente tras agotar los reintentos")

// indexErrors traduce cada índice único con nombre al error del contrato. Los nombres los pone keel-core/gen/document.js y
// el error, con su mensaje, keel-core/gen/constraint-errors.js: los cuatro servidores del diseño responden lo mismo a la
// misma violación.
var indexErrors = map[string]error{${rows.length > 0 ? `\n${alignRows(rows).join('\n')}\n` : ''}}

// translate traduce un fallo de la persistencia al contrato: versión obsoleta o conflicto agotado → el 409 de
// concurrencia; violación de un índice único conocido → su error; de uno desconocido (el _id) → 409 sin code. Lo demás (y
// los errores del dominio) pasa tal cual.
func translate(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, errStaleVersion) || errors.Is(err, errConflictExhausted) {
		return domain.Errorf(domain.${concurrencySentinel}, ${goString(CONCURRENT_MODIFICATION_MESSAGE)})
	}
	if !mongodriver.IsDuplicateKeyError(err) {
		return err
	}
	if known := indexIn(err.Error()); known != nil {
		return known
	}
	return domain.Errorf(domain.ErrIntegrityViolation, ${goString(UNKNOWN_INTEGRITY_MESSAGE)})
}

// indexIn es el error del índice conocido que nombra el mensaje E11000 del motor («… index: uk_jobs_natural dup key: …»),
// o nil. Con su delimitador: uk_jobs_natural no puede casar dentro de uk_jobs_natural_x.
func indexIn(message string) error {
	text := strings.ToLower(message)
	for name, known := range indexErrors {
		at := strings.Index(text, "index: "+name)
		end := at + len("index: "+name)
		if at >= 0 && (end == len(text) || text[end] == ' ') {
			return known
		}
	}
	return nil
}
`;
}

// ─── bson_values.go ──────────────────────────────────────────────────────────────────────────────

function bsonValuesBody() {
  return `
// Los valores entre el dominio y el documento, con la representación física del contrato (keel-core/gen/document.js), la
// que escriben y leen también los servidores de keel-spring, keel-nest y keel-dotnet del mismo diseño:
//   - uuid como binario de subtipo 4 (estándar), no el subtipo 3 heredado ni texto;
//   - decimal como Decimal128 con su escala (2.50 sigue siendo 2.50), nunca un double;
//   - un instante como fecha BSON (milisegundos desde la época, en UTC);
//   - una fecha sin hora como la medianoche UTC de ese día: el día no tiene zona;
//   - un json embebido como su texto, y un enum por el NOMBRE de su constante.
// Escribir es estricto; leer acepta lo que otro cliente pudo escribir sin cambiar el valor (un entero de 32 bits donde se
// espera uno de 64). Un null donde el dominio no lo admite es un dato roto: el error dice qué campo.

// errMissing es un campo null (o ausente) que el dominio no admite.
var errMissing = errors.New("es null y el dominio no lo admite")

// unexpected es un campo que guarda otro tipo BSON del que pide el contrato.
func unexpected(v bson.RawValue, want string) error {
	return fmt.Errorf("guarda %s y el contrato pide %s", v.Type, want)
}

// isNull dice si un valor es null o falta.
func isNull(v bson.RawValue) bool {
	return v.Type == 0 || v.Type == bson.TypeNull || v.Type == bson.TypeUndefined
}

// get lee key de doc con read. Un campo ausente se lee como null; el error lleva el nombre del campo delante.
func get[T any](doc bson.Raw, key string, read func(bson.RawValue) (T, error)) (T, error) {
	v, err := doc.LookupErr(key)
	if err != nil {
		v = bson.RawValue{Type: bson.TypeNull}
	}
	out, err := read(v)
	if err != nil {
		var zero T
		return zero, fmt.Errorf("%s: %w", key, err)
	}
	return out, nil
}

// optional lee con read un valor que puede ser null: nil si lo es.
func optional[T any](read func(bson.RawValue) (T, error)) func(bson.RawValue) (*T, error) {
	return func(v bson.RawValue) (*T, error) {
		if isNull(v) {
			return nil, nil
		}
		out, err := read(v)
		if err != nil {
			return nil, err
		}
		return &out, nil
	}
}

// asUUID lee un uuid: binario de subtipo 4.
func asUUID(v bson.RawValue) (uuid.UUID, error) {
	if isNull(v) {
		return uuid.UUID{}, errMissing
	}
	subtype, data, ok := v.BinaryOK()
	if !ok || subtype != bson.TypeBinaryUUID || len(data) != 16 {
		return uuid.UUID{}, unexpected(v, "un uuid (binario de subtipo 4)")
	}
	return uuid.FromBytes(data)
}

// asText lee un texto.
func asText(v bson.RawValue) (string, error) {
	if isNull(v) {
		return "", errMissing
	}
	text, ok := v.StringValueOK()
	if !ok {
		return "", unexpected(v, "un texto")
	}
	return text, nil
}

// asInt32 lee un entero de 32 bits (también de un Int64 que cabe).
func asInt32(v bson.RawValue) (int32, error) {
	if isNull(v) {
		return 0, errMissing
	}
	if n, ok := v.Int32OK(); ok {
		return n, nil
	}
	if n, ok := v.Int64OK(); ok && n >= math.MinInt32 && n <= math.MaxInt32 {
		return int32(n), nil
	}
	return 0, unexpected(v, "un entero de 32 bits")
}

// asInt64 lee un entero de 64 bits (también de un Int32).
func asInt64(v bson.RawValue) (int64, error) {
	if isNull(v) {
		return 0, errMissing
	}
	if n, ok := v.Int64OK(); ok {
		return n, nil
	}
	if n, ok := v.Int32OK(); ok {
		return int64(n), nil
	}
	return 0, unexpected(v, "un entero de 64 bits")
}

// asBool lee un booleano.
func asBool(v bson.RawValue) (bool, error) {
	if isNull(v) {
		return false, errMissing
	}
	flag, ok := v.BooleanOK()
	if !ok {
		return false, unexpected(v, "un booleano")
	}
	return flag, nil
}

// asDecimal lee un decimal EXACTO de un Decimal128, con su escala (también de un entero).
func asDecimal(v bson.RawValue) (wire.Decimal, error) {
	if isNull(v) {
		return wire.Decimal{}, errMissing
	}
	if d, ok := v.Decimal128OK(); ok {
		return wire.ParseDecimal(d.String())
	}
	if n, ok := v.AsInt64OK(); ok && v.Type != bson.TypeDouble {
		return wire.NewDecimal(n, 0), nil
	}
	return wire.Decimal{}, unexpected(v, "un Decimal128")
}

// asInstant lee un instante de una fecha BSON, en UTC.
func asInstant(v bson.RawValue) (time.Time, error) {
	if isNull(v) {
		return time.Time{}, errMissing
	}
	ms, ok := v.DateTimeOK()
	if !ok {
		return time.Time{}, unexpected(v, "una fecha BSON")
	}
	return time.UnixMilli(ms).UTC(), nil
}

// asDay lee un día de la fecha BSON de su medianoche UTC.
func asDay(v bson.RawValue) (wire.Date, error) {
	instant, err := asInstant(v)
	if err != nil {
		return wire.Date{}, err
	}
	return wire.DateOf(instant), nil
}

// asJSON lee un json embebido de su texto.
func asJSON(v bson.RawValue) (jsontext.Value, error) {
	text, err := asText(v)
	if err != nil {
		return nil, err
	}
	return jsontext.Value(text), nil
}

// asEnum lee un enum por el nombre de su constante, con parse.
func asEnum[T any](parse func(string) (T, error)) func(bson.RawValue) (T, error) {
	return func(v bson.RawValue) (T, error) {
		text, err := asText(v)
		if err != nil {
			var zero T
			return zero, err
		}
		return parse(text)
	}
}

// asSub lee un subdocumento (un value object o una entidad anidada) con decode.
func asSub[T any](decode func(bson.Raw) (T, error)) func(bson.RawValue) (T, error) {
	return func(v bson.RawValue) (T, error) {
		var zero T
		if isNull(v) {
			return zero, errMissing
		}
		doc, ok := v.DocumentOK()
		if !ok {
			return zero, unexpected(v, "un subdocumento")
		}
		return decode(doc)
	}
}

// asList lee un array en su orden; null o ausente es una lista vacía (una lista nunca es null).
func asList[T any](read func(bson.RawValue) (T, error)) func(bson.RawValue) ([]T, error) {
	return func(v bson.RawValue) ([]T, error) {
		if isNull(v) {
			return nil, nil
		}
		array, ok := v.ArrayOK()
		if !ok {
			return nil, unexpected(v, "un array")
		}
		values, err := array.Values()
		if err != nil {
			return nil, err
		}
		out := make([]T, 0, len(values))
		for i, element := range values {
			item, err := read(element)
			if err != nil {
				return nil, fmt.Errorf("[%d]: %w", i, err)
			}
			out = append(out, item)
		}
		return out, nil
	}
}

// uuidValue escribe un uuid como binario de subtipo 4.
func uuidValue(id uuid.UUID) bson.Binary {
	return bson.Binary{Subtype: bson.TypeBinaryUUID, Data: id[:]}
}

// instantValue escribe un instante como fecha BSON: el milisegundo, la precisión de keel-spring y keel-nest.
func instantValue(t time.Time) bson.DateTime {
	return bson.NewDateTimeFromTime(t)
}

// dayValue escribe un día como la medianoche UTC de ese día.
func dayValue(d wire.Date) bson.DateTime {
	return bson.NewDateTimeFromTime(d.Time())
}

// jsonValue escribe un json embebido como su texto, tal cual llegó.
func jsonValue(v jsontext.Value) string {
	return string(v)
}

// orNull escribe un opcional: null si no hay valor, o el valor escrito con write.
func orNull[T any](value *T, write func(T) any) any {
	if value == nil {
		return nil
	}
	return write(*value)
}

// each escribe una lista como array, en su orden. Una lista nunca es null: sin elementos es un array vacío.
func each[T any](items []T, write func(T) any) bson.A {
	out := make(bson.A, 0, len(items))
	for _, item := range items {
		out = append(out, write(item))
	}
	return out
}

// encoder escribe un documento y recoge el primer valor que no cabe en su representación: un decimal de más de 34
// dígitos no tiene Decimal128.
type encoder struct {
	err error
}

// decimal escribe un decimal como Decimal128 con su escala.
func (e *encoder) decimal(d wire.Decimal) any {
	value, err := bson.ParseDecimal128(d.String())
	if err != nil {
		e.err = errors.Join(e.err, fmt.Errorf("el decimal %s no cabe en un Decimal128: %w", d, err))
		return nil
	}
	return value
}
`;
}
