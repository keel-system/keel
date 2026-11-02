// Los sabotajes de db-check: cada uno rompe UN mecanismo de la persistencia en el Go (o el SQL) emitido conservando que
// compile, y dice qué sondas de scripts/lib/db-probes.js tienen que salir en rojo (`expect`) y cuáles pueden caer con
// ellas por una dependencia legítima (`also`). Se aplican EN MEMORIA, antes de escribir lo emitido: una red que
// reconstruye lo que mide no lo falsa. test/db-sabotages.test.js comprueba sin Go que cada uno se sigue aplicando.

// Los archivos del adaptador, en el paquete de cualquiera de los dos motores.
const STORE = String.raw`^internal\/infrastructure\/(?:postgres|mysql)\/`;
const REPOSITORY = new RegExp(`${STORE}\\w+_repository\\.go$`);
const BASELINE = new RegExp(`${STORE}migrations\\/.*\\.sql$`);
const VALUES = new RegExp(`${STORE}values\\.go$`);
const ERRORS = new RegExp(`${STORE}errors\\.go$`);
const TRANSACTIONS = new RegExp(`${STORE}transactions\\.go$`);
const AUDIT_ACTOR = new RegExp(`${STORE}audit_actor\\.go$`);

// Los sabotajes: en qué archivos, qué texto (o expresión) y por qué; qué sondas tienen que caer (`expect`) y cuáles
// pueden caer con ellas (`also`). Donde el texto emitido es otro en MySQL, `mysql` lleva su `from`/`to`: el MISMO
// mecanismo, roto en su dialecto. `engines` limita un sabotaje a los motores donde el mecanismo existe.
export const DB_SABOTAGES = {
  // El UPDATE con versión que no tocó ninguna fila deja de ser un conflicto: la lectura obsoleta pisa a la otra.
  version: { files: REPOSITORY, from: 'err != nil || changed == 0 {', to: 'err != nil || changed < 0 {', expect: /_StaleVersion/ },
  // El enum se guarda por su constante en minúsculas: la fila deja de llevar la constante (y no se vuelve a leer).
  enum: { files: VALUES, from: /return (\w+)Columns\[value\]/g, to: 'return strings.ToLower($1Columns[value])', expect: /_StoresEnumByConstant/, also: /./ },
  // El traductor no reconoce ninguna constraint: el choque sale como el 409 sin code. En MySQL el nombre se busca en el
  // mensaje, así que se busca otro.
  constraint: {
    files: ERRORS,
    from: 'constraintErrors[strings.ToLower(engine.ConstraintName)]',
    to: 'constraintErrors[strings.ToLower(engine.ConstraintName)+"-"]',
    mysql: { from: 'for name, known := range constraintErrors {', to: 'for name, known := range constraintErrors {\n\t\tname += "-"' },
    expect: /Clash/
  },
  // Las unicidades salen con OTRO nombre en el esquema: el traductor ya no las reconoce.
  index: { files: BASELINE, from: /(CONSTRAINT|UNIQUE INDEX) uk_/g, to: '$1 zz_', expect: /Clash/ },
  // El pliegue de caja no pliega: la clave en otra caja es otra clave. Solo en PostgreSQL: en MySQL la sombra no lleva
  // collation y la de por defecto (utf8mb4_0900_ai_ci) ya compara sin caja ni acentos, así que el motor pliega por el
  // adaptador y ninguna sonda puede verlo (medido el 2026-10-29: 0 sondas en rojo). Es un hueco neutral: ver
  // PLAN-KEEL-GO.md, tramo 6d.
  fold: { engines: ['postgresql'], files: /textfold\/textfold\.go$/, from: 'func Case(text string) string {\n\treturn strings.ToLower(text)', to: 'func Case(text string) string {\n\treturn text', expect: /OtherCase|_FindBy/ },
  // El clasificador no reconoce el interbloqueo: no se repite y una de las dos transacciones falla.
  deadlock: {
    files: TRANSACTIONS,
    from: 'engine.Code == "40P01" || ',
    to: '',
    // En MySQL el interbloqueo es el ÚNICO conflicto transitorio (no hay fallo de serialización aparte), así que el
    // conflicto agotado, que lo simula con el mismo 1213, cae con él.
    mysql: { from: 'engine.Number == 1213', to: 'engine.Number == 1214', also: /_ExhaustedConflict/ },
    expect: /_DeadlockIsRetried/
  },
  // La transacción no repite el conflicto transitorio.
  retry: { files: TRANSACTIONS, from: 'if attempt == writeConflictAttempts {', to: 'if attempt == 1 {', expect: /_DeadlockIsRetried|_ExhaustedConflict/ },
  // La sentencia (en MySQL, la espera de un bloqueo) cortada por el tope no se reconoce: sale como un error del motor y
  // no como el 503.
  timeout: {
    files: ERRORS,
    from: 'engine.Code == "57014" ||',
    to: 'engine.Code == "57099" ||',
    mysql: { from: 'case 1205, 3024:', to: 'case 1206, 3024:' },
    expect: /_StatementOverTimeoutIs503/
  },
  // El predicado del índice condicionado con el literal del diseño en minúsculas: el índice existe y no cubre ninguna
  // fila. Solo en PostgreSQL: en MySQL la columna del estado compara sin caja y el literal en minúsculas casa igual
  // (medido el 2026-10-29 sobre la expresión de la columna generada: 0 sondas en rojo); allí se rompe la columna
  // generada (`partial-flag`).
  'partial-literal': { engines: ['postgresql'], files: BASELINE, from: /(UNIQUE INDEX [^\n]* WHERE [^\n']*)'([^']+)'/g, to: (_, head, value) => `${head}'${value.toLowerCase()}'`, expect: /ConditionalUniqueClash/ },
  // MySQL: la columna generada del índice condicionado vale NULL también DENTRO de la condición: el índice existe y no
  // restringe ninguna fila.
  'partial-flag': { engines: ['mysql'], files: BASELINE, from: /(GENERATED ALWAYS AS \(CASE WHEN [^\n]*) THEN 1 END\)/g, to: '$1 THEN NULL END)', expect: /ConditionalUniqueClash/ },
  // La lectura por lote por id se deja el primer id.
  'id-batch': {
    files: REPOSITORY,
    from: /(func \(r \*\w+\) FindAllByID\([\s\S]*?r\.load\(ctx, "[^"]*", (?:uuidTexts\()?ids)/g,
    to: '$1[1:]',
    mysql: { from: /(func \(r \*\w+\) FindAllByID\([\s\S]*?inList\(ids)/g, to: '$1[1:]' },
    expect: /_FindAllByID$/
  },
  // La fusión no borra las hijas que ya no están.
  merge: { files: REPOSITORY, from: 'AND NOT (', to: 'AND false AND NOT (', mysql: { from: /(\+= " AND )/g, to: '$1false AND ' }, expect: /_SaveMerges/ },
  // Las listas se leen en el orden inverso al de su posición.
  'list-order': { files: REPOSITORY, from: /ORDER BY (\w+), (\w+)"/g, to: 'ORDER BY $1, $2 DESC"', expect: /_RoundTrip|_SaveMerges/ },
  // La lectura por la FK inversa se deja una fila.
  'inverse-finder': {
    files: REPOSITORY,
    from: /(func \(r \*\w+\) FindAllBy\w+ID\(ctx context\.Context, \w+ [\w.]+\) \(\[\]\*domain\.\w+, error\) \{\n\treturn r\.load\(ctx, "WHERE \w+ = \$1)"/g,
    to: '$1 OFFSET 1"',
    // MySQL no admite OFFSET sin LIMIT: el mayor posible, como pide su manual.
    mysql: {
      from: /(func \(r \*\w+\) FindAllBy\w+ID\(ctx context\.Context, \w+ [\w.]+\) \(\[\]\*domain\.\w+, error\) \{\n\treturn r\.load\(ctx, "WHERE \w+ = \?)"/g,
      to: '$1 LIMIT 18446744073709551615 OFFSET 1"'
    },
    expect: /_FindAllBy\w+ID$/
  },
  // El orden por un enum va por su nombre y no por la sombra de rango.
  'rank-sort': { files: REPOSITORY, from: /"(\w+)Rank":(\s+)"(\w+)_rank",/g, to: '"$1Rank":$2"$3",', expect: /_SortsBy/ },
  // Los finders (DSL 2.22): el WHERE que no restringe nada, el extremo inclusivo que deja de serlo, el texto sin plegar y
  // el texto buscado como PATRÓN y no como literal.
  'finder-where': { files: VALUES, from: 'return "WHERE " + strings.Join(f.conditions, " AND ")', to: 'return "WHERE true OR " + strings.Join(f.conditions, " AND ")', expect: /_Finder/ },
  'finder-range': { files: REPOSITORY, from: /f\.add\(("[^"]+"), ">=", /g, to: 'f.add($1, ">", ', expect: /_Finder/ },
  // Solo en PostgreSQL, por lo mismo que `fold`: en MySQL el LIKE sobre la sombra ya compara sin caja ni acentos.
  'finder-fold': { engines: ['postgresql'], files: REPOSITORY, from: /f\.(prefix|contains)\(("[^"]+"), textfold\.\w+\((\w+)\)\)/g, to: 'f.$1($2, $3)', expect: /_Finder/ },
  'finder-literal': { files: VALUES, from: 'return likeEscaper.Replace(text)', to: 'return text', expect: /_Finder/ },
  // El registro de idempotencia no reconoce su clave primaria repetida: la carrera sale como el 409 sin code de la
  // violación desconocida, indistinguible de un conflicto de negocio.
  idempotency: {
    files: new RegExp(`${STORE}idempotency_store\\.go$`),
    from: 'if duplicateIdempotencyRecord(err) {',
    to: 'if duplicateIdempotencyRecord(err) && key == "" {',
    expect: /_RepeatedKeyIsConflict|_RaceOneWins/
  },
  // La mensajería (incremento 9). El lease del reclamo en el PASADO: lo reclamado vuelve a salir en la pasada siguiente.
  // La purga del outbox corta por created_at y no por published_at: se lleva también lo PENDIENTE que es viejo.
  purge: {
    files: new RegExp(`${STORE}purges\\.go$`),
    from: /"(?:SELECT|DELETE)[^"]*outbox_event[^"]*"/g,
    to: (statement) => statement.replaceAll('published_at IS NOT NULL AND ', '').replaceAll('published_at', 'created_at'),
    expect: /^TestPurge_Outbox_KeepsWhatIsPending$/
  },
  // Cada lote borra hasta el corte y no hasta su frontera (la corre un siglo): la pasada se lo lleva todo en el primero y el
  // tope no corta nada.
  'purge-batch': {
    files: /^internal\/infrastructure\/scheduler\/purge\.go$/,
    from: 'n, err := table.DeleteUpTo(ctx, cutoff, edge)',
    to: 'n, err := table.DeleteUpTo(ctx, cutoff, edge.AddDate(100, 0, 0))',
    expect: /^TestPurge_\w+_StopsAtItsCap$/
  },
  // Los reclamos de barrido (tramo 10c). Sin SKIP LOCKED, el reclamo espera a la fila que retiene otra réplica.
  'claim-skip-locked': { files: REPOSITORY, from: ' FOR UPDATE SKIP LOCKED"', to: ' FOR UPDATE"', expect: /^TestClaim_\w+_SkipsARowHeldByAnotherReplica$/ },
  // El rescate sin cota temporal (la cota, una hora en el FUTURO): se lleva también lo que acaba de entrar en vuelo.
  'claim-stale': { files: REPOSITORY, from: 'staleBefore := time.Now().UTC().Add(-', to: 'staleBefore := time.Now().UTC().Add(time.Hour).Add(0 * -', expect: /^TestRescue_\w+_(OnlyWhatIsAbandoned\w+|TheHarnessStatementsBuildItsPrecondition)$/ },
  // MySQL: el reclamo en el REPEATABLE READ por defecto, que bloquea los huecos entre claves.
  'claim-isolation': {
    engines: ['mysql'],
    files: new RegExp(`${STORE}claims\\.go$`),
    from: 'sql.TxOptions{Isolation: sql.LevelReadCommitted}',
    to: 'sql.TxOptions{}',
    expect: /^TestClaim_\w+_LocksTheBatchWithoutGaps$/
  },
  // La reconciliación (tramo 11c). La marca caducada justo en el límite deja de renovarse (`<` en vez de `<=`).
  'reconciliation-expiry': {
    files: new RegExp(`${STORE}reconciliation\\.go$`),
    from: 'WHERE reconciliation_claim.claimed_at <= $4"',
    to: 'WHERE reconciliation_claim.claimed_at < $4"',
    mysql: { from: 'AND claimed_at <= ?"', to: 'AND claimed_at < ?"' },
    expect: /^TestReconciliationStore_RenewsTheExpiredMarkAtTheLimit$/
  },
  // El umbral en el FUTURO: se lleva también lo que acaba de quedarse esperando.
  'reconciliation-threshold': {
    files: REPOSITORY,
    from: 'unansweredBefore := now.Add(-window.UnansweredAfter())',
    to: 'unansweredBefore := now.Add(window.UnansweredAfter())',
    expect: /^TestReconcile_\w+_TakesOnlyWhatOutlivedTheThresholdAndLeavesTheState$/
  },
  // La lectura de candidatos deja de excluir la marca viva (el parámetro se conserva): la cabeza de la cola, reclamada y
  // sin resolver, ocupa el lote de cada pasada y los de detrás no salen hasta que caduque. Con dos réplicas en MySQL, las
  // pasadas que recogen lo que no cupo caen con ella.
  'reconciliation-head': {
    files: REPOSITORY,
    from: /AND NOT EXISTS \(SELECT 1 FROM reconciliation_claim c WHERE c\.activation = '\w+' AND c\.entity_id = e\.\w+ AND (c\.claimed_at > (?:\$2|\?))\)/g,
    to: 'AND NOT EXISTS (SELECT 1 FROM reconciliation_claim c WHERE $1 AND 1 = 0)',
    expect: /^TestReconcile_\w+_TheNextPassTakesTheOnesBehind$/,
    also: /^TestReconcile_\w+_TwoReplicasDoNotRepeat$/
  },
  // El arnés de flujos atasca todas las filas MENOS la pedida: la sonda lee sus sentencias de lo emitido, así que lo ve.
  'harness-stall': { files: /^tests\/integration\/flow_test\.go$/, from: /(UPDATE [^"\n]*) WHERE id = "/g, to: '$1 WHERE id <> "', expect: /^TestRescue_\w+_TheHarnessStatementsBuildItsPrecondition$/ },
  lease: { files: new RegExp(`${STORE}outbox\\.go$`), from: 'now.Add(lease), event.ID)', to: 'now.Add(-lease), event.ID)', expect: /^TestOutbox_ClaimsInArrivalOrderWithLease$/ },
  // El reclamo sin SKIP LOCKED: espera a la fila retenida en vez de saltarla.
  'skip-locked': { files: new RegExp(`${STORE}outbox\\.go$`), from: ' FOR UPDATE SKIP LOCKED', to: ' FOR UPDATE', expect: /^TestOutbox_SkipLockedSkipsHeldRows$/ },
  // La guarda no reconoce la clave primaria repetida: el duplicado y la carrera salen como un error.
  guard: { files: new RegExp(`${STORE}processed_events\\.go$`), from: 'if duplicateProcessedEvent(err) {', to: 'if duplicateProcessedEvent(err) && handlerID == "" {', expect: /^TestProcessed_(RecordIsKeyedByHandlerAndEvent|ConcurrentDeliveriesOneWins)$/ },
  // Lo que espera al commit se ejecuta en el acto, dentro de la transacción: un evento best-effort sale aunque el caso de
  // uso revierta después.
  'after-commit': {
    files: TRANSACTIONS,
    from: 'hooks.pending = append(hooks.pending, fn)\n\t\treturn',
    to: '_ = hooks\n\t\tfn(ctx)\n\t\treturn',
    expect: /^TestTransaction_AfterCommitRunsOnlyOnCommit$/
  },
  // El registro se une a la transacción del caso de uso en vez de ir en la suya: el rollback del handler lo deshace.
  apart: {
    files: TRANSACTIONS,
    from: 'return t.fresh(ctx, options, func(_ context.Context, q DBTX) error {',
    to: 'return t.within(ctx, options.ReadOnly, func(_ context.Context, q DBTX) error {',
    expect: /^TestProcessed_SurvivesTheCallerRollback$/
  },
  // La autoría (13g). El actor deja de leer el `sub`: queda el nombre del principal, que es para mostrar.
  'actor-subject': { files: AUDIT_ACTOR, from: 'principal.Kind == security.TokenPrincipal && found', to: 'principal.Kind == 0 && found', expect: /_Authorship/, also: /TestAuditActor/ },
  // El actor sin petición autenticada pierde la correlación: queda `system` a secas.
  'actor-correlation': { files: AUDIT_ACTOR, from: 'return systemActor + ":" + id', to: 'return systemActor + id[:0]', expect: /_Authorship/, also: /TestAuditActor/ },
  // El alta deja de estampar la autoría declarada que llega vacía: la fila guarda el vacío del dominio.
  'created-by-empty': { files: AUDIT_ACTOR, from: 'if current == "" {', to: 'if current == "-" {', expect: /_Authorship/, also: /TestCreatedAuthor/ },
  // created_by se reescribe en cada guardado. Solo en PostgreSQL: el `?` de MySQL es posicional y no admite repetirlo.
  'created-by-rewritten': { engines: ['postgresql'], files: REPOSITORY, from: /\bupdated_by = (\$\d+|EXCLUDED\.updated_by)/g, to: 'created_by = $1, updated_by = $1', expect: /_Authorship/ }
};

/** ¿Existe el mecanismo del sabotaje en el motor? */
export function sabotageApplies(sabotage, engine) {
  return !sabotage.engines || sabotage.engines.includes(engine);
}

/**
 * Aplica un sabotaje a los archivos emitidos para `engine`: `{ files, changed }`, con el número de archivos que cambió.
 * Un sabotaje de otro motor no cambia nada.
 */
export function applyDbSabotage(sabotage, files, engine = 'postgresql') {
  if (!sabotageApplies(sabotage, engine)) return { files, changed: 0 };
  const { from, to } = sabotage[engine] ?? sabotage;
  let changed = 0;
  const out = files.map((file) => {
    if (!sabotage.files.test(file.path) || typeof file.content !== 'string') return file;
    const content = typeof from === 'string' ? file.content.replaceAll(from, to) : file.content.replace(from, to);
    if (content === file.content) return file;
    changed += 1;
    return { ...file, content };
  });
  return { files: out, changed };
}
