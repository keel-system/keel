# Cómo producir validation-scenarios.md

Procedimiento del paso **5** de `/keel-design`. `docs/validation-scenarios.md` define **qué debe cumplir** el archivo (es el formato canónico, y el mismo que aplica `/keel-validate` como gate); este documento define **cómo producirlo** para que lo cumpla.

Lee ambos antes de escribir la primera línea del artefacto.

## 1. Inventario de obligaciones (antes de escribir nada)

El error más común es escribir los flujos que se te ocurren y después rellenar la matriz con lo que salió. Eso produce cobertura del camino feliz y huecos sistemáticos en todo lo demás. **Se hace al revés**: primero el inventario mecánico de lo que hay que cubrir, y los flujos se escriben **para cubrirlo**.

Recorre los artefactos y construye la lista de obligaciones. Es un borrador de trabajo, no va al archivo:

| Fuente | Obligación |
|---|---|
| `use-cases.operations` | una fila de matriz por operación |
| `operations[].errors[]` | una aserción por `code`, con su status |
| `operations[].preconditions/rules` | un orden de evaluación por command, más un escenario de precedencia si hay ≥2 errores |
| `operations[].emits[]` | una aserción de evento (nombre + payload + canal) |
| `operations[].idempotency` | **dos**: el reintento secuencial con la misma clave (mismo status, mismo cuerpo, sin segundo efecto) + una **carrera** de dos peticiones con la misma clave a la vez, cuyo `Then` es disyunción cerrada (respuesta reproducida o `409` de clave en curso) **más un conteo por la API que afirma un solo recurso** |
| `operations[].output.embed` | una aserción del **objeto anidado** (no del `<relación>Id`), con sus campos |
| `operations[].output.exclude` | una aserción de **ausencia** por cada ruta excluida |
| `operations[].cache.invalidatedBy` | un ciclo leer → mutar → releer **por cada vía** listada |
| `operations[].cache.ttlSeconds` | un escenario de **retención**: mutar por una vía que **no** está en `invalidatedBy` y comprobar que la lectura sigue sirviendo el valor viejo |
| `operations[].schedule` | disparo y efecto observable |
| `domain.entities[].lifecycle` | un escenario por transición + una transición inválida + **todo estado alcanzado** |
| `operations[].transitions` | la transición feliz + su aplicación desde un estado que **no** está en `from`, con el error de transición inválida |
| `dependencies.*.compensations[]` | **tres** escenarios: el efecto completo (trabajo deshecho, estado propio devuelto leído por la API y —si el encargo salió por un cliente— la **llamada de vuelta al proveedor**) + la **reentrega del mismo evento** sin segundo efecto + la **doble entrega simultánea**, que tampoco lo produce |
| `dependencies.*.needs[].onUnavailable` | uno por acción, con el proveedor indisponible: `fail` → el error declarado con su status; `degrade` → el resultado degradado exacto. Con `lastKnown`, **dos**: el **rescate** (hubo lectura previa → se sirve el último valor conocido) y el **arranque en frío** (no la hubo → el `error` declarado). Sin el segundo, un almacén que no guarda nada pasa el primero |
| `dependencies.*.needs[].exposedAs` | una aserción del dato ajeno **en la salida**, con la forma entera de su origen: si el origen es un objeto, el campo expuesto es un objeto y no un escalar |
| `domain` campos `unique` | una colisión |
| `domain` constraints y requeridos | casos borde `400` |
| `api.endpoints` con `successStatus: 201` | una aserción de la cabecera `Location` (ver § 2) |
| `api.endpoints` con `paginated` | primera página, siguiente, vacía, tope `maxSize` |
| query de colección con `embed`, `exposedAs` o un `need` `on-demand` | una afirmación de **coste**: dos páginas de tamaños muy distintos, y el trabajo de la operación no crece con el tamaño. Por **forma** («veinte no cuestan más que dos»), nunca por número absoluto. Solo con capa `api` |
| `api.endpoints[].audience: services/both` | contrato M2M completo (request + response + errores + auth) |
| `security.access` | `401` sin credencial y `403` sin permiso, por operación protegida |
| `security.cors` | **dos**: el **preflight** (`OPTIONS` sin credencial → método y `allowedHeaders` aceptados, `maxAgeSeconds`) y una petición **normal cross-origin** cuyo `Then` afirma las cabeceras de `exposedHeaders`. El primero solo prueba que el preflight pasa; el segundo, que la respuesta le sirve al navegador |
| `messaging.subscriptions` | consumo + `onFailure` (retry/DLQ) + reentrega si hay `messageId` |
| `messaging.reliability: outbox` | un escenario de **supervivencia**: con el canal indisponible, la mutación responde igual y el canal sigue vacío; restablecido, el evento llega **exactamente una vez**. Las dos negaciones son lo que lo hace fallable |
| `activations[].reconciledBy` | **ninguno, por construcción** — no hay puerta de caja negra que dispare un barrido por tiempo. Se declara el umbral y qué queda observable; la verificación es estática (ver `validation-scenarios.md § Lo que no tiene escenario`) |
| `storage.buckets` | subida feliz, lectura según `visibility`, lectura de una clave inexistente, `FILE_TOO_LARGE`, `UNSUPPORTED_CONTENT_TYPE` |
| capa `mail` | que sale el correo (destinatario, asunto ya interpolado y las partes que declara `delivery.parts`), que **no** sale cuando la operación rechaza, y que un reintento con la misma guarda no manda un segundo. El Then afirma sobre el buzón, no sobre el 2xx: la respuesta acepta el encargo, no lo cumple |

