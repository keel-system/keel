// Los sabotajes del historial de cambios (DSL 2.29) que mide la prueba EMITIDA history_test.go: cada uno rompe UNA garantía
// del código común del almacén (el diff, el id de la entrada) conservando que compile, y nombra las pruebas emitidas que
// tienen que salir en rojo, y solo ellas. Los mismos ids que los de cs-check en keel-dotnet. Los del adaptador y del almacén
// contra el motor (hi-*) son de db-check y doc-check (scripts/lib/history-probes.js). Los ejecuta go-check --history, y
// test/history-parity.test.js comprueba sin Go que cada uno se sigue aplicando.

/** El sujeto: el diseño de keel-core/test/helpers/history-designs.js cuyas pruebas emitidas se falsan. */
export const HISTORY_SUBJECT = 'cards-history';

export const HISTORY_EMITTED_SABOTAGES = [
  {
    id: 'history-diff',
    what: 'el diff registra toda ruta, cambie o no',
    file: 'internal/infrastructure/postgres/history.go',
    find: '\t\tif was != is {\n',
    replace: '\t\tif was != is || true {\n',
    packages: './internal/infrastructure/postgres/',
    fails: 'TestHistoryDiffOfACreation TestHistoryDiffOfAnUpdate TestHistoryDiffWithoutChangesIsEmpty'
  },
  {
    id: 'history-next-id',
    what: 'el id de la entrada es un UUID aleatorio, que no crece',
    file: 'internal/infrastructure/postgres/history.go',
    find: '\treturn uuid.NewV7()\n',
    replace: '\treturn uuid.New(), nil\n',
    packages: './internal/infrastructure/postgres/',
    fails: 'TestHistoryIDGrowsWithinTheSameMillisecond'
  }
];

/** El texto con el sabotaje aplicado, o null si ya no contiene lo que busca. */
export function applyHistorySabotage(sabotage, text) {
  return text.includes(sabotage.find) ? text.replace(sabotage.find, () => sabotage.replace) : null;
}
