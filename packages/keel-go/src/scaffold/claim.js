// El RECLAMO de un barrido (tramo 10c): llevarse un lote de filas pendientes de forma que dos réplicas nunca se lleven la
// misma. Es el mismo mecanismo que generan keel-spring, keel-nest y keel-dotnet, sobre database/sql y PostgreSQL o MySQL
// (en MySQL la transacción del reclamo va en READ COMMITTED).
//
// Por qué lo genera build y no el agente: el reloj dispara el barrido en TODAS las réplicas, y el camino de menor
// resistencia para quien escribe el handler a mano —leer el lote con un finder por estado y marcarlo después— sale verde
// con una sola instancia y se lo da entero a todas en producción.
//
// Dos capas, como en los otros tres:
//   · llevarse la fila: un UPDATE condicional (`… WHERE id = $n AND estado IN (…)`). Una fila afectada = es mía; cero =
//     otra réplica llegó antes. La marca es el PROPIO estado de destino del diseño;
//   · elegir a qué filas tirarle: la lectura con FOR UPDATE SKIP LOCKED, para que cada réplica reciba candidatos
//     distintos. Es una optimización: el reclamo es correcto sin ella.
// Y dos sujetos: la COLA (filas que esperan) y el RESCATE de un estado en vuelo (`claim.stalled`), que lleva una cota
// temporal —sin ella, reclamar es arrancarle el trabajo a quien lo está haciendo— y que NO cambia el estado: lo ARRIENDA
// renovando su reloj; la transición la hace el dominio, que fija los campos que exige.
//
// Qué reclama cada barrido, en qué orden y de qué claves salen el lote y el plazo lo decide keel-core
// (`operation.claim[]`, `claimOrderField`, `sweepConfig`). El SQL va LITERAL: la tabla, las columnas y las constantes
// del estado son del generador, y solo los instantes, el lote y el id viajan como parámetro. Ninguno de los cuatro
// generadores sube la versión del bloqueo optimista en el reclamo.
//
// Lo propio de Go: el reclamo confirma en una transacción NUEVA (`Transactions.fresh`) y se niega a correr con una
// abierta en el contexto, porque se uniría a ella y el reclamo no existiría para nadie hasta el commit final.

import { claimOrderField, claimsForEntity, screamingSnake, snakeCase, sweepClaims, sweepConfig } from '@keel-system/keel-core/gen';
import { envWithDefault } from '@keel-system/keel-core/gen/profile-values';
import { usesPersistence, usesRelational } from '@keel-system/keel-core/gen/features';
import { goExported } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { sqlDialect } from '../lib/relational-engine.js';
import { layout, packageFile } from './render.js';
import { parameterAccessor, parametersType } from './service-parameters.js';
import { usesDependencies } from './use-cases.js';
import { usesReconciliationClaims } from './reconciliation-claim.js';
import { sweepPassSignal } from './timer.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

/** ¿Genera build algún reclamo de barrido? Con persistencia (relacional o documental) y los casos de uso cableados. */
export function usesSweepClaims(model) {
  return usesPersistence(model) && usesDependencies(model) && sweepClaims(model).length > 0;
}

/** El método Go de un reclamo: `ClaimForDispatchJobsRunning`. */
export const claimMethod = (claim) => goExported(claim.method);

/** ¿Hacen falta los ayudantes de un reclamo (claims.go)? Los usan el de barrido y el de reconciliación. */
export function usesClaimHelpers(model) {
  // Los documentales no los necesitan: FindOneAndUpdate elige y marca en una operación (document-repositories.js).
  return usesRelational(model) && (usesSweepClaims(model) || usesReconciliationClaims(model));
}