Cuando el inventario esté completo, la **matriz de cobertura** sale de él, no de los flujos.

### La lista de campos de una respuesta se deriva del artefacto, no de tu lectura

El formato exige que el `Then` fije el **cuerpo completo**. De dónde sale ese cuerpo no es opinión: para un `output: { entity: X, … }`, es

> los campos de `domain.entities.X` — menos las rutas de `exclude` — más un objeto anidado por cada relación de `embed` — más los campos con `default`, que viajan **siempre** aunque la petición no los mande.

Enumerarlo de memoria es el error que más contradicciones internas produce, y son caras: un escenario dice que la creación devuelve seis campos, otro del mismo documento asume un séptimo que el primero negó, y el desacuerdo no aflora hasta que un agente tiene que elegir a cuál obedecer. El caso típico es un `status` con `default: active`: no aparece en la petición, así que se olvida en la respuesta, mientras el flujo de transición de estado que viene después lo da por descontado.

Dos consecuencias prácticas:

- La cláusula **"el cuerpo no trae ningún campo adicional"** convierte la enumeración en contrato cerrado. Escríbela solo cuando hayas derivado la lista del artefacto; sobre una lista enumerada de memoria, lo que fija es un error.
- Si al derivarla descubres que el `output` no proyecta algo que el escenario necesita —una relación que debería venir anidada y viaja como id—, **el que cambia es el YAML**, no el escenario. Vuelve a la capa `use-cases` antes de seguir.

## 2. Convenciones de determinación

Antes de los flujos, fija las convenciones transversales del servicio en la sección `## Convenciones de determinación` del archivo: formato temporal y zona, escala decimal y redondeo, ausencia vs nulo, sensibilidad a mayúsculas/acentos, forma del cuerpo de error, cabecera de idempotencia. Se declaran **una vez** y ningún escenario las repite.

Estas convenciones son la salida natural de la clase 12 del análisis de huecos (`gap-analysis.md`). Si llegaste aquí sin haberlas decidido, decídelas ahora con el usuario: son contrato, y sin ellas dos generadores divergen.

**Solo se nombran identidades que el diseño declara.** Un escenario que dice «con la credencial de máquina del cliente `billing`» describe una superficie que **no existe** si `security.serviceClients` no declara a `billing`: no hay credencial que aprovisionar, y ese escenario no será ejercitable por la vía que él mismo exige — se descubre al puntuar, cuando ya no hay identidad que inventar. Lo mismo con los roles: se nombran los de `security.roles`, o no hay token que emitir.

