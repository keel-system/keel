# El proveedor de identidad, sin acoplamiento a Keycloak

Origen: la revisión del 2026-11-10 de qué pasa con la lectura acotada (DSL 2.27) sobre otro proveedor. Este plan es
independiente de `PLAN-DSL-227-LECTURA-ACOTADA.md`, que conserva su alcance inicial. Regla de siempre: **cada pieza nueva
tiene una red que la ejecuta y un sabotaje que demuestra que esa red la ve.**

**Cuándo empieza:** al terminar las corridas de keel-spring del incremento 8 del plan 2.27
(`vault-227-spring-mongo-rabbit` y `shop-227-spring-postgre`), sin esperar a las de los otros tres generadores.

## Por qué

El acoplamiento no está en el diseño ni en el servidor generado, sino en cómo se **prueba**. Medido el 2026-11-10 buscando
en el código, no con una auditoría completa:

| Capa | Acoplamiento | Qué hay |
|---|---|---|
| DSL y validación | Ninguno | Los schemas solo nombran Keycloak como ejemplo; `crossrefs.js`, `checks.js` y `obligations.js` no lo citan |
| Servidor generado | Bajo | JWT y JWKS estándar; dónde van los roles es una tabla de datos (`TOKEN_CLAIMS`, `gen/access-plan.js`) |
| Arnés de pruebas | Alto | `tokenAs` y `tokenWithScope` solo con Keycloak (`usesPersonaTokens`, `usesScopedTokens`, `gen/identity-realm.js`) |
| Redes en vivo | Alto | `security-check` de keel-nest, keel-dotnet y keel-go, contra Keycloak; keel-spring no tiene esa red. Cognito es un emulador (`mock-oauth2-server`) |
| Corridas | Alto | 2 de los 98 registros de `docs/corridas/` mencionan Cognito |
| keel-recover | Total | `target.js` busca una imagen `keycloak` y `parity-target.js` da de alta personas con `kcadm` |
| Añadir un proveedor | Medio | El catálogo `AUTH` solo tiene `keycloak`, `cognito` y `none`, y hay unas 30 ramas `=== 'keycloak'` o `=== 'cognito'` (20 en keel-core, 9 en los generadores) |

Lo que más pesa: **las garantías solo están demostradas con un proveedor**, y un verde con el emulador prueba menos de lo
que parece, porque el emulador se escribió con la forma que esperamos.

### Lo que falla hoy con un Cognito real

El mecanismo de la lectura acotada no depende del proveedor, pero tres piezas dependen de claims que el access token de
Cognito no trae. Los tres fallos son seguros (se deniega de más). Se deduce del código y de la documentación de AWS: **no
se ha ejecutado contra Cognito real**.

| Pieza | Qué pasa | Estado hoy |
|---|---|---|
| `exemptClients` | Se compara el nombre declarado con `azp`/`client_id`, y Cognito genera ese id: el cliente no se reconoce y recibe el error del alcance en toda ficha | Hueco del generador |
| `callerIdentity` desde un claim que no sea `sub` (`email` en shop-api) | Ese claim va en el ID token: 401 en toda operación que necesite la identidad | Sin documentar |
| `scoping.claim` (`vaults` en asset-vault) | Sin disparador de pre-generación de tokens V2 no llega al access token: conjunto vacío, listados vacíos y error del alcance | La skill de keel-spring lo dice; sin aviso en `build` |

El disparador V2 no está en todos los planes de Cognito: en Lite, solo con las funciones de seguridad avanzada; en
Essentials y Plus, sí.

**El emulador esconde los tres**: pone `client_id` igual al nombre del cliente, añade el claim del alcance directamente y
no emite `email` (shop-api con Cognito probablemente falle ya en local; sin medir).

## Principios

- **El DSL no cambia.** El proveedor se elige al generar, como el broker. Si un diseño necesitara nombrarlo, el hueco es
  del método.
- **Lo que un proveedor sabe hacer se declara como datos**, no como una rama por nombre. Una carencia se rechaza con su
  motivo en vez de quedar implícita.
- **Lo neutral primero**, en `keel-core/gen`, y keel-spring antes que los otros tres: sus pruebas de paridad comparan con lo
  que emite keel-spring.
- **Lo emitido con `auth: keycloak` no se mueve**, para no invalidar los proyectos ya generados. La suite lo fija
  (`keel-nest/test/golden/digests.json` y las paridades).
