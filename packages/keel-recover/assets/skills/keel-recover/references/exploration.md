# La exploración del paso 1: escribir rondas de sondas

Lo lee el agente `keel-recover-explorer` (y quien escriba una ronda a mano). Una **ronda** es
`legacy/<servicio>/probes/round-N.yaml` (schema `probes.schema.json` de keel-recover), y la ejecuta
`keel-recover probe legacy/<servicio>/probes/round-N.yaml`.

## Qué graba cada sonda

Cada sonda parte del **snapshot** de `verify`, ejecuta sus pasos y graba en `recordings/round-N/<id>.json`:
- las respuestas;
- el diff de la base;
- las llamadas al proveedor de prueba (WireMock);
- lo publicado en el broker;
- el correo.

Un canario por canal comprueba que cada efecto se está capturando. Una ronda con un canal en rojo (`PRB-*`) no es
evidencia en ese canal. Al final, la cobertura **de la ronda sola** (`round.json`) y la serie acumulada
(`recordings/coverage.json`).

## La forma

```yaml
# Ronda 2: a por lo que la 1 dejó sin cubrir (validación, permisos de otro usuario, borrado).
x-steps:                                   # claves x-* libres: anclas de pasos que se repiten
  regA: &regA { name: registro-A, request: { method: POST, path: /api/users, body: { user: { username: alice, email: a@x.io, password: pw } } }, capture: { tA: user.token } }
vars:
  ghost: "<un token con un id que no existe>"
probes:
  - id: R2-001                             # estable: lo citan provenance.yaml y los escenarios
    why: registro duplicado                # la pregunta que hace la sonda
    steps: [ *regA, *regA ]
  - id: R2-002
    class: authz                           # basic | authz | concurrency | repeat | lifecycle | collation | overflow | outbound-failure | outbound-target | broker-down | db-down
    why: un usuario borra el artículo de otro
    steps:
      - *regA
      - { request: { method: POST, path: /api/articles, headers: { Authorization: "Token {{tA}}" }, body: { article: { title: t } } }, capture: { slug: article.slug } }
      - { request: { method: DELETE, path: "/api/articles/{{slug}}", headers: { Authorization: "Token {{ghost}}" } } }
  - id: R2-003
    class: concurrency
    why: dos altas a la vez con el mismo username
    repeat: 10                             # una distribución, no un desenlace
    outcome: status
    parallel: true
    steps: [ *regA, *regA ]
```

Otras piezas del schema:
- **La sesión por cookie.** Cada sonda lleva su almacén de cookies, como un navegador: lo que fija el login (la
  `SESSION` de Spring Session, el `connect.sid` de express-session) viaja en los pasos siguientes sin escribir nada. Una
  sonda no hereda la sesión de otra, ni una repetición la de la anterior. Dos personas en la misma sonda son dos sesiones
  con nombre (`session: gestor` en sus pasos, `session: usuario` en los otros); `session: none` manda el paso sin
  cookies (lo mismo sin sesión) y no guarda las que reciba. Si un legacy da 401 en todo lo que hay detrás del login,
  mira antes si la sonda hizo login en la misma sesión que el paso.

  ```yaml
  - id: R1-030
    why: el gestor da de alta un recinto y un usuario general no puede
    steps:
      - { session: gestor, request: { method: POST, path: /login, body: { userId: admin1, password: "Pw1!" } } }
      - { session: usuario, request: { method: POST, path: /login, body: { userId: user1, password: "Pw1!" } } }
      - { session: gestor, request: { method: POST, path: /venues, body: { name: Sala A } } }
      - { session: usuario, request: { method: POST, path: /venues, body: { name: Sala B } } }
      - { session: none, request: { method: GET, path: /my-page } }
  ```
- `capture` lee el cuerpo (ruta con puntos), una cookie (`cookie:SESSION`) o una cabecera (`header:Location`).
- `setup.stubs` (WireMock solo durante la sonda) y `setup.broker: down` / `setup.db: down`.
- `then_parallel` y `after`, para los pasos a la vez y la lectura del desenlace. Los pasos a la vez salen de UN curl en el contenedor de herramientas (`-Z --parallel-immediate`), porque con una petición por proceso llegan en serie y la carrera no se ve nunca. Una sonda de concurrencia con un único desenlace en todas sus repeticiones no prueba que no haya carrera: mira si el legacy serializa de verdad (bloqueo, versión, restricción) antes de decidir. Y calienta su pool de conexiones antes de la carrera (unas lecturas en `then_parallel` previas, o en `steps`): un pool que abre la conexión en el momento retrasa la segunda petición lo justo para que la primera termine, y la carrera no se ve (medido en la fixture `node-postgres`: 0/10 con el pool frío, 10/10 caliente).
- Una sonda con `repeat` graba `outcomes`: cuántas repeticiones dieron cada desenlace. La clave lleva los status y la huella de lo que quedó en la base (`|db=…`, sin las secuencias), así que una carrera que solo se ve en la base (dos pedidos del mismo carrito) sale como desenlaces distintos con el mismo status. `outcomeEffects` trae el diff de la base de cada desenlace: léelo antes de describir lo que pasa, porque `effects` es solo el de la primera repetición.
- `publish`: un evento entrante por la API de gestión del broker.
- `settleMs`.

