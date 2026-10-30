---
name: keel-go-cognito
description: Guía de autenticación OIDC con Amazon Cognito en un proyecto generado por keel-go — qué se emula en local (el contrato del token, no la API de AWS), qué no queda probado ahí y cómo verificar grupos, scopes y audiencia; el código de seguridad y la configuración del emulador ya los genera build. Usar cuando keel-stack.json declara auth "cognito".
---

# Amazon Cognito (auth: `cognito`)

La capa `security` sale **entera** de build, con la misma autorización que los servidores de keel-spring,
keel-nest y keel-dotnet del diseño: la decisión de la entrada HTTP (`internal/httpapi/security.go`) y la
validación del JWT (`internal/platform/security/jwt.go`), que lee los claims planos de Cognito:
`cognito:groups` → `ROLE_<grupo>`, `scope` → `SCOPE_<scope>`. **No reescribas ese código.**

## Qué corre en local, y qué NO se prueba ahí

En local no corre Cognito: corre `mock-oauth2-server`, que emite tokens con la **forma exacta** de los de
Cognito. Este servicio es un resource server puro —nunca llama a la API de AWS—, así que lo único que consume es
el token. Build deja:

- `infra/cognito/mock-oauth2-config.json` — un usuario por rol (con sus `cognito:groups`), uno sin roles y un
  cliente máquina por `serviceClient`, derivados de `security.keel.yaml`. No hay nada que sembrar.
- `config/parameters/<perfil>/security.yaml` — el `issuer-uri`: en local `http://localhost:9229/<servicio>`
  (determinista); fuera de local, el pool real por `OAUTH2_ISSUER_URI`.
- `infra/test-credentials.env` — `AUTH_TOKEN_URL` y los clientes que usa el arnés
  (`tests/integration/credentials_test.go`: `s.TokenFor`, `s.SecondTokenFor`, `s.ServiceCredential`).

**Lo que ahí no queda probado**, y hay que decirlo al cerrar: que el proveedor autentique de verdad (el emulador
no valida contraseñas) y el alta de user pool, grupos y usuarios (API de AWS).

## Las dos rarezas de Cognito, ya resueltas por build

| Rareza | Quién la absorbe |
|---|---|
| Los scopes vienen prefijados por el resource server (`<servicio>/product:read`) | `jwt.go` corta el prefijo antes de componer `SCOPE_*` |
| Los tokens de `client_credentials` **no traen `aud`** | `security.IssuedFor` exige que algún scope venga prefijado por el resource server de este servicio, que es como Cognito dice «este token es para esta API» |

Si algo no casa, el fallo está en otro sitio: no las arregles a mano.

## Qué hace el agente

1. **Infraestructura**: `bash infra/up.sh` y `bash infra/validate-infra.sh`. No hay script de aprovisionamiento:
   el emulador arranca con su configuración.
2. **Pruebas**: las credenciales salen del arnés (`Bearer(s.TokenFor("<rol>"))`,
   `Bearer(s.ServiceCredential("<cliente>"))`). `TokenAs` no existe con Cognito: el emulador fija los claims en su
   configuración, no por petición; un escenario que necesite una persona con un `sub` elegido es un `blocker`.
3. **Verificación**: sin token → 401 `UNAUTHENTICATED`; token sin el grupo → 403 `ACCESS_DENIED`; con él → 2xx.
   En un token de máquina, el `scope` con prefijo y sin `aud`.