- **Decir lo que queda sin medir.** Lo que solo se ha visto en el emulador se dice así en las skills y en la salida de
  `build` (`messages.cognitoEmulated`).

## Decisiones abiertas

| # | Pregunta | Recomendación |
|---|---|---|
| P1 | Forma de la traducción de `exemptClients` | Un mapa nombre → id en el `security.yaml` neutral (`gen/security-config.js`), con una variable de entorno por cliente; solo con proveedores cuyo `client_id` no sea el nombre declarado |
| P2 | Si falta esa variable en producción | Que el servicio no arranque: un exento sin reconocer rompe en silencio a un consumidor, y el fallo se descubre tarde |
| P3 | ¿Emite `email` el emulador? | No emitirlo por defecto, como el token real; si el diseño lo necesita, `build` avisa y el emulador lo añade representando un pool con el disparador desplegado |
| P4 | Cuenta de AWS para la corrida real (incremento 7) | Del usuario. Sin ella, el incremento 7 no se hace y el plan lo dice |

## Trampas que hay que medir antes de suponerlas

- **T1 · personas por petición en el emulador.** El código dice que `mock-oauth2-server` fija los claims en su configuración
  y no por petición, y por eso `tokenAs` no se emite. Hay que comprobarlo en su versión fijada (6.0.1): de ahí sale si basta
  con configurarlo o hace falta otra pieza.
- **T2 · `sub` en el emulador.** Es el nombre de usuario, y en Cognito real es un uuid: un escenario o una sonda que
  dependa de su forma no se vería.
- **T3 · `client_id` opaco.** Al dejar de ser el nombre, se mueven los mapeos del emulador (`requestParam: 'client_id'`), el
  arnés y `test-credentials.env`. Con Keycloak no debe cambiar nada.
- **T4 · `validateAudience`.** La skill de keel-spring dice que el filtro de audiencia «choca» con Cognito, y el código ya
  tiene una variante por el prefijo del scope. Hay que ver cuál de los dos está al día.
- **T5 · M2M con disparador.** Según AWS, los tokens de máquina solo pasan por el disparador con el evento V3, en Essentials
  y Plus. Un `scoping.claim` en un cliente no exento no llegaría con V2.

## Incrementos (secuenciales desde `main`, sin subagentes, un generador cerrado antes del siguiente)

**0. Inventario y medidas.** Clasificar las unas 30 ramas por proveedor (capacidad, aprovisionamiento o forma del token) y
resolver T1 a T4. Las decisiones P1 a P3 se cierran aquí. **Medido con:** la tabla escrita en este plan.

**1. Las capacidades del proveedor, como datos.** Cada entrada de `AUTH` declara lo que sabe hacer (personas por petición,
claims por usuario, `client_id` igual al nombre, identidad en el access token…), y `usesPersonaTokens`, `usesScopedTokens` y
las demás ramas preguntan por la capacidad. Refactorización sin cambios: **medido con** lo emitido byte a byte igual con
Keycloak y con Cognito, y las suites.

**2. `exemptClients` con un `client_id` opaco.** Lo neutral en `gen/security-config.js` y `gen/read-scope.js`, y después los
cuatro generadores, keel-spring primero. **Medido con:** RS-10 con un `client_id` que no es el nombre, en los cuatro.
**Sabotaje:** sin la traducción, el cliente exento cae en el error del alcance.

**3. Los avisos y las skills.** `build` avisa si el diseño depende de un claim que el access token de ese proveedor no trae
(`callerIdentity` que no sea `sub`, `scoping.claim`), con la capacidad del incremento 1 y el mismo texto en los cuatro.
Las cuatro skills `keel-<tech>-cognito` explican el disparador y sus planes. **Medido con:** una prueba por caso y
`generator-docs.test.js`.

**4. Un emulador que no esconde.** `client_id` opaco, `sub` con la forma real y `email` según P3. Si T1 lo permite,
`tokenAs` y `tokenWithScope` también con Cognito; si no, quedan rechazados con su motivo. **Medido con:** `identity-provisioning.test.js`
y el humo del arnés con `auth: cognito`. **Sabotaje:** volver al `client_id` igual al nombre deja de pasar la sonda del
incremento 2.

**5. Las redes en vivo con Cognito.** `security-check --auth=cognito` en keel-nest, keel-dotnet y keel-go, contra el
emulador del incremento 4, con los casos que apliquen y sus sabotajes; en keel-spring, `read-scope-check` con los claims de
Cognito. Los casos RS y OA de la 2.27 entran aquí. **Medido con:** esas redes en verde y falsadas.

