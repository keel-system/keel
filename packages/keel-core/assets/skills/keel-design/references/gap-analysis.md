# Análisis de huecos del diseño

Procedimiento del paso **4b** de `/keel-design`. Se ejecuta con `keel validate` en verde, antes de escribir los escenarios de validación.

## Qué es un hueco

**La validación demuestra que el diseño es consistente; el análisis de huecos busca lo que el diseño no dice.**

Un **hueco** es una decisión funcional que el diseño no toma y que, sin embargo, alguien tendrá que tomar: el agente que genere el código. Como no está en los artefactos, cada generador la resolverá a su manera — y dos servidores del mismo diseño dejarán de comportarse igual.

Ninguna regla mecánica puede verlos, porque **no hay nada roto que detectar**: no hay referencia colgante, ni schema incumplido, ni tipo inexistente. Un estado del `lifecycle` al que ninguna operación conduce, una query de colección sin orden, un `error` que ninguna guarda puede disparar, un borrado sin política para las entidades hijas — todo eso pasa `keel validate` en verde y pasa también la checklist semántica de `/keel-validate`, que revisa la **calidad de lo declarado**, no la **ausencia de lo no declarado**.

Distinción operativa:

| | Qué busca | Quién |
|---|---|---|
| `keel validate` | referencias rotas, schema incumplido | CLI (mecánico) |
| `/keel-validate` nivel 3 | calidad y coherencia de lo que **está** declarado | checklist semántica |
| **Análisis de huecos** | lo que **falta** decidir, y nadie echa de menos | este documento |

## Procedimiento

0. **Inventario de barrido.** Antes de mirar ninguna clase, enumera **las unidades** que hay que recorrer. Es el mismo movimiento —y por la misma razón— que el inventario de obligaciones de `scenario-authoring.md § 1`: recorrer las clases y ver si "parece completo" produce cobertura del camino feliz y huecos sistemáticos en todo lo demás. Es un borrador de trabajo, no va a ningún artefacto:

   | Fuente | Unidades | Clases |
   |---|---|---|
   | `domain.entities[].lifecycle` | `Order`, `Shipment` | 1, 3 |
   | `domain` campos `computed`/`generated`/requeridos | … | 3 |
   | `domain` campos `unique`, agregados | … | 4, 6 |
   | `use-cases` `kind: command` | `createOrder`, `cancelOrder`, … | 2, 3, 4, 16 |
   | `use-cases` `kind: query` (y su `cache`) | `listOrders`, `getOrder`, … | 5, 15, 16 |
   | `use-cases[].schedule` | `reconcilePrices` | 13 |
   | `messaging.publishing.events` · `subscriptions` | … | 7, 16 |
   | `dependencies[].needs` · `http-clients` `calls` | … | 8, 16 |
   | `security.access` / operaciones sobre datos de un titular | … | 9 |
   | `storage.buckets` | … | 10, 16 |
   | `mail.sentBy` (las operaciones que mandan correo) | … | 17, 2, 16 |
   | `api.endpoints` `audience: services`/`both` | … | 11, 15 |
   | `persistence.entities` · `consistency` | … | 14, 16 |
   | todo el servicio | — | 12 |

1. **Barrido con evidencia.** Recorre **por unidad, no por clase**: para cada unidad del inventario, las clases que le aplican. La dirección importa por la misma razón que en los escenarios — el sesgo está en no echar de menos lo que nunca escribiste, y una clase recorrida "en general" es una clase no recorrida. Cada hallazgo debe poder señalarse con nombre de operación, entidad o campo.

   Cada clase abre con su **disparador**; salta solo las que no lo tengan. Ojo con los disparadores **por ausencia** (`api` sin `security`, entidad con campo de estado sin `lifecycle`, eventos publicados sin `persistence`): son huecos que no tienen dónde vivir en el YAML, y por eso nadie los echa de menos.

   Que `/keel-validate` mire algo parecido **no** es motivo para saltarse una unidad: su checklist juzga la calidad de lo **declarado** y esto busca la **ausencia**. Ese atajo es exactamente lo que vacía de contenido la tabla del paso 2.

