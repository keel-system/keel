# HTTP y seguridad del borde

## El servidor

- `net/http` sin framework: el enrutador entiende método y patrón (`mux.HandleFunc("GET /orders/{id}", …)`,
  `r.PathValue("id")`).
- El `http.Server` lleva **siempre** `ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout`, `IdleTimeout` y
  `MaxHeaderBytes`: los de net/http por defecto son «sin límite», y un cliente lento retendría la conexión para
  siempre. Los emite build en `internal/httpapi`.
- Un cuerpo se lee con `http.MaxBytesReader`; pasarse es el 413 del contrato.

## JSON

- Un solo punto de lectura y escritura de JSON (`internal/httpapi`): ahí se cumple el contrato del cable.
- Decodificación estricta: tras el cuerpo no puede quedar un segundo valor, y `DisallowUnknownFields` solo donde
  el contrato lo pida.
- Una lista vacía sale como `[]`, nunca como `null`: un slice `nil` se serializa como `null`.

## Clientes salientes

- Nunca `http.DefaultClient` ni `http.Get`: no tienen plazo. Un `http.Client` propio con `Timeout`, y las
  peticiones con `http.NewRequestWithContext`.
- El cuerpo de la respuesta se cierra siempre (`defer response.Body.Close()`).

## Seguridad

- Secretos, tokens y firmas de webhooks se comparan con `hmac.Equal` o `subtle.ConstantTimeCompare`.
- Aleatoriedad con `crypto/rand`; `math/rand` nunca para nada que importe.
- Nada de `fmt.Sprintf` en SQL ni en la ruta de un comando.
- Ningún secreto en los logs: el handler de `slog` los redacta por el nombre del atributo.