Es fácil caer en ello sin darse cuenta, porque el nombre suena natural: un código de aplicación de los datos de prueba se escribe igual que un cliente máquina. Cuando el escenario necesita una identidad que el diseño no tiene —dos consumidores distintos para probar el aislamiento, un cliente con un scope y **sin** otro para probar el mínimo privilegio—, lo que falta es **declararla** en `security`, no redactar como si existiera. `keel validate` avisa, y para verlo tiene que reconocer la forma canónica (`credencial de máquina del cliente \`<serviceClient>\``, `rol \`<rol>\``): escrito de otra manera el aviso no salta y el hueco vuelve a ser invisible.

**Lo que no decide el diseñador.** Algunas afirmaciones del `Then` no dependen del diseño sino del generador, y escribirlas "como deberían ser" produce un escenario que ningún servidor correcto pasa. Antes de fijarlas, contrástalas con la documentación del generador previsto; si el diseño necesita otra cosa, es un cambio en el generador, no una convención que se declara y ya. En keel-spring, hoy:

- La **forma del cuerpo de error** es fija: `{timestamp, status, error, code, message, details}` (+ `correlationId`). La convención del servicio la **describe**, no la sustituye. Lo que sí decides es el `code` y el status de cada error, en el YAML.
- El fallo de **audiencia** (`serviceAuth.validateAudience`) responde **403**, no 401.
- Una operación `level: service` **no rechaza por sí sola un token de usuario**: la separación es por scopes, no por tipo de credencial.
- La cabecera **`Location`** de una creación **no se declara ni se niega en el YAML**: se emite en toda operación con `successStatus: 201` cuyo `output` declare `id`, con la URI de la petición más el id devuelto. El escenario la asserta; lo que **no** puede hacer es afirmar "sin cabecera `Location`" ni fijarle una URI distinta de esa — ningún servidor correcto lo pasa. Si la creación no devuelve `id` (output vacío o una lista), entonces no hay `Location` que assertar.
- Si un escenario ejercita **dos escrituras concurrentes**, el resultado lo fija `persistence.consistency.optimisticLocking` (`all`/`declared` → conflicto `409`; `none` → ambas con éxito, último escritor gana). Declararlo solo en prosa dentro de `rules` no vale: ningún generador lee prosa.
- Si el escenario ejercita **dos peticiones simultáneas con la misma clave de idempotencia**, el desenlace admisible es doble y hay que enumerarlo: o las dos responden lo mismo, o la que pierde la carrera recibe **`409` con code `IDEMPOTENCY_KEY_IN_PROGRESS`** — la clave se registra en la misma transacción que el recurso, así que hasta que la ganadora no commitea no hay respuesta que reproducir. Lo que no admite disyunción es el efecto: la API tiene que devolver **exactamente un** recurso. Ese `code` lo emite el generador; no se inventa otro en el YAML.

Esta lista es una **copia manual** del contrato de keel-spring, y por eso envejece: la fuente real es `docs/keel/conventions/flow-fidelity.md`, que solo existe **dentro de un proyecto ya generado** (`services/<servicio>-<tech>/`), es decir, después de este paso. Si hay algún proyecto generado a mano, contrasta contra él; si el generador se comporta de otra forma que la descrita aquí, gana el generador y esta lista está desactualizada — repórtalo.

## 3. Agrupación en flujos

Un **flujo** (`FL-*`) es una historia coherente de negocio sobre una agrupación (entidad o agregado), auto-contenida y reseteada antes de ejecutarse. Dentro de él, los escenarios van en orden y encadenan estado.

Reglas prácticas:

- El **primer escenario del flujo crea** lo que los demás necesitan. Si el `Given` de un flujo necesita algo que solo produce otro flujo, o lo creas dentro, o lo replanteas: tras el reset ese estado no existe.
- Un caso borde es **escenario propio** cuando necesita su propio `Given` o cuando ejercita un error que nadie más cubre; es una entrada del campo **Casos borde** cuando es una variación del input del escenario que lo precede.
- No metas todo el ciclo de vida de una entidad en un solo flujo gigante: un flujo por historia (alta y consulta; transición de estado; borrado y sus efectos).
- Los flujos de consumo de eventos y los de schedule son flujos aparte, con su propio prefijo si conviene.
- El prefijo `FL-<PREFIJO>-NNN` es 3-4 letras de la agrupación, `NNN` secuencial dentro de ella. Deja huecos entre números si prevés insertar (`001`, `010`, `020`).

