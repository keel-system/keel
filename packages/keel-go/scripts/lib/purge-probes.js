// Las sondas de las PURGAS por lotes (tramo 10b) para db-check: ejecutan contra el motor real el SQL emitido de cada tabla
// del generador (`purges.go`) con el bucle emitido del reloj (`scheduler.BatchedPurge`), como los purga el servidor:
//
//   · por lotes y hasta el corte, con instantes repetidos en la frontera de un lote: lo anterior se va y lo posterior queda;
//   · con su tope: la pasada que llega a él lo dice y la siguiente se lleva el resto;
//   · lo PENDIENTE del outbox no se toca nunca, por viejo que sea.
//
// Cada sonda marca sus filas con una etiqueta propia y las borra al terminar, y sus instantes son de 2001: ninguna otra
// sonda escribe tan atrás, así que lo que el corte se lleva es solo lo suyo.

import { OUTBOX_EVENT, PROCESSED_EVENT, storeColumns } from '@keel-system/keel-core/gen/messaging-stores';
import { IDEMPOTENCY_RECORD } from '@keel-system/keel-core/gen/request-idempotency';
import { goString } from '../../src/lib/go-source.js';
import { sqlDialect } from '../../src/lib/relational-engine.js';
import { tablePurges } from '../../src/scaffold/purge.js';
import { usesScheduling } from '../../src/scaffold/scheduling.js';

const TABLES = { [OUTBOX_EVENT.table]: OUTBOX_EVENT, [PROCESSED_EVENT.table]: PROCESSED_EVENT, [IDEMPOTENCY_RECORD.table]: IDEMPOTENCY_RECORD };

/** Las sondas de las purgas del sujeto, o null si no tiene ninguna (o no tiene el reloj que las ejecuta). */
export function purgeProbes(model) {
  if (!usesScheduling(model)) return null;
  const purges = tablePurges(model);
  if (purges.length === 0) return null;
  return [PRELUDE, ...purges.flatMap((purge) => probesOf(model, purge))].join('\n\n');
}

const PRELUDE = `// purgeAt es el instante s segundos después del 1 de enero de 2001: más atrás de lo que escribe cualquier otra sonda.
func purgeAt(s int) time.Time {
	return time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(s) * time.Second)
}`;

