// Los sabotajes de la API: cada uno rompe UNA garantía del contrato HTTP en el Go emitido para product-catalog
// conservando que compile, y nombra la prueba EMITIDA de internal/httpapi (api_test.go o edge_test.go) que tiene que
// salir en rojo, y solo ella. Los ejecuta go-check, y test/api-sabotages.test.js comprueba sin Go que cada uno se
// sigue aplicando al texto de hoy y que nombra una prueba que existe.

const HTTPAPI = 'internal/httpapi';

export const API_SABOTAGES = [
  {
    id: 'wrong-method',
    what: 'un camino que existe con otro método responde 404 en vez de 405',
    file: `${HTTPAPI}/middleware.go`,
    find: 'if _, pattern := mux.Handler(probe); pattern != "/" {',
    replace: 'if _, pattern := mux.Handler(probe); pattern == "nunca" {',
    fails: 'TestUnCaminoQueExisteConOtroMetodoEs405ConAllow'
  },
  {
    id: 'correlation',
    what: 'la correlación recibida se ignora y siempre se genera una',
    file: `${HTTPAPI}/middleware.go`,
    find: 'id := correlation.Accept(r.Header.Get(correlation.Header))',
    replace: 'id := correlation.Accept("")',
    fails: 'TestLaCorrelacionRecibidaVuelveYUnaQueNoCumpleElFormatoSeSustituye'
  },
  {
    id: 'details-empty',
    what: 'details sin detalles viaja como [] en vez de null',
    file: `${HTTPAPI}/errors.go`,
    find: '\tif d == nil {\n\t\treturn enc.WriteToken(jsontext.Null)\n\t}\n',
    replace: '',
    fails: 'TestUnCuerpoQueNoEsJSONEs400PeticionMalformadaSinDetails'
  },
  {
    id: 'not-blank',
    what: 'la regla notBlank deja pasar un texto de espacios',
    file: `${HTTPAPI}/product_endpoints.go`,
    find: 'strings.TrimSpace(msg.Sku) == ""',
    replace: 'msg.Sku == ""',
    fails: 'TestUnCuerpoQueIncumpleLoDeclaradoEs400ValidationErrorConElCampoEnDetails'
  },
  {
    id: 'null-member',
    what: 'un miembro a null se lee sobre su campo (y un value object pasa el null por su constructor)',
    file: `${HTTPAPI}/reading.go`,
    find: '\tif !has(fields, name) {\n\t\treturn nil\n\t}\n\tif err := wire.Unmarshal(fields[name], out); err != nil {',
    replace: '\tif _, ok := fields[name]; !ok {\n\t\treturn nil\n\t}\n\tif err := wire.Unmarshal(fields[name], out); err != nil {',
    fails: 'TestUnValueObjectObligatorioANullEsMustNotBeNullYNoMalformada'
  },
  {
    id: 'body-limit',
    what: 'el cuerpo no tiene tope',
    file: `${HTTPAPI}/middleware.go`,
    find: 'r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)',
    replace: '_ = MaxBodyBytes',
    fails: 'TestUnCuerpoPorEncimaDelTopeEs413'
  },
  {
    id: 'uuid-lenient',
    what: 'un uuid de ruta mal formado se acepta',
    file: `${HTTPAPI}/reading.go`,
    find: '\tif len(raw) > 36 || len(parts) != 5 {\n\t\treturn uuid.UUID{}, malformed(nil)\n\t}',
    replace: '\tif len(raw) > 36 || len(parts) != 5 {\n\t\treturn uuid.UUID{}, nil\n\t}',
    fails: 'TestUnUUIDDeRutaMalFormadoEs400PeticionMalformada'
  },
  {
    id: 'panic-swallowed',
    what: 'un pánico se recupera sin responder ni registrarlo',
    file: `${HTTPAPI}/middleware.go`,
    find: '\tif recovered == nil {\n\t\treturn\n\t}',
    replace: '\t_ = recovered\n\treturn',
    fails: 'TestUnPanicoEnUnHandlerEs500YSeRegistraConSuPila'
  },
  {
    id: 'domain-status',
    what: 'un error del dominio responde 500 en vez de su status',
    file: `${HTTPAPI}/errors.go`,
    find: '\tstatus := rejected.Status()\n',
    replace: '\tstatus := http.StatusInternalServerError\n',
    fails: 'TestUnErrorDelDominioRespondeConSuStatusSuCodeYSuMensaje',
    alsoFails: ['TestUnErrorDelDominioSinMensajeRespondeConElDeSuCategoria']
  },
  {
    id: 'unlogged-500',
    what: 'el catch-all responde 500 sin registrar el error',
    file: `${HTTPAPI}/errors.go`,
    find: '\ta.logger.ErrorContext(r.Context(), "error no controlado", "error", err)\n',
    replace: '',
    fails: 'TestUnErrorSinTraducirEs500YSeRegistra'
  }
];

/** El texto saboteado, o null si el sabotaje ya no encuentra lo que buscaba. */
export function applySabotage(sabotage, content) {
  return content.includes(sabotage.find) ? content.replace(sabotage.find, sabotage.replace) : null;
}
