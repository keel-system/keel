# Clientes M2M de prueba — matriz scope × audiencia

Cuando el diseño declara `serviceAuth` con scopes, `infra/init-keycloak.sh` crea, además de los
`serviceClients` del diseño, clientes de prueba que varían **una sola** condición cada uno. Así un 403 se
puede atribuir a su causa:

| Cliente | Lleva | Token | Sirve para |
|---|---|---|---|
| `test-m2m-ok` | audiencia del servicio + todos los scopes | scope ✓ / aud ✓ | Camino feliz M2M → 2xx |
| `test-m2m-no-scope` | solo la audiencia | scope ✗ / aud ✓ | Aísla el **403 por scope** |
| `test-m2m-bad-aud` | audiencia ajena + todos los scopes | scope ✓ / aud ✗ | Aísla el **403 por audiencia** (solo con `validateAudience: true`) |
| `test-m2m-none` | nada | scope ✗ / aud ✗ | Control: sigue siendo 403, nunca 401 (solo con `validateAudience: true`) |

Todos comparten el secreto `AUTH_CLIENT_SECRET` de `infra/test-credentials.env`; los del diseño tienen el
suyo (`AUTH_CLIENT_SECRET_<CLIENTE>`). Desde el arnés: `serviceCredential('test-m2m-no-scope')`.

La audiencia y los permisos viven en client scopes **separados** (`aud-<servicio>`, `aud-wrong` y uno por
scope del diseño): si viajaran juntos, el cliente «sin scope» perdería también la audiencia y su 403 no
probaría nada sobre el scope.

## Dónde se comprueba la audiencia

Solo en las rutas de `audience: services` del diseño, y como **autorización**: un token legítimo emitido
para otro servicio está autenticado y no autorizado (403). Las rutas de usuarios y las `both` no la
comprueban — un token de usuario lleva la audiencia del proveedor (`aud: account`), y exigirla ahí
rechazaría a todos los usuarios.

## Verificación antes de correr los escenarios

```bash
REALM=<servicio>
tok() { curl -s -d "grant_type=client_credentials&client_id=$1&client_secret=test-secret" \
    http://localhost:8180/realms/$REALM/protocol/openid-connect/token | sed 's/.*"access_token":"\([^"]*\)".*/\1/'; }
for C in test-m2m-ok test-m2m-no-scope test-m2m-bad-aud test-m2m-none; do
  echo "== $C"; tok $C | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null; echo
done
```

Si `test-m2m-no-scope` no trae el `aud` correcto, el realm está a medias: vuelve a ejecutar
`bash infra/init-keycloak.sh` (es idempotente).
