# Cognito — preparación del entorno de prueba (cognito-local)

Receta reproducible con la AWS CLI contra el emulador. Guárdala en `infra/`
(p. ej. `infra/init-cognito.sh`): los escenarios deben poder recrear el
entorno desde cero. `reset-db.sh` **no** toca el emulador.

## Script completo (pool + cliente + grupos + usuarios)

Los grupos salen de `security.keel.yaml` — crea exactamente esos, con el
nombre exacto. Desde el host (`--endpoint-url http://localhost:9229`; desde
devtools, `http://cognito:9229`; región y credenciales dummy valen):

```bash
AWS="aws --endpoint-url http://localhost:9229 --region us-east-1"

POOL_ID=$($AWS cognito-idp create-user-pool --pool-name <servicio>-pool \
    --query 'UserPool.Id' --output text)

CLIENT_ID=$($AWS cognito-idp create-user-pool-client --user-pool-id "$POOL_ID" \
    --client-name <servicio>-client \
    --explicit-auth-flows ADMIN_NO_SRP_AUTH USER_PASSWORD_AUTH \
    --query 'UserPoolClient.ClientId' --output text)

# Un grupo por rol de security.keel.yaml
$AWS cognito-idp create-group --user-pool-id "$POOL_ID" --group-name <rol>

# Usuario de prueba por rol (y uno SIN grupos para los escenarios de 403)
$AWS cognito-idp admin-create-user --user-pool-id "$POOL_ID" \
    --username <user> --temporary-password 'Temp0rary!'
$AWS cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" \
    --username <user> --password '<pass>' --permanent
$AWS cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" \
    --username <user> --group-name <rol>

echo "issuer local: http://localhost:9229/$POOL_ID  client: $CLIENT_ID"
```

Tras crearlo, actualiza el `issuer-uri` de `parameters/local/oauth2.yaml` con
el `POOL_ID` real. `admin-set-user-password --permanent` evita el estado
`FORCE_CHANGE_PASSWORD` que rompería el login programático.

## Tokens

```bash
TOKEN=$($AWS cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH \
    --client-id "$CLIENT_ID" \
    --auth-parameters USERNAME=<user>,PASSWORD='<pass>' \
    --query 'AuthenticationResult.AccessToken' --output text)
```

Usa el **AccessToken** como Bearer (es el que trae `cognito:groups`); el
IdToken no es el contrato del converter (ver configuration.md). Para
escenarios M2M reales Cognito usa client credentials con un domain hosted —
fuera del alcance del emulador: valida M2M con un usuario técnico en un grupo
propio y documéntalo.

## Verificación del mapeo

1. Decodifica el token (`echo $TOKEN | cut -d. -f2 | base64 -d | jq`) y
   comprueba `token_use: access`, `iss` = issuer local y `cognito:groups` con
   los grupos esperados.
2. Usuario **sin** el grupo requerido → 403; **con** él → 2xx, según
   `access.rules` del diseño. Ambos casos.
3. Sin token → 401 (no 403): distingue autenticación de autorización.

## Reset del entorno

El emulador guarda el estado en el contenedor: `docker compose -f
infra/docker-compose.yaml rm -sf cognito && docker compose ... up -d cognito`
lo vacía. Recuerda: pool nuevo = `POOL_ID` nuevo = actualizar `issuer-uri`
local y reiniciar la app (el decoder cachea el well-known del arranque).
