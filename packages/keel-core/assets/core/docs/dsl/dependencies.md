# Capa `dependencies` — de qué otros servidores depende este (opcional)

Archivo: `specs/<servicio>/dependencies.keel.yaml` · Schema: [`schema/dependencies.schema.json`](../../schema/dependencies.schema.json)

De quién depende este servicio y **de cuál de las dos maneras en que se puede depender**. Es la capa de *síntesis* de la integración: `http-clients` declara un canal saliente y `messaging` uno entrante, pero ninguna de las dos dice que ambos existen por la misma razón. Aquí se declara esa razón. El mecanismo concreto (cliente REST, tabla de proyección, topic) no se menciona: es decisión de generación.

## Las dos formas de depender

|  | `needs` — leer | `activations` — activar |
|---|---|---|
| Qué se obtiene | Un **dato** que no es nuestro | **Trabajo** que hace otro |
| La pregunta | ¿Qué dato ajeno necesita esta operación **para decidir**? | ¿Qué parte de esto **no es nuestra responsabilidad** y se la pedimos a otro? |
| Del contrato del proveedor nos acopla | Su **salida**: la forma del dato que devuelve o publica | Su **entrada**: la firma exacta que hay que mandarle para que actúe |
| Ejemplo | `orders` lee de `catalog` el precio vigente para cotizar | `orders` le pide a `notifications` que mande el correo de confirmación |
| Arista del mapa | `consumes` (la dibuja quien lee) | `invokes` (la dibuja quien pide) |

La distinción no es terminológica. Al **leer**, el proveedor no sabe que existimos y puede desplegarse solo; al **activarlo**, somos nosotros los que tenemos que conocer su firma, y por eso necesitamos su `INTEGRATION.md` **antes** de poder diseñarnos. Eso cambia el orden de construcción del sistema, y es lo que `keel system` calcula a partir de las dos aristas.

Escribir una activación como si fuera un `need` (un `strategy: on-demand` cuyo `fetchedFrom` apunta a un `POST` que no lee nada) valida, pero miente: dice que el dato vive en el proveedor cuando lo que vive allí es el trabajo. Y deja el acoplamiento fuera del mapa.

Un mismo proveedor puede aparecer de las dos formas: se le leen datos **y** se le pide trabajo. Se declara un solo bloque con `needs` y `activations`.

**Regla de la capa: referencia, nunca redeclara.** Todo lo que ya vive en otra capa se cita por nombre y no se repite.

```yaml
dependencies:
  catalog:
    description: Fuente de verdad de productos y precios.
    contract:
      version: "0.2.0"
      source: contracts/catalog/INTEGRATION.md
    needs:
      productPricing:
        description: Precio y estado del producto al construir un pedido.
        usedBy: [createOrder, repriceOrder]
        strategy: replicated
        fetchedFrom:
          client: catalog
          call: getProductsByIds
        replica:
          entity: ProductSnapshot
          keyField: productId
          fedBy: [ProductCreated, ProductUpdated]
          freshness: Un precio de hasta cinco minutos vale para cotizar; para cobrar, no.
          onMiss:
            action: fetch
    compensations:
      - onEvent: OrderPaymentFailed
        description: Al fallar el cobro se revierte la reserva hecha contra catalog.

  notifications:
    description: Servicio de avisos. No le leemos nada: le pedimos que envíe.
    contract:
      version: "1.2.0"
      source: contracts/notifications/INTEGRATION.md
    activations:
      sendOrderConfirmation:
        description: El aviso al comprador es trabajo de notifications, no nuestro.
        triggeredBy: [confirmOrder]
        via: { publishes: DeliveryRequested }
        effect: Sale un correo de confirmación hacia el comprador.
        awaits: nothing
```

## La dependencia y su contrato

- La clave es el **nombre del servicio proveedor** en kebab-case (`catalog`), el mismo que aparece como `source` de sus eventos y como id de su cliente HTTP. Es el inverso de `security: serviceClients`, que cataloga a quienes nos consumen a nosotros.
- `contract.version` registra **a qué versión del contrato publicado se acopla este diseño**. Romper esa versión rompe este servicio: es un hecho de arquitectura, no un detalle administrativo. Con `needs` nos acopla a su contrato de salida; con `activations`, al de entrada — y ese es más frágil, porque un campo nuevo obligatorio en su firma nos rompe sin que nadie toque nuestro código.
- `contract.source` es la procedencia (ruta relativa al workspace o URL), informativa. Ni `keel validate` ni ningún generador la resuelven.
- `contract` entero es opcional: hay proveedores que aún no publican `INTEGRATION.md`. Declarar la dependencia sin contrato es correcto; inventarse el contrato, no.

## `needs` — qué dato necesita cada caso de uso

Un `need` es **un dato ajeno concreto**, no un endpoint del proveedor. Se descubre recorriendo los casos de uso propios y preguntando *"¿qué dato que no es nuestro necesita esta operación para decidir?"*, nunca al revés: empezar por lo que el proveedor ofrece produce integraciones que nadie usa. Si la respuesta honesta es *"ningún dato: lo que necesito es que **haga** algo"*, no es un `need` — es una `activation`.

