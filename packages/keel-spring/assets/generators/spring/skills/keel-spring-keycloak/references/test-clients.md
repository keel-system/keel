# Clientes M2M de prueba — matriz scope × audiencia

Cuando el diseño declara `serviceAuth` con `validateAudience: true` **y** scopes
por operación, los escenarios `FL-*` distinguen dos fallos que devuelven códigos
distintos por causas distintas:

- **sin el scope exigido** → `403` (autenticado, pero sin la authority `SCOPE_*`)
- **audiencia inválida** → `403` (el token es válido y está autenticado; lo que
  falla es la autorización: el `AudienceAuthorizationFilter` no encuentra la
  audiencia del servicio en el claim `aud`)

**La regla completa, que este documento no contradice en ninguna línea:**

| Situación | Status |
|---|---|
| Sin cabecera `Authorization`, o token inválido/caducado | `401` |
| Token válido sin el scope exigido | `403` |
| Token válido con la audiencia de otro servicio | `403` |

El `401` está reservado a la **autenticación**. Si aparece en cualquiera de los dos
casos de abajo, el token no llegó a autenticarse y la causa es otra —issuer
distinto, firma, expiración—: diagnostícala antes de tocar nada de scopes o
audiencia (`references/troubleshooting.md`).

Para poder afirmar cuál de las dos condiciones produjo el `403`, los clientes de
prueba tienen que variar **una sola** de ellas cada vez. El error típico es
acoplarlas sin querer: el cliente pensado para "sin scope" se queda también sin el
mapper de audiencia (porque el mapper vivía en el mismo client scope), así que su
`403` no prueba nada sobre el scope —lo habrían producido las dos condiciones—; y
el cliente de "audiencia inválida" trae el scope correcto por default. Con las
variables acopladas, cada ajuste obliga a otra ronda contra el servidor real.

## Desacoplar las dos variables

La clave es que **el mapper de audiencia y los scopes de permisos vivan en client
scopes distintos**, asignables por separado:

- `aud-<servicio>` — client scope que solo lleva el **Audience mapper** con la
  audiencia correcta (`security.audience`).
- `aud-wrong` — idéntico pero con «Included Custom Audience» = `otro-servicio`.
- `<recurso>:<accion>` — un client scope por cada scope del diseño, solo con
  `include.in.token.scope=true`, **sin** mapper de audiencia.

Ninguno de los tres se asigna como *realm default client scope*: se asignan
explícitamente por cliente.

## Los 4 clientes mínimos

| Cliente | Client scopes asignados | Token resultante | Sirve para |
|---|---|---|---|
| `test-m2m-ok` | `aud-<servicio>` + `<recurso>:<accion>` | scope ✓ / aud ✓ | Camino feliz M2M → 2xx |
| `test-m2m-no-scope` | `aud-<servicio>` | scope ✗ / aud ✓ | Aísla el **403 por scope** |
| `test-m2m-bad-aud` | `aud-wrong` + `<recurso>:<accion>` | scope ✓ / aud ✗ | Aísla el **403 por audiencia** |
| `test-m2m-none` | (ninguno) | scope ✗ / aud ✗ | Control: con las dos condiciones fallando sigue siendo `403`, nunca `401` |

Los clientes de prueba son **adicionales** a los `serviceClients` que declara el
diseño: esos se crean con su `clientId` exacto y su configuración correcta, y son
los que ejercitan el camino feliz de producción. Los `test-m2m-*` existen solo
para las variantes negativas de los escenarios.

## Receta

```bash
KC="docker compose -f infra/docker-compose.yaml exec keycloak /opt/keycloak/bin/kcadm.sh"
REALM=<realm>; SVC=<audiencia-del-servicio>   # security.audience, default = nombre del servicio

# 1. Client scope solo-audiencia (correcta)
$KC create client-scopes -r $REALM -s name=aud-$SVC -s protocol=openid-connect
AUD_OK=$($KC get client-scopes -r $REALM -q name=aud-$SVC --fields id --format csv --noquotes | tail -1)
$KC create client-scopes/$AUD_OK/protocol-mappers/models -r $REALM \
    -s name=aud-mapper -s protocol=openid-connect \
    -s protocolMapper=oidc-audience-mapper \
    -s 'config."included.custom.audience"='"$SVC" \
    -s 'config."access.token.claim"=true'

# 2. Client scope solo-audiencia (incorrecta) — mismo mapper, otra audiencia
$KC create client-scopes -r $REALM -s name=aud-wrong -s protocol=openid-connect
AUD_BAD=$($KC get client-scopes -r $REALM -q name=aud-wrong --fields id --format csv --noquotes | tail -1)
$KC create client-scopes/$AUD_BAD/protocol-mappers/models -r $REALM \
    -s name=aud-mapper -s protocol=openid-connect \
    -s protocolMapper=oidc-audience-mapper \
    -s 'config."included.custom.audience"=otro-servicio' \
    -s 'config."access.token.claim"=true'

# 3. Client scope de permisos, uno por scope del diseño — SIN mapper de audiencia
$KC create client-scopes -r $REALM -s name=<recurso>:<accion> -s protocol=openid-connect \
    -s 'attributes."include.in.token.scope"=true'

# 4. Los 4 clientes; a cada uno se le asignan solo los client scopes de su fila
for C in test-m2m-ok test-m2m-no-scope test-m2m-bad-aud test-m2m-none; do
  $KC create clients -r $REALM -s clientId=$C -s enabled=true \
      -s publicClient=false -s serviceAccountsEnabled=true -s secret=test-secret
done
# Asignación (repite por cliente y scope, con los ids que devuelve `get`):
#   PUT /admin/realms/$REALM/clients/<clientId>/default-client-scopes/<scopeId>
# o admin console → Clients → <cliente> → Client scopes → Add client scope.
```

## Verificación antes de correr los escenarios

Decodifica el token de cada cliente y comprueba que **solo** varía lo que debe:

```bash
tok() { curl -s -d "grant_type=client_credentials&client_id=$1&client_secret=test-secret" \
    http://localhost:8180/realms/$REALM/protocol/openid-connect/token | jq -r .access_token; }
for C in test-m2m-ok test-m2m-no-scope test-m2m-bad-aud test-m2m-none; do
  echo "== $C"; tok $C | cut -d. -f2 | base64 -d 2>/dev/null | jq '{aud, scope}'
done
```

Si `test-m2m-no-scope` no muestra el `aud` correcto, las variables siguen
acopladas: el `403` que dé no probará nada sobre el scope, porque la audiencia lo
explicaría igual de bien. Arréglalo **aquí**, no después de ver fallar el escenario.
