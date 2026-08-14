# Informe de corrida — stock-reservation con RabbitMQ (eje C)

Corrida completa de `/keel-generate-spring` sobre `specs/stock-reservation` v1.0.0 en
`corrida-stock-rabbitmq/`, con **PostgreSQL + RabbitMQ**. 11-ago-2026. Es la primera vez que
los escenarios `FL-*` se ejecutan contra un broker que no es Kafka: `compile-check` cubre el
eje estático y `broker-check` el de fontanería, pero ninguno de los dos arranca la
aplicación.

El broker se fijó escribiendo `keel-stack.json` **antes** de construir, que es la fuente de
esa elección: un build limpio de RabbitMQ en vez de un build de Kafka reescrito con
`--force`, que dejaría huérfanos del broker anterior.

**Resultado**: la suite en verde. Un solo `culprit: code` (`FL-RES-001-C`, la carrera de la
clave resuelta por la unicidad del pedido en vez de por el registro — exactamente el defecto
que ese escenario existe para cazar) resuelto en un ciclo, y dos `culprit: test` por el
nombre de la tabla en el helper de envejecimiento, que es comportamiento esperado del
pipeline: el agente de traducción no puede leer `src/main/java` en la fase 1.

---

## Defectos del generador (corregidos y congelados)

### 1. `deadLetterMessages` no traducía «cola viva y vacía» a cadena vacía

Tres escenarios de dos clases distintas (`FL-CMP-001-B`, `FL-CMP-001-C`, `FL-CNT-001-B`)
fallaron con `Expecting blank but was: "[]"`. El helper delegaba en `publishedMessages` sin
traducir, y **«vacío» no es cadena vacía en ningún broker salvo Kafka**: la API de RabbitMQ
devuelve el literal `"[]"` y la CLI de SQS un JSON sin la clave `"Messages"`. El javadoc
prometía cadena vacía y la aserción que de verdad importa es la negativa
(`deadLetterMessages(...).isBlank()`, «se absorbió el duplicado sin acabar en el descarte»),
así que el caso en el que el servicio **se comporta bien** era justo el que fallaba. El mismo
síntoma en tres clases independientes es la firma de un defecto de arnés, no de tres
aserciones mal derivadas.

**Corrección** (`src/scaffold/integration-tests.js`): la rama no-Kafka traduce con
`emptyReadJava(broker, …)` — el predicado de vacío que ya vive en `broker-probes.js` y del
que se renderiza el resto del arnés. No una comparación escrita a mano: así el que se olvida
no es un broker, es ninguno. **El fix cubre también SNS/SQS**, donde el mismo defecto estaba
vivo y aún no lo había pagado nadie. `publishedMessages` se deja intacto: sigue devolviendo
el crudo del broker, que es de lo que depende `HarnessSmokeIT`.

### 2. El gate `dedupe` exigía un listener por evento, que en RabbitMQ es incorrecto

El gate buscaba `<Evento>Listener.java`, un archivo por suscripción. Cuando varias
suscripciones comparten destino —`topicDefault` sale de la FUENTE, así que las tres de
`inventory` caen en la misma cola—, varios `@RabbitListener` sobre esa cola son consumidores
**compitiendo**: el broker reparte, cada mensaje llega a uno solo y los demás no lo ven
nunca. La implementación correcta es un listener único que enruta por `eventType`, y el gate
la marcaba KO con el guard y los órdenes bien puestos. El camino de menor resistencia para
apagar ese hallazgo es partir el listener en tres, o sea **romper el consumo para que el
script se calle**.

**Corrección**, en dos sitios porque el defecto estaba en los dos:

- `src/scaffold/idempotency-check.js`: con RabbitMQ, las suscripciones que comparten destino
  producen **una** comprobación por cola en vez de una por evento. Exige el guard y los
  órdenes que el diseño pide (`record` si alguna tiene guarda de dominio, `tryRecord` si
  alguna no la tiene) y **deja de prohibir el contrario**: en un archivo con las dos ramas, el
  cruce no es atribuible a un evento por presencia. Se pierde precisión y se dice en el `why`.
  El `unit` del script gana un localizador por **contenido** para cuando el nombre canónico no
  existe. Con Kafka y con SNS/SQS no cambia nada: allí cada listener tiene su grupo o su cola
  propia y un archivo por suscripción sigue siendo lo correcto.
