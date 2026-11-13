// El arnés de flujos sobre DOCUMENTOS (incremento 12): lo que en la rama relacional hace `Db` con una sentencia, aquí lo
// hace `MongoEval` con un script de mongosh, y con él los ayudantes que fabrican las precondiciones que ninguna operación
// puede (el rescate de un barrido) y las esperas y trampas del outbox. Los mismos nombres y los MISMOS scripts que
// keel-spring, keel-nest y keel-dotnet: salen de keel-core/gen/mongo-probes.js, nunca de un literal de aquí.
//
// Dos trampas que esa fuente documenta y que aquí se respetan tal cual:
//   · el script viaja por ARCHIVO dentro del contenedor (en Windows el argv se come las comillas), y por archivo mongosh
//     NO imprime el valor de la última expresión: va envuelto en el print de PRINT_WRAPPER, o un countDocuments
//     devolvería cadena vacía, que se parece a un cero;
//   · un id va como UUID("…"): el _id es un binario, y un literal que no case deja el script en cero modificados SIN
//     fallar. Por eso el id se valida antes de meterlo.

import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { usesDocument } from '@keel-system/keel-core/gen/features';
import { documentDeadlineAgingMembers, fireAgedCall, fireAgedMember, fireScheduleCall, fireScheduleMember } from './timer.js';
import { documentDeletionAgingMembers } from './data-lifecycle.js';
import { CLOCK, OUTBOX, PRINT_WRAPPER, abandonOutboxScript, ageClockScript, clearAbandonedScript, holdClockScript, missingClockCountScript, setStateScript } from '@keel-system/keel-core/gen/mongo-probes';
import { documentAgingTargets } from '@keel-system/keel-core/gen/aging-targets';
import { rescueProbes } from '@keel-system/keel-core/gen/scheduling';
import { alignRows, goString } from '../lib/go-source.js';

/** La base de prueba como contenedor al que se le pueden mandar scripts de mongosh (documental). */
export function documentProbe(model) {
  if (!usesDocument(model)) return null;
  const entry = DATABASES.mongodb;
  const dbName = model.service.name.replaceAll('-', '_');
  return {
    container: `${model.service.name}-db`,
    argv: entry.cliQueryArgv({ user: entry.user(dbName), pass: entry.password, db: dbName }).filter((part) => part !== '--eval'),
    label: entry.label
  };
}

/** harness_test.go: `mongoEval`, el transporte de los scripts. */
export function mongoEvalSection(model) {
  const probe = documentProbe(model);
  return String.raw`// dbContainer es el contenedor de la base de prueba (${probe.label}).
const dbContainer = ${goString(probe.container)}

// mongoShellArgs es la invocación de mongosh sin el script.
var mongoShellArgs = []string{${probe.argv.map(goString).join(', ')}}

// mongoScript es dónde se deja el script dentro del contenedor de la base.
const mongoScript = "/tmp/keel-eval.js"

// mongoMu serializa los scripts: todos van por el mismo archivo del contenedor.
var mongoMu sync.Mutex

// mongoEval ejecuta un script de mongosh contra la base de prueba y devuelve su salida en crudo. Viaja por ARCHIVO (el
// argv se come las comillas en Windows) y envuelto en un print: ejecutado por archivo, mongosh no imprime el valor de la
// última expresión, y sin él un countDocuments devolvería cadena vacía, que se parece a un cero
// (keel-core/gen/mongo-probes.js).
func mongoEval(ctx context.Context, script string) (string, error) {
	mongoMu.Lock()
	defer mongoMu.Unlock()
	printed := ${goString(PRINT_WRAPPER.prefix)} + script + ${goString(PRINT_WRAPPER.suffix)}
	hint := "¿Está la base arriba (bash infra/up.sh)?"
	if _, err := runCommand(ctx, containerRuntime(), []string{"exec", "-i", dbContainer, "sh", "-c", "cat > " + mongoScript}, hint, printed); err != nil {
		return "", err
	}
	return runCommand(ctx, containerRuntime(), slices.Concat([]string{"exec", dbContainer}, mongoShellArgs, []string{mongoScript}), hint, "")
}

// scriptPair es un script partido en dos: el valor que aporta cada escenario (un id, un tipo de evento) va en medio.
type scriptPair struct {
	prefix, suffix string
}

// documentIDPattern es la forma canónica de un uuid, la que se mete dentro de UUID("…").
var documentIDPattern = regexp.MustCompile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

// documentID es un id de documento para un script: se valida la forma antes de meterlo dentro de UUID("…"), porque un
// literal que no case deja el script en cero modificados SIN fallar.
func documentID(id string) (string, error) {
	canonical := strings.ToLower(strings.TrimSpace(id))
	if !documentIDPattern.MatchString(canonical) {
		return "", fmt.Errorf("no es un id de documento: %q", id)
	}
	return canonical, nil
}`;
}

