// Lo que hace funcionar la persistencia relacional en el servidor: la conexión del perfil, las migraciones de goose al
// arrancar, la transacción del caso de uso y la traducción de los errores del motor al contrato. Los repositorios
// (repositories.js) escriben el SQL sobre esto.
//
//   · config/parameters/<perfil>/db.yaml — las MISMAS claves y variables que keel-nest y keel-dotnet (la URL JDBC de
//     keel-spring vale tal cual: el mismo .env sirve para los cuatro servidores del diseño). En `test` no hay base;
//   · database.go — Settings, Open (pgx o go-sql-driver sobre database/sql) y Migrate (goose, con las migraciones
//     embebidas);
//   · transactions.go — la transacción del caso de uso viaja en el contexto y los repositorios se unen a ella sin verla,
//     como la propagación por defecto de Spring. El tope (DB_TRANSACTION_TIMEOUT) es `SET LOCAL statement_timeout` en
//     PostgreSQL y va en la sesión en MySQL (database.go); un interbloqueo (o, en PostgreSQL, un fallo de
//     serialización) se arregla repitiendo la transacción entera, hasta WRITE_CONFLICT_ATTEMPTS
//     (keel-core/gen/transactions.js); un conflicto de versión NO se repite. En MySQL la conexión de los repositorios
//     escribe cada uuid como sus 16 bytes (`bound`, ver src/lib/relational-engine.js);
//   · errors.go — el error del motor traducido por el NOMBRE de la constraint con keel-core/gen/constraint-errors.js, la
//     misma tabla de los otros tres: la misma violación sale con el mismo error y el mismo mensaje. PostgreSQL da el
//     nombre aparte; MySQL solo en el texto del mensaje, y su clave primaria se llama siempre PRIMARY.

import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { envFor } from '@keel-system/keel-core/gen/runtime-env';
import { WRITE_CONFLICT_ATTEMPTS } from '@keel-system/keel-core/gen/transactions';
import {
  CONCURRENT_MODIFICATION_MESSAGE,
  TRANSACTION_TIMEOUT_MESSAGE,
  UNKNOWN_INTEGRITY_MESSAGE,
  constraintErrors,
  declaredConcurrencyError
} from '@keel-system/keel-core/gen/constraint-errors';
import { usesRelational } from '@keel-system/keel-core/gen/features';
import { usesBestEffort, usesGoOutbox, usesGoProcessedEvents } from './messaging.js';
import { persistedMembers } from '@keel-system/keel-core/gen';
import { alignRows, goString } from '../lib/go-source.js';
import { relationalEngine, sqlDialect } from '../lib/relational-engine.js';
import { sentinelOf } from './errors.js';
import { layout, packageFile } from './render.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

/** El driver de MySQL se importa con otro nombre: su paquete se llama como el del adaptador. */
export const MYSQL_DRIVER = { path: 'github.com/go-sql-driver/mysql', name: 'mysqldriver' };

export function generate(model) {
  if (!usesRelational(model)) return [];
  const { store, textfold } = layout(model);
  const d = sqlDialect(model);
  const dbName = model.service.name.replace(/-/g, '_');
  const files = PROFILES.map((profile) => ({ path: `config/parameters/${profile}/db.yaml`, content: dbYaml(model, profile, dbName) }));
  const engineError = d.mysql ? MYSQL_DRIVER : 'github.com/jackc/pgx/v5/pgconn';
  files.push(
    { path: `${store.dir}/database.go`, content: packageFile(model, store, { imports: databaseImports(d), body: databaseBody(d) }) },
    { path: `${store.dir}/transactions.go`, content: packageFile(model, store, { imports: [...TRANSACTION_IMPORTS, engineError, 'github.com/google/uuid'], body: transactionsBody(d, transactionNeeds(model)) }) },
    { path: `${store.dir}/errors.go`, content: packageFile(model, store, { imports: ['errors', 'strings', engineError, 'internal/domain'], body: errorsBody(model, d) }) }
  );
  if (usesTextFold(model)) {
    files.push({ path: `${textfold.dir}/textfold.go`, content: packageFile(model, textfold, { doc: TEXTFOLD_DOC, imports: ['strings', 'unicode', 'golang.org/x/text/unicode/norm'], body: textfoldBody(model) }) });
  }
  return files;
}

