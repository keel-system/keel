# Evaluación del DSL 2.24: lo que la industria pide y el diseño todavía no puede decir

Fecha: 2026-11-06 · Alcance: `keel-core/assets/core` (schemas y `docs/dsl/`), DSL 2.24 · Naturaleza: **evaluación con
recomendaciones justificadas**. No es un plan: no fija orden de ejecución ni incrementos, y ninguna propuesta está
lista para entrar tal cual.

## 1. Cómo leer este documento

Cada recomendación se mide con la regla que el propio DSL se impone (`dsl-reference.md` § Evolución del DSL):

> *¿Esto es verdad sobre el servicio aunque nadie lo construya jamás?*

Si la respuesta es sí, el hecho puede ir al DSL; si es una decisión de cómo se construye, va al generador. Por eso
cada propuesta tiene un apartado **Qué no entra**, que importa tanto como el que sí entra.

Para cada escenario se describe cómo se rompe hoy el diseño. Hay tres formas, ordenadas de menos a más grave:

- **Prosa**: el hecho se puede escribir, pero solo en una `rule`, una `description` o una invariante. El generador no
  lee prosa, así que lo implementa un agente en cada corrida, y dos generadores pueden implementarlo distinto. Es el
  patrón que destapó la divergencia spring/nest de 2.20.
- **Defecto silencioso**: el servidor generado se comporta mal sin que falle ningún escenario ni ninguna validación.
- **Inexpresable**: no hay forma de que el diseño lo diga, ni siquiera en prosa coherente con el resto.

**Sobre la evidencia.** Todos los primitivos del historial (2.1–2.24) entraron porque una corrida o un legacy los
pidió. Aquí la fuente es otra: escenarios habituales de la industria, cruzados con el DSL. Cuando el repo ya tiene
evidencia (fronteras `F-*` de keel-recover, `designGaps` de corridas, límites escritos en la propia referencia) se
cita. Cuando no la tiene, la propuesta es una hipótesis. Habría que confirmarla con un diseño real antes de admitirla,
igual que `payments.md` § «Lo que no entra (todavía)» exige contrastar una forma con más de una pasarela.

## 2. Qué cubre ya el DSL (y por qué no se propone)

El DSL 2.24 es maduro en un eje concreto: **la corrección de los efectos ante repetición, fallo y concurrencia de
escritura**. Hay que decirlo antes de pedirle más:

| Área | Primitivos | Valoración |
|---|---|---|
| Repetición | `idempotency` (tres `keySource`, `partitionBy`, `storedIn`), `contract.messageId`, `http-clients.calls.idempotency` | Los tres ejes de repetición, separados y con su guarda derivada. Mejor que la mayoría de lo que se ve en la industria |
| Entrega fiable | `publishing.reliability: outbox`, `onFailure` (`retry`, `deadLetter`, `acknowledgeOn`) | Completo |
| Trabajo delegado | `dependencies.activations` (`awaits`, `onFailure`, `reconciledBy`, `awaitingSince`, `unansweredAfterSeconds`), `compensations` | Sagas coreografiadas con reconciliación obligatoria |
| Estado | `lifecycle` + `use-cases.transitions` + `stalledAfter` | Máquina de estados contrastada en las dos direcciones |
| Unicidad | `naturalKey`, `indexes` con `when`, `naturalKeyError`, `indexes[].error` | Incluye unicidad condicionada al estado |
| Escritura concurrente en el servidor | `optimisticLocking` (`all` / `declared` / `none`) | Bien decidido, pero solo dentro del servidor (ver R1) |
| Autorización | `access`, `scoping`, `ownership`, `callerIdentity`, `serviceClients` | Fuerte en escritura y en la puerta; débil en lectura (ver R3) |
| Lectura | `embed`, `sort`, `filter`/`where` (2.22), `cache` con invalidación | Cubre el caso común; quedan fuera `in`, `ne`, la búsqueda libre y el orden que elige el cliente (ver R8) |
| Integración | `dependencies.needs` (`strategy`, `replica`, `onMiss`, `onUnavailable`, `exposedAs`), `http-clients`, `nature: fact\|request` | Completo para servicio a servicio |
| Capacidades | `storage`, `mail`, `payments` | Neutrales respecto del proveedor |
| Contrato del cable | `wire-contract.md`, `conventions.nulls`, `scalePolicy`, `compare`/`match` | Determinista y medido en los cuatro generadores |

**Dónde están los huecos.** La mayoría cae en cuatro familias que el método todavía no ha recorrido con una corrida:

1. **El tiempo como causa**: cosas que pasan porque pasó un plazo, no porque alguien llamó.
2. **La autorización en lectura**: qué filas ve cada uno, y no solo qué operaciones puede ejecutar.
3. **El ciclo de vida del dato**: borrado, retención, datos personales e historial.
4. **La evolución del contrato**: cómo cambia un servicio que ya tiene consumidores.

## 3. Resumen

Prioridad = cuánto daño evita × con qué frecuencia aparece el escenario. Coste = impacto aproximado sobre keel-core más
los cuatro generadores (S: un emisor neutral y notas; M: emisores por generador y redes en vivo; L: capa o mecanismo
nuevo con sus checks).

