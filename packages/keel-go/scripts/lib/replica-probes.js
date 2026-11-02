// Las sondas de la RÉPLICA en db-check (tramo 13h): el proyector y el lector emitidos contra el motor real. Crear, la
// reentrega del mismo instante, el hecho viejo y el nuevo conservando el id, la copia que sobrevive a la transacción de quien
// la escribe cuando esta se revierte, y ByKeys, que trae lo replicado y nada más. Falsadas con replica-tx, replica-order y
// replica-batch (test/helpers/db-sabotages.js).

import { occurredAtField } from '@keel-system/keel-core/gen/replica';
import { goExported } from '../../src/lib/go-projection.js';
import { goTypeName } from '../../src/scaffold/render.js';
import { naturalKeyBatchFinder } from '../../src/scaffold/repositories.js';
import { replicas } from '../../src/scaffold/projections.js';

export function replicaProbes(model, repository) {
  return replicas(model)
    .map(({ need, entity }) => {
      const name = entity.name;
      const repo = repository(entity);
      const projector = goTypeName(need.replica.projectorClass);
      const reader = goTypeName(need.replica.readerClass);
      const key = goExported(need.replica.keyField);
      const when = occurredAtField(entity);
      if (!when) return '';
      const at = goExported(when.name);
      const fields = entity.fields.filter((field) => !field.isId && !field.generated).map((field) => goExported(field.name));
      const snapshot = `func ${name}SnapshotOf(state domain.${name}State) application.${name}Snapshot {
	return application.${name}Snapshot{${fields.map((field) => `${field}: state.${field}`).join(', ')}}
}`;
      const batch = naturalKeyBatchFinder(model, entity);
      const byKeys = batch
        ? `

func Test${name}_ReaderByKeysBringsWhatIsReplicatedAndNothingElse(t *testing.T) {
	ctx := t.Context()
	repo := ${repo}
	state := sample${name}(t, 231)
	if err := application.New${projector}(repo).Apply(ctx, ${name}SnapshotOf(state)); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	absent := sample${name}(t, 232).${key}
	byKey, err := application.New${reader}(repo${need.replica.onMiss.action === 'fetch' && need.fetch ? ', nil' : ''}).ByKeys(ctx, []${batch.param.type}{state.${key}, absent})
	if err != nil {
		t.Fatalf("ByKeys: %v", err)
	}
	if _, ok := byKey[state.${key}]; !ok || len(byKey) != 1 {
		t.Fatalf("ByKeys = %d copias, quiero solo la replicada", len(byKey))
	}
}`
        : '';
      return `${snapshot}

func Test${name}_ProjectorCreatesDiscardsTheOldAndAppliesTheNew(t *testing.T) {
	ctx := t.Context()
	repo := ${repo}
	projector := application.New${projector}(repo)
	state := sample${name}(t, 221)
	start := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	state.${at} = start
	if err := projector.Apply(ctx, ${name}SnapshotOf(state)); err != nil {
		t.Fatalf("crear: %v", err)
	}
	created, found, err := repo.FindBy${key}(ctx, state.${key})
	if err != nil || !found {
		t.Fatalf("la copia no está: found=%v err=%v", found, err)
	}
	for label, instant := range map[string]time.Time{"la reentrega del mismo instante": start, "un hecho anterior": start.Add(-time.Hour)} {
		old := state
		old.${at} = instant
		if err := projector.Apply(ctx, ${name}SnapshotOf(old)); err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		read, _, err := repo.FindBy${key}(ctx, state.${key})
		if err != nil {
			t.Fatal(err)
		}
		if !read.${at}().Equal(start) || dump${name}(read) != dump${name}(created) {
			t.Fatalf("%s cambió la copia: %s", label, dump${name}(read))
		}
	}
	newer := state
	newer.${at} = start.Add(time.Hour)
	if err := projector.Apply(ctx, ${name}SnapshotOf(newer)); err != nil {
		t.Fatalf("el hecho nuevo: %v", err)
	}
	read, _, err := repo.FindBy${key}(ctx, state.${key})
	if err != nil {
		t.Fatal(err)
	}
	if !read.${at}().Equal(newer.${at}) {
		t.Fatalf("el hecho nuevo no se aplicó: %v", read.${at}())
	}
	if read.ID() != created.ID() {
		t.Fatalf("el hecho nuevo cambió el id: %v, era %v", read.ID(), created.ID())
	}
}

func Test${name}_CopySurvivesTheTransactionOfWhoeverWritesIt(t *testing.T) {
	ctx := t.Context()
	repo := ${repo}
	state := sample${name}(t, 241)
	boom := errors.New("el caso de uso se revierte")
	err := probeTx.Within(ctx, application.KindCommand, func(ctx context.Context) error {
		if err := application.New${projector}(repo).Apply(ctx, ${name}SnapshotOf(state)); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("Within = %v", err)
	}
	if _, found, err := repo.FindBy${key}(ctx, state.${key}); err != nil || !found {
		t.Fatalf("la copia se revirtió con quien la escribió: found=%v err=%v", found, err)
	}
}${byKeys}`;
    })
    .filter(Boolean)
    .join('\n\n');
}