| Campo | Obligatorio | Qué declara |
|---|---|---|
| `usedBy` | ✅ | Operaciones de `use-cases` que necesitan el dato. Es el único enlace del DSL entre un caso de uso y su integración. |
| `strategy` | ✅ | `on-demand` o `replicated` (ver abajo). |
| `exposedAs` | — | El campo con el que el dato **viaja en la salida** de esas operaciones (ver abajo). |
| `fetchedFrom` | según estrategia | Llamada de `http-clients` que resuelve el dato: `{ client, call }`. |
| `replica` | con `replicated` | La copia local (ver abajo). |
| `onUnavailable` | — | Qué pasa cuando el proveedor no da el dato (ver abajo). Sin él, la política la elige quien construya. |

### `exposedAs` — cuando el dato además se devuelve

La pregunta que descubre un `need` es «¿qué necesita esta operación para **decidir**?», y muchas veces la respuesta se agota ahí: el dato entra, se decide con él y no vuelve a aparecer. Pero otras el dato **es parte de la respuesta** —el precio vigente que acompaña a una ficha, el coste que el consumidor necesita para pintar un margen—, y eso hay que declararlo:

```yaml
needs:
  currentPrice:
    description: Precio vigente que acompaña a la ficha pública del producto.
    strategy: on-demand
    usedBy: [getProductBySlug]
    exposedAs: currentPrice        # viaja en la salida con ese nombre
    fetchedFrom: { client: pricing, call: getPrice }
```

Cuatro cosas que no son evidentes:

- **La forma del dato no se declara aquí.** Sale de donde ya está: `response.fields` de la llamada de `fetchedFrom` con `on-demand`, y los campos de la entidad réplica con `replicated`. Declararla otra vez sería una segunda fuente de verdad, y la que manda es la del proveedor.
- **Y viaja con esa forma entera: es un objeto, no un escalar.** `exposedAs: supplierPrice` sobre un origen `{amount, currency, occurredAt}` produce un campo `supplierPrice` con esos tres campos dentro — **no** el importe suelto, aunque el importe sea lo único que interese al que lo lee. Aplanar exigiría declarar *cuál* de los campos es el bueno, que es precisamente la segunda fuente de verdad que el punto anterior evita; y un origen que hoy tiene un solo campo puede tener dos mañana sin avisar. Merece decirse porque el nombre invita a leerlo al revés —`currentPrice` suena a número— y porque la forma **no es visible desde el nombre**: quien escriba un cliente, un escenario o una aserción contra esa salida tiene que ir al contrato de la llamada (o a la entidad réplica) a mirar los campos, no suponerlos.
- **El campo es siempre opcional en el contrato.** Si la llamada declara `fallback`, o la réplica `onMiss: degrade`, el propio diseño ya está diciendo que el dato puede faltar. Presentarlo como obligatorio prometería lo que él mismo desmiente.
- **Exponerlo en un listado cambia la estrategia correcta.** Con `on-demand`, un `usedBy` que devuelve varios elementos es una llamada al proveedor **por elemento**: `keel validate` lo avisa y nombra la salida, que es `replicated`. Es el mismo criterio que ya gobierna `strategy`, visto desde la salida en vez de desde la decisión.

Sin `exposedAs`, el dato solo sirve para decidir y no sale del servicio. Es el default, y es lo correcto en la mayoría de los casos: un dato ajeno en la respuesta acopla el contrato público al del proveedor.

## `strategy` — dónde vive la verdad que se lee

| | `on-demand` | `replicated` |
|---|---|---|
| Dónde está el dato al decidir | Se pide al proveedor en el momento | En una copia local mantenida por sus eventos |
| Con el proveedor caído | El servicio **no** puede operar | Sigue operando |
| Frescura | Siempre vigente | Eventual: la copia va por detrás |
| Coste por petición | Una llamada de red (N si es un listado) | Ninguno |

Tres preguntas deciden:

1. **Corrección** — ¿la decisión exige el valor vigente en ese instante, o vale una copia reciente? Cobrar exige lo primero; mostrar un catálogo, no.
2. **Disponibilidad** — ¿puede este servicio seguir operando con el proveedor caído, y con qué consecuencia de negocio?
3. **Volumen** — ¿es una consulta por petición, o un listado que exigiría N llamadas?

Es una decisión de **negocio**, no de rendimiento: cambia lo que el servicio puede prometer a sus clientes.

## `replica` — la copia local

La entidad y sus campos se declaran en `domain`; dónde se guarda, en `persistence`. Aquí solo se declara **que esa entidad es una réplica, de quién y cómo se mantiene**.

- `entity` — la entidad de `domain` que materializa la copia. **No es fuente de verdad**: nunca se expone tal cual como recurso propio ni se le atribuyen invariantes de negocio.
- `keyField` — el campo que correlaciona la copia con el identificador del proveedor. Debería ser `unique` (`keel validate` avisa si no lo es: sin unicidad, una reentrega duplica la copia).
- `fedBy` — las suscripciones de `messaging` que la mantienen al día. **Deben cubrir todas las vías de cambio del dato, incluidas bajas y retiradas**: si el proveedor retira un producto y no emites (o no consumes) ese evento, la copia se queda rancia para siempre y nadie se entera.
- `freshness` — la tolerancia de negocio a leer un dato viejo, **en prosa**. Nunca un número: un umbral cuantificado (`maxStalenessSeconds`) es una decisión de implementación, no un hecho del dominio.
- Copia **solo los campos que este servicio lee**. Replicar el agregado ajeno entero acopla tu diseño a decisiones que no controlas.

## `onMiss` — qué pasa cuando no tenemos el dato

