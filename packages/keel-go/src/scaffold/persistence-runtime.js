// Lo que hace funcionar la persistencia relacional en el servidor: la conexión del perfil, las migraciones de goose al
// arrancar, la transacción del caso de uso y la traducción de los errores del motor al contrato. Los repositorios
// (repositories.js) escriben el SQL sobre esto.
//
//   · config/parameters/<perfil>/db.yaml — las MISMAS claves y variables que keel-nest y keel-dotnet (la URL JDBC de
//     keel-spring vale tal cual: el mismo .env sirve para los cuatro servidores del diseño). En `test` no hay base;
//   · database.go — Settings, Open (pgx sobre database/sql) y Migrate (goose, con las migraciones embebidas);
//   · transactions.go — la transacción del caso de uso viaja en el contexto y los repositorios se unen a ella sin verla,
//     como la propagación por defecto de Spring. `SET LOCAL statement_timeout` es el tope (DB_TRANSACTION_TIMEOUT); un
//     interbloqueo o un fallo de serialización se arreglan repitiendo la transacción entera, hasta
//     WRITE_CONFLICT_ATTEMPTS (keel-core/gen/transactions.js); un conflicto de versión NO se repite;
//   · errors.go — el error del motor traducido por el NOMBRE de la constraint con keel-core/gen/constraint-errors.js, la
//     misma tabla de los otros tres: la misma violación sale con el mismo error y el mismo mensaje.

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
import { persistedMembers } from '@keel-system/keel-core/gen';
import { alignRows, goString } from '../lib/go-source.js';
import { sentinelOf } from './errors.js';
import { layout, packageFile } from './render.js';

const PROFILES = ['local', 'develop', 'production', 'test'];
const ENGINE = 'postgresql';

