# Corrida 2026-09-22 — prueba manual de `catalog` con `deploy/`

No es una corrida de generación: es la **validación manual** que viene después, sobre el
proyecto de la corrida del 21 (`keel-registry/services/catalog-spring`, 200/200), levantando
`deploy/` con podman y recorriendo los flujos con las colecciones de Postman. Es la primera
vez que alguien la hace entera sobre un diseño con scopes, bucket público y seguridad a la vez.

| | |
|---|---|
| Diseño | `catalog` v0.1.0 (DSL 2.14, relacional, 7 capas) |
| Stack | postgresql · rabbitmq · keycloak · minio · otel |
| Generador | `keel-spring@0.1.5` |
| Huecos | **3, los tres del generador**; ninguno del diseño |
| Parches a mano | 3 (`docker-compose.yaml`, `realm-export.json`, un `postman-env.sh` nuevo) |

## Lección transferible

**`deploy/` no tenía ninguna red que lo cruzara con quien lo consume.** La suite de
integración corre contra `infra/`, y `deploy-check` usa `job-dispatch` —sin seguridad ni
storage— porque es el único fixture cuyo contexto arranca sin código del agente. Así que lo
que `deploy/` le entrega a la app (entorno) y al diseñador (realm, credenciales) no lo
verificaba nadie, y los tres fallos eran justo eso.

## Los tres huecos

1. **No había environment de Postman.** `/keel-docs` tiene prohibido generarlo (el diseño no
   sabe de proveedores) y el generador, que sí sabe, no lo emitía. Ahora `build` escribe
   `deploy/postman/<servicio>-local.postman_environment.json` desde `realmSpec()`, con los
   nombres de variable que la guía de `/keel-docs` pasa a fijar como contrato (incluido
   `other-audience` para el rechazo por audiencia). Test: cruce contra el realm importado.
2. **403 con token válido.** Un import de Keycloak **con** `clientScopes` propios no siembra
   los integrados (`basic`, `roles`, `profile`), y son los que ponen `realm_access.roles`,
   `preferred_username` y `sub` en el token. El realm de `infra/` lo crea kcadm vacío y
   Keycloak sí los siembra: por eso la suite estaba en verde. Solo afecta a diseños con
   scopes. Ahora el export declara los tres integrados, con los nombres de claim sacados de
   `AUTH_PROVIDERS.keycloak` (lo que lee el `JwtAuthConverter`). Test: el claim que lee el
   converter generado tiene que salir de un mapper alcanzable por el cliente de usuario.
   Verificado en vivo contra Keycloak 26.3.1: token de usuario con roles, máquinas con su
   audiencia y scopes intactos.
3. **La app no arrancaba.** `develop` declara `${STORAGE_PUBLIC_BASE_URL}` sin default (a
   propósito) y `appEnvironment()` no la ponía. Arreglado, y con un gate genérico
   (`test/deploy-develop-env.test.js`): toda variable sin default de `develop` tiene que estar
   en el entorno de la app de `deploy/`, en todos los fixtures y con dos variantes de stack.

## Qué queda

- Una red en vivo del realm dentro de `deploy-check` (levantar solo `keycloak` y decodificar
  un token). Hoy la verificación en vivo se hizo a mano en esta sesión.
- Propagar a `catalog-spring`: `keel-spring build specs/catalog --refresh`. Los dos archivos
  parcheados a mano saldrán como conflicto; la versión nueva es la buena.
