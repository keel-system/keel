# Capa `api` — integración con el cliente (opcional)

Archivo: `specs/<servicio>/api.keel.yaml` · Schema: [`schema/api.schema.json`](../../schema/api.schema.json)

Cómo se exponen las operaciones al cliente vía REST. Existe solo si el servicio tiene API; un worker puro que solo consume eventos no la declara.

```yaml
style: rest
basePath: /api/v1
auto: true                       # rutas CRUD por convención desde los nombres de operación
defaultAudience: users           # público por defecto: users | services | both
endpoints:                       # mapeo explícito; prioridad sobre auto
  retireProduct:   { method: POST, path: "/products/{productId}/retire", successStatus: 200 }
  getProductPrice: { method: GET, path: "/products/{productId}/price", audience: services }
pagination: { style: offset, defaultSize: 20, maxSize: 100 }
```

- `basePath` es el prefijo de todas las rutas. Si **no** incluye la versión (`/api`), el generador añade `/v1`; si ya la incluye (`/api/v1`, `/api/v2`), se respeta tal cual. Las dos formas son válidas: elige una y no mezcles.
- `auto: true` deriva rutas CRUD: `createX → POST /xs`, `getX → GET /xs/{id}`, `listXs → GET /xs`, `updateX → PUT /xs/{id}`, `deleteX → DELETE /xs/{id}`. Los `endpoints` explícitos cubren operaciones no-CRUD.
- Cada clave de `endpoints` debe ser una operación de `use-cases` (referencia por nombre, validada por `keel validate`).
- **Preferencia por defecto para un borrado: `successStatus: 204` con `output: "void"` en `use-cases`.** El 204 dice exactamente lo que pasó y no obliga al cliente a leer ni a ignorar un cuerpo; es también lo que asume el generador en un `DELETE` sin `successStatus` (y lo que produce `auto: true` para `deleteX`), así que declarar `output` sin declarar el status deja el contrato a merced de ese default. Devolver cuerpo es legítimo cuando la operación **cambia más de lo que borra** —recompactar posiciones, reasignar el elemento principal, recalcular un total— y esa representación le ahorra al cliente un GET que no podría predecir; entonces el status tiene que admitir cuerpo (`200`). Lo que no existe es el punto medio: `204` con `output` no-void es una respuesta que ningún cliente HTTP puede consumir, y `keel validate` lo da en rojo.
- `audience` declara el público del endpoint: `users` (clientes web/mobile con usuario humano, el default), `services` (otros servidores, M2M) o `both`.
- **Preferencia por defecto: cada consumo servidor-a-servidor tiene operación propia en `use-cases` y endpoint propio con `audience: services`.** No es duplicación gratuita: `endpoints` se indexa **por nombre de operación**, así que compartir endpoint es compartir output, errores, paginación y scopes. Y los dos contratos crecen en direcciones opuestas —el de máquina hacia lotes, campos estables y respuestas sin adorno de pantalla; el de usuarios hacia lo contrario—, de modo que sin operación propia no pueden divergir sin romperse mutuamente, y el que se rompe es el que tiene otro equipo acoplado detrás. Nombra la operación M2M por su intención (`listProductsBatch`, `getProductPriceForServices`), no duplicando la de usuarios con un sufijo casual.
- `audience: both` (un endpoint para ambos públicos) es legítimo, pero es **la excepción**: cualquier cambio para usuarios pasa a ser un cambio para el consumidor servidor. Lo elige el diseñador a sabiendas y su porqué queda en `DESIGN.md`; el análisis de huecos lo lista siempre como riesgo. Ejes de decisión: `references/structural-decisions.md` de la skill `keel-design` §3.4 (y §3.8 para la paginación).
- `defaultAudience` fija la audiencia de los endpoints sin `audience` propia, incluidos los derivados por `auto`. Una operación CRUD cubierta por `auto` que necesite otra audiencia debe declararse como endpoint explícito.
- La coherencia audiencia ↔ regla de acceso (nivel `service`, scopes) la valida `keel validate` contra la capa `security`.
- `pagination` aplica a los outputs con `paginated: true`.
- **Forma del sobre de paginación (contrato canónico)**: una respuesta `paginated: true` es siempre

  ```json
  { "items": [ … ], "page": 0, "size": 20, "totalElements": 42, "totalPages": 3 }
  ```

  La página se pide con los query params `page` (base 0) y `size`. `defaultSize` es el `size` cuando
  el cliente no lo manda y `maxSize` el tope: un `size` mayor se recorta a `maxSize`, no da error.
  Los nombres no se declaran en el DSL porque son los mismos para todo servicio y todo generador —
  **los escenarios de validación deben escribirse contra estos**.
- Paths con `{param}` van entre comillas en YAML.

## Qué NO va aquí

- Qué endpoints son públicos o protegidos, roles y permisos → capa `security` (por operación, no por ruta).
- Validaciones y errores de la operación → capa `use-cases`.
