# Keycloak — troubleshooting

Síntoma → causa → arreglo. Sondeo básico en
`.claude/conventions/infra-validation.md`.

## 401 con un token que «debería» valer

1. **Issuer mismatch** (la causa nº1): el claim `iss` del token no coincide
   carácter a carácter con el `issuer-uri` configurado. Pasa al pedir el token
   a `keycloak:8080` (devtools) y validar contra `localhost:8180`, o al usar
   otro realm. Decodifica el token (`cut -d. -f2 | base64 -d | jq .iss`) y
   compáralo. Arreglo: pide el token al mismo host/realm que valida la app.
2. **Token expirado**: los access tokens del realm default duran 5 min; los
   escenarios largos deben renovar o subir el lifespan (ver configuration.md).
3. **Realm equivocado en el issuer-uri**: el YAML local trae un placeholder;
   ajústalo al realm que creaste.

## 403 con un usuario que tiene el rol

- El rol es de **cliente** y el converter esperaba realm (o al revés):
  decodifica el token y mira si el rol está en `realm_access.roles` o en
  `resource_access.<cliente>.roles`. Crea el rol donde el diseño lo espera
  (realm salvo diseño explícito por cliente).
- El rol existe pero no está **asignado** al usuario (`add-roles` olvidado).
- Mayúsculas/prefijos: el `JwtAuthConverter` de build mapea el nombre tal
  cual; `ADMIN` ≠ `admin`. Usa exactamente los nombres de `security.keel.yaml`.

## La app no arranca: `Unable to resolve the Configuration with the provided Issuer`

Con `issuer-uri`, Spring consulta el well-known **al construir el decoder**:
Keycloak caído o realm inexistente impiden el arranque. Levanta la infra y
crea el realm antes de `bootRun` (o usa `jwk-set-uri` en local, asumiendo que
pierdes la validación de `iss`).

## El token no trae los roles (`realm_access` vacío)

- Usuario sin roles asignados en ese realm (¿lo creaste en `master` por error?
  `kcadm.sh` sin `-r <realm>` opera sobre master).
- Cliente con scopes restringidos: en el cliente de prueba deja los default
  client scopes (incluyen `roles`); si los quitaste, el mapper de roles no se
  aplica.

## `invalid_grant` al pedir el token

- Password incorrecto o usuario deshabilitado (`enabled=false`, o acciones
  requeridas pendientes como «update password» — créalo con `set-password`
  sin temporal).
- El cliente no tiene `directAccessGrantsEnabled=true` (password grant
  apagado).

## Todo funciona a mano pero los escenarios fallan de forma intermitente

- Keycloak `start-dev` tarda unos segundos más que el «up» del compose: sondea
  `curl -sf http://keycloak:8080/realms/<realm>` (el realm concreto, no solo
  master) antes de lanzar escenarios.
- El realm se perdió: `start-dev` sin volumen persiste en el contenedor —
  sobrevive a `stop/start` pero no a `rm`/recreate. Re-ejecuta el script de
  `references/environment.md` o monta el realm exportado con `--import-realm`.