export function generate(model) {
  if (!usesRelational(model)) return [];
  const { postgres, textfold } = layout(model);
  const dbName = model.service.name.replace(/-/g, '_');
  const files = PROFILES.map((profile) => ({ path: `config/parameters/${profile}/db.yaml`, content: dbYaml(model, profile, dbName) }));
  files.push(
    { path: `${postgres.dir}/database.go`, content: packageFile(model, postgres, { imports: DATABASE_IMPORTS, body: DATABASE_BODY }) },
    { path: `${postgres.dir}/transactions.go`, content: packageFile(model, postgres, { imports: TRANSACTION_IMPORTS, body: transactionsBody() }) },
    { path: `${postgres.dir}/errors.go`, content: packageFile(model, postgres, { imports: ['errors', 'strings', 'github.com/jackc/pgx/v5/pgconn', 'internal/domain'], body: errorsBody(model) }) }
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
export function localDatabaseUrl(dbName) {
  return `jdbc:${ENGINE}://localhost:${DATABASES[ENGINE].port}/${dbName}`;
}

function dbYaml(model, profile, dbName) {
  const db = DATABASES[ENGINE];
  if (profile === 'test') {
    return `# El perfil test no tiene base de datos: las pruebas de build arrancan sin infraestructura, y un
# repositorio usado aquí falla diciéndolo. El esquema contra un motor real lo juzga db-check.
database:
  enabled: false
`;
  }
  return `database:
  # La URL JDBC de keel-spring vale tal cual (jdbc:${ENGINE}://host:puerto/base): el mismo .env sirve para los
  # cuatro servidores del diseño.
  url: ${envFor('DB_URL', profile, localDatabaseUrl(dbName))}
  username: ${envFor('DB_USERNAME', profile, db.user(dbName))}
  password: ${envFor('DB_PASSWORD', profile, db.password)}
  pool:
    # El nombre de la aplicación en pg_stat_activity: con el de por defecto, dos servicios en el mismo backend
    # no se distinguen.
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

const DATABASE_IMPORTS = [
  'context',
  'database/sql',
  'errors',
  'fmt',
  'io/fs',
  'log/slog',
  'math',
  'net/url',
  'strconv',
  'strings',
  'time',
  'github.com/jackc/pgx/v5',
  'github.com/jackc/pgx/v5/stdlib',
  'github.com/pressly/goose/v3',
  'internal/platform/config'
];

const DATABASE_BODY = `
// Settings es la conexión a la base de datos del perfil (config/parameters/<perfil>/db.yaml).
type Settings struct {
	// Enabled es false en el perfil test: el servicio arranca sin base, y un repositorio usado falla diciéndolo.
	Enabled bool
	// URL es la de keel-spring (jdbc:postgresql://host:puerto/base) o la misma sin jdbc:.
	URL string
	// Username y Password son las credenciales.
	Username string
	Password string
	// PoolName es el nombre de la aplicación en pg_stat_activity.
	PoolName string
	// MaxSize es el máximo de conexiones abiertas.
	MaxSize int
	// ConnectionTimeout es cuánto espera una conexión nueva a que el motor conteste.
	ConnectionTimeout time.Duration
	// MaxLifetime es la vida máxima de una conexión.
	MaxLifetime time.Duration
	// TransactionTimeout es el tope de cada sentencia de una transacción.
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
	if _, err := s.dsn(); err != nil {
		errs = append(errs, err)
	}
	return s, errors.Join(errs...)
}

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

// Open abre el pool de conexiones y comprueba que el motor contesta: sin base, el servicio no arranca.
func Open(ctx context.Context, s Settings) (*sql.DB, error) {
	dsn, err := s.dsn()
	if err != nil {
		return nil, err
	}
	connConfig, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("database.url: %w", err)
	}
	db := stdlib.OpenDB(*connConfig)
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
// nunca el código. Dos réplicas que arrancan a la vez no las aplican dos veces: goose las serializa con su tabla de
// versiones.
func Migrate(ctx context.Context, db *sql.DB, logger *slog.Logger) error {
	migrations, err := fs.Sub(Migrations, "migrations")
	if err != nil {
		return fmt.Errorf("leer las migraciones embebidas: %w", err)
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations)
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

// ─── transactions.go ─────────────────────────────────────────────────────────────────────────────

const TRANSACTION_IMPORTS = ['context', 'database/sql', 'errors', 'fmt', 'log/slog', 'time', 'github.com/jackc/pgx/v5/pgconn', 'internal/application'];

function transactionsBody() {
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
	db               *sql.DB
	statementTimeout string
	logger           *slog.Logger
}

var _ application.Transactor = (*Transactions)(nil)

// NewTransactions construye las transacciones sobre el pool. Con db nil (el perfil test), todo lo que necesite la
// base falla con errDisabled.
func NewTransactions(db *sql.DB, timeout time.Duration, logger *slog.Logger) *Transactions {
	return &Transactions{db: db, statementTimeout: fmt.Sprintf("SET LOCAL statement_timeout = %d", timeout.Milliseconds()), logger: logger}
}

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
		return tx, nil
	}
	if t.db == nil {
		return nil, errDisabled
	}
	return t.db, nil
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
		return translate(fn(ctx, tx))
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
	}
}

// once es un intento: abre, fija el tope, ejecuta y confirma; cualquier fallo revierte.
func (t *Transactions) once(ctx context.Context, readOnly bool, fn func(context.Context, DBTX) error) (err error) {
	tx, err := t.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: readOnly})
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			// Revertir es lo que pide el fallo; si revertir también falla, el motor ya descartó la transacción.
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.ExecContext(ctx, t.statementTimeout); err != nil {
		return err
	}
	if err = fn(context.WithValue(ctx, txKey{}, tx), tx); err != nil {
		return err
	}
	return tx.Commit()
}

// transient dice si err es un interbloqueo o un fallo de serialización: se arreglan repitiendo la transacción.
func transient(err error) bool {
	var engine *pgconn.PgError
	return errors.As(err, &engine) && (engine.Code == "40P01" || engine.Code == "40001")
}
`;
}

// ─── errors.go ───────────────────────────────────────────────────────────────────────────────────

function errorsBody(model) {
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
	var engine *pgconn.PgError
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
	return err
}
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
