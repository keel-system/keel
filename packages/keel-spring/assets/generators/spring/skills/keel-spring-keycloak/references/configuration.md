# Keycloak — configuración

Qué hay detrás de `parameters/<perfil>/oauth2.yaml` y qué puede ajustar el
agente. El código de seguridad (SecurityConfig, `JwtAuthConverter`) **lo
genera build y no se toca**; aquí solo configuración.

## `issuer-uri`: cómo funciona y por qué debe coincidir exacto

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: http://localhost:8180/realms/<realm>
```

- Al arrancar, Spring descubre `<issuer>/.well-known/openid-configuration` y
  de ahí el JWKS para validar firmas. **La app no arranca si Keycloak está
  caído** con `issuer-uri` (hace la petición en el arranque); si eso molesta
  en local, cambia a `jwk-set-uri` (no valida el claim `iss` — entonces
  compénsalo con un validador o asume el riesgo solo en local).
- La validación compara el claim `iss` del token **carácter a carácter** con
  el issuer configurado. El token emitido por `http://localhost:8180/...`
  solo vale contra ese issuer exacto: pedir el token a un host y validarlo
  con otro (p. ej. `keycloak:8080` desde devtools) da 401 (ver
  troubleshooting).

## Puertos del compose

Keycloak escucha en 8080 **dentro** del contenedor, publicado como **8180**
en el host. La app (host) y los tokens usan `localhost:8180`; el sondeo desde
devtools usa `keycloak:8080`. No mezcles.

## Claims y mapeo (lo hace build, entiéndelo para depurar)

El `JwtAuthConverter` generado mapea `realm_access.roles` (roles de realm) y
`resource_access.<cliente>.roles` (roles de cliente) a authorities. Los roles
de `security.keel.yaml` deben existir en Keycloak como roles de **realm**
(la ruta que el converter cubre siempre); usa roles de cliente solo si el
diseño distingue por cliente.

## Ajustes que sí puede necesitar el agente

- **Audiencia**: por defecto no se valida `aud`. Si el diseño exige que el
  token sea para este servicio, añade `audiences` al YAML
  (`spring.security.oauth2.resourceserver.jwt.audiences: [<cliente>]`) y
  configura en Keycloak un mapper de audience para el cliente.
- **Clock skew**: el validador tolera 60s por defecto — suficiente; si ves
  expiraciones raras el problema es el reloj del contenedor, no el skew.
- **Vida del token**: para escenarios largos, sube el access token lifespan
  del realm de prueba (Realm settings → Tokens) en vez de regenerar token a
  mitad de flujo.

## Por perfil

- **local**: issuer literal al realm de prueba (`http://localhost:8180/realms/<realm>`
  — ajusta `<realm>` al que crees en `references/environment.md`).
- **develop/production**: `${OAUTH2_ISSUER_URI}` (ya en el gradiente) apuntando
  al Keycloak real; **https siempre** fuera de local.

## Qué no hacer

- No reescribas `SecurityConfig`/`JwtAuthConverter` para «arreglar» un 401/403:
  el arreglo casi siempre está en el realm (roles, mappers) o en el issuer.
- No desactives la validación de firma ni uses `permitAll` para desbloquear
  escenarios: los escenarios de seguridad validan exactamente eso.
