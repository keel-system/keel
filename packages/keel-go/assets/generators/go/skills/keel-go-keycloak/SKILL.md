---
name: keel-go-keycloak
description: Guía de autenticación OIDC con Keycloak en un proyecto generado por keel-go — sembrar el realm de prueba con el script que genera build, pedir tokens desde el arnés de los flujos, verificar las reglas de acceso y diagnosticar un 401/403 inesperado; el código de seguridad ya lo genera build. Usar cuando keel-stack.json declara auth "keycloak".
---

# Keycloak (auth: `keycloak`)

La capa `security` sale **entera** de build, con la cabecera de código generado, y es la misma autorización que
los servidores de keel-spring, keel-nest y keel-dotnet del diseño (el plan de acceso lo decide keel-core): **no
reescribas ese código**.

| Pieza | Dónde | Qué hace |
|---|---|---|
| Decisión de la entrada HTTP | `internal/httpapi/security.go` | Las reglas de `access.rules` como datos y un middleware que decide ANTES de enrutar: sin credencial, un camino que no existe es 401, no 404 |
| Validación del JWT | `internal/platform/security/jwt.go` | golang-jwt contra el JWKS del `issuer-uri` (discovery, perezoso), `iss` exacto, 60 s de margen; `realm_access.roles` → `ROLE_<rol>`, `scope` → `SCOPE_<scope>`, `permissions` y los `roleGrants` del diseño |
| El principal | `internal/platform/security/principal.go` | Quién llama, en el contexto de la petición; de ahí sale la identidad del llamante (`callerIdentity`), que los lectores de los endpoints estampan en el mensaje |
| Realm de prueba | `infra/init-keycloak.sh` | Realm, roles, dos usuarios por rol (`<rol>`, `<rol>-2`), `no-role`, clientes del diseño y la matriz `test-m2m-*` |
| Credenciales | `infra/test-credentials.env` | Lo que el script crea y el arnés lee: un solo productor, un solo consumidor |
| Credenciales en los flujos | `tests/integration/credentials_test.go` | `Bearer`, `TokenFor`, `SecondTokenFor`, `ServiceCredential`, `TokenAs` |

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"auth": "keycloak"`.
- Lee `specs/security.keel.yaml`: roles, `access.rules`, `serviceClients`, `callerIdentity`.
- **Frontera**: build dejó el código, la configuración por perfil (`config/parameters/<perfil>/security.yaml`)
  y el aprovisionamiento. Lo que queda es ejecutarlo y verificarlo.

## Qué hace cada agente

**Infraestructura** — con la infra arriba (`bash infra/up.sh`):

1. `bash infra/init-keycloak.sh`. Es idempotente (tolera el 409 de lo que ya existe) y espera a que Keycloak
   acepte la sesión de administración: si sale con error, el realm está a medias y no hay que seguir. **No lo
   edites**: si algo tiene que cambiar, cambia en el diseño.
2. `bash infra/validate-infra.sh`.

**Pruebas** — el arnés de los flujos ya trae las credenciales (`tests/integration/credentials_test.go`); las
cabeceras van detrás del cuerpo en cualquier verbo:

```go
got := s.Get(RouteBase+"/me/card", Bearer(s.TokenFor("card-holder")))     // usuario con el rol
other := s.Get(RouteBase+"/me/card", Bearer(s.SecondTokenFor("card-holder"))) // el SEGUNDO usuario del rol
denied := s.Get(RouteBase+"/me/card", Bearer(s.TokenFor("no-role")))       // autenticado sin roles: el 403
machine := s.Get(RouteBase+"/me/card", Bearer(s.ServiceCredential("billing-service"))) // cliente máquina
ana := s.Get(RouteBase+"/me/card", Bearer(s.TokenAs(Persona{Sub: "sub-ana-001", Claims: map[string]string{"email": "ana@x.test"}})))
```

Llama a la función **en cada petición**: el token dura cinco minutos y la caché lo renueva solo si se le pregunta.
Si el proveedor no da el token, el escenario termina ahí con el motivo. `TokenAs` existe cuando la identidad del
llamante sale de un claim: da de alta a la persona por la API de administración del realm con ese `sub` exacto y
los claims del escenario (`Persona.Without` quita uno: «el mismo token sin email»).

El humo del arnés (SMOKE-4 y SMOKE-5) ya pide el token con el que la regla de cierre deja pasar: si sale en rojo,
el realm no está sembrado o el proveedor no responde, y ningún flujo autenticado puede salir en verde.

## Lo que tiene que dar cada caso

| Situación | Status | `code` |
|---|---|---|
| Sin `Authorization`, token mal formado, caducado o de otra firma | 401 | `UNAUTHENTICATED` |
| Token inválido en una ruta abierta (`/livez`) | 401 | `UNAUTHENTICATED` |
| Token válido sin el rol, permiso o scope de la regla | 403 | `ACCESS_DENIED` |
| Token de máquina con la audiencia de otro servicio (`validateAudience`) | 403 | `ACCESS_DENIED` |
| Token válido sin el claim de la identidad del llamante | 401 | `UNAUTHENTICATED` |
| Camino que no existe, sin credencial (cierre no público) | 401 | `UNAUTHENTICATED` |

Un 401 donde esperabas 403 es que el token **no llegó a autenticarse**: diagnostica eso antes de tocar roles o
scopes (`references/troubleshooting.md`).

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/test-clients.md` | Antes de escribir un escenario M2M negativo: qué varía en cada cliente `test-m2m-*` |
| `references/troubleshooting.md` | Ante un 401/403 inesperado, un `invalid_grant` o un claim que no llega |
