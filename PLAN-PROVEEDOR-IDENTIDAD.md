# El proveedor de identidad: el mismo servidor con Keycloak o con Cognito

Origen: la revisión del 2026-11-10 de qué pasa con la lectura acotada (DSL 2.27) sobre otro proveedor, reorganizada el mismo
día tras evaluar el plan contra el código. Es independiente de `PLAN-DSL-227-LECTURA-ACOTADA.md`. Regla de siempre: **cada
pieza nueva tiene una red que la ejecuta y un sabotaje que demuestra que esa red la ve.**

**Objetivo.** Dado un diseño que requiere un proveedor de identidad, keel genera un servidor equivalente con el proveedor
elegido, y se puede afirmar que ese servidor funcionará con él. No hace falta generar todos los proyectos con Cognito: lo que
se garantiza es el contrato entre el servidor y el token. Y queda un camino medido para añadir otro proveedor.

**Nivel de garantía.** El contrato se verifica contra la documentación del proveedor y un emulador fiel, no contra un pool real:
las fases 1 a 4 no necesitan una cuenta de AWS. Lo que eso no demuestra está en la fase 5, y se dice en lo que se genera.

**Cuándo empieza:** ya se cumple la condición (las corridas de keel-spring del inc. 8 del plan 2.27 terminaron: asset-vault
32/32 y shop-api 92/92).

## Por qué

El diseño no depende del proveedor y el servidor casi tampoco, pero **las garantías solo están demostradas con uno**, y un
verde con el emulador prueba menos de lo que parece, porque el emulador se escribió con la forma que esperamos.

| Capa | Acoplamiento | Qué hay |
|---|---|---|
| DSL y validación | Ninguno | Los schemas solo nombran Keycloak como ejemplo; `crossrefs.js`, `checks.js` y `obligations.js` no lo citan |
| Servidor generado | Medio | JWT y JWKS estándar, pero el contrato del token está repartido: roles y principal en `TOKEN_CLAIMS` (`gen/access-plan.js`), y scopes, audiencia y cliente en una rama `const cognito` o en literales de cada generador |
| Arnés de pruebas | Alto | `tokenAs` y `tokenWithScope` solo con Keycloak (`usesPersonaTokens`, `usesScopedTokens`, `gen/identity-realm.js`) |
| Redes en vivo | Alto | `security-check` de keel-nest, keel-dotnet y keel-go, contra Keycloak; keel-spring no tiene esa red. Cognito es un emulador (`mock-oauth2-server`) |
| Corridas | Alto | 2 de los 100 registros de `docs/corridas/` mencionan Cognito |
| keel-recover | Total | `target.js` busca una imagen `keycloak` y `parity-target.js` da de alta personas con `kcadm`. Con Cognito omite el bloque `idp` sin decir nada |
| Añadir un proveedor | Medio | El catálogo `AUTH` solo tiene `keycloak`, `cognito` y `none`, 36 ramas por nombre (23 en keel-core y 13 en los generadores, recontadas en el incremento 1.1) y una skill por generador y proveedor, que ya divergen: la de keel-spring tiene 89 líneas y tres referencias, las otras tres unas 52 y ninguna |

### Lo que falla hoy con un Cognito real

Se deduce del código y de la documentación de AWS: **no se ha ejecutado contra Cognito real**.

| # | Pieza | Qué pasa | Falla |
|---|---|---|---|
| D1 | `token_use` | Ningún generador lo comprueba. Un ID token del mismo pool tiene el mismo emisor y firma y trae `cognito:groups`: se acepta como access token | **Concede de más** |
| D2 | Prefijo del scope | Los cuatro cortan por la primera `/` sin comprobar que sea el del servicio: `otra-api/product:read` acaba siendo `SCOPE_product:read`, y un identificador con forma de URL no casa con ninguna regla | **Concede de más** o 403 |
| D3 | `exemptClients` | Se compara el nombre declarado con `azp`/`client_id`, y Cognito genera ese id: el cliente no se reconoce | Deniega |
| D4 | `callerIdentity` con `source: serviceClient` y correspondencia 1:1 | El mismo problema: el identificador del recurso sería el id opaco, no el nombre declarado. Con `resolvedBy` funciona (la lista guarda los ids) y **no debe traducirse**. Ninguna fixture cubre el 1:1 | Deniega |
| D5 | `callerIdentity` desde un claim que no sea `sub` (`email` en shop-api) | Ese claim va en el ID token: 401 en toda operación que necesite la identidad | Deniega |
| D6 | `scoping.claim` (`vaults` en asset-vault) | Sin disparador de pre-generación de tokens no llega al access token: conjunto vacío, listados vacíos y error del alcance | Deniega |

