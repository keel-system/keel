// La sonda del cronómetro y de los plazos (DSL 2.26, PLAN-DSL-226-PLAZOS.md, incremento 6): `timer_probe_test.go`, en el
// paquete del motor, que db-check (relacional) y doc-check (documental) compilan junto a su sonda sobre el par
// verification-codes. El gemelo de keel-nest/scripts/lib/timer-probes.js y de keel-dotnet/scripts/lib/timer-probes.js: los
// mismos casos, con los mismos ids (keel-core/gen/deadlines.js, DEADLINE_CASES), y los mismos sabotajes, cada uno en
// exactamente sus casos.
//
// Ejecuta lo que build emitió —el rechazo tardío del dominio, el armado del adaptador, el almacén con las sentencias de
// keel-core, el sondeador y el handler del plazo— y no una copia: los nombres salen del MODELO. Lo que escribiría el
// agente —el método semántico de la entidad y el handler de la operación `by`— lo pone la sonda: dos métodos exportados
// de prueba en el archivo del agente de la entidad (`timerProbePatch`, que no lleva la cabecera de código generado) y un
// `CommandHandlerFunc` que hace lo que haría el handler de `by` (cargar, transicionar, guardar), salvo para el id del caso
// del aparcado.
//
// Cada prueba se llama `TestTimer_DL<n>_…` o `TestTimer_R<n>_…`: es lo que lee el veredicto de un sabotaje. Las pruebas de un
// paquete de Go corren en orden, así que comparten la base y la tabla keel_timer sin pisarse.

import { modelDeadlines, lateGuards, DEADLINE_SABOTAGES } from '@keel-system/keel-core/gen/deadlines';
import { timerStatements, KEEL_TIMER } from '@keel-system/keel-core/gen/timer-store';
import { repositoryRoots, usesDocument } from '@keel-system/keel-core/gen/features';
import { goExported } from '../../src/lib/go-projection.js';
import { goFile, goString } from '../../src/lib/go-source.js';
import { storeDir, sqlDialect } from '../../src/lib/relational-engine.js';
import { constantOf } from '../../src/scaffold/enums.js';
import { sentinelOf } from '../../src/scaffold/errors.js';
import { isOptional } from '../../src/scaffold/render.js';
import { repositoryArgs } from '../../src/scaffold/repositories.js';
import { messageComponents, messageType } from '../../src/scaffold/services.js';
import { parametersType } from '../../src/scaffold/service-parameters.js';
import { deadlineAccessor, deadlineHandlerType, deadlinesReadParameters, deadlinesType, kindConstant, usesDeadlines } from '../../src/scaffold/timer.js';

/** El sujeto: el primer plazo con rechazo tardío del diseño, con todo lo que la sonda nombra. */
export function timerSubject(model) {
  if (!usesDeadlines(model)) return null;
  const entry = modelDeadlines(model).find(({ entity }) => lateGuards(entity).length > 0) ?? modelDeadlines(model)[0];
  const { entity, deadline } = entry;
  const guard = lateGuards(entity).find((candidate) => candidate.from === deadline.state) ?? null;
  const lateTarget = entity.lifecycle.transitions.find((transition) => transition.from === deadline.state)?.to.find((state) => state !== deadline.to) ?? null;
  const by = (model.services ?? []).flatMap((service) => service.operations ?? []).find((operation) => operation.name === deadline.by);
  return { entity, deadline, guard, lateTarget, by };
}

// ─── Los sabotajes ───────────────────────────────────────────────────────────
//
// Con la forma de test/helpers/db-sabotages.js: en qué archivos, qué texto y qué sondas caen (`expect`, y `breaks`, los ids
// de keel-core, que tienen que caer TODOS: «exactamente sus casos»). dl-wrong-field y dl-app-clock no tienen sujeto aquí:
// la fixture solo tiene una marca de tiempo, y la red corre con la instancia y la base en la misma máquina.

