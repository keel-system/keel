---
name: keel-spring-keycloak
description: Guía de autenticación OIDC con Keycloak en un proyecto generado por keel-spring — realm de prueba, obtención de tokens y verificación del mapeo de roles; el código de seguridad ya lo genera build. Usar cuando keel-stack.json declara auth "keycloak".
---

# Keycloak (auth: `keycloak`)

La capa `security` sale **completa** de build (código transversal al proveedor):
`SecurityConfig` con `SecurityFilterChain` (matchers derivados del diseño), resource
server JWT y `JwtAuthConverter` que mapea los claims anidados de Keycloak
(`realm_access.roles` / `resource_access`) a authorities. **No reescribas ese código.**

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"auth": "keycloak"`.
- Lee `specs/security.keel.yaml`: roles y `access.rules` — el diseño es la única fuente de verdad funcional.
- Sigue estrictamente `.claude/conventions/mapping.md`.
- **Frontera**: build ya dejó el código de seguridad, la config por perfil y el compose; esta skill cubre solo preparación de entorno y validación.

## Qué dejó listo build

- `parameters/<perfil>/oauth2.yaml`: `issuer-uri` por perfil (local apunta al contenedor).
- `infra/docker-compose.yaml`: `keycloak` en `start-dev` (host `localhost:8180`, admin/admin).

## Qué hace el agente

Solo preparación de entorno y validación funcional (nada de código, salvo que el
diseño exija lógica que el mapeo de claims no cubre — p. ej. autorización por
*ownership* — y entonces documéntalo):

1. **Realm de prueba**: crea realm, cliente y usuarios con los roles que declara
   `security.keel.yaml` (admin console en `http://localhost:8180`, admin/admin, o
   `kcadm.sh` dentro del contenedor). El `issuer-uri` del perfil local debe quedar
   `http://localhost:8180/realms/<realm>`.
2. **Token para los escenarios**:
   `curl -d 'grant_type=password&client_id=<cliente>&username=<user>&password=<pass>' http://localhost:8180/realms/<realm>/protocol/openid-connect/token`
   y usa el `access_token` como Bearer en las llamadas de `validation-scenarios.md`.
3. **Verifica el mapeo**: un usuario sin el rol requerido debe recibir 403 y uno con
   él 2xx, según `access.rules` del diseño.

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/configuration.md` | Antes de tocar `parameters/<perfil>/oauth2.yaml` (issuer-uri vs jwk-set-uri, audiencia, claims que mapea build) |
| `references/environment.md` | Al crear el realm/cliente/usuarios por script, exportar el realm y obtener tokens (usuario y M2M) |
| `references/troubleshooting.md` | Ante 401/403 inesperados, arranque fallido por issuer o roles que no llegan al token |

## Validación

Sondeo desde devtools: `curl -sf http://keycloak:8080/realms/master`.
Recetas completas (incluida la obtención de tokens) en
`.claude/conventions/infra-validation.md`.
