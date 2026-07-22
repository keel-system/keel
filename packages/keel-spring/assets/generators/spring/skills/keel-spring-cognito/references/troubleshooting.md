# Cognito — troubleshooting

Síntoma → causa → arreglo. Sondeo básico en
`.claude/conventions/infra-validation.md`.

## 401 con un token que «debería» valer

1. **Issuer mismatch**: el `iss` del token no coincide con el `issuer-uri`
   configurado. Con el emulador pasa al recrear el pool (poolId nuevo) sin
   actualizar el YAML, o al pedir el token vía `cognito:9229` (devtools) y
   validar contra `localhost:9229`. Decodifica y compara:
   `echo $TOKEN | cut -d. -f2 | base64 -d | jq .iss`.
2. **Usaste el IdToken**: el converter espera el AccessToken
   (`token_use: access`). Revisa qué campo extrajiste de
   `AuthenticationResult`.
3. **La app arrancó antes de crear el pool**: el decoder cacheó un well-known
   fallido o antiguo — reinicia la app tras crear/recrear el pool.

## 403 con un usuario que está en el grupo

- El claim `cognito:groups` no trae el grupo: `admin-add-user-to-group`
  olvidado, o el token se emitió **antes** de añadir al grupo (los claims se
  fijan al emitir: pide un token nuevo).
- Nombre del grupo ≠ rol del diseño (mayúsculas incluidas): el converter
  mapea tal cual; usa exactamente los nombres de `security.keel.yaml`.

## `NotAuthorizedException` al pedir el token

- Password incorrecta o usuario en `FORCE_CHANGE_PASSWORD` (falta
  `admin-set-user-password --permanent`).
- El cliente no permite `USER_PASSWORD_AUTH` (falta en
  `--explicit-auth-flows`). Recrea el cliente con el flow.

## `ResourceNotFoundException` (pool o cliente no existe)

El emulador perdió el estado (contenedor recreado) o el `POOL_ID`/`CLIENT_ID`
son de una ejecución anterior. Re-ejecuta `infra/init-cognito.sh` y actualiza
issuer + ids donde los uses.

## La app no arranca: no resuelve el issuer

Con `issuer-uri`, Spring consulta `<issuer>/.well-known/openid-configuration`
al arrancar: emulador caído o poolId inexistente la tumban. Orden correcto:
compose up → init-cognito → ajustar YAML → bootRun. Sondeo:
`curl -sf http://cognito:9229/health` desde devtools.

## Funciona con el emulador pero no contra Cognito real

- El `issuer-uri` real es `https://cognito-idp.<región>.amazonaws.com/<poolId>`
  — región y poolId del pool real, no los del emulador.
- Grupos no creados en el pool real (los crea la plataforma/IaC, no tu script).
- Validación extra que el emulador no aplica (password policy, MFA, secret del
  cliente — si el cliente real tiene secret, `initiate-auth` necesita
  `SECRET_HASH`).

## Los escenarios fallan de forma intermitente tras «resets»

Cada recreación del contenedor cambia el poolId: los escenarios que cachearon
el issuer o el token viejo fallan. Regla: init-cognito → YAML → reiniciar app →
tokens nuevos, en ese orden, en cada reset del emulador.