El disparador V2 está en Essentials y Plus, y en Lite solo con las funciones de seguridad avanzada. Los tokens de máquina solo
pasan por el disparador con V3, en Essentials y Plus (documentación de AWS, consultada el 2026-11-10). `aud` no sirve de
alternativa: en un access token solo puede valer el id del app client.

**El emulador esconde D3 a D6**: pone `client_id` igual al nombre del cliente, añade el claim del alcance directamente y no
emite `email`.

## Principios

- **El DSL no cambia.** El proveedor se elige al generar, como el broker o la pasarela. Si un diseño necesitara nombrarlo, el
  hueco es del método.
- **Lo que un proveedor es y sabe hacer se declara como datos**, en un único descriptor, no como una rama por nombre. Una
  carencia se rechaza o se avisa con su motivo en vez de quedar implícita.
- **Se reutiliza el precedente de las pasarelas de pago**: el catálogo neutral, la matriz con `checkGatewaySupport`, el
  veredicto en `check` y en `build`, y la prueba de que solo difiere lo permitido (`payment-parity.test.js`).
- **Lo neutral primero**, en `keel-core/gen`, y keel-spring antes que los otros tres: sus pruebas de paridad comparan con lo
  que emite keel-spring.
- **Lo emitido con `auth: keycloak` no se mueve**, para no invalidar los proyectos ya generados. La suite lo fija
  (`test/golden/digests.json` y las paridades). Lo emitido con `auth: cognito` sí cambia, y es a propósito.
- **Decir lo que queda sin medir.** Lo que solo se ha visto en el emulador se dice así en las skills y en la salida de `build`
  (`messages.cognitoEmulated`).

## Decisiones

| # | Pregunta | Estado |
|---|---|---|
| P1 | Forma de la traducción del cliente | **Cerrada.** Un mapa nombre → id por configuración, con una variable de entorno por cliente, solo con proveedores cuyo `client_id` no sea el nombre declarado. Se aplica en el único punto que lee el cliente de la credencial. Va en `gen/security-config.js` y también en el `config.js` de keel-spring, que no usa ese módulo. No se aplica con `resolvedBy` |
| P2 | Si falta esa variable en producción | **Cerrada.** El servicio no arranca, solo por los clientes de los que depende (exentos e identidad 1:1): un exento sin reconocer rompe en silencio a un consumidor |
| P3 | ¿Emite `email` el emulador? | **Cerrada.** No por defecto, como el token real. Si el diseño lo necesita, el emulador lo añade representando un pool con el disparador desplegado, y `check`/`build` lo dicen |
| P4 | Cuenta de AWS | **Cerrada: no hace falta para este plan.** Solo la necesitan lo opcional (incremento 1.5) y la fase 5, diferida. Si llega a usarse: un perfil propio en la máquina, nunca credenciales en la conversación, y recursos con prefijo `keel-` que se borran al terminar |
| P5 | Generador de la red de extremo a extremo (incremento 4.4) | **Abierta.** Recomendación: keel-spring, que es la referencia y la única sin `security-check` |

## Trampas

- **T1 · personas por petición en el emulador. Medido en vivo con la 6.0.1 (2026-11-10).** Las plantillas funcionan por
  petición: `sub`, `email` y un elemento de `cognito:groups` salieron del formulario. El comentario de `usesPersonaTokens` que
  lo descarta está desactualizado. Tres límites medidos: un parámetro ausente deja el literal `${email}` en el token, así que
  «un token sin ese claim» necesita su propio mapping; un parámetro repetido no devuelve token, así que varios valores no
  entran por ahí; y un cliente sin mapping recibe un token válido sin `sub`. Sin medir: varios valores en un solo parámetro.
