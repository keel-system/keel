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
    class: authz                           # basic | authz | concurrency | repeat | lifecycle | outbound-failure | outbound-target | broker-down | db-down
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
- `setup.stubs` (WireMock solo durante la sonda) y `setup.broker: down` / `setup.db: down`.
- `then_parallel` y `after`, para los pasos a la vez y la lectura del desenlace. Los pasos a la vez salen de UN curl en el contenedor de herramientas (`-Z --parallel-immediate`), porque con una petición por proceso llegan en serie y la carrera no se ve nunca. Una sonda de concurrencia con un único desenlace en todas sus repeticiones no prueba que no haya carrera: mira si el legacy serializa de verdad (bloqueo, versión, restricción) antes de decidir. Y calienta su pool de conexiones antes de la carrera (unas lecturas en `then_parallel` previas, o en `steps`): un pool que abre la conexión en el momento retrasa la segunda petición lo justo para que la primera termine, y la carrera no se ve (medido en la fixture `node-postgres`: 0/10 con el pool frío, 10/10 caliente).
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
   - un broker o una base → caídos (`broker-down`, `db-down`).

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