| # | Recomendación | Escenario típico | Hoy | Prioridad | Coste |
|---|---|---|---|---|---|
| R1 | Concurrencia optimista de extremo a extremo | Dos personas editan la misma ficha | Defecto silencioso | **Alta** | M |
| R2 | Plazos de negocio sobre el estado | Reserva que caduca a los 15 min | Prosa + carrera silenciosa | **Alta** | M |
| R3 | Autorización a nivel de fila en lectura | Multiinquilino, «mis pedidos», lecturas personalizadas | Prosa por operación; dos `F-*` | **Alta** | L |
| R4 | Ciclo de vida del dato | Borrado lógico, retención, RGPD | Inexpresable | **Alta** | L |
| R5 | Lotes con resultado por elemento | Importar 500 filas y que fallen 3 | Inexpresable | Media | M |
| R6 | Tipos suma (variantes discriminadas) | Medio de pago tarjeta \| transferencia | Prosa o `json` opaco | Media | M |
| R7 | Invariantes entre campos y derivados, con vocabulario cerrado | `endDate > startDate`, `total = Σ líneas` | Prosa | Media | M |
| R8 | Búsqueda: `in`/`ne`, texto libre, orden elegido por el cliente, cursor | Listados de back-office | Parcial; `cursor` sin significado | Media | M |
| R9 | Evolución del contrato: deprecación y versión de eventos | Retirar un endpoint o el campo de un evento | Inexpresable | Media | M |
| R10 | Orden de eventos por clave | Los eventos de un pedido llegan en orden | Implícito | Media-baja | S |
| R11 | Webhooks salientes | Notificar por HTTP a sistemas de clientes | Inexpresable | Media | L |
| R12 | Historial de cambios consultable | Auditoría regulatoria | Inexpresable | Media-baja | M |
| R13 | Subida directa al almacenamiento | Archivos grandes | Inexpresable | Media-baja | M |
| R14 | Tipos temporales (`time`, `duration`) y zona | Horarios, SLA | Prosa o `string` | Baja | S |
| R15 | Cuotas de negocio por plan | Plan gratuito con límite mensual | Inexpresable | Baja | M |
| R16 | Notificaciones por otros canales (SMS, push) | Avisos al usuario | Inexpresable | Baja | L |
| R17 | Contenido localizado | Catálogo en varios idiomas | Prosa | Baja | M |

---

## 4. Prioridad alta

### R1. Concurrencia optimista de extremo a extremo

**Escenario.** Ana abre la ficha de un producto a las 10:00. Luis cambia el precio a las 10:02. Ana guarda la
descripción a las 10:05 con el formulario que cargó a las 10:00, y el precio de Luis desaparece. Es el problema de la
*actualización perdida* y se da en cualquier back-office, CRM o editor colaborativo. El estándar HTTP lo resuelve con
peticiones condicionales: `ETag` en la lectura, `If-Match` en la escritura, `412 Precondition Failed` y
`428 Precondition Required`.

**Hoy: defecto silencioso.** `optimisticLocking: all` protege de dos transacciones que se cruzan **dentro** del
servidor. No protege del caso anterior, que ocurre entre dos peticiones: la versión no viaja al cliente (con `all` la
pone la infraestructura y no está en el contrato) y, aunque viajara con `declared`, `lockVersion` es
`generated: true`, así que el cliente nunca la puede mandar de vuelta. El PUT de Ana carga la versión actual, que es
la de Luis, y confirma. Ningún escenario lo detecta, porque el conflicto que afirman los escenarios es el de dos
escrituras simultáneas. La referencia promete que con `all`, perder una edición ajena «es un conflicto, no un éxito
silencioso», pero solo se cumple dentro de la ventana de una transacción.

**Propuesta.**

```yaml
# api.keel.yaml
concurrency:
  conditionalWrites: required      # none (default) | optional | required
  operations: [updateProduct, retireProduct]   # escrituras sobre raíces con versión
```

- Las lecturas por id de esas raíces devuelven `ETag`. Las escrituras de la lista aceptan `If-Match`: si no coincide,
  `412`; si falta y la política es `required`, `428`.
- Los dos códigos entran en la lista cerrada de `framework-errors.md` (`PRECONDITION_FAILED` y
  `PRECONDITION_REQUIRED`), con su override por `errors` como los demás.
- La puerta por eventos no tiene lectura previa del cliente, así que no aplica. Si una operación por evento necesita
  versión esperada, eso es un campo de su input y ya es expresable.

**Test de admisión.** «Quien guarda un formulario viejo no pisa los cambios de otro, y recibe 412» es un contrato
con el cliente, igual que un `code` de error. Cómo se calcula el ETag (versión, hash o débil/fuerte) es del generador.

**Validación mecánica posible.** Un `CHK` que dé error si la operación escribe sobre una raíz sin versión
(`optimisticLocking: none` o `declared` sin `lockVersion`). Una `OBL` para un `PUT`/`PATCH` sobre una raíz con
versión, en un servicio con `audience: users`, que no diga nada: es una decisión sin default seguro.

