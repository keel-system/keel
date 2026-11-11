---
name: keel-dotnet-cognito
description: Guía de autenticación OIDC con Amazon Cognito en un proyecto generado por keel-dotnet — qué se emula en local (el contrato del token, no la API de AWS), qué no queda probado ahí y cómo verificar grupos, scopes y audiencia; el código de seguridad y la configuración del emulador ya los genera build. Usar cuando keel-stack.json declara auth "cognito".
---

# Amazon Cognito (auth: `cognito`)

La capa `security` sale **entera** de build, con la misma autorización que los servidores de keel-spring y
keel-nest del diseño: el middleware de la entrada HTTP (`src/<Raíz>.Api/Rest/HttpSecurityMiddleware.cs`), las
reglas como datos (`src/<Raíz>.Infrastructure/Security/AccessRules.cs`) y la validación del JWT
(`src/<Raíz>.Infrastructure/Security/JwtAuthenticator.cs`), que lee los claims planos de Cognito:
`cognito:groups` → `ROLE_<grupo>`, `scope` → `SCOPE_<scope>`. **No reescribas ese código.**

## Qué corre en local, y qué NO se prueba ahí

En local no corre Cognito: corre `mock-oauth2-server`, que emite tokens con la **forma exacta** de los de
Cognito. Este servicio es un resource server puro —nunca llama a la API de AWS—, así que lo único que
consume es el token. Build deja:

- `infra/cognito/mock-oauth2-config.json` — un usuario por rol (con sus `cognito:groups`), uno sin roles
  y un cliente máquina por `serviceClient`, derivados de `security.keel.yaml`. No hay nada que sembrar.
- `config/parameters/<perfil>/security.yaml` — el `issuer-uri`: en local `http://localhost:9229/<servicio>`
  (determinista); fuera de local, el pool real por `OAUTH2_ISSUER_URI`.
- `infra/test-credentials.env` — `AUTH_TOKEN_URL` y los clientes que usa el arnés (`TokenFor`,
  `ServiceCredential` de `tests/<Raíz>.IntegrationTests/Support/FlowTest.cs`).

**Lo que ahí no queda probado**, y hay que decirlo al cerrar: que el proveedor autentique de verdad (el
emulador no valida contraseñas) y el alta de user pool, grupos y usuarios (API de AWS).

**Lo que el pool tiene que traer** —grupos, resource server, app clients, el disparador de pre-generación de
tokens si el diseño lee un claim que Cognito no pone (el del alcance, `email`…), el plan que lo admite y las
variables— está en `{{keel:docs}}/identity-contract.md`, que build genera desde el diseño: no lo repitas, cítalo
en el cierre. El emulador pone esos claims como si el disparador existiera (el del alcance, con el valor de
`ScopedResource()`). Otro valor del claim lo da
`await TokenWithScope("<rol>", "<valor>")`: el emulador no guarda usuarios y responde con la forma que pide la petición, un
mapping por cantidad de valores y hasta 4; con más, el arnés lo rechaza con su motivo, y ese escenario es un `blocker`.

## Las rarezas de Cognito, ya resueltas por build

| Rareza | Quién la absorbe |
|---|---|
| Los scopes vienen prefijados por el resource server (`<servicio>/product:read`) | `JwtAuthenticator.cs` corta el prefijo antes de componer `SCOPE_*` |
| Los tokens de `client_credentials` **no traen `aud`** | `JwtAuthenticator.IssuedFor` exige que algún scope venga prefijado por el resource server de este servicio, que es como Cognito dice «este token es para esta API» |
| Un ID token del mismo pool tiene el mismo emisor, la misma firma y los mismos grupos | `JwtAuthenticator.cs` rechaza con 401 lo que no traiga `token_use: access` |
| `client_id` es un id que genera Cognito, no el nombre del cliente en el diseño | `ServiceClientIds.cs` lo traduce con `client-ids` de `security.yaml` (`SECURITY_CLIENT_ID_<CLIENTE>`, obligatorio en production), para los exentos del alcance y la identidad 1:1 |

Si algo no casa, el fallo está en otro sitio: no las arregles a mano.

## Qué hace el agente

1. **Infraestructura**: `bash infra/up.sh` y `bash infra/validate-infra.sh`. No hay script de
   aprovisionamiento: el emulador arranca con su configuración.
2. **Pruebas**: las credenciales salen del arnés (`Bearer(await TokenFor("<rol>"))`,
   `Bearer(await ServiceCredential("<cliente>"))`). Si el diseño identifica al llamante por un claim,
   `await TokenAs("<sub>")` pide la persona al emulador con su `sub`; solo admite los claims que el diseño lee del
   token, y otro lo rechaza con su motivo (ese escenario es un `blocker`).
3. **Verificación**: sin token → 401 `UNAUTHENTICATED`; token sin el grupo → 403 `ACCESS_DENIED`; con él
   → 2xx. En un token de máquina, el `scope` con prefijo y sin `aud`.
