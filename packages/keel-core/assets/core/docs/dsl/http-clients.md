# Capa `http-clients` — integraciones HTTP salientes (opcional)

Archivo: `specs/<servicio>/http-clients.keel.yaml` · Schema: [`schema/http-clients.schema.json`](../../schema/http-clients.schema.json)

Llamadas síncronas a terceros u otros servicios, descritas por **contrato**. La resiliencia (timeout, retry, circuit breaker, fallback) se declara aquí, por llamada: es política del canal saliente y la reutilizan todos los casos de uso que lo usen.

```yaml
clients:
  pricing-service:
    purpose: Obtener el precio vigente de un producto.
    calls:
      getPrice:
        contract: "GET /prices/{sku} -> { amount: decimal, currency: string }"
        timeoutMs: 2000
        retry: { maxAttempts: 3, backoff: exponential, initialDelayMs: 200, retryOn: [timeout, 5xx] }
        circuitBreaker: { failureRateThreshold: 50, slidingWindowSize: 20, waitDurationMs: 30000 }
        fallback: Devolver el último precio conocido en caché; si no existe, error PRICE_UNAVAILABLE.
```

- `contract` resume método, ruta y forma de la respuesta; no es un OpenAPI — es el mínimo que un integrador y el generador necesitan.
- `retry.retryOn`: `timeout`, `5xx`, `connection`. Nunca reintentar 4xx.
- `circuitBreaker`: `failureRateThreshold` (% de fallos que abre el circuito), `slidingWindowSize` (llamadas observadas), `waitDurationMs` (espera antes de probar de nuevo).
- Todo `circuitBreaker` debería tener `fallback` definido: qué hace el servicio cuando el circuito está abierto. La skill `/keel-validate` lo revisa.

## Qué NO va aquí

- Eventos asíncronos → capa `messaging`.
- El error de negocio que el fallback dispara (`PRICE_UNAVAILABLE`) se declara en la operación de `use-cases` que hace la llamada.
