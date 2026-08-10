# Guía de entrevista de `/keel-consume`

Tablas de apoyo para los pasos 3 y 4. Los ejemplos usan el dominio compartido de la documentación:
`order-service` **lee** de `catalog` el precio de un producto y le **encarga** a `notifications` el
correo de confirmación.

## 0. Antes de nada: ¿qué clase de dependencia es?

|  | `need` — leer | `activation` — activar |
|---|---|---|
| La pregunta | ¿Qué dato que no es nuestro necesita esta operación **para decidir**? | ¿Qué parte de esta operación **no es responsabilidad nuestra**? |
| Lo que obtenemos | Un dato | Un trabajo hecho |
| A qué nos acopla | A la **salida** del proveedor | A su **entrada**: la firma exacta que hay que mandarle |
| Efecto en el proveedor | Ninguno: leer no cambia nada suyo | Cambia su estado: hemos provocado algo |

**Señal mecánica:** si la llamada saliente es un `POST`/`PUT`/`DELETE` y lo que devuelve no se usa para
decidir nada (un acuse, un id), es una activación. Un `need` con `strategy: on-demand` sobre un `POST`
que no lee nada es el error clásico: valida, y deja el acoplamiento fuera del mapa del sistema.

Ejemplos del dominio:

| Lo que hace falta | Qué es | Por qué |
|---|---|---|
| El precio vigente del producto para cotizar | `need` | Es un dato de `catalog` y `catalog` no se entera de que lo leemos |
| Que se envíe el correo de confirmación | `activation` | Es trabajo de `notifications`, y tenemos que saber qué campos exige para hacerlo |
| Retener un asiento antes de confirmar | `activation` | Cambia el estado del otro servicio; el "¿quedó retenido?" es el desenlace, no el dato |
| Que el histórico conserve el nombre del producto | `need` (`replicated`) | Es un dato que copiamos, no un encargo |

## 1. Decidir la estrategia (needs)

Las tres preguntas, con lo que significa cada respuesta:

| Eje | Pregunta al diseñador | Respuesta → estrategia |
|---|---|---|
| **Corrección** | ¿La decisión exige el valor vigente en ese instante, o vale una copia reciente? | "Vigente" → `on-demand`. "Reciente basta" → candidato a `replicated`. |
| **Disponibilidad** | Si el proveedor está caído, ¿este servicio puede seguir operando? ¿Qué pasa si no? | "No puede parar" → `replicated`. "Es aceptable rechazar" → `on-demand` viable. |
| **Volumen** | ¿Es una consulta por petición, o un listado que exigiría N llamadas? | "N llamadas" → `replicated` (o un endpoint batch del proveedor). |

Los ejes pueden dar respuestas contradictorias: **corrección gana siempre**. Un dato que hay que leer
vigente para ser correcto no se replica aunque sea caro y aunque el proveedor sea inestable; si la
disponibilidad importa igualmente, la salida es rediseñar la operación (reservar, confirmar en dos
pasos), no relajar la corrección.

Ejemplos del dominio:

| Necesidad | Estrategia | Por qué |
|---|---|---|
| Precio para **cobrar** un pedido | `on-demand` | Cobrar con un precio viejo es un error de negocio, no una molestia. |
| Precio para **cotizar** un carrito | `replicated` | Una diferencia de minutos es tolerable y el volumen es alto. |
| Nombre e imagen del producto en el histórico de pedidos | `replicated` | Además de barato, es **deseable**: el histórico debe conservar lo que el cliente vio. |
| Comprobar que un producto **existe** al crear el pedido | `replicated` con `onMiss: fetch` | La copia resuelve el 99 %; el alta recién creada se rescata con una llamada. |

## 2. Segunda ronda, solo con `replicated`

