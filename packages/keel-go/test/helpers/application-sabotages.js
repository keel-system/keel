// Los sabotajes de la APLICACIÓN: cada uno rompe UNA garantía del despacho en el Go emitido para product-catalog
// conservando que compile, y nombra la prueba EMITIDA (internal/application/use_cases_test.go) que tiene que salir
// en rojo. Los ejecuta go-check, y test/application-sabotages.test.js comprueba sin Go que cada uno se sigue
// aplicando al texto de hoy y que nombra una prueba que existe.

const APPLICATION = 'internal/application';

const AFTER_COMMIT = `${APPLICATION}/after_commit.go`;

export const APPLICATION_SABOTAGES = [
  {
    id: 'after-commit-now',
    what: 'afterCommit no espera: el efecto corre dentro de la transacción',
    file: AFTER_COMMIT,
    find: '\tif s := openSettlement(ctx); s != nil {\n',
    replace: '\tif s := openSettlement(ctx); s != nil && false {\n',
    fails: 'TestAfterCommitEsperaAQueElCasoDeUsoTermineBien',
    alsoFails: ['TestAfterCommitEsperaAlCasoDeUsoDeFuera', 'TestAfterCommitNoOcurreSiElCasoDeUsoFalla']
  },
  {
    id: 'after-commit-failed',
    what: 'un comando que falla ejecuta igualmente lo que esperaba al commit',
    file: AFTER_COMMIT,
    find: '\t\tif err := next.Handle(context.WithValue(ctx, settlementKey{}, own), cmd); err != nil {\n\t\t\treturn err\n\t\t}\n',
    replace: '\t\tif err := next.Handle(context.WithValue(ctx, settlementKey{}, own), cmd); err != nil {\n\t\t\tsettled(ctx, own, onCommit)\n\t\t\treturn err\n\t\t}\n',
    fails: 'TestAfterCommitNoOcurreSiElCasoDeUsoFalla',
    alsoFails: ['TestAfterCommitEsperaAlCasoDeUsoDeFuera']
  },
  {
    id: 'after-commit-detached',
    what: 'lo despachado con WithoutTransaction espera a un commit que no le toca',
    file: AFTER_COMMIT,
    find: '\tif TransactionDetached(ctx) {\n\t\treturn nil\n\t}\n\ts, _ := ctx.Value',
    replace: '\ts, _ := ctx.Value',
    fails: 'TestAfterCommitSinTransaccionOcurreYa'
  },
  {
    id: 'use-case-logger',
    what: 'un handler registra con el slog global, sin el JSON ni la correlación del servicio',
    file: AFTER_COMMIT,
    find: '\t\treturn s.logger\n',
    replace: '\t\t_ = s\n',
    fails: 'TestUseCaseLoggerEsElDelCasoDeUso',
    alsoFails: ['TestAfterCommitNoDependeDelClienteNiDeshaceNada']
  },
  {
    id: 'after-commit-cancel',
    what: 'el efecto hereda la cancelación de la petición',
    file: AFTER_COMMIT,
    find: '\t\tctx = context.WithoutCancel(ctx)\n',
    replace: '',
    fails: 'TestAfterCommitNoDependeDelClienteNiDeshaceNada'
  },
  {
    id: 'unwired',
    what: 'NewUseCases deja una operación sin cablear',
    file: `${APPLICATION}/use_cases.go`,
    find: '\tuc.CreateProduct = settle(',
    replace: '\t_ = settle(',
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
