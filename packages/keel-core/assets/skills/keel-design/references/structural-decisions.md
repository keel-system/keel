# Decisiones estructurales: el catálogo

Tablas de apoyo del paso **3** de `/keel-design`. Cada entrada se resuelve **en su capa**, durante la
entrevista de esa capa, no en el barrido final. Todos los ejemplos usan el dominio compartido de la
documentación: `product-service` (catálogo de productos) y `order-service` (pedidos que lo consumen).

## 1. Qué es una decisión estructural

Una decisión estructural es la que fija **lo que el servidor garantiza**, no lo que calcula. Cinco
preguntas que la delatan:

- ¿Qué se **pierde** cuando algo falla a mitad?
- ¿Qué se puede **repetir** sin hacer daño?
- ¿Qué puede llegar **rancio**, y cuánto?
- ¿**Quién** consume este contrato, y a qué ritmo evoluciona?
- ¿Qué **transacción** envuelve qué?

Ninguna de las cinco es una pregunta técnica disfrazada: todas cambian lo que el servicio puede
**prometer** a sus clientes y el coste de operarlo. Por eso **no son tuyas**. Tú conoces el mecanismo;
el diseñador conoce el negocio que lo paga y lo que ocurre cuando falla.

El catálogo de la sección 3 tiene diez entradas, pero **es un catálogo, no una lista cerrada**: ante
cualquier decisión que responda a una de las cinco preguntas de arriba, aplica el mismo protocolo
aunque no esté aquí.

## 2. Protocolo de decisión

Vale igual para las diez entradas:

1. **Recomienda una opción concreta, con su porqué.** Un menú neutro de tres opciones equivalentes le
   devuelve al humano el trabajo de pensar que tú puedes hacer por él. Di cuál elegirías y por qué,
   en una frase.
2. **Pregunta con `AskUserQuestion`.** Incluye **siempre** la opción «sin \<mecanismo\>» —sin outbox,
   sin idempotencia, sin caché— con su **consecuencia observable**: qué vería un cliente el día que
   pase lo que el mecanismo evita. Sin esa opción la pregunta es retórica.
3. **Nunca escribas la decisión en silencio**, ni siquiera cuando el diseñador vaya a decir que sí.
   Escribir primero y contarlo después no es preguntar.
4. **Si elige lo contrario a tu recomendación, acata sin insistir.** Una réplica está bien; dos son
   presión. Anota la elección y la alternativa descartada como rationale para `/keel-handoff`.
5. **Si no puede decidir ahora, márcalo pendiente explícito** y enumera esos pendientes en el cierre
   de sesión. Un default tácito no es una decisión: es una decisión tomada por ti sin decirlo.

La consecuencia observable es la parte que no puedes saltarte. «¿Quieres outbox?» no es una pregunta
que un diseñador pueda responder; «si el broker está caído cuando confirmamos el pedido, ¿es
aceptable que ese pedido nunca llegue a facturación?» sí lo es.

## 3. El catálogo

| # | Decisión | Dónde se declara | Paso |
|---|---|---|---|
| 3.1 | Fiabilidad de publicación | `messaging.publishing.reliability` | 3.6 |
| 3.2 | Idempotencia de una operación | `use-cases.<op>.idempotency` | 3.2 |
| 3.3 | Caché de una query | `use-cases.<op>.cache` | 3.2 |
| 3.4 | Superficie M2M (audiencia del endpoint) | `use-cases` + `api.endpoints.<op>.audience` | 3.4 |
| 3.5 | Política de fallo de una suscripción | `messaging.subscriptions.<E>.onFailure` | 3.6 |
| 3.6 | Resiliencia de una llamada saliente | `http-clients.clients.<c>.calls.<l>` | 3.7 |
| 3.7 | Frontera transaccional | `persistence.consistency.transactionalBoundary` | 3.8 |
| 3.8 | Paginación de una colección | `use-cases` (`paginated`) + `api.pagination` | 3.4 |
| 3.9 | Concurrencia sobre la misma entidad | `persistence.consistency.optimisticLocking` + `use-cases.<op>.errors` | 3.2 y 3.8 |
| 3.9b | Rastro de auditoría | `persistence.audit` (+ campos reservados en `domain`) | 3.8 |
| 3.11 | Compensación de un trabajo encargado | `dependencies.<dep>.compensations` + `use-cases.<op>.transitions` | 3.7 |
| 3.10 | Visibilidad de un bucket | `storage.buckets.<b>.visibility` | 3.9 |