- **T2 · `sub` en el emulador.** Es el nombre de usuario, y en Cognito real es un uuid: un escenario o una sonda que dependa de
  su forma no se vería.
- **T3 · `client_id` opaco.** Al dejar de ser el nombre, se mueven los mapeos del emulador (`requestParam: 'client_id'`), el
  arnés y `test-credentials.env`. Por lo medido en T1, un mapeo que se quede atrás no falla: da un token vacío. Con Keycloak no
  debe cambiar nada.
- **T4 · `validateAudience`. Resuelta.** La desactualizada es `references/configuration.md` de `keel-spring-cognito`, que dice
  que el filtro de audiencia choca con Cognito; `renderAudienceFilter` ya mira el prefijo del scope.
- **T5 · M2M con disparador. Confirmada en la documentación**: solo con V3. Un `scoping.claim` en un cliente no exento no llega
  con V2.
- **T6 · `SECURITY_AUDIENCE` solo existe con `validateAudience: true`.** Para quitar solo el prefijo propio (D2), un proveedor
  con scopes prefijados la necesita también con scopes declarados sin esa validación.

## Fases

Cada fase se implementa completa en un hilo de conversación. Dentro de una fase, los incrementos van en orden, y un generador
se cierra antes de empezar el siguiente.

### Fase 1 · El contrato del proveedor (solo keel-core, sin cambios en lo emitido)

Deja todo lo que un proveedor es en un solo sitio, y la forma de demostrar que un servidor lo cumple.

- **1.1 Inventario.** Recontar las ramas por nombre y clasificar cada una: contrato del token, capacidad del arnés o
  aprovisionamiento. **Medido con:** la tabla escrita en este plan.

  Hecho el 2026-11-10: 36 ramas, sin contar `keel-recover` (fase 3.4) ni las redes en vivo (`scripts/`). Las líneas son las
  de `3c0a7961`.

  | Clase | Qué decide | Dónde |
  |---|---|---|
  | Contrato del token (6) | Formato de los scopes y cómo se expresa la audiencia | `gen/access-plan.js:213`, `keel-spring/.../security.js:626` y `:842`, y el `security.js` de keel-nest (`:288`), keel-dotnet (`:369`) y keel-go (`:299`) |
  | Capacidad del arnés (3) | Personas por petición, valores del alcance y el sondeo del claim | `gen/identity-realm.js:85`, `:158` y `:184` |
  | Aprovisionamiento (23) | URLs del proveedor de prueba, realm importado o emulador, consola, credenciales de administración y notas del issuer | `gen/identity-realm.js:92`, `:119`, `:197`, `:293` y `:294`; `gen/deploy.js:133`, `:137`, `:208`, `:531`, `:535`, `:595`, `:666`, `:793` y `:950`; `gen/identity-provisioning.js:59`, `:60` y `:79`; `gen/security-config.js:42`; `keel-spring/.../config.js:1299`, `:1304` y `:1314`; `keel-spring/.../readme.js:155` y `:244` |
  | Aviso y skills (4) | Qué se emula y qué skill se instala | `gen/model.js:180`, y el `generator-docs.js` de keel-nest (`:61`), keel-dotnet (`:54`) y keel-go (`:61`) |

  Fuera de la cuenta porque ya son datos: `TOKEN_CLAIMS`, el catálogo `AUTH`, `PORT_VARS` y `HEALTHCHECKS`. Tampoco son ramas, pero
  pasan al descriptor: `cognitoMockConfig`, con los claims de Cognito escritos a mano, y la skill de keel-spring
  (`generator-docs.js:106`), que se instala para cualquier proveedor que no sea `none`.
