# Capa `messaging` — broker de mensajería (opcional)

Archivo: `specs/<servicio>/messaging.keel.yaml` · Schema: [`schema/messaging.schema.json`](../../schema/messaging.schema.json)

Qué eventos publica el servicio y a cuáles se suscribe, y por qué **canales** lo hace. El broker concreto (Kafka, RabbitMQ…) no se menciona: es decisión de generación.

```yaml
channels:
  productEvents:
    description: Ciclo de vida del producto que publica este servicio.
  inventoryEvents:
    description: Eventos de inventory-service que este servicio consume.
    external: true                 # el canal lo posee otro sistema

publishing:
  reliability: outbox            # outbox | best-effort
  events:
    ProductCreated:
      description: Se emitió un alta de producto.
      channel: productEvents
      payload:
        productId: { type: uuid, required: true }
        sku:       { type: SKU, required: true }
    ProductRetired:
      channel: productEvents
      payload:
        productId: { type: uuid, required: true }

subscriptions:
  StockDepleted:
    source: inventory-service
    channel: inventoryEvents
    contract:
      envelope: wrapped            # keel | wrapped | none
      payloadPath: data
      format: json
      discriminator: { location: header, name: eventType, value: stock.depleted }
      messageId: { location: header, name: messageId }
      unknownFields: ignore
    payload:
      productId: { type: uuid, required: true, wireName: product_id }
    triggers: retireProduct
    input:
      productId: productId
    onFailure:
      retry: { maxAttempts: 5, backoff: exponential, initialDelayMs: 1000 }
      deadLetter: true
```

## Canales

- Un **canal** es un concepto lógico y agnóstico del broker: al generar se materializa en un **topic** (Kafka), una **cola/exchange** (RabbitMQ), etc. — igual que un `bucket` de la capa `storage` se materializa en S3/MinIO. En el diseño solo se declara el nombre lógico y su propósito.
- Se declaran en `channels` (nombres en `camelCase`) y se referencian por nombre desde `publishing.events.<Evento>.channel` y `subscriptions.<Evento>.channel`. `keel validate` comprueba que el canal referenciado exista (referencia cruzada) y avisa de canales declarados que nadie usa (canal huérfano).
- `channel` es **opcional**: un diseño puede dejar el enrutado a convención del generador. Pero si el servicio se integra con otros, declarar el canal deja plasmado el contrato de integración (por dónde emite y de dónde consume).
- `external: true` marca un canal que **posee otro sistema**: el generador no lo crea ni asume sobre él la envoltura de eventos de Keel, y el nombre físico del topic/cola real (que ya existe fuera) se resuelve como **parámetro de despliegue**, no en el spec. Publicar en un canal externo es posible pero se avisa: exige acuerdo con su dueño.

## Publicación

- Todo evento en `emits` de una operación de `use-cases` **debe** estar declarado en `publishing.events`.
- `reliability: outbox` es el contrato "ningún evento se pierde si la transacción confirma"; el mecanismo (tabla + relay, CDC…) lo decide el generador. `best-effort` admite pérdida ante fallos. Si `domain` declara `aggregates`, el evento se escribe en la misma transacción que el agregado que cambió.
- **`outbox` exige capa `persistence`, y es error si no está.** No es una dependencia de estilo: la fila del evento se escribe en la misma transacción que el cambio de estado, y sin almacén no hay dónde ponerla. Un generador que se encuentre ese diseño no puede construir nada y publicará en el acto — o sea, `best-effort` con el documento diciendo lo contrario.
- **Encargar trabajo con `via: { publishes }` sobre `best-effort` es aviso.** `dependencies` da por hecho que un encargo publicado llega —por eso no admite `onFailure` en esa rama—, y quien lo garantiza es el outbox, no el acto de publicar. Con `best-effort`, si el broker no está en ese instante el encargo se pierde sin rastro, y no hay compensación posible de un trabajo que nunca se pidió.
- **`reliability` la decide el diseñador**, no el agente: es una decisión estructural (qué se pierde cuando el broker está caído en el instante en que la transacción confirma) y arrastra la capa `persistence` —la transacción que el outbox necesita confirmar— y su frontera transaccional, así que ambas se deciden juntas. Lo mismo vale para el `onFailure` de cada suscripción: `retry` sin `deadLetter` no produce un fallo visible, produce un consumidor que deja de avanzar. Ejes y consecuencias observables: `references/structural-decisions.md` de la skill `keel-design` §3.1 y §3.5.
- Eventos en pasado y `PascalCase`: `ProductCreated`, no `CreateProduct`.
- Un campo del `payload` (publicado o consumido) puede ser una colección con `list: true`, acotable con `constraints: { minItems, maxItems }`.

