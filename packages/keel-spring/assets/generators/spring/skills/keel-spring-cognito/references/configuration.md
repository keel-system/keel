# Cognito — configuración

Qué hay detrás de `parameters/<perfil>/oauth2.yaml` y qué puede ajustar el
agente. El código de seguridad (SecurityConfig, `JwtAuthConverter` para claims
planos de Cognito) **lo genera build y no se toca**; aquí solo configuración.

## `issuer-uri` por perfil

- **local** (emulador cognito-local): `http://localhost:9229/<poolId>` — el
  `<poolId>` sale del `create-user-pool` (ver `references/environment.md`);
  actualiza el YAML tras crearlo.
- **develop/production** (Cognito real):
  `https://cognito-idp.<región>.amazonaws.com/<poolId>` por env var (gradiente
  ya generado). El resource server descubre el JWKS en
  `<issuer>/.well-known/jwks.json`.
- La validación compara el claim `iss` **carácter a carácter**: el token del
  emulador solo vale contra el issuer del emulador, y el de un pool real solo
  contra su pool exacto.
- Con `issuer-uri`, la app consulta el well-known **al arrancar**: emulador
  caído o pool inexistente = app que no arranca. Levanta y crea el pool antes
  de `bootRun`.

## Access token vs ID token (la trampa clásica de Cognito)

- El **access token** trae `cognito:groups`, `scope`, `token_use: access` — y
  **no trae `aud`** (trae `client_id`). Es el que se usa como Bearer.
- El **ID token** trae los datos del usuario (`email`, etc.) y `aud`, pero
  `token_use: id`: no es un token de autorización.
- Consecuencia: no configures `audiences` en el resource server esperando
  validar el access token (fallaría por `aud` ausente). Si el diseño declara
  `serviceAuth.validateAudience: true`, el `AudienceValidator` que generó build
  choca con esta divergencia de Cognito: ajusta la validación al claim
  `client_id` (o al scope) y documenta la decisión en el proyecto (frontera
  agente admitida por mapping.md).

## Claims y mapeo (lo hace build, entiéndelo para depurar)

El `JwtAuthConverter` generado mapea los claims **planos** de Cognito:
`cognito:groups` (grupos del user pool → roles del diseño) y `scope`. Los
roles de `security.keel.yaml` deben existir como **grupos** del pool con el
nombre exacto (mayúsculas incluidas).

## Diferencias emulador vs Cognito real

- cognito-local emite tokens firmados con su propia clave y expone su JWKS:
  suficiente para validar el flujo completo en local, pero no valida
  passwords policies/MFA/etc. como el real.
- El emulador persiste su estado en el contenedor (sobrevive a `stop/start`,
  no a `rm`): recrear contenedor = recrear pool = **nuevo poolId** → actualizar
  el `issuer-uri` local.
- En el real, el pool/clientes/grupos los crea la plataforma (IaC); el script
  de environment.md es solo para el emulador.

## Qué no hacer

- No reescribas `SecurityConfig`/`JwtAuthConverter` para «arreglar» un 401/403:
  el arreglo está en el pool (grupos, usuario) o en el issuer/token usado.
- No uses el ID token como Bearer «porque trae más claims»: los grupos del
  access token son el contrato del converter.
- No apuntes develop al emulador salvo decisión explícita: su issuer
  `http://localhost:9229` no existe fuera de tu máquina.
