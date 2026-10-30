// Los sabotajes de la APLICACIÓN: cada uno rompe UNA garantía del despacho en el Go emitido para product-catalog
// conservando que compile, y nombra la prueba EMITIDA (internal/application/use_cases_test.go) que tiene que salir
// en rojo. Los ejecuta go-check, y test/application-sabotages.test.js comprueba sin Go que cada uno se sigue
// aplicando al texto de hoy y que nombra una prueba que existe.

const APPLICATION = 'internal/application';

export const APPLICATION_SABOTAGES = [
  {
    id: 'unwired',
    what: 'NewUseCases deja una operación sin cablear',
    file: `${APPLICATION}/use_cases.go`,
    find: '\tuc.CreateProduct = observe(',
    replace: '\t_ = observe(',
    fails: 'TestNewUseCasesCableaCadaOperacion'
  },
  {
    id: 'swallow',
    what: 'el decorador de un comando se traga el error del caso de uso',
    file: `${APPLICATION}/usecase.go`,
    find: '\t\tlogOutcome(ctx, logger, operation, KindCommand, started, err)\n\t\treturn err\n',
    replace: '\t\tlogOutcome(ctx, logger, operation, KindCommand, started, err)\n\t\treturn nil\n',
    fails: 'TestObserveDejaPasarResultadoYError',
    // El rechazo del dominio también se pierde por el mismo decorador.
    alsoFails: ['TestObserveRegistraElRechazoDelDominioConSuCode']
  },
  {
    id: 'result',
    what: 'el decorador de una consulta devuelve el valor cero en vez del resultado',
    file: `${APPLICATION}/usecase.go`,
    find: '\t\treturn result, nil\n',
    replace: '\t\t_ = result\n\t\tvar zero R\n\t\treturn zero, nil\n',
    fails: 'TestObserveDejaPasarResultadoYError'
  },
  {
    id: 'level',
    what: 'un rechazo del dominio se registra como un fallo',
    file: `${APPLICATION}/usecase.go`,
    find: 'logger.InfoContext(ctx, "caso de uso: rechazado"',
    replace: 'logger.ErrorContext(ctx, "caso de uso: rechazado"',
    fails: 'TestObserveRegistraElRechazoDelDominioConSuCode'
  },
  // La firma del registro de idempotencia (request-idempotency.js): las tres garantías de su forma canónica.
  {
    id: 'signature-scale',
    what: 'la firma conserva los ceros finales de un importe: 1.50 y 1.5 serían dos peticiones distintas',
    file: `${APPLICATION}/signer.go`,
    find: '\t\ttext = strings.TrimRight(strings.TrimRight(text, "0"), ".")\n',
    replace: '\t\ttext += ""\n',
    fails: 'TestLaEscalaNoEsContenidoYElOrdenDeUnaListaSi'
  },
  {
    id: 'signature-length',
    what: 'la firma escribe los valores sin su longitud delante: un contenido puede imitar un separador',
    file: `${APPLICATION}/signer.go`,
    find: '\ts.text.WriteString(strconv.Itoa(len(value)))\n\ts.text.WriteByte(\':\')\n',
    replace: '\t_ = strconv.Itoa\n',
    fails: 'TestLaFormaCanonicaNoDejaQueUnContenidoImiteUnSeparadorNiANull',
    // Lo compuesto entra por su JSON con la longitud delante: cae con ella.
    alsoFails: ['TestUnInstanteFirmaIgualEnCualquierZonaYLoCompuestoPorSuJSON']
  },
  {
    id: 'idempotency-code',
    what: 'la carrera sale con el code de la clave reutilizada: el cliente no distingue «en curso» de «otro contenido»',
    file: 'internal/domain/idempotency.go',
    find: 'return Errorf(ErrIdempotencyKeyInProgress, "Otra petición',
    replace: 'return Errorf(ErrIdempotencyKeyReused, "Otra petición',
    fails: 'TestCadaConflictoSaleConElCodeDeSuOperacion'
  }
];

/** El texto saboteado, o null si el sabotaje ya no encuentra lo que buscaba. */
export function applySabotage(sabotage, content) {
  return content.includes(sabotage.find) ? content.replace(sabotage.find, sabotage.replace) : null;
}
