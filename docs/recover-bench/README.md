# Banco de medida de `keel-recover`

Tres servicios **reales y abandonados**, fijados por commit, con una **hoja de respuestas** cada uno.
Sirve para medir `keel-recover` cuando el plan (`PLAN-KEEL-RECOVER.md`) esté terminado. La prueba
manual del incremento 1 usa los mismos tres, así que la línea base (a mano) y la medida final (con la
herramienta) son comparables fila a fila.

| Legacy | Repo y commit | Pila | Qué ejercita del plan |
|---|---|---|---|
| `realworld-node` | [gothinkster/node-express-realworld-example-app](https://github.com/gothinkster/node-express-realworld-example-app) `ba04b70c31af81ca7935096740a6e083563b3a4a` (2018-01-31, el último antes de la migración a TypeScript/Prisma) | Node (era 6/8, **sin `engines`**), Express 4.13, Mongoose 4.4, JWT, **sin lockfile** | Huella del runtime sin pistas, entorno que cambia con `NODE_ENV`, unicidad, propiedad por recurso (403), errores 422, superficie oculta (`method-override`), defectos de borrado en cascada, una carrera de unicidad |
| `sockshop-orders` | [microservices-demo/orders](https://github.com/microservices-demo/orders) `546a10c92d1ff9998c21f3849f5b95a0f14430a0` (repo archivado) | Java 8, Maven, Spring Boot 1.4.4, Spring Data REST, MongoDB | Superficie que **solo la introspección ve** (Spring Data REST), seis llamadas salientes (cuatro a URLs que llegan en el cuerpo), fallo y timeout del saliente, ausencia de idempotencia y de compensación, datos de tarjeta persistidos |
| `sockshop-shipping` | [microservices-demo/shipping](https://github.com/microservices-demo/shipping) `9c0fbfa31895dd029d44d3434de93f64cd71f87b` (repo archivado) | Java 8, Maven, Spring Boot 1.4.0, RabbitMQ | Emisión a broker, **broker caído aceptado en silencio** (best-effort explícito), cola no durable, endpoints falsos |

`orders` llama a `shipping` por HTTP: juntos son el sistema mínimo para el paso 2 (descomponer) si se
quiere ejercitarlo, aunque el banco los mide por separado.

## Lo que el banco NO cubre

Ningún legacy real pequeño cubre todo el plan. Lo que queda **sin medir** con estos tres:

| Mecanismo del plan | Por qué falta |
|---|---|
| `information_schema` (introspección relacional) | Los tres son MongoDB o sin base |
| `lifecycle` (columna de estado y transiciones) | Ninguno tiene máquina de estados |
| Roles (`security` por rol) | RealWorld solo tiene propiedad; Sock Shop, nada |
| Correo (Mailpit) | Ninguno envía correo |
| `@Scheduled`/cron → `unobserved.yaml` | Ninguno tiene trabajo programado |
| Consumo de mensajes (listener) | `queue-master` consume, pero no está en el banco |

Si al final se quiere medir alguno, se añade un cuarto legacy real con su hoja; **no** se rellena el
hueco con uno fabricado (la decisión fue «solo reales»).

## Hojas de respuestas

`<legacy>.answers.yaml`. Cada hecho es una fila con id estable:

```yaml
- id: RW-RULE-03          # <LEGACY>-<CATEGORÍA>-<n>, nunca se renumera
  category: rule          # environment | asset | surface | model | rule | error | security | effect | concurrency | defect | frontier | canary
  fact: ...               # lo que hace el legacy, en una frase
  evidence: models/Article.js:27-29
  observable: ...         # cómo lo ve una sonda (o «solo por lectura»)
  expect: ...             # dónde tiene que aparecer en lo recuperado
  status: read            # read | measured | refuted
  note: ...               # al medir: qué se vio (obligatorio en measured y refuted)
  found_by: operator      # solo en filas añadidas después: operator (a mano) | tool (keel-recover)
```

- **`status: read`**: se escribió leyendo el código el 2026-10-22. La hoja **no es la verdad**: es una
  predicción. El incremento 1 pasa cada fila a `measured` (confirmada en vivo) o a `refuted` (era falsa,
  y la fila se queda con su motivo: sirve para medir si la herramienta cae en el mismo error).
- Las filas marcadas `hipótesis` en `fact` dependen del runtime (versión del motor, del driver) y son
  las primeras candidatas a `refuted`.
- **La hoja crece y nunca encoge**: un hecho cierto que la herramienta encuentra y la hoja no tenía se
  añade con id nuevo y `found_by: tool`. Eso mide también lo que la hoja se dejó.

### Activos del repo frente a oráculos

En producción la herramienta **solo ve el repo** (`PLAN-KEEL-RECOVER.md`, supuestos y principios 7
y 8). Lo que el repo trae dentro (pruebas, specs, stubs, seeds) es **entrada**: la herramienta debe
aprovecharlo, y la hoja lo recoge en la categoría `asset`. No sirve de oráculo, porque la herramienta
lo ve.

Oráculo es lo que está **fuera** del repo y la herramienta no puede ver:

| Legacy | Activos del repo (entrada, categoría `asset`) | Oráculo externo (fuera del alcance de la herramienta) |
|---|---|---|
| `realworld-node` | `tests/api-tests.postman.json` (31 peticiones, newman) | La especificación pública de RealWorld **de enero de 2018** (la actual cambió) |
| `sockshop-orders` | `api-spec/orders.json` (Swagger 2), `api-spec/hooks.js` (Dredd, con seed), `test/json-server/server.py` (stub Flask de los servicios de usuarios y carritos) | Los repos de las dependencias: [payment](https://github.com/microservices-demo/payment) `384e33447dda5334187517dda09566c9a17fd6af` (y user y carts, sin fijar aún) |
| `sockshop-shipping` | `ITShippingController.java` | El consumidor de la cola, `microservices-demo/queue-master` (sin fijar aún) |

El oráculo externo mide **lo que la herramienta asumió** de las dependencias. Lo correcto es que lo
declare como asunción en `unobserved.yaml`, no que acierte.

### Canarios de contaminación

RealWorld y Sock Shop son públicos y famosos, así que el modelo que hay detrás del agente puede
**sabérselos de memoria**. Las filas `category: canary` son hechos ciertos del sistema que **no están
en el repo** del legacy, como el umbral de rechazo de payment. Si el diseño recuperado contiene uno, la
herramienta usó conocimiento de fuera del repo: es `inferred` aunque sea verdad, y la medida de ese
legacy queda contaminada. Por eso el legacy retenido de la medida final tiene que ser **privado** o
desconocido para el modelo.

## Protocolo de una medida

1. Clonar cada legacy al commit fijado **fuera** de este repo (por ejemplo
   `../keel-recover-lab/<legacy>/src`), en solo lectura y con su historial de git. Es **la única
   entrada**: cada legacy se mide solo, sin los repos de sus vecinos (`orders` no ve `shipping` ni
   `payment`).
2. Workspace de diseño limpio (`keel init`), sin acceso a `docs/recover-bench/` ni a la web. La red
   solo resuelve dependencias del build. **El agente evaluado no ve la hoja**: si la lee, la medida no
   vale.
3. Ejecutar el flujo entero (`/keel-recover` y sus pasos 0 a 7). Anotar el esfuerzo según avanza.
4. Guardar el `FIDELITY.md` tal como lo escribió la herramienta, **antes** de abrir la hoja.
5. Puntuar contra la hoja (abajo), incluida la calibración, y escribir la corrida en
   `docs/corridas/<fecha>-recover-<legacy>.md`.

## Métricas

### Fidelidad (los dos ejes del plan, §0)

| Métrica | Cálculo |
|---|---|
| **Recall por categoría** | hechos de la hoja (`measured`) encontrados / total, por `category`. Encontrado = aparece en el diseño, en `decisions.yaml`, en `unobserved.yaml` o en los rechazos, con procedencia `measured`, `read` o `asked` |
| **Precisión** | afirmaciones del diseño ciertas / afirmaciones del diseño. Una afirmación que no está en la hoja se comprueba contra el legacy: cierta → fila nueva en la hoja; falsa → error de la herramienta |
| **`keep` en verde** | escenarios `keep` que pasan contra el legacy / total (el plan exige el 100 %) |
| **Cobertura** | líneas y ramas del legacy bajo las sondas (JaCoCo, c8) |
| **Procedencia** | reparto `measured`/`read`/`asked`; cualquier `inferred` es suspenso |
| **Activos aprovechados** | filas `asset` usadas / total: si el repo traía un stub o un seed y la herramienta montó el suyo a ciegas, cuenta como fallo |
| **Contaminación** | filas `canary` presentes en el diseño; tiene que ser **0** (una sola invalida el recall de ese legacy) |
| **Asunciones declaradas** | contratos de dependencias que acaban en `unobserved.yaml` como asunción / dependencias del legacy |
| **Defectos detectados** | filas `category: defect` que acaban como `fix` en `decisions.yaml` / total |
| **Paridad** (paso 7) | sondas con el mismo resultado en el legacy y en el regenerado, sobre los `keep` |

### Calibración: ¿se puede creer `FIDELITY.md`?

La hoja es un instrumento **del banco**. Nunca está en el repo objetivo, y en producción no existe:
allí lo único que hay para saber si el diseño es fiel es la autoevaluación de la herramienta
(`FIDELITY.md`: `keep` en verde, cobertura, procedencias, `unobserved.yaml`). El banco mide si esa
autoevaluación dice la verdad comparándola con la hoja:

| Métrica | Cálculo |
|---|---|
| **Huecos confesados** | hechos de la hoja que faltan en el diseño Y están declarados en `unobserved.yaml` o en los rechazos / hechos de la hoja que faltan en el diseño. Lo que falta sin declararse es lo peligroso: el usuario de producción no tiene forma de verlo |
| **Cobertura frente a recall** | la cobertura que reporta `FIDELITY.md` frente al recall real contra la hoja. Si la cobertura es alta y el recall bajo, la cobertura no es buen indicador para ese tipo de legacy |
| **Verde engañoso** | escenarios `keep` en verde cuya afirmación contradice una fila `measured` de la hoja (el escenario pasa porque afirma poco o afirma mal) |

Una herramienta con recall moderado y huecos bien confesados es usable en producción. Una con recall
alto y huecos silenciosos no lo es, porque el día que falle nadie se enterará.

### Esfuerzo

| Métrica | Fuente |
|---|---|
| Intentos de build (0d) y de arranque (0e) | `environment.yaml` |
| Adaptaciones del entorno, con motivo | `environment.yaml` |
| Rondas de sondas hasta estancarse | `probes/round-N.yaml` |
| Preguntas al humano | número de procedencias `asked` + preguntas sin respuesta |
| Tiempo de reloj y tokens del agente | registro de la sesión |
| Hechos de `environment` de la hoja resueltos sin preguntar | recall de la categoría `environment` |

## Riesgo de sobreajuste

Quien construya `keel-recover` (incrementos 2 a 7) **ve** este banco, y la herramienta puede acabar
ajustada a tres legacys concretos. Contramedida: al terminar, una medida extra sobre un legacy
**retenido** que elige el humano sin decírselo al agente, sin hoja de respuestas. Ahí solo valen las
métricas que no la necesitan: `keep` en verde, cobertura, procedencia, paridad y esfuerzo. Si esas
caen mucho respecto a los tres del banco, la herramienta está sobreajustada.

## Conservación

Los tres repos están archivados o abandonados y pueden desaparecer. Antes del incremento 1 conviene
copiarlos (fork o espejo) en un sitio propio. La hoja cita `archivo:línea` contra el commit fijado,
que es lo que sostiene la evidencia.
