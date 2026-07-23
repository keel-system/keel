---
name: keel-spring-cognito
description: Guía de autenticación OIDC con Amazon Cognito (cognito-local en dev) en un proyecto generado por keel-spring — user pool de prueba, obtención de tokens y verificación del mapeo de grupos; el código de seguridad ya lo genera build. Usar cuando keel-stack.json declara auth "cognito".
---

# Amazon Cognito (auth: `cognito`)

La capa `security` sale **completa** de build (código transversal al proveedor):
`SecurityConfig` con `SecurityFilterChain` (matchers derivados del diseño), resource
server JWT y `JwtAuthConverter` que mapea los claims planos de Cognito
(`cognito:groups`, `scope`) a authorities. **No reescribas ese código.**

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"auth": "cognito"`.
- Lee `specs/security.keel.yaml`: roles/grupos y `access.rules` — el diseño es la única fuente de verdad funcional.
- Sigue estrictamente `.claude/conventions/mapping.md`.
- **Frontera**: build ya dejó el código de seguridad, la config por perfil y el compose; esta skill cubre solo preparación de entorno y validación.

## Qué dejó listo build

- `parameters/<perfil>/oauth2.yaml`: `issuer-uri` por perfil (local apunta a cognito-local;
  en develop/production, el user pool real: `https://cognito-idp.<región>.amazonaws.com/<poolId>`).
- `infra/docker-compose.yaml`: `cognito-local` (emulador, host `localhost:9229`).

## Qué hace el agente

Solo preparación de entorno y validación funcional (nada de código, salvo que el
diseño exija lógica que el mapeo de claims no cubre, y entonces documéntalo):

1. **User pool de prueba**: con la AWS CLI apuntando al emulador —
   `aws --endpoint-url http://localhost:9229 cognito-idp create-user-pool ...`,
   `create-user-pool-client`, `admin-create-user` — creando los grupos/roles que
   declara `security.keel.yaml`. Ajusta el `issuer-uri` local al pool creado.
2. **Clientes máquina (si el diseño declara `serviceClients` con `serviceAuth:
   client-credentials`)**: en Cognito real, un resource server con los custom
   scopes del diseño + un app client `client_credentials` por `serviceClient`.
   El emulador no cubre ese flujo — sigue la estrategia de validación descrita
   en `references/environment.md` (usuario técnico) y documenta las divergencias
   de Cognito (formato de scopes, ausencia de `aud`).
3. **Token para los escenarios**: `aws --endpoint-url http://localhost:9229
   cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH ...` y usa el
   `IdToken`/`AccessToken` como Bearer en las llamadas de `validation-scenarios.md`.
4. **Verifica el mapeo**: un usuario sin el grupo requerido debe recibir 403 y uno
   con él 2xx, según `access.rules` del diseño; para las reglas `level: service`,
   el equivalente con scopes según la estrategia M2M elegida.

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/configuration.md` | Antes de tocar `parameters/<perfil>/oauth2.yaml` (issuer por perfil, access vs ID token, claims que mapea build) |
| `references/environment.md` | Al crear el user pool/cliente/grupos por script y obtener tokens contra el emulador |
| `references/troubleshooting.md` | Ante 401/403 inesperados, `NotAuthorizedException`, pools perdidos o diferencias emulador/real |

## Validación

Sondeo desde devtools: `curl -sf http://cognito:9229/health`.
Recetas completas en `.claude/conventions/infra-validation.md`.