/** ¿Guarda alguna entidad una sombra plegada? Entonces hace falta internal/platform/textfold. */
export function usesTextFold(model) {
  return foldKinds(model).size > 0;
}

/** ¿Qué pliegues usa el diseño? `case` (sin mayúsculas) y `accents` (sin mayúsculas ni acentos). */
export function foldKinds(model) {
  const kinds = new Set();
  if (!usesRelational(model)) return kinds;
  for (const entity of model.entities.filter((candidate) => candidate.persisted)) {
    for (const member of persistedMembers(model, entity)) if (member.kind === 'scalar' && member.folded) kinds.add(member.folded.accents ? 'accents' : 'case');
  }
  return kinds;
}

// ─── Configuración ───────────────────────────────────────────────────────────────────────────────

/** La URL de conexión de local: la JDBC que escribe keel-spring para el mismo motor. */
export function localDatabaseUrl(dbName, engine = 'postgresql') {
  return `jdbc:${engine}://localhost:${DATABASES[engine].port}/${dbName}`;
}

function dbYaml(model, profile, dbName) {
  const engine = relationalEngine(model);
  const db = DATABASES[engine];
  if (profile === 'test') {
    return `# El perfil test no tiene base de datos: las pruebas de build arrancan sin infraestructura, y un
# repositorio usado aquí falla diciéndolo. El esquema contra un motor real lo juzga db-check.
database:
  enabled: false
`;
  }
  return `database:
  # La URL JDBC de keel-spring vale tal cual (jdbc:${engine}://host:puerto/base): el mismo .env sirve para los
  # cuatro servidores del diseño.
  url: ${envFor('DB_URL', profile, localDatabaseUrl(dbName, engine))}
  username: ${envFor('DB_USERNAME', profile, db.user(dbName))}
  password: ${envFor('DB_PASSWORD', profile, db.password)}
  pool:
${
    engine === 'mysql'
      ? `    # El nombre de la aplicación (program_name en performance_schema.session_connect_attrs): con el de por defecto,
    # dos servicios en el mismo backend no se distinguen.`
      : `    # El nombre de la aplicación en pg_stat_activity: con el de por defecto, dos servicios en el mismo backend
    # no se distinguen.`
  }
    name: ${model.service.name}-pool
    max-size: ${envFor('DB_POOL_MAX_SIZE', profile)}
    # Cuánto espera el arranque o una conexión nueva a que el motor conteste: fallar rápido en vez de acumular
    # peticiones que el cliente ya abandonó.
    connection-timeout-ms: ${envFor('DB_POOL_CONNECTION_TIMEOUT_MS', profile)}
    # Vida máxima de una conexión: menor que cualquier corte de ociosas entre el servicio y la base.
    max-lifetime-ms: ${envFor('DB_POOL_MAX_LIFETIME_MS', profile)}
  # Tope de cada sentencia de una transacción; lo cancelado sale como 503 TRANSACTION_TIMEOUT.
  transaction-timeout: ${envFor('DB_TRANSACTION_TIMEOUT', profile)}
`;
}

// ─── database.go ─────────────────────────────────────────────────────────────────────────────────

function databaseImports(d) {
  const driver = d.mysql ? [MYSQL_DRIVER] : ['github.com/jackc/pgx/v5', 'github.com/jackc/pgx/v5/stdlib'];
  return ['context', 'database/sql', 'errors', 'fmt', 'io/fs', 'log/slog', 'math', 'net', 'net/url', 'strconv', 'strings', 'time', ...driver, 'github.com/pressly/goose/v3', 'internal/platform/config'];
}

/** La conexión de cada motor: cómo se compone desde la URL de keel-spring y cómo se abre el pool. */
const CONNECTION = {
  postgresql: {
    url: 'jdbc:postgresql://host:puerto/base',
    poolName: 'el nombre de la aplicación en pg_stat_activity',
    timeout: 'el tope de cada sentencia de una transacción',
    check: 's.dsn()',
    build: `