Obligatorio en toda réplica: es el hueco más caro de dejar implícito, porque siempre ocurre (arranque en frío, evento aún no llegado, alta recién creada en el proveedor). Cada acción **obliga a declarar su consecuencia de negocio**, y eso es lo que la hace un hecho del dominio y no un botón de configuración.

| `action` | Qué exige | Qué observa el cliente |
|---|---|---|
| `fetch` | `fetchedFrom` en el `need` | Nada: la petición tarda un poco más y el dato llega |
| `fail` | `error`, declarado por alguna operación de `use-cases` | El error de negocio declarado, con su status |
| `degrade` | `degradedTo` en prosa | Un resultado parcial o conservador, descrito ahí |

`degrade` es la opción peligrosa: un resultado degradado que produce datos plausibles pero falsos es peor que fallar. La skill `/keel-validate` lo revisa con el mismo criterio que el `fallback` de `http-clients`.

## `onUnavailable` — qué pasa cuando el proveedor no contesta

La otra mitad de `onMiss`, y durante mucho tiempo la que faltaba. `onMiss` dice qué pasa cuando **la copia** no tiene el dato; `onUnavailable` dice qué pasa cuando **el proveedor** no lo da: la llamada de `fetchedFrom` falla, agota su timeout o encuentra el circuito abierto. Aplica siempre que haya `fetchedFrom` — con `on-demand` es la vía única, y con `replicated` + `onMiss: fetch` es el rescate, que también puede fallar.

Antes de existir, esa política solo se podía escribir como prosa en el `fallback` de la llamada, que vive en `http-clients` — **capa técnica**: describe el mecanismo («devolver el último precio conocido en caché») en vez de la decisión de negocio, y ningún generador puede aplicar una frase. El resultado era que la tomaba quien construía.

| `action` | Qué exige | Qué observa el cliente |
|---|---|---|
| `fail` | `error`, declarado por alguna operación de `usedBy` | El error de negocio declarado, con su status |
| `degrade` | `degradedTo` en prosa | Un resultado parcial o conservador, descrito ahí |
| `lastKnown` | `maxAgeSeconds` **y** `error` | El último valor que este servicio llegó a leer, mientras no supere esa edad; superada, el error declarado |

```yaml
needs:
  currentPrice:
    strategy: on-demand
    usedBy: [getProductBySlug]
    fetchedFrom: { client: pricing, call: getPrice }
    onUnavailable:
      action: lastKnown
      maxAgeSeconds: 900          # 15 minutos: pasado eso, ya no es un precio
      error: PRICE_UNAVAILABLE    # el desenlace cuando no queda nada lo bastante fresco
```

**`maxAgeSeconds` es el único número de esta capa, y entra por su consecuencia.** «Servir el último valor conocido» sin edad máxima no tiene final: un precio de hace tres días se sirve igual que uno de hace un minuto, y nadie decidió eso. Por eso el schema exige los dos campos juntos — la ventana y qué pasa al superarla. No se contradice con `replica.freshness`, que sigue siendo prosa a propósito: allí la antigüedad la produce la latencia de los eventos del proveedor y este servicio no la controla; aquí la ventana la decide y la aplica él, y es observable en su respuesta.

`degrade` es la opción peligrosa, con el mismo criterio de siempre: un resultado que el cliente no puede distinguir del normal no es degradación, es un dato falso.

**Precedencia sobre el `fallback` de la llamada**: con `onUnavailable` declarado, esa es **la** política —es la que el generador aplica—, y el `fallback` de `http-clients` queda como resumen para humanos. Si dicen cosas distintas, la que se construye es esta.

## `activations` — qué trabajo le pide cada caso de uso

Una `activation` es **un trabajo concreto que hace otro servicio**. Se descubre igual que un `need`, recorriendo los casos de uso propios, pero con la otra pregunta: *"¿qué parte de esta operación no es responsabilidad nuestra?"*.

| Campo | Obligatorio | Qué declara |
|---|---|---|
| `triggeredBy` | ✅ | Operaciones de `use-cases` que la disparan. Es el espejo de `usedBy`. |
| `via` | ✅ | El canal: `{ client, call }` de `http-clients`, o `{ publishes: <Evento> }` de `messaging`. |
| `effect` | ✅ | Qué hace el proveedor al recibirla, en lenguaje de negocio. |
| `awaits` | | `outcome`, `acknowledgement` (por defecto) o `nothing`. |
| `onFailure` | con `via` HTTP | Qué hace la operación propia si el encargo no sale. |
| `reconciledBy` | | Operación con `schedule` que barre los encargos que nunca recibieron desenlace. |
| `unansweredAfterSeconds` | con `reconciledBy` | Cuánto silencio de **este** proveedor se tolera antes de que el barrido vuelva a insistir. |
| `awaitingSince` | **obligatorio** con `reconciledBy` | Campo de la entidad que dice **desde cuándo** cuenta ese silencio. El estado dice que espera; esto, cuánto lleva. |

### `via` — por dónde se le pide

- **`{ client, call }`** — la llamada saliente de `http-clients`. Su `request` es donde vive la firma que el proveedor exige; **la fija él, no nosotros**, y por eso una activación sin `contract.version` es una integración contra un contrato que nadie ha fijado.
- **`{ publishes: <Evento> }`** — un evento propio de `messaging: publishing.events`. Es la vía que antes no se podía declarar: el evento se publica **para** que alguien concreto actúe, y su payload existe para cumplir lo que ese alguien exige. El proveedor tiene que declararlo en su lado como `subscriptions.<Evento>` con `nature: request`; si lo consume como `fact`, nadie se ha comprometido a atenderlo y `keel system check` lo reporta.