| Pregunta | Va a | Trampa habitual |
|---|---|---|
| ¿Cuánto puede tener de viejo el dato sin que el negocio se resienta? | `replica.freshness` (prosa) | Si responde con un número, pregunta **qué pasa** al superarlo: eso es lo que se declara. |
| ¿Qué eventos del proveedor cambian este dato? | `replica.fedBy` | **Bajas y retiradas.** Es el olvido más común: sin el evento de baja, la copia conserva para siempre un producto retirado. |
| ¿Y si el dato todavía no está en la copia? | `replica.onMiss` | "No puede pasar" es falso: pasa en el arranque en frío y con cualquier alta recién creada en el proveedor. |
| ¿Qué campos lee realmente alguna operación de `usedBy`? | los campos de la entidad en `domain` | Copiar el agregado entero "por si acaso" acopla el diseño a cambios que no controlas. |
| ¿Cómo se correlaciona la copia con el proveedor? | `replica.keyField` (con `unique: true`) | Sin unicidad, una reentrega duplica la fila. |

## 3. `onMiss`: qué exige cada acción

| `action` | Exige | Qué observa el cliente | Cuándo elegirla |
|---|---|---|---|
| `fetch` | `fetchedFrom` en el `need` | Nada: la petición tarda algo más | Hay endpoint del proveedor y la latencia extra es aceptable |
| `fail` | `error`, declarado por alguna operación de `usedBy` | El error de negocio, con su status | No hay forma de decidir bien sin el dato |
| `degrade` | `degradedTo` en prosa | Un resultado parcial o conservador | El servicio puede dar una respuesta útil y honesta sin el dato |

**`degrade` es la peligrosa.** Aplica el mismo criterio que al `fallback` de `http-clients`: un resultado
degradado que produce datos plausibles pero falsos es peor que fallar. Si el cliente no puede distinguir
la respuesta degradada de la normal, no es `degrade` — es un bug declarado.

## 3b. Entrevistar una activación

| Eje | Pregunta al diseñador | Va a |
|---|---|---|
| **Efecto** | ¿Qué hace exactamente el proveedor al recibirlo? | `effect` (prosa, **sacado de su contrato**) |
| **Desenlace** | ¿Esta operación necesita el resultado para continuar, le basta con que lo aceptara, o lo delega y sigue? | `awaits` |
| **Desenlace diferido** | Si necesita el resultado pero el proveedor **no puede darlo en el acto**, ¿por dónde llega? | suscripción al evento de resultado + estado de espera en `domain: lifecycle` + `reconciledBy` |
| **Canal** | *(se deduce de los dos anteriores)* | `via` |
| **Fallo** | Si el encargo no sale, ¿qué ve el cliente de nuestra API? | `onFailure` |

### `awaits`: qué se está prometiendo

| | Qué significa | La consecuencia que hay que decirle al diseñador |
|---|---|---|
| `outcome` | Necesitamos el resultado para continuar | Exige `via` HTTP. Nuestra operación **no puede terminar** si el proveedor está caído |
| `acknowledgement` | Basta con que lo aceptara | El trabajo puede fallar **después** y nuestra operación ya respondió que todo fue bien |
| `nothing` | Se delega y se sigue | Nadie comprueba nunca que se hiciera. Solo es honesto si el negocio lo asume |

La pregunta que desempata: **si ese trabajo no llegara a hacerse, ¿quién lo echaría de menos y cuándo se
enteraría?** Si la respuesta es "el cliente, y tarde", ni `nothing` ni `ignore` son aceptables.

**Y si la respuesta a `acknowledgement` es «no me vale, necesito enterarme», la salida no es subir a
`outcome`.** Hay una tercera forma de encargar, y es la que se olvida porque no tiene un valor propio en
el enum: **el desenlace diferido**. Se declara componiendo, y `awaits` sigue siendo `acknowledgement`
—la operación propia sí terminó—:

| | Encargo síncrono | Publicar y olvidar | **Desenlace diferido** |
|---|---|---|---|
| `via` | `{ client, call }` | `{ publishes }` | `{ publishes }` |
| `awaits` | `outcome` | `nothing` | `acknowledgement` |
| Cómo nos enteramos | La llamada devuelve sí o no | No nos enteramos | Por un **evento de resultado** al que nos suscribimos |
| Estado de la entidad | Termina resuelta | Termina resuelta | Queda en un **estado de espera** |
| Si no llega nada | No aplica: la llamada falla | No aplica: no esperamos nada | Se queda esperando para siempre → **`reconciledBy`** |

