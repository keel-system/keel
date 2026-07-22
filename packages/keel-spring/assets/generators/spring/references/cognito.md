# Amazon Cognito (auth: `cognito`)

La capa `security` sale **completa** de build (código transversal al proveedor):
`SecurityConfig` con `SecurityFilterChain` (matchers derivados del diseño), resource
server JWT y `JwtAuthConverter` que mapea los claims planos de Cognito
(`cognito:groups`, `scope`) a authorities. **No reescribas ese código.**

## Qué dejó listo build

- `parameters/<perfil>/oauth2.yaml`: `issuer-uri` por perfil (local apunta a cognito-local;
  en develop/production, el user pool real: `https://cognito-idp.<región>.amazonaws.com/<poolId>`).
- `docker-compose.yaml`: `cognito-local` (emulador, host `localhost:9229`).

## Qué hace el agente

Solo preparación de entorno y validación funcional (nada de código, salvo que el
diseño exija lógica que el mapeo de claims no cubre, y entonces documéntalo):

1. **User pool de prueba**: con la AWS CLI apuntando al emulador —
   `aws --endpoint-url http://localhost:9229 cognito-idp create-user-pool ...`,
   `create-user-pool-client`, `admin-create-user` — creando los grupos/roles que
   declara `security.keel.yaml`. Ajusta el `issuer-uri` local al pool creado.
2. **Token para los escenarios**: `aws --endpoint-url http://localhost:9229
   cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH ...` y usa el
   `IdToken`/`AccessToken` como Bearer en las llamadas de `validation-scenarios.md`.
3. **Verifica el mapeo**: un usuario sin el grupo requerido debe recibir 403 y uno
   con él 2xx, según `access.rules` del diseño.

## Validación

Sondeo desde devtools: `curl -sf http://cognito:9229/health`.
Recetas completas en `conventions/infra-validation.md`.