---

### 3.1 Fiabilidad de publicación — `reliability: outbox | best-effort`

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Pérdida** | Si la operación confirma y el broker está caído en ese instante, ¿es aceptable que ese evento no llegue nunca? | "No" → `outbox`. "Sí, se reconcilia por otra vía" → `best-effort`. |
| **Consumidor** | ¿Qué hace el consumidor con el hecho: mueve dinero, factura, notifica, alimenta un informe? | Efecto irreversible o contable → `outbox`. Informativo → `best-effort` viable. |
| **Coste** | `outbox` exige capa `persistence` y una tabla + relay que hay que operar y vigilar. ¿Lo asumes? | "No hay persistencia" → o se añade, o el evento no puede ser fiable. |

**Consecuencia observable de `best-effort`**: el estado local cambió y nadie aguas abajo se enteró; no
hay error, no hay reintento, no hay traza. Se descubre semanas después por descuadre.

**Trampa habitual**: "el broker no se cae". El despliegue del broker —o el del propio servicio a mitad
de una publicación— es la caída más frecuente y la más segura de todas: está en el calendario.

`outbox` arrastra la capa `persistence`: es la transacción que confirma lo que el outbox garantiza.
Si el servicio no tiene estado propio, la respuesta correcta no es `best-effort` por descarte — es
revisar por qué un servicio sin estado emite eventos de dominio.

---

### 3.2 Idempotencia — `idempotency: { keySource, ttlSeconds }`

**Antes de los ejes, sitúa el caso.** Hay **tres** ejes de repetición y cada uno tiene su mecanismo;
elegir el equivocado es declarar una garantía que nada implementa:

| Quién repite | Mecanismo | Dónde se declara |
|---|---|---|
| Un llamante HTTP que reintenta (timeout, doble clic) | clave que él manda en una cabecera | `use-cases.<op>.idempotency` ← **esta entrada** |
| El broker, que reentrega el mismo mensaje | id del mensaje, o irrepetibilidad en el dominio | `messaging: subscriptions.<E>.contract.messageId`, o `use-cases.<op>.transitions` |
| **Nosotros**, reintentando contra un proveedor | clave que le mandamos a él | `http-clients.clients.<c>.calls.<x>.idempotency` |

Esta entrada es **solo la primera fila**: `idempotency` solo tiene sentido en una operación **con
endpoint HTTP**, porque su clave entra por ahí. En una operación interna o disparada por evento,
`keel validate` la da en rojo. Si el caso es el segundo, la decisión no es esta: es §3.5 y §3.11.

El tercero es el que más se olvida, porque el reintento parece resiliencia y no repetición: si
la llamada es una escritura ajena —cobrar, reservar, inscribir— cada reintento la ejecuta otra
vez al otro lado, y un timeout no distingue «no llegó» de «llegó y se hizo». Pregunta simple:
*«si esta llamada se manda dos veces, ¿el proveedor hace el trabajo dos veces?»*. Si la respuesta
es sí y él ofrece una cabecera de idempotencia, decláralo; si no la ofrece, escríbelo en el
`contract` — es la deuda que después tendrá que ir a limpiar una compensación.

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Quién repite** | ¿Puede un cliente ejecutar esto dos veces: un timeout que reintenta, un usuario que pulsa dos veces, un reproceso manual? | Sí → hace falta `idempotency`. (Si quien repite es el broker, el mecanismo es otro: ver la tabla de arriba.) |
| **Daño** | Si se ejecuta dos veces, ¿qué pasa? | Doble cobro, doble alta, doble envío → obligatoria. Naturalmente idempotente (fijar un estado a un valor) → declarar que lo es basta. |
| **Origen de la clave** | ¿Puede el llamante HTTP generar y repetir un identificador de intento? | Sí → `client-key`. No, pero el mismo cuerpo significa la misma intención → `payload-hash`. En ambos casos la clave viaja por la superficie HTTP. |
| **Ventana** | ¿Cuánto tiempo debe una repetición devolver el resultado original en vez de ejecutarse de nuevo? | El `ttlSeconds`; pregúntalo en unidades de negocio ("el reintento del cliente entra en minutos"). |