**6. keel-recover con un adaptador por proveedor.** `src/lib/idp/`, con el patrón de `src/lib/db/`: lo de Keycloak se muda
sin cambios y un proveedor sin adaptador es un rechazo con motivo. Ata el registro a `target.schema.json`. Cognito queda
rechazado hasta que lo pida un legacy. **Medido con:** `test/` de keel-recover y `target-db-check`.

**7. Una corrida contra un Cognito real.** Requiere P4. `asset-vault` en keel-spring, con el disparador desplegado: mide
`exemptClients`, el claim del alcance y T5. Se registra en `docs/corridas/`.

## Fuera de alcance

- Un tercer proveedor (Auth0, Entra). Se añade cuando lo pida un diseño real; con el incremento 1 hecho, cuesta mucho menos.
- Probar contra Cognito el alta de pools, grupos y usuarios: el servicio generado es un resource server y no los usa.

## Puerta de cierre

- Las suites de los seis paquetes en verde.
- Lo emitido con `auth: keycloak`, igual que antes del plan.
- Ninguna rama por nombre de proveedor fuera del aprovisionamiento y de la forma del token.
- Cada sabotaje cae solo en sus casos, en cada generador.
- La corrida real hecha, o escrito en este plan por qué no.

## Cómo se ejecuta

- Desde `main`, sin subagentes ni worktrees, y keel-spring primero.
- Cada incremento termina con «Para retomar» y un commit en `main`.
- Las redes en vivo, de una en una. Los temporales en `D:`.

## Estado

| Incremento | Estado | Medido con |
|---|---|---|
| 0. inventario y medidas | pendiente | |
| 1. capacidades como datos | pendiente | |
| 2. `exemptClients` con `client_id` opaco | pendiente | |
| 3. avisos y skills | pendiente | |
| 4. emulador que no esconde | pendiente | |
| 5. redes en vivo con Cognito | pendiente | |
| 6. keel-recover con adaptador | pendiente | |
| 7. corrida contra Cognito real | pendiente | |

## Para retomar

- Plan escrito el 2026-11-10. Las corridas de keel-spring del plan 2.27 ya terminaron (asset-vault 32/32, shop-api 92/92), así
  que la condición de inicio se cumple. Se empieza en un contexto nuevo, por decisión del usuario.
- **Adelantado del incremento 0, solo leyendo (2026-11-10). No está cerrado:**
  - **T1, a medias.** La documentación de `mock-oauth2-server` dice que todos los parámetros de la petición de token están
    disponibles como variables en los claims (`${clientId}` y los parámetros del formulario, sustituidos también dentro de
    listas y mapas). El comentario de `usesPersonaTokens` (`gen/identity-realm.js`), que descarta `tokenAs` con Cognito porque
    los claims van «fijos en la configuración», parece desactualizado. **Falta medirlo en vivo con la 6.0.1**: qué sale cuando
    el parámetro no llega (un claim que debe faltar) y si un mapping puede dar un `sub` elegido por petición.
  - **T4, resuelto.** La que está desactualizada es `references/configuration.md` de `keel-spring-cognito`: dice que el filtro
    de audiencia choca con Cognito, y `renderAudienceFilter` (`keel-spring/src/scaffold/security.js`) ya mira el prefijo del
    scope, como dice la tabla de rarezas del `SKILL.md`. Hay que corregir esa referencia.
  - **T2 y T3, vistos en el código.** En `cognitoMockConfig` (`gen/identity-provisioning.js`), `sub` es el nombre de usuario y
    `client_id` el nombre del cliente, en usuarios y en máquinas.
  - **Las ramas, primera clasificación** (sin cerrar; volver a contarlas):
    - Capacidades, las que el incremento 1 convierte en datos: `usesPersonaTokens` y `usesScopedTokens`.
    - Forma del token: `access-plan.js`, el `const cognito` de `security.js` en los cuatro generadores y `tokenClaims`.
    - Aprovisionamiento e infraestructura: `identity-provisioning.js`, `deploy.js`, `tokenUrl` e issuer en `identity-realm.js`,
      `security-config.js`, `config.js` y `readme.js` de keel-spring. Parecen legítimas: es donde cada proveedor es distinto.
- Siguiente: **incremento 0**: medir T1 y T5, cerrar la clasificación y decidir P1 a P3.
