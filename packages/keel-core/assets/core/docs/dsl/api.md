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

- `auto: true` deriva rutas CRUD: `createX → POST /xs`, `getX → GET /xs/{id}`, `listXs → GET /xs`, `updateX → PUT /xs/{id}`, `deleteX → DELETE /xs/{id}`. Los `endpoints` explícitos cubren operaciones no-CRUD.
- Cada clave de `endpoints` debe ser una operación de `use-cases` (referencia por nombre, validada por `keel validate`).
- `audience` declara el público del endpoint: `users` (clientes web/mobile con usuario humano, el default), `services` (otros servidores, M2M) o `both`. Reutilizar un endpoint para ambos públicos es posible pero **explícito** (`both`); lo habitual es que los consumidores servidor tengan endpoints propios con contrato pensado para máquina.
- `defaultAudience` fija la audiencia de los endpoints sin `audience` propia, incluidos los derivados por `auto`. Una operación CRUD cubierta por `auto` que necesite otra audiencia debe declararse como endpoint explícito.
- La coherencia audiencia ↔ regla de acceso (nivel `service`, scopes) la valida `keel validate` contra la capa `security`.
- `pagination` aplica a los outputs con `paginated: true`.
- Paths con `{param}` van entre comillas en YAML.

## Qué NO va aquí

- Qué endpoints son públicos o protegidos, roles y permisos → capa `security` (por operación, no por ruta).
- Validaciones y errores de la operación → capa `use-cases`.
