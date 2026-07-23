# Capa `security` — autenticación y autorización (opcional)

Archivo: `specs/<servicio>/security.keel.yaml` · Schema: [`schema/security.schema.json`](../../schema/security.schema.json)

Integración con el servidor de autenticación y reglas de acceso. Agnóstica del proveedor: se declara el protocolo (`oidc`, `jwt`, `api-key`), nunca el producto (Keycloak, Auth0…). Las reglas se declaran **por operación** — el nombre es estable aunque cambien las rutas.

Si el servicio declara capa `api` sin capa `security`, `keel validate` emite un warning.

```yaml
authentication:
  protocol: oidc                 # oidc | jwt | api-key | none
  tokenLocation: header

roles:
  catalog-admin:  { description: Gestiona el catálogo completo. }
  catalog-reader: { description: Solo consulta el catálogo. }

permissions:
  product:write: { description: Crear y mutar productos. }
  product:read:  { description: Leer productos. }

roleGrants:
  catalog-admin: [product:write, product:read]
  catalog-reader: [product:read]

access:
  default: { level: required, permissions: [product:read] }
  rules:
    createProduct: { level: required, permissions: [product:write] }
    retireProduct: { level: admin, roles: [catalog-admin] }
    listProducts:  { level: public }
```

- `access.default` cubre toda operación sin regla explícita; `rules` la sobrescribe por operación.
- `level`: `public` (sin token), `required` (token válido), `admin` (token + privilegio elevado), `service` (token de cliente máquina; ver más abajo).
- `roles` y `permissions` son catálogos: toda referencia desde `access` o `roleGrants` debe existir en ellos.
- Permisos en formato `recurso:accion` (`product:write`); roles en kebab-case.
- Principio de mínimo privilegio: la skill `/keel-validate` revisa que ningún rol acumule permisos que no use.

## Clientes máquina (M2M)

Cuando otros servidores consumen endpoints del servicio (capa `api` con `audience: services` o `both`), la seguridad se modela con tres piezas:

```yaml
authentication:
  protocol: oidc
  serviceAuth:                    # cómo se autentican los clientes máquina
    protocol: client-credentials  # client-credentials | api-key
    validateAudience: true        # exige que el claim aud incluya la audiencia del servicio
    audience: product-service     # opcional; por defecto, el nombre del servicio

serviceClients:                   # catálogo de servicios consumidores reconocidos
  billing-service: { description: Consulta precios para facturar., scopes: [product:read] }

access:
  rules:
    getProductPrice: { level: service, scopes: [product:read] }
```

- `serviceAuth` es obligatorio si hay endpoints `services`/`both` o `serviceClients` (lo valida `keel validate`). `client-credentials` es el flujo OAuth2 para máquinas (nunca tokens de usuario); `api-key` es la alternativa simple.
- **Los scopes reutilizan el catálogo `permissions`**: `permissions` es el catálogo único de capacidades del servicio; `accessRule.permissions` las exige a usuarios humanos y `scopes` a clientes máquina. No hay catálogo de scopes aparte.
- `serviceClients` declara cada consumidor y los scopes que se le conceden (mínimo privilegio por cliente). El proveedor concreto (Keycloak, Cognito…) materializa cada entrada como cliente `client_credentials` al generar.
- `level: service` sin `scopes` acepta cualquier cliente autenticado (warning de `keel validate`); combínalo con `validateAudience: true` para que solo valgan tokens emitidos para este servicio.

Combinaciones válidas de `audience` (capa `api`) × `level`:

| `audience` | Niveles válidos | Notas |
|---|---|---|
| `users` (default) | `public`, `required`, `admin` | `scopes` prohibido |
| `services` | `service` (con `scopes`), `public` | `roles` prohibido con `service` |
| `both` | `required` (opcionalmente `scopes` + `roles`/`permissions`, semántica "cualquiera de"), `public` | `service` sería error: excluiría a los usuarios |
