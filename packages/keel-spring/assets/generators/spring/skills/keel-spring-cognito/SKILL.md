---
name: keel-spring-cognito
description: Guía de autenticación OIDC con Amazon Cognito en un proyecto generado por keel-spring — qué se emula en local (el contrato del token, no la API de AWS), qué no queda probado ahí, y cómo verificar el mapeo de grupos y scopes; el código de seguridad y la config del emulador ya los genera build. Usar cuando keel-stack.json declara auth "cognito".
---

# Amazon Cognito (auth: `cognito`)

La capa `security` sale **completa** de build (código transversal al proveedor):
`SecurityConfig` con `SecurityFilterChain` (matchers derivados del diseño), resource
server JWT y `JwtAuthConverter` que mapea los claims planos de Cognito
(`cognito:groups`, `scope`) a authorities. **No reescribas ese código.**

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"auth": "cognito"`.
- Lee `specs/security.keel.yaml`: roles/grupos y `access.rules` — el diseño es la única fuente de verdad funcional.
- Sigue estrictamente `{{keel:docs}}/conventions/mapping.md`.
- **Frontera**: build ya dejó el código de seguridad, la config por perfil y el compose; esta skill cubre solo preparación de entorno y validación.

## Qué levanta build en local, y qué NO se prueba ahí

**En local no corre Cognito ni un emulador de su API**: corre un servidor OAuth2
(`mock-oauth2-server`) que emite tokens con la **forma exacta** de los de Cognito. La razón
es que este servicio es un **resource server puro** —nunca llama a la API de administración
de Cognito—, así que lo único que consume es el token: JWKS, `iss`, `exp` y los claims.

Build deja esto, y **no hay que crear ningún user pool**:

- `infra/cognito/mock-oauth2-config.json` — derivado de `security.keel.yaml`: un usuario por
  rol (con sus `cognito:groups`), uno sin roles, y un cliente máquina por `serviceClient`.
- `infra/docker-compose.yaml` — el servicio `cognito-mock` con ese config montado.
- `parameters/<perfil>/oauth2.yaml` — el `issuer-uri`. En local es determinista
  (`http://localhost:9229/<servicio>`) porque el issuerId lo elige el diseño; fuera de local,
  el pool real por variable de entorno.
- `infra/test-credentials.env` — el `AUTH_TOKEN_URL` y los usuarios que consume el arnés.

**Lo que ahí NO queda probado**, y hay que decirlo al cerrar:

1. **Que el proveedor autentique de verdad**: el emulador no valida contraseñas. Autenticar
   no es responsabilidad de este servicio (él valida firmas y claims), pero tampoco se puede
   afirmar lo contrario.
2. **El alta de user pool, grupos y usuarios**: eso es la API de AWS, y se verifica contra
   Cognito real (`references/environment.md`).

**Lo que sí queda probado, y es todo lo que este servicio consume**: la verificación por
JWKS, el `iss`, la caducidad, el mapeo de `cognito:groups` a roles, el formato real de los
scopes y la ausencia de `aud` en los tokens de máquina.

## Las dos rarezas de Cognito, ya resueltas por build

No las arregles a mano: si algo no casa, el fallo está en otro sitio.

| Rareza de Cognito | Quién la absorbe |
|---|---|
| Los scopes vienen prefijados por el resource server (`catalog/product:read`), no como el `recurso:accion` del diseño | `JwtAuthConverter` corta el prefijo antes de componer `SCOPE_*` |
| Los access token de `client_credentials` **no traen `aud`**, traen `client_id` | `AudienceAuthorizationFilter` comprueba que algún scope venga prefijado por el resource server de este servicio — que es como Cognito expresa «este token es para esta API» |

## Qué hace el agente

1. **Levantar y sondear** (`infra/up.sh`, `infra/validate-infra.sh`): el emulador arranca con
   su config; no hay aprovisionamiento que ejecutar.
2. **Verificar el mapeo con un token de verdad**: pide uno, decodifícalo
   (`echo $TOKEN | cut -d. -f2 | base64 -d | jq`) y comprueba `cognito:groups`, el `iss` y —en
   el de máquina— el `scope` con prefijo y la ausencia de `aud`.
3. **Comprobar las reglas del diseño**: sin token → 401; con token sin el grupo requerido →
   403; con él → 2xx.
4. **Documentar** en el cierre las dos cosas que el emulador no prueba (arriba).

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/configuration.md` | Antes de tocar `parameters/<perfil>/oauth2.yaml` (issuer por perfil, access vs ID token, claims que mapea build) |
| `references/environment.md` | Al crear el user pool/cliente/grupos por script y obtener tokens contra el emulador |
| `references/troubleshooting.md` | Ante 401/403 inesperados, `NotAuthorizedException`, pools perdidos o diferencias emulador/real |

## Validación

Sondeo desde devtools: `curl -sf http://cognito:9229/health`.
Recetas completas en `{{keel:docs}}/conventions/infra-validation.md`.