// dsn es la cadena de conexión de pgx compuesta desde la URL y las credenciales.
func (s Settings) dsn() (string, error) {
	u, err := url.Parse(strings.TrimPrefix(s.URL, "jdbc:"))
	if err != nil || (u.Scheme != "postgresql" && u.Scheme != "postgres") || u.Host == "" {
		return "", fmt.Errorf("database.url no es una URL de PostgreSQL: %q", s.URL)
	}
	u.User = url.UserPassword(s.Username, s.Password)
	query := u.Query()
	if s.PoolName != "" {
		query.Set("application_name", s.PoolName)
	}
	// libpq mide en segundos enteros: el tope se redondea hacia arriba.
	query.Set("connect_timeout", strconv.Itoa(int(math.Ceil(s.ConnectionTimeout.Seconds()))))
	u.RawQuery = query.Encode()
	return u.String(), nil
}
`,
    open: `	dsn, err := s.dsn()
	if err != nil {
		return nil, err
	}
	connConfig, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("database.url: %w", err)
	}
	db := stdlib.OpenDB(*connConfig)`,
    goose: 'goose.DialectPostgres',
    serialized: `// nunca el código. Dos réplicas que arrancan a la vez no las aplican dos veces: goose las serializa con su tabla de
// versiones.`
  },
  mysql: {
    url: 'jdbc:mysql://host:puerto/base',
    poolName: 'el program_name de la conexión (performance_schema.session_connect_attrs)',
    timeout: 'el tope de la espera de un bloqueo y de cada lectura, en la sesión de cada conexión',
    check: 's.driverConfig()',
    build: `
// driverConfig es la conexión de go-sql-driver compuesta desde la URL y las credenciales. Cuatro opciones no son las de
// por defecto, y sin ellas el adaptador falla o miente en silencio:
//   - ParseTime y Loc: un datetime(6) se lee como time.Time, en UTC (se guarda en UTC);
//   - ClientFoundRows: un UPDATE cuenta las filas que ENCONTRÓ y no solo las que cambió. Guardar un agregado sin
//     cambios no es «no existe»;
//   - el tope de la transacción va en la sesión, al abrir cada conexión: innodb_lock_wait_timeout (en segundos) para
//     la espera de un bloqueo y max_execution_time para una lectura. MySQL no tiene un tope por sentencia para las
//     escrituras.
func (s Settings) driverConfig() (*mysqldriver.Config, error) {
	u, err := url.Parse(strings.TrimPrefix(s.URL, "jdbc:"))
	if err != nil || u.Scheme != "mysql" || u.Hostname() == "" {
		return nil, fmt.Errorf("database.url no es una URL de MySQL: %q", s.URL)
	}
	cfg := mysqldriver.NewConfig()
	cfg.Net = "tcp"
	cfg.Addr = u.Host
	if u.Port() == "" {
		cfg.Addr = net.JoinHostPort(u.Hostname(), "3306")
	}
	cfg.DBName = strings.TrimPrefix(u.Path, "/")
	cfg.User = s.Username
	cfg.Passwd = s.Password
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.ClientFoundRows = true
	cfg.Timeout = s.ConnectionTimeout
	if s.PoolName != "" {
		cfg.ConnectionAttributes = "program_name:" + s.PoolName
	}
	cfg.Params = map[string]string{
		"time_zone":                "'+00:00'",
		"innodb_lock_wait_timeout": strconv.Itoa(max(1, int(math.Ceil(s.TransactionTimeout.Seconds())))),
		"max_execution_time":       strconv.FormatInt(s.TransactionTimeout.Milliseconds(), 10),
	}
	return cfg, nil
}
`,
    open: `	cfg, err := s.driverConfig()
	if err != nil {
		return nil, err
	}
	connector, err := mysqldriver.NewConnector(cfg)
	if err != nil {
		return nil, fmt.Errorf("database.url: %w", err)
	}
	db := sql.OpenDB(connector)`,
    goose: 'goose.DialectMySQL',
    serialized: `// nunca el código. En MySQL el DDL no es transaccional y goose no toma un bloqueo: dos réplicas que arrancan a la vez
// sobre una base vacía pueden chocar, y la segunda no arranca (su orquestador la reinicia, y entonces ya no falta nada).`
  }
};