**Valor.** Cierra el único hueco de corrección del eje de concurrencia, que es el que mejor cubre el método. Además
convierte en contrato algo que hoy el agente no puede improvisar, porque el DSL le prohíbe aceptar `lockVersion` del
cliente.

**Qué no entra.** El formato del ETag, los ETag débiles y el `If-None-Match` para caché de lectura (`304`), que es
optimización y no corrección.

---

### R2. Plazos de negocio sobre el estado

**Escenario.** Una reserva de stock caduca a los 15 minutos si no se paga. Una invitación caduca a los 7 días. Un
carrito se abandona a las 24 horas. Una oferta vence en su fecha. Un código de verificación vale 10 minutos. Es de lo
más común en comercio, *ticketing*, identidad y logística.

**Hoy: prosa, más una carrera silenciosa.** El DSL tiene tres relojes, y los tres son de **mecánica de recuperación**:

- `stalledAfter`: rescata una fila que una réplica dejó en vuelo.
- `reconciledBy` con `awaitingSince` y `unansweredAfterSeconds`: detecta un proveedor que no contestó.
- El reclamo con caducidad, que pone el generador.

Ninguno modela un **plazo de negocio**: que el paso del tiempo sea, por sí mismo, la causa de una transición. Hoy se
escribe como un `schedule` con `transitions` y una `rule` del tipo «expira las reservas `held` con más de 15
minutos». Funciona, con dos defectos:

1. El plazo vive en prosa (el mismo problema que cerró 2.18 para `stalledAfter`).
2. **La carrera entre el barrido y la acción tardía queda sin decidir.** A los 15 min y 30 s el barrido aún no ha
   pasado y el cliente llama a `confirmReservation`. El guard del `lifecycle` ve `held → confirmed` como legal y
   confirma una reserva que el negocio daba por caducada. Lo mismo ocurre en la lectura: `getReservation` devuelve
   `held` cuando ya no lo es. Que el barrido pase cada minuto o cada hora cambia el contrato, y nadie lo ha decidido.

**Propuesta.** El plazo se declara junto a la máquina de estados, que es donde vive lo que es legal:

```yaml
# domain.keel.yaml
lifecycle:
  field: status
  transitions:
    held: [confirmed, expired]
  deadlines:
    held:
      after: { parameter: holdMinutes, unit: minutes }   # mismo enlace que stalledAfter
      since: heldAt                                      # campo timestamp de la entidad
      to: expired
      lateAction: { error: RESERVATION_EXPIRED }         # salir de held pasado el plazo
```

- `lateAction` es la decisión que hoy no toma nadie. Pasado el plazo, cualquier transición que salga de `held` hacia
  un destino distinto de `to` se rechaza con ese error, haya pasado el barrido o no. La ventana deja de depender de la
  cadencia del `cron`.
- El barrido que ejecuta la transición se **deriva**, como el de `reconciledBy`. El índice del barrido (estado
  primero, marca después) ya tiene su aviso en `persistence`.
- Sin `lateAction` se abre una `OBL`. No hay default seguro: rechazar rompe al cliente que paga en el segundo 901, y
  aceptar vende stock que ya se liberó.

**Test de admisión.** «Una reserva sin pagar se libera a los 15 minutos, y quien intenta pagarla después recibe
`RESERVATION_EXPIRED`» es verdad del servicio aunque nadie lo construya, en el mismo sentido que el `lifecycle`.

**Qué no entra.** La cadencia del barrido, el tamaño del lote y el temporizador por fila frente al barrido periódico:
son mecánica del generador, y la misma frontera que ya trazó 2.8.

**Valor.** Unifica conceptualmente los relojes del método: tres de recuperación y uno de negocio, y este último es el
que falta. Cierra una carrera que en comercio cuesta dinero, porque vende lo que ya no se tiene. Es buen candidato
para validar sobre `stock-reservation`, que ya tiene la forma «reserva → confirmación».

---

### R3. Autorización a nivel de fila en lectura

Son tres escenarios con la misma raíz: **el DSL decide quién puede *ejecutar* una operación, pero apenas decide qué
*filas* ve cada uno.** Es el riesgo número uno del OWASP API Security Top 10 (Broken Object Level Authorization), y el
repo ya tiene evidencia propia de los tres.

#### R3a. Aislamiento por inquilino, estructural

**Escenario.** En un SaaS multiinquilino, ningún usuario de la empresa A ve, cuenta ni adivina por id un recurso de la
empresa B, en ninguna operación.

**Hoy: prosa por operación.** `scoping` dice de qué claim sale el alcance y sobre qué campo actúa, pero la propia
referencia admite que «la comprobación en sí se escribe como `rule` en cada operación acotada». La seguridad depende
de que nadie olvide una `rule`, y una operación nueva añadida en una evolución nace sin acotar. Un finder de 2.22
tampoco filtra por inquilino si el input no lo nombra.

**Propuesta.** Un predicado implícito y obligatorio:

```yaml
# security.keel.yaml
tenancy:
  field: organizationId                       # campo presente en toda raíz acotada
  from: { source: claim, name: org }          # o callerIdentity
  entities: all                               # o la lista explícita
  crossTenant: not-found                      # not-found (recomendado) | forbidden
  exemptRoles: [platform-admin]
```

