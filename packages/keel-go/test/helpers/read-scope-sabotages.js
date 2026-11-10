// Los sabotajes de la lectura acotada (DSL 2.27) que miden las pruebas EMITIDAS: cada uno rompe UNA garantía de la caché o
// del borde en el Go emitido para un diseño de keel-core/test/helpers/read-scope-designs.js conservando que compile, y
// nombra la prueba emitida que tiene que salir en rojo, y solo ella. Los mismos ids que en los otros tres
// (READ_SCOPE_SABOTAGES de keel-core/gen/read-scope.js). Los del adaptador (y la mitad del adaptador de rs-empty-is-all) son
// de db-check y doc-check (scripts/lib/read-scope-probes.js). Los ejecuta go-check, y test/read-scope.test.js comprueba
// sin Go que cada uno se sigue aplicando y nombra una prueba que existe.

export const READ_SCOPE_EDGE_SABOTAGES = [
  {
    id: 'rs-cache-key',
    what: 'la clave de caché no lleva el scope',
    subject: 'vault-scoped',
    file: 'internal/application/cached_operations.go',
    find: 'return CacheKey(query.ID, query.ReadScope.CacheKey())',
    replace: 'return CacheKey(query.ID)',
    packages: './internal/application/',
    fails: 'TestRS9LaGetAssetCacheLlevaElScopeEnLaClave'
  },
  {
    id: 'rs-empty-is-all',
    what: 'el claim ausente se trata como sin restricción',
    subject: 'vault-scoped',
    file: 'internal/httpapi/read_scope.go',
    find: '\treturn domain.ScopeWithin(scope.ScopedValues(ctx))\n',
    replace: '\tif values := scope.ScopedValues(ctx); len(values) > 0 {\n\t\treturn domain.ScopeWithin(values)\n\t}\n\treturn domain.UnrestrictedScope()\n',
    packages: './internal/httpapi/',
    fails: 'TestRS10ReadScopeScopingElClaimAusenteEsElConjuntoVacioYSoloLaExencionLoVeTodo'
  }
];

/** El texto con el sabotaje aplicado, o null si ya no contiene lo que busca. */
export function applyReadScopeSabotage(sabotage, text) {
  return text.includes(sabotage.find) ? text.replace(sabotage.find, () => sabotage.replace) : null;
}