**Consecuencia observable de no declararla**: en una red real, con reintentos, el duplicado no es
probable — es seguro. La pregunta es cuándo, no si.

**Trampa habitual**: `payload-hash` sobre un payload que lleva `timestamp`, `requestId` o un uuid
generado por el cliente. Dos envíos idénticos producen hashes distintos y no deduplica nada. Si el
payload no es estable, la única respuesta correcta es `client-key`.

Toda operación disparada por una suscripción con `retry.maxAttempts > 1` necesita estar protegida
contra el doble efecto; **`keel validate` lo da en rojo** si no lo está por ninguno de los dos
mecanismos del eje de eventos (`contract.messageId` en la suscripción, o una `transitions` de
lifecycle irrepetible). El caso de **esta** entrada, en cambio, no lo comprueba nadie y depende
enteramente de esta conversación: un `POST` de cobro expuesto a clientes con timeout necesita
`idempotency` igual, y nada lo detecta.

---

### 3.3 Caché de una query — `cache: { ttlSeconds, keyFields, invalidatedBy }`

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Tolerancia** | ¿Qué pasa en el negocio si esta respuesta refleja el mundo de hace N minutos? | "Nada" → candidata. "Se cobra mal / se decide mal" → sin caché. |
| **Invalidación** | Enumera **todas** las vías por las que este dato cambia: operaciones propias **y** eventos ajenos. | Cada una es una entrada de `invalidatedBy`. Si no puedes enumerarlas, no hay caché. |
| **Proyección** | ¿El `output` trae algún `embed`? Entonces repite la pregunta anterior **sobre la entidad embebida**, no solo sobre la principal. | Los eventos de esa entidad también son entradas de `invalidatedBy`. |
| **Clave** | ¿Qué campos del input distinguen una respuesta de otra? ¿Depende de **quién** pregunta? | Los `keyFields`. Si depende de la identidad del llamante y no está en el input, cachear filtra datos entre usuarios. |

**Consecuencia observable de un `invalidatedBy` incompleto**: el dato rancio se sirve hasta que expire
el TTL o hasta que alguien toque una de las vías que sí están listadas. Es el fallo más silencioso de
esta entrada, porque el servicio responde `200` y nada distingue una respuesta vieja de una fresca.

**El caso del `embed` es peor que un olvido.** Una ficha que proyecta `brand` y `category` como objetos
anidados depende de tres agregados, no de uno, pero es fácil enumerar solo las vías del principal. Y si
esas entidades no publican **ningún** evento, `invalidatedBy` no es que esté incompleto: la invalidación
es imposible de expresar, y el TTL pasa a ser la única cota. `keel validate` lo marca en rojo, así que
la decisión hay que tomarla aquí, y solo hay tres salidas legítimas:

1. Declarar los eventos de esa entidad en `messaging` y añadirlos a `invalidatedBy`.
2. Quitar el `embed` — el consumidor recibe el id y lee el objeto por su propia vía, sin caché de por medio.
3. Aceptar el staleness acotado por el TTL, lo que obliga a quitar la caché o a bajar el TTL a algo que
   el negocio tolere.

