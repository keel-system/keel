# Keycloak — troubleshooting

Síntoma → causa → arreglo. Decodificar un token: `echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d`.

## 401 con un token que «debería» valer

1. **Issuer distinto** (la causa nº 1): el claim `iss` tiene que ser carácter a carácter el
   `security.oauth2.issuer-uri` del perfil (`http://localhost:8180/realms/<servicio>` en local). Pasa al
   pedir el token a `keycloak:8080` (desde un contenedor) y validar contra `localhost:8180`. Pide el token
   al mismo host que valida la app: es lo que hace el arnés (`AUTH_TOKEN_URL`).
2. **Token caducado**: duran cinco minutos. Un token guardado en una variable al principio del flujo
   caduca a mitad; llama a `tokenFor(...)` en cada petición.
3. **Bearer mal formado**: la cabecera es `Authorization: Bearer <token>` con un solo espacio; cualquier
   otra forma es 401, como en Spring.

## 500 en la primera petición con token

El servidor no pudo leer las claves: el discovery de `issuer-uri` (`/.well-known/openid-configuration`)
no responde o el realm no existe. No es la credencial (por eso no es 401): levanta la infra y ejecuta
`bash infra/init-keycloak.sh`. El servicio arranca aunque Keycloak no esté: las claves se resuelven en la
primera petición con token y, si fallan, se reintenta en la siguiente.

## 403 con un usuario que tiene el rol

- El rol no está **asignado** al usuario, o lo está en `resource_access` (rol de cliente) y no en
  `realm_access`: decodifica el token. El script asigna roles de realm.
- Mayúsculas: el nombre se compara tal cual; `ADMIN` ≠ `admin`.
- La regla exige un **permiso** (`recurso:accion`) y el rol no lo otorga en `roleGrants` del diseño.
- **El 403 trae el `code` del alcance** (el `error` de `authentication.scoping`) y sale en varios roles a
  la vez: no es el servidor, es el claim. `bash infra/validate-infra.sh` comprueba que cada usuario lo
  lleva; si estaba en verde, el realm se re-sembró después.

## `invalid_grant` al pedir el token

- `"Account is not fully set up"`: al usuario le faltan `email`, `firstName` o `lastName` y el perfil de
  usuario del realm los exige. Los usuarios del script los llevan; las personas de `tokenAs` no, y por
  eso `tokenAs` relaja ese perfil la primera vez.
- Contraseña distinta de `AUTH_TEST_PASSWORD`, o el realm no se sembró: `bash infra/init-keycloak.sh`.

## Los escenarios fallan de forma intermitente

`start-dev` tarda en aceptar peticiones más que el «up» del compose. `init-keycloak.sh` ya espera a la
sesión de administración; si los flujos arrancan antes que él, el primer token falla con conexión
rechazada. El humo del arnés (SMOKE-5) lo detecta antes que ningún flujo.