- **1.2 El descriptor** (`gen/identity-providers.js`). Por proveedor: `token` (roles, permisos, principal, formato de los
  scopes, cómo se expresa la audiencia, claims del cliente y si su valor es el nombre declarado, qué token se acepta, qué claims
  no llegan al access token sin configuración), `harness` (personas por petición, valores del alcance) y `provisioning`.
  Absorbe `TOKEN_CLAIMS` y las capacidades, y `usesPersonaTokens`, `usesScopedTokens` y las demás ramas preguntan al descriptor.
  **Medido con:** lo emitido byte a byte igual con los dos proveedores, y las suites.
- **1.3 Los casos del token como datos** (`gen/token-cases.js`, patrón de `wire.js`). Una tabla neutral `IDT-*`: dado un token
  con la forma de ese proveedor, qué principal, qué authorities, qué identidad, qué exención y qué 401 o 403. Se derivan del
  descriptor y del diseño. Incluye los casos de D1 a D4, que hasta la fase 2 ningún generador cumple. **Medido con:** una prueba
  de la derivación por caso.
- **1.4 Que el camino para otro proveedor exista de verdad.** Un proveedor ficticio registrado solo en los tests, que genera en
  los cuatro sin tocar un generador (como `gen-model.test.js` con una proyección que no es Java); un test que prohíbe las ramas
  por nombre fuera de los módulos del descriptor (como `gen-neutral.test.js`); y un test de paridad entre proveedores, con la
  lista cerrada de lo que puede diferir (como `payment-parity.test.js`). **Sabotaje:** una rama nueva por nombre y un archivo
  distinto fuera de la lista.
- **1.5 Captura de tokens reales (opcional).** Solo si alguien aporta un pool: un token de usuario y uno de máquina, saneados y
  contrastados con los casos `IDT-*`. No bloquea la fase ni la puerta de cierre.

### Fase 2 · El servidor equivalente (los cuatro generadores)

Lo único que cambia en producción. Orden: keel-spring, keel-nest, keel-dotnet, keel-go. Si el contexto no da, el corte natural
es después de keel-nest.

- **2.1 Neutral.** Parámetros de traducción del cliente (P1, P2) y `SECURITY_AUDIENCE` (T6) en `gen/security-config.js`, y la
  referencia ejecutable de cada regla en el descriptor.
- **2.2 La prueba emitida.** `build` escribe en el proyecto una prueba con los casos `IDT-*` del proveedor elegido, firmando sus
  tokens con la clave del perfil `test` (como las que ya emite con `fullAccessClaims`). Es lo que hace que cada proyecto generado
  demuestre su propio contrato sin necesitar el proveedor.
- **2.3 Por generador.** D1 (rechazar lo que no sea un access token), D2 (quitar solo el prefijo propio; un scope de otro
  resource server no da authority), D3 y D4 (traducción en el único lector del cliente, sin tocar `resolvedBy`). RS-10 deja de
  llevar `azp` escrito a mano. **Medido con:** la prueba emitida ejecutada en cada generador (`compile-check` y una red de
  keel-spring, `test/helpers/emitted.js` en keel-nest, `cs-check`, `go-check`). **Sabotaje:** uno por defecto (`token-use`,
  `scope-prefix`, `client-translation`), cada uno cae en exactamente sus casos, en cada generador. Una fixture o silueta que
  declare `serviceClient` 1:1.

### Fase 3 · Lo que el proveedor debe cumplir (sin red)

El servidor puede estar bien y el pool mal configurado. Lo que el pool debe traer se declara y se comprueba por diseño.

- **3.1 La matriz de soporte** (`checkIdentitySupport`, patrón de `gen/payment-gateways.js`). Cruza lo que pide el diseño (D5, D6,
  claims en clientes máquina no exentos) con el descriptor. Estados: soportado, requiere configuración (con qué disparador y
  qué plan) y no soportado. `check` dice con qué proveedores sirve el diseño y `build` lo aplica, con el mismo texto en los
  cuatro. **Medido con:** una prueba por requisito.
