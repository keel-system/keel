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

**Servicio (client credentials, escenarios M2M):** si el diseño declara
`serviceClients` (security.keel.yaml), crea **un cliente confidencial por cada
entrada**, con el `clientId` exacto del diseño:

```bash
# Cliente confidencial con service accounts (flujo client_credentials)
$KC create clients -r <realm> -s clientId=<service-client> -s enabled=true \
    -s publicClient=false -s serviceAccountsEnabled=true -s secret=<secret>

# Un client scope por cada scope del diseño (mismo nombre recurso:accion),
# asignado como default al cliente para que entre en el claim scope del token
$KC create client-scopes -r <realm> -s name=<scope> -s protocol=openid-connect \
    -s 'attributes."include.in.token.scope"=true'
# (asigna el scope al cliente: admin console → Clients → <service-client> → Client scopes,
#  o via API: PUT /admin/realms/<realm>/clients/<id>/default-client-scopes/<scopeId>)
```

Con `serviceAuth.validateAudience: true`, añade al cliente un **mapper de
audiencia** que meta la audiencia del servicio (`security.audience`, por defecto
el nombre del servicio) en el claim `aud`: admin console → Clients →
`<service-client>` → Client scopes → dedicated scope → Add mapper → Audience,
con «Included Custom Audience» = la audiencia. Sin ese mapper el token no trae
el `aud` esperado y el servicio responde 401.

Token:

```bash
curl -s -d 'grant_type=client_credentials&client_id=<service-client>&client_secret=<secret>' \
    http://localhost:8180/realms/<realm>/protocol/openid-connect/token | jq -r .access_token
```

Nunca uses tokens de usuario (password grant) para escenarios M2M: el diseño los
distingue (`level: service` + scopes) y la validación debe ejercitar el flujo real.

## Verificación del mapeo

1. Decodifica el token (`cut -d. -f2 | base64 -d`) y comprueba que
   `realm_access.roles` contiene los roles esperados.
2. Usuario **sin** el rol → 403 en el endpoint protegido; **con** el rol → 2xx,
   según `access.rules` del diseño. Ambos casos, no solo el feliz.
3. Sin token → 401 (no 403): distingue autenticación de autorización en los
   escenarios.
4. M2M: en el token `client_credentials` comprueba el claim `scope` (los scopes
   del diseño, separados por espacio) y —si `validateAudience: true`— que `aud`
   incluye la audiencia del servicio. Cliente sin el scope exigido → 403; token
   con `aud` de otro servicio → 401.
