// Los sabotajes de db-check: cada uno rompe UN mecanismo de la persistencia en el Go (o el SQL) emitido conservando que
// compile, y dice qué sondas de scripts/lib/db-probes.js tienen que salir en rojo (`expect`) y cuáles pueden caer con
// ellas por una dependencia legítima (`also`). Se aplican EN MEMORIA, antes de escribir lo emitido: una red que
// reconstruye lo que mide no lo falsa. test/db-sabotages.test.js comprueba sin Go que cada uno se sigue aplicando.

const REPOSITORY = /^internal\/infrastructure\/postgres\/\w+_repository\.go$/;
const BASELINE = /^internal\/infrastructure\/postgres\/migrations\/.*\.sql$/;

// Los sabotajes: en qué archivos, qué texto (o expresión) y por qué; qué sondas tienen que caer (`expect`) y cuáles
// pueden caer con ellas (`also`).
export const DB_SABOTAGES = {
  // El UPDATE con versión que no tocó ninguna fila deja de ser un conflicto: la lectura obsoleta pisa a la otra.
  version: { files: REPOSITORY, from: 'err != nil || changed == 0 {', to: 'err != nil || changed < 0 {', expect: /_StaleVersion/ },
  // El enum se guarda por su constante en minúsculas: la fila deja de llevar la constante (y no se vuelve a leer).
  enum: { files: /postgres\/values\.go$/, from: /return (\w+)Columns\[value\]/g, to: 'return strings.ToLower($1Columns[value])', expect: /_StoresEnumByConstant/, also: /./ },
  // El traductor no reconoce ninguna constraint: el choque sale como el 409 sin code.
  constraint: { files: /postgres\/errors\.go$/, from: 'constraintErrors[strings.ToLower(engine.ConstraintName)]', to: 'constraintErrors[strings.ToLower(engine.ConstraintName)+"-"]', expect: /Clash/ },
  // Las unicidades salen con OTRO nombre en el esquema: el traductor ya no las reconoce.
  index: { files: BASELINE, from: /(CONSTRAINT|UNIQUE INDEX) uk_/g, to: '$1 zz_', expect: /Clash/ },
  // El pliegue de caja no pliega: la clave en otra caja es otra clave.
  fold: { files: /textfold\/textfold\.go$/, from: 'func Case(text string) string {\n\treturn strings.ToLower(text)', to: 'func Case(text string) string {\n\treturn text', expect: /OtherCase|_FindBy/ },
  // El clasificador no reconoce el interbloqueo: no se repite y una de las dos transacciones falla.
  deadlock: { files: /postgres\/transactions\.go$/, from: 'engine.Code == "40P01" || ', to: '', expect: /_DeadlockIsRetried/ },
  // La transacción no repite el conflicto transitorio.
  retry: { files: /postgres\/transactions\.go$/, from: 'if attempt == writeConflictAttempts {', to: 'if attempt == 1 {', expect: /_DeadlockIsRetried|_ExhaustedConflict/ },
  // La sentencia cortada por el tope no se reconoce: sale como un error del motor y no como el 503.
  timeout: { files: /postgres\/errors\.go$/, from: 'engine.Code == "57014" ||', to: 'engine.Code == "57099" ||', expect: /_StatementOverTimeoutIs503/ },
  // El predicado del índice condicionado con el literal del diseño en minúsculas: el índice existe y no cubre ninguna fila.
  'partial-literal': { files: BASELINE, from: /(UNIQUE INDEX [^\n]* WHERE [^\n']*)'([^']+)'/g, to: (_, head, value) => `${head}'${value.toLowerCase()}'`, expect: /ConditionalUniqueClash/ },
  // La lectura por lote por id se deja el primer id.
  'id-batch': { files: REPOSITORY, from: /(func \(r \*\w+\) FindAllByID\([\s\S]*?r\.load\(ctx, "[^"]*", (?:uuidTexts\()?ids)/g, to: '$1[1:]', expect: /_FindAllByID$/ },
  // La fusión no borra las hijas que ya no están.
  merge: { files: REPOSITORY, from: 'AND NOT (', to: 'AND false AND NOT (', expect: /_SaveMerges/ },
  // Las listas se leen en el orden inverso al de su posición.
  'list-order': { files: REPOSITORY, from: /ORDER BY (\w+), (\w+)"/g, to: 'ORDER BY $1, $2 DESC"', expect: /_RoundTrip|_SaveMerges/ },
  // La lectura por la FK inversa se deja una fila.
  'inverse-finder': {
    files: REPOSITORY,
    from: /(func \(r \*\w+\) FindAllBy\w+ID\(ctx context\.Context, \w+ [\w.]+\) \(\[\]\*domain\.\w+, error\) \{\n\treturn r\.load\(ctx, "WHERE \w+ = \$1)"/g,
    to: '$1 OFFSET 1"',
    expect: /_FindAllBy\w+ID$/
  },
  // El orden por un enum va por su nombre y no por la sombra de rango.
  'rank-sort': { files: REPOSITORY, from: /"(\w+)Rank":(\s+)"(\w+)_rank",/g, to: '"$1Rank":$2"$3",', expect: /_SortsBy/ },
  // Los finders (DSL 2.22): el WHERE que no restringe nada, el extremo inclusivo que deja de serlo, el texto sin plegar y
  // el texto buscado como PATRÓN y no como literal.
  'finder-where': { files: /postgres\/values\.go$/, from: 'return "WHERE " + strings.Join(f.conditions, " AND ")', to: 'return "WHERE true OR " + strings.Join(f.conditions, " AND ")', expect: /_Finder/ },
  'finder-range': { files: REPOSITORY, from: /f\.add\(("[^"]+"), ">=", /g, to: 'f.add($1, ">", ', expect: /_Finder/ },
  'finder-fold': { files: REPOSITORY, from: /f\.(prefix|contains)\(("[^"]+"), textfold\.\w+\((\w+)\)\)/g, to: 'f.$1($2, $3)', expect: /_Finder/ },
  'finder-literal': { files: /postgres\/values\.go$/, from: 'return likeEscaper.Replace(text)', to: 'return text', expect: /_Finder/ }
};

/** Aplica un sabotaje a los archivos emitidos: `{ files, changed }`, con el número de archivos que cambió. */
export function applyDbSabotage(sabotage, files) {
  let changed = 0;
  const out = files.map((file) => {
    if (!sabotage.files.test(file.path) || typeof file.content !== 'string') return file;
    const content = typeof sabotage.from === 'string' ? file.content.replaceAll(sabotage.from, sabotage.to) : file.content.replace(sabotage.from, sabotage.to);
    if (content === file.content) return file;
    changed += 1;
    return { ...file, content };
  });
  return { files: out, changed };
}
