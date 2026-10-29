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
    find: '\t\treturn result, err\n',
    replace: '\t\t_ = result\n\t\tvar zero R\n\t\treturn zero, err\n',
    fails: 'TestObserveDejaPasarResultadoYError'
  },
  {
    id: 'level',
    what: 'un rechazo del dominio se registra como un fallo',
    file: `${APPLICATION}/usecase.go`,
    find: 'logger.InfoContext(ctx, "caso de uso: rechazado"',
    replace: 'logger.ErrorContext(ctx, "caso de uso: rechazado"',
    fails: 'TestObserveRegistraElRechazoDelDominioConSuCode'
  }
];

/** El texto saboteado, o null si el sabotaje ya no encuentra lo que buscaba. */
export function applySabotage(sabotage, content) {
  return content.includes(sabotage.find) ? content.replace(sabotage.find, sabotage.replace) : null;
}