/** flow_test.go: `MongoEval` y el rescate de cada barrido, sobre documentos. */
export function documentFlowMembers(model) {
  const members = [
    String.raw`// MongoEval ejecuta un script de mongosh contra la base de prueba y devuelve su salida en crudo: el Db de la rama
// relacional sobre documentos. Los nombres son los del DOCUMENTO (snake_case, _id) y un id va como UUID("…"). Es para lo
// que no se ve por HTTP; si el servicio lo expone por su API, se comprueba por ahí.
//
//	s.MongoEval(` + "`" + `db.getCollection("jobs").countDocuments({ status: "QUEUED" })` + "`" + `)
func (s *Scenario) MongoEval(script string) string {
	s.Helper()
	out, err := mongoEval(s.Context(), script)
	if err != nil {
		s.Fatal(err)
	}
	return out
}`
  ];
  members.push(...rescueMembers(model));
  members.push(...fireScheduleMember(model, rescueProbes(model).map((probe) => probe.operation)));
  members.push(...agingMembers(model));
  members.push(...fireAgedMember(model));
  // El plazo de negocio (DSL 2.26): AgeForDeadline envejece el since y el temporizador a la vez.
  members.push(...documentDeadlineAgingMembers(model));
  // El borrado lógico (DSL 2.28): AgeDeletion retrasa la marca de borrado de un documento ya borrado.
  members.push(...documentDeletionAgingMembers(model));
  // Quien mete un id en un script: el rescate, la reconciliación, los plazos y el borrado. Sin ninguno, sería una función sin usar.
  if (members.length > 1) {
    members.push(String.raw`func (s *Scenario) documentID(id string) string {
	s.Helper()
	valid, err := documentID(id)
	if err != nil {
		s.Fatal(err)
	}
	return valid
}`);
  }
  return members;
}

/** Las dos mitades de un script partido, como literal Go de un `scriptPair`. */
const pair = ({ prefix, suffix }) => `scriptPair{${goString(prefix)}, ${goString(suffix)}}`;

/**
 * El rescate de cada barrido que lo tiene, sobre documentos: los mismos tres ayudantes que la rama relacional, con los
 * scripts de setStateScript y missingClockCountScript. El reloj «rancio» es la época y el de «ahora», el instante de la
 * escritura: la diferencia es lo que separa rescatar de robarle el trabajo a quien lo está haciendo.
 */
