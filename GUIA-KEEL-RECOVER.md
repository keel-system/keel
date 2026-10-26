# Guía de uso de keel-recover

Cómo sacar un diseño Keel **fiel** de un servicio que ya existe, regenerarlo con keel-spring, keel-nest o keel-dotnet y
demostrar que el servicio nuevo hace lo mismo que el viejo. Para el porqué de cada paso, `PLAN-KEEL-RECOVER.md`; para
la referencia de los comandos, `packages/keel-recover/README.md`. El ejemplo completo y real es el laboratorio
`../keel-recover-lab` (legacy `realworld-node`, diseño `conduit`).

## 1. Antes de empezar: ¿encaja tu legacy?

La herramienta solo hace lo que se ha medido. Hoy:

| Pieza | Soportado | Si no encaja |
|---|---|---|
| Lenguaje y build (`fingerprint`) | Java con Maven o Gradle, Node | sin adaptador: no hay huella |
| Rutas del legacy (`introspect`) | Express, Spring 4 (por su log), Spring con actuator | la superficie hay que escribirla a mano |
| Base de datos (snapshot y rastro de escrituras) | MongoDB, PostgreSQL (desde 9.4: `pg_dump`/`pg_restore`, secuencias incluidas) y MySQL (desde 8.0: `mysqldump`, AUTO_INCREMENT incluido; adaptador medido contra `show-ticketing`, todavía sin fixture ni redes en vivo: `PLAN-KEEL-RECOVER-MYSQL.md`, M2) | otro motor, `sandbox.yaml` lo rechaza |
| Broker | **solo RabbitMQ** | `sandbox.yaml` lo rechaza |
| Cobertura | nyc y V8 (medidas en vivo); JaCoCo se vuelca pero el paso 1 no lo ha ejercitado | |
| Probado de punta a punta | **un legacy**: RealWorld (Node + MongoDB) | |

Y las fronteras de keel que ya se han visto en el banco: un legacy que llama a URLs calculadas en tiempo de ejecución, o
que es mensajería sin base de datos, no se puede regenerar (lo rechazan los tres generadores).

**La regla de entrada**: la herramienta solo ve el repo del legacy, con su historial de git. Nada de dumps, documentación
externa ni los repos de sus dependencias. El repo **nunca se modifica**: todo lo que se escribe va al workspace de diseño.

**Lo que necesitas**: Node 18+, podman (o docker) en marcha, Git Bash si estás en Windows (con
`export MSYS_NO_PATHCONV=1`), y un workspace de diseño (`keel init`).

## 2. Instalación

Todavía no está publicado en npm. Desde este monorepo:

```bash
npm install
npm link --workspace packages/keel-core      # keel
npm link --workspace packages/keel-recover   # keel-recover
npm link --workspace packages/keel-dotnet    # o keel-spring / keel-nest: el generador que vayas a usar
```

## 3. El uso normal: dos llamadas

Desde la raíz del workspace de diseño:

```bash
keel-recover init ../repos/mi-legacy --name mi-servicio     # una vez: prepara legacy/mi-servicio/ y siembra las skills
```

y en tu agente (Claude Code u opencode):

```
/keel-recover-run legacy/mi-servicio
```

`/keel-recover-run` hace el recorrido entero. Antes de cada paso mira en disco en qué punto está
(`keel-recover status legacy/mi-servicio`), así que puedes cortarlo cuando quieras y **volver a lanzar el mismo
comando**: sigue donde se quedó. El trabajo lo hacen tres subagentes que `init` siembra:
- `keel-recover-sandbox` monta el legacy;
- `keel-recover-explorer` escribe y ejecuta las rondas de sondas;
- `keel-recover-designer` escribe el diseño.

Lo determinista lo hacen los comandos de la sección 4.

### Cuándo te pregunta

Solo en tres momentos, con todo agrupado y una recomendación en cada pregunta:

1. **Al terminar la exploración**: la cobertura ronda a ronda, lo que queda sin observar y si seguir o cerrar.
2. **Al terminar el diseño**, todo lo que es tuyo de una vez:
   - cada `fix` (corregir algo que el legacy hace);
   - cada elemento que el legacy no fija (`asked`);
   - cada decisión estructural que el legacy no tomaba (`omitted`).

   Los subagentes no pueden preguntarte: lo dejan en `legacy/mi-servicio/questions.yaml` y el orquestador te lo
   pregunta.
3. **Antes de generar**:
   - si cerrar el diseño ahora (revisión, huecos, careo, `DESIGN.md`) o generar sin cerrar;
   - con qué generador y qué stack.

