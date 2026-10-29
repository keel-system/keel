// Los sabotajes del DOMINIO: cada uno rompe UNA garantía en el Go emitido para product-catalog conservando que
// compile, y nombra la prueba de la sonda (scripts/probes/domain_probe_test.go) que tiene que salir en rojo. Los
// ejecuta go-check y test/domain-sabotages.test.js comprueba sin Go que cada uno se sigue aplicando al texto de
// hoy: un sabotaje que ya no encuentra lo que buscaba no falsa nada.

const DOMAIN = 'internal/domain';

export const DOMAIN_SABOTAGES = [
  {
    id: 'scale',
    what: 'el value object no normaliza la escala de su decimal',
    file: `${DOMAIN}/money.go`,
    find: '\tamount = amount.Rescale(2, wire.RoundHalfUp)\n',
    replace: '\t_ = wire.RoundHalfUp\n',
    fails: 'TestProbeMoneyNormalizesScale',
    // Lo que viaja por el cable pasa por el mismo constructor: sale 2.5 en vez de 2.50.
    alsoFails: ['TestProbeMoneyTravelsThroughItsConstructor']
  },
  {
    id: 'bound',
    what: 'el value object no hace cumplir el mínimo de su tipo',
    file: `${DOMAIN}/money.go`,
    find: 'if amount.Cmp(wire.MustDecimal("0")) < 0 {',
    replace: 'if amount.Cmp(wire.MustDecimal("0")) < -1 {',
    fails: 'TestProbeMoneyRejectsWithValidationError',
    // El Money negativo que llega por el cable tampoco se rechaza.
    alsoFails: ['TestProbeMoneyTravelsThroughItsConstructor']
  },
  {
    id: 'enum',
    what: 'el enum admite un valor que el diseño no tiene',
    file: `${DOMAIN}/product_status.go`,
    find: '\t}\n\treturn "", Errorf(ErrInvalidValue, ',
    replace: '\t}\n\treturn ProductStatus(text), nil\n\treturn "", Errorf(ErrInvalidValue, ',
    fails: 'TestProbeEnumRejectsUnknownValue'
  },
  {
    id: 'anchor',
    what: 'la expresión del formato no se ancla al valor entero',
    file: `${DOMAIN}/sku_format.go`,
    find: 'regexp.MustCompile(`^(?:^[A-Z]{3}-[0-9]{4}$)$`)',
    replace: 'regexp.MustCompile(`[A-Z]{3}-[0-9]{4}`)',
    fails: 'TestProbeFormatIsAnchored'
  },
  {
    id: 'transition',
    what: 'la guarda del lifecycle deja pasar una transición que el diseño no declara',
    file: `${DOMAIN}/product.go`,
    find: '\tif !slices.Contains(productTransitions[p.status], target) {\n',
    replace: '\tif !slices.Contains(productTransitions[p.status], target) && false {\n',
    fails: 'TestProbeTransitionGuard'
  },
  {
    id: 'sentinel',
    what: 'errors.Is reconoce cualquier centinela',
    file: `${DOMAIN}/errors.go`,
    find: '\treturn e.of != nil && target == error(e.of)\n',
    replace: '\treturn e.of != nil\n',
    fails: 'TestProbeSentinelsAreDistinguished',
    // json/v2 pregunta errors.Is(err, json.SkipFunc) al error de UnmarshalJSONFrom: un Is que dice que sí a todo
    // cambia lo que hace el lector del cable.
    alsoFails: ['TestProbeMoneyTravelsThroughItsConstructor']
  },
  {
    id: 'copy',
    what: 'el accesor de un campo opcional devuelve el puntero del estado',
    file: `${DOMAIN}/product.go`,
    find: '\treturn clonePtr(p.lockVersion)\n',
    replace: '\treturn p.lockVersion\n',
    fails: 'TestProbeStateIsCopied'
  }
];

/** El texto saboteado, o null si el sabotaje ya no encuentra lo que buscaba. */
export function applySabotage(sabotage, content) {
  return content.includes(sabotage.find) ? content.replace(sabotage.find, sabotage.replace) : null;
}