**El estado de espera no lo crea el evento, lo crea necesitar el desenlace.** Un encargo `awaits:
nothing` no lleva estado intermedio, y ponérselo fabrica una espera que el negocio no tiene y de la que
nadie va a sacar a la entidad.

### `onFailure`: qué exige cada acción (solo con `via` HTTP)

| `action` | Exige | Qué observa el cliente | Cuándo elegirla |
|---|---|---|---|
| `fail` | `error`, declarado por alguna operación de `triggeredBy` | El error de negocio, con su status | La operación propia no tiene sentido sin ese trabajo |
| `degrade` | `degradedTo` en prosa | Un resultado parcial y **distinguible** | La operación vale igual y el trabajo se recupera por otra vía |
| `ignore` | nada | Nada: éxito normal | Solo si el negocio de verdad no cuenta con ese trabajo |

`ignore` es a las activaciones lo que `degrade` a las réplicas: la opción peligrosa. Silencia un trabajo
que no se hizo, y la operación propia responde `200`.

### Desenlace diferido: las tres declaraciones acopladas

No es un campo, son cuatro cosas que se escriben juntas o el diseño queda a medias:

1. **El estado de espera**, en `domain: lifecycle` de la entidad que queda esperando, con sus aristas de
   salida — confirmación, rechazo y rendición del barrido. Y la `transitions` de la operación que
   encarga, que es la que mete la entidad ahí.
2. **La marca de cuándo empezó a esperar**, un campo propio de la entidad que estampa esa misma
   operación, nombrado a partir de la activación: `<activacion>AwaitingSince` (`reserveStockAwaitingSince`).
   El estado dice *que* espera; el barrido necesita *desde cuándo*. Y las dos marcas obvias no valen:
   `createdAt` es cuándo nació la entidad —puede confirmarse horas después— y un `updatedAt`
   **rejuvenece** con cualquier otra escritura, dejando la entidad invisible al barrido para siempre. El
   prefijo tampoco es cosmética: si la entidad llega a esperar dos desenlaces, una marca única deja que
   el segundo encargo pise la del primero. Suele ir fuera del contrato (`exclude`): es un marcador
   operativo.
3. **La operación que aplica el desenlace bueno** (`internal: true`), disparada por la suscripción al
   evento de resultado. Sin ella la entidad no sale nunca de la espera por la vía normal y el barrido
   acaba rindiéndose con todas: la reconciliación respalda el camino feliz, no lo sustituye.
4. **`reconciledBy`** con su operación `schedule`, que barre lo que lleva demasiado tiempo esperando.

Y una consecuencia que se pasa por alto: **el estado de espera es contrato público**. Si la API lo
devuelve, el cliente lo ve y tiene que saber qué hacer con él; la operación deja de poder prometer
«confirmado» en su respuesta, y los escenarios de validación tienen que afirmar el estado de espera, no
el final.

### Activación por evento: el compromiso del otro lado

Con `via: { publishes: <Evento> }` hace falta algo que no se puede suponer: el proveedor tiene que
declararlo como `subscriptions.<Evento>` con **`nature: request`**. Eso es su compromiso de atenderlo, y
es lo que hace que el payload que publicamos sea contrato y no una esperanza.

| Lo que ves en su `INTEGRATION.md` | Qué significa |
|---|---|
| §Suscripciones lista el evento con sus campos | Acepta el encargo: copia el payload campo a campo |
| No aparece, pero sí un endpoint equivalente | El canal acordado es HTTP: usa `via: { client, call }` |
| No aparece nada | **Hueco**, no invención. Publicar el evento y esperar que actúe no es una integración acordada |

## 4. Mapeo: front-matter del `INTEGRATION.md` → DSL del consumidor