const DOMAIN_ENTITY = /^internal\/domain\/\w+\.go$/;
const DEADLINE_HANDLER = /^internal\/infrastructure\/timer\/\w+_deadline\.go$/;
const TIMERS = /^internal\/infrastructure\/(?:postgres|mysql|mongo)\/timers\.go$/;
const GUARD = /if !(\w+\.\w+\.Add\(deadlines\.\w+\(\)\))\.After\(now\) \{/;
const REVALIDATION = /if !ok \|\| found\.\w+\(\) != [\w.]+ \{(\s*return Finished\(\), nil\s*\}\s*due := [^\n]*\n\s*)if due\.After\(dbNow\) \{/;

const expectOf = (ids) => new RegExp(ids.map((id) => `^TestTimer_${id.replace('-', '')}_`).join('|'));

function sabotage(id, spec) {
  const breaks = [...DEADLINE_SABOTAGES[id].breaks].sort();
  return { ...spec, breaks, expect: expectOf(breaks), ...(spec.documentBreaks ? { documentExpect: expectOf(spec.documentBreaks) } : {}) };
}

export const TIMER_SABOTAGES = Object.freeze({
  'dl-boundary': sabotage('dl-boundary', { files: DOMAIN_ENTITY, from: GUARD, to: 'if $1.Before(now) {' }),
  'dl-no-guard': sabotage('dl-no-guard', { files: DOMAIN_ENTITY, from: GUARD, to: 'if now.IsZero() {' }),
  'dl-no-revalidate': sabotage('dl-no-revalidate', { files: DEADLINE_HANDLER, from: REVALIDATION, to: 'if !ok {$1if due.After(dbNow.AddDate(1000, 0, 0)) {' }),
  'dl-no-lease': sabotage('dl-no-lease', {
    files: TIMERS,
    from: /"leaseMs": lease\.Milliseconds\(\)|bson\.A\{"\$\$NOW", lease\.Milliseconds\(\)\}/,
    to: (match) => match.replace('lease.Milliseconds()', 'int64(0)'),
    // Sin arriendo, el bucle de FindOneAndUpdate vuelve a llevarse en el MISMO lote lo que acaba de reclamar: cae además
    // DL-5 (en relacional el lote es una sola sentencia y no lo ve). Lo mismo que midieron keel-spring, keel-nest y keel-dotnet.
    documentBreaks: ['DL-5', ...DEADLINE_SABOTAGES['dl-no-lease'].breaks].sort()
  }),
  'dl-outside-tx': sabotage('dl-outside-tx', {
    files: TIMERS,
    // El armado fuera de la transacción del caso de uso: por la base y no por la transacción (relacional), o sin la sesión
    // (documental).
    from: /timerExec\(ctx, q, timerArm,|timers\.UpdateOne\(ctx, bson\.D\{\{Key: "_id", Value: timerID\(kind/,
    to: (match) => (match.startsWith('timerExec') ? 'timerExec(ctx, t.db, timerArm,' : match.replace('UpdateOne(ctx,', 'UpdateOne(outside(ctx),'))
  })
});

export const isTimerSabotage = (id) => Boolean(id && TIMER_SABOTAGES[id]);

/** Los casos que tienen que caer con el sabotaje en esa rama, y la expresión que los reconoce. */
export function timerSabotageBreaks(id, branch) {
  const spec = TIMER_SABOTAGES[id];
  return branch === 'document' && spec.documentBreaks ? { breaks: spec.documentBreaks, expect: spec.documentExpect } : { breaks: spec.breaks, expect: spec.expect };
}

/** ¿Cayeron TODOS los casos del sabotaje? (las pruebas en rojo, por su nombre `TestTimer_DL<n>_…`). */
export function timerBreaksCovered(failed, id, branch) {
  const { breaks } = timerSabotageBreaks(id, branch);
  const seen = new Set(failed.map((test) => /^TestTimer_(DL|R)(\d+)_/.exec(test)).filter(Boolean).map((m) => `${m[1]}-${m[2]}`));
  return breaks.filter((caseId) => !seen.has(caseId));
}

// ─── Lo que escribiría el agente ─────────────────────────────────────────────

/**
 * Los métodos semánticos de la sonda en el archivo del agente de la entidad (`<entidad>_behavior.go`, sin la cabecera):
 * `ProbeTransition` y, con rechazo tardío, `ProbeTransitionAt`. Devuelve el archivo parcheado.
 */
export function timerProbePatch(model, file) {
  const subject = timerSubject(model);
  if (!subject || typeof file.content !== 'string' || !/^internal\/domain\/\w+_behavior\.go$/.test(file.path)) return file;
  const { entity, guard } = subject;
  if (!file.content.includes(`// Lo que escribe el agente sobre ${entity.name}:`)) return file;
  if (!/^package domain\n/.test(file.content)) throw new Error(`timer-probes: el parche de la sonda no aplica en ${file.path}`);
  const enumType = entity.lifecycle.enumType;
  const methods = [
    `// ProbeTransition es la sonda del cronómetro (db-check/doc-check): el método semántico que escribiría el agente.
func (e *${entity.name}) ProbeTransition(target ${enumType}) error {
	return e.transitionTo(target)
}`
  ];
  if (guard) {
    methods.push(`// ProbeTransitionAt es la sonda del cronómetro con la hora y los plazos: el rechazo tardío.
func (e *${entity.name}) ProbeTransitionAt(target ${enumType}, now time.Time, deadlines ${deadlinesType(model)}) error {
	return e.transitionAt(target, now, deadlines)
}`);
  }
  const content = file.content.replace(/^package domain\n/, `package domain\n${guard ? '\nimport "time"\n' : ''}`);
  return { ...file, content: `${content.trimEnd()}\n\n${methods.join('\n\n')}\n` };
}

// ─── El archivo de la sonda ──────────────────────────────────────────────────

/** `timer_probe_test.go` en el paquete del motor, o null si el diseño no tiene plazos. */
export function timerProbeFile(model) {
  const subject = timerSubject(model);
  if (!subject) return null;
  const { entity, deadline, guard, lateTarget, by } = subject;
  const document = usesDocument(model);
  if (!repositoryRoots(model).some((root) => root.name === entity.name)) throw new Error(`timer-probes: ${entity.name} no es una raíz con repositorio`);
  const statusField = entity.fields.find((field) => field.name === entity.lifecycle.field);
  if (statusField && isOptional(statusField)) throw new Error(`timer-probes: el estado de ${entity.name} es opcional; la sonda no lo cubre`);
  const args = repositoryArgs(model, entity, 'probeTx', 'nil');
  if (args !== 'probeTx, deadlines') throw new Error(`timer-probes: el adaptador de ${entity.name} recibe ${args}; la sonda solo construye probeTx y deadlines`);
  const component = messageComponents(by, model)[0];
  const command = `application.${messageType(by)}`;
  const enumType = entity.lifecycle.enumType;
  const state = (constant) => `domain.${constantOf(model, enumType, constant)}`;
  const status = goExported(entity.lifecycle.field);
  const since = goExported(deadline.since);
  const plazo = deadlineAccessor(entity, deadline);
  const kind = `timer.${kindConstant(entity, deadline)}`;
  const repo = `New${entity.name}Repository(probeTx, deadlines)`;
  const params = model.service.parameters ?? [];
  const deadlinesValue = deadlinesReadParameters(model)
    ? `must(domain.New${deadlinesType(model)}(must(domain.New${parametersType(model)}(${params
        .map((parameter) => `ptr(${parameter.goType === 'string' ? goString(String(parameter.testValue)) : `${parameter.goType}(${parameter.testValue})`})`)
        .join(', ')}))))`
    : `must(domain.New${deadlinesType(model)}())`;
  const store = document
    ? {
        clear: `	if _, err := must(probeTx.collection(${goString(KEEL_TIMER.table)})).DeleteMany(t.Context(), bson.D{}); err != nil {
		t.Fatal(err)
	}`,
        count: `	n, err := must(probeTx.collection(${goString(KEEL_TIMER.table)})).CountDocuments(t.Context(), bson.D{{Key: "kind", Value: kind}})
	if err != nil {
		t.Fatal(err)
	}
	return n`,
        fire: `	if _, err := must(probeTx.collection(${goString(KEEL_TIMER.table)})).UpdateMany(t.Context(), bson.D{{Key: "kind", Value: kind}}, bson.D{{Key: "$set", Value: bson.D{{Key: "due_at", Value: bson.NewDateTimeFromTime(timerNow(t))}, {Key: "claimed_until", Value: nil}, {Key: "claim_token", Value: nil}}}}); err != nil {
		t.Fatal(err)
	}`
      }
    : {
        clear: `	timerRun(t, ${goString(`DELETE FROM ${KEEL_TIMER.table}`)}, nil)`,
        count: `	query, args, err := timerSQL(${goString(`SELECT count(*) FROM ${KEEL_TIMER.table} WHERE kind = :kind`)}, map[string]any{"kind": kind})
	if err != nil {
		t.Fatal(err)
	}
	var n int64
	if err := probeDB.QueryRowContext(t.Context(), query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n`,
        fire: `	timerRun(t, ${goString(timerStatements(sqlDialect(model).engine).fire)}, map[string]any{"kind": kind})`
      };
  const runHelper = document
    ? ''
    : `
// timerRun ejecuta una sentencia con marcadores nombrados, como el almacén (timerSQL).
func timerRun(t *testing.T, statement string, values map[string]any) {
	t.Helper()
	query, args, err := timerSQL(statement, values)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := probeDB.ExecContext(t.Context(), query, args...); err != nil {
		t.Fatal(err)
	}
}
`;
  const domainCases =
    guard && lateTarget
      ? `
func TestTimer_DL1_DentroDelPlazoLaTransicionTardiaSale(t *testing.T) {
	since := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	entity := timerEntity(t, ${state(deadline.state)}, since)
	if err := entity.ProbeTransitionAt(${state(lateTarget)}, since.Add(deadlines.${plazo}()-time.Millisecond), deadlines); err != nil {
		t.Fatalf("un milisegundo antes del vencimiento la transición tardía tiene que salir: %v", err)
	}
	if entity.${status}() != ${state(lateTarget)} {
		t.Fatalf("estado %v", entity.${status}())
	}
}

func TestTimer_DL2_EnElInstanteExactoSeRechaza(t *testing.T) {
	since := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	entity := timerEntity(t, ${state(deadline.state)}, since)
	err := entity.ProbeTransitionAt(${state(lateTarget)}, since.Add(deadlines.${plazo}()), deadlines)
	if !errors.Is(err, domain.${sentinelOf(guard.error)}) {
		t.Fatalf("en el instante exacto del vencimiento tiene que salir ${guard.error}, salió %v", err)
	}
	if entity.${status}() != ${state(deadline.state)} {
		t.Fatalf("una transición rechazada no mueve el estado: %v", entity.${status}())
	}
}

func TestTimer_DL3_PasadoElPlazoLaCaducidadSaleEnElDominio(t *testing.T) {
	since := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	entity := timerEntity(t, ${state(deadline.state)}, since)
	if err := entity.ProbeTransitionAt(${state(deadline.to)}, since.Add(deadlines.${plazo}()+time.Hour), deadlines); err != nil {
		t.Fatalf("pasado el plazo, la caducidad tiene que salir: %v", err)
	}
	if entity.${status}() != ${state(deadline.to)} {
		t.Fatalf("estado %v", entity.${status}())
	}
}
`
      : '';
  const lateMove = lateTarget
    ? `	repo := ${repo}
	found, ok, err := repo.FindByID(t.Context(), id)
	if err != nil || !ok {
		t.Fatalf("la entidad no está: %v", err)
	}
	if err := found.${guard ? `ProbeTransitionAt(${state(lateTarget)}, found.${since}(), deadlines)` : `ProbeTransition(${state(lateTarget)})`}; err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Save(t.Context(), found); err != nil {
		t.Fatal(err)
	}
`
    : '';
  const body = `
// La sonda del cronómetro y de los plazos (scripts/lib/timer-probes.js de keel-go): ${entity.name} en '${deadline.stateName}'.
// No es parte del proyecto generado.

// deadlines son los plazos vigentes con los parámetros de prueba: los recibe el adaptador de ${entity.name}.
var deadlines = ${deadlinesValue}

// timerFailID es la entidad cuyo despacho falla a propósito (el aparcado, DL-10); uuid.Nil, ninguna.
var timerFailID uuid.UUID

// timerSettings es la mecánica de la sonda: lo que el perfil leería de timer.yaml.
func timerSettings(maxAttempts int) timer.Settings {
	return timer.Settings{Enabled: true, MaxSleep: 30 * time.Second, BatchSize: 50, Lease: time.Minute, MaxAttempts: maxAttempts, RetentionDays: 7, PurgeCron: "0 30 5 * * *"}
}

// timerExpire es lo que escribiría el agente en el handler de ${deadline.by}: cargar, transicionar y guardar.
func timerExpire() application.CommandHandler[${command}] {
	return application.CommandHandlerFunc[${command}](func(ctx context.Context, cmd ${command}) error {
		if cmd.${goExported(component.name)} == timerFailID {
			return errors.New("fallo de prueba del cronómetro")
		}
		repo := ${repo}
		found, ok, err := repo.FindByID(ctx, cmd.${goExported(component.name)})
		if err != nil {
			return err
		}
		if !ok {
			return errors.New("la entidad no está")
		}
		if err := found.ProbeTransition(${state(deadline.to)}); err != nil {
			return err
		}
		_, err = repo.Save(ctx, found)
		return err
	})
}

// timerPoller es el sondeador emitido, con el handler del plazo y la purga de la tabla.
func timerPoller(t *testing.T, maxAttempts int) *timer.Poller {
	t.Helper()
	store := NewTimerStore(probeTx)
	settings := timerSettings(maxAttempts)
	handlers := []timer.Handler{
		timer.New${deadlineHandlerType(entity, deadline)}(${repo}, timerExpire(), deadlines),
		must(timer.NewTimerPurge(store, settings)),
	}
	return must(timer.NewPoller(store, handlers, settings, slog.New(slog.DiscardHandler)))
}

// timerEntity es una muestra de ${entity.name} en un estado y con su ${deadline.since}.
func timerEntity(t *testing.T, status domain.${enumType}, since time.Time) *domain.${entity.name} {
	t.Helper()
	state := sample${entity.name}(t, 900+int(probeSeq.Add(1)))
	state.${goExported(entity.idField?.name ?? 'id')} = uuid.Must(uuid.NewV7())
	state.${status} = status
	state.${since} = since
	return domain.Rehydrate${entity.name}(state)
}

// timerStart deja la tabla vacía y sin fallo forzado: los demás casos de la sonda también arman.
func timerStart(t *testing.T) {
	t.Helper()
	timerFailID = uuid.Nil
${store.clear}
}
${runHelper}
// timerCount son los temporizadores de un kind.
func timerCount(t *testing.T, kind string) int64 {
	t.Helper()
${store.count}
}

// timerFire adelanta los temporizadores de un kind a ahora, libres.
func timerFire(t *testing.T, kind string) {
	t.Helper()
${store.fire}
}

// timerNow es la hora de la base.
func timerNow(t *testing.T) time.Time {
	t.Helper()
	return must(NewTimerStore(probeTx).DBNow(t.Context()))
}

// timerSave guarda la entidad por el adaptador, que es lo que arma el temporizador.
func timerSave(t *testing.T, status domain.${enumType}, since time.Time) uuid.UUID {
	t.Helper()
	entity := timerEntity(t, status, since)
	if _, err := ${repo}.Save(t.Context(), entity); err != nil {
		t.Fatal(err)
	}
	return entity.${goExported(entity.idField?.name ?? 'id')}()
}

// timerExpired guarda una entidad cuyo plazo venció hace ago, con la hora de la base.
func timerExpired(t *testing.T, ago time.Duration) uuid.UUID {
	t.Helper()
	return timerSave(t, ${state(deadline.state)}, timerNow(t).Add(-deadlines.${plazo}()-ago))
}

// timerState es el estado guardado de una entidad.
func timerState(t *testing.T, id uuid.UUID) domain.${enumType} {
	t.Helper()
	found, ok, err := ${repo}.FindByID(t.Context(), id)
	if err != nil || !ok {
		t.Fatalf("la entidad %s no está: %v", id, err)
	}
	return found.${status}()
}

// timerClaim reclama como una réplica.
func timerClaim(t *testing.T, limit int, lease time.Duration) []timer.Claimed {
	t.Helper()
	return must(NewTimerStore(probeTx).Claim(t.Context(), []string{${kind}}, limit, lease, uuid.New()))
}
${domainCases}
func TestTimer_DL4_ElArmadoVaEnLaTransaccionDeLaEntidad(t *testing.T) {
	timerStart(t)
	timerSave(t, ${state(deadline.state)}, timerNow(t))
	if n := timerCount(t, ${kind}); n != 1 {
		t.Fatalf("guardar una entidad que entra en '${deadline.stateName}' arma su temporizador: %d", n)
	}
	now := timerNow(t)
	err := probeTx.Within(t.Context(), application.KindCommand, func(ctx context.Context) error {
		if _, err := ${repo}.Save(ctx, timerEntity(t, ${state(deadline.state)}, now)); err != nil {
			return err
		}
		return errors.New("revierte")
	})
	if err == nil {
		t.Fatal("la transacción tenía que revertir")
	}
	if n := timerCount(t, ${kind}); n != 1 {
		t.Fatalf("si la transacción revierte, no queda temporizador: %d", n)
	}
}

func TestTimer_DL5_ElReclamoSeLlevaLoVencidoEnOrden(t *testing.T) {
	timerStart(t)
	oldest := timerExpired(t, 30*time.Minute)
	recent := timerExpired(t, 5*time.Minute)
	timerSave(t, ${state(deadline.state)}, timerNow(t))
	claimed := timerClaim(t, 10, time.Minute)
	if len(claimed) != 2 || claimed[0].EntityID != oldest || claimed[1].EntityID != recent {
		t.Fatalf("el reclamo se lleva los dos vencidos, en orden de vencimiento: %+v", claimed)
	}
}

func TestTimer_DL6_DosReplicasNoReclamanLoMismo(t *testing.T) {
	timerStart(t)
	for range 20 {
		timerExpired(t, time.Minute)
	}
	var (
		wg     sync.WaitGroup
		mu     sync.Mutex
		total  int
		unique = map[string]bool{}
	)
	for range 2 {
		wg.Go(func() {
			claimed, err := NewTimerStore(probeTx).Claim(t.Context(), []string{${kind}}, 20, time.Minute, uuid.New())
			if err != nil {
				t.Error(err)
				return
			}
			mu.Lock()
			defer mu.Unlock()
			total += len(claimed)
			for _, one := range claimed {
				unique[one.ID] = true
			}
		})
	}
	wg.Wait()
	if total != len(unique) || len(unique) != 20 {
		t.Fatalf("dos réplicas a la vez: %d reclamados, %d distintos (tienen que ser 20 y 20)", total, len(unique))
	}
	if again := timerClaim(t, 20, time.Minute); len(again) != 0 {
		t.Fatalf("lo arrendado no vuelve a reclamarse antes de que venza su arriendo: %d", len(again))
	}
}

func TestTimer_DL7_VencidoElArriendoOtraReplicaLoRetoma(t *testing.T) {
	timerStart(t)
	timerExpired(t, time.Minute)
	if n := len(timerClaim(t, 10, 400*time.Millisecond)); n != 1 {
		t.Fatalf("una réplica lo reclama: %d", n)
	}
	if n := len(timerClaim(t, 10, 400*time.Millisecond)); n != 0 {
		t.Fatalf("otra no se lo quita con el arriendo en vigor: %d", n)
	}
	time.Sleep(time.Second)
	if n := len(timerClaim(t, 10, 400*time.Millisecond)); n != 1 {
		t.Fatalf("vencido el arriendo, otra réplica lo retoma: %d", n)
	}
}

func TestTimer_DL8_ElTemporizadorDeUnaEntidadQueYaSalioSeDescarta(t *testing.T) {
	timerStart(t)
	id := timerExpired(t, time.Minute)
${lateMove}	if _, err := timerPoller(t, 10).PollOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if n := timerCount(t, ${kind}); n != 0 {
		t.Fatalf("el temporizador de una entidad que ya salió del estado se descarta: %d", n)
	}
	if got := timerState(t, id); got != ${state(lateTarget ?? deadline.to)} {
		t.Fatalf("el cronómetro no mueve una entidad que ya no está en '${deadline.stateName}': %v", got)
	}
}

func TestTimer_DL9_ConElPlazoVigenteSinVencerSeRearma(t *testing.T) {
	timerStart(t)
	id := timerSave(t, ${state(deadline.state)}, timerNow(t))
	timerFire(t, ${kind})
	if _, err := timerPoller(t, 10).PollOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := timerState(t, id); got != ${state(deadline.state)} {
		t.Fatalf("con el plazo vigente sin vencer, el cronómetro no caduca la entidad: %v", got)
	}
	if n := timerCount(t, ${kind}); n != 1 {
		t.Fatalf("el temporizador se rearma en vez de borrarse: %d", n)
	}
	if n := len(timerClaim(t, 10, time.Minute)); n != 0 {
		t.Fatalf("rearmado al vencimiento vigente, no se puede reclamar ya: %d", n)
	}
}

func TestTimer_DL3_VencidoElPlazoElCronometroDespacha(t *testing.T) {
	timerStart(t)
	id := timerExpired(t, time.Minute)
	if _, err := timerPoller(t, 10).PollOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := timerState(t, id); got != ${state(deadline.to)} {
		t.Fatalf("vencido el plazo, el cronómetro despacha y la entidad pasa a '${deadline.toName}': %v", got)
	}
	if n := timerCount(t, ${kind}); n != 0 {
		t.Fatalf("el temporizador cumplido se borra: %d", n)
	}
}

func TestTimer_DL10_ElSondeadorDuermeHastaLoProximo(t *testing.T) {
	timerStart(t)
	timerSave(t, ${state(deadline.state)}, timerNow(t).Add(-deadlines.${plazo}()+5*time.Second))
	poller := timerPoller(t, 10)
	sleep, err := poller.PollOnce(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if sleep <= 2*time.Second || sleep > 5500*time.Millisecond {
		t.Fatalf("con un vencimiento a 5 s, el sondeador duerme hasta él: %v", sleep)
	}
	timerStart(t)
	if sleep := must(poller.PollOnce(t.Context())); sleep != 30*time.Second {
		t.Fatalf("sin nada pendiente, el sueño es el tope: %v", sleep)
	}
	now := time.Now()
	poller.Armed(now.Add(30 * time.Second))
	poller.Armed(now.Add(time.Second))
	poller.Armed(now.Add(10 * time.Second))
	if !poller.WakeAt().Equal(now.Add(time.Second)) {
		t.Fatalf("armar uno que vence antes adelanta el despertar, y uno que vence después no lo retrasa: %v", poller.WakeAt().Sub(now))
	}
}

func TestTimer_DL10_AgotadosLosIntentosSeAparca(t *testing.T) {
	timerStart(t)
	id := timerExpired(t, time.Minute)
	timerFailID = id
	poller := timerPoller(t, 2)
	store := NewTimerStore(probeTx)
	before := must(store.ParkedCount(t.Context()))
	if _, err := poller.PollOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if n := must(store.ParkedCount(t.Context())); n != before {
		t.Fatalf("no aparca al primer fallo: %d", n)
	}
	if _, err := poller.PollOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if n := must(store.ParkedCount(t.Context())); n != before+1 {
		t.Fatalf("agotados los intentos, el temporizador se aparca: %d", n)
	}
	if got := timerState(t, id); got != ${state(deadline.state)} {
		t.Fatalf("el aparcado no mueve la entidad: %v", got)
	}
}

func TestTimer_R1_LosRecurrentesSeAseguranUnaSolaVez(t *testing.T) {
	timerStart(t)
	poller := timerPoller(t, 10)
	for range 2 {
		if err := poller.EnsureRecurring(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if n := timerCount(t, timer.KindTimerPurge); n != 1 {
		t.Fatalf("la purga de la tabla queda asegurada como un recurrente, una sola vez: %d", n)
	}
}
`;
  const imports = [
    'context',
    'errors',
    'log/slog',
    'sync',
    'testing',
    'time',
    'github.com/google/uuid',
    ...(document ? ['go.mongodb.org/mongo-driver/v2/bson'] : []),
    'internal/application',
    'internal/domain',
    'internal/infrastructure/timer'
  ];
  const dir = storeDir(model);
  return { path: `${dir}/timer_probe_test.go`, content: goFile({ pkg: dir.split('/').pop(), imports, body, module: model.service.goModule, generated: false }) };
}
