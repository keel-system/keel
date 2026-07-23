# HTTP clients — configuración por perfil

`keel-spring build` genera `parameters/<perfil>/http-clients.yaml` para cada
perfil (`local`, `develop`, `production`, `test`). Estos fragmentos los ensambla
el arranque por perfil; **no** dupliques la config en `application.yaml`.

## Qué genera build (y qué NO tocas)

Derivado del diseño, **no lo edites** salvo para afinar valores de despliegue:

```yaml
http-clients:
  pricing-service:
    base-url: ${PRICING_SERVICE_BASE_URL}      # obligatorio fuera de local
    auth:
      api-key: ${PRICING_SERVICE_API_KEY:}     # credencial por env var, nunca del diseño
resilience4j:
  retry:
    instances:
      pricing-service-get-price:
        max-attempts: 3
        wait-duration: 500ms
        enable-exponential-backoff: true
        retry-exceptions:
          - org.springframework.web.client.HttpServerErrorException   # 5xx
          - org.springframework.web.client.ResourceAccessException    # timeout/connection
        ignore-exceptions:
          - org.springframework.web.client.HttpClientErrorException   # 4xx: NUNCA reintentar
  circuitbreaker:
    instances:
      pricing-service-get-price:
        failure-rate-threshold: 50
        sliding-window-size: 20
        wait-duration-in-open-state: 30000ms
```

Reglas que build ya aplica y que debes **preservar**:

- **`base-url`**: el DSL no declara URLs (son infraestructura). Fuera de `local` la
  env var es **obligatoria sin default**: un despliegue sin configurar debe fallar
  al arrancar, no llamarse a sí mismo en silencio.
- **Credenciales**: siempre por env var (`<C>_API_KEY`, `<C>_TOKEN`,
  `<C>_USERNAME`/`<C>_PASSWORD`; oauth2 en `spring.security.oauth2.client.*` con
  `<C>_CLIENT_ID`/`<C>_CLIENT_SECRET`/`<C>_TOKEN_URL`). Jamás un secreto literal en
  el fragmento.
- **`ignore-exceptions` con `HttpClientErrorException`**: los 4xx no se reintentan.
  No lo quites.
- Los nombres de instancia son `<cliente>-<llamada>`: deben coincidir con los
  `name` de `@Retry`/`@CircuitBreaker`. Si no cuadran, resilience4j aplica su
  config por defecto en silencio.

## Qué te toca al agente

- **Apuntar `local`/`test` a un stub.** build deja en `local` un
  `# TODO (agente): URL del servicio de prueba/mock`. Si levantas un stub HTTP en
  `infra/` para validar, fija ahí su URL (p. ej. `http://wiremock:8080`).
- **Timeouts finos.** El read-timeout del bean es el mayor `timeoutMs` del cliente;
  si una llamada concreta necesita otro, ajústalo en el `<C>ClientConfig` (no en el
  YAML: el timeout del bean no es una property estándar).
- **Ajustar `retry`/`circuitbreaker`** solo si el diseño lo pide y los valores
  derivados no bastan; documenta el porqué.

## Perfil `test`

Con oauth2-client-credentials, build ya deja un fragmento `test` que evita que el
manager oauth2 intente emitir tokens en `@SpringBootTest`. Para el resto, el perfil
`test` no necesita `base-url` real salvo que un test de integración ejercite la
llamada contra un stub; en ese caso apúntalo al stub, nunca a la URL de producción.