- **3.2 El documento de precondiciones** (`docs/keel/identity-contract.md`, emitido siempre, como `engine-limits.md`): grupos,
  resource server, disparador, plan y variables. Con Cognito dice, igual que `build` (`messages.cognitoEmulated`), «verificado
  contra el contrato documentado y el emulador, no contra un pool real», y cómo debe llegar el claim que añade el disparador.
- **3.3 Skills.** Las cuatro `keel-<tech>-cognito` remiten a ese documento en vez de repetirlo, y se corrige la referencia de T4.
  **Medido con:** `generator-docs.test.js` y `harness.test.js`.
- **3.4 keel-recover.** Con un proveedor distinto de Keycloak, `target` rechaza con su motivo en vez de omitir `idp`. **Medido
  con:** `test/target.test.js`.

### Fase 4 · El emulador fiel y el arnés

Un diseño con Cognito tiene que poder llegar a verde en el pipeline, y el emulador no puede esconder lo que falla en real.

- **4.1 Emulador.** `client_id` opaco y determinista, `sub` uuid y `email` según P3, con T3 resuelta. **Medido con:**
  `identity-provisioning.test.js`. **Sabotaje:** volver al `client_id` igual al nombre deja de pasar.
- **4.2 Medir lo que falta de T1**: varios valores del claim y lista vacía.
- **4.3 Arnés.** `tokenAs` y `tokenWithScope` también con Cognito, con un mapping por forma de claims, en los cuatro generadores
  y por capacidad del descriptor. Lo que no se pueda, rechazado con su motivo. **Medido con:** humo del arnés con `auth: cognito`
  y un diseño con identidad en el `sub`.
- **4.4 Red de extremo a extremo**, en el generador de P5, parametrizada por proveedor: infraestructura real, descubrimiento,
  JWKS y emisor, tokens reales del emulador, 401 y 403. Los otros generadores quedan cubiertos por la prueba emitida y por su
  `security-check` contra Keycloak, porque lo que cambia entre proveedores son los claims. **Medido con:** esa red en verde y
  falsada.

### Fase 5 · Cognito real (diferida)

No forma parte del cierre de este plan. Se hace cuando un diseño real vaya a producción con Cognito, y en ese pool, que es el
que importa. El plan se cierra sin ella porque el servidor solo consume el token, cuya forma está documentada por AWS, y porque
los defectos D1 a D6 salieron de leer el código y esa documentación.

**Lo que queda sin demostrar hasta entonces:** que Cognito emita la forma documentada, cómo llega el claim que añade el
disparador (lista o texto) y T5 en ejecución. Si AWS se aparta de su documentación, se verá en el primer despliegue real, casi
siempre como un 401 o un 403 visible, una vez corregidos D1 y D2. Que un pool concreto esté bien configurado no lo demuestra
ninguna red de keel: lo cubre el documento del incremento 3.2.

- **5.1 Verificación dirigida**, no una corrida completa: el arnés no puede funcionar contra un pool real, porque pide los tokens
  de usuario con el grant `password` (por lo que se sabe de Cognito, su `/oauth2/token` no lo admite; sin medir) y `tokenAs` y
  `tokenWithScope` dependen del emulador o del admin de Keycloak. Se pide a mano cada token (`InitiateAuth` para los de usuario,
  `client_credentials` para los de máquina) contra el servidor generado, en local y apuntando al pool, y se miden los casos que
  dependen del proveedor: grupos, scope con prefijo, cliente exento traducido, claim del alcance con V2 y V3, e ID token
  rechazado. Se registra en `docs/corridas/`.
- **5.2 Contraste.** Lo medido contra los casos `IDT-*` y el emulador; se corrige lo que no coincida.

## Fuera de alcance

- Un tercer proveedor real (Auth0, Entra). Se añade cuando lo pida un diseño: un descriptor, sus casos y sus skills.
- El adaptador por proveedor de keel-recover (`src/lib/idp/`). Hasta que un legacy lo pida, basta el rechazo con motivo.
- `security-check --auth=cognito` en todos los generadores.
- Probar contra Cognito el alta de pools, grupos y usuarios: el servicio generado es un resource server y no los usa.