### Dónde se para

En la **generación**: el pipeline `/keel-generate-<tech>` lanza sus propios subagentes y no se puede anidar. El
orquestador deja hecho el `build` y te dice qué lanzar en el proyecto:

```
cd services/mi-servicio-dotnet
dotnet restore              # solo keel-dotnet
/keel-generate-dotnet       # en una sesión nueva, dentro del proyecto
```

Cuando termine, vuelve al workspace y lanza otra vez `/keel-recover-run legacy/mi-servicio`. Hace la paridad:
1. levanta el `deploy/`;
2. escribe el `target.yaml`;
3. da de alta a las personas de los escenarios en su Keycloak;
4. compara con el legacy;
5. baja el `deploy/`;
6. te deja el resumen.

```
init → sandbox → observe → explore ⏸ → design ⏸ → characterize → close ⏸ → build → generate ✋ → parity → done
                                   (⏸ te pregunta)                              (✋ lo lanzas tú)
```

## 4. El recorrido paso a paso (lo que hace el orquestador por dentro)

Si prefieres llevarlo a mano, o quieres saber qué está haciendo, estos son los pasos. Todo se ejecuta **desde la raíz
del workspace de diseño**. `<repo>` es la ruta al repo del legacy; `<svc>`, el nombre
del servicio en kebab-case.

| Paso | Qué haces | Qué queda |
|---|---|---|
| 0a-0b | `keel-recover init <repo> --name <svc>` | `legacy/<svc>/` con `runtime.yaml`, `environment.yaml` y las skills |
| 0c-0e | `/keel-recover-sandbox` (agente) | `legacy/<svc>/sandbox/`: el legacy corriendo en contenedores con su cadena antigua |
| 0f | `keel-recover verify legacy/<svc>/sandbox` | `verify.json` y el **snapshot** de la base |
| 1 | `keel-recover introspect …` y rondas de `keel-recover probe …` | `surface.yaml`, `recordings/` y la cobertura |
| 3-4 | `/keel-recover` (agente) | `specs/<svc>/` (capas, `provenance.yaml`, escenarios marcados) y `legacy/<svc>/contract-map.yaml` |
| 5 | `keel-recover characterize legacy/<svc>` | el sello `specs/<svc>/characterized.yaml` y `legacy/<svc>/FIDELITY.md` |
| 6 | el cierre normal de keel (`/keel-validate`, huecos, careo, `/keel-docs`) | `keel validate --ready` en verde |
| 7 | generar, levantar el `deploy/`, `keel-recover target …` y `keel-recover parity …` | `legacy/<svc>/PARITY-<destino>.md` |

`keel-recover status legacy/<svc>` dice en cualquier momento en qué paso estás y qué toca.

### Paso 0: el legacy en un sandbox

```bash
keel-recover init ../repos/mi-legacy --name mi-servicio
```

`init` crea `legacy/mi-servicio/` (con `legacy.yaml`, que dice dónde está el repo), corre la huella del runtime (0a) y
el inventario del entorno (0b), y siembra las skills `/keel-recover-sandbox` y `/keel-recover`. Si quieres ver la huella
sin escribir nada: `keel-recover fingerprint <repo>` y `keel-recover env-deps <repo>`.

Después, en tu agente:

```
/keel-recover-sandbox
```

El agente arma el `Dockerfile`, el `compose.yaml` y el `sandbox.yaml` con la versión de lenguaje y de motor que el
legacy necesita: lo que el repo declaraba (CI, Dockerfiles), no lo que tengas instalado. Lo que decide al montarlo
(imagen, adaptaciones) lo escribe él, no la herramienta. Cuando termina, el juez:

```bash
keel-recover verify legacy/mi-servicio/sandbox
```

Comprueba, con un id `VER-*` por criterio:
- la red interna y sin salida a internet;
- imágenes fijadas por digest;
- el motor que usaba la CI;
- una lectura y una escritura reales con rastro en la base;
- la cobertura grabando.

En verde **toma el snapshot de la base**, desde el que parte cada sonda y cada escenario.

> El snapshot vive dentro del contenedor de la base. Si bajas y vuelves a subir el sandbox (`podman compose … down`),
> **vuelve a pasar `verify`** antes de `probe` o `characterize`; los dos lo comprueban al empezar y lo dicen.

### Paso 1: observar el legacy

```bash
keel-recover introspect legacy/mi-servicio/sandbox
```

Pregunta al runtime: rutas del framework, colecciones con sus índices y topología del broker. Lo funde en `surface.yaml`.

