# Cognito — entorno de prueba

## En LOCAL no hay nada que aprovisionar

Build genera `infra/cognito/mock-oauth2-config.json` desde `security.keel.yaml` y el compose
lo monta: los usuarios (uno por rol y uno sin roles) y los clientes máquina ya existen al
arrancar el contenedor. No ejecutes la AWS CLI contra el emulador — **no es un emulador de la
API de Cognito**, es un servidor OAuth2 que emite tokens con su forma.

Para pedir un token, OAuth2 estándar (es lo mismo que hace `AbstractFlowIT`):

```bash
# Usuario (el username ES el rol; ver infra/test-credentials.env)
TOKEN=$(curl -s -X POST http://localhost:9229/<servicio>/token \
    -d 'grant_type=password' -d 'client_id=<servicio>-spring-test' \
    -d 'username=<rol>' -d 'password=password' | jq -r .access_token)

# Cliente máquina
M2M=$(curl -s -X POST http://localhost:9229/<servicio>/token \
    -d 'grant_type=client_credentials' -d 'client_id=<cliente>' \
    -d 'client_secret=<cliente>-secret' | jq -r .access_token)
```

Decodifica y comprueba la forma, que es lo que hace que local prediga producción:

```bash
echo "$TOKEN" | cut -d. -f2 | base64 -d | jq
```

- Token de usuario: `cognito:groups` con sus roles, `iss` = `http://localhost:9229/<servicio>`.
- Token de máquina: `scope` **prefijado** (`<servicio>/<scope>`), `client_id`, y **sin `aud`**.

Si el pool hiciera falta de verdad (probar el alta de usuarios, MFA, políticas de
contraseña), eso ya no es local: es Cognito real, abajo.

## En Cognito REAL (develop/production)

Aquí sí hay que crear el pool, y esta es la receta. Los grupos salen de
`security.keel.yaml` — crea exactamente esos, con el nombre exacto:

```bash
AWS="aws --region <región>"

POOL_ID=$($AWS cognito-idp create-user-pool --pool-name <servicio>-pool \
    --query 'UserPool.Id' --output text)

CLIENT_ID=$($AWS cognito-idp create-user-pool-client --user-pool-id "$POOL_ID" \
    --client-name <servicio>-client \
    --explicit-auth-flows ADMIN_NO_SRP_AUTH USER_PASSWORD_AUTH \
    --query 'UserPoolClient.ClientId' --output text)

# Un grupo por rol de security.keel.yaml
$AWS cognito-idp create-group --user-pool-id "$POOL_ID" --group-name <rol>

# Usuario por rol (y uno SIN grupos para los escenarios de 403)
$AWS cognito-idp admin-create-user --user-pool-id "$POOL_ID" \
    --username <user> --temporary-password 'Temp0rary!'
$AWS cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" \
    --username <user> --password '<pass>' --permanent
$AWS cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" \
    --username <user> --group-name <rol>
```

`admin-set-user-password --permanent` evita el estado `FORCE_CHANGE_PASSWORD`, que rompería
el login programático. El `issuer-uri` de ese entorno es
`https://cognito-idp.<región>.amazonaws.com/$POOL_ID`, y va por la variable de entorno que
`parameters/<perfil>/oauth2.yaml` ya declara — no se toca el YAML.

### M2M contra Cognito real

Un **resource server** cuyo identifier sea el nombre del servicio (es lo que produce el
prefijo `<servicio>/<scope>` que el código generado espera) con un custom scope por cada
scope del diseño, y un app client con `generate-secret` y
`--allowed-o-auth-flows client_credentials` por cada `serviceClient`:

```bash
$AWS cognito-idp create-resource-server --user-pool-id "$POOL_ID" \
    --identifier <servicio> --name <servicio> \
    --scopes ScopeName=<scope>,ScopeDescription='...'
```

El token se pide contra el **hosted domain** del pool
(`https://<dominio>/oauth2/token`), no contra la API de administración. Las dos divergencias
que esto introduce —scope prefijado y ausencia de `aud`— **ya las absorbe el código
generado**: ver `SKILL.md § Las dos rarezas de Cognito`.