## Puerta de cierre

- Las suites de los seis paquetes en verde.
- Lo emitido con `auth: keycloak`, igual que antes del plan.
- El proveedor ficticio genera en los cuatro, y ningún test admite una rama por nombre fuera del descriptor.
- Todo proyecto generado con proveedor lleva su prueba `IDT-*`, y cada sabotaje cae solo en sus casos, en cada generador.
- Lo generado con Cognito dice que no se ha verificado contra un pool real, y la fase 5 sigue escrita con lo que queda sin
  demostrar.

## Cómo se ejecuta

- Una fase por hilo. Desde `main`, sin subagentes ni worktrees, y keel-spring primero.
- Cada incremento termina con un commit en `main`, y cada fase con «Para retomar».
- Las redes en vivo, de una en una. Los temporales en `D:`.

## Estado

| Fase | Estado | Medido con |
|---|---|---|
| 1. contrato del proveedor | hecha el 2026-11-10 (sin el 1.5, opcional) | Lo emitido, idéntico en 4 generadores × 19 fixtures × 3 valores de `auth`; `keel-core/test/token-cases.test.js` y `keel-go/test/identity-providers.test.js`, falsada con tres sabotajes; las seis suites |
| 2. servidor equivalente | hecha: 2.1 y 2.2/2.3 en keel-spring y keel-nest (2026-11-10), keel-dotnet y keel-go (2026-11-11) | keel-spring: `token-check` (4 diseños) y sus 4 sabotajes. keel-nest: `test/token-contract.test.js` ejecuta lo emitido, 3 sabotajes, y `ts-check --auth=cognito` 13/13. keel-dotnet: `cs-check --fixtures` con cuatro variantes `*-cognito` y 3 sabotajes, cada uno en exactamente sus casos. keel-go: `go-check --token` (5 sujetos con gofmt, vet y staticcheck) 9/9 y 3 sabotajes, cada uno en exactamente sus casos. Lo emitido con `keycloak` y sin proveedor, idéntico salvo la prueba nueva |
| 3. lo que debe cumplir el proveedor | pendiente | |
| 4. emulador fiel y arnés | pendiente | |
| 5. Cognito real | diferida (fuera del cierre) | |

## Para retomar

- Plan reorganizado en fases el 2026-11-10 tras evaluarlo contra el código. Ya medido o resuelto: T1 (salvo varios valores), T4
  y T5; P1 a P4 cerradas. Por decisión del usuario, el plan se hace con el emulador y sin cuenta de AWS.
- Fase 1 hecha. Lo que deja: `gen/identity-providers.js` (el descriptor; `identityProvider(auth)` y `tokenContract(auth)`),
  `gen/token-cases.js` (`tokenCases(model)`, con `defect` en D1 a D4) y las tres redes de `keel-go/test/identity-providers.test.js`.
  El proveedor ficticio se registra añadiendo su entrada a `IDENTITY_PROVIDERS` y a `AUTH`.
- `cognitoMockConfig` ya sale del descriptor, pero sigue escribiendo `client_id` igual al nombre: eso es T3, en la fase 4.
  `messages.cognitoEmulated` sigue siendo un texto de Cognito en cada proyección: otro proveedor emulado necesitaría el suyo.
- `npm run golden -- --check` de keel-spring y keel-nest **ya estaba en rojo antes de empezar** (417 y 407 diferencias, las mismas
  con y sin la fase 1, en agentes y skills). Una `--check` no vale para la fase 2 hasta regenerarlas, y regenerarlas a ciegas
  tampoco: la fase 1 se midió con una línea base propia tomada antes de tocar nada.
- Fase 2 cortada después de keel-nest, el corte natural del plan. Lo neutral está en `gen/identity-providers.js` (la referencia
  ejecutable: `acceptsToken`, `grantedScope`, `credentialClient`, `isExemptClient`, `declaredClient`; `tokenContract` da también
  `clientClaims`, `opaqueClients` y `accepted`) y en `gen/security-config.js` (`needsAudience`, `translatedClients`, `clientIdLines`). El
  diseño de D4 sin fixture es `keel-core/test/helpers/identity-designs.js`.