### La envoltura Keel

Ningún evento viaja desnudo: todo mensaje que publica un servicio Keel sale envuelto en la **envoltura estándar**, con dos claves de primer nivel. El `payload` declarado en el diseño ocupa `data`; `metadata` es **transversal** —la misma para todos los eventos, no se declara en el spec— y la estampa el servicio al emitir.

```json
{
  "metadata": {
    "eventId": "9f1c3b6e-2d4a-4a91-b0f2-5c7d8e0a1b23",
    "eventType": "ProductCreated",
    "eventVersion": 1,
    "occurredAt": "2026-03-14T09:21:07.482Z",
    "source": "product-service",
    "correlationId": "1f7b0a52-33c9-4a1e-9a44-6c0f2b8d55e1"
  },
  "data": {
    "productId": "3d2e1f00-8a44-4c9b-9f01-77b6c2d4e5a9",
    "sku": "SKU-10493"
  }
}
```

| Campo | Tipo | Descripción |
|---|---|---|
| `eventId` | `uuid` | Id único de **esta ocurrencia**. Es la clave de deduplicación del consumidor: se estampa al emitir y nunca se regenera aguas abajo (una reentrega repite el mismo `eventId`). |
| `eventType` | `string` | Nombre del evento en el diseño (`ProductCreated`). Sirve de discriminador cuando un canal transporta varios tipos. |
| `eventVersion` | `int` | Versión del contrato del `payload`. Arranca en `1` y solo sube al romper compatibilidad. |
| `occurredAt` | `timestamp` | Instante ISO-8601 en UTC en que **ocurrió el hecho** en el dominio, no el del envío (con `reliability: outbox` pueden distar). |
| `source` | `string` | Nombre del servicio emisor (`service.name` del manifiesto). Es **procedencia declarada**, no identidad verificada: sirve para trazar, nunca para autorizar (ver abajo). |
| `correlationId` | `string` \| `null` | Correlación de la petición que originó el hecho; es lo que hila la traza end-to-end entre servicios. `null` si no hubo contexto de petición (p. ej. un job programado). |
| `data` | objeto | El `payload` declarado en `publishing.events.<Evento>.payload`, con sus campos tal cual. |

Esta forma es **parte del contrato público**: `/keel-docs` la publica en el `asyncapi.yaml` del servicio
(el payload de cada mensaje publicado es `{ metadata, data }`), no solo en la documentación en prosa.