Lo que **no** es una salida es dejarlo escrito en `rules` y esperar que el generador lo resuelva: si
además algún escenario de validación exige ver el cambio reflejado de inmediato, el diseño se está
contradiciendo a sí mismo y ese conflicto se paga entero en la fase de generación.

**Trampa habitual**: cachear una query que devuelve campos que dependen del rol o de la propiedad del
recurso. Si dos usuarios distintos comparten clave de caché, el primero decide lo que ve el segundo.

Solo aplica a `kind: query`. Si aparece la tentación de cachear un command, lo que se busca de verdad
es idempotencia (3.2).

---

### 3.4 Superficie M2M — audiencia del endpoint

**La preferencia por defecto de Keel: cada consumo servidor-a-servidor tiene operación propia en
`use-cases` y endpoint propio con `audience: services`.**

No es duplicación gratuita. En el DSL `api.endpoints` se indexa **por nombre de operación**, así que
compartir endpoint es compartir output, errores, paginación y scopes. Y los dos contratos crecen en
direcciones opuestas: el de máquina tiende a lotes, campos estables y respuestas sin adorno de
pantalla; el de usuarios, a lo contrario. Sin operación propia no pueden divergir sin romperse
mutuamente — y el que se rompe es siempre el que tiene otro equipo acoplado detrás.

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Consumidor** | ¿Qué servidor consume esto, y qué necesita realmente: un recurso, o N recursos de golpe? | "N de golpe" → operación M2M propia de lote, casi siempre. |
| **Ritmo** | ¿Puede el contrato de usuarios cambiar sin avisar al servidor consumidor? | "No" → operación propia: el contrato M2M es estable por definición. |
| **Forma** | ¿La respuesta que quiere la máquina es la misma que pinta la pantalla? | "No" (campos de presentación, textos, agregados de UI) → operación propia. |

Pregunta con `AskUserQuestion` y tres opciones reales:

| Opción | Qué implica | Consecuencia |
|---|---|---|
| **Operación M2M propia** (recomendada) | Nueva operación en `use-cases` + endpoint `audience: services` + scopes propios en `security` | Los dos contratos evolucionan por separado. Cuesta una operación más en el spec. |
| `audience: both` | Un endpoint sirve a los dos públicos | Legítimo, pero **es la excepción**: cualquier cambio para usuarios es un cambio para el consumidor servidor. Exige rationale. |
| No exponerlo a máquinas | El dato se comparte por evento, o no se comparte | A veces la respuesta correcta: no todo dato debe ser un endpoint. |

Nombra la operación por su **intención de máquina** (`listProductsBatch`,
`getProductPriceForServices`), nunca duplicando la de usuarios con un sufijo casual.

**Trampa habitual**: descubrir la necesidad M2M al final, cuando el endpoint de usuarios ya existe, y
"aprovecharlo" con `both` por no añadir una operación. Es exactamente el momento en que más barato
sale separarlos.

Toda operación con `audience: services`/`both` arrastra `security` (`level: service` + scopes, un
`serviceClient` por consumidor con mínimo privilegio) y aparece en el `INTEGRATION.md` que produce
`/keel-integrate`: es contrato público desde el primer día.

---

### 3.5 Política de fallo de una suscripción — `onFailure: { retry, deadLetter }`

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Naturaleza del fallo** | Cuando este mensaje falle, ¿será por algo pasajero (la BD no responde) o por algo que no va a cambiar (payload inválido, referencia inexistente)? | Pasajero → `retry` con backoff. Permanente → reintentar no arregla nada: `deadLetter`. |
| **Destino final** | Tras agotar los reintentos, ¿el mensaje se descarta o alguien lo mira? | "Alguien lo mira" → `deadLetter: true` y quién la vigila. "Se descarta" → dilo en voz alta: es pérdida aceptada. |
| **Duplicados** | Con reintentos, el mismo mensaje se procesará dos veces. ¿La operación lo soporta? | Si no → primero 3.2 (idempotencia), después esto. |