Luego, **rondas de sondas**. Una ronda es un `legacy/mi-servicio/probes/round-N.yaml` con peticiones agrupadas y el
porqué de cada una:

```yaml
probes:
  - id: R1-001
    why: registro duplicado
    steps:
      - { request: { method: POST, path: /api/users, body: { user: { username: alice, email: a@x.io, password: pw } } } }
      - { request: { method: POST, path: /api/users, body: { user: { username: alice, email: a@x.io, password: pw } } } }
```

```bash
keel-recover probe legacy/mi-servicio/probes/round-1.yaml
```

Cada sonda parte del snapshot y graba en `recordings/round-1/` la respuesta y sus **efectos**:
- el diff de la base;
- las llamadas a WireMock;
- lo publicado en el broker;
- el correo.

Un canario por canal prueba que cada efecto se está capturando, y uno que no llega sale en rojo con su `PRB-*`. Al
final vuelca la cobertura **de esa ronda sola**.

El bucle es: miras la cobertura, escribes la ronda siguiente contra lo que quedó sin cubrir, la ejecutas. Pararlo es una
decisión tuya: lo que no se observe va a `unobserved.yaml`, no se inventa. Las rondas
las escribe el agente `keel-recover-explorer` (una por llamada, desde la superficie y lo que quedó sin cubrir), o tú a
mano: el formato y a qué ir en cada ronda están en la referencia `exploration.md` de la skill `/keel-recover`. Si el
repo trae una colección Postman, esa es la ronda 0.

### Pasos 3 y 4: el diseño desde las grabaciones

```
/keel-recover
```

El agente escribe `specs/mi-servicio/` capa a capa **desde las grabaciones**, y deja tres cosas que son las que hacen
que el diseño sea fiel:

- **`provenance.yaml`**: la procedencia de **cada** elemento del diseño, con su id del inventario. Niveles:
  - `measured`: una grabación;
  - `read`: el código, con `archivo:línea`;
  - `asked`: lo decidiste tú.

  `inferred` no se admite: un contrato inventado es un diseño incorrecto que parece completo.
