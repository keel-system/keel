# Keycloak — troubleshooting

Síntoma → causa → arreglo. Decodificar un token: `echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d`.

## 401 con un token que «debería» valer

1. **Issuer distinto** (la causa nº 1): el claim `iss` tiene que ser carácter a carácter el `issuer-uri` de
   `config/parameters/<perfil>/security.yaml` (`http://localhost:8180/realms/<servicio>` en local). Pasa al pedir
   el token a `keycloak:8080` (desde un contenedor) y validar contra `localhost:8180`. Pide el token al mismo host
   que valida el servidor: es lo que hace el arnés (`AUTH_TOKEN_URL`).
2. **Token caducado**: duran cinco minutos. Un token guardado en una variable al principio del flujo caduca a
   mitad; llama a `s.TokenFor(...)` en cada petición.
3. **Bearer mal formado**: la cabecera es `Authorization: Bearer <token>` con un solo espacio (`Bearer(token)` la
   escribe así); cualquier otra forma es 401, como en los otros tres servidores.
4. **Falta el claim de la identidad** (`callerIdentity`): el token autentica, pero sin ese claim el lector del
   endpoint no sabe quién llama y responde 401. Con `TokenAs`, revisa `Persona.Claims` y `Persona.Without`.

## 500 en la primera petición con token

El servidor no pudo leer las claves: el discovery de `issuer-uri` (`/.well-known/openid-configuration`) no
responde o el realm no existe. No es la credencial (por eso no es 401): levanta la infra y ejecuta
`bash infra/init-keycloak.sh`. El servidor arranca aunque Keycloak no esté: las claves se leen en la primera
petición con token y, si fallan, se reintenta en la siguiente.

## 403 con un usuario que tiene el rol

- El rol no está **asignado** al usuario, o lo está en `resource_access` (rol de cliente) y no en `realm_access`:
  decodifica el token. El script asigna roles de realm.
- Mayúsculas: el nombre se compara tal cual; `ADMIN` ≠ `admin`.
- La regla exige un **permiso** (`recurso:accion`) y el rol no lo otorga en `roleGrants` del diseño.

## `invalid_grant` al pedir el token

- `"Account is not fully set up"`: al usuario le faltan `email`, `firstName` o `lastName` y el perfil de usuario
  del realm los exige. Los usuarios del script los llevan; las personas de `TokenAs` no, y por eso `TokenAs` relaja
  ese perfil la primera vez.
- Contraseña distinta de `AUTH_TEST_PASSWORD`, o el realm no se sembró: `bash infra/init-keycloak.sh`.

## `TokenAs` falla con un error de la administración del realm

- `401` al pedir el token de administración: `AUTH_ADMIN_USER`/`AUTH_ADMIN_PASSWORD` de
  `infra/test-credentials.env` no son las del contenedor.
- «el realm no respetó el id pedido»: un Keycloak que ignora el `id` también en `partialImport`; el `sub` del token
  no sería el del escenario, y no hay forma de pedirlo desde el arnés.

## Los escenarios fallan de forma intermitente

`start-dev` tarda en aceptar peticiones más que el «up» del compose. `init-keycloak.sh` ya espera a la sesión de
administración; si los flujos arrancan antes que él, el primer token falla con conexión rechazada. El humo del
arnés (SMOKE-5) lo detecta antes que ningún flujo.