function databaseBody(d) {
  const c = CONNECTION[d.engine];
  return `
// Settings es la conexión a la base de datos del perfil (config/parameters/<perfil>/db.yaml).
type Settings struct {
	// Enabled es false en el perfil test: el servicio arranca sin base, y un repositorio usado falla diciéndolo.
	Enabled bool
	// URL es la de keel-spring (${c.url}) o la misma sin jdbc:.
	URL string
	// Username y Password son las credenciales.
	Username string
	Password string
	// PoolName es ${c.poolName}.
	PoolName string
	// MaxSize es el máximo de conexiones abiertas.
	MaxSize int
	// ConnectionTimeout es cuánto espera una conexión nueva a que el motor conteste.
	ConnectionTimeout time.Duration
	// MaxLifetime es la vida máxima de una conexión.
	MaxLifetime time.Duration
	// TransactionTimeout es ${c.timeout}.
	TransactionTimeout time.Duration
}

// SettingsFrom lee database.* de la configuración del perfil. Un valor que no se entiende no deja arrancar.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	if enabled, _ := cfg.Value("database.enabled"); enabled == "false" {
		return Settings{}, nil
	}
	value := func(key string) string {
		v, _ := cfg.Value(key)
		return v
	}
	s := Settings{Enabled: true, URL: value("database.url"), Username: value("database.username"), Password: value("database.password"), PoolName: value("database.pool.name")}
	var errs []error
	size, err := strconv.Atoi(value("database.pool.max-size"))
	if err != nil || size < 1 {
		errs = append(errs, fmt.Errorf("database.pool.max-size inválido: %q", value("database.pool.max-size")))
	}
	s.MaxSize = size
	for _, d := range []struct {
		key    string
		target *time.Duration
	}{
		{"database.pool.connection-timeout-ms", &s.ConnectionTimeout},
		{"database.pool.max-lifetime-ms", &s.MaxLifetime},
		{"database.transaction-timeout", &s.TransactionTimeout},
	} {
		if *d.target, err = config.ToDuration(value(d.key)); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", d.key, err))
		}
	}
	if _, err := ${c.check}; err != nil {
		errs = append(errs, err)
	}
	return s, errors.Join(errs...)
}
${c.build}
// Open abre el pool de conexiones y comprueba que el motor contesta: sin base, el servicio no arranca.
func Open(ctx context.Context, s Settings) (*sql.DB, error) {
${c.open}
	db.SetMaxOpenConns(s.MaxSize)
	db.SetMaxIdleConns(s.MaxSize)
	db.SetConnMaxLifetime(s.MaxLifetime)
	pingCtx, cancel := context.WithTimeout(ctx, s.ConnectionTimeout)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		return nil, errors.Join(fmt.Errorf("conectar con la base de datos: %w", err), db.Close())
	}
	return db, nil
}

// Migrate aplica las migraciones de goose que falten, en todos los perfiles: el esquema lo gobiernan las migraciones,
${c.serialized}
func Migrate(ctx context.Context, db *sql.DB, logger *slog.Logger) error {
	migrations, err := fs.Sub(Migrations, "migrations")
	if err != nil {
		return fmt.Errorf("leer las migraciones embebidas: %w", err)
	}
	provider, err := goose.NewProvider(${c.goose}, db, migrations)
	if err != nil {
		return fmt.Errorf("preparar las migraciones: %w", err)
	}
	results, err := provider.Up(ctx)
	if err != nil {
		return fmt.Errorf("aplicar las migraciones: %w", err)
	}
	logger.InfoContext(ctx, "migraciones aplicadas", "applied", len(results))
	return nil
}
`;
}

// ─── transactions.go ─────────────────────────────────────────────────────────────────────────────

const TRANSACTION_IMPORTS = ['context', 'database/sql', 'errors', 'fmt', 'log/slog', 'time', 'internal/application'];