- `assets/generators/spring/skills/keel-spring-rabbitmq/SKILL.md`: la sección se llamaba
  «Listener (uno por suscripción)» y ahora es «uno por COLA, no uno por suscripción», con el
  porqué (consumidores compitiendo, mensajes que se pierden en silencio) y la nota de que esto
  **no se traslada** a los otros dos brokers. El agente tuvo que deducirlo contra la
  instrucción que estaba leyendo.

### 3. El umbral del barrido: mi propia corrección de la fase 4, mal puesta

En la cosecha documental moví la exigencia de `@Value` del handler de `application` —donde la
constitución prohíbe importar Spring— al **mismo archivo que el reclamo**. Esta corrida
demuestra que esa segunda ubicación es igual de falsa: el reparto que el propio scaffold
impone separa necesariamente el puerto (sin framework), su adaptador (`@Value`) y el
repositorio Spring Data (`SKIP LOCKED`). Exigir las tres piezas en un archivo contradice la
convención que el generador manda seguir. Dos suposiciones seguidas sobre **dónde** vive el
umbral, y las dos equivocadas.

**Corrección**: el umbral pasa a ser una comprobación **propia**, sin decir en qué archivo
tiene que estar. Lo único afirmable sin suponer arquitectura es que en algún sitio esté
parametrizado (`@Value`/`@ConfigurationProperties`) **y** que ese sitio hable de la espera
(`stale`, `awaiting`, `threshold`, `reconcil`, `umbral`) — un `@Value` suelto en cualquier
configuración no es el umbral de este barrido. El reclamo mantiene su pareja «patrón + cota
en el mismo archivo», que sí es una consulta y su lote.

**Verificación de las tres**: `npm test` 398 en verde (5 casos nuevos) · `compile-check` sobre
`stock-reservation` con los tres brokers · y el gate corregido ejecutado contra el **árbol
real que escribió el agente**, donde las cinco familias salen OK y las dos falsas alarmas
desaparecen sin que las estrictas dejen de mirar (los tests fuerzan cada una a volver:
quitando `tryRecord`, quemando el umbral, o pidiendo Kafka).

---

## Huecos de diseño

Uno de los dos aparece **también** en la corrida documental de `asset-vault`, con otro diseño
y otro modelo de persistencia. Dos veces el mismo hueco no es un despiste del diseñador:

- **El desenlace «misma clave, cuerpo distinto» no se puede nombrar en el DSL.**
  `use-cases.<op>.idempotency` declara el mecanismo pero no da forma de declarar el `code` de
  ese conflicto, así que el generador improvisa: `IDEMPOTENCY_KEY_IN_PROGRESS` reutilizado
  aquí, `IDEMPOTENCY_KEY_REUSED` inventado en `asset-vault`. Dos servicios, dos contratos
  públicos distintos para el mismo hecho, ninguno declarado. **Recomendación**: que el bloque
  `idempotency` admita el `code` de la firma discordante, o que la doctrina fije uno único y
  lo documente como contrato del mecanismo — no dejarlo a criterio de cada corrida.
- **`reconcileReservations` no declara umbral de paciencia ni tamaño de lote.** El agente fijó
  15 minutos y lote 100 en `parameters/`, pendientes de confirmación. Es coherente con la
  doctrina (el umbral es operativo, no de diseño), pero conviene decidir si el diseño debería
  poder fijarlo cuando forma parte del contrato de negocio.

## Lo que esta corrida sí confirmó

- **El eje conductual de RabbitMQ existe**: los 19 escenarios corrieron contra un broker que
  hasta ahora solo se había ejercitado con `broker-check`, que no arranca la JVM.
- **La purga de DLQ de `reset-db.sh` funciona entre flujos reales**, no solo en el aislado de
  `BRK-13`.
- **Sin hallazgos de agentes ni skills**: ningún ciclo se alargó por falta de un antecedente
  documentado.