- Toda lectura, finder, conteo y escritura sobre esas raíces lleva el filtro. Lo emite el generador en el puerto del
  repositorio, no el handler.
- `crossTenant: not-found` responde 404 a un id ajeno, para no filtrar su existencia. Es una decisión con
  consecuencias de seguridad y por eso se declara.
- Las unicidades se interpretan **dentro** del inquilino salvo que se diga lo contrario. Que dos empresas puedan tener
  el mismo SKU es un hecho del dominio.

**Test de admisión.** «Los datos de una organización son invisibles para las demás» es verdad del servicio. Si se
implementa con un filtro en el repositorio, con *row-level security* del motor o con una base por inquilino, es del
generador.

#### R3b. Listados acotados por propietario o por rol (`F-ORDER-LIST-SCOPING`)

**Escenario.** Un cliente ve en `listOrders` solo sus pedidos y el personal ve todos. Una lectura por id de un pedido
ajeno no debe devolverlo.

**Hoy: inexpresable.** La frontera la registró keel-recover sobre `shop-api` con este texto: «la salida de una query
se acota por igualdad de campos fijos o de inputs, no por el rol de quien pregunta, y scoping/ownership actúan sobre
[…] la operación de escritura, no sobre un listado según rol».

**Propuesta.** Ampliar `ownership` (2.23) a lectura, donde **filtrar** sustituye a **rechazar**:

```yaml
ownership:
  Order:
    owner: customerEmail
    operations: [cancelOrder]          # escritura: 403 NOT_ORDER_OWNER (como hoy)
    error: NOT_ORDER_OWNER
    reads: [listOrders, getOrder]      # lectura: solo las suyas
    readMiss: not-found                # un get ajeno: 404, no 403
    exemptRoles: [staff]
```

#### R3c. Autenticación opcional (`F-OPTIONAL-AUTH`)

**Escenario.** Una lectura pública que se personaliza si llega token: `favorited` y `following` en Conduit, el precio
de cliente frente al de visitante, o «ya lo compraste».

**Hoy: inexpresable.** `level` es `public | required | admin | service`. En la corrida de paridad de Conduit, 6 de las
diferencias venían de aquí.

**Propuesta.** `level: optional`. Sin token, se ejecuta como público; con un token válido, la identidad del llamante
está disponible; con un token **inválido**, `401`, porque un token roto no se degrada en silencio a anónimo. Los campos
que dependen del llamante enlazan con los derivados de R7.

**Validación mecánica posible (R3 entera).** Con `tenancy` declarada, error si una raíz acotada no tiene el campo. Un
aviso sobre una query que devuelve una raíz con `ownership` sin estar en `reads` ni declarada pública.

**Valor.** Es la recomendación con más riesgo evitado del documento: el defecto se ve como una fuga de datos, no como
un fallo. Además pasa de defensa por convención («recuerda la `rule`») a **defensa por construcción**, que es la tesis
de todo el método.

---

### R4. Ciclo de vida del dato: borrado lógico, retención y datos personales

**Escenario.**

- **Borrado lógico**: «borrar» un cliente lo oculta pero conserva sus facturas, puede deshacerse durante 30 días, y su
  email puede volver a registrarse.
- **Retención**: los pedidos se guardan 6 años por obligación fiscal y después se purgan o anonimizan.
- **Datos personales**: el RGPD y leyes análogas (LGPD, CCPA, Ley 1581 en Colombia) obligan a saber qué campos son
  personales, a minimizarlos, a no volcarlos en logs y a atender el derecho de supresión.

**Hoy: inexpresable.**

- `DELETE` es físico. No hay forma de declarar que un borrado oculta en vez de eliminar, ni qué hacen las queries con
  lo borrado.
- `sensitive` es un eje distinto: decide qué **sale** en un output, no qué régimen legal tiene el dato ni cuánto vive.
- Las purgas del repo (`BatchedPurge`, la retención de `processed_event`) son de tablas **del generador**, nunca de
  datos de negocio.
- keel-recover ya lo encontró: el informe de `shop-api` (5.9) dice que `decisions.yaml` «no admite […] retención» y
  que el diseñador lo dejó en comentarios.

**Propuesta.**

```yaml
# domain.keel.yaml
fields:
  email: { type: Email, required: true, unique: true, personal: true }

# persistence.keel.yaml
entities:
  Customer:
    deletion: logical            # physical (default) | logical
    restorableFor: { days: 30 }  # opcional; habilita una operación de restauración
  Order:
    retention:
      from: closedAt             # campo timestamp que inicia la cuenta
      keep: { years: 6 }
      then: anonymize            # delete | anonymize (solo campos personal)
```

- `deletion: logical` tiene tres consecuencias que el generador emite juntas. Las queries no ven lo borrado. Las
  unicidades se evalúan **solo entre filas vivas** (reutiliza la unicidad condicionada de 2.9). El evento de borrado
  sigue saliendo.
- `personal: true` es una clasificación. De ella se **derivan** el enmascarado en logs y trazas (TEL/ECS de los
  cuatro generadores) y el alcance de `then: anonymize`. También lo que la operación de supresión del interesado tiene
  que alcanzar, que se puede contrastar mecánicamente: todo campo `personal` de las entidades del titular.
