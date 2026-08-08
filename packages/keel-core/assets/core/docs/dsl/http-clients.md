# Capa `http-clients` — integraciones HTTP salientes (opcional)

Archivo: `specs/<servicio>/http-clients.keel.yaml` · Schema: [`schema/http-clients.schema.json`](../../schema/http-clients.schema.json)

Llamadas síncronas a terceros u otros servicios, descritas por **contrato**. La resiliencia (timeout, retry, circuit breaker, fallback) se declara aquí, por llamada: es política del canal saliente y la reutilizan todos los casos de uso que lo usen. La **autenticación saliente** se declara por cliente.

```yaml
clients:
  pricing-service:
    purpose: Obtener el precio vigente de un producto.
    auth:
      type: api-key
      headerName: X-Api-Key
    calls:
      getPrice:
        contract: Precio vigente de un SKU con su moneda.
        method: GET
        path: /prices/{sku}
        request:
          pathParams:
            sku: { type: string, required: true }
          queryParams:
            currency: { type: string }
        response:
          fields:
            amount: { type: decimal, required: true }
            currency: { type: string, required: true }
        timeoutMs: 2000
        retry: { maxAttempts: 3, backoff: exponential, initialDelayMs: 200, retryOn: [timeout, 5xx] }
        circuitBreaker: { failureRateThreshold: 50, slidingWindowSize: 20, waitDurationMs: 30000 }
        fallback: Devolver el último precio conocido en caché; si no existe, error PRICE_UNAVAILABLE.
```

## El contrato: prosa siempre, estructura cuando importa

- `contract` (obligatorio) resume la llamada en prosa; no es un OpenAPI — es el mínimo que un integrador humano necesita.
- `method` + `path` + `request` + `response` (opcionales) estructuran la llamada. Con ellos, el generador produce los tipos reales del cliente (parámetros y records de request/response) y `keel validate` cruza los tipos contra el dominio; sin ellos, la prosa del `contract` es lo único que guía al agente al generar. **Prefiere la forma estructurada** en cuanto el contrato del tercero sea conocido.
- `method` y `path` van siempre juntos; `request` exige `method`. Con `GET`/`DELETE` no hay `request.body`.
- Los tipos de `request.{pathParams,queryParams,headers,body}` y `response.fields` son los mismos del resto del DSL: base types, value types de `domain: types` o `enum` inline. En esta capa, prefiere enums nominales del dominio a enums inline.
- Un campo puede ser una colección con `list: true` (acotable con `constraints: { minItems, maxItems }`) — típico en query params repetidos y en respuestas que devuelven varios elementos. No es válido en `pathParams`.
- Toda variable `{var}` de `path` debe declararse en `request.pathParams` y viceversa (`keel validate` lo comprueba).
- `response.fields` describe la forma que **devuelve el sistema externo** (contrato wire). Los generadores la aíslan del dominio con una capa de anticorrupción: si el tercero cambia su respuesta, solo cambia esta capa y su adaptador.

## Autenticación saliente (`auth`, por cliente)

- `type`: `none` | `api-key` (con `headerName`, por defecto `X-Api-Key`) | `bearer-static` | `basic` | `oauth2-client-credentials` (con `tokenUrl` obligatorio y `scopes` opcionales).
- **Las credenciales jamás van en el diseño.** Aquí se declara solo el mecanismo; los valores (api keys, tokens, client secrets, incluso el `tokenUrl` efectivo por entorno) llegan por configuración/variables de entorno del servicio generado.

## Resiliencia

- `retry`: `maxAttempts` (obligatorio), `backoff` (`fixed` | `exponential`, por defecto `exponential`), `initialDelayMs` (espera antes del primer reintento) y `maxDelayMs` (tope al que la espera deja de crecer; solo tiene efecto con `backoff: exponential`, donde acota el crecimiento). Con `backoff: fixed`, `maxDelayMs` **no hace nada y ninguna regla lo avisa**: es un límite declarado de la validación mecánica, no un descuido. Si aparece ahí, sobra.
- `retry.retryOn`: `timeout`, `5xx`, `connection`. Nunca reintentar 4xx.
- `circuitBreaker`: `failureRateThreshold` (% de fallos que abre el circuito), `slidingWindowSize` (llamadas observadas), `waitDurationMs` (espera antes de probar de nuevo).
- Todo `circuitBreaker` debería tener `fallback` definido: qué hace el servicio cuando el circuito está abierto. `keel validate` avisa si falta; la skill `/keel-validate` revisa la calidad del fallback.
- **La resiliencia la decide el diseñador**, no el agente: el `timeoutMs` sale del presupuesto de latencia de **nuestra** operación (nunca del SLA ajeno), la caída del tercero se traduce a un `code` propio, y un `fallback` que produce datos plausibles pero falsos es peor que el error que evita. Ejes de decisión: `references/structural-decisions.md` de la skill `keel-design` §3.6.

## Idempotencia saliente (`idempotency`, por llamada)

Reintentar es ejecutar otra vez. En una lectura da igual; en una escritura ajena —cobrar, reservar, inscribir— el reintento **duplica el efecto al otro lado**, y un timeout no distingue «no llegó» de «llegó y se hizo». Es la cara simétrica de `use-cases.<op>.idempotency`: aquella evita que un cliente nos ejecute dos veces a nosotros, esta que nosotros ejecutemos dos veces al proveedor. Y es la deuda que después intenta arreglar una `compensation`, cuando ya hay dos cargos.

```yaml
        idempotency: { keyFrom: payload-hash }        # o { keyFrom: correlation, header: X-Request-Id }
        retry: { maxAttempts: 3, retryOn: [timeout, connection] }
```

- `keyFrom: payload-hash` — la clave es la firma determinista del contenido de la petición. El reintento manda lo mismo, luego repite clave. Es el caso normal.
- `keyFrom: correlation` — la clave sale del identificador de correlación de la ejecución en curso. Se usa cuando el proveedor deduplica por **intención de negocio** y no por contenido: dos peticiones idénticas de dos ejecuciones distintas sí deben ejecutarse las dos.
- `header` — solo si el proveedor usa una cabecera distinta de `Idempotency-Key`.
- Solo sirve **si el proveedor la honra**: eso es parte de su contrato, no una decisión nuestra. Si no la honra, dilo en el `contract` de la llamada — que reintentar duplica es información que el siguiente que lea el diseño necesita.
- `keel validate` avisa de un `retry` sobre un método no seguro (`POST`/`PUT`/`PATCH`/`DELETE`) sin `idempotency` declarada.

## Qué NO va aquí

- Eventos asíncronos → capa `messaging`.
- **Por qué existe una llamada**: de qué servidor dependemos, qué dato le pedimos y qué caso de uso lo necesita → capa `dependencies`. Aquí se declara el canal saliente; allí, la razón de negocio que lo justifica.
- El error de negocio que el fallback dispara (`PRICE_UNAVAILABLE`) se declara en la operación de `use-cases` que hace la llamada.
- Credenciales o secretos de ningún tipo.