- **Los escenarios marcados** en `validation-scenarios.md`, cada flujo con su marca:

  | Marca | Significado |
  |---|---|
  | `keep` | el nuevo hace lo mismo que el legacy |
  | `fix` | corrige a propósito un defecto del legacy, con su `fix-*` en `provenance.yaml → fixes` |
  | `frontier` | el legacy lo hace y el DSL no lo puede decir |
  | `new` | solo existe en el servicio nuevo |

  Los `keep`, `fix` y `frontier` llevan dentro su bloque ```` ```keel-flow ```` con los pasos ejecutables.
- **`legacy/mi-servicio/contract-map.yaml`**: cómo se pide cada operación del diseño al legacy (ruta, envoltorios,
  estados) y, para el paso 7, al servicio nuevo.

**Lo que decides tú** (el agente te lo pregunta, nunca lo decide él):
- cada `fix`;
- cada decisión `asked`;
- las decisiones estructurales que el legacy no tomaba (`origin: omitted`: idempotencia, caché…).

Un `fix` que ningún flujo HTTP puede demostrar declara `noFlow`, con su porqué y su otra prueba:
- un defecto que solo se ve en la base;
- uno que necesita más datos de los que carga un escenario;
- uno de arquitectura.

### Paso 5: ejecutar los escenarios contra el legacy

```bash
keel-recover characterize legacy/mi-servicio
```

Ejecuta cada `keep`, `fix` y `frontier` contra el legacy, partiendo del snapshot:
- un `keep` tiene que pasar tal cual;
- un `fix` tiene que mostrar el defecto que dice corregir.

Escribe el sello `characterized.yaml`, por flujo y con el mismo sello que el careo: tocar un flujo después lo deja sin
ejecutar. Escribe también `FIDELITY.md`, el resumen para leer:
- keep/fix/frontier en verde;
- la cobertura;
- la procedencia por nivel;
- el backlog de `fix`;
- la frontera;
- lo no observado.

**Un `keep` en rojo se corrige en el diseño, no en el escenario**: el escenario dice lo que el legacy hace.

```bash
keel validate specs/mi-servicio --ready
```

Los dos criterios propios de un diseño recuperado:
- **`provenance`**: cada elemento con fila, ninguno `inferred`, cada `fix` con su flujo o su `noFlow`, cada decisión
  estructural con su `origin`.
- **`characterized`**: el sello al día y en verde.

### Paso 6: cerrar el diseño

Es el cierre de cualquier diseño Keel: `/keel-validate` (revisión semántica), el análisis de huecos, el careo de flujos
(`keel-flow-review`) y `DESIGN.md`. Mientras falte, `--ready` sigue en rojo y la generación pide `--accept-unready`
(queda estampado en el proyecto generado).

En un diseño recuperado, el análisis de huecos ya se hizo una vez al escribir las capas (el pre-barrido del paso 4b de
`/keel-recover`), así que el de cierre debería salir casi vacío. Y el orden importa: primero la revisión y el barrido,
que pueden cambiar el YAML, con sus decisiones en una sola tanda; el careo, al final y con el YAML quieto, porque cerrar
un hallazgo cambiando el diseño lo caduca entero.

### Paso 7: regenerar y medir la paridad

1. Generar, como siempre:

   ```bash
   keel-dotnet build specs/mi-servicio          # o keel-spring / keel-nest
   cd services/mi-servicio-dotnet
   /keel-generate-dotnet
   ```

2. Levantar el servicio regenerado con su `deploy/`: `bash services/mi-servicio-dotnet/deploy/up.sh`.
3. Escribir su `target.yaml` desde ese `deploy/` en marcha:

   ```bash
   keel-recover target services/mi-servicio-dotnet -o legacy/mi-servicio/target-mi-servicio-dotnet.yaml
   ```

   Pregunta al runtime los contenedores reales (por sus etiquetas de compose, que valen para podman y docker) y saca del
   `deploy/` la URL interna, la base y el proveedor de identidad.
4. Medir:

   ```bash
   keel-recover parity legacy/mi-servicio --target legacy/mi-servicio/target-mi-servicio-dotnet.yaml
   ```

   Antes de empezar da de alta en el Keycloak del deploy a cada persona de los escenarios (`alice`, `bob`…): el deploy
   no trae usuarios, porque el diseño identifica al llamante por su `sub`.

`parity` ejecuta los mismos flujos contra el servicio nuevo. Del legacy no vuelve a ejecutar nada: compara con lo que
grabó `characterize`, y por eso exige su sello al día. Compara **todos** los datos de cada paso. Cada diferencia sale
de una de tres formas:
- **equivalente**: un campo volátil o ausente frente a `null`;
- **declarada**: está en `declaredDifferences` del mapa, con su `fix` o su frontera;
- **sin declarar**: un defecto que ningún escenario afirmaba.

Una sola sin declarar pone el veredicto en rojo. El resultado queda en `legacy/mi-servicio/PARITY-<destino>.md`.

## 5. Errores frecuentes

| Síntoma | Causa | Qué hacer |
|---|---|---|
| «no hay snapshot en …» al empezar `characterize` o `probe` | se perdió el snapshot al recrear el sandbox | `keel-recover verify legacy/<svc>/sandbox --no-up` |
| `characterized` en rojo tras tocar un escenario | el sello es por flujo | volver a ejecutar `characterize` |
| `provenance` en rojo con «de otro diseño» | filas con nombres libres en vez de ids del inventario | copiar los ids que imprime `--ready` |
| un flujo `fix` que cita un `fix` con `noFlow` | contradicción | quitar el `noFlow` o el flujo |
| `keel-recover target` dice «no hay contenedor del servicio 'app'» | el `deploy/` no está en marcha | `bash services/<svc>-<tech>/deploy/up.sh` |
| `parity` dice que no hay nada que comparar | el regenerado no responde o los tokens fallan | `keel-recover target` otra vez, con el `deploy/` arriba |
| `/keel-recover-run` vuelve a preguntar algo ya contestado | la respuesta no se aplicó al diseño | la entrada de `questions.yaml` sigue sin `applied: true`: relánzalo, el diseñador la aplica |
| en Windows, rutas `/c/...` rotas dentro de `podman exec` | Git Bash traduce rutas | `export MSYS_NO_PATHCONV=1` |

## 6. Dónde mirar

- Diseño y estado del plan: `PLAN-KEEL-RECOVER.md`.
- Referencia de comandos, schemas y redes de prueba: `packages/keel-recover/README.md`.
- Corridas medidas, con sus tablas: `docs/recover-bench/corridas/`. La última, que hace el recorrido entero, es
  `2026-10-22-inc8-propiedad-y-v011.md`.
- El ejemplo real, de punta a punta: `../keel-recover-lab/`:
  - `realworld-node/`: lo de `legacy/<svc>/`;
  - `workspace/specs/conduit/`: el diseño;
  - `workspace/services/conduit-dotnet/`: el regenerado.