export function generate(model) {
  const files = [];
  const { store } = layout(model);
  if (usesClaimHelpers(model)) files.push({ path: `${store.dir}/claims.go`, content: packageFile(model, store, { imports: ['context', 'database/sql', 'fmt'], body: helpersBody(model) }) });
  if (!usesSweepClaims(model)) return files;
  return [
    ...files,
    { path: `${store.dir}/sweep.go`, content: packageFile(model, store, { imports: ['fmt', 'strconv', 'strings', 'internal/platform/config'], body: sweepBody(model) }) },
    { path: `${store.dir}/sweep_test.go`, content: packageFile(model, store, { test: true, imports: ['strings', 'testing', 'testing/fstest', store.dir, 'internal/platform/config'], body: sweepTest(model) }) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/sweep.yaml`, content: sweepYaml(model, profile) }))
  ];
}

/** El MISMO texto que el sweep.yaml de keel-nest y keel-dotnet. */
export function sweepYaml(model, profile) {
  const lines = ['sweep:'];
  for (const { key, entries } of sweepConfig(model)) {
    lines.push(`  ${key}:`);
    for (const entry of entries) {
      if (entry.kind === 'batch') {
        lines.push(
          '    # Cota del lote por pasada: capacidad, no diseño; misma familia que outbox.relay.batch-size.',
          `    batch-size: ${envWithDefault(profile, entry.env, entry.default)}`
        );
      } else {
        lines.push(
          `    # ${entry.operation.name}: un ${entry.claim.entity} que lleva más de esto en ${entry.claim.stalled.state} (medido sobre`,
          `    # ${entry.claim.stalled.stampField}) se da por abandonado y otra réplica lo rescata. Por ENCIMA de un ciclo completo.`,
          `    stalled-after-seconds: ${envWithDefault(profile, entry.env, entry.default)}`
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Las entradas de una clase (`batch` o `stalled`) de sweep.*, con su bloque. */
function entriesOf(model, kind) {
  return sweepConfig(model).flatMap(({ key, entries }) => entries.filter((entry) => entry.kind === kind).map((entry) => ({ key, entry })));
}

// ─── sweep.go ────────────────────────────────────────────────────────────────────────────────────

function sweepBody(model) {
  const literal = (kind) => {
    const rows = alignRows(entriesOf(model, kind).map(({ key, entry }) => ({ indent: '\t\t', cells: [`${goString(key)}:`, `${entry.default},`] })));
    return rows.length > 0 ? `map[string]int{\n${rows.join('\n')}\n\t}` : 'map[string]int{}';
  };
  return `
// SweepSettings son los barridos del perfil activo (config/parameters/<perfil>/sweep.yaml), con las claves y los
// defaults de los servidores de keel-spring, keel-nest y keel-dotnet.
type SweepSettings struct {
	// BatchSize es la cota del lote de cada barrido, por su clave (sweep.<clave>.batch-size).
	BatchSize map[string]int
	// StalledAfterSeconds es el plazo de abandono de cada rescate que no lee el suyo de un parámetro del diseño
	// (sweep.<clave>.stalled-after-seconds).
	StalledAfterSeconds map[string]int
}

// DefaultSweepSettings son los barridos sin configuración: los defaults de los cuatro servidores.
func DefaultSweepSettings() SweepSettings {
	batch := ${literal('batch')}
	stalled := ${literal('stalled')}
	return SweepSettings{BatchSize: batch, StalledAfterSeconds: stalled}
}

// SweepSettingsFrom lee los barridos del perfil al ARRANCAR: un valor que no es un entero positivo no deja arrancar.
func SweepSettingsFrom(cfg *config.Config) (SweepSettings, error) {
	settings := DefaultSweepSettings()
	blocks := []struct {
		leaf   string
		values map[string]int
	}{
		{"batch-size", settings.BatchSize},
		{"stalled-after-seconds", settings.StalledAfterSeconds},
	}
	for _, block := range blocks {
		for key, fallback := range block.values {
			name := "sweep." + key + "." + block.leaf
			value, ok := cfg.Value(name)
			if !ok || strings.TrimSpace(value) == "" {
				continue
			}
			n, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil || n <= 0 {
				return SweepSettings{}, fmt.Errorf("%s tiene que ser un entero positivo: %q (default %d)", name, value, fallback)
			}
			block.values[key] = n
		}
	}
	return settings, nil
}
`;
}

function sweepTest(model) {
  const { store } = layout(model);
  const batch = entriesOf(model, 'batch')[0];
  const stalled = entriesOf(model, 'stalled')[0];
  const fragment = `sweep:\n  ${batch.key}:\n    batch-size: 7\n`;
  const stalledCheck = stalled
    ? `
	if got := settings.StalledAfterSeconds[${goString(stalled.key)}]; got != ${stalled.entry.default} {
		t.Errorf("StalledAfterSeconds[%q] = %d, quiero el default ${stalled.entry.default}", ${goString(stalled.key)}, got)
	}`
    : '';
  return `
// load es la configuración con application.yaml y un fragmento del perfil por defecto con fragment dentro.
func load(t *testing.T, fragment string) *config.Config {
	t.Helper()
	fsys := fstest.MapFS{
		"application.yaml":            {Data: []byte("server:\\n  port: 8080\\n")},
		"parameters/local/sweep.yaml": {Data: []byte(fragment)},
	}
	cfg, err := config.Load(fsys, func(string) string { return "" })
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return cfg
}

func TestSweepSettingsFromReadsTheProfile(t *testing.T) {
	settings, err := ${store.name}.SweepSettingsFrom(load(t, ${goString(fragment)}))
	if err != nil {
		t.Fatalf("SweepSettingsFrom = %v", err)
	}
	if got := settings.BatchSize[${goString(batch.key)}]; got != 7 {
		t.Errorf("BatchSize[%q] = %d, quiero 7", ${goString(batch.key)}, got)
	}${stalledCheck}
}

func TestSweepSettingsFromRefusesANonPositiveValue(t *testing.T) {
	_, err := ${store.name}.SweepSettingsFrom(load(t, ${goString(`sweep:\n  ${batch.key}:\n    batch-size: 0\n`)}))
	if err == nil || !strings.Contains(err.Error(), ${goString(`sweep.${batch.key}.batch-size`)}) {
		t.Errorf("SweepSettingsFrom = %v, quiero el error de sweep.${batch.key}.batch-size", err)
	}
}
`;
}

// ─── claims.go ───────────────────────────────────────────────────────────────────────────────────

function helpersBody(model) {
  const d = sqlDialect(model);
  const isolation = d.mysql
    ? `// claimOptions son las de la transacción de un reclamo: READ COMMITTED, como en keel-nest y keel-dotnet. En REPEATABLE
// READ, el aislamiento por defecto de MySQL, el UPDATE condicional bloquea también los huecos del índice que recorre, y
// dos réplicas a la vez se esperan en vez de repartirse el lote.
var claimOptions = sql.TxOptions{Isolation: sql.LevelReadCommitted}`
    : `// claimOptions son las de la transacción de un reclamo: el READ COMMITTED por defecto de PostgreSQL, en el que el
// UPDATE condicional vuelve a evaluar su WHERE sobre la versión confirmada de la fila.
var claimOptions = sql.TxOptions{}`;
  return `
${isolation}

// ownTransaction dice si method puede reclamar: un reclamo confirma en SU transacción antes de devolver las filas, y
// dentro de otra se uniría a ella; el reclamo no existiría para ninguna otra réplica hasta el commit final, así que todas
// actuarían sobre los mismos candidatos.
func ownTransaction(ctx context.Context, method string) error {
	if openTx(ctx) != nil {
		return fmt.Errorf("%s confirma en su propia transacción y hay una abierta: despacha la operación con application.WithoutTransaction (el reloj ya lo hace)", method)
	}
	return nil
}

// claimCandidates lee los ids de los candidatos de un reclamo. La consulta los bloquea con SKIP LOCKED hasta el final de
// la transacción del reclamo, así que otra réplica recibe candidatos DISTINTOS en vez de pelearse por la misma página.
func claimCandidates[ID any](ctx context.Context, q DBTX, query string, args ...any) ([]ID, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []ID
	for rows.Next() {
		var id ID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
`;
}

// ─── El puerto ───────────────────────────────────────────────────────────────────────────────────

/** Los métodos de reclamo del puerto `<Raíz>Repository`, como [doc, firma], con lo que el agente tiene que saber. */
export function portClaimMethods(model, entity) {
  return claimsForEntity(model, entity.name).map((claim) => [wrap(describe(claim, entity.name)), `${claimMethod(claim)}(ctx context.Context) ([]*${entity.name}, error)`]);
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

function describe(claim, entityName) {
  const stamp = claim.stamps
    ? ` Devuelve las filas con ${claim.stamps.field} YA estampado, en el mismo UPDATE que el cambio de estado, porque ${claim.stamps.reason} consulta esa marca. No la vuelvas a poner desde el handler: una caída entre las dos escrituras dejaría la fila con la marca a cero, invisible para siempre a quien la busca por antigüedad.`
    : '';
  const own =
    ' Confirma en SU PROPIA transacción, así que no corre dentro de otra: la tarea del reloj despacha su operación con application.WithoutTransaction, y llamarlo con una transacción abierta devuelve un error en vez de unirse a ella.';
  if (claim.stalled) {
    const deadline = claim.stalled.parameter
      ? `el parámetro del diseño ${claim.stalled.parameter.name} (en ${claim.stalled.parameter.unit})`
      : `sweep.${claim.stalled.configKey}.stalled-after-seconds`;
    return (
      `rescata hasta el lote de ${entityName} ATASCADOS en ${claim.stalled.state}: los devuelve SIGUIENDO en ${claim.stalled.state}, con ${claim.stalled.stampField} renovado, para que el handler los pase a ${claim.to}. ` +
      'Reclama, no lee: puede correr a la vez en varias réplicas (en todas con el reloj; con el cronómetro, cuando un tick se repite al vencer su arriendo), y solo devuelve lo que ESTA se llevó (un UPDATE condicional que solo casa si la fila sigue atascada, y que renueva el reloj). ' +
      `No cambia el estado, lo ARRIENDA: la transición a ${claim.to} es del dominio, que fija los campos que ese estado exige; si el ciclo muere entre el reclamo y la transición, la fila sigue en ${claim.stalled.state} con el reloj renovado y otro rescate la recoge pasado el plazo. ` +
      `Solo se lleva lo ABANDONADO: ${claim.stalled.stampField} más viejo que ${deadline}. Lo que devuelve es trabajo que alguien dejó a medias: si el ciclo que murió ya produjo un efecto irreversible, repetirlo lo duplica.${stamp}${own}`
    );
  }
  const due = claim.due ? ` Solo los que ya vencieron (${claim.due.field} <= ahora).` : '';
  return (
    `reclama hasta el lote de ${entityName} en ${claim.from.join(' o ')} y los pasa a ${claim.to}.${due} ` +
    `Reclama, no lee: puede correr a la vez en varias réplicas (en todas con el reloj; con el cronómetro, cuando un tick se repite al vencer su arriendo), y lo que devuelve son SOLO las filas que ESTA se llevó (el paso a ${claim.to} va en un UPDATE condicional). Leer el lote con un finder y marcarlo después se lo daría entero a todas. Actúa sobre lo que devuelve FUERA de su transacción.${stamp}${own}`
  );
}

// ─── El adaptador ────────────────────────────────────────────────────────────────────────────────

/** Lo que el adaptador de una raíz recibe para sus reclamos: los barridos y, si un rescate lee su plazo de uno, los parámetros. */
export function claimDependencies(model, entity) {
  if (!usesSweepClaims(model)) return [];
  const claims = claimsForEntity(model, entity.name);
  if (claims.length === 0) return [];
  const deps = [{ field: 'sweeps', type: 'SweepSettings', arg: 'sweeps' }];
  if (claims.some((claim) => claim.stalled?.parameter)) deps.push({ field: 'parameters', type: `domain.${parametersType(model)}`, arg: 'parameters' });
  return deps;
}

/** El valor GUARDADO de un estado del ciclo de vida de la entidad: la constante de su enum (`QUEUED`). */
export function storedState(model, entity, state) {
  const enumDef = (model.enums ?? []).find((candidate) => candidate.name === entity.lifecycle?.enumType);
  return enumDef?.values.find((value) => value.literal === state)?.constant ?? screamingSnake(state);
}

/**
 * Las dos sentencias de un reclamo, con sus argumentos en orden (el `?` de MySQL es posicional): la lectura de los
 * candidatos y el UPDATE condicional de una fila. Las comparten el adaptador y las pruebas.
 */
export function claimStatements(model, entity, claim) {
  const d = sqlDialect(model);
  const q = (field) => d.quote(snakeCase(field));
  const table = d.quote(entity.tableName);
  const states = claim.from.map((state) => `'${storedState(model, entity, state)}'`).join(', ');
  const stateColumn = q(entity.lifecycle.field);
  const idColumn = q(entity.idField?.name ?? 'id');
  const conditions = (next) => {
    const where = [`${stateColumn} IN (${states})`];
    const args = [];
    if (claim.stalled) {
      where.push(`${q(claim.stalled.stampField)} < ${next()}`);
      args.push('staleBefore');
    }
    if (claim.due) {
      where.push(`${q(claim.due.field)} <= ${next()}`);
      args.push('now');
    }
    return { where, args };
  };
  // La lectura de los candidatos, del más antiguo al más nuevo.
  let n = 0;
  const nextRead = () => d.param(++n);
  const read = conditions(nextRead);
  const candidates = `SELECT ${idColumn} FROM ${table} WHERE ${read.where.join(' AND ')} ORDER BY ${q(claimOrderField(entity, claim))} LIMIT ${nextRead()} FOR UPDATE SKIP LOCKED`;
  // El UPDATE de una fila: el estado de destino y su reloj, o solo el reloj en el rescate.
  n = 0;
  const nextWrite = () => d.param(++n);
  const set = [];
  const setArgs = [];
  if (claim.stalled) {
    set.push(`${q(claim.stalled.stampField)} = ${nextWrite()}`);
    setArgs.push('claimedAt');
  } else {
    set.push(`${stateColumn} = '${storedState(model, entity, claim.to)}'`);
    if (claim.stamps) {
      set.push(`${q(claim.stamps.field)} = ${nextWrite()}`);
      setArgs.push('claimedAt');
    }
  }
  const idParam = nextWrite();
  const write = conditions(nextWrite);
  const update = `UPDATE ${table} SET ${set.join(', ')} WHERE ${idColumn} = ${idParam} AND ${write.where.join(' AND ')}`;
  return {
    candidates,
    candidateArgs: [...read.args, 'batch'],
    update,
    updateArgs: [...setArgs, 'id', ...write.args],
    reload: `WHERE ${idColumn} = ${d.param(1)}`
  };
}

/** Los métodos de reclamo del adaptador, sobre `load` y las transacciones del propio adaptador. */
export function adapterClaimMethods(model, entity, type) {
  const idType = entity.idField?.goType ?? 'uuid.UUID';
  return claimsForEntity(model, entity.name).map((claim) => {
    const method = claimMethod(claim);
    const sql = claimStatements(model, entity, claim);
    const setup = [`\tbatch := r.sweeps.BatchSize[${goString(claim.sweepKey)}]`];
    if (claim.stalled) {
      const seconds = claim.stalled.parameter
        ? `time.Duration(r.parameters.${parameterAccessor({ name: claim.stalled.parameter.name })}()) * ${claim.stalled.parameter.unitSeconds} * time.Second`
        : `time.Duration(r.sweeps.StalledAfterSeconds[${goString(claim.stalled.configKey)}]) * time.Second`;
      setup.push(
        '\t// La cota del rescate: solo lo que lleva atascado más que el plazo. Se calcula UNA vez para la lectura y para cada',
        '\t// UPDATE: recalcularla movería la cota entre los dos.',
        `\tstaleBefore := time.Now().UTC().Add(-${seconds})`
      );
    }
    if (claim.due) setup.push(`\t// Solo lo que ya venció (${claim.due.field} <= ahora).`, '\tnow := time.Now().UTC()');
    // El instante con el que se estampa o se arrienda: uno por tanda.
    if (claim.stamps || claim.stalled) setup.push('\tclaimedAt := time.Now().UTC()');
    const what = claim.stalled
      ? `renueva ${claim.stalled.stampField} SOLO si la fila sigue atascada en ${claim.stalled.state}; el estado no se toca`
      : `pasa la fila a ${claim.to} SOLO si sigue en su estado de partida`;
    return `// ${method} implementa domain.${entity.name}Repository (${claim.stalled ? 'rescate' : 'cola'}).
func (r *${type}) ${method}(ctx context.Context) ([]*domain.${entity.name}, error) {
	if err := ownTransaction(ctx, ${goString(method)}); err != nil {
		return nil, err
	}
${setup.join('\n')}
	var claimed []*domain.${entity.name}
	err := r.tx.fresh(ctx, claimOptions, func(ctx context.Context, q DBTX) error {
		// Un conflicto transitorio repite la transacción entera: lo reclamado en el intento fallido se revirtió.
		claimed = nil
		ids, err := claimCandidates[${idType}](ctx, q, ${goString(sql.candidates)}, ${sql.candidateArgs.join(', ')})
		if err != nil {
			return err
		}
		for _, id := range ids {
			// El reclamo: ${what}.
			// 1 = es mía; 0 = otra réplica la reclamó entre la lectura y esta escritura. Esa comparación es toda la
			// exclusión mutua.
			result, err := q.ExecContext(ctx, ${goString(sql.update)}, ${sql.updateArgs.join(', ')})
			if err != nil {
				return err
			}
			won, err := result.RowsAffected()
			if err != nil {
				return err
			}
			if won != 1 {
				continue
			}
			found, err := r.load(ctx, ${goString(sql.reload)}, id)
			if err != nil {
				return err
			}
			claimed = append(claimed, found...)
		}
${sweepPassSignal(model, claim, 'len(ids)', 'batch', '		')}		return nil
	})
	if err != nil {
		return nil, err
	}
	return claimed, nil
}`;
  });
}
