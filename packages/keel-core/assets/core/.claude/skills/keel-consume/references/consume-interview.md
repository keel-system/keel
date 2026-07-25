# Guía de entrevista de `/keel-consume`

Tablas de apoyo para los pasos 3 y 4. Todos los ejemplos usan el dominio compartido de la documentación:
`order-service` depende de `catalog` para conocer el precio de un producto.

## 1. Decidir la estrategia

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

Lo que **nunca** se traslada: `basePath` absoluto, credenciales, `tokenUrl` de un entorno concreto, el
modelo de datos completo del proveedor, y sus códigos de error tal cual como errores nuestros.

## 5. Checklist de cierre

- [ ] Todo `need` tiene al menos una operación en `usedBy`, y esa operación existe.
- [ ] Todo cliente HTTP escrito lo usa algún `need`; toda suscripción escrita alimenta una réplica o
      es una compensación declarada.
- [ ] Toda réplica declara `onMiss`, y su `fedBy` cubre **altas, cambios y bajas**.
- [ ] Todo `onMiss.action: fail` tiene su `error` declarado en **cada** operación de `usedBy`.
- [ ] La entidad de la réplica está en `persistence.entities`, su `keyField` es `unique`, y su
      `description` dice que es una proyección.
- [ ] No hay credenciales, secretos ni URLs de entorno en ningún artefacto.
- [ ] `keel validate` pasa (o `--wip` si el diseño sigue abierto).
- [ ] La lista de huecos está escrita, con destinatario. En modo degradado, **no está vacía**.
