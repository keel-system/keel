// Los sabotajes de la escritura condicional (DSL 2.25) que miden las pruebas EMITIDAS: cada uno rompe UNA garantía del borde
// o de la caché en el Go emitido para una silueta de keel-core/test/helpers/conditional-write-designs.js conservando que
// compile, y nombra la prueba emitida que tiene que salir en rojo, y solo ella. Los mismos ids que en keel-dotnet y keel-nest
// (CW_SABOTAGES de keel-core/gen/conditional-writes.js). Los del adaptador (cw-ignore-expected, cw-stale-version,
// cw-collapse-409) son de db-check y doc-check; el del gate (cw-gate), de test/conditional-writes.test.js. Los ejecuta
// go-check, y test/conditional-writes.test.js comprueba sin Go que cada uno se sigue aplicando y nombra una prueba que existe.

export const CONDITIONAL_SABOTAGES = [
  {
    id: 'cw-no-428',
    what: 'el borde no exige If-Match con required',
    subject: 'catalog-conditional',
    file: 'internal/httpapi/conditional.go',
    find: '\t\tif required {\n',
    replace: '\t\tif required && false {\n',
    packages: './internal/httpapi/',
    fails: 'TestCW6UnaEscrituraCondicionalSinIfMatchEs428YNoLlegaAlCasoDeUso'
  },
  {
    id: 'cw-weak-match',
    what: 'la comparación acepta un ETag débil (W/)',
    subject: 'catalog-conditional',
    file: 'internal/httpapi/conditional.go',
    find: 'regexp.MustCompile(`^"(0|[1-9][0-9]*)"$`)',
    replace: 'regexp.MustCompile(`^(?:W/)?"(0|[1-9][0-9]*)"$`)',
    packages: './internal/httpapi/',
    fails: 'TestCW7IfMatchSeLeeComoDicenLosCasosDelCable'
  },
  {
    id: 'cw-error-map',
    what: 'la precondición sale como 409',
    subject: 'catalog-conditional',
    file: 'internal/domain/errors.go',
    find: 'code: "PRECONDITION_FAILED", status: 412}',
    replace: 'code: "PRECONDITION_FAILED", status: 409}',
    packages: './internal/httpapi/',
    fails: 'TestCW8LaPrecondicionSaleDelBordeComo412ConSuCodeYSuTexto'
  },
  {
    id: 'cw-cors',
    what: 'CORS no expone el ETag',
    subject: 'shop-conditional',
    file: 'internal/platform/security/cors.go',
    find: ', "ETag"}',
    replace: '}',
    packages: './internal/httpapi/',
    fails: 'TestCW9CORSExponeElETag'
  },
  {
    id: 'cw-cache-etag',
    what: 'la entrada de la caché se lee sin su versión',
    subject: 'catalog-conditional',
    file: 'internal/application/versioned.go',
    find: '\tif entry.Version == nil {\n\t\treturn errUnversioned\n\t}\n',
    replace: '\tif entry.Version == nil {\n\t\tentry.Version = new(int64)\n\t}\n',
    packages: './internal/application/',
    fails: 'TestCW11UnaEntradaSinVersionNoSeLee'
  }
];

export function applySabotage(sabotage, text) {
  return text.includes(sabotage.find) ? text.replace(sabotage.find, () => sabotage.replace) : null;
}
