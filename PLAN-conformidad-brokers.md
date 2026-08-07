# Conformidad de brokers en vivo (`broker-check`)

> Plan para implementación futura. No implementado todavía.

## Contexto

El generador soporta tres brokers —Kafka, RabbitMQ, SNS/SQS sobre LocalStack— y genera
para cada uno una capa de fontanería que **habla con procesos externos por CLI**: el
compose de `infra/`, `validate-infra.sh`, `init-messaging.sh`, `reset-db.sh` y las
primitivas del arnés (`publishedMessages`, `purgeMessages`, `deliverMessage`,
`nextOffset`), que se ejecutan vía `podman exec`/`docker exec` sobre el contenedor
devtools.

**Nada de eso se ejecuta nunca en la suite.** `java-syntax.test.js` y
`generation-regressions.test.js` cubren los tres brokers comparando cadenas, y
`compile-check` verifica que el arnés compile. Entre "compila" y "el pipeline completo
con agente lo prueba" no hay ninguna red que compruebe que esos comandos son correctos
contra un broker real.

Que ese hueco duele está escrito en los propios comentarios del generador, que son un
registro de bugs descubiertos sólo en vivo y a precio de una corrida entera del pipeline:

- `messaging-provisioning.js:8` — «mientras no existió este script, la app arrancaba
  apuntando a un topic inexistente y el humo moría con `NonExistentQueue`».
- `integration-tests.js:1042` — «kcat elige modo productor cuando su stdin no es un
  terminal […] devolvería éxito con salida vacía, un falso negativo indistinguible de
  "el evento aún no llegó"».
- `integration-tests.js:1553` — «Kafka autocrea el topic vacío al primer sondeo, así que
  un topic equivocado […] pasa en verde exactamente igual que un canal sano y purgado».
- `bodyFileHelper` — el cliente de contenedores corrompe las comillas de un JSON en
  Windows y «el fallo aparece lejos de su causa».

El objetivo es una **puerta determinista y sin LLM** que levante la infraestructura con
podman y ejercite esa fontanería contra los tres brokers, con una matriz legible por
máquina para poder iterar (correr → leer fallos → corregir el generador → recorrer).

Fuera de alcance a propósito: arrancar la aplicación. `AbstractFlowIT` es
`@SpringBootTest` y el `main` recién generado no compila por diseño (build deja TODOs
para el agente), así que `HarnessSmokeIT` no es ejecutable sin un pase de agente. Lo que
sí es 100 % de `build` —y por tanto exigible en verde recién generado— es la capa de
infraestructura y sondeo, que es exactamente donde viven los fallos de arriba.

## Alcance

- **keel-spring (~85 % del trabajo)**: fuente única de los comandos de broker + runner de
  conformidad + correcciones que la corrida destape.
- **keel-core**: auditoría de los ejes del DSL de `messaging` contra lo que cada broker
  demuestra honrar, y aterrizaje de los huecos en `supported-features.js` (gate) o en
  `docs/dsl/messaging.md` (limitación documentada). Es subproducto, no objetivo.

---

## Paso 1 — Fuente única de los comandos de broker

**Nuevo**: `packages/keel-spring/src/lib/broker-probes.js`

Hoy los comandos viven como literales Java incrustados en `integration-tests.js`
(`brokerSection`, `deliverySection`, `emptyReadExpression`, líneas ~890–1200). Un runner
que construyera los suyos validaría "los brokers responden a estos comandos", no "los
comandos que el generador emite son correctos".

El módulo exporta, por broker (`kafka` | `rabbitmq` | `snssqs`), la superficie **a nivel
de exec**, en arrays de argv con huecos nombrados:

| Operación | kafka | rabbitmq | snssqs |
|---|---|---|---|
| `read` | `kcat -C -b kafka:29092 -t <topic> -o <offset> -e -q` | `curl -sf -u … -XPOST -d @<file> <api>/<dest>/get` | `aws … sqs receive-message --queue-url … --visibility-timeout 0` |
| `purge` | — (marca de offset) | `curl -sf -u … -XDELETE <api>/<dest>/contents` | `aws … sqs purge-queue` |
| `offsets` | `kcat -C … -o beginning -e -q -f %o\n` | — | — |
| `deliver` | `kcat -P -b … -t <dest> -k <key> [-H …] -l <file>` | `curl -sf … -XPOST -d @<file> <publish>` | `aws … sqs send-message --message-body file://… [--message-attributes file://…]` |
| `validate` | ya en `stack-catalog.js` (`cliValidateCmd`) | ídem | ídem |
| `emptyRead` | salida en blanco | `[]` | sin `"Messages"` |