## A qué ir, ronda a ronda

1. **Ronda 0**: lo que el repo ya trae. Una colección Postman o las pruebas de API se traducen tal cual; son
   afirmaciones de sus autores, y la grabación es lo que las convierte en `measured`.
2. **Las rutas**: cada ruta de `surface.yaml` al menos una vez por su camino feliz.
3. **Lo no cubierto**: `round.json` dice qué archivos y líneas no ejecutó la ronda anterior. Detrás suele haber:
   - una validación (`422`/`400` con un campo malo);
   - una rama de error (un recurso que no existe, un `404`);
   - un permiso (el recurso de otro usuario, sin token, con un token de alguien que no existe);
   - el borrado y lo que deja detrás (el diff de la base).
4. **Las sondas de clase** que la superficie sugiere:
   - una columna de estado → sus transiciones (`lifecycle`);
   - un índice único → el duplicado y la carrera (`concurrency`);
   - una operación que se reintenta → su repetición (`repeat`);
   - una llamada saliente → su fallo y su destino (`outbound-*`);
   - un broker o una base → caídos (`broker-down`, `db-down`);
   - en MySQL, una UNIQUE sobre texto con collation `_ci` → el mismo valor con otra caja (`collation`);
   - en MySQL, una tabla que se escribe con columnas de texto de longitud fija → un texto más largo que la más corta
     (`overflow`).

   `keel-recover status` deriva de `surface.yaml` y de las grabaciones las que faltan (`concurrency:<tabla>`,
   `lifecycle:<tabla>.<columna>`, `collation:<tabla>`, `overflow:<tabla>`) y no cierra la exploración hasta que cada una
   esté grabada o descartada con su motivo en `exploration.yaml` (`waived`).

### Las dos sondas de clase de MySQL

Lo que graban es comportamiento del MOTOR que la app hereda sin escribirlo, y que el regenerado no tendrá si el diseño no
lo dice (`evidence-to-dsl.md`, § MySQL).

- **`collation`: el duplicado con otra caja.** Un alta, y otra con el mismo valor en otra caja; y la lectura por esa
  clave con la otra caja. Con `_ci`, el segundo alta choca con la UNIQUE (un 409 o lo que haga la app con
  `ER_DUP_ENTRY`) y la lectura encuentra la fila: «A» es «a». Cuenta como hecha la sonda de clase `collation` que
  inserta en la tabla y manda dos textos que solo difieren en la caja.

  ```yaml
  - id: R1-020
    class: collation
    why: el mismo sku con otra caja (sku es UNIQUE sobre utf8mb4_0900_ai_ci)
    steps:
      - { request: { method: POST, path: /items, body: { sku: a, quantity: 2 } } }
      - { request: { method: POST, path: /items, body: { sku: A, quantity: 1 } } }
      - { request: { method: GET, path: /items/A } }
  ```

- **`overflow`: el texto más largo que la columna.** Un alta con un texto que no cabe, y la lectura de lo que quedó. Sin
  `STRICT_TRANS_TABLES` en la sesión de la app, MySQL lo trunca y la escritura sale bien: la respuesta puede devolver el
  texto entero, la base guarda el corto y la lectura con el texto enviado no lo encuentra (medido en la fixture
  `node-mysql`: 201 y 404). Con modo estricto, el motor lo rechaza (un 500, o lo que haga la app con el error). El
  `sqlMode` de `surface.yaml` es el del servidor y no basta: el driver puede fijar otro, y por eso hace falta la
  sonda. Cuenta como hecha la sonda de clase `overflow` que manda un texto más largo que la columna de texto más corta
  de la tabla.

  ```yaml
  - id: R1-021
    class: overflow
    why: un sku de 70 caracteres en varchar(64)
    steps:
      - { request: { method: POST, path: /items, body: { sku: "oooooo-012345678901234567890123456789012345678901234567890123456789abc", quantity: 1 } } }
      - { request: { method: GET, path: "/items/oooooo-012345678901234567890123456789012345678901234567890123456789abc" } }
  ```

## Cuándo parar

La decisión es del humano, en el primer punto de parada de `/keel-recover-run`. Lo que el explorador le da para decidir:
- **la serie de cobertura**: una ronda que sube menos de ~2 puntos es la señal de estancamiento;
- **lo que queda sin cubrir**: código muerto, ramas que solo dispara un fallo interno;
- **lo que no se puede disparar desde fuera**, en `unobserved.yaml`.

Lo no observado no se inventa: el diseño lo deja fuera o lo pregunta.

## Lo que se ha medido

Sobre RealWorld (Node + MongoDB), tres rondas llegaron al 97,7 % de cobertura:
- la ronda 0 fue la colección Postman del repo (88 %);
- la 1 fue a por la validación, los permisos de otro usuario y el borrado;
- la 2, a por lo que quedaba detrás de cada ruta.

Las rondas útiles tuvieron entre 20 y 40 sondas.