function probesOf(model, purge) {
  const d = sqlDialect(model);
  const table = TABLES[purge.table];
  const columns = storeColumns(table, 'relational');
  const tagColumn = columns.find((column) => column.base === 'string').name;
  const values = columns.map((column) => {
    if (column.name === purge.column) return 'cut';
    if (column.name === tagColumn) return 'tag';
    if (column.base === 'uuid') return 'uuid.New()';
    if (column.base === 'string' || column.base === 'text') return 'fmt.Sprintf("%s-%d", tag, i)';
    if (column.base === 'int') return '0';
    if (column.base === 'timestamp') return column.nullable ? 'nil' : 'at';
    throw new Error(`purge-probes: ${purge.table}.${column.name} (${column.base}) sin valor de muestra`);
  });
  const insert = `INSERT INTO ${purge.table} (${columns.map((column) => column.name).join(', ')}) VALUES (${columns.map((_, i) => d.param(i + 1)).join(', ')})`;
  const name = purge.field;
  const parts = [`// insert${name}PurgeRows inserta en ${purge.table} una fila por instante, marcada con tag; pending deja ${purge.column} sin
// valor (lo que todavía no se publicó). Las borra al terminar la prueba.
func insert${name}PurgeRows(t *testing.T, tag string, instants []time.Time, pending bool) {
	t.Helper()
	t.Cleanup(func() {
		if err := probeTx.write(context.WithoutCancel(t.Context()), func(q DBTX) error {
			_, err := q.ExecContext(context.WithoutCancel(t.Context()), ${goString(`DELETE FROM ${purge.table} WHERE ${tagColumn} = ${d.param(1)}`)}, tag)
			return err
		}); err != nil {
			t.Errorf("limpiar ${purge.table}: %v", err)
		}
	})
	for i, at := range instants {
		var cut any = at
		if pending {
			cut = nil
		}
		if err := probeTx.write(t.Context(), func(q DBTX) error {
			_, err := q.ExecContext(t.Context(), ${goString(insert)}, ${values.join(', ')})
			return err
		}); err != nil {
			t.Fatalf("insertar en ${purge.table}: %v", err)
		}
	}
}

// count${name}PurgeRows cuenta las filas de ${purge.table} marcadas con tag.
func count${name}PurgeRows(t *testing.T, tag string) int {
	t.Helper()
	var n int
	if err := probeTx.db.QueryRowContext(t.Context(), ${goString(`SELECT COUNT(*) FROM ${purge.table} WHERE ${tagColumn} = ${d.param(1)}`)}, tag).Scan(&n); err != nil {
		t.Fatalf("contar ${purge.table}: %v", err)
	}
	return n
}

func TestPurge_${name}_ByBatchesUpToTheCutoff(t *testing.T) {
	tag := "purge-" + uuid.NewString()[:8]
	// Siete antes del corte —tres en el mismo instante, en la frontera de un lote de dos— y dos después.
	insert${name}PurgeRows(t, tag, []time.Time{purgeAt(1), purgeAt(2), purgeAt(2), purgeAt(2), purgeAt(3), purgeAt(4), purgeAt(5), purgeAt(20), purgeAt(30)}, false)
	deleted, exhausted, err := scheduler.BatchedPurge(t.Context(), ${purge.constructor}(probeTx), purgeAt(10), 2, 10)
	if err != nil || deleted != 7 || exhausted {
		t.Errorf("BatchedPurge = %d, tope %v, %v; quiero 7 borradas sin llegar al tope", deleted, exhausted, err)
	}
	if left := count${name}PurgeRows(t, tag); left != 2 {
		t.Errorf("quedan %d filas, quiero las 2 posteriores al corte", left)
	}
}

func TestPurge_${name}_StopsAtItsCap(t *testing.T) {
	tag := "purge-" + uuid.NewString()[:8]
	insert${name}PurgeRows(t, tag, []time.Time{purgeAt(1), purgeAt(2), purgeAt(3), purgeAt(4), purgeAt(5), purgeAt(6)}, false)
	purge := ${purge.constructor}(probeTx)
	deleted, exhausted, err := scheduler.BatchedPurge(t.Context(), purge, purgeAt(10), 2, 2)
	if err != nil || deleted != 4 || !exhausted {
		t.Errorf("la pasada con tope de 2 lotes de 2 = %d, tope %v, %v; quiero 4 borradas y el tope alcanzado", deleted, exhausted, err)
	}
	deleted, exhausted, err = scheduler.BatchedPurge(t.Context(), purge, purgeAt(10), 2, 2)
	if err != nil || deleted != 2 || exhausted {
		t.Errorf("la pasada siguiente = %d, tope %v, %v; quiero las 2 que quedaban", deleted, exhausted, err)
	}
	if left := count${name}PurgeRows(t, tag); left != 0 {
		t.Errorf("quedan %d filas anteriores al corte", left)
	}
}`];
  if (purge.predicate) {
    parts.push(`func TestPurge_${name}_KeepsWhatIsPending(t *testing.T) {
	tag := "purge-" + uuid.NewString()[:8]
	// Lo pendiente es tan viejo como lo publicado: solo la condición de la purga (${purge.predicate}) lo salva.
	insert${name}PurgeRows(t, tag, []time.Time{purgeAt(1), purgeAt(2), purgeAt(3)}, true)
	insert${name}PurgeRows(t, tag+"-done", []time.Time{purgeAt(1)}, false)
	deleted, _, err := scheduler.BatchedPurge(t.Context(), ${purge.constructor}(probeTx), purgeAt(10), 2, 10)
	if err != nil || deleted != 1 {
		t.Errorf("BatchedPurge = %d, %v; quiero solo la fila publicada", deleted, err)
	}
	if left := count${name}PurgeRows(t, tag); left != 3 {
		t.Errorf("quedan %d de las 3 pendientes", left)
	}
}`);
  }
  return parts;
}