## 4. Ejemplo trabajado

Un flujo completo en el formato final, para calibrar el nivel de detalle:

```markdown
### FL-ORD-001: alta de pedido y publicación del evento

**Given**: existe el cliente `c1` (`status: active`) y el producto `p1`
(`sku: "SKU-001"`, `price: 12.50`, `stock: 10`). No existe ningún pedido de `c1`.

**When**: `createOrder` — `POST /v1/orders`
```json
{ "customerId": "c1", "lines": [ { "productId": "p1", "quantity": 2 } ] }
```

**Then**:
1. Status `201`.
2. Cabecera `Location` con la ruta del pedido creado.
3. El cuerpo trae `id` (forma de identificador), `customerId: "c1"`, `status: "pending"`,
   `total: 25.00` (escala 2) y `lines` con un elemento (`productId: "p1"`, `quantity: 2`).
4. El cuerpo **no** trae `internalNotes` (campo `sensitive`).
5. `getOrder` sobre el `id` devuelto responde `200` con el mismo cuerpo.
6. Se publica `OrderCreated` en el canal `orders` con `orderId` (el devuelto),
   `customerId: "c1"` y `total: 25.00`.

**Orden de evaluación**:
1. El cliente existe → `CUSTOMER_NOT_FOUND` (`404`).
2. El cliente está activo → `CUSTOMER_INACTIVE` (`409`).
3. Cada producto existe → `PRODUCT_NOT_FOUND` (`404`).
4. Hay stock suficiente → `INSUFFICIENT_STOCK` (`409`).

**Casos borde**:
- `lines` vacío → `400` (`minItems: 1`).
- `quantity: 0` → `400`.
- Cliente inexistente **y** producto inexistente en la misma llamada →
  `CUSTOMER_NOT_FOUND` (`404`): la guarda 1 precede a la 3.

**Notas de determinación**: `total` se verifica con escala 2 y redondeo al alza en el
último decimal; `id` y `createdAt` se verifican por forma, no por valor.
```

Fíjate en lo que hace que sea contrato y no descripción: la aserción 3 fija el cuerpo **completo**, la 4 fija una **ausencia**, la 5 comprueba el efecto **por la API pública** en vez de por la base de datos, la 6 nombra canal y payload, y el último caso borde es lo único que fija la **precedencia** entre guardas.

## 5. Auto-revisión antes de mostrarlo

Dos pasadas, en este orden. No enseñes el archivo al usuario sin haberlas hecho.

**Pasada de cobertura (recorrido inverso).** Para **cada fila del inventario** del paso 1, localiza la aserción concreta que la cubre —el flujo, el escenario y el número de aserción—. Si no la encuentras, falta escenario. Recorrer los flujos y ver si "parece completo" no es esta pasada: la dirección importa, porque el sesgo está en no echar de menos lo que nunca escribiste.

**Pasada de equivalencia.** Por cada punto de `docs/validation-scenarios.md § Determinación observable`, comprueba que está fijado o declarado indiferente. Y a cada escenario, hazle la pregunta de calidad: *¿podría una implementación plausible pero distinta pasar este escenario comportándose de otra manera?* Si la respuesta es sí, el escenario es decorativo — concrétalo.

**Pasada de campos.** Por cada entidad que algún `Then` enumera, deriva su proyección del artefacto (la regla del paso 1) y compárala contra **todas** las enumeraciones de esa entidad en el documento. Tienen que coincidir entre sí y con el YAML. Basta un campo con `default` que aparezca en un flujo y falte en otro para que el documento se contradiga.

Errores frecuentes que estas pasadas deben cazar:

