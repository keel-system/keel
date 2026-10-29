# HTTP y seguridad del borde

## El servidor

- `net/http` sin framework: el enrutador entiende método y patrón (`mux.HandleFunc("GET /orders/{id}", …)`,
  `r.PathValue("id")`).
- El `http.Server` lleva **siempre** `ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout`, `IdleTimeout` y
  `MaxHeaderBytes`: los de net/http por defecto son «sin límite», y un cliente lento retendría la conexión para
  siempre. Los emite build en `internal/httpapi`.
- El cuerpo tiene tope (`http.MaxBytesReader` con `MaxBodyBytes`, en el borde): pasarse es un 413.

## La API que emite build

- `internal/httpapi/routes.go` es el ÚNICO mapa de rutas: una fila por operación, de la que se registra cada
  endpoint en el ServeMux. Una ruta nueva no se registra a mano en otra parte.
- Cada operación tiene su endpoint (`<grupo>_endpoints.go`) y su lector generado (`read<Operación>`): convierte la
  petición al mensaje del caso de uso y valida las reglas del diseño, en el orden del binding de keel-spring. El
  agente no los toca: escribe el handler (`internal/application`).
- Un endpoint DEVUELVE su error; `writeError` lo traduce con `errors.As`. Un `*domain.Error` responde con su status
  y su `code`; cualquier otro error es el 500 del contrato, y es lo único que se registra entero. Un pánico lo
  recupera el borde como un 500 con su pila en el log: no es la forma de devolver un error.

## JSON

- Un solo punto de lectura y escritura de JSON (`internal/platform/wire`, con encoding/json/v2): ahí se cumple el
  contrato del cable.
- Tras el cuerpo no puede quedar un segundo valor, y los nombres casan exactos (el v1 casaba `"A"` con `a`).
- Una lista vacía sale como `[]`: json/v2 escribe así un slice `nil`. Lo que el contrato quiere `null` (los
  `details` de un error sin detalles) lleva su `MarshalJSONTo`.
- json/v2 llama a `UnmarshalJSONFrom` también con `null`: por eso el lector lee el cuerpo como objeto y cada miembro
  presente y no nulo sobre su campo, en vez de todo el cuerpo sobre el mensaje.

## Clientes salientes

- Nunca `http.DefaultClient` ni `http.Get`: no tienen plazo. Un `http.Client` propio con `Timeout`, y las
  peticiones con `http.NewRequestWithContext`.
- El cuerpo de la respuesta se cierra siempre (`defer response.Body.Close()`).

## Seguridad

- Secretos, tokens y firmas de webhooks se comparan con `hmac.Equal` o `subtle.ConstantTimeCompare`.
- Aleatoriedad con `crypto/rand`; `math/rand` nunca para nada que importe.
- Nada de `fmt.Sprintf` en SQL ni en la ruta de un comando.
- Ningún secreto en los logs: el handler de `slog` los redacta por el nombre del atributo.