/** Lo que cambia por motor en transactions.go: el tope, lo transitorio y la conexión que ven los repositorios. */
const TRANSACTION_PLATFORM = {
  postgresql: {
    field: '\tdb               *sql.DB\n\tstatementTimeout string\n\tlogger           *slog.Logger',
    construct: `// NewTransactions construye las transacciones sobre el pool. Con db nil (el perfil test), todo lo que necesite la
// base falla con errDisabled.
func NewTransactions(db *sql.DB, timeout time.Duration, logger *slog.Logger) *Transactions {
	return &Transactions{db: db, statementTimeout: fmt.Sprintf("SET LOCAL statement_timeout = %d", timeout.Milliseconds()), logger: logger}
}`,
    once: 'abre, fija el tope, ejecuta y confirma',
    prologue: `	if _, err = tx.ExecContext(ctx, t.statementTimeout); err != nil {
		return err
	}
`,
    wrap: (expr) => expr,
    transient: `// transient dice si err es un interbloqueo o un fallo de serialización: se arreglan repitiendo la transacción.
func transient(err error) bool {
	var engine *pgconn.PgError
	return errors.As(err, &engine) && (engine.Code == "40P01" || engine.Code == "40001")
}`,
    binding: ''
  },
  mysql: {
    field: '\tdb     *sql.DB\n\tlogger *slog.Logger',
    construct: `// NewTransactions construye las transacciones sobre el pool. Con db nil (el perfil test), todo lo que necesite la
// base falla con errDisabled. El tope no va aquí: en MySQL es de la sesión de cada conexión (Settings.driverConfig).
func NewTransactions(db *sql.DB, _ time.Duration, logger *slog.Logger) *Transactions {
	return &Transactions{db: db, logger: logger}
}`,
    once: 'abre, ejecuta y confirma',
    prologue: '',
    wrap: (expr) => `bound{${expr}}`,
    transient: `// transient dice si err es un interbloqueo (1213): MySQL ya revirtió la transacción entera, y se arregla repitiéndola.
func transient(err error) bool {
	var engine *mysqldriver.MySQLError
	return errors.As(err, &engine) && engine.Number == 1213
}`,
    binding: `

// bound es la conexión que ven los repositorios en MySQL: escribe cada uuid como sus 16 bytes. La columna es
// binary(16) con los bytes EN EL ORDEN DEL TEXTO (los de keel-spring, keel-nest y keel-dotnet), que son los de
// uuid.UUID; pero su Value() es el texto, y sin esto un id se escribiría como 36 caracteres. Leer no lo necesita: Scan
// admite los 16 bytes.
type bound struct {
	inner DBTX
}

// ExecContext implementa DBTX.
func (b bound) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return b.inner.ExecContext(ctx, query, bind(args)...)
}

// QueryContext implementa DBTX.
func (b bound) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return b.inner.QueryContext(ctx, query, bind(args)...)
}

// QueryRowContext implementa DBTX.
func (b bound) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return b.inner.QueryRowContext(ctx, query, bind(args)...)
}

// bind devuelve args con cada uuid (también opcional) como sus 16 bytes, y lo demás tal cual.
func bind(args []any) []any {
	out := make([]any, len(args))
	for i, arg := range args {
		switch v := arg.(type) {
		case uuid.UUID:
			out[i] = v[:]
		case *uuid.UUID:
			if v != nil {
				id := *v
				out[i] = id[:]
			}
		case uuid.NullUUID:
			if v.Valid {
				id := v.UUID
				out[i] = id[:]
			}
		default:
			out[i] = arg
		}
	}
	return out
}`
  }
};

/**
 * Lo que la mensajería pide a la unidad de trabajo (incremento 9), y solo si la usa: `apart`, una transacción PROPIA
 * aunque el contexto traiga otra (el relay del outbox y el registro de procesados), y `afterCommit`, lo que se ejecuta
 * cuando confirma la transacción abierta (la publicación best-effort).
 */
function transactionNeeds(model) {
  return { apart: usesGoOutbox(model) || usesGoProcessedEvents(model), afterCommit: usesBestEffort(model) };
}

