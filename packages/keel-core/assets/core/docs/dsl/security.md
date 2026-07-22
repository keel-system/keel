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
- `level`: `public` (sin token), `required` (token válido), `admin` (token + privilegio elevado).
- `roles` y `permissions` son catálogos: toda referencia desde `access` o `roleGrants` debe existir en ellos.
- Permisos en formato `recurso:accion` (`product:write`); roles en kebab-case.
- Principio de mínimo privilegio: la skill `/keel-validate` revisa que ningún rol acumule permisos que no use.