Un evento-comando **no deja de ser legítimo por serlo**: un servicio genérico (avisos, auditoría, facturación) existe para que le encarguen trabajo, y su puerta de entrada puede ser un mensaje. Lo que no es legítimo es no declararlo, porque entonces el acoplamiento existe y nadie lo ve.

### `awaits` — qué necesita saber la operación propia

| | Qué significa | Consecuencia |
|---|---|---|
| `outcome` | Necesita el resultado del trabajo para continuar | Exige canal síncrono: publicar no devuelve nada |
| `acknowledgement` | Le basta con que el proveedor lo aceptara | El trabajo puede fallar después sin que nos enteremos |
| `nothing` | Se delega y se sigue | El caso del fire-and-forget honesto |

Es una decisión de **negocio**: `acknowledgement` y `nothing` significan que el trabajo puede no llegar a hacerse y que la operación propia dio el visto bueno igualmente. Si eso no es aceptable (un cobro), el `awaits` es `outcome`.

`awaits` describe lo que la operación necesita para **terminar**, no cómo se entera después. Esperar el desenlace por un **evento** que llegará más tarde no es ninguno de los tres valores: es una combinación —publicar el encargo, dejar el agregado en un estado intermedio y suscribirse al evento de resultado— y en ella `awaits` es `acknowledgement`, porque la operación propia sí terminó. Es la forma que necesita `reconciledBy`, y está desarrollada abajo.

### `onFailure` — qué pasa si el encargo no sale

Obligatorio con `via` HTTP, por el mismo motivo que `onMiss` en una réplica: siempre ocurre, y es comportamiento observable en la API propia. `fail` exige el `error` (declarado por alguna operación de `use-cases`), `degrade` exige el `degradedTo` en prosa, e `ignore` no exige nada — pero solo es honesto cuando el negocio de verdad no cuenta con ese trabajo. Con `via: { publishes }` no aplica: la entrega la garantiza `reliability: outbox`.

Y esa última frase es literal: la garantía la da el outbox, no el hecho de publicar. Encargar trabajo por evento con `messaging: publishing.reliability: best-effort` es aviso de `keel validate` — el encargo se puede perder sin dejar rastro aquí ni en el proveedor, y no hay compensación que valga para un trabajo que nunca llegó a pedirse.

### `reconciledBy` — el desenlace en el que no pasa nada

`onFailure` cubre que el encargo **no salga**, y una `compensation` cubre que el proveedor **avise** de que su trabajo no vale. Falta el tercer desenlace, que es el único que no produce ningún hecho: el proveedor acepta el encargo y luego cae, pierde el mensaje, o ni siquiera se entera de que hay que deshacerlo. Entonces no llega ningún evento, nada se dispara, y el encargo queda hecho con nuestra entidad esperando un desenlace que no va a venir. El sistema no está roto: está callado.

**Qué es, en una frase**: un cron que consulta **tu propia base de datos** buscando agregados atascados en un estado de espera, y los desatasca. No es un coordinador distribuido ni un gestor de transacciones; mira tu estado, no el ajeno. Y es un mecanismo aparte porque **no detecta un fallo, detecta una ausencia**: un fallo produce un hecho al que reaccionar —una excepción, un evento—, y una ausencia no produce nada. Lo único que puede ver algo que no ocurrió es algo que corre solo, y de ahí el `schedule`: `keel validate` da error si la operación citada no lo tiene, porque una reconciliación que hay que disparar a mano no reconcilia nada.

#### El requisito: un estado que signifique «esperando»

Esto es lo que decide si la necesitas, y la pregunta es literal: **¿qué estado de mi `lifecycle` significa «esperando»?** Sin uno observable no hay nada que barrer y `reconciledBy` sobra. Depende de **cómo** se encarga el trabajo:

| Forma de encargar | Cómo nos enteramos del desenlace | ¿Reconciliación? |
|---|---|---|
| **Síncrona** — `via: { client }` + `awaits: outcome` | En el acto: la llamada devuelve sí o no | Sí, pero para el silencio **en duda** (abajo) |
| **Publicar y olvidar** — `via: { publishes }` + `awaits: nothing` | Nunca, y el negocio ya dijo que le vale | **No**: no hay nada esperando |
| **Publicar y esperar el desenlace** — `via: { publishes }` **+ suscripción al evento de resultado + estado intermedio** | Por un evento que llega después | **Sí**: es su caso canónico |

La tercera fila **no es un valor de `awaits`**: es una combinación que se declara en cuatro sitios. El encargo sale publicado, el agregado se queda en un estado como `awaitingStock`, y una suscripción a `StockReserved` / `StockRejected` lo saca de ahí. Si no llega ninguno de los dos, se queda ahí para siempre — sin excepción, sin log de error, sin alarma— y eso es exactamente lo que el barrido busca.

#### El cuarto sitio: desde cuándo espera

El estado dice **que** espera; el barrido necesita saber **desde cuándo**, porque `status = 'awaitingStock'` incluye lo que empezó hace tres segundos. Hace falta una marca temporal, y las dos obvias no sirven:

- **`createdAt` es cuándo nació la entidad, no cuándo entró en la espera.** Una reserva se crea y se confirma después: pueden pasar horas. Un barrido que mire `createdAt` cancelaría un encargo hecho hace treinta segundos.
- **`updatedAt` rejuvenece.** Cualquier otra escritura durante la espera la deja pareciendo fresca, y el barrido **nunca la alcanza**: se queda esperando para siempre. Es el fallo que pasa las pruebas —donde nada más toca la entidad— y falla en producción.