function transactionsBody(d, { apart = false, afterCommit = false } = {}) {
  const p = TRANSACTION_PLATFORM[d.engine];
  const hooksType = afterCommit
    ? `

// commitHooks es lo que espera a que confirme la transacción abierta en el contexto.
type commitHooks struct {
	pending []func(context.Context)
}

// hooksKey es la clave de los commitHooks de la transacción abierta en el contexto.
type hooksKey struct{}

// afterCommit ejecuta fn cuando confirma la transacción abierta en ctx, o ya si no hay ninguna (la escritura que acaba
// de terminar confirmó la suya). Si la transacción revierte, fn no se ejecuta.
func (t *Transactions) afterCommit(ctx context.Context, fn func(context.Context)) {
	if hooks, ok := ctx.Value(hooksKey{}).(*commitHooks); ok && openTx(ctx) != nil {
		hooks.pending = append(hooks.pending, fn)
		return
	}
	fn(ctx)
}`
    : '';
  const apartMethod = apart
    ? `

// apart ejecuta fn en una transacción PROPIA aunque ctx traiga una abierta, con sus opciones: lo que se confirma aparte
// del caso de uso (el relay del outbox, el registro de un mensaje procesado).
func (t *Transactions) apart(ctx context.Context, options sql.TxOptions, fn func(DBTX) error) error {
	return t.fresh(ctx, options, func(_ context.Context, q DBTX) error {
		return fn(q)
	})
}`
    : '';
  return `
// writeConflictAttempts son los intentos de una transacción de escritura que pierde un conflicto transitorio
// (keel-core/gen/transactions.js).
const writeConflictAttempts = ${WRITE_CONFLICT_ATTEMPTS}

// errDisabled es lo que devuelve un repositorio en un perfil sin base de datos (database.enabled: false).
var errDisabled = errors.New("la base de datos no está configurada en este perfil (database.enabled: false)")

// DBTX es lo que un repositorio necesita de la conexión: el pool o la transacción abierta, sin saber cuál.
type DBTX interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// txKey es la clave de la transacción abierta en el contexto.
type txKey struct{}

// Transactions abre la transacción de cada caso de uso y la deja en el contexto, donde la encuentran los repositorios.
// Con la persistencia, es el application.Transactor del servicio.
type Transactions struct {
${p.field}
}

var _ application.Transactor = (*Transactions)(nil)

${p.construct}

// Within implementa application.Transactor: las consultas en una transacción de solo lectura y los comandos en una de
// escritura. Un caso de uso despachado con application.WithoutTransaction no abre ninguna: cada escritura de sus
// repositorios confirma la suya.
func (t *Transactions) Within(ctx context.Context, kind application.MessageKind, fn func(context.Context) error) error {
	if application.TransactionDetached(ctx) {
		return fn(ctx)
	}
	return t.within(ctx, kind == application.KindQuery, func(ctx context.Context, _ DBTX) error {
		return fn(ctx)
	})
}

// write ejecuta una escritura de un repositorio en la transacción abierta o, sin ella, en una suya.
func (t *Transactions) write(ctx context.Context, fn func(DBTX) error) error {
	return t.within(ctx, false, func(_ context.Context, q DBTX) error {
		return fn(q)
	})
}

// conn es la conexión de una lectura: la transacción abierta o, sin ella, el pool.
func (t *Transactions) conn(ctx context.Context) (DBTX, error) {
	if tx := openTx(ctx); tx != nil {
		return ${p.wrap('tx')}, nil
	}
	if t.db == nil {
		return nil, errDisabled
	}
	return ${p.wrap('t.db')}, nil
}

// openTx es la transacción abierta en ctx, o nil (también si el caso de uso se despachó sin transacción).
func openTx(ctx context.Context) *sql.Tx {
	if application.TransactionDetached(ctx) {
		return nil
	}
	tx, _ := ctx.Value(txKey{}).(*sql.Tx)
	return tx
}

// within ejecuta fn en la transacción ABIERTA si la hay (se une a ella) o en una nueva, que confirma si fn termina bien
// y revierte si no. Un conflicto transitorio repite la transacción nueva entera; los errores del motor salen ya
// traducidos al contrato.
func (t *Transactions) within(ctx context.Context, readOnly bool, fn func(context.Context, DBTX) error) error {
	if tx := openTx(ctx); tx != nil {
		return translate(fn(ctx, ${p.wrap('tx')}))
	}
	return t.fresh(ctx, sql.TxOptions{ReadOnly: readOnly}, fn)
}

// fresh ejecuta fn en una transacción nueva, que confirma si fn termina bien y revierte si no. Un conflicto transitorio
// la repite entera; los errores del motor salen ya traducidos al contrato.
func (t *Transactions) fresh(ctx context.Context, options sql.TxOptions, fn func(context.Context, DBTX) error) error {
	if t.db == nil {
		return errDisabled
	}
	for attempt := 1; ; attempt++ {
		err := t.once(ctx, options, fn)
		if err == nil || options.ReadOnly || !transient(err) {
			return translate(err)
		}
		if attempt == writeConflictAttempts {
			return translate(errors.Join(errConflictExhausted, err))
		}
		t.logger.WarnContext(ctx, "conflicto de escritura transitorio: se repite la transacción", "attempt", attempt)
	}
}

// once es un intento: ${p.once}; cualquier fallo revierte.
func (t *Transactions) once(ctx context.Context, options sql.TxOptions, fn func(context.Context, DBTX) error) (err error) {
	tx, err := t.db.BeginTx(ctx, &options)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			// Revertir es lo que pide el fallo; si revertir también falla, el motor ya descartó la transacción.
			_ = tx.Rollback()
		}
	}()
${p.prologue}${afterCommit ? `	hooks := &commitHooks{}
	if err = fn(context.WithValue(context.WithValue(ctx, txKey{}, tx), hooksKey{}, hooks), ${p.wrap('tx')}); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	for _, hook := range hooks.pending {
		hook(ctx)
	}
	return nil
}` : `	if err = fn(context.WithValue(ctx, txKey{}, tx), ${p.wrap('tx')}); err != nil {
		return err
	}
	return tx.Commit()
}`}${apartMethod}${hooksType}

${p.transient}${p.binding}
`;
}

