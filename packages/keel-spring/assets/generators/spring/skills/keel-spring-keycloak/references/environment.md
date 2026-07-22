# Keycloak — preparación del entorno de prueba

Receta reproducible con `kcadm.sh` (dentro del contenedor). La admin console
(`http://localhost:8180`, admin/admin) sirve para inspeccionar, pero el
entorno se crea **por script** para que la validación sea repetible.

## Script completo (realm + cliente + roles + usuarios)

Los roles salen de `security.keel.yaml` — crea exactamente esos, como roles de
**realm**. Ejecuta dentro del contenedor:

```bash
KC="docker compose -f infra/docker-compose.yaml exec keycloak /opt/keycloak/bin/kcadm.sh"

# Sesión admin (dentro del contenedor el puerto es 8080)
$KC config credentials --server http://localhost:8080 --realm master \
    --user admin --password admin

# Realm (el nombre debe casar con el issuer-uri del perfil local)
$KC create realms -s realm=<realm> -s enabled=true

# Cliente confidencial con direct access grants (para obtener tokens por password)
$KC create clients -r <realm> -s clientId=<cliente> -s enabled=true \
    -s publicClient=true -s directAccessGrantsEnabled=true

# Roles de realm: uno por rol de security.keel.yaml
$KC create roles -r <realm> -s name=<rol>

# Usuario de prueba por rol (y uno SIN roles para los escenarios de 403)
$KC create users -r <realm> -s username=<user> -s enabled=true
$KC set-password -r <realm> --username <user> --new-password <pass>
$KC add-roles -r <realm> --uusername <user> --rolename <rol>
```

Guárdalo en `infra/` (p. ej. `infra/init-keycloak.sh`): los escenarios deben
poder recrear el entorno desde cero. `reset-db.sh` **no** toca Keycloak; si
necesitas resetearlo, `docker compose rm -sf keycloak && docker compose up -d
keycloak` + re-ejecutar el script.

## Export/import como alternativa

Para no depender del script en cada arranque, exporta el realm ya configurado
y móntalo en el compose:

```bash
docker compose -f infra/docker-compose.yaml exec keycloak \
    /opt/keycloak/bin/kc.sh export --realm <realm> --file /tmp/realm.json
docker compose -f infra/docker-compose.yaml cp keycloak:/tmp/realm.json infra/realm.json
```

y en el servicio keycloak del compose: `command: start-dev --import-realm` +
volumen `./realm.json:/opt/keycloak/data/import/realm.json`. Documenta el
cambio del compose si lo haces.

## Tokens

**Usuario (password grant, escenarios de API):**

```bash
curl -s -d 'grant_type=password&client_id=<cliente>&username=<user>&password=<pass>' \
    http://localhost:8180/realms/<realm>/protocol/openid-connect/token | jq -r .access_token
```

Pide el token al **mismo host** que valida la app (`localhost:8180`): un token
de `keycloak:8080` tiene otro `iss` y da 401.

**Servicio (client credentials, escenarios M2M):** crea un segundo cliente
confidencial (`-s publicClient=false -s serviceAccountsEnabled=true`), asigna
roles a su service account (`add-roles --uusername service-account-<cliente>`) y:

```bash
curl -s -d 'grant_type=client_credentials&client_id=<cliente-m2m>&client_secret=<secret>' \
    http://localhost:8180/realms/<realm>/protocol/openid-connect/token | jq -r .access_token
```

## Verificación del mapeo

1. Decodifica el token (`cut -d. -f2 | base64 -d`) y comprueba que
   `realm_access.roles` contiene los roles esperados.
2. Usuario **sin** el rol → 403 en el endpoint protegido; **con** el rol → 2xx,
   según `access.rules` del diseño. Ambos casos, no solo el feliz.
3. Sin token → 401 (no 403): distingue autenticación de autorización en los
   escenarios.