function rescueMembers(model) {
  const probes = rescueProbes(model);
  if (probes.length === 0) return [];
  const rows = alignRows(
    probes.map((probe) => {
      const shape = { collection: probe.table, stateField: probe.stateColumn, state: probe.state, clockField: probe.clockColumn };
      return {
        indent: '\t',
        cells: [`${goString(probe.operation)}:`, `{${pair(setStateScript({ ...shape, clock: CLOCK.stale }))}, ${pair(setStateScript({ ...shape, clock: CLOCK.now }))}, ${goString(missingClockCountScript(shape))}},`]
      };
    })
  );
  const known = probes.map((probe) => probe.operation).join(', ');
  return [
    String.raw`// rescue son los scripts del rescate de un barrido: atascar un documento, ponerlo en vuelo ahora y contar los que quedaron
// en vuelo sin reloj.
type rescue struct {
	stall, put scriptPair
	missing    string
}

// rescues son los scripts del rescate de cada barrido que lo tiene: ${known}.
var rescues = map[string]rescue{
${rows.join('\n')}
}

// StallInFlight deja el documento id EN VUELO con el reloj infinitamente rancio: el estado exacto en el que queda una
// réplica que murió con él en la mano, que es lo que el rescate busca. ${
      fireScheduleMember(model, probes.map((probe) => probe.operation)).length > 0
        ? `Adelanta además el barrido en el cronómetro
// (FireTimer): vence ya y lo ejecuta UNA réplica en su próxima pasada`
        : `No dispara el barrido —lo dispara su cron, como en
// producción—`
    }, y no siembra el documento: mueve uno creado por la API.
func (s *Scenario) StallInFlight(operation, id string) {
	s.Helper()
	script := s.rescueOf(operation).stall
	s.MongoEval(script.prefix + s.documentID(id) + script.suffix)
${fireScheduleCall(model, probes.map((probe) => probe.operation), 'operation')}}

// PutInFlight es lo mismo con el reloj a AHORA: acaba de entrar en vuelo y hay alguien trabajando en él. Un rescate sin
// cota temporal pasa el escenario del rescate y falla aquí.
func (s *Scenario) PutInFlight(operation, id string) {
	s.Helper()
	script := s.rescueOf(operation).put
	s.MongoEval(script.prefix + s.documentID(id) + script.suffix)
${fireScheduleCall(model, probes.map((probe) => probe.operation), 'operation')}}

// InFlightWithoutClock es cuántos documentos quedaron EN VUELO sin reloj. Tiene que valer cero siempre. Vacío NO es
// cero: es un fallo del transporte, y se dice.
func (s *Scenario) InFlightWithoutClock(operation string) int {
	s.Helper()
	output := strings.Fields(s.MongoEval(s.rescueOf(operation).missing))
	if len(output) == 0 {
		s.Fatalf("la cuenta de documentos sin reloj de %s salió vacía", operation)
	}
	count, err := strconv.Atoi(output[len(output)-1])
	if err != nil {
		s.Fatalf("la cuenta de documentos sin reloj no es un número: %q", output)
	}
	return count
}

func (s *Scenario) rescueOf(operation string) rescue {
	s.Helper()
	scripts, ok := rescues[operation]
	if !ok {
		s.Fatalf("no hay rescate para el barrido %q. Los que lo tienen: ${known}", operation)
	}
	return scripts
}`
  ];
}

/**
 * `AgeForReconciliation` y `HoldFromReconciliation` sobre documentos: mueven SOLO la marca de espera de ese documento, con
 * los scripts de keel-core, los mismos que los otros tres.
 */
function agingMembers(model) {
  const targets = documentAgingTargets(model);
  if (targets.size === 0) return [];
  const known = [...targets.keys()].join(', ');
  const first = [...targets.keys()][0];
  const table = (name, script) =>
    `var ${name} = map[string][]scriptPair{\n${alignRows(
      [...targets].map(([activation, list]) => ({ indent: '\t', cells: [`${goString(activation)}:`, `{${list.map((target) => pair(script(target))).join(', ')}},`] }))
    ).join('\n')}\n}`;
  return [
    String.raw`// reconciliationAging son los scripts que envejecen la marca de espera de cada barrido, por activación: ${known}. El id va
// en medio.
${table('reconciliationAging', ageClockScript)}

// AgeForReconciliation deja la marca de espera de activation infinitamente rancia para el documento id, de modo que el
// barrido lo tome en SU PRÓXIMA PASADA. No dispara el barrido —lo dispara su cron, como en producción— y no toca el estado:
// el documento ya está donde el barrido lo busca. Bajar el umbral por configuración sería global.
//
//	s.AgeForReconciliation(${goString(first)}, id)
//	s.Eventually(func() bool { … }, 90*time.Second, "el barrido no tomó el documento")
func (s *Scenario) AgeForReconciliation(activation, id string) {
	s.Helper()
	s.reconciliationClock(reconciliationAging, activation, id)
${fireAgedCall(model, 'activation')}}

// reconciliationHolding son los scripts que dejan la marca de espera de cada barrido en el FUTURO.
${table('reconciliationHolding', holdClockScript)}

// HoldFromReconciliation es el inverso de AgeForReconciliation: deja la marca de espera de activation en el FUTURO para el
// documento id, de modo que el barrido NO lo tome aunque pasen sus ciclos. Es la palanca de un escenario que pide «lo que
// acaba de encargarse no se toca».
func (s *Scenario) HoldFromReconciliation(activation, id string) {
	s.Helper()
	s.reconciliationClock(reconciliationHolding, activation, id)
}

func (s *Scenario) reconciliationClock(scripts map[string][]scriptPair, activation, id string) {
	s.Helper()
	list, ok := scripts[activation]
	if !ok {
		s.Fatalf("no hay barrido para la activación %q. Las que lo tienen: ${known}", activation)
	}
	for _, script := range list {
		s.MongoEval(script.prefix + s.documentID(id) + script.suffix)
	}
}`
  ];
}

/** SMOKE-3 sobre documentos: la base responde a un script, por archivo e impreso. */
export function documentSmokeCase() {
  return String.raw`	f.Scenario("SMOKE-3: la base de prueba responde a un script", func(s *Scenario) {
		// Es la vía de los Then que miran el almacén y de las precondiciones del rescate: el script viaja por ARCHIVO e
		// impreso. Si esto no devuelve 1, devolverían vacío, que parece un cero.
		if got := strings.TrimSpace(s.MongoEval("db.runCommand({ ping: 1 }).ok")); got != "1" {
			s.Errorf("ping = %q, quiero \"1\"", got)
		}
	})`;
}

// ─── El outbox sobre documentos ──────────────────────────────────────────────────────────────────

/** La marca de los documentos aparcados: una fecha que ningún backoff alcanza (la de keel-dotnet). */
const PARKED = 'new Date("2999-01-01T00:00:00Z")';

/** Lo del outbox que el arnés de mensajería lee y fabrica en la base, con los scripts de mongo-probes.js. */
export function documentOutboxHelpers(abandonedAttempts) {
  const abandon = abandonOutboxScript(abandonedAttempts);
  const { collection, publishedAt, attempts } = OUTBOX;
  return {
    clear: `\ts.MongoEval(${goString(clearAbandonedScript(abandonedAttempts))})`,
    park: `
// parkScript aparca lo pendiente con presupuesto: una fecha de reintento que ningún backoff alcanza. El tope de intentos va
// en medio.
var parkScript = scriptPair{${goString(`db.getCollection("${collection}").updateMany({ ${publishedAt}: null, ${attempts}: { $lt: `)}, ${goString(` } }, { $set: { next_attempt_at: ${PARKED} } }).modifiedCount`)}}

func parkOutbox(ctx context.Context) error {
	_, err := mongoEval(ctx, parkScript.prefix+strconv.Itoa(maxAttempts())+parkScript.suffix)
	return err
}

func unparkOutbox(ctx context.Context) error {
	_, err := mongoEval(ctx, ${goString(`db.getCollection("${collection}").updateMany({ next_attempt_at: ${PARKED} }, { $set: { next_attempt_at: null } }).modifiedCount`)})
	return err
}
`,
    body: String.raw`// abandonScript agota el presupuesto de los pendientes de un tipo: el tipo va en medio.
var abandonScript = scriptPair{${goString(abandon.prefix)}, ${goString(abandon.suffix)}}

// scriptText es value como literal de texto de un script de mongosh (JSON: las comillas y las barras escapadas).
func scriptText(value string) string {
	quoted, err := json.Marshal(value)
	if err != nil {
		return "\"\""
	}
	return string(quoted)
}

// inScript es value dentro de un script partido que ya lo entrecomilla: el texto sin sus comillas de fuera.
func inScript(script scriptPair, value string) string {
	quoted := scriptText(value)
	return script.prefix + quoted[1:len(quoted)-1] + script.suffix
}

func queryCount(ctx context.Context, script string) (int64, error) {
	out, err := mongoEval(ctx, script)
	if err != nil {
		return 0, err
	}
	return countOf(out)
}

// awaitOutboxDrained espera a que no queden documentos del outbox sin entregar para este servicio. Un canal que no
// publicamos no pasa por nuestro outbox, y con el broker parado por el escenario los documentos esperan a propósito. El
// documento RENDIDO no cuenta: no va a salir nunca.
func awaitOutboxDrained(ctx context.Context, channel string) error {
	if !slices.Contains(publishedChannels, channel) || brokerStopped.Load() {
		return nil
	}
	// Por el destino FÍSICO que escribe el publicador (contar por el canal lógico daba cero siempre) y sin lo rendido.
	script := ${goString(`db.getCollection("${collection}").countDocuments({ ${OUTBOX.destination}: `)} + scriptText(outboxDestination()) + ${goString(`, ${publishedAt}: null, ${attempts}: { $lt: `)} + strconv.Itoa(maxAttempts()) + " } })"
	deadline := time.Now().Add(outboxDrainTimeout)
	for time.Now().Before(deadline) {
		pending, err := queryCount(ctx, script)
		if err != nil {
			return err
		}
		if pending == 0 {
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return nil
}

func deadLetteredEvents(ctx context.Context) (int64, error) {
	return queryCount(ctx, ${goString(`db.getCollection("${collection}").countDocuments({ ${publishedAt}: null, ${attempts}: { $gte: `)}+strconv.Itoa(maxAttempts())+" } })")
}

func abandonOutboxEvent(ctx context.Context, eventType string) error {
	pending, err := queryCount(ctx, ${goString(`db.getCollection("${collection}").countDocuments({ event_type: `)}+scriptText(eventType)+${goString(`, ${publishedAt}: null })`)})
	if err != nil {
		return err
	}
	if pending == 0 {
		return errors.New("no hay ningún evento " + eventType + " pendiente en el outbox que abandonar")
	}
	_, err = mongoEval(ctx, inScript(abandonScript, eventType))`
  };
}