- Decisiones tomadas al implementar: con scopes prefijados, un scope sin el prefijo propio no da authority (tampoco uno pelado); con ids
  generados, a falta del claim el nombre de la autenticación no sustituye al cliente; un id fuera del mapa sigue crudo y no encuentra
  recurso, como un cliente desconocido con Keycloak; el rechazo de D1 se hace donde el token se convierte en principal, también en un
  diseño sin reglas por rol (keel-spring emite entonces el conversor con el `sub` de principal).
- Trampas medidas: en keel-spring el `Binder` deja un `${VAR}` sin resolver como texto, y P2 no se cumpliría (se lee con
  `getRequiredProperty`); toda prueba emitida que firme a mano un token necesita el claim del tipo (`accepted`), o da 401 donde espera
  403 (lo vio `ts-check`). **keel-dotnet (`api-tests.js:338`) y keel-go (`api-tests.js:545`) tienen ese mismo token.**
- Local sigue con `client_id` igual al nombre: `clientIdLines` pone el nombre en `local` y `develop`, y cambia con T3 en la fase 4.
- **Fase 3.2 o antes:** la descripción de `SECURITY_AUDIENCE` en `keel-spring/.../readme.js` dice «claim `aud`», falso con Cognito.
- keel-dotnet (2026-11-11): `TokenContractTests.cs` (`src/scaffold/token-contract-test.js`) carga el perfil `test` REAL con
  `ServiceConfiguration.Load`, así que mide también la audiencia y el mapa `client-ids` de `security.yaml`; un método por caso con el
  id en el nombre, que es lo que lee `cs-check`. El mapa vive en `ServiceClientIds.cs` (estático: `CallerIdentity` es estático y
  `JwtCallerScope` se construye sin configuración) y lo carga el constructor de `JwtAuthenticator`. Las variantes `*-cognito` están en
  `CS_VARIANTS` (`variantStack` admite `auth`), los sabotajes en `scripts/lib/token-sabotages.js` (`cs-check --fixtures
  --only=asset-vault-cognito,mailer-one-to-one-cognito --sabotage=<id>`: el paso «cae en exactamente sus casos» en verde y la suite
  en rojo). RS-10 de keel-dotnet ya no lleva `azp` escrito a mano: con Cognito usa `client_id`, el id opaco y el mapa del perfil
  `test`, y por eso `client-translation` también lo tumba.
- keel-go (2026-11-11): sin estado global (§ 3 de PLAN-KEEL-GO.md), así que no hay un `ServiceClientIds`: el autenticador traduce el
  cliente UNA vez y lo deja en `Principal.Client` (el nombre declarado si el id está en `Settings.ClientIDs`, si no vacío), y el
  alcance y la identidad 1:1 leen ese campo; con `resolvedBy`, `client_id` crudo. El campo y `Settings.ClientIDs` solo existen con un
  proveedor de id opaco, y `SettingsFrom` lee el mapa por los nombres del diseño (el `Config` de Go no enumera claves). La prueba
  emitida es `internal/httpapi/token_contract_test.go` (paquete `httpapi`, por `callerIdentity`), con `config.Load` sobre el perfil
  `test` embebido; `go-check --token` la ejecuta con sus sujetos y sabotajes (`test/helpers/token-sabotages.js`). RS-10 y
  `caller_scope_test.go` con Cognito construyen el principal con `Client` puesto, que es lo que deja el autenticador.
- Fase 2 hecha. RS-10 de keel-nest sigue con `azp` escrito a mano (con Cognito daría rojo: lo arreglado en keel-dotnet y keel-go).
- Siguiente: **fase 3** (lo que debe cumplir el proveedor, sin red): `checkIdentitySupport` (3.1), `docs/keel/identity-contract.md`
  (3.2, y ahí la descripción de `SECURITY_AUDIENCE`), las skills (3.3) y el rechazo de keel-recover (3.4). P5 puede esperar a la fase 4.
