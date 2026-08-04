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
| `fetchedFrom` | según estrategia | Llamada de `http-clients` que resuelve el dato: `{ client, call }`. |
| `replica` | con `replicated` | La copia local (ver abajo). |

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

## `activations` — qué trabajo le pide cada caso de uso

Una `activation` es **un trabajo concreto que hace otro servicio**. Se descubre igual que un `need`, recorriendo los casos de uso propios, pero con la otra pregunta: *"¿qué parte de esta operación no es responsabilidad nuestra?"*.

| Campo | Obligatorio | Qué declara |
|---|---|---|
| `triggeredBy` | ✅ | Operaciones de `use-cases` que la disparan. Es el espejo de `usedBy`. |
| `via` | ✅ | El canal: `{ client, call }` de `http-clients`, o `{ publishes: <Evento> }` de `messaging`. |
| `effect` | ✅ | Qué hace el proveedor al recibirla, en lenguaje de negocio. |
| `awaits` | | `outcome`, `acknowledgement` (por defecto) o `nothing`. |
| `onFailure` | con `via` HTTP | Qué hace la operación propia si el encargo no sale. |

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

### `onFailure` — qué pasa si el encargo no sale

Obligatorio con `via` HTTP, por el mismo motivo que `onMiss` en una réplica: siempre ocurre, y es comportamiento observable en la API propia. `fail` exige el `error` (declarado por alguna operación de `use-cases`), `degrade` exige el `degradedTo` en prosa, e `ignore` no exige nada — pero solo es honesto cuando el negocio de verdad no cuenta con ese trabajo. Con `via: { publishes }` no aplica: la entrega la garantiza `reliability: outbox`.

## `compensations`

Eventos ante los que este servicio **deshace lo que hizo contra el proveedor** (una reserva que no llegó a cobrarse, un envío que se anuló). Aquí solo se declara **el hecho y contra quién**: la operación que se ejecuta vive en `messaging: subscriptions.<evento>.triggers`, y no se repite.

`undoes` cita la `activation` que se revierte, y es lo que cierra el par hacer/deshacer: si lo que se compensa es un trabajo que le encargamos a otro, ese encargo debería estar declarado.

## Qué comprueba `keel validate`

**Errores** — `usedBy` o `triggeredBy` hacia una operación inexistente · `fetchedFrom` o `via` hacia un cliente o una llamada que no existen en `http-clients` · `via.publishes` hacia un evento que no está en `messaging: publishing.events` · `awaits: outcome` sobre un `via` de evento (publicar no devuelve resultado) · `replica.entity` que no existe en `domain` · `replica.keyField` que no es campo de esa entidad · `replica` sin capa `persistence` (también con `--wip`: una copia necesita dónde guardarse) · `fedBy` o `compensations.onEvent` hacia un evento que no está en `messaging: subscriptions` · `compensations.undoes` hacia una activación inexistente · `onMiss.error` u `onFailure.error` que ninguna operación declara.

**Avisos** — la entidad de la réplica no está en `persistence: entities` · `keyField` sin `unique` · la suscripción citada declara un `source` distinto del nombre de la dependencia · `onMiss.error` declarado por una operación ajena a `usedBy` (y lo mismo con `onFailure.error` y `triggeredBy`) · dos needs replicando la misma entidad · un cliente de `http-clients` que ningún need ni activación usa · una suscripción `fact` cuyo `source` no está declarado como dependencia (una `request` no: quien nos activa no es una dependencia nuestra).

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