Lo único que dice la verdad es un **campo propio**, estampado al entrar en la espera por la operación que encarga y que nadie más toca. Suele ser interno: se declara en `domain` y se deja fuera de las respuestas con `exclude`, porque es un marcador operativo y no algo que el cliente necesite.

**Cuál es ese campo lo dice la activación, en `awaitingSince`, y es obligatorio junto a `reconciledBy`:**

```yaml
reserveStock:
  reconciledBy: reconcileReservations
  unansweredAfterSeconds: 1800
  awaitingSince: reserveStockAwaitingSince
```

`keel validate` comprueba lo que se puede comprobar: que el campo exista en la entidad que queda esperando, que sea `timestamp` y que no lo gestione la auditoría —un `updatedAt` automático rejuvenece con cualquier escritura y deja la entidad invisible al barrido para siempre—. Con `createdAt` avisa, porque solo es correcto si la entidad entra en la espera al crearse. Lo que no puede comprobar —quién estampa el campo y si es el momento correcto— se queda para la revisión semántica de `/keel-validate`.

El nombre sigue teniendo su convención, y ahora es una **recomendación** en vez del mecanismo: **derivarlo de la activación**, `<activacion>AwaitingSince`, es decir `reserveStockAwaitingSince` para la activación `reserveStock`. Las dos mitades hacen trabajos distintos y por eso ninguna sobra: el prefijo dice **de qué espera** es la marca, y el sufijo fijo dice **qué es** —el inicio de un intervalo abierto, que es justo como la usa el barrido (`… < now - umbral`)— y la hace reconocible por forma para quien la busque después.

Lo que compra el prefijo es concreto: una misma entidad puede quedar esperando **dos desenlaces distintos** —dos activaciones, quizá de dos proveedores, cada una con su `reconciledBy`— y con un campo `awaitingSince` compartido el segundo encargo pisa la marca del primero. A partir de ahí cada barrido ve candidatos del otro y su umbral mide una espera que no es la suya. Un nombre genérico solo es seguro mientras la entidad espere una sola cosa, que es exactamente la condición que nadie recuerda al añadir la segunda activación.

Y declarar la marca no termina el trabajo: el par (estado, marca) es un **predicado que se ejecuta cada N minutos** sobre una tabla de negocio, así que quiere su índice compuesto en `persistence: entities.<E>.indexes`. Es el único patrón de consulta frecuente que no se ve mirando `use-cases`, y por eso está desarrollado en la referencia de esa capa.

#### Tres silencios, tres barridos

Confundirlos es lo que hace el concepto resbaladizo, porque cada uno busca algo distinto:

| Silencio | Cuándo ocurre | Qué barre |
|---|---|---|
| **Esperando** | El desenlace por evento no llegó nunca | Lo parado en el estado de espera. Es el canónico |
| **En duda** | La llamada síncrona dio timeout **después** de que el proveedor confirmara: nosotros revertimos, él no | Lo que **no** avanzó de nuestro lado y aun así pudo dejar trabajo hecho fuera |
| **Deriva** | Los dos lados creen cosas distintas y ningún evento lo va a decir nunca | Se vuelve a preguntar. Es auditoría periódica, no reconciliación de un encargo concreto |

Qué hace con lo que encuentra (reintentar el encargo, compensarlo o rendirse) es decisión de negocio, y el umbral de «demasiado tiempo» es configuración del servicio generado, nunca una constante en el código.

Una frontera que conviene tener presente al diseñar aunque no se declare aquí: **el barrido corre en todas las réplicas del servicio**, porque un `schedule` es «cada N minutos en cada instancia», no «cada N minutos en el clúster». Cómo se reparte el trabajo entre ellas —reclamar lotes disjuntos, un lock distribuido— es del generador y no del diseño, pero lo que sí es del diseño es no dar por hecho que el barrido se ejecuta una sola vez.

Existir, correr por el reloj y no ser una lectura son la **forma** del barrido. Lo que lo hace un barrido *de esto* es estar enlazado con lo que reconcilia, y son las mismas salidas que hay que decidir de todos modos —reintentar el encargo, compensarlo o rendirse—; basta con una:

- **Mueve el lifecycle** de alguna entidad que el encargo dejó esperando: se rinde y la saca de ahí.
- **Encarga algo a ese mismo proveedor**, y da igual cuál de las dos cosas: aparecer en el `triggeredBy` de la activación reconciliada es reintentar el encargo, y en el de la activación de vuelta es compensarlo.

Sin ninguna es aviso, y no es formalismo: `triggeredBy` y `transitions` son el único enlace del DSL entre una operación y lo que hace, así que el generador escribe un barrido sin cliente que llamar ni estado que mover. Un `schedule` que no toca nada pasa las tres comprobaciones de forma y no reconcilia nada — y como es la pata del silencio, nadie se entera nunca. Encargarle algo a **otro** proveedor (dejar constancia en un registro de incidencias) no cuenta: documenta el problema, no lo reconcilia.

Una compensación **sin** `reconciledBy` en la activación que deshace es aviso: toda ella cuelga de que llegue un mensaje, y hay un final en el que no llega.

## `compensations`