- La retención genera su barrido, con el mismo patrón de reloj que R2.

**Test de admisión.** «El email es dato personal», «un pedido se conserva seis años» y «un cliente borrado se puede
restaurar durante 30 días» son verdad del servicio, y de hecho son obligación legal. La columna `deleted_at`, el
`@Where` de Hibernate o la purga por lotes son del generador.

**Valor.** Cumplimiento normativo verificable desde el diseño. Hoy un auditor tendría que leer el código de cuatro
generadores para saber qué campos personales acaban en un log. Además cierra un defecto típico del borrado lógico
hecho a mano: la unicidad que impide volver a registrar el email de alguien que se fue.

**Qué no entra.** El cifrado en reposo y la gestión de claves (despliegue), la base legal del tratamiento
(documentación) y el consentimiento como flujo, que se modela como dato de dominio con las capas que ya existen.

---

## 5. Prioridad media

### R5. Lotes con resultado por elemento

**Escenario.** Importar un CSV de 500 productos, actualizar en bloque 200 precios o enviar 50 notificaciones de una
vez. Lo habitual es que se procesen las válidas y se informe de cada inválida con su error: respuesta multiestado o
207 con un resultado por elemento.

**Hoy: inexpresable.** `errors` es por operación, y una operación con un `list` de entrada falla entera o termina
entera. Para responder por elemento hay que inventar en `fields` una lista de resultados con un `code` libre, que no
es un error declarado y queda fuera del catálogo de codes del contrato.

**Propuesta.**

```yaml
importProducts:
  kind: command
  input:
    fields:
      items: { type: ProductDraft, list: true, constraints: { maxItems: 500 } }
  batch:
    over: items
    atomicity: per-item          # all-or-nothing | per-item
    itemErrors: [SKU_ALREADY_EXISTS, INVALID_PRICE]   # codes declarados en errors
```

La forma de la respuesta por elemento (índice, estado, `code`, `message`) la fija `wire-contract.md` igual que la
página o el error: es del método, no de cada diseño.

**Test de admisión.** «Si falla una fila, las demás se importan y el cliente sabe cuál falló y por qué» es contrato.
El tamaño de transacción y el paralelismo son del generador.

**Nota sobre operaciones asíncronas (202).** También se evaluó una `execution: async`. Se descarta como primitivo
porque **ya es expresable**: una entidad de trabajo con su `lifecycle`, un command que la crea (`successStatus: 202`
es válido), un `dispatches` o un `schedule` que la procesa y una query de estado. Convendría documentarlo como
patrón en `methodology.md` antes que añadir sintaxis.

---

### R6. Tipos suma (variantes discriminadas)

**Escenario.** Un medio de pago es una tarjeta (últimos 4 dígitos y marca) **o** una transferencia (IBAN). Un destino
de notificación es un email **o** un teléfono. Una regla de precio es un porcentaje **o** un importe fijo. En el cable
suele ser `{"kind": "card", ...}` con `oneOf` en OpenAPI.

**Hoy: prosa o `json` opaco.** Hay dos salidas y las dos son malas. La primera es un value object con todos los campos
opcionales y una invariante en prosa del tipo «exactamente uno de»: el generador no la aplica y la validación de
forma acepta combinaciones imposibles. La segunda es `type: json`, que la propia referencia descarta para todo lo que
el servicio tenga que leer.

**Propuesta.**

```yaml
types:
  PaymentInstrument:
    discriminator: kind
    variants:
      card:         { fields: { last4: { type: string, required: true }, brand: { type: CardBrand, required: true } } }
      bankTransfer: { fields: { iban: { type: IBAN, required: true } } }
```

Cada variante es un value object cerrado. El cable lleva el discriminador, una regla del método en `wire-contract.md`.
Cómo se persiste (columnas por variante, una tabla por variante o un documento) es del generador, como hoy con los
value objects compuestos.

**Test de admisión.** «Un medio de pago es una de estas dos cosas y nunca una mezcla» es una verdad del dominio.

**Valor.** La validación de forma rechaza en el borde lo que hoy llega al handler, y el OpenAPI derivado sale con
`oneOf` y `discriminator` en vez de un objeto amorfo.

**Qué no entra.** Herencia entre entidades (polimorfismo con identidad). Abre preguntas de persistencia y de agregado
que un value object no tiene, y su valor es mucho menor.

---

### R7. Invariantes entre campos y derivados, con vocabulario cerrado

**Escenario.** Validaciones como `endDate` posterior a `startDate`, «si el estado es `cancelled`, `cancellationReason`
es obligatorio», «el descuento no supera el subtotal» o «el total es la suma de las líneas». Las validaciones y los
derivados entre campos son la mayor parte de las reglas de negocio de un CRUD.

**Hoy: prosa.** `invariants` y `computed` son frases. El generador no puede escribir la guarda, así que la escribe el
agente. El gate derivado del diseño (`check-domain-guards.sh`) cubre el **formato** de los value types escalares y no
las relaciones entre campos. El historial ya muestra el coste: una guarda que solo existe donde hay escenario (memoria
«guarda solo donde hay escenario»).

