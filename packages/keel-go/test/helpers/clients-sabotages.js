// Los sabotajes de los CLIENTES SALIENTES (incremento 11b): cada uno rompe UNA garantía de la resiliencia en el Go emitido
// para stock-reservation conservando que compile, y nombra la prueba EMITIDA (internal/infrastructure/clients/
// clients_test.go) que tiene que salir en rojo, y solo ella. Los ejecuta go-check, y test/clients-sabotages.test.js
// comprueba sin Go que cada uno se sigue aplicando al texto de hoy y que nombra una prueba que existe. Son los seis de
// keel-dotnet (su 11b) más el del contrato.

const CLIENTS = 'internal/infrastructure/clients';

export const CLIENTS_SUBJECT = 'stock-reservation';

export const CLIENTS_SABOTAGES = [
  {
    id: 'circuit-strict',
    what: 'el circuito abre con la tasa ESTRICTAMENTE mayor que el umbral (resilience4j abre con >=)',
    file: `${CLIENTS}/circuit.go`,
    find: '>= c.spec.FailureRateThreshold',
    replace: '> c.spec.FailureRateThreshold',
    fails: 'TestElCircuitoDiceLoMismoQueLaReferencia',
    // Dos 503 en una ventana de cuatro son el 50 %: con > ya no abre.
    alsoFails: ['TestParaElCircuitoUn4xxEsUnExitoYUnContratoRotoNoCuenta']
  },
  {
    id: 'circuit-4xx',
    what: 'un 4xx cuenta como fallo para el circuito: un rechazo nuestro abriría el circuito de un proveedor que responde',
    file: `${CLIENTS}/failures.go`,
    find: 'return ok && (failure.Kind == KindTransport',
    replace: 'return ok && (failure.Kind == KindClientError || failure.Kind == KindTransport',
    fails: 'TestParaElCircuitoUn4xxEsUnExitoYUnContratoRotoNoCuenta'
  },
  {
    id: 'retry-all',
    what: 'el retry reintenta cualquier fallo del proveedor, no solo los de su política',
    file: `${CLIENTS}/resilience.go`,
    find: 'return retry != nil && ok && slices.Contains(retry.Retries, failure.Kind)',
    replace: 'return retry != nil && ok && !slices.Contains([]FailureKind{}, failure.Kind)',
    fails: 'TestElRetryReintentaSoloLoQueSuPoliticaDiceYNuncaElCircuitoAbierto'
  },
  {
    id: 'idempotency-random',
    what: 'la clave de idempotencia saliente cambia en cada intento: el reintento pediría una ejecución nueva',
    file: `${CLIENTS}/inventory_adapter.go`,
    find: 'key, err := outboundKey("cancelStock", orderID)',
    // uuid.New() y no time.Now().UnixNano(): en Windows el reloj de pared avanza a saltos de hasta 15,6 ms, y los tres
    // intentos seguidos de la prueba caían en el mismo tic con la MISMA clave (go-check del 11c, 2026-10-31).
    replace: 'key, err := outboundKey("cancelStock", orderID, uuid.New())',
    fails: 'TestInventoryHTTPAdapterCancelStockReintentaElTransporteComoDiceSuPolitica'
  },
  {
    id: 'fallback-any',
    what: 'el fallback atiende cualquier error: un contrato roto se disfraza de «el proveedor no está»',
    file: `${CLIENTS}/inventory_adapter.go`,
    find: '\tif failure, ok := AsProviderFailure(err); ok && slices.Contains(inventoryCancelStockFallback, failure.Kind) {\n',
    replace:
      '\tif err != nil {\n\t\tfailure, ok := AsProviderFailure(err)\n\t\tif !ok || !slices.Contains(inventoryCancelStockFallback, failure.Kind) {\n\t\t\tfailure = transportFailure(err.Error(), err)\n\t\t}\n',
    fails: 'TestInventoryHTTPAdapterCancelStockNoDisfrazaUnContratoRotoDeCaida'
  },
  {
    id: 'cancel-as-timeout',
    what: 'la cancelación de quien llama se clasifica como un fallo de transporte del proveedor',
    file: `${CLIENTS}/exchange.go`,
    find: '\tif ctx.Err() != nil {\n\t\treturn ctx.Err()\n\t}\n\tif errors.Is(err, context.DeadlineExceeded) {',
    replace: '\tif errors.Is(err, context.DeadlineExceeded) {',
    fails: 'TestLaCancelacionDeQuienLlamaNoEsUnTimeout'
  },
  {
    id: 'contract-missing',
    what: 'un campo obligatorio que falta en la respuesta se lee como su valor cero en vez de romper el contrato',
    file: `${CLIENTS}/reading.go`,
    find: '\tif !ok {\n\t\treturn contractErrorf(nil, "%s", missing)\n\t}',
    replace: '\tif !ok {\n\t\treturn nil\n\t}',
    fails: 'TestLaLecturaDelContratoDistingueAusenteDeMalTipado'
  }
];

/** El texto saboteado, o null si el sabotaje ya no encuentra lo que busca (no falsaría nada). */
export function applySabotage(sabotage, text) {
  return text.includes(sabotage.find) ? text.replace(sabotage.find, sabotage.replace) : null;
}