Eventos ante los que este servicio **deshace lo que hizo contra el proveedor** (una reserva que no llegó a cobrarse, un envío que se anuló). Aquí solo se declara **el hecho y contra quién**: la operación que se ejecuta vive en `messaging: subscriptions.<evento>.triggers`, y no se repite.

`undoes` cita la `activation` que se revierte, y es lo que cierra el par hacer/deshacer: si lo que se compensa es un trabajo que le encargamos a otro, ese encargo debería estar declarado. Solo puede citar una activación **de este mismo proveedor**: compensar el trabajo de tres servidores son tres bloques.

**Omitirlo es error mientras la dependencia tenga activaciones**, y no por formalismo: sin saber qué encargo se deshace, quedan sin evaluar las cuatro comprobaciones que hacen que una compensación sea algo más que una suscripción con buen nombre —el estado de vuelta, el alcance al proveedor, la reconciliación del desenlace silencioso y la saga incompleta—. Un aviso que apaga media sección de validación no está proporcionado al daño.

En el **mapa del sistema**, una compensación son dos aristas hacia el mismo proveedor: `invokes` por la activación, y `consumes` con `kind: events` por el evento que la deshace. No es contradicción de dirección (esa salta cuando el otro declara consumir de nosotros) ni fabrica un ciclo: las dos apuntan en el mismo sentido. Sin la segunda, `keel system check` reporta la suscripción como una fuente que el mapa no contempla.

### De quién es la compensación

**Quien encarga el trabajo es quien lo deshace.** No es una convención: es dónde vive el campo. `compensations` cuelga de `dependencies.<proveedor>` en el diseño **del que llama**, nunca en el del proveedor. El proveedor no sabe por qué le pidieron el trabajo, así que no puede saber cuándo deja de valer.

Lo que sí cambia según el caso es **cuánto de la compensación cruza el cable**, y lo decide una sola pregunta: *¿quién publica el fallo?*

| Quién lo publica | Qué sabe el proveedor | Qué hace la compensación |
|---|---|---|
| **El proveedor** (`StockRejected` de `inventory`) | Que su trabajo no vale: rechazarlo y anunciarlo son el mismo acto | Solo devolver el **estado propio**. Pedirle además que lo deshaga es hablar de más |
| **Un tercero** (`PaymentFailed` de `payments`) | Nada: sigue creyendo que su encargo está en pie | Devolver el estado propio **y** encargarle la vuelta — una `activation` más hacia él. `keel validate` avisa si falta |

El segundo caso es el más común, y conviene verlo entero. `orders` confirma un pedido y encarga stock a `inventory`; el pago falla después, en `payments`:

```yaml
# orders/messaging.keel.yaml
subscriptions:
  PaymentFailed:              # nature: fact — payments no sabe que existimos
    source: payments
    triggers: releaseOrderStock
    contract: { messageId: { location: field, name: eventId } }
    onFailure: { retry: { maxAttempts: 5, backoff: exponential }, deadLetter: true }

# orders/dependencies.keel.yaml
dependencies:
  inventory:
    activations:
      reserveStock:
        triggeredBy: [confirmOrder]
        via: { publishes: ReserveStockRequested }
        reconciledBy: sweepPendingReservations
        unansweredAfterSeconds: 1800
        awaitingSince: reserveStockAwaitingSince
      releaseStock:                          # la activación de VUELTA
        triggeredBy: [releaseOrderStock]
        via: { publishes: ReleaseStockRequested }
    compensations:
      - onEvent: PaymentFailed               # de payments, no de inventory
        undoes: reserveStock
```

`inventory` recibe `ReleaseStockRequested` como una suscripción `nature: request` —su payload es contrato público de entrada suyo— y **nunca se entera de que existe un pago**.

**Por qué no al revés.** Que `inventory` se suscriba a `PaymentFailed` parece un salto menos, y es el error que más caro sale:

- Pasaría a depender de `payments` sin ninguna razón de negocio: su responsabilidad es *quién tiene qué stock*, no *por qué*.
- No escala. Cada llamante tiene sus propios modos de fallo, y mañana serían `ShipmentCancelled` y `FraudDetected`: `inventory` acabaría siendo el sitio donde vive el workflow de todos sus consumidores.
- Para liberar **la reserva correcta**, el `PaymentFailed` tendría que traer su identidad — o sea, `payments` tendría que saber que existe un stock reservado.
- **La política no es suya.** Un pago fallido no siempre libera: puede haber ventana de reintento. Eso lo decide `orders`.

**Dos deduplicaciones, no una.** Se olvida casi siempre: `orders` tiene que sobrevivir a que le reentreguen `PaymentFailed`, e `inventory` a que le reentreguen `ReleaseStockRequested`. Son dos registros distintos en dos servicios distintos, y resolver solo el primero deja la mitad del camino abierta.

**Evento antes que llamada síncrona.** Para la vuelta, `via: { publishes }` es preferible a `via: { client }`: la liberación tiene que acabar ocurriendo, y el outbox se lo garantiza sin que `orders` dependa de que `inventory` esté vivo justo cuando algo ya está fallando. El precio es que no hay `onFailure` ni desenlace, así que el `reconciledBy` de la activación pesa más: se publicó la liberación y no vuelve nada.

### Las dos obligaciones de una compensación

Una compensación es el punto del diseño donde un fallo silencioso cuesta más caro: se ejecuta ante un evento de fallo, por un canal **at-least-once**, y deshace trabajo real. Por eso no basta con que las referencias existan, y `keel validate` exige dos cosas más de la operación que la ejecuta.