- `Then` que solo comprueba el status.
- Creación `201` cuyo `Then` no asserta la cabecera `Location` — o, peor, que la **niega**.
- Campo con `default` ausente de la enumeración de una respuesta de creación, y presente en otro flujo del mismo documento.
- Relación con `embed` afirmada como `<relación>Id` (o al revés) en algún `Then`.
- Lista devuelta sin orden declarado.
- Afirmación de coste escrita contra un **número absoluto** («cuesta 4 consultas») en vez de contra la forma: se rompe con cualquier cambio de motor o proyección, y acaba subiéndose sin mirar hasta volverse decorativa.
- CORS cubierto **solo** con el preflight: el servicio contesta al `OPTIONS` y el navegador sigue sin poder leer las cabeceras de `exposedHeaders`. Son dos escenarios porque son dos fallos distintos.
- `onUnavailable: lastKnown` probado solo por el camino del rescate: sin el escenario de arranque en frío, un almacén que nunca guarda nada pasa igual y la política degrada en silencio a «fallar siempre».
- Error sin status, o con status distinto al del artefacto.
- Escenario cuyo `Given` depende de otro flujo.
- `invalidatedBy` con tres vías y un solo ciclo de invalidación probado.
- Caché sin escenario de retención: sin él, una implementación que **no cachea nada** pasa todos los escenarios de invalidación.
- Escenario que exige ver un cambio reflejado de inmediato en un objeto `embed` cuya entidad no publica ningún evento en `invalidatedBy`: es una exigencia que ningún generador puede cumplir, y lo que hay que corregir es el diseño (o el escenario), no el servidor.
- Estado del `lifecycle` que ningún flujo alcanza.
- Evento en `emits` que no aparece en ningún `Then`.
- **Compensación sin escenario de reentrega**: el flujo prueba que la compensación deshace el trabajo, y nada prueba que no lo deshaga dos veces. Es el hueco más caro de la lista, porque el segundo efecto no se ve al probar a mano — hay que reentregar el mensaje a propósito.
- **Compensación sin la doble entrega simultánea**: no es la reentrega con otras palabras. La secuencial encuentra la marca de procesado ya commiteada; la simultánea cae en la ventana en la que todavía no lo está, que con réplicas es el caso normal.
- **Idempotencia probada solo en secuencia**: mismo argumento. Reintentar después encuentra el registro de la clave ya escrito y lo resuelve una lectura; el fallo real vive en la ventana en la que aún no lo está. Sin el escenario de carrera, lo que se ha probado es la lectura.
- **Outbox sin escenario de canal indisponible**, o con uno que solo afirma «el evento acaba llegando»: eso lo cumple igual un servicio que publica directo dentro de la operación, así que el escenario no distingue nada y el `reliability: outbox` del diseño queda sin verificar.
- **Compensación que solo mira hacia dentro**: el `Then` verifica el estado propio devuelto y nada dice del proveedor al que se le encargó el trabajo. El servicio queda internamente coherente y con un encargo vivo ahí fuera que nadie va a cancelar, y ningún `Then` que solo lea la propia API puede notarlo.

De esta lista, `keel validate` caza cuatro **por texto**: los dos de compensación (reentrega y doble entrega), el de la carrera de idempotencia y el del outbox. Busca la señal en los escenarios y avisa si no la encuentra. Si el escenario existe con otra redacción, el aviso es un falso positivo que se cierra escribiendo la palabra que toca («reentrega», «a la vez», «canal indisponible»); si no existe, hay que escribirlo. El último —la llamada de vuelta al proveedor— no se mecaniza: depende de qué encarga cada dependencia, y es revisión de `/keel-validate`.

## 6. Regenerar sin romper

El archivo se reemite cada vez que el spec cambia, y **los ids `FL-*` son estables**: otros artefactos se apoyan en ellos (las colecciones Postman de `/keel-docs` crean una carpeta por flujo, y el agente del generador los reporta uno a uno).

- Actualiza la **versión del spec** de la cabecera: es lo que permite a `/keel-validate` detectar que el archivo quedó desactualizado.
- Los flujos que siguen siendo válidos **conservan su id**, aunque cambie su contenido.
- Los flujos nuevos toman números nuevos. **Nunca recicles** un id liberado.
- Un flujo que ya no aplica se elimina; su número no se reutiliza.
- Si una operación se renombra, el flujo mantiene el id y actualiza el `When`.

Cierra mostrando el archivo al usuario y pidiendo su aprobación: es el contrato con el que se va a aceptar o rechazar cada servidor generado a partir de este diseño.