Más las constantes de endpoint (`kafka:29092`, `http://rabbitmq:15672/api/…`,
`http://localstack:4566`, `QUEUE_URL`, región y cuenta) y los constructores de cuerpo
(`rabbitProbeBody`, `rabbitPublishBody` con base64, `sqsAttributesJson`), como funciones
JS puras.

Dos consumidores:

- `src/scaffold/integration-tests.js` renderiza el Java desde ahí (`javaArgv(...)` →
  `"kcat", "-C", "-b", …`). El comportamiento generado no cambia: los tests de cadenas
  existentes (`generation-regressions.test.js §1.1/§1.2`, `java-syntax.test.js`) son la
  red del refactor y deben seguir verdes **sin tocarlos**.
- El runner del paso 2 ejecuta los mismos argv vía `podman exec`.

Se comparte lo que es de nivel exec (flags, hosts, puertos, rutas, `-C`, `%2F`,
`--visibility-timeout 0`, `-l`) y los cuerpos de petición. **No** se comparte la
orquestación con estado que vive en Java (contabilidad de offsets `MARKS`, filtrado por
`eventType`): el runner la reimplementa en ~40 líneas de Node. Si templatizar el cuerpo
de publicación de RabbitMQ desde ambos lados sale contorsionado, la salida es dejar la
concatenación en Java y añadir un test de paridad contra el constructor JS.

Tests nuevos: `test/broker-probes.test.js` (los argv por broker, y que el Java
renderizado contiene lo que el módulo declara).

## Paso 2 — El runner

**Nuevo**: `packages/keel-spring/scripts/broker-check.js`, calcado del precedente
`scripts/compile-check.js` (opt-in, fuera de `npm test`, mismo estilo de argumentos y
códigos de salida).

```bash
node packages/keel-spring/scripts/broker-check.js [fixture] [--broker=<id>] [--keep]
npm run broker-check --workspace packages/keel-spring     # nuevo script en package.json
```

Por cada broker de la matriz:

1. `scaffoldService(...)` de la fixture a un directorio temporal.
2. Resolver runtime y frontend de compose con la **misma lógica que los scripts
   generados** (`CONTAINER_RUNTIME`, luego docker → podman; `podman compose` con
   `podman-compose` de fallback), no una propia.
3. `compose -f infra/docker-compose.yaml up -d` y esperar salud sondeando, no por
   `compose ps --format` (no es portable — ya razonado en `deploy.js`).
4. `infra/validate-infra.sh` → exige 0.
5. Con snssqs: `infra/init-messaging.sh` **dos veces** → exige 0 las dos (idempotencia).
6. Batería de escenarios (abajo), cada uno `podman exec`ando los argv del paso 1.
7. `infra/reset-db.sh` → exige que todos los destinos queden vacíos.
8. `finally`: `compose down -v` y borrado del temporal, siempre (`--keep` lo salta para
   diagnosticar a mano). Sin esto, un fallo deja contenedores y volúmenes colgados.

Salida: por stdout sólo la matriz `broker × escenario → OK/KO`, el detalle a un log; y un
`broker-check.json` con la misma matriz. Códigos: `0` todo OK, `1` hay fallos, `2` la
infraestructura no levantó (no hay veredicto). Es el mismo contrato que
`score-scenarios.sh`, y es lo que hace mecánico el bucle de autocorrección.

## Paso 3 — Los escenarios

Derivados del diseño de la fixture, no hardcodeados. Cada uno ataca una clase de fallo
concreta:

| Id | Escenario | Qué caza |
|---|---|---|
| BRK-1 | Cada canal de publicación existe y es legible | Topología no sembrada (`NonExistentQueue`) |
| BRK-2 | Publicar con marcador único → leerlo de vuelta | Topic/cola físicos equivocados; `kcat` sin `-C` |
| BRK-3 | Cuerpo con comillas dobles, acentos y `$` → vuelve byte a byte | Escapado por `podman exec` / `podman cp` |
| BRK-4 | Purgar → la lectura vacía cumple el predicado del broker | Aislamiento entre flujos; predicados de vacío |
| BRK-5 | Dos eventos de canales distintos → cada canal ve sólo el suyo | El canal lógico sobre destino único: filtro por `eventType` (Kafka), filter policy (SNS), binding (Rabbit) |
| BRK-6 | `deliverMessage` con cabeceras → llegan con discriminador y clave intactos | La mitad entrante del arnés; atributos SQS / headers AMQP / `-H` de kcat |
| BRK-7 | Entregar dos veces el mismo messageId → llegan los dos | Si el broker deduplica solo, el escenario de compensación es inejecutable |
| BRK-8 | Tras `retry.maxAttempts` recepciones sin borrar, el mensaje cae en la DLQ (snssqs) | Que `deadLetter`/`maxAttempts` del DSL se honren de verdad |
| BRK-9 | `nextOffset` sobre topic virgen no revienta (kafka) | La regresión ya documentada en `safeNextOffset` |
| BRK-10 | `reset-db.sh` deja todos los destinos vacíos | El reset por flujo |

Matriz: `catalog-extended` (publica + suscribe + `reliability: outbox` + `deadLetter`) ×
los tres brokers, y `metering-digest` (canal `external`, `envelope: wrapped`) para BRK-5
y BRK-6. Fixtures ya existentes, sin inventar ninguna.

## Paso 4 — Autoevaluación y corrección

El runner en rojo es una lista de defectos del generador. El bucle:

1. `npm run broker-check` → matriz.
2. Cada KO se arbitra: ¿defecto del generador (argv/endpoint/script/topología) o del
   propio escenario? Un KO de generador se corrige en `src/scaffold/` o
   `src/lib/broker-probes.js` y se acompaña de un test de cadenas que lo fije, para que
   la regresión se cace después sin levantar nada.
3. Recorrer hasta verde.

Cierre en keel-core: tabla eje del DSL × broker con lo que la corrida demuestra
(`envelope: keel|wrapped|none`, `external`, `reliability: outbox`, `retry.maxAttempts`,
`deadLetter`, filtrado por canal). Lo que un broker no pueda honrar se cierra por una de
dos vías, nunca en silencio: gate en `packages/keel-spring/src/lib/supported-features.js`
o limitación explícita en `packages/keel-core/assets/core/docs/dsl/messaging.md`.

## Paso 5 — Documentación

- `CLAUDE.md` § Comandos de desarrollo: `npm run broker-check`, con la nota de que exige
  podman/docker y minutos, como `compile-check`.
- `CLAUDE.md` § Dónde se añade cada cosa: fila para "nuevo broker" y para "cambio en las
  primitivas de broker del arnés" → `src/lib/broker-probes.js` + `broker-check`.
- Cabecera del propio `broker-check.js` explicando qué cubre y qué no (que no arranca la
  app, y por qué), en el tono de `compile-check.js`.

---

## Verificación

```bash
# 1. El refactor no cambia lo generado
npm test --workspace packages/keel-spring          # cadenas: regresiones §1.1/§1.2, java-syntax
npm run compile-check --workspace packages/keel-spring   # el arnés sigue compilando (JDK + red)

# 2. La conformidad en vivo
npm run broker-check --workspace packages/keel-spring                 # los tres brokers
node packages/keel-spring/scripts/broker-check.js --broker=kafka      # uno solo, para iterar

# 3. Higiene: ni contenedores ni volúmenes ni temporales tras una corrida (ni tras una fallida)
podman ps -a; podman volume ls
```

Entorno comprobado el 2026-08-06: podman 5.8.3, máquina WSL corriendo, `podman compose`
(proveedor docker-compose v2.29.7) y `podman-compose` 1.5.0 de fallback.

## Archivos

| Archivo | Cambio |
|---|---|
| `packages/keel-spring/src/lib/broker-probes.js` | **Nuevo**: argv, endpoints y cuerpos por broker |
| `packages/keel-spring/src/scaffold/integration-tests.js` | Las ramas de broker (~890–1200) renderizan desde el módulo nuevo |
| `packages/keel-spring/scripts/broker-check.js` | **Nuevo**: runner |
| `packages/keel-spring/package.json` | Script `broker-check` |
| `packages/keel-spring/test/broker-probes.test.js` | **Nuevo** |
| `packages/keel-spring/src/lib/supported-features.js` | Gates que destape el paso 4 |
| `packages/keel-core/assets/core/docs/dsl/messaging.md` | Limitaciones por broker |
| `CLAUDE.md` | Comandos y tabla |