**Consecuencia observable de `retry` sin `deadLetter`**: un mensaje envenenado bloquea la partición o
gira para siempre, consumiendo la capacidad del consumidor. No falla nada visible: solo deja de
avanzar.

**Trampa habitual**: reintentar sin ninguna clave de deduplicación — cada reintento es entonces un
procesamiento nuevo y completo. Ojo con el reflejo contrario: **la clave no siempre se declara**. Con
`envelope: keel` ya existe (`metadata.eventId`, que el emisor estampa en el `raise` y viaja intacto),
y declarar un `messageId` propio apuntaría a un metadato nativo del broker que ningún emisor Keel
escribe. `contract.messageId` es para `none`, `wrapped` y canales `external`, donde no hay envoltura
de la que tirar.

---

### 3.6 Resiliencia de una llamada saliente — `timeoutMs`, `retry`, `circuitBreaker`, `fallback`

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Espera** | ¿Cuánto puede esperar **nuestro** cliente por culpa de esta llamada? | El `timeoutMs` sale del presupuesto de latencia de nuestra operación, nunca del SLA ajeno. |
| **Traducción** | Cuando el tercero cae, ¿qué ve el llamante de **nuestra** API? | Un `code` propio declarado en la operación. Un timeout sin traducción es un hueco de contrato. |
| **Degradación** | ¿Podemos dar una respuesta útil y **honesta** sin el dato? | Sí → `fallback` con esa respuesta. No → sin fallback: fallar es la respuesta correcta. |

**Consecuencia observable de un `fallback` mal elegido**: el cliente recibe una respuesta que no puede
distinguir de la buena y toma una decisión con datos falsos. Un fallback que produce datos plausibles
pero incorrectos es peor que el error que evita.

**Trampa habitual**: la llamada externa dentro de una transacción de escritura. El timeout deja la
transacción abierta y arrastra a todo el servicio. Si la llamada tiene que ocurrir, ocurre fuera.

Mismo criterio que el `onMiss.action: degrade` de `dependencies` (ver
`../../keel-consume/references/consume-interview.md § 3`): la coherencia entre ambos la revisa la
clase 8 del análisis de huecos.

---

### 3.7 Frontera transaccional — `transactionalBoundary: per-operation | per-aggregate`

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Atomicidad** | ¿Hay operaciones que tocan **dos** agregados y deben confirmar o fallar juntas? | "Sí, y deben ser atómicas" → `per-operation`. "Cada agregado por su cuenta" → `per-aggregate`. |
| **Concurrencia** | ¿Cuánto contiende esta escritura? Una transacción por operación bloquea más y por más tiempo. | Alta contención → `per-aggregate`, si el negocio lo tolera. |
| **Consistencia aceptada** | Con `per-aggregate`, un cambio puede confirmar y el otro no. ¿Qué se hace entonces? | Si no hay respuesta, la frontera está mal elegida o falta una compensación declarada. |

**Trampa habitual**: elegir `per-aggregate` por rendimiento sin decidir qué pasa con la mitad que
falló. La consistencia eventual es una decisión de negocio, no un ajuste de rendimiento.

`per-aggregate` exige que `domain` declare `aggregates` (`keel validate` lo comprueba). Si `messaging`
declara `reliability: outbox`, el evento comparte esta frontera: las dos decisiones se toman juntas.

---

### 3.8 Paginación de una colección — `paginated` + `api.pagination`

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Cota** | ¿Cuántos elementos puede llegar a devolver esta query el año que viene? | Sin cota conocida → paginada, siempre. |
| **Uso** | ¿El cliente los pinta en pantalla o los procesa entero? | Pantalla → `defaultSize` pequeño. Proceso M2M → probablemente otra operación (3.4) con página mayor. |
| **Orden** | Una colección paginada sin orden **total** reparte mal las páginas: hay elementos que no salen en ninguna. | Orden declarado, con desempate por `id` si el campo puede empatar. |