// ─── errors.go ───────────────────────────────────────────────────────────────────────────────────

/** Cómo lee cada motor su fallo: el tope, la violación de integridad y dónde viaja el nombre de la constraint. */
function engineTranslation(d) {
  if (d.mysql) {
    return {
      read: `	var engine *mysqldriver.MySQLError
	if !errors.As(err, &engine) {
		return err
	}
	switch engine.Number {
	// Espera de un bloqueo agotada (innodb_lock_wait_timeout) o lectura cortada por max_execution_time.
	case 1205, 3024:
		return domain.Errorf(domain.ErrTransactionTimeout, ${goString(TRANSACTION_TIMEOUT_MESSAGE)})
	// Violaciones de integridad: unicidad, FK (padre referenciado, hija sin padre), NOT NULL y CHECK. Las mismas que la
	// clase 23 de PostgreSQL.
	case 1062, 1451, 1452, 1216, 1217, 1048, 1364, 3819:
		if known := constraintIn(engine.Message); known != nil {
			return known
		}
		return domain.Errorf(domain.ErrIntegrityViolation, ${goString(UNKNOWN_INTEGRITY_MESSAGE)})
	}
	return err`,
      helper: `

// constraintIn es el error de la constraint conocida que nombra el mensaje del motor, o nil. MySQL no da el nombre
// aparte: va en el texto, como «for key 'tabla.nombre'» (unicidad) o «CONSTRAINT \`nombre\`» (FK). Se busca con sus
// delimitadores, para que un nombre no case dentro de otro más largo.
func constraintIn(message string) error {
	text := strings.ToLower(message)
	for name, known := range constraintErrors {
		if strings.Contains(text, "."+name+"'") || strings.Contains(text, "'"+name+"'") || strings.Contains(text, "\`"+name+"\`") {
			return known
		}
	}
	return nil
}`
    };
  }
  return {
    read: `	var engine *pgconn.PgError
	if !errors.As(err, &engine) {
		return err
	}
	switch {
	// Sentencia cancelada por statement_timeout, también la espera de un bloqueo.
	case engine.Code == "57014" || engine.Code == "55P03":
		return domain.Errorf(domain.ErrTransactionTimeout, ${goString(TRANSACTION_TIMEOUT_MESSAGE)})
	// Clase 23: violaciones de integridad (unicidad, FK, NOT NULL, CHECK).
	case strings.HasPrefix(engine.Code, "23"):
		if known, ok := constraintErrors[strings.ToLower(engine.ConstraintName)]; ok {
			return known
		}
		return domain.Errorf(domain.ErrIntegrityViolation, ${goString(UNKNOWN_INTEGRITY_MESSAGE)})
	}
	return err`,
    helper: ''
  };
}