**Propuesta.** No un lenguaje de expresiones, sino reutilizar los dos vocabularios cerrados que el DSL ya tiene: los
operadores de `filter` (2.22) y la condición `when` de los índices (2.9).

```yaml
entities:
  Booking:
    checks:
      - { field: endDate, op: gt, than: startDate, error: INVALID_DATE_RANGE }
      - { requires: cancellationReason, when: { field: status, equals: cancelled }, error: REASON_REQUIRED }
  Order:
    fields:
      total: { type: Money, computed: { sum: lines.amount } }
      lineCount: { type: int, computed: { count: lines } }
```

- `computed` acepta su forma actual (prosa) **o** una forma estructurada pequeña: `sum` y `count` sobre una relación
  a muchos del mismo agregado. Lo que no quepa sigue en prosa, como ya ocurre con `filter` frente a `rules`.
- Cada `check` lleva su `error`. Así el `code` es alcanzable y se resuelve la tensión que `use-cases.md` describe
  entre `constraints` y `preconditions`.

**Test de admisión.** Una invariante es verdad del dominio por definición. Donde se evalúa (entidad, comando o base
de datos) es del generador.

**Valor.** Guardas en los cuatro generadores sin depender de un escenario, y una fuente de mutaciones nuevas para el
corpus de la puerta de diseño.

**Qué no entra.** Expresiones arbitrarias, aritmética entre campos más allá de `sum`/`count`, e invariantes que
cruzan agregados (la referencia ya las prohíbe).

---

### R8. Búsqueda: `in`/`ne`, texto libre, orden elegido por el cliente y cursor

**Escenario.** Las pantallas de back-office filtran por «estado en (`active`, `draft`)», buscan «texto en nombre o
descripción», dejan al usuario ordenar por columna y, en volúmenes grandes, paginan por cursor.

**Hoy: parcial, y con un primitivo que valida sin significar nada.**

- 2.22 dejó fuera, por escrito, «la búsqueda libre sobre varios campos, `in` y `ne`». Una sola query con un input sin
  enlazar se queda **sin finder entero**, y el agente vuelve a escribir el puerto y el adaptador.
- 2.4 descartó la *whitelist* de campos ordenables como «validación de la entrada». Pero qué órdenes acepta la API es
  contrato con quien construye la interfaz: hoy un cliente no tiene forma documentada de pedir otro orden.
- `pagination.style: cursor` está en el schema y **ningún generador lo implementa**: lo dice `api.md`. Choca con la
  regla de la referencia: «un spec que valida es un spec que esta CLI entiende entero».

**Propuesta.**

```yaml
searchProducts:
  kind: query
  input:
    fields:
      statuses: { type: ProductStatus, list: true, filter: { field: status, op: in } }
      q:        { type: string, search: { over: [name, description], match: contains, compare: ignore-case-accents } }
  output: { entity: Product, paginated: true, sort: [name:asc], sortable: [name, price.amount, createdAt] }
```

- `op: in` y `op: ne` amplían el vocabulario de 2.22 sin cambiar su naturaleza.
- `search.over` declara una búsqueda de texto sobre varios campos con la semántica de 2.14. Cómo se resuelve (`LIKE`,
  índice de texto completo o un motor de búsqueda externo) es del generador.
- `sortable` declara qué órdenes acepta la API. La sintaxis del parámetro la fija `wire-contract.md`.
- **Cursor**: o se define su contrato en `wire-contract.md` (cursor opaco, `nextCursor`, orden estable obligatorio) y
  se implementa, o se retira del enum hasta que haya un generador que lo sirva. Mantenerlo como está es la única
  deuda de esta lista que contradice una regla escrita del propio método.

**Valor.** Cierra el último trozo grande de código de repositorio que el agente reescribe fuera de los handlers, que
fue la motivación de 2.22.

**Qué no entra.** Facetas y agregaciones (conteos por categoría): es un modelo de lectura distinto. Tampoco la
relevancia o el *ranking* de la búsqueda.

---

### R9. Evolución del contrato: deprecación y versión de eventos

**Escenario.** Un endpoint se retira en seis meses y sus consumidores reciben las cabeceras `Deprecation` y `Sunset`
(RFC 8594) entretanto. Un evento cambia de forma de manera incompatible y se publica v2 junto a v1 durante una
transición.

**Hoy: inexpresable.**

- La envoltura Keel lleva `eventVersion` («solo sube al romper compatibilidad»), pero `messaging.schema.json` no
  tiene dónde declararla, así que todo evento es v1 para siempre.
- No hay forma de marcar como en retirada un endpoint, una operación ni un campo de salida.
- El versionado del diseño (`service.version` semver) existe, pero no dice **qué** se rompe ni **cuándo** deja de
  servirse.

**Propuesta.**

```yaml
# api.keel.yaml
endpoints:
  getProductV1: { method: GET, path: "/products/{id}", deprecated: { sunset: 2027-05-01, replacedBy: getProduct } }

# messaging.keel.yaml
publishing:
  events:
    OrderPlaced:
      version: 2
      alsoPublish: [1]          # transición: se emite también la forma v1, hasta retirarla
```

