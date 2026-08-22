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

## Identidad del llamante (`authentication.callerIdentity`)

Quién pide el trabajo — no si puede pedirlo (eso es `access`), sino **en nombre de qué recurso** lo pide.

```yaml
authentication:
  protocol: oidc
  callerIdentity:
    field: applicationCode          # el campo del input que la recibe, YA resuelta
    from: { source: serviceClient } # el cliente máquina de la credencial ES el recurso
    # from: { source: claim, name: tenant }   # o un claim que puebla el proveedor
```

- Es el **hermano** de `messaging.subscriptions.<E>.identity`: el mismo hecho por la otra puerta. Si una operación entra por las dos, **las dos tienen que nombrar el mismo `field`** — dos campos son dos verdades, y la operación decidiría con uno u otro sin saberlo. `keel validate` lo da en rojo.
- El campo **deja de viajar en el cuerpo** de la petición: lo estampa el servidor, igual que un campo `generated`. Quien hace la petición es justamente quien no debería poder elegir en nombre de quién actúa, así que no hay nada que comprobar ni ningún error de inconsistencia que declarar.
- La resolución vive en **un solo punto**. Cambiar de la credencial a un claim son dos líneas y no toca dominio, casos de uso ni esquema.
- Sin este bloque, un servicio que resuelve el inquilino por la credencial deja esa resolución en la prosa de una `rule`, y cada implementación la inventa: el dato acaba llegando del cuerpo o duplicado en dos campos que alguien tiene que reconciliar a mano.

## Alcance por recurso (`authentication.scoping`)

`roles`, `permissions` y `scopes` son **globales**: quien pasa la regla de acceso, pasa para **todos** los recursos. Un servicio multi-inquilino necesita además acotar al recurso concreto, y eso no cabe en `access` — una regla de acceso decide si puedes ejecutar la operación, no sobre qué filas.

```yaml
authentication:
  protocol: oidc
  scoping:
    claim: applications          # el claim del token con los recursos que alcanza el titular
    over: Application.code       # qué identifica al recurso acotado (Entidad.campo de domain)
    error: APPLICATION_FORBIDDEN # el code del rechazo: es contrato público
    exemptRoles: [catalog-admin] # roles transversales, que NO se acotan
```

- `over` apunta a una entidad y un campo **que existen en `domain`**, y es el dato que las operaciones acotadas reciben.
- `error` es un `code` que alguna operación tiene que declarar en sus `errors` (con su `403` y su `when`): ahí es donde vive el contrato. Declarar el alcance sin su error es un **error de validación**.
- `exemptRoles` se enumera uno a uno. La exención es la parte peligrosa —un rol exento alcanza cualquier recurso— y no puede quedar implícita.
- **Sin este bloque**, un 403 declarado sobre una operación protegida por rol describe una discriminación que nada evalúa: `keel validate` lo avisa, el generador emite el código igual, y el servidor acaba sirviendo a cualquier titular del rol los recursos de todos los inquilinos.
- Qué recurso alcanza cada usuario **de prueba** no es del diseño: el generador siembra el proveedor de identidad con un valor convencional y lo publica para el arnés (en keel-spring, `AUTH_SCOPED_RESOURCE` de `infra/test-credentials.env`).
- La comprobación en sí se escribe como `rule` en cada operación acotada — el DSL declara de dónde sale el alcance, no el algoritmo que lo aplica.

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

## CORS (consumo desde el navegador)

El bloque `cors` declara que el servicio se consume desde un origen web. Solo hace falta si un navegador llama a la API directamente: sin él, el servidor generado rechaza toda petición cross-origin (el preflight muere en la cadena de seguridad).

```yaml
cors:
  description: Consumido desde el navegador por la SPA de back-office.
  allowCredentials: false
  allowedHeaders: [Authorization, Content-Type, Idempotency-Key]
  exposedHeaders: [X-Correlation-Id]
  maxAgeSeconds: 3600
```

- **Los orígenes permitidos no se declaran aquí.** Son URLs de despliegue, no diseño: cambian por ambiente y no deben obligar a regenerar. El generador los expone como configuración del servicio (en Spring, la variable `SECURITY_CORS_ALLOWED_ORIGINS`, obligatoria fuera de local).
- **Los métodos tampoco**: se derivan de los endpoints declarados en la capa `api`, más `OPTIONS` para el preflight.
- `allowCredentials: true` es obligatorio si `authentication.tokenLocation` es `cookie` (lo valida `keel validate`); con token en `Authorization` déjalo en `false`.
- `exposedHeaders` es lo que el navegador deja **leer** de la respuesta: normalmente solo cabeceras propias (correlación, paginación).

Requiere capa `api`: CORS sin HTTP entrante no significa nada (error de `keel validate`).

Combinaciones válidas de `audience` (capa `api`) × `level`:

| `audience` | Niveles válidos | Notas |
|---|---|---|
| `users` (default) | `public`, `required`, `admin` | `scopes` prohibido |
| `services` | `service` (con `scopes`), `public` | `roles` prohibido con `service` |
| `both` | `required` (opcionalmente `scopes` + `roles`/`permissions`, semántica "cualquiera de"), `public` | `service` sería error: excluiría a los usuarios |