**No poder aplicarse dos veces (error).** Deshacer dos veces el mismo trabajo no es deshacerlo: es liberar el stock de otro o reembolsar dos veces. Vale cualquiera de los dos mecanismos, porque cortan el doble efecto en un sitio distinto:

| Mecanismo | Dónde se declara | Dónde corta | Alcance |
|---|---|---|---|
| `contract.messageId` | `messaging: subscriptions.<E>.contract` | antes del dominio, deduplicando el mensaje | solo el camino de eventos |
| `transitions` | `use-cases.<op>` | en el dominio: una transición cuyo `to` no está entre sus `from` es irrepetible | **cualquier camino** |

Sobre un canal `external: true` el guard de lifecycle **a solas** es aviso: sin envoltura Keel no hay id de mensaje por defecto con el que deduplicar antes, así que cada reentrega normal llega al dominio, sale rechazada y acaba en la cola de descartes. Funciona, pero convierte lo normal en ruido.

**Guarda de puerta y guarda de dominio.** Esa columna «Alcance» es la diferencia que más se pasa por alto. `contract.messageId` deduplica en el listener y la `idempotency` HTTP en el filtro: cada una cierra **su** puerta y no sabe de la otra —son dos registros con espacios de clave distintos, uno por listener e id de mensaje y otro por operación y clave del cliente—. La transición, en cambio, vive dentro del agregado, por debajo de las dos.

Por eso, si la operación de la compensación **además** está expuesta por HTTP —un operador que la reejecuta a mano tras revisar el caso—, deduplicar el mensaje deja el otro camino abierto, y `keel validate` lo da en **rojo**: ahí hace falta la transición. Añadir `idempotency` no lo arregla, y conviene entender por qué: sin cabecera `Idempotency-Key` la operación se ejecuta **sin deduplicar**, y quien la reejecuta a mano es precisamente el llamante que no la manda (con `keySource: payload-field` la clave va en el cuerpo y esto no aplica). En una compensación, `transitions` no es una alternativa más entre las dos: es la única que no depende de por dónde entre la ejecución.

**Por qué `use-cases.<op>.idempotency` no está en esa tabla.** Con `keySource: client-key` es el mecanismo del **otro eje de repetición**: el reintento de un llamante HTTP que reenvía su clave en la cabecera `Idempotency-Key`. El broker no manda esa cabecera, así que en el camino de un evento esa clave no existe y declararla no impide nada. (Con `keySource: payload-field` la clave es un campo del propio contrato y sí llega por el canal de eventos — pero entonces ya no estamos ante dos mecanismos separados sino ante uno solo que cubre las dos puertas.) No es un matiz de implementación: son dos mecanismos separados, con dos tablas distintas —`processed_event`, que escribe el consumidor de mensajes, frente a `idempotency_record`, que escribe la superficie HTTP—, y por eso `keel validate` no acepta el segundo como prueba del primero. Declarar `idempotency` en una operación que no tiene endpoint es directamente error: la clave llega por una puerta que esa operación no tiene.

**Tener sus dos escenarios (aviso).** `docs/validation-scenarios.md` exige que toda compensación lleve dos: el efecto completo y la **reentrega** del mismo evento sin segundo efecto. `keel validate` lo comprueba —es la única regla mecánica que lee `validation-scenarios.md`— buscando escenarios que mencionen el `onEvent` y, entre ellos, uno que reentregue. Existe porque ese documento era la única parte del diseño que nada cruzaba con el resto: es prosa, y el gate del generador solo puntúa lo que el documento declara, así que un escenario que falta no lo echaba de menos nadie por ningún lado. Es una lectura de texto, así que avisa diciendo «no encuentro», no «no existe».

**Tener un final cuando no llega nada (aviso).** Ver `reconciledBy` arriba: sin él, la compensación entera depende de un mensaje que puede no llegar nunca. Y si la suscripción manda a la DLQ lo que no logra procesar, hay un aviso más: lo que caiga ahí necesita una vía declarada de reejecución —el endpoint HTTP de la operación (con su guarda de dominio) o el barrido de reconciliación—, o el final del mensaje es que alguien lo note.

**Sobrevivir a llegar fuera de orden (error).** Entre que este servicio confirma su trabajo y que el proveedor publica su fallo no hay ninguna garantía de orden: el evento de compensación puede llegar **antes** del hecho que compensa. Y entonces se rechaza —la transición no sale de un estado al que todavía no se ha llegado—, así que lo que decide el desenlace es la política de la suscripción. Sin `onFailure.retry` ni `deadLetter` el mensaje se pierde en silencio, y lo que se pierde es justo lo que deshace trabajo real contra otro servidor. Con `deadLetter` pero sin reintentos es aviso: se salva el mensaje, pero exige intervención manual para una carrera que unos reintentos con backoff resolverían solos.

**Devolver el estado propio (aviso fuerte).** Si las operaciones que disparan la activación que se deshace mueven el `lifecycle` de una entidad y la operación compensadora no declara ninguna `transition` sobre ella, el trabajo se deshace contra el proveedor y la entidad se queda en el estado que le puso un trabajo que ya no existe. La pregunta que hay que responder es literal: *¿a qué estado vuelve?* — y la respuesta se escribe en `use-cases.<op>.transitions`, donde además se comprueba que esa vuelta sea una arista que el `lifecycle` declara. Es el fallo más caro de los dos, porque el diseño valida en verde y el guard del generador rechaza la compensación **en cada ejecución**.

