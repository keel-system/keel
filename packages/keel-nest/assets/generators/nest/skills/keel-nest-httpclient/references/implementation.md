# HTTP clients — lo que se completa en el adaptador

Complementa «Lo que escribes» del SKILL.md. Todo esto vive en `infrastructure/clients`.

## La forma de una llamada

Build deja tres métodos por llamada con resiliencia, y cada uno tiene UN trabajo:

```ts
async cancelStock(orderId: string): Promise<CancelStockResult> {          // el del puerto
  try {
    return await withResilience(CANCEL_STOCK_POLICY, this.cancelStockCircuit, () => this.cancelStockOnce(orderId));
  } catch (error) {
    const failure = providerFailureOf(error, ['circuit-open', 'transport', 'server-error', 'unknown-status', 'client-error']);
    if (failure === null) throw error;                                       // un bug tuyo: se propaga
    return this.cancelStockUnavailable(orderId, failure);                    // la política del diseño
  }
}

private async cancelStockOnce(orderId: string): Promise<CancelStockResult> { // UN intento: lo repite el retry
  const response = await exchange(this.client, { method: 'DELETE', path: '/stock/reservations/{orderId}', params: { orderId }, headers: { … } });
  …
}
```

- **`<llamada>Once`** es un intento: lo que pongas aquí se repite en cada reintento. La clave de idempotencia se
  calcula aquí y sale IGUAL en cada uno; no la saques fuera ni le metas nada aleatorio o del instante.
- **`withResilience`** aplica `<LLAMADA>_POLICY`, que es la de keel-core (`resiliencePolicy`) ya resuelta. No la
  edites a mano: la decide el diseño (`retry`, `circuitBreaker`) y es la misma que la del servidor de keel-spring.
- **`<llamada>Unavailable`** es la política del diseño. Solo la alcanzan los fallos del proveedor.

## Rechazos con significado

`exchange` lanza `ProviderStatusError` para todo status que no sea 2xx, con su `status` y su `kind`
(`client-error`, `server-error`, `unknown-status`). Si el diseño le da significado a un rechazo, tradúcelo en
el intento, antes de que el error llegue al fallback:

```ts
private async getPriceOnce(sku: string): Promise<GetPriceResult> {
  let response: OutboundResponse;
  try {
    response = await exchange(this.client, { method: 'GET', path: '/prices/{sku}', params: { sku } });
  } catch (error) {
    // 404: el precio NO existe — un hecho del dominio, no una caída. Con el code exacto que declara use-cases.
    if (error instanceof ProviderStatusError && error.status === 404) throw new PriceNotFoundError('No hay precio para ' + sku);
    throw error;
  }
  …
}
```

Una excepción de dominio no es un fallo del proveedor: el retry no la repite, el circuito la cuenta como éxito y
el fallback la deja pasar. Es lo que se quiere. **Nunca conviertas un 4xx en reintento**: el proveedor contestó, y
repetir la misma petición obtiene la misma respuesta.

## El contrato en prosa

Sin `request`/`response` estructurados, build deja `<Llamada>Response` sin campos y el mapper con un `TODO`:

- declara los campos de `<Llamada>Response` con los nombres y tipos del TERCERO, y léelos en `read()` con
  `responseField.<tipo>(...)` (`src/infrastructure/clients/response-reading.ts`) — un campo que el contrato
  declara obligatorio va con `requiredField(...)`;
- declara los de `<Llamada>Result` (en `domain/clients`) con los del DOMINIO, y el mapeo campo a campo en el mapper;
- el wire refleja al tercero y el resultado al dominio; el mapper es el único puente.

Un cuerpo que no cumple el contrato es `OutboundContractError`: no es «el proveedor no está», no entra al
fallback ni cuenta para el circuito, y sale como 500 con su traza. No lo captures para devolver otra cosa.

## Un fallback `degrade`

Build deja `throw new Error('TODO: fallback …')` con la prosa de `onFailure.degradedTo`. Escribe el resultado
degradado, y que se distinga de uno normal (un campo ausente, una marca): un dato plausible pero falso es peor
que fallar. No reintentes ni llames a otro proveedor desde aquí sin que el diseño lo diga.

## Lo que la frontera todavía rechaza

`keel-nest build` no genera, y lo dice al rechazar el diseño: los `needs` de `dependencies` (réplica, `onMiss`,
`onUnavailable`, `lastKnown`), la autenticación `oauth2-client-credentials` y un value object compuesto en una
llamada. Si uno de esos llega aquí, el diseño se generó con `--accept-unready` o con otra versión: repórtalo.