**Consecuencia observable de no paginar**: no se nota en desarrollo y tumba el servicio en producción
el día que un cliente tiene mil registros en vez de diez.

---

### 3.9 Concurrencia sobre la misma entidad

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Pérdida de actualización** | Si dos peticiones modifican la misma entidad a la vez, ¿es aceptable que la segunda pise a la primera? | "Sí" → `optimisticLocking: none`, último gana, y se dice explícitamente. "No" → `all` (o `declared` si conviven agregados con y sin necesidad de conflicto), y el cliente recibe `409`. |
| **Leer-y-luego-escribir** | ¿Hay operaciones que deciden en función de lo que acaban de leer (reservar stock, asignar numeración, comprobar un cupo)? | Sí → es una condición de carrera salvo que se declare la política. |
| **Colisión de unicidad** | Por cada campo `unique`: ¿está declarado el error de colisión en las operaciones que lo escriben? | Falta un `code` estable si no. |

**Trampa habitual**: dar "último gana" por supuesto porque nadie preguntó. Es una respuesta legítima
—en muchos dominios, la correcta— pero tiene que ser una elección, no un descuido.

La decisión se **materializa en `persistence`**, así que se toma en el paso 3.2 (con las operaciones
delante, que es donde se ve la contención) y se escribe en el 3.8. `optimisticLocking` tiene default
en el schema (`all`): es de los campos que se escriben solos si nadie los pregunta, y su elección es
observable — cambia el status que ve el cliente. Declararlo en prosa dentro de `rules` no vale:
ningún generador lee prosa.

---

### 3.9b Rastro de auditoría — `persistence.audit`

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Tiempos** | ¿Hace falta saber cuándo se creó y modificó cada registro? ¿Y alguien lo lee desde fuera, o solo se consulta operando la base? | Solo operando → `timestamps: all` (el defecto): la columna existe y no ensucia ningún contrato. Lo lee un cliente → `declared` + los campos en `domain`, porque solo lo que está en `domain` puede salir en un `output`. Nada → `none`. |
| **Autoría** | ¿Hay que poder responder "quién hizo este cambio" —cumplimiento, disputas, soporte—? | Sí → `authorship: all` o `declared` con el mismo criterio de arriba. **Exige capa `security`**: sin principal autenticado no hay autor. |
| **Escrituras sin usuario** | Con autoría: ¿qué se registra cuando el cambio no lo hace una persona (un evento consumido, un proceso nocturno)? | El generador escribe un centinela (`system`), nunca `null`. Si el negocio necesita distinguir *qué* proceso fue, eso es un campo de dominio, no auditoría. |

**Trampa habitual**: pedir `createdBy` y descubrir al validar el flujo que la operación que lo
escribe es un consumidor de eventos, donde no hay usuario. La autoría responde "quién", y en una
escritura asíncrona la respuesta honesta es "nadie": si lo que se necesita es rastrear el origen,
el correlation id ya lo da sin declarar nada.

`timestamps` tiene default (`all`) y `authorship` también (`none`): los dos se escriben solos si
nadie pregunta, y el segundo silencia una necesidad de cumplimiento que aparece tarde.

---

### 3.10 Visibilidad de un bucket — `visibility: private | public`

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Contenido** | ¿Qué hay dentro: material de catálogo que cualquiera puede ver, o documentos de un cliente concreto? | Lo segundo → `private`, sin discusión. |
| **Acceso** | Con `private`, ¿qué operación produce el acceso de lectura: una URL firmada, una descarga mediada? | Si ninguna la produce, el archivo es inaccesible por contrato. |
| **Adivinable** | Con `public`, la URL es la única protección. ¿Es aceptable que quien la tenga la comparta? | "No" → `private`. |

**Trampa habitual**: `public` porque es más cómodo de servir. Un bucket público con identificadores
secuenciales es un listado completo para quien itere.

---

### 3.11 Compensación — `compensations` + la transición de vuelta