| Origen (contrato del proveedor) | Destino (spec de este servicio) |
|---|---|
| `service` | clave de `dependencies.<proveedor>` y `messaging.subscriptions.<E>.source` |
| `version` | `dependencies.<proveedor>.contract.version` |
| ruta del archivo leído | `dependencies.<proveedor>.contract.source` (relativa al workspace) |
| `m2mAuth.protocol: client-credentials` | `http-clients.clients.<p>.auth.type: oauth2-client-credentials` |
| `m2mAuth.audience` | **no se declara**: la audiencia la valida el proveedor, no la pide el consumidor |
| *(no está en el front-matter)* | `auth.tokenUrl` — **pregúntalo**, el schema lo exige y es por entorno |
| scopes concedidos a nuestro cliente (tabla de §Endpoints) | `http-clients.clients.<p>.auth.scopes` |
| `basePath` + `endpoints[].path` | `http-clients.clients.<p>.calls.<c>.path` (relativa; el `basePath` es despliegue) |
| `endpoints[].method` | `…calls.<c>.method` |
| tablas Request/Response del cuerpo | `…calls.<c>.request` / `.response.fields` |
| `errors[]` de un endpoint | `use-cases.<op>.errors` de la operación que lo llama, **si son suyos**; los del proveedor solo se traducen a errores propios |
| `events.envelope: keel` | `messaging.subscriptions.<E>.contract.envelope: keel` |
| `events.published[].name` | clave de `messaging.subscriptions.<E>` y entrada de `replica.fedBy` |
| `events.published[].channel` | `messaging.channels.<c>` con `external: true` |
| tabla de payload de cada evento | `messaging.subscriptions.<E>.payload` (solo los campos que usamos) |
| `metadata.eventId` de la envoltura Keel | `contract.messageId: { location: field, name: metadata.eventId }` |
| §Suscripciones: evento que el proveedor **atiende** (`nature: request` en su diseño) | `messaging.publishing.events.<E>` **nuestro**, con su payload **completo tal como él lo exige**, más `dependencies.<p>.activations.<a>.via: { publishes: <E> }` |
| §Endpoints con efecto (crear, retener, cobrar, enviar) | `http-clients…calls.<c>` + `dependencies.<p>.activations.<a>.via: { client, call }` — **no** un `need` |

Lo que **nunca** se traslada: `basePath` absoluto, credenciales, `tokenUrl` de un entorno concreto, el
modelo de datos completo del proveedor, y sus códigos de error tal cual como errores nuestros.

## 5. Checklist de cierre

- [ ] Cada dependencia está en la casilla correcta: lo que se **lee** en `needs`, lo que se **encarga**
      en `activations`. Ningún `need` cuyo `fetchedFrom` apunte a una llamada que no devuelve un dato usado.
- [ ] Todo `need` tiene al menos una operación en `usedBy`, y esa operación existe.
- [ ] Toda activación tiene `triggeredBy`, `via` y un `effect` sacado del contrato del proveedor, no supuesto.
- [ ] Toda activación por evento tiene su contraparte `nature: request` en el diseño del proveedor, o
      está declarada como hueco.
- [ ] Todo `onFailure.action: fail` tiene su `error` declarado en las operaciones de `triggeredBy`.
- [ ] Todo cliente HTTP escrito lo usa algún `need` o alguna activación; toda suscripción escrita
      alimenta una réplica o es una compensación declarada.
- [ ] Toda compensación tiene, si el workspace lleva `system.yaml`, la arista `consumes` con
      `kind: events` hacia ese proveedor —además del `invokes` de la activación que deshace—: sin ella
      `keel system check` da la suscripción por no contemplada.
- [ ] Toda réplica declara `onMiss`, y su `fedBy` cubre **altas, cambios y bajas**.
- [ ] Todo `onMiss.action: fail` tiene su `error` declarado en **cada** operación de `usedBy`.
- [ ] La entidad de la réplica está en `persistence.entities`, su `keyField` es `unique`, y su
      `description` dice que es una proyección.
- [ ] No hay credenciales, secretos ni URLs de entorno en ningún artefacto.
- [ ] `keel validate` pasa (o `--wip` si el diseño sigue abierto).
- [ ] La lista de huecos está escrita, con destinatario. En modo degradado, **no está vacía**.
