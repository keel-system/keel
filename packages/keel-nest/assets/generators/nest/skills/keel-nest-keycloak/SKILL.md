---
name: keel-nest-keycloak
description: Guía de autenticación OIDC con Keycloak en un proyecto generado por keel-nest — sembrar el realm de prueba con el script que genera build, pedir tokens desde el arnés, verificar las reglas de acceso y diagnosticar un 401/403 inesperado; el código de seguridad ya lo genera build. Usar cuando keel-stack.json declara auth "keycloak".
---

# Keycloak (auth: `keycloak`)

La capa `security` sale **entera** de build, y es la misma autorización que el servidor de keel-spring
del diseño (el plan de acceso lo decide keel-core): **no reescribas ese código**.

| Pieza | Dónde | Qué hace |
|---|---|---|
| Hook de la entrada HTTP | `src/infrastructure/security/http-security.ts` | Decide ANTES de enrutar, como Spring Security: sin credencial, un camino que no existe es 401, no 404 |
| Reglas como datos | `src/infrastructure/security/access-rules.ts` | Una fila por regla de `access.rules`, en orden, más el cierre de `access.default` |
| Validación del JWT | `src/infrastructure/security/jwt-authenticator.ts` | `jose` contra el JWKS del `issuer-uri` (discovery), `iss` exacto, 60 s de margen; `realm_access.roles` → `ROLE_<rol>`, `scope` → `SCOPE_<scope>`, `permissions` y los `roleGrants` del diseño |
| Identidad del llamante | `src/infrastructure/security/caller-identity.ts` | El único punto que mira el token para `callerIdentity`; los controladores la estampan en el mensaje |
| Alcance por recurso | `src/application/support/caller-scope.ts` + `jwt-caller-scope.ts` | El puerto que reciben inyectado los handlers que declaran el error del alcance |
| Realm de prueba | `infra/init-keycloak.sh` | Realm, roles, dos usuarios por rol (`<rol>`, `<rol>-2`), `no-role`, clientes del diseño y la matriz `test-m2m-*` |
| Credenciales | `infra/test-credentials.env` | Lo que el script crea y el arnés lee: un solo productor, un solo consumidor |

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"auth": "keycloak"`.
- Lee `specs/security.keel.yaml`: roles, `access.rules`, `serviceClients`, `callerIdentity`, `scoping`.
- **Frontera**: build dejó el código, la configuración por perfil (`config/parameters/<perfil>/security.yaml`)
  y el aprovisionamiento. Lo que queda es ejecutarlo y verificarlo.

## Qué hace cada agente

**Infraestructura** — con la infra arriba (`bash infra/up.sh`):

1. `bash infra/init-keycloak.sh`. Es idempotente (tolera el 409 de lo que ya existe) y espera a que
   Keycloak acepte la sesión de administración: si sale con error, el realm está a medias y no hay que
   seguir. **No lo edites**: si algo tiene que cambiar, cambia en el diseño.
2. `bash infra/validate-infra.sh`: con alcance por recurso, comprueba usuario a usuario que el claim
   llega al token.

**Pruebas** — el arnés (`test/integration/support/flow.ts`) ya trae las credenciales:

```ts
import { bearer, tokenFor, serviceCredential, tokenAs, scopedResource } from './support/flow.js';

await flow.get(`${ROUTE_BASE}/me/card`, bearer(await tokenFor('card-holder')));     // usuario con el rol
await flow.get(ruta, bearer(await tokenFor('editor', 2)));                         // el SEGUNDO usuario del rol
await flow.get(ruta, bearer(await tokenFor('no-role')));                           // autenticado sin roles: el 403
await flow.get(ruta, bearer(await serviceCredential('billing-service')));          // cliente máquina
await flow.get(ruta, bearer(await tokenAs('sub-ana-001', { email: 'ana@x.test' }))); // persona con un sub elegido
```

Llama a la función **en cada petición**: el token dura cinco minutos y la caché lo renueva solo si se le
pregunta. `tokenAs` existe cuando la identidad del llamante es el claim `sub`: da de alta a la persona por
la API de administración del realm con ese `sub` exacto y los claims del escenario (un `null` quita el
claim).

## Lo que tiene que dar cada caso

| Situación | Status | `code` |
|---|---|---|
| Sin `Authorization`, token mal formado, caducado o de otra firma | 401 | `UNAUTHENTICATED` |
| Token inválido en una ruta abierta (`/livez`) | 401 | `UNAUTHENTICATED` |
| Token válido sin el rol, permiso o scope de la regla | 403 | `ACCESS_DENIED` |
| Token de máquina con la audiencia de otro servicio (`validateAudience`) | 403 | `ACCESS_DENIED` |
| Camino que no existe, sin credencial (cierre no público) | 401 | `UNAUTHENTICATED` |

Un 401 donde esperabas 403 es que el token **no llegó a autenticarse**: diagnostica eso antes de tocar
roles o scopes (`references/troubleshooting.md`).

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/test-clients.md` | Antes de escribir un escenario M2M negativo: qué varía en cada cliente `test-m2m-*` |
| `references/troubleshooting.md` | Ante un 401/403 inesperado, un `invalid_grant` o un claim que no llega |
