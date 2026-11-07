// La escritura condicional (DSL 2.25, api.concurrency) contra el adaptador emitido: CW-1 a CW-5 de
// keel-core/gen/conditional-writes.js, el MISMO texto para las dos ramas (db-check y doc-check, vía rootProbes), con los ids
// de los casos que ejecutan los otros generadores. Una función de prueba por caso, para que cada sabotaje caiga en el suyo.

import { concurrencyCode } from './db-probes.js';
import { goString } from '../../src/lib/go-source.js';
import { loadsExpecting, preconditionSentinels } from '../../src/scaffold/conditional-writes.js';

/**
 * Las sondas de una raíz que carga una escritura condicional, o []. `repo` es la expresión del repositorio, `id` el campo
 * del id en el estado y `dump` la función que vuelca el agregado.
 */
export function conditionalWriteProbes(model, root, { repo, id }) {
  if (!loadsExpecting(model, root)) return [];
  const name = root.name;
  const failed = preconditionSentinels(model).failed;
  const concurrency = concurrencyCode(model);
  // Un agregado guardado, y su versión.
  const saved = (n) => `	ctx := t.Context()
	state := sample${name}(t, ${n})
	saved, err := ${repo}.Save(ctx, domain.Rehydrate${name}(state))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if saved.LockVersion() == nil {
		t.Fatal("Save devuelve un agregado sin versión")
	}
	version := int64(*saved.LockVersion())`;
  return [
    `func Test${name}_CW1_LoadExpectingTheCurrentVersionLoads(t *testing.T) {
${saved(501)}
	current, found, err := ${repo}.LoadExpecting(ctx, state.${id}, []int64{version})
	if err != nil || !found {
		t.Fatalf("CW-1: LoadExpecting con la versión vigente: found=%v err=%v", found, err)
	}
	if a, b := dump${name}(saved), dump${name}(current); a != b {
		t.Errorf("CW-1: lo cargado no es lo guardado:\\nguardado %s\\ncargado  %s", a, b)
	}
}`,
    `func Test${name}_CW2_LoadExpectingAnotherVersionIsThePrecondition(t *testing.T) {
${saved(502)}
	_, _, err = ${repo}.LoadExpecting(ctx, state.${id}, []int64{version + 1})
	de := domainError(t, err)
	if de.Code() != ${goString(failed.code)} || de.Status() != ${failed.status} {
		t.Errorf("CW-2: cargar con otra versión sale %q/%d, no ${failed.code}/${failed.status}", de.Code(), de.Status())
	}
	untouched, _, err := ${repo}.FindByID(ctx, state.${id})
	if err != nil {
		t.Fatal(err)
	}
	if a, b := dump${name}(saved), dump${name}(untouched); a != b || int64(*untouched.LockVersion()) != version {
		t.Errorf("CW-2: la precondición tocó el agregado:\\nantes   %s\\ndespués %s", a, b)
	}
}`,
    `func Test${name}_CW3_LoadExpectingNothingDoesNotCompare(t *testing.T) {
${saved(503)}
	if _, err := ${repo}.Save(ctx, saved); err != nil {
		t.Fatalf("el segundo guardado: %v", err)
	}
	unchecked, found, err := ${repo}.LoadExpecting(ctx, state.${id}, nil)
	if err != nil || !found {
		t.Fatalf("CW-3: LoadExpecting sin versión esperada: found=%v err=%v", found, err)
	}
	if got := int64(*unchecked.LockVersion()); got != version+1 {
		t.Errorf("CW-3: sin versión esperada carga la versión %d, no la vigente %d", got, version+1)
	}
	if _, found, err := ${repo}.LoadExpecting(ctx, state.${id}, []int64{}); found || err == nil {
		t.Errorf("CW-3: una lista vacía (un If-Match débil o ilegible) casó: found=%v err=%v", found, err)
	}
}`,
    `func Test${name}_CW4_SaveReturnsTheNewVersion(t *testing.T) {
${saved(504)}
	mine, _, err := ${repo}.LoadExpecting(ctx, state.${id}, []int64{version})
	if err != nil {
		t.Fatal(err)
	}
	second, err := ${repo}.Save(ctx, mine)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	after, _, err := ${repo}.FindByID(ctx, state.${id})
	if err != nil {
		t.Fatal(err)
	}
	if got, read := int64(*second.LockVersion()), int64(*after.LockVersion()); got != version+1 || read != version+1 {
		t.Errorf("CW-4: Save devuelve la versión %d y una lectura posterior ve la %d; quiero %d en las dos", got, read, version+1)
	}
}`,
    `func Test${name}_CW5_AWriteBetweenLoadAndSaveIsTheConcurrencyConflict(t *testing.T) {
${saved(505)}
	late, _, err := ${repo}.LoadExpecting(ctx, state.${id}, []int64{version})
	if err != nil {
		t.Fatal(err)
	}
	theirs, _, err := ${repo}.FindByID(ctx, state.${id})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ${repo}.Save(ctx, theirs); err != nil {
		t.Fatalf("la escritura de otro: %v", err)
	}
	_, err = ${repo}.Save(ctx, late)
	de := domainError(t, err)
	if de.Code() != ${goString(concurrency)} || de.Status() != 409 {
		t.Errorf("CW-5: la escritura de otro entre la carga y el guardado sale %q/%d, no ${concurrency}/409: las dos garantías no se funden", de.Code(), de.Status())
	}
}`
  ];
}
