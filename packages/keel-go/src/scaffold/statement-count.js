// El COSTE de una petición, para los `Then` que lo afirman («el trabajo no crece con el tamaño de la página»): el
// `queryCount()` de keel-spring (hibernate.statements del actuator), de keel-nest (un suscriptor del DataSource) y de
// keel-dotnet (un interceptor de EF Core). El arnés de Go es caja negra —el servidor es otro proceso—, así que, como en
// keel-dotnet, la cuenta la lleva el SERVIDOR y la lee el arnés por HTTP:
//   · `Transactions` envuelve la conexión que ven los repositorios y cuenta cada sentencia cuyo contexto viene de una
//     petición HTTP: el relay del outbox, las purgas y los barridos corren con otro contexto y no cuentan;
//   · `Counter.Wrap`, delante de todo el handler (correlación y seguridad incluidas), marca ese contexto y sirve la cuenta
//     en `GET /__keel/statements`;
//   · las dos piezas solo existen si el proceso arranca con KEEL_FLOW_STATEMENTS=on, que solo pone el arnés de flujos
//     (server_test.go): ni deploy/ ni producción tienen la ruta.
// Solo con API y persistencia relacional, como en los otros tres generadores. Sin estado global: `run` construye el
// contador y se lo da a quien lo usa.

import { usesStatementCount } from '@keel-system/keel-core/gen/features';
import { goString } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';

export { usesStatementCount };

export const STATEMENT_COUNT_VARIABLE = 'KEEL_FLOW_STATEMENTS';
export const STATEMENT_COUNT_PATH = '/__keel/statements';

const DOC = `// Package statements cuenta las sentencias SQL que emiten las peticiones HTTP, para los Then de COSTE de las pruebas de
// flujo. Solo existe en un proceso arrancado con ${STATEMENT_COUNT_VARIABLE}=on.`;

export function generate(model) {
  if (!usesStatementCount(model)) return [];
  const { statements } = layout(model);
  return [
    {
      path: `${statements.dir}/statements.go`,
      content: packageFile(model, statements, { doc: DOC, imports: ['context', 'fmt', 'net/http', 'strings', 'sync/atomic'], body: counterBody() })
    }
  ];
}

function counterBody() {
  return String.raw`
// Variable es la variable de entorno que enciende la cuenta. Solo la pone el arnés de flujos.
const Variable = ${goString(STATEMENT_COUNT_VARIABLE)}

// Path es la ruta en la que el servidor sirve la cuenta.
const Path = ${goString(STATEMENT_COUNT_PATH)}

// requestKey marca el contexto de una petición HTTP: lo que se emita con él, cuenta.
type requestKey struct{}

// Counter son las sentencias que han emitido las peticiones HTTP desde que arrancó el proceso. Un viaje al motor es una
// sentencia, sin el control de la transacción (START, COMMIT, SET…), que lo paga igual una página de 2 que una de 100.
// Un Counter nil no cuenta nada ni añade ninguna ruta: es el de cualquier arranque que no sea el del arnés.
type Counter struct {
	statements atomic.Int64
	reads      atomic.Int64
}

// FromEnv devuelve un Counter si la variable lo enciende, y nil si no.
func FromEnv(getenv func(string) string) *Counter {
	if getenv(Variable) != "on" {
		return nil
	}
	return &Counter{}
}

// Count apunta query si ctx viene de una petición HTTP.
func (c *Counter) Count(ctx context.Context, query string) {
	if c == nil {
		return
	}
	if inRequest, _ := ctx.Value(requestKey{}).(bool); !inRequest {
		return
	}
	keyword := firstWord(query)
	switch keyword {
	case "START", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "SET":
		return
	}
	c.statements.Add(1)
	if keyword == "SELECT" || keyword == "WITH" {
		c.reads.Add(1)
	}
}

// Wrap sirve la cuenta en Path y marca cualquier otra petición como trabajo que cuenta. Va delante de todo el handler:
// leer la cuenta no es una petición del diseño. Con un Counter nil, devuelve next tal cual.
func (c *Counter) Wrap(next http.Handler) http.Handler {
	if c == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == Path {
			w.Header().Set("Content-Type", "application/json")
			// El cliente es el arnés: si no llega a leerla, su propia lectura falla.
			_, _ = fmt.Fprintf(w, "{\"statements\":%d,\"reads\":%d}", c.statements.Load(), c.reads.Load())
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestKey{}, true)))
	})
}

// firstWord es la primera palabra de query, en mayúsculas.
func firstWord(query string) string {
	fields := strings.Fields(query)
	if len(fields) == 0 {
		return ""
	}
	return strings.ToUpper(fields[0])
}
`;
}