Es también la forma que asume `envelope: keel` al describir el [contrato de recepción](#contrato-de-recepción-contract) de una suscripción, y la que **todo generador debe emitir**: es lo que permite que dos servicios Keel escritos en tecnologías distintas se consuman entre sí sin traductor. Cómo se materializa en cada stack (nombres de clase, serializador) es decisión del generador; la forma del cable, no.

#### `source` es procedencia, no identidad

Conviene decirlo aparte porque el campo invita a lo contrario. `source` lo estampa el
emisor **en el cuerpo del mensaje**, hermano de `data`, con un valor que sale de su
propio manifiesto. Nadie al otro lado lo comprueba —ningún generador lo lee siquiera— y
cualquiera que pueda publicar en ese canal escribe ahí lo que quiera.

De ahí la regla, que es sobre lo que `source` **es**: no es una credencial. La simetría con
el eje HTTP es exacta y vale la pena tenerla presente: allí la identidad sale de la
credencial (el token) y jamás del cuerpo de la petición; en un broker la credencial es lo
que el **broker** autenticó en el momento de publicar. Un servicio que atienda a varios
emisores y decida algo en función de quién le escribe tiene ahí su fuente verificada: el
destino del que consume (una entrada por emisor, con ACL), o el principal que el propio
broker estampa cuando la tecnología lo ofrece. Eso es **configuración de despliegue, no
diseño**, y viaja con el nombre físico del topic/cola, que esta capa ya declara fuera del
spec.

Y con eso dicho: **hay organizaciones que resuelven el inquilino desde `source` a
sabiendas**, y es una decisión defendible mientras todos los emisores sean sistemas propios
que el broker ya autenticó. Lo que no se puede es hacerlo **sin decirlo** — que era el
verdadero problema: un servicio que autoriza con un dato del cuerpo sin que el diseño lo
declare en ninguna parte. Por eso esa vía existe, pero solo dentro de
[`identity`](#cuando-el-inquilino-sí-tiene-que-salir-del-mensaje-identity) y obligando a
escribir la asunción que la sostiene.

Para lo demás, `source` sirve para lo mismo que `correlationId`: traza, diagnóstico y
enrutado de soporte — saber de dónde dice venir un mensaje cuando alguien lo investiga.

#### Cuando el inquilino sí tiene que salir del mensaje: `identity`

Todo lo anterior dice por qué `source` no es identidad **verificada**. Lo que no dice es qué
hacer cuando un servicio atiende a varios emisores y tiene que decidir algo según quién le
escribe: ahí hace falta un inquilino, y por el broker no llega ningún token. `identity` es
dónde se declara de dónde sale, y el efecto de declararlo es que el caso de uso recibe el
inquilino **ya resuelto** en vez del mensaje crudo.

```yaml
subscriptions:
  NotificationRequested:
    source: any-registered-system
    nature: request
    contract: { envelope: keel }
    identity:
      field: applicationKey                        # campo del input de la operación disparada
      from: { location: field, name: metadata.source }
      trustedPublishers: >-
        Nadie publica anónimamente en este canal: el broker autentica a los emisores. Sobre
        eso se acepta que cada uno ponga su propio nombre en `source`, que es política de
        desarrollo y no control técnico.
      onUnresolved: discard                        # permanente: sin reintentos
    payload: { ... }
    triggers: acceptNotificationRequest
```

**Las dos opciones de `from` son legítimas; lo que no lo es es no haber decidido.**

| | `location: header` | `location: field` |
|---|---|---|
| De dónde sale | Un metadato que estampa el **broker** (`user_id` de AMQP, `SenderId` de SQS) | Un campo del **cuerpo** (`metadata.source`) |
| Quién la garantiza | El broker, que rechaza el `publish` si no coincide con la conexión | Una política de desarrollo: nada en el camino lo comprueba |
| Qué hace falta para suplantar | Robar la credencial del emisor ante el broker | Escribir otro nombre en un campo |
| Riesgo residual | Credencial filtrada | Un emisor **registrado** enviando en nombre de otro |

Con `location: field`, el schema **exige `trustedPublishers`**: la asunción que sostiene el
mecanismo, en prosa. No es una casilla de conformidad — es lo que hace la decisión revisable
el día que cambie, y sin escribirla cada quien supondrá una cosa distinta. La asunción tiene
casi siempre dos mitades y solo una es técnica: (1) el broker autentica a los emisores, lo
que acota el riesgo a quienes ya están dentro; (2) cada emisor pone su propio nombre, que no
lo comprueba nadie. La primera hace el trabajo pesado; la segunda **no elimina lo que queda**,
y se acepta a sabiendas mientras todos los emisores sean sistemas propios en la misma malla
de confianza.

Dos cosas más que declarar `identity` cierra:

- **El dato de identidad está en un solo sitio.** `identity.field` no puede aparecer además
  en `input`: son dos versiones de la verdad, y tarde o temprano una deja de validarse. Por
  eso tampoco viaja en el `payload`.
- **`onUnresolved` es un fallo permanente, no transitorio.** Una identidad que no resuelve a
  nada conocido no va a resolver en el intento cinco: reintentarlo con backoff solo retrasa el
  descubrimiento y llena los logs. Por eso no hay opción de reintentar y se declara aparte de
  `onFailure`, que trata todo fallo como transitorio.

**La señal para pasar a `header` es inconfundible**: el día que un emisor deje de estar dentro
del perímetro de confianza —un tercero, un sistema de otra organización, un cliente que se
integra— o que alguien pida no-repudio del origen para una auditoría. Y cambiarlo es barato
porque la resolución vive en **un único punto**: son estas dos líneas, y no tocan el dominio,
ni los casos de uso, ni el esquema. Mientras tanto, `/keel-validate` relee la asunción en cada
revisión en vez de darla por vigente.

## Suscripciones

- Cada suscripción indica su `source`, el `payload` esperado y la operación local que dispara (`triggers`, referencia por nombre a `use-cases`).
- `nature` declara **qué es el mensaje para este servicio**, y es lo que decide de qué lado cae el acoplamiento (ver abajo).
- `onFailure` declara la política de consumo: `retry` (reintentos con backoff) y `deadLetter` (tras agotarlos, el mensaje va a una DLQ).
- `retry` admite `maxAttempts` (obligatorio), `backoff` (`fixed` | `exponential`, por defecto `exponential`), `initialDelayMs` y `maxDelayMs` (tope al que la espera deja de crecer con `backoff: exponential`) — el mismo juego de campos que `http-clients`.
- Si una suscripción reintenta (`maxAttempts > 1`), reintentar es pedir explícitamente que el mismo mensaje llegue más de una vez: sin nada que impida el doble efecto, la operación disparada se aplica tantas veces como intentos haya. `keel validate` lo da como **error** si no la protege ninguno de los dos mecanismos: `contract.messageId` aquí, o una `transitions` de lifecycle irrepetible en la operación (su `to` no está entre sus propios `from`). La `idempotency` de la operación **no** cuenta con `keySource: client-key`: esa clave llega por una cabecera HTTP que el broker no manda. Con `keySource: payload-field` sí, porque entonces la clave es un campo del propio mensaje.

### `nature` — hecho ajeno o petición dirigida a nosotros

Dos mensajes idénticos en el cable pueden significar cosas opuestas, y de eso depende quién se acopla a quién.

| | `fact` (por defecto) | `request` |
|---|---|---|
| Qué es | Algo que **pasó** en el origen | Algo que nos **piden** hacer |
| Quién decide el payload | El emisor, para describir su hecho | **Nosotros**: es nuestra firma de entrada |
| Quién se acopla | Nosotros al emisor | El emisor a nosotros |
| El emisor sabe que existimos | No | Sí: nos eligió para el trabajo |
| Es una dependencia nuestra | Sí → va en `dependencies` | No: es una puerta de entrada |
| Dónde se publica | En nuestro diseño | En nuestro `INTEGRATION.md` §Suscripciones |

Un `fact` es `OrderPlaced`: `orders` lo publica porque pasó, y quien quiera reaccionar lo hace por su cuenta. Un `request` es `DeliveryRequested`: quien lo emite nos está encargando un envío, con los campos que **nosotros** exigimos para poder hacerlo.

La consecuencia práctica: un `request` **no obliga a declarar su `source` como dependencia** (no dependemos de quien nos da trabajo), y su payload es contrato público que no se puede cambiar sin avisar. El otro lado lo declara con una `activation` (`dependencies`) y una arista `invokes` (`system.yaml`); `keel system check` comprueba que las dos lecturas coinciden — si alguien nos manda trabajo y nosotros lo tratamos como `fact`, nadie se ha comprometido a atenderlo.

### Contrato de recepción (`contract`)

`payload` dice **qué datos** trae el evento; `contract` dice **qué forma tiene el mensaje que llega**. Sin él, el generador tiene que suponer, y suponer solo es seguro cuando la fuente es otro servicio Keel. Al diseñar una suscripción a un sistema ajeno, hay que averiguar con su dueño:

| Pregunta al emisor | Dónde se plasma |
|---|---|
| ¿El mensaje viene envuelto? ¿Dónde está el payload dentro? | `envelope` (`keel` \| `wrapped` \| `none`) + `payloadPath` |
| ¿En qué formato serializa? ¿Hay schema registrado? | `format` + `schemaRef` |
| ¿El canal transporta varios tipos de evento? ¿Cómo se reconoce este? | `discriminator` (`location: header\|field`, `name`, `value`) |
| ¿Qué dato identifica el mensaje para no procesarlo dos veces? | `messageId` (`location`, `name`) |
| ¿Los campos llegan con otro nombre? | `wireName` en cada campo del `payload` |
| ¿Qué hacemos con campos que envía y no declaramos? | `unknownFields` (`ignore` \| `fail`) |

- `envelope: keel` — la fuente es otro servicio Keel y usa la [envoltura estándar](#la-envoltura-keel) (`metadata` + `data`): el payload llega en `data` y la deduplicación sale de `metadata.eventId`. `wrapped` — envoltura propia de la fuente, el payload cuelga de `payloadPath` (obligatorio). `none` — el mensaje **es** el payload. Por defecto se asume `keel` si el canal no es `external`, y `none` si lo es.
- `messageId` es la **clave de deduplicación**: con reentregas (`retry`, DLQ, at-least-once) es lo que evita procesar dos veces el mismo evento. Corta el doble efecto **antes** de llegar al dominio, y es imprescindible cuando el canal es `external` y no hay envoltura de la que sacar un id. Es el equivalente en el eje de eventos de lo que la `idempotency` de la operación hace en el eje HTTP, y con `keySource: client-key` **no son intercambiables**: aquella se identifica por una cabecera que el broker no manda. La excepción es `payload-field`, cuya clave viaja en el cuerpo y por tanto llega por las dos puertas.
  - Su `location` se refiere al **mensaje del broker**, no a HTTP: `header` es el metadato nativo (header Kafka, atributo SQS, property AMQP) y `field`, un campo del cuerpo. Son las dos únicas partes que tiene un mensaje, y por eso el enum no tiene más valores.
  - **Con `envelope: keel` no se declara**: la identidad ya es `metadata.eventId`, que el emisor estampa una vez en el `raise` y viaja intacta hasta el cable, y es de ahí de donde deduplica el consumidor. Declarar uno propio apuntaría a un metadato nativo que ningún emisor Keel escribe —la envoltura entera va en el cuerpo—, así que el listener lo leería vacío: `keel validate` lo avisa. El campo es para `none`, `wrapped`, canales `external` y fuentes que sí usan una propiedad nativa del broker.
  - **La deduplicación tiene una ventana, y el DSL no la declara.** El consumidor recuerda los mensajes ya procesados durante un plazo de **retención** que es configuración del servicio generado, no del diseño: en keel-spring, `processed-event.purge.retention-days` con un default de 14 días. Una reentrega posterior a ese plazo se procesa como si fuera nueva. No es una limitación práctica —la ventana de reentrega de un broker se mide en horas, no en semanas— pero conviene saber que la garantía es «no se procesa dos veces dentro de la retención», no «nunca jamás»: si el negocio necesita una ventana mayor (un evento que puede reaparecer meses después), el mecanismo correcto no es esta deduplicación sino una guarda de dominio, que no caduca.
- `discriminator` importa sobre todo cuando **varias suscripciones comparten canal**, que es el caso normal: un emisor suele publicar todos sus eventos en el mismo destino. Cada listener recibe entonces el canal entero y necesita algo con que reconocer lo suyo; sin ello deserializa el mensaje ajeno como propio, y según la forma del JSON eso falla con un error de parseo o —peor— cuela campos a `null` y procesa un evento que no era.
  - **Con `envelope: keel` tampoco se declara**, por la misma razón que `messageId`: la envoltura ya trae `metadata.eventType`, el emisor lo estampa siempre y el consumidor filtra por él sin que el diseño diga nada. La simetría es exacta —`eventId` deduplica, `eventType` discrimina— y declarar cualquiera de los dos sobre una envoltura Keel es pedir dos veces el mismo dato.
  - Sin envoltura Keel (`none`, `wrapped`, canales `external`), un canal compartido **sin** `discriminator` es un aviso de `keel validate`: no hay nada que lo resuelva solo.
- `wireName` solo es válido en contratos de sistemas externos (aquí y en `http-clients`): los identificadores del DSL van en inglés y `camelCase`, y `wireName` guarda el nombre real del cable (`product_id`, `numero_documento`). `keel validate` da error si aparece en una capa interna.

### Del mensaje a la operación (`input`)

`input` mapea **campo del input de la operación disparada → campo del `payload` de la suscripción**. Si se omite, se asume identidad por nombre. `keel validate` comprueba mecánicamente que:

- todo campo `required` del input de `triggers` (que no sea `generated` ni `computed`) llegue en el payload, directamente o vía `input` — si no, **error**: el listener no podría construir la operación;
- las claves de `input` existan en el input de la operación y sus valores en el payload;
- todo campo del payload alimente algo (si no, **aviso**: o sobra en el contrato o falta en la operación).

## Qué NO va aquí

- Qué operación emite cada evento → `use-cases` (`emits`).
- **Por qué existe una suscripción `fact`**: de qué dependencia forma parte, qué copia local alimenta y qué compensa → capa `dependencies`. Aquí se declara el canal de entrada; allí, la razón de negocio que lo justifica. (Una suscripción `request` no tiene entrada en `dependencies`: su razón de ser es que alguien nos encarga trabajo, y eso se declara en el diseño de quien nos lo encarga.)
- **A quién le pedimos trabajo publicando un evento**: eso no es una decisión de esta capa. Aquí solo vive el evento y su payload; que exista *para* que un servicio concreto actúe, y contra qué versión de su contrato, va en `dependencies: activations`.
- La frontera transaccional que sostiene el outbox → `persistence` (`consistency`).
- **Quién está autorizado a publicar** en un canal del que consumimos: ACLs del broker, credenciales del emisor, un destino por origen. Se decide al desplegar, y `metadata.source` no lo sustituye — es un dato que escribe el emisor, no una identidad verificada.
- El broker concreto y el nombre físico del topic/cola que respalda cada canal → se deciden al **generar**, nunca en el spec. También el de un canal `external`, cuyo nombre real ya existe fuera: entra como parámetro de despliegue, no como dato de diseño.
- El consumer group / la durabilidad de la suscripción y el número de consumidores → decisión de generación y despliegue.