function errorsBody(model, d) {
  const engine = engineTranslation(d);
  const concurrency = declaredConcurrencyError(model);
  const concurrencySentinel = concurrency ? sentinelOf(concurrency.code) : 'ErrConcurrentModification';
  const build = (declared, code, message) => {
    if (declared?.dynamicStatus) return `domain.StatusErrorf(domain.${sentinelOf(declared.code)}, 409, ${goString(message)})`;
    return `domain.Errorf(domain.${sentinelOf(declared ? declared.code : code)}, ${goString(message)})`;
  };
  const rows = [];
  for (const entry of constraintErrors(model)) {
    const why = entry.reference
      ? `referencia entre agregados (${entry.reference.table}.${entry.reference.column} → ${entry.reference.refTable})`
      : entry.raceOnly
        ? `unicidad de ${entry.entity}.${entry.fields.join(', ')}: solo una carrera la rompe`
        : `unicidad de ${entry.entity}.${entry.fields.join(', ')}`;
    rows.push({ text: `\t// ${why}.` });
    rows.push({ indent: '\t', cells: [`${goString(entry.constraint.toLowerCase())}:`, `${build(entry.declared, entry.code, entry.message)},`] });
  }
  return `
// errStaleVersion es el UPDATE con versión que no tocó ninguna fila: otra escritura ganó entre la lectura y el guardado.
var errStaleVersion = errors.New("la versión del agregado cambió desde que se leyó")

// errConflictExhausted es un conflicto de escritura transitorio que agotó sus reintentos.
var errConflictExhausted = errors.New("conflicto de escritura concurrente tras agotar los reintentos")

// constraintErrors traduce cada constraint con nombre del esquema al error del contrato. Los nombres los pone
// keel-core/gen/relational.js y el error, con su mensaje, keel-core/gen/constraint-errors.js: los cuatro servidores del
// diseño responden lo mismo a la misma violación.
var constraintErrors = map[string]error{${rows.length > 0 ? `\n${alignRows(rows).join('\n')}\n` : ''}}

// translate traduce un fallo de la persistencia al contrato: versión obsoleta o conflicto agotado → el 409 de
// concurrencia; sentencia cortada por el tope → 503; violación de una constraint conocida → su error; de una
// desconocida → 409 sin code. Lo demás (y los errores del dominio) pasa tal cual.
func translate(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, errStaleVersion) || errors.Is(err, errConflictExhausted) {
		return domain.Errorf(domain.${concurrencySentinel}, ${goString(CONCURRENT_MODIFICATION_MESSAGE)})
	}
${engine.read}
}${engine.helper}
`;
}

// ─── textfold ────────────────────────────────────────────────────────────────────────────────────

const TEXTFOLD_DOC =
  'Package textfold pliega un texto para compararlo como pide el diseño (compare: ignore-case o\nignore-case-accents): es el valor de la SOMBRA que guarda la persistencia, donde viven la unicidad y la\nbúsqueda del campo. El campo conserva el texto tal como llegó.';

function textfoldBody(model) {
  const kinds = foldKinds(model);
  const blocks = [
    `// Case pliega las mayúsculas (compare: ignore-case).
func Case(text string) string {
	return strings.ToLower(text)
}`
  ];
  if (kinds.has('accents')) {
    blocks.push(`// CaseAndAccents pliega las mayúsculas y las marcas diacríticas (compare: ignore-case-accents): descompone (NFD), quita
// las marcas y recompone, como el FoldCaseAndAccents de keel-dotnet.
func CaseAndAccents(text string) string {
	var kept strings.Builder
	for _, r := range norm.NFD.String(text) {
		if !unicode.Is(unicode.Mn, r) && !unicode.Is(unicode.Mc, r) && !unicode.Is(unicode.Me, r) {
			kept.WriteRune(r)
		}
	}
	return strings.ToLower(norm.NFC.String(kept.String()))
}`);
  }
  return `\n${blocks.join('\n\n')}\n`;
}