2. **Dos tablas.** Presenta al usuario la **cobertura** y los **hallazgos**, en ese orden. La primera es la que hace auditable el barrido: sin ella, una clase recorrida y limpia es indistinguible de una clase saltada.

   **Cobertura** — ninguna clase puede faltar; "no aplica" exige nombrar el disparador ausente; un veredicto sin unidades enumeradas no cuenta como recorrido:

   | Clase | Aplica | Unidades recorridas | Veredicto |
   |---|---|---|---|
   | 5. Consultas | sí | `listOrders`, `searchOrders`, `getOrderHistory` | 1 hueco (#2), 2 ok |
   | 9. Autorización a nivel de dato | sí | 11/11 operaciones | 2 huecos (#1, #4) |
   | 10. Archivos | no — sin capa `storage` | — | — |
   | 17. Correo saliente | no — sin capa `mail` | — | — |

   **Hallazgos** — todo lo encontrado, ordenado por severidad:

   | # | Clase | Dónde | Qué no dice el diseño | Propuesta |
   |---|-------|-------|------------------------|-----------|
   | 1 | Alcanzabilidad | `Order.lifecycle: refunded` | Ninguna operación transiciona a `refunded` | Añadir `refundOrder`, o quitar el estado |
   | 2 | Consultas | `listOrders` | Sin orden declarado ni paginación | Orden por `createdAt` descendente + `paginated` |

   Severidades: **hueco** (hay que decidir algo, bloquea el cierre), **riesgo** (decidible por defecto razonable, pero conviene explicitarlo). Lo que está resuelto no va aquí: va como `ok` en la tabla de cobertura, que es donde se ve que lo miraste.

3. **Cierre uno a uno.** Cada hueco se cierra con una **decisión del usuario**, no con una corrección tuya. Usa `AskUserQuestion` cuando haya opciones claras (p. ej. "al borrar el pedido, ¿las líneas se borran en cascada o se bloquea el borrado?"). **Nunca corrijas el spec en silencio**: un hueco es una pregunta de negocio disfrazada de omisión técnica. Cada hallazgo acaba con una de tres etiquetas, y ninguna otra cosa cuenta como cerrado:

   - **decidido** — la decisión está materializada en el artefacto correspondiente.
   - **aceptado** — el diseñador vio la **consecuencia observable** y eligió no actuar. Exige la frase del porqué: es rationale para `/keel-handoff`, y sin ella "aceptado" y "no lo miramos" se escriben igual.
   - **abierto** — bloquea el cierre del análisis.

   **Hay huecos que no admiten `aceptado`**: toda la clase 9, el `http` de cada error (clase 2), el orden de las colecciones (clase 5) y las convenciones de la clase 12. En esos el generador está **obligado** a elegir algo y no existe default seguro, así que "aceptado" significa literalmente "que lo decida el generador" — que es justo lo que esta metodología existe para impedir. O se decide, o queda **abierto**.

4. **Re-validación.** Tras materializar los cambios, vuelve a ejecutar `keel validate specs/<servicio>` — tocar artefactos puede romper referencias cruzadas.

5. **Cierre del análisis.** Termina reportando la **tabla de cobertura** (no solo los hallazgos) y una de dos frases explícitas:
   - "Sin huecos abiertos: N hallazgos, M decididos y K aceptados con su porqué."
   - "N huecos abiertos: …" — con la lista y por qué no se pudieron cerrar. El diseño **no está terminado** mientras quede uno.

Un análisis que no encuentra nada en un servicio de tamaño real es sospechoso: casi siempre significa que no se hicieron las preguntas de las clases 4, 6, 8, 9, 13 y 14, que son las que exigen pensar en fallos y no en caminos felices — o las de la clase 16, que pregunta **quién** decidió cada cosa.

## Taxonomía

### 1. Alcanzabilidad del ciclo de vida

*Aplica si:* alguna entidad declara `lifecycle` — **o** tiene un campo de estado enum y **no** lo declara (entonces la primera pregunta es por qué las transiciones son libres).

Por cada entidad con `lifecycle`:

- ¿Qué estado tiene la entidad **recién creada**? ¿Lo dice el diseño (`default` del campo) o hay que adivinarlo?
- Por cada estado: ¿hay alguna operación que **lleve** a él? Un estado inalcanzable es diseño muerto o una operación olvidada.
- Por cada transición declarada: ¿qué operación la ejecuta, y **lo declara con `transitions`**? Una transición que nadie ejecuta no es contrato, es intención — `keel validate` lo avisa, pero quién debería ejecutarla es respuesta de diseño.
- ¿Hay estados **terminales**? ¿Es correcto que no tengan salida, o el negocio necesita revertirlos (cancelar, reactivar, devolver)? **Cruza esta pregunta con las `compensations`**: una compensación que tiene que devolver la entidad a un estado anterior necesita esa arista de vuelta declarada aquí, y el estado terminal es justo donde se olvida (clase 8).
- ¿Qué operaciones están **prohibidas** en cada estado, y con qué error? Modificar un pedido entregado suele ser un error declarado que nadie declara.

### 2. Guardas ↔ errores

*Aplica siempre* (todo servicio tiene commands).

Por cada `command`, cruzando `preconditions`, `rules`, `errors` y las constraints de los tipos:

- Por cada `error` declarado: ¿qué guarda concreta lo dispara? Un error sin guarda es inalcanzable — o falta la guarda, o sobra el error.
- Por cada guarda: ¿tiene error propio? Dos guardas distintas compartiendo `code` hacen indistinguibles dos fallos distintos para el cliente.
- ¿El command declara **al menos un** error? Si "no puede fallar", pregunta por: no encontrado, ya existe, estado inválido, sin permiso.
- ¿El **orden** de las guardas es el que el negocio quiere? El orden del array es el contrato de implementación (qué error ve el cliente cuando fallan dos a la vez) y es lo único que lo fija.
- Y antes que eso: ¿es **implementable**? Cada guarda solo puede mirar datos que ya estén resueltos cuando le toca. Buscar un duplicado «dentro de la aplicación» no puede ir antes de resolver esa aplicación, por mucho que el negocio lo prefiera. Un orden imposible lo invierte quien implemente —no tiene otra salida—, y a partir de ahí el diseño y sus escenarios de precedencia describen un servidor que no existe.
- ¿Cada `error` lleva `http`? Es opcional en el schema, pero el escenario lo exige. Si el status no es evidente, **decídelo aquí** — no en el markdown de escenarios. No admite cierre `aceptado`: sin `http`, cada generador elige el suyo.
- ¿El mismo `code` aparece en operaciones distintas con status distinto? Es legítimo, pero debe ser deliberado y quedar declarado en ambas.

### 3. Determinación del estado

*Aplica siempre.*

Campo a campo, en `domain`:

- Cada campo `computed`: ¿está su **regla**? Y más importante, ¿**cuándo** se recalcula — en cada escritura, solo si su fuente cambió, bajo demanda?
- Cada campo `generated`: ¿quién lo asigna y con qué criterio (secuencia, uuid, marca de tiempo de servidor)?
- Cada campo **requerido**: ¿de dónde sale? Si no llega en ningún input, no es `computed` ni `generated` y no tiene `default`, hay un hueco.
- Campos con `default` implícito en la prosa pero no en el artefacto.
- Campos que el input **puede omitir** en una actualización parcial: ¿omitir significa "no tocar" o "poner a nulo"? Es la ambigüedad más común y más cara.

### 4. Concurrencia y unicidad

*Aplica si:* hay campos `unique`, dos commands que escriben la misma entidad, o alguna operación alcanzada por reintentos. En un servicio con estado, casi siempre las tres.

- Por cada `unique` en `domain` o `persistence`: ¿hay un `error` de colisión declarado en las operaciones que escriben ese campo?
- ¿Hay algún «**como máximo uno … que cumpla X**»? Una versión activa por clave, un contacto principal por cliente, una suscripción vigente por usuario. Es unicidad **condicionada al estado**, no de columnas, y con `unique` a secas hay que elegir entre lo imposible (no poder tener nunca dos versiones) y lo que no garantiza nada. Se declara con la forma larga de `persistence.entities.<E>.indexes` (`{ fields, unique: true, when: { field, equals } }`, ver `docs/dsl/persistence.md`). La pregunta se hace aquí porque el que responde «sí» casi siempre lo tenía como una regla en prosa dentro de `rules`, donde no la sostiene nada más que el orden de dos escrituras.
- ¿Qué pasa si **dos peticiones concurrentes** ejecutan el mismo command sobre la misma entidad? ¿Último gana, o conflicto explícito? Si el negocio no tolera la pérdida de actualizaciones, hay que declararlo — y el sitio donde se declara es `persistence.consistency.optimisticLocking` (clase 14), no la prosa de `rules`.
- Operaciones con `retry` que las alcanzan: ¿la operación destino es idempotente, y **con el mecanismo del eje correcto**? Si quien reintenta es una subscription, es `contract.messageId` o una transición irrepetible; si es un cliente HTTP contra un endpoint nuestro, es `idempotency`. Declarar el de un eje contra la repetición del otro no protege nada.
- ¿Hay operaciones que **leen y luego escriben** en función de lo leído (reservar stock, asignar numeración)? Ese patrón sin política de concurrencia es una condición de carrera declarada.

### 5. Consultas

*Aplica si:* hay operaciones `kind: query`.

Por cada operación `kind: query`:

- ¿Devuelve **colección**? Entonces: ¿cuál es el **orden**? Sin orden declarado, dos motores devuelven órdenes distintos y ambos son "correctos". ¿Es orden **total** (el campo de orden puede empatar → desempate por id)? No admite cierre `aceptado`.
- ¿Está **paginada**? Una colección que puede crecer sin cota y no pagina es un problema de diseño, no de rendimiento.
- ¿Con qué criterios se **filtra**, y qué pasa con los filtros combinados?
- ¿Qué devuelve cuando no hay resultados: colección vacía o `404`?
- ¿Devuelve campos `sensitive`, directamente o a través de una relación?
- Si tiene `cache`: ¿`invalidatedBy` cubre **todas** las operaciones y eventos que mutan lo cacheado? Basta una vía de mutación no listada para servir datos rancios indefinidamente.

### 6. Fronteras del agregado y cascadas

*Aplica si:* hay más de una entidad, haya o no `aggregates` declarados — la ausencia de agregados en un dominio con relaciones es en sí misma la primera pregunta.

- Al **borrar** una raíz de agregado: ¿qué pasa con las entidades internas? ¿Y con las referencias por id desde otros agregados — quedan colgantes, o el borrado se bloquea con un error declarado?
- ¿Hay borrado **lógico** (estado `archived`) o físico? Si es lógico, ¿las queries lo filtran?
- Las entidades hijas: ¿se gestionan **solo** a través de la raíz, o hay operaciones propias? Si hay operaciones propias sobre una entidad interna, cuestiona la frontera del agregado.
- Al **reemplazar** una colección de hijas en una actualización, ¿se sustituye entera o se hace merge por id?
- Invariantes que necesitan datos de **otro** agregado: no son verificables transaccionalmente; o el agregado está mal cortado o la invariante es eventual (y debe decirlo).

### 7. Contrato de eventos

*Aplica si:* hay capa `messaging`. Y si hay `publishing.events` **sin** capa `persistence`, esa es la primera pregunta: un evento que no comparte transacción con nada no puede prometer que se emitió.

Por cada evento de `messaging.publishing`:

- ¿Quién lo **consume**? Un evento sin consumidor conocido es contrato público (y por tanto un compromiso) o es ruido. Que el usuario elija a sabiendas.
- ¿El **payload** lleva lo que un consumidor necesitaría, o obliga a llamar de vuelta a la API? Un evento anémico convierte cada consumidor en un cliente HTTP.
- ¿Lleva lo necesario para **deduplicar y ordenar** (identificador del evento, identificador de la entidad, momento)?
- ¿Se emite dentro de la misma transacción que el cambio de estado? Si el evento puede perderse cuando la operación falla después, hace falta `outbox` — y `persistence`.
- ¿Qué pasa si el mismo evento se emite **dos veces**? Todo consumidor debe poder soportarlo.

Por cada suscripción:

- ¿Tiene `messageId` para deduplicar? Con `retry` y sin `messageId`, los duplicados son seguros, no probables.
- ¿La operación disparada es idempotente?
- ¿Qué se hace con un mensaje que **nunca** va a poder procesarse (payload inválido, referencia inexistente)? ¿DLQ, o reintento infinito?
- ¿El evento llega **antes** que la entidad que referencia? Es el fallo de orden más común entre servicios. Si el servicio mantiene una réplica de esa entidad, la respuesta se declara: es su `dependencies.*.replica.onMiss` (ver clase 8).

### 8. Fallo de dependencias externas

*Aplica si:* hay capa `dependencies`, `http-clients` o suscripciones a eventos ajenos.

Si el servicio declara la capa `dependencies`, este barrido se hace **por `need` y por `activation`**, no por cliente: la unidad de análisis es el dato que necesitamos o el trabajo que encargamos, no el canal por el que viaja.

Por cada cliente de `http-clients`, cada suscripción, cada `need` y cada `activation`:

- Cuando la dependencia **cae o tarda**, ¿qué ve el llamante de nuestra API? ¿Un error declarado con `code` propio, o un fallo genérico? Un timeout sin traducción a error de negocio es un hueco de contrato.
- El `fallback` del circuit breaker: ¿produce un resultado **correcto** (valor por defecto aceptable para el negocio) o solo evita el error? Un fallback que devuelve datos falsos silenciosamente es peor que fallar. **Mismo criterio para `onMiss.action: degrade`**: si el cliente no puede distinguir la respuesta degradada de la normal, no es degradación, es un bug declarado.
- Y la pregunta que traslada esa respuesta al YAML en vez de dejarla en la conversación: ¿está declarada en `onUnavailable`? Un `need` con `fetchedFrom` y sin ella deja la política en manos de quien construya (`keel validate` lo avisa). Si la elegida es `lastKnown`, lo que cierra la decisión no es «¿podemos servir el último valor?» sino **¿durante cuánto deja de ser cierto?** (`maxAgeSeconds`) y **¿qué pasa la primera vez, cuando no hay ningún valor que servir?** (el `error`): un servidor recién arrancado no tiene último valor conocido, y una política sin esa segunda respuesta degrada a fallar siempre justo el día que más se la necesita.
- ¿La llamada externa ocurre **dentro** de una transacción de escritura? Si sí, un timeout deja la transacción abierta: hay que separar. Ojo con los `need` de `strategy: on-demand` usados por un `command`.
- Si la llamada externa es una **escritura** que no podemos deshacer y luego fallamos, ¿queda inconsistencia? ¿Hay compensación? Si la hay, ¿está declarada en `dependencies.<dep>.compensations` (con su `undoes` apuntando a la activación que revierte) y respaldada por una suscripción real, o solo vive en la conversación?
- Si la llamada externa es una **escritura** y tiene `retry`, ¿el proveedor ejecuta el trabajo dos veces cuando reintentamos? Un timeout no distingue «no llegó» de «llegó y se hizo». Si el proveedor honra una cabecera de idempotencia, va en `http-clients.calls.<x>.idempotency`; si no la honra, tiene que estar escrito en su `contract` — es deuda que hereda quien lea el diseño después.
- Y el desenlace que no produce ningún hecho: si le encargamos trabajo y **no llega ninguna respuesta ni ningún evento**, ¿quién lo detecta? Sin `activations.<a>.reconciledBy` la respuesta es «nadie»: el encargo queda hecho, nuestra entidad esperando, y el sistema no da error porque no ha pasado nada.
- El hueco simétrico, que se ve menos: una activación cuyo desenlace llega **por evento** y que no deja la entidad en ningún **estado de espera**. Entonces el evento de resultado no tiene dónde aplicarse —no hay transición que ejecutar— y el barrido no tiene qué buscar: `reconciledBy` correría cada N minutos sobre una consulta que no se puede escribir. Reconciliar es sacar de la espera lo que se quedó ahí, así que primero hay que declarar la espera: la `transitions` de la operación que encarga es la que mete la entidad en ella. `keel validate` lo avisa, pero el estado correcto es de diseño.
- Y si la hay, las dos preguntas que la hacen funcionar de verdad —`keel validate` las comprueba, pero la respuesta correcta es de diseño—: (a) el evento de fallo llega por un canal que **reentrega**; si la compensación se ejecuta dos veces, ¿qué pasa? ¿Qué la protege: `contract.messageId` o una transición irrepetible? (`idempotency` no: su clave llega por una cabecera HTTP que el broker no manda, y declararla ahí es error.) (b) el trabajo encargado movió el estado de una entidad nuestra: al deshacerlo, **¿a qué estado vuelve**, y esa arista está en `domain: lifecycle.transitions`? Si el estado de partida es terminal, la respuesta casi siempre es que falta la arista, no que la compensación sobre.

Por cada `activation`:

- ¿Está en la casilla correcta? Un `need` con `strategy: on-demand` cuyo `fetchedFrom` apunta a una llamada que **cambia estado** en el proveedor y cuya respuesta no decide nada es una activación mal declarada: el acoplamiento va al revés de como está escrito y queda fuera del mapa del sistema.
- Si ese trabajo **no llegara a hacerse**, ¿quién lo echaría de menos y cuándo se enteraría? Es la pregunta que valida el `awaits` y el `onFailure`: con `awaits: nothing` o `onFailure: ignore` la operación propia responde éxito y el trabajo puede no existir nunca.
- ¿La activación ocurre **dentro** de la transacción de escritura? Además del timeout, hay un segundo problema que no tiene el `need`: si la transacción falla después, el trabajo ya se encargó y no se deshace solo.
- Con `via: { publishes }`, ¿el proveedor lo declara como `nature: request` en su diseño? Si lo consume como `fact`, nadie se ha comprometido a atenderlo: publicamos y esperamos.
- ¿El `effect` describe lo que el proveedor **hace de verdad**, sacado de su contrato, o es el nombre de la llamada repetido?

Por cada `need` con `strategy: replicated`:

- ¿`fedBy` cubre **todas** las vías de cambio del dato en el proveedor, incluidas **bajas y retiradas**? Si falta la baja, la copia conserva para siempre algo que ya no existe y nadie se entera. Es el hueco más frecuente de esta clase.
- ¿El `onMiss` declarado produce un resultado de negocio **aceptable**, o solo evita el error?
- ¿La copia se lee en algún sitio **como si fuera fuente de verdad** (se expone tal cual en una respuesta, se le aplican invariantes, se escribe desde una operación de negocio)? Es el error de diseño más caro de esta capa.
- ¿Se copian campos que **ninguna** operación de `usedBy` lee? Cada campo copiado es acoplamiento a una decisión ajena.
- ¿Qué pasa si dos eventos del proveedor llegan **desordenados**? La respuesta correcta suele ser del generador (comparar el instante del hecho), pero si el diseño no da ningún instante en el payload, el generador no puede resolverlo: eso sí es un hueco del diseño.

### 9. Autorización a nivel de dato

*Aplica siempre*, incluso —sobre todo— si **no** hay capa `security`: un servicio con api y sin security expone todo a todo el mundo, y eso tiene que ser una decisión dicha en voz alta.

El hueco más caro y el que ninguna regla mecánica puede ver. **Ningún hallazgo de esta clase admite el cierre `aceptado`**: o se decide, o queda abierto.

- Un permiso autoriza la **operación**. ¿Autoriza sobre **ese** recurso concreto? Un rol con `order:read`, ¿lee cualquier pedido, o solo los suyos? El DSL declara lo primero; el negocio casi siempre quiere lo segundo.
- ¿De dónde sale la relación "es suyo": un campo de la entidad (`ownerId`, `customerId`) que se compara con la identidad del token? Si esa relación no está modelada, no se puede implementar.
- Y el síntoma que delata que este hallazgo se cerró sin decidir: un **error 403 declarado** en operaciones cuya regla de acceso solo exige roles o permissions. `keel validate` lo avisa, pero llega tarde a propósito — cuando aparece, el diseño ya escribió errores y escenarios contra un alcance que no existe. La pregunta se hace aquí, antes.
- Las **queries de colección**: ¿devuelven todo, o solo lo del solicitante? Es el mismo hueco, y aquí se convierte en fuga de datos masiva.
- ¿Hay campos que un rol ve y otro no dentro de la **misma** respuesta?
- Operaciones de mutación con acceso `public`: ¿deliberado?

### 10. Archivos

*Aplica si:* hay capa `storage` o algún campo `type: file`.

- Ciclo de vida del archivo frente al de la entidad: al borrar la entidad, ¿se borra el archivo?
- Al **reemplazar** el archivo de un campo `file`, ¿el anterior se borra o queda huérfano?
- Bucket `private`: ¿qué operación produce el acceso de lectura (URL firmada, descarga mediada)? Si ninguna la produce, el archivo es inaccesible por contrato.
- Subida: ¿el archivo se sube en la misma operación que crea la entidad, o en dos pasos? Si son dos, ¿qué pasa si el segundo no llega?
- ¿`maxSizeMb` y `allowedContentTypes` tienen errores declarados (`FILE_TOO_LARGE`, `UNSUPPORTED_CONTENT_TYPE`) en las operaciones que suben?
- Y en el sentido contrario, el que se olvida: ¿qué devuelve una **lectura** (descarga o URL firmada) cuya clave ya no está en el bucket? Sin un error declarado (`FILE_NOT_FOUND`, `404`) el adaptador propaga la excepción cruda del SDK de storage y sale un `500` que no está en ningún contrato. Pasa más de lo que parece: la entidad conserva la key aunque el objeto se borre o se migre el bucket.

### 11. Superficie servidor-a-servidor

*Aplica si:* `api` declara `audience: services`/`both`, o `security` declara `serviceClients`.

Esta clase y la 8 son **simétricas**: aquí se examina la superficie que **ofrecemos** a otros servidores; la clase 8 examina la que **consumimos** (capa `dependencies`). Recórrelas juntas — un mismo servicio suele estar a los dos lados, y los criterios de calidad se reflejan (un endpoint de lote que le falta a nuestro proveedor es el mismo hueco que un `need` nuestro que obligaría a N llamadas).

- **¿La identidad de quién llama entra en el trabajo?** Si el sistema que llama determina sobre QUÉ datos se opera —sus
  plantillas, sus envíos, sus documentos—, eso se declara con `authentication.callerIdentity`, y entonces el campo deja de
  viajar en el cuerpo: lo estampa el servidor desde la credencial. No decidirlo **no es neutro**: el campo se queda en la
  petición y cualquier cliente autenticado puede escribir la clave de otro y operar sobre sus datos. Es la obligación
  `OBL-CALLER-IDENTITY`, y se cierra en una línea o se acepta por escrito (hay servicios donde quién llama da igual).
- ¿Cada endpoint de máquina tiene un `serviceClient` que lo consuma? Y al revés: ¿cada scope concedido lo exige alguien?
- ¿El contrato está pensado **para servidores**, o es el de usuarios reutilizado? Señales de hueco: el consumidor tendría que llamar N veces (falta un endpoint de lote), o recibe un DTO de pantalla en vez de datos.
- ¿Qué garantías de **estabilidad** tiene ese contrato? Es el que otro equipo va a acoplarse.
- **Todo `audience: both` es un hallazgo de severidad riesgo**, se mire como se mire: la preferencia por defecto de Keel es operación propia para cada consumo M2M (`structural-decisions.md § 3.4`), porque compartir endpoint es compartir output, errores, paginación y scopes entre dos contratos que evolucionan a ritmos distintos. Se cierra con la decisión razonada del diseñador —mantenerlo compartido con su porqué, o separarlo—, nunca dándolo por bueno. Señal de que hay que separarlo ya: la respuesta difiere según el token sea de usuario o de máquina.

### 12. Zonas grises de la equivalencia

*Aplica siempre*, al servicio entero. Sus decisiones tampoco admiten el cierre `aceptado`: una convención sin fijar es divergencia garantizada entre stacks.

Lo que dos stacks resolverían distinto y el diseño rara vez fija. La mayoría se cierra **en el escenario de validación**, no en el YAML (ver `docs/validation-scenarios.md § Determinación observable`); aquí solo hay que **sacarlas a la luz** antes del paso 5, y llevar al YAML las que sean decisiones de negocio:

- **Fechas y horas**: ¿instantes en UTC o fechas locales? ¿Qué zona usa el negocio para "hoy"?
- **Números y dinero**: escala decimal y regla de redondeo. Dos motores redondean distinto el mismo total.
- **Texto**: ¿la unicidad y la búsqueda distinguen mayúsculas y acentos? `ACME` y `acme`, ¿son el mismo nombre?
- **Ausencia**: en las respuestas, ¿un campo sin valor **no aparece** o aparece como nulo? Debe ser la misma convención en todo el servicio.
- **Longitudes y cotas**: campos de texto sin cota superior, listas sin `maxItems`.
- **Idioma y formato de los mensajes de error**: el `code` es contrato; el texto, ¿también?

Al terminar esta clase, deberías poder responder, para el servicio entero: *si dos equipos implementaran este diseño con stacks distintos, ¿en qué podría diferir lo observable?* Todo lo que quede en esa lista debe quedar fijado en los escenarios.

### 13. Ejecuciones programadas

*Aplica si:* alguna operación declara `schedule`.

Un `schedule` es la única superficie del servicio sin cliente que espere respuesta: cuando se comporta mal, no falla nadie visible. Por cada operación programada:

- ¿Qué pasa si una ejecución **tarda más que el intervalo**? ¿Se solapa con la siguiente, se salta, o hay que impedirlo? Dos instancias del servicio disparando el mismo ciclo a la vez es el mismo caso.
- Tras una parada (despliegue, caída, ventana de mantenimiento): ¿el ciclo **recupera** lo que no procesó, o salta al siguiente sin más? Es una decisión de negocio con nombre distinto en cada dominio, y sin ella el generador elige "salta" por omisión.
- ¿Es **idempotente** el ciclo? Un job que se relanza tras un fallo a mitad reprocesa lo ya procesado (enlaza con la clase 4).
- ¿Cuánto procesa por ejecución? Un `schedule` que barre "lo pendiente" sin cota es el mismo problema que un lote sin `maxItems`, con el agravante de que crece solo.
- Si falla a mitad, ¿qué queda hecho y qué no? ¿Se reintenta el ciclo entero, o continúa donde iba?
- ¿En qué **zona horaria** vive el calendario, y qué pasa en los cambios de hora? "Todos los días a las 00:00" no es una hora hasta que se dice de quién (enlaza con la clase 12).
- ¿Es **verificable**? Un `schedule` no se llama desde fuera, así que su escenario se escribe contra el **efecto**: qué cambia ahí fuera cuando el ciclo pasa. Si el diseño no declara ninguno (`transitions`, `emits`), no hay nada que afirmar y el escenario saldrá decorativo. Y si además su condición de entrada es un umbral de tiempo que ninguna suite puede esperar —«lleva 18 meses»—, decide entre las dos únicas salidas honestas: declararlo como hueco, o exponer un disparador manual además del reloj. `keel validate` avisa del caso sin efecto declarado.

### 14. Estado persistido

*Aplica si:* hay capa `persistence` — **o** el servicio tiene entidades y **no** la declara, en cuyo caso la primera pregunta es si de verdad no guarda nada.

- **`consistency.optimisticLocking`**: `all`, `declared` o `none` cambia lo que ve el cliente cuando dos escrituras caen sobre la misma raíz — conflicto `409` frente a último-escritor-gana silencioso. Tiene default en el schema, así que se escribe solo si nadie pregunta. Es la decisión de la clase 4 materializada: si el diseño declara operaciones de leer-y-luego-escribir y `optimisticLocking: none`, eso no es configuración, es una contradicción.
- **`audit.timestamps` / `audit.authorship`**: los dos tienen default (`all` y `none`), así que se escriben solos si nadie pregunta — y el segundo silencia en el proceso una necesidad de cumplimiento. Si el rastro lo lee alguien de fuera, la política es `declared` y los campos van en `domain`: lo que no está ahí no puede salir en un `output`. Y si el diseño pide autoría, comprueba **quién ejecuta cada escritura**: en una operación disparada por una suscripción no hay usuario, y la respuesta honesta a "quién lo hizo" es el correlation id, no un actor inventado.
- Entidades de `domain` que **no aparecen** en `persistence.entities`: ¿son efímeras a sabiendas, o se olvidaron? Una entidad que el diseño trata como duradera y nadie persiste desaparece en el primer reinicio.
- Por cada `naturalKey`: ¿hay un error de colisión declarado en las operaciones que la escriben? Es la clase 4 vista desde la otra capa, y aquí se olvida más.
- **Índices frente a las queries**: por cada criterio de filtro y de orden de una query, ¿lo sostiene algún índice? No es rendimiento, es **cota**: una colección paginada cuyo orden no puede sostenerse deja de responder al crecer, y eso sí es contrato.
- Si hay borrado **lógico** (estado `archived`, campo `deletedAt`): ¿qué queries lo filtran, y qué pasa con la unicidad de un registro borrado (enlaza con la clase 6)? Si la respuesta es «el slug de un archivado puede reutilizarse, pero solo puede haber uno vivo», eso es unicidad **condicionada** y tiene primitivo: `indexes` con `when` (clase 4). Sin él la unicidad se declara sobre todas las filas —y entonces el archivado bloquea el alta nueva para siempre— o no se declara y no la sostiene nadie.
- ¿Los datos se guardan para siempre? Si el negocio tiene retención o archivado, no hay dónde declararlo en el DSL: es un hueco que se cierra con una operación explícita, no con una suposición.

### 15. Superficie HTTP

*Aplica si:* hay capa `api`.

- Con `auto: true`, las rutas públicas las deriva una convención (`docs/dsl/api.md`). **¿Ha visto el diseñador la lista de rutas resultante?** Es contrato público fijado sin que nadie lo aprobara; y las operaciones que no son CRUD son justo donde la derivación produce rutas que nadie querría.
- ¿Qué `successStatus` devuelve cada creación? Es lo único de esto que decide el diseño. La cabecera **`Location` no se declara**: la emite el generador en toda creación `201` cuyo `output` traiga `id`. Lo que hay que cerrar aquí es lo que sí es del diseño: **¿el `output` de cada creación devuelve el `id`?** Si no lo devuelve, el cliente no puede referenciar lo que acaba de crear ni habrá `Location` — casi siempre es un olvido, no una decisión.
- Y por el otro extremo: **¿qué devuelve cada borrado?** Un `output` no-`"void"` en un `DELETE` solo se sostiene si la operación deja el recurso vecino en un estado que el cliente **no puede predecir** —recompactar posiciones, reasignar el elemento principal, recalcular un total—, y entonces el `successStatus` tiene que admitir cuerpo. Si la respuesta a por qué devuelve el agregado es "no lo había pensado", el par correcto es `204` + `output: "void"`, no el cuerpo por inercia de copiar la operación de al lado. Es el hueco que más barato sale cerrar aquí y más caro sale después: el status es contrato público y cambiarlo rompe a quien ya lo consume.
- `defaultAudience` fija la audiencia de todos los endpoints que no la declaran, incluidos los derivados por `auto`. ¿Se miró **uno a uno** cuál queda expuesto a quién, o se heredó en bloque?
- **Versionado**: cuando este contrato cambie de forma incompatible, ¿qué pasa con los consumidores ya acoplados? La respuesta afecta a `basePath` y, si hay superficie M2M, es parte del contrato (clase 11).
- ¿Llama un **navegador** directamente a esta API? Entonces `cors` es parte del contrato, no del despliegue. Si no se declaró, o no lo llama nadie desde el navegador, o el servicio no funcionará ahí.
- Operaciones `internal: true`: ¿quién las invoca de verdad? Una operación sin trigger y sin llamante conocido es código muerto declarado.

No es hueco lo que ya es **contrato canónico** del DSL y por tanto no puede divergir: el sobre de paginación y los nombres `page`/`size` (`docs/dsl/api.md § pagination`). No lo listes.

### 17. Correo saliente

*Aplica si:* hay capa `mail`.

Un correo es el único efecto de un servicio que **llega a una persona real y no se puede
retirar**. Ninguna transacción lo deshace, ningún reintento lo corrige, y el destinatario
ya lo ha leído. Eso cambia el peso de cada hueco de esta clase.

- **La repetición.** ¿Cada operación de `sentBy` tiene guarda (`idempotency` o una transición)? Sin ella, un reintento del llamante —o una reentrega del broker, que es *at-least-once* por definición— manda el correo dos veces.
- **El desenlace del envío que falla.** Si la operación responde antes de enviar (un `202`), ¿qué pasa cuando el envío falla después? ¿Se reintenta, se marca como fallido, se avisa a alguien? Sin desenlace declarado, el correo se pierde en silencio y quien lo pidió cree que salió.
- **El orden de las comprobaciones.** ¿En qué punto exacto se manda respecto a las validaciones y a la persistencia? Cada comprobación que quede *después* del envío es un correo que no se puede retirar.
- **El remitente.** Con `sender.source: data`, ¿qué pasa cuando el dato no lo resuelve? Sin `fallback` no se envía (falla cerrado, que quema menos reputación); con él, se envía desde la genérica. Las dos son decisiones legítimas y opuestas: la que no se toma la toma el generador.
- **Las variables.** Con `templating.declaredVariables`, ¿hay error declarado para la variable obligatoria que falta? Sin él, se interpola vacía y el correo sale diciendo «Tu pedido por  € está confirmado» — un fallo que se descubre por la reclamación del cliente.
- **El destinatario que no debe recibir.** ¿Hay algo que impida enviar a una dirección que rebotó o se quejó? Un rebote duro quema la reputación del remitente, que es **compartida** por todos los consumidores del servicio: no puede quedar en manos de cada llamante.
- **Y por dónde te enteras del rebote.** Es la mitad que casi siempre falta: el relay **acepta** el mensaje y responde OK; el rebote vuelve minutos u horas después. Si alguna regla depende de clasificarlo —suprimir la dirección, contar quejas, distinguir rebote duro de blando—, ¿por qué canal llega esa noticia (un webhook del proveedor, un buzón de retorno, un evento)? Sin canal declarado, esa regla no es implementable ni verificable: ninguna infraestructura de prueba rebota sola. La forma de la decisión ya existe en `dependencies` (`awaits`, `reconciledBy`): un desenlace que llega tarde o no llega.
- **Quién puede pedir el envío.** Si el servicio manda correo por cuenta de varios sistemas, ¿de dónde sale la identidad de quien lo pide — del token, o de un campo del cuerpo? Si viaja en el cuerpo, cualquier cliente autenticado puede enviar en nombre de otro, desde su remitente verificado.


### 16. Decisiones estructurales sin dueño

*Aplica siempre.*

Las quince clases anteriores preguntan **qué** dice o no dice el diseño. Esta pregunta **quién lo decidió**.

Recorre el catálogo de `structural-decisions.md § 3` entrada por entrada y, por cada una que **aplique** a este servicio, comprueba que la eligió el diseñador y no tú. Lo que buscas no deja rastro en el YAML: un `reliability: best-effort` decidido y uno asumido se escriben igual. Por eso el barrido **no se hace contra tu memoria de la sesión** —que en un diseño real ha pasado por horas de conversación y probablemente por una compactación de contexto— sino contra los **bloques de decisiones estructurales** que cerraron cada capa en el paso 3 de `/keel-design`.

**Si esos bloques no están disponibles** (sesión reanudada, contexto compactado, diseño heredado con `--from`), no supongas que se decidió: clasifica como **hueco** toda entrada aplicable del catálogo y vuelve a preguntarla. La asimetría es deliberada — re-preguntar cuesta una pregunta; asumir cuesta un default tácito con apariencia de decisión de negocio, que es exactamente lo que esta clase existe para cazar.

| Aplica si… | Entrada del catálogo | Qué comprobar |
|---|---|---|
| hay `publishing.events` | 3.1 fiabilidad | el valor de `reliability` se eligió; si es `outbox`, existe `persistence` y su frontera se decidió a la vez |
| hay commands expuestos o disparados por eventos | 3.2 idempotencia | se preguntó por cada uno, incluidos los que **no** la llevan |
| hay queries | 3.3 caché | tanto las que la llevan como las que no; en las que la llevan, `invalidatedBy` lo enumeró el diseñador |
| hay `audience: services`/`both` | 3.4 M2M | operación propia, o `both` con rationale escrito |
| hay `subscriptions` | 3.5 política de fallo | `retry`/`deadLetter` elegidos, no heredados de un ejemplo |
| hay `http-clients` | 3.6 resiliencia | timeout, breaker y `fallback` salieron del negocio, no de un valor redondo |
| hay `persistence` | 3.7 frontera transaccional | `per-operation`/`per-aggregate` es elección, no default del template |
| hay queries de colección | 3.8 paginación | paginar o no paginar se decidió con la cota esperada delante |
| hay commands que escriben la misma entidad | 3.9 concurrencia | "último gana" está dicho en voz alta, o hay conflicto declarado; el `optimisticLocking` que lo materializa se eligió, no se heredó del default |
| hay `storage` | 3.10 visibilidad | cada bucket, con su vía de acceso si es `private` |

Severidades de esta clase:

- **hueco** — la decisión está escrita en los artefactos y **nunca se preguntó**. Es lo peor de los dos mundos: tiene la apariencia de una decisión de negocio y el origen de un default tuyo.
- **riesgo** — se preguntó, el diseñador dijo "lo que recomiendes" y se aceptó tu propuesta. Legítimo, pero conviene que quede como rationale explícito en `/keel-handoff`: dentro de seis meses nadie distinguirá eso de una decisión meditada.
- **ok** — decisión del diseñador, con su alternativa descartada anotada. Va a la tabla de cobertura, no a la de hallazgos.

Los huecos de esta clase **no se cierran corrigiendo el artefacto**: se cierran haciendo ahora la pregunta que no se hizo entonces, con su consecuencia observable, y aceptando la respuesta que venga — incluida la de dejarlo como está.