`keel system check` ganaría una regla cross-servicio natural: el consumidor que lee `OrderPlaced@1` de un emisor que
ya no la publica es rojo.

**Test de admisión.** Una fecha de retirada y la versión de un evento son contrato con integradores. Cómo se emiten
las dos formas (dos mensajes, o una envoltura con *upcasting*) es del generador.

**Valor.** Hoy el método protege muy bien un servicio aislado. Este es el primer primitivo que protege la **flota** a
lo largo del tiempo, y encaja con `system.yaml` y con el registry.

---

### R10. Orden de eventos por clave

**Escenario.** Los eventos de un mismo pedido (`OrderPlaced`, `OrderPaid`, `OrderShipped`) se consumen en orden. Los
de pedidos distintos pueden ir en paralelo.

**Hoy: implícito.** El orden por clave lo decide el generador (la clave de partición en Kafka, por ejemplo), y el
consumidor no tiene forma de saber si puede contar con él. 2.2 descartó con razón el umbral de antigüedad del dato.
Que el emisor **garantice** orden por clave es otra cosa: es una promesa al consumidor.

**Propuesta.** `publishing.events.<E>.orderedBy: orderId` (por defecto, el id del agregado que lo emite) y, del lado
del consumidor, un aviso si una suscripción depende de un orden que su fuente no promete.

**Valor.** Bajo coste, porque casi todo existe ya en los generadores. Hace explícita una suposición de la que dependen
las compensaciones y las réplicas de `dependencies`.

---

### R11. Webhooks salientes

**Escenario.** En una plataforma B2B, los clientes registran una URL y reciben un `POST` firmado cuando cambia algo
suyo, con reintentos, desactivación tras fallos sostenidos y la posibilidad de verificar la firma. Es el modelo de
integración de Stripe, GitHub o Shopify.

**Hoy: inexpresable.** `messaging` es para el broker interno. `http-clients` describe llamadas a un proveedor
**conocido** con contrato fijo. `mail` es correo. Ninguna capa sirve para «el destinatario es un dato que registra el
cliente».

**Propuesta.** Una capa `webhooks`, hermana de `mail`:

```yaml
webhooks:
  endpointsFrom: WebhookEndpoint     # entidad del dominio con url y eventos suscritos
  events: [OrderShipped, OrderCancelled]
  delivery:
    retry: { maxAttempts: 8, backoff: exponential }
    disableAfterFailures: 50
```

La forma del mensaje y el esquema de firma son contrato con el receptor y tienen que ser **los mismos para todo
servicio Keel**, igual que la envoltura de eventos. Los fija el método (hay un estándar público, *Standard Webhooks*,
que conviene evaluar como base), no cada diseño.

**Test de admisión.** «Los clientes reciben un aviso firmado cuando se envía su pedido» es contrato público.

**Valor.** Alto para servicios de plataforma, y hereda casi todo de lo que ya existe: outbox, reintentos y la
protección anti-SSRF de los clientes salientes de keel-spring, que aquí pasa a ser **imprescindible** porque la URL la
elige un tercero.

---

### R12. Historial de cambios consultable

**Escenario.** En banca, salud o seguros hay que poder responder qué valía un campo en una fecha, quién lo cambió y
desde qué valor.

**Hoy: inexpresable.** `audit` registra la **última** escritura (`createdAt/updatedAt/createdBy/updatedBy`). No hay
historial.

**Propuesta.** `persistence.audit.history: [Policy, Account]` y, en `use-cases`, una salida
`output: { history: Policy }` con forma fija en `wire-contract.md` (instante, autor, campo, antes y después). Los
campos `personal` de R4 quedan sujetos a su retención también en el historial.

**Qué no entra.** *Event sourcing* como modelo de persistencia. Es una decisión de implementación, y el historial es
la propiedad observable que se suele pedir de él.

---

### R13. Subida directa al almacenamiento

**Escenario.** Un vídeo de 2 GB no debe atravesar el servicio. El cliente pide una URL de subida prefirmada, sube
directamente al almacenamiento y confirma.

**Hoy: inexpresable.** `storage` declara la URL firmada de **lectura** (`signedUrlTtlSeconds`), pero la subida es
siempre mediada (multipart contra el servicio). Además, el multipart es la fuente de `designGaps` más repetida en las
corridas (`multipart-list-field` y la cota de cada etiqueta), aunque esos fueran huecos del generador.

**Propuesta.** `buckets.<b>.upload: mediated | direct`, con `uploadUrlTtlSeconds` y un estado de «pendiente de
confirmar» del campo `file`: cuándo se valida el tipo y el tamaño declarados si el binario no pasa por el servicio.

**Valor.** Desbloquea casos de uso de medios y documentos grandes. Obliga a decidir **dónde** se cumplen
`allowedContentTypes` y `maxSizeMb` cuando el servicio no ve el binario, un hueco de seguridad si se improvisa.

---

## 6. Prioridad baja (vigilar)

- **R14. Tipos temporales.** Faltan `time` (hora del día: horarios de apertura) y `duration` (un SLA, una ventana).
  Hoy acaban como `string` con patrón o como `int` en una unidad que solo dice la `description`. La zona horaria de
  negocio ya es expresable como parámetro, pero nada enlaza un `date` con ella. Coste bajo y valor real en reservas y
  agenda.
