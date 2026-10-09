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

## El dato que se PIDE a otro servidor (`dependencies.needs`)

**Bajo demanda** (`strategy: on-demand`): el puerto ya está inyectado en el handler del `usedBy`; llámalo con
`await` y usa el resultado de dominio que devuelve. Si el proveedor no contesta, el fallback ya aplica
`onUnavailable`: `fail` lanza el error declarado, `lastKnown` sirve el último valor DE ESOS parámetros mientras
esté dentro de `maxAgeSeconds` (y se rinde con el error declarado después; el almacén es
`src/infrastructure/clients/last-known-values.ts`, no lo dupliques) y `degrade` te deja el `TODO` con el resultado
degradado que describe el diseño.

**Replicado** (`strategy: replicated`): la copia local la escriben y la leen dos clases de `application/projection`:

- `<E>Projector.apply({ ... })` — la ÚNICA escritura de la copia. Lo invoca el handler de la operación de
  proyección (la que dispara la suscripción del `fedBy`), ya inyectado. Descarta la reentrega tardía si la entidad
  guarda el instante del hecho. Te toca añadir al dominio los dos métodos que cita su TODO: `static
  projectionOf(snapshot)` y `applySnapshot(...)`.
- `<E>Reader.byKey(clave)` — la lectura, inyectada en los handlers del `usedBy`, con su `onMiss`. Con `fetch`, el
  `hydrate` es tuyo: pide el dato con el puerto, construye la copia con `projectionOf` y guárdala. La copia se
  guarda en su PROPIA transacción (el adaptador del repositorio de la réplica la abre aparte), porque aquí se llega
  desde una consulta de solo lectura.

Nunca leas ni escribas el repositorio de la réplica desde un handler de negocio.

## OAuth2 client-credentials

No hay nada que escribir: la concesión (`src/infrastructure/clients/oauth2-client-credentials.ts`) pide el token al
emisor una vez, lo reutiliza hasta su caducidad menos 60 s y lo pone en cada petición como `Bearer`, con la
semántica del cliente de Spring Security (secreto por `client_secret_basic`, `scope` en el formulario). Un emisor
caído es un fallo `auth-grant`: llega al fallback de la llamada —nunca un 500— y la petición de negocio no sale.
En `local` el `token-uri` es el PATH del diseño sobre el WireMock de `infra/`; en un flujo, prográmalo con el
mismo `stubFor('POST', '<path del tokenUrl>', 200, { access_token, token_type: 'Bearer', expires_in })`.

## Lo que la frontera todavía rechaza

Un value object compuesto en la petición o la respuesta de una llamada: el adaptador lee y escribe escalares, enums
y listas de ellos. Si llega aquí, el diseño se generó con otra versión: repórtalo.