**Y a qué estado se vuelve (aviso).** Declarar la transición de vuelta no cierra la pregunta si el destino es un estado **terminal** —uno del que el `lifecycle` no deja salir—: la entidad queda parada ahí para siempre y el trabajo que se acaba de deshacer no se puede volver a encargar. A veces es exactamente lo correcto (`cancelled` y `refunded` son desenlaces, no callejones), así que `keel validate` solo pone el dato encima de la mesa; distinguir un desenlace de un callejón es juicio semántico y lo hace `/keel-validate`.

## Qué comprueba `keel validate`

**Errores** — `usedBy` o `triggeredBy` hacia una operación inexistente · `fetchedFrom` o `via` hacia un cliente o una llamada que no existen en `http-clients` · `via.publishes` hacia un evento que no está en `messaging: publishing.events` · `awaits: outcome` sobre un `via` de evento (publicar no devuelve resultado) · `replica.entity` que no existe en `domain` · `replica.keyField` que no es campo de esa entidad · `replica` sin capa `persistence` (también con `--wip`: una copia necesita dónde guardarse) · `fedBy` o `compensations.onEvent` hacia un evento que no está en `messaging: subscriptions` · `compensations.undoes` hacia una activación inexistente · compensación **sin** `undoes` habiendo activaciones en esa dependencia (apaga en cascada las cuatro comprobaciones que dependen de saber qué encargo se deshace) · compensación cuya operación disparada es `kind: query` (una lectura no deshace nada) · compensación cuya operación no está protegida por **ninguno** de los dos mecanismos que impiden aplicarla dos veces · compensación cuya operación también se expone por HTTP y solo declara `contract.messageId` (una guarda de puerta no cubre el otro camino) · compensación cuya suscripción no reintenta ni tiene `deadLetter` (una llegada fuera de orden se pierde) · `onMiss.error`, `onUnavailable.error` u `onFailure.error` que ninguna operación declara · `reconciledBy` hacia una operación inexistente, sin `schedule` o `kind: query`.

**Avisos** — `need` con `fetchedFrom` que no declara `onUnavailable` (nadie ha dicho qué ve el cliente con el proveedor caído, y el `fallback` de la llamada es prosa técnica) · `reconciledBy` sin `unansweredAfterSeconds` (el barrido necesita el umbral para elegir candidatos: sin declararlo lo fija quien construya) · compensación cuya operación no devuelve el estado que movió el trabajo encargado · compensación que devuelve la entidad a un estado **terminal** del `lifecycle` (¿desenlace o callejón?) · compensación sin escenarios suyos en `validation-scenarios.md`, o con el del efecto pero sin el de **reentrega** · `reconciledBy` que no mueve el lifecycle de lo que quedó esperando ni encarga nada a ese proveedor —ni reintentar ni compensar— (un barrido que no toca lo que barre) · encargo por `via: { publishes }` con `publishing.reliability: best-effort` (el encargo se puede perder y no hay nada que compensar) · activación compensada sin `reconciledBy` (nada detecta el desenlace que no llega) · operación que encarga trabajo a **varios** proveedores declarando compensación solo para algunos (la saga incompleta) · compensación con `deadLetter` cuya operación no se expone por HTTP ni se reconcilia (la DLQ sin vía de reejecución) · compensación disparada por un evento de un tercero cuya operación no tiene por dónde avisar al proveedor · compensación con `deadLetter` pero sin reintentos · compensación sobre un canal `external` cuya única protección es el guard de lifecycle · la entidad de la réplica no está en `persistence: entities` · `keyField` sin `unique` · la suscripción citada declara un `source` distinto del nombre de la dependencia · `onMiss.error` declarado por una operación ajena a `usedBy` (y lo mismo con `onUnavailable.error`, y con `onFailure.error` y `triggeredBy`) · dos needs replicando la misma entidad · un cliente de `http-clients` que ningún need ni activación usa · una suscripción `fact` cuyo `source` no está declarado como dependencia (una `request` no: quien nos activa no es una dependencia nuestra).

Con `--wip`, las referencias a capas aún no diseñadas (`http-clients`, `messaging`) quedan como pendientes.

La skill `/keel-validate` añade lo que ninguna regla mecánica ve: si `fedBy` cubre la baja del recurso, si el `degradedTo` es aceptable, si un `on-demand` o una activación ocurren dentro de una transacción de escritura, si la réplica copia campos que nadie lee, y si un `onFailure: ignore` o un `awaits: nothing` dan por hecho un trabajo con el que el negocio sí cuenta.

## Qué NO va aquí

- Método, ruta, timeout, retry, circuit breaker y autenticación de la llamada → capa `http-clients`.
- Payload, contrato de recepción (`envelope`, `messageId`, `discriminator`), retry y DLQ del evento, y la operación que dispara → capa `messaging`.
- Los campos de la copia, su tipo y sus constraints → capa `domain`.
- Dónde y cómo se guarda la copia, sus índices → capa `persistence`.
- El error de negocio en sí (su `when`, su `http`) → `use-cases: errors` de la operación.
- Quién nos consume **a nosotros** → `security: serviceClients` (y el `INTEGRATION.md` que produce `/keel-integrate`).
- TTL de refresco, tamaño de lote, cron de rehidratación, umbrales de antigüedad → **generador**. Son decisiones de solución.
- Credenciales, URLs de entorno y `basePath` del proveedor.
