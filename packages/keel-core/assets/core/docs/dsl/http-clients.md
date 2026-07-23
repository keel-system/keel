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
- Toda variable `{var}` de `path` debe declararse en `request.pathParams` y viceversa (`keel validate` lo comprueba).
- `response.fields` describe la forma que **devuelve el sistema externo** (contrato wire). Los generadores la aíslan del dominio con una capa de anticorrupción: si el tercero cambia su respuesta, solo cambia esta capa y su adaptador.

## Autenticación saliente (`auth`, por cliente)

- `type`: `none` | `api-key` (con `headerName`, por defecto `X-Api-Key`) | `bearer-static` | `basic` | `oauth2-client-credentials` (con `tokenUrl` obligatorio y `scopes` opcionales).
- **Las credenciales jamás van en el diseño.** Aquí se declara solo el mecanismo; los valores (api keys, tokens, client secrets, incluso el `tokenUrl` efectivo por entorno) llegan por configuración/variables de entorno del servicio generado.

## Resiliencia

- `retry.retryOn`: `timeout`, `5xx`, `connection`. Nunca reintentar 4xx.
- `circuitBreaker`: `failureRateThreshold` (% de fallos que abre el circuito), `slidingWindowSize` (llamadas observadas), `waitDurationMs` (espera antes de probar de nuevo).
- Todo `circuitBreaker` debería tener `fallback` definido: qué hace el servicio cuando el circuito está abierto. `keel validate` avisa si falta; la skill `/keel-validate` revisa la calidad del fallback.

## Qué NO va aquí

- Eventos asíncronos → capa `messaging`.
- El error de negocio que el fallback dispara (`PRICE_UNAVAILABLE`) se declara en la operación de `use-cases` que hace la llamada.
- Credenciales o secretos de ningún tipo.