/** La línea de `run` que construye el contador. */
export function statementCountWiring(model) {
  return usesStatementCount(model) ? '\tcounter := statements.FromEnv(getenv)\n' : '';
}

/** Lo que `run` le pide a las transacciones, justo después de construirlas. */
export function statementCountOnTransactions(model) {
  return usesStatementCount(model) ? '\ttransactions.CountStatements(counter)\n' : '';
}

/** El handler del servidor, envuelto si hay cuenta. */
export function statementCountHandler(model, handler) {
  return usesStatementCount(model) ? `counter.Wrap(${handler})` : handler;
}

/** El arranque del servidor del arnés enciende la cuenta. */
export function statementCountLaunch(model) {
  return usesStatementCount(model) ? `, ${goString(`${STATEMENT_COUNT_VARIABLE}=on`)}` : '';
}

/** QueryCount, QueryExecutions y su lectura, en flow_test.go. */
export function statementCountMembers(model) {
  if (!usesStatementCount(model)) return [];
  return [
    String.raw`// QueryCount son las sentencias SQL (lecturas y escrituras, sin el control de la transacción) que han emitido las
// peticiones HTTP desde que arrancó el servidor. Es para los Then de COSTE: se lee antes y después de la petición y se
// afirma sobre el SALTO, midiendo dos tamaños muy distintos, nunca contra un número escrito:
//
//	s.Get(RouteBase + "/products?size=2") // calienta: se mide la SEGUNDA ejecución
//	before := s.QueryCount()
//	s.Get(RouteBase + "/products?size=2")
//	small := s.QueryCount() - before
//	before = s.QueryCount()
//	s.Get(RouteBase + "/products?size=100")
//	if large := s.QueryCount() - before; large > small {
//		s.Errorf("el coste crece con la página: %d sentencias con size=2 y %d con size=100", small, large)
//	}
//
// La petición medida es la ÚNICA del intervalo, y el Given deja más elementos que el tamaño pequeño. El relay, las purgas
// y los barridos no cuentan: corren fuera de una petición. Leer la cuenta tampoco cuenta.
func (s *Scenario) QueryCount() int64 {
	s.Helper()
	return s.statementTotals().Statements
}

// QueryExecutions son solo las LECTURAS (SELECT/WITH) de QueryCount: para cuando el When ESCRIBE. Allí cuentan también los
// INSERT, que crecen con lo guardado, y «no crece con N» saldría rojo aunque la comprobación fuera una sola consulta por
// lote.
func (s *Scenario) QueryExecutions() int64 {
	s.Helper()
	return s.statementTotals().Reads
}

// statementTotals lee la cuenta del servidor del flujo. No pasa por send: no es un intercambio del escenario, y su
// evidencia seguiría siendo la de la petición anterior.
func (s *Scenario) statementTotals() statementTotals {
	s.Helper()
	request, err := http.NewRequestWithContext(s.Context(), http.MethodGet, server.url()+${goString(STATEMENT_COUNT_PATH)}, nil)
	if err != nil {
		s.Fatalf("armar la lectura de la cuenta de sentencias: %v", err)
	}
	response, err := httpClient.Do(request)
	if err != nil {
		s.Fatalf("leer la cuenta de sentencias: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		s.Fatalf("no se pudo leer la cuenta de sentencias (%d): ¿arrancó el servidor sin ${STATEMENT_COUNT_VARIABLE}=on?", response.StatusCode)
	}
	var totals statementTotals
	if err := json.NewDecoder(response.Body).Decode(&totals); err != nil {
		s.Fatalf("la cuenta de sentencias no es JSON: %v", err)
	}
	return totals
}

// statementTotals es lo que sirve el servidor en ${STATEMENT_COUNT_PATH}.
type statementTotals struct {
	Statements int64 ${'`'}json:"statements"${'`'}
	Reads      int64 ${'`'}json:"reads"${'`'}
}`
  ];
}

/** El humo: que la cuenta se lea. Si no, todo Then de coste fallaría por la fontanería. */
export function statementCountSmokeCase(model) {
  if (!usesStatementCount(model)) return null;
  return String.raw`	f.Scenario("SMOKE-7: el servidor cuenta las sentencias de las peticiones", func(s *Scenario) {
		before := s.QueryCount()
		if before < 0 || s.QueryExecutions() > before {
			s.Errorf("la cuenta de sentencias no es coherente: %d sentencias y %d lecturas", before, s.QueryExecutions())
		}
		// Leer la cuenta no es una petición que cuente.
		if after := s.QueryCount(); after != before {
			s.Errorf("leer la cuenta de sentencias la movió de %d a %d", before, after)
		}
	})`;
}