- **R15. Cuotas de negocio.** «El plan gratuito tiene 1.000 envíos al mes» es un hecho del servicio, con su `429` y su
  `Retry-After`. El *rate limiting* de protección no lo es (ver § 7). Merece entrar solo cuando un diseño lo pida,
  porque la frontera entre cuota de negocio y protección técnica es fina.
- **R16. Otros canales de notificación.** SMS y push tienen la misma estructura que `mail` (transporte, plantilla y
  emisor), pero cada uno tiene su propio régimen: opt-in, horarios, longitud. Mejor generalizar `mail` cuando aparezca
  el segundo canal real que diseñarlo en abstracto.
- **R17. Contenido localizado.** `localized: true` en un campo de texto: el valor existe por idioma y la lectura
  elige uno por `Accept-Language`. Es común en catálogos, pero hoy se modela razonablemente bien con una entidad hija
  `ProductTranslation`, así que el valor del primitivo es de comodidad más que de corrección.

## 7. Evaluado y no recomendado

Esta lista es la mitad del valor del documento: lo que el test de admisión manda al generador o al despliegue.

| Tema | Por qué no va al DSL |
|---|---|
| Direcciones de un índice (`F-INDEX-DIRECTIONS`) | Es rendimiento, no contrato. Además es **derivable**: el `sort` de la query que el índice sirve ya dice las direcciones. Va al generador |
| Sobre de página con campos hermanos (`F-CATEGORY-NAME-WRAPPER`) | Es fidelidad a un legacy, no un patrón. Abrir el sobre canónico rompería el contrato uniforme de los cuatro generadores. Se puede modelar con una query que devuelva la categoría y otra la página |
| *Rate limiting* técnico, *timeouts* de petición, tamaño de cuerpo | Protección de infraestructura, familia de `backoffMs`. Se configura al desplegar |
| *Feature flags* | Despliegue y operación |
| CQRS, *event sourcing*, réplicas de lectura, vistas materializadas | Patrones de implementación. Lo observable (historial, lectura replicada de un dato ajeno) ya tiene o tendría su primitivo (R12, `dependencies.replica`) |
| Sagas orquestadas | `activations` + `compensations` + `reconciledBy` ya expresan los hechos. El orquestador es una forma de construirlo |
| GraphQL, gRPC, SSE/WebSocket | Un estilo de API sí es contrato con el cliente. Pero `api.style: rest` es la única puerta que hoy miden los cuatro generadores, y abrir otra multiplica las redes por estilo. Habría que esperar a un diseño real que lo exija, sobre todo para el tiempo real (SSE), que es el más pedido |
| Operaciones asíncronas como primitivo | Ya expresables (ver la nota de R5). Mejor documentar el patrón |
| Herencia entre entidades | Coste alto, valor bajo frente a R6 |

## 8. Lectura de conjunto

**Tres recomendaciones son un mismo mecanismo.** El inquilino (R3a), la propiedad en lectura (R3b) y el borrado
lógico (R4) son **predicados implícitos**: condiciones que toda consulta sobre una entidad tiene que llevar sin que la
operación las nombre. Diseñarlos por separado produciría tres emisores en cada uno de los cuatro generadores que
tendrían que componerse en cada finder. Conviene pensarlos como un solo concepto neutral en `keel-core/gen`, igual que
`query-filters.js` unificó los finders, y con un solo sabotaje que demuestre que ninguno se cae al componerse.

**Dos son el mismo reloj.** Los plazos de negocio (R2) y la retención (R4) son barridos derivados de un campo
timestamp y un plazo enlazado a un parámetro, con la misma forma que `stalledAfter` y `reconciledBy`. Si el método
tuviera un único concepto de reloj del dominio, los cinco saldrían del mismo sitio.

**Dónde está el riesgo de verdad.** Las cuatro recomendaciones de prioridad alta comparten un rasgo: su fallo **no se
ve** en una corrida verde. Una actualización perdida, una reserva confirmada fuera de plazo, una fila de otro
inquilino o un email personal en un log no rompen ningún escenario que el diseñador no haya pensado en escribir. Es
la misma familia de defecto contra la que el método construyó la medición por mutación, y por eso son las que más
robustez añaden.

**Con qué contrastar cada una antes de admitirla.** Siguiendo la regla del propio método (ningún primitivo sin un
diseño que lo pida):

| Recomendación | Diseño de contraste |
|---|---|
| R1 | `product-catalog` o `catalog-extended`, con un escenario de dos lecturas y dos escrituras separadas |
| R2 | `stock-reservation`, añadiendo la caducidad de la reserva |
| R3b, R3c | `shop-api` y `conduit`: las fronteras ya están registradas y la paridad las mediría |
| R3a | `asset-vault`, que ya usa `scoping` |
| R4 | `profile-directory`, el más cercano a datos personales |
| R8 | `catalog-extended`, la búsqueda que 2.22 dejó fuera |

Con eso, cada recomendación pasaría de hipótesis de industria a hueco medido, que es la única forma en que el DSL ha
crecido hasta ahora.