Se pregunta **siempre que haya una `activation`**: encargar trabajo a otro y poder fallar después es
lo que crea la deuda. No se pregunta «¿quieres una compensación?» —nadie responde a eso— sino qué
pasa con el trabajo ya hecho.

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Quién** | ¿Esta compensación es **nuestra**? Y si el fallo lo publica un tercero, ¿cómo se entera el proveedor de que su trabajo ya no vale? | Es nuestra si **nosotros** encargamos el trabajo: quien lo encarga es quien lo deshace, y `compensations` vive en el diseño del que llama. Si el fallo lo publica el **proveedor**, ya lo sabe y basta con devolver el estado propio; si lo publica un **tercero** (encargamos stock y lo que falla es el pago), sigue creyendo que su encargo está en pie → hace falta la **activación de vuelta** hacia él. Es el único eje de esta tabla que evita un error de *arquitectura* en vez de uno de implementación: la tentación es que el proveedor se suscriba al fallo, y eso le mete el workflow de todos sus llamantes. |
| **Deuda** | Si le encargamos el trabajo y **luego** fallamos (o el proveedor lo rechaza a posteriori), ¿qué queda hecho que nadie va a deshacer? ¿Quién lo echaría de menos y cuándo? | Algo queda hecho → hace falta compensación, con su evento en `messaging: subscriptions` y su bloque `compensations` (con `undoes`). Nada queda hecho → decláralo, es la respuesta corta. |
| **Doble aplicación** | El evento de fallo llega por un canal que **reentrega**. Si la compensación se ejecuta dos veces, ¿qué pasa? | Doble liberación, doble reembolso, doble aviso → uno de los dos mecanismos del eje de eventos (`contract.messageId` o una `transitions` irrepetible), elegido explícitamente. **Ojo con la respuesta fácil**: `idempotency` en la operación no vale aquí, porque su clave llega por una cabecera HTTP que el broker no manda. «No pasa nada» hay que poder defenderlo con el efecto delante. |
| **Cuántos caminos** | ¿Se puede lanzar la compensación de más de una forma — el evento **y** un endpoint para que un operador la reejecute a mano? | Más de uno → el mecanismo tiene que estar en el **dominio** (`transitions`), no en el borde. `contract.messageId` cierra el listener y la cabecera cierra el filtro: cada una cubre su puerta y deja la otra abierta, y quien reejecuta a mano es justo el que no manda cabecera. `keel validate` lo da en rojo. |
| **Estado propio** | El trabajo que se encarga suele mover el estado de una entidad nuestra. Al deshacerlo, **¿a qué estado vuelve?** | El estado destino → `use-cases.<op>.transitions` en la operación compensadora, **y** la arista correspondiente en `domain: lifecycle.transitions`. |
| **Ventana** | Entre encargar y compensar pasa tiempo. ¿Puede el cliente ver la entidad en el estado intermedio? ¿Es aceptable? | Si no lo es, la frontera transaccional (§3.7) o el `awaits` (§3.6) están mal elegidos, no falta compensación. |
| **Silencio** | **Primero**: ¿hay un estado del `lifecycle` que signifique *«esperando»*? Si el encargo es síncrono y el desenlace se conoce en el acto, no lo hay y este eje se salta —`reconciledBy` sobraría—. Si el encargo se publica y el desenlace llega por un evento posterior, sí lo hay, y entonces: toda la compensación cuelga de que llegue un aviso, **¿y si no llega ninguno?** El proveedor cae, pierde el mensaje, o ni siquiera sabe que su trabajo hay que deshacerlo. ¿Quién se entera, y cuándo? | «Alguien lo verá» no es una respuesta: no hay ningún hecho que dispare nada, y lo que no pasa solo lo detecta un barrido → `activations.<a>.reconciledBy` con una operación `schedule` que recorra los encargos sin desenlace. Pregunta también **cuánto tiempo** es demasiado (es configuración, no código) y **qué hace** con lo que encuentra: reintentar el encargo o compensarlo. `keel validate` avisa si falta. |
| **La DLQ** | Si la compensación falla tantas veces que acaba en la cola de descartes, ¿por dónde se reejecuta? | O el endpoint de la operación (con su guarda de dominio, ver «Cuántos caminos») o el mismo barrido de la reconciliación. Sin ninguno de los dos, el final de ese mensaje es que alguien abra la base de datos a mano. |
| **Orden** | El evento de compensación puede llegar **antes** que el hecho que compensa: entre que confirmamos nuestro trabajo y que el proveedor publica su fallo no hay orden garantizado. Si llega primero, ¿qué pasa? | Se rechaza —la transición no sale del estado en que aún no estamos—, así que la respuesta la da la política de la suscripción: `onFailure.retry` absorbe la carrera sin que nadie intervenga, y `deadLetter` es la red por si no se resuelve. Sin ninguno de los dos el mensaje se pierde en silencio, y `keel validate` lo da en rojo. No es un caso exótico: es el orden normal de dos hechos concurrentes. |

**Consecuencia observable de no declararla**: el sistema queda con dos verdades distintas y ninguna
alarma. El stock reservado que nadie libera no da error — da faltantes semanas después.

**Trampa habitual, y la razón de que este eje exista**: declarar la compensación y olvidar la arista
de vuelta en el `lifecycle`. El diseño valida en verde, el generador deriva del `lifecycle` un guard
que rechaza cualquier transición no declarada, y la compensación falla **en cada ejecución** — el
peor sitio posible para un fallo, porque solo se ejecuta cuando algo ya había salido mal. Desde
2.6 `keel validate` lo da en rojo, pero la respuesta («¿a qué estado vuelve?») sigue siendo del
diseñador: la CLI comprueba que la arista existe, no que sea la correcta.

**No confundir con `onFailure`** (§3.6): `onFailure` es qué hacemos si el encargo **no sale**; la
compensación es qué hacemos con el encargo que **sí salió** y luego dejó de valer.

---

## 4. Checklist de cierre

- [ ] Toda entrada aplicable del catálogo tiene **decisión explícita del diseñador**, o pendiente anotado.
- [ ] Ninguna se escribió por **default tácito** (ni siquiera las que coincidían con tu recomendación).
- [ ] Cada pregunta ofreció la opción «sin \<mecanismo\>» con su **consecuencia observable**.
- [ ] Las decisiones que se apartan de la recomendación tienen su porqué anotado para `/keel-handoff`.
- [ ] `reliability: outbox` ⇒ existe capa `persistence`, y su frontera transaccional se decidió a la vez.
- [ ] Toda operación disparada por una suscripción con `retry` está protegida contra el doble efecto.
- [ ] Toda `activation` que puede quedar hecha tras un fallo posterior tiene compensación, o su ausencia tiene un porqué escrito.
- [ ] Toda compensación declara **cómo** no se aplica dos veces y **a qué estado vuelve** la entidad propia (con la arista en `domain: lifecycle`).
- [ ] Toda operación que cambia un estado del `lifecycle` lo declara en `transitions`: ninguna arista de la máquina de estados se queda sin operación que la ejecute.
- [ ] Todo `cache.invalidatedBy` enumera **todas** las vías de mutación, propias y ajenas.
- [ ] Todo consumo M2M tiene operación propia, o `audience: both` con rationale escrito.
- [ ] `optimisticLocking` se eligió con la contención de las escrituras delante, no se heredó del default.
- [ ] `audit.timestamps` y `audit.authorship` se preguntaron: si el rastro es parte del contrato es `declared` (campos en `domain`), no `all`.
- [ ] Cada capa cerró con su **registro de decisiones estructurales** (elección, porqué, alternativa descartada): es lo que la clase 16 del análisis de huecos audita, y sin él ese barrido se hace contra la memoria.
- [ ] Los pendientes estructurales están enumerados en el cierre de sesión, con nombre de operación o capa.
