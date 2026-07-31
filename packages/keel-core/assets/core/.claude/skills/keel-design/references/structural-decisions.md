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

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Quién repite** | ¿Quién puede ejecutar esto dos veces: un cliente con timeout que reintenta, una suscripción con `retry`, un usuario que pulsa dos veces? | Cualquiera de los tres → hace falta `idempotency`. |
| **Daño** | Si se ejecuta dos veces, ¿qué pasa? | Doble cobro, doble alta, doble envío → obligatoria. Naturalmente idempotente (fijar un estado a un valor) → declarar que lo es basta. |
| **Origen de la clave** | ¿Puede el llamante generar y repetir un identificador de intento? | Sí → `client-key`. No, pero el mismo cuerpo significa la misma intención → `payload-hash`. |
| **Ventana** | ¿Cuánto tiempo debe una repetición devolver el resultado original en vez de ejecutarse de nuevo? | El `ttlSeconds`; pregúntalo en unidades de negocio ("el reintento del cliente entra en minutos"). |

**Consecuencia observable de no declararla**: en una red real, con reintentos, el duplicado no es
probable — es seguro. La pregunta es cuándo, no si.

**Trampa habitual**: `payload-hash` sobre un payload que lleva `timestamp`, `requestId` o un uuid
generado por el cliente. Dos envíos idénticos producen hashes distintos y no deduplica nada. Si el
payload no es estable, la única respuesta correcta es `client-key`.

Toda operación disparada por una suscripción con `retry.maxAttempts > 1` necesita `idempotency`;
`/keel-validate` lo da por **error**. Pero no es el único caso: un `POST` de cobro expuesto a
clientes con timeout lo necesita igual, y ahí no lo comprueba nadie.

---

### 3.3 Caché de una query — `cache: { ttlSeconds, keyFields, invalidatedBy }`

| Eje | Pregunta al diseñador | Respuesta → decisión |
|---|---|---|
| **Tolerancia** | ¿Qué pasa en el negocio si esta respuesta refleja el mundo de hace N minutos? | "Nada" → candidata. "Se cobra mal / se decide mal" → sin caché. |
| **Invalidación** | Enumera **todas** las vías por las que este dato cambia: operaciones propias **y** eventos ajenos. | Cada una es una entrada de `invalidatedBy`. Si no puedes enumerarlas, no hay caché. |
| **Clave** | ¿Qué campos del input distinguen una respuesta de otra? ¿Depende de **quién** pregunta? | Los `keyFields`. Si depende de la identidad del llamante y no está en el input, cachear filtra datos entre usuarios. |

**Consecuencia observable de un `invalidatedBy` incompleto**: el dato rancio no se sirve "un rato"
—se sirve **indefinidamente**, hasta que alguien toque una de las vías que sí están listadas. Es el
fallo más caro de esta entrada y el más silencioso.

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

**Trampa habitual**: reintentar sin `messageId` en el `contract`. Sin clave de deduplicación, cada
reintento es un procesamiento nuevo y completo.

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

## 4. Checklist de cierre

- [ ] Toda entrada aplicable del catálogo tiene **decisión explícita del diseñador**, o pendiente anotado.
- [ ] Ninguna se escribió por **default tácito** (ni siquiera las que coincidían con tu recomendación).
- [ ] Cada pregunta ofreció la opción «sin \<mecanismo\>» con su **consecuencia observable**.
- [ ] Las decisiones que se apartan de la recomendación tienen su porqué anotado para `/keel-handoff`.
- [ ] `reliability: outbox` ⇒ existe capa `persistence`, y su frontera transaccional se decidió a la vez.
- [ ] Toda operación disparada por una suscripción con `retry` declara `idempotency`.
- [ ] Todo `cache.invalidatedBy` enumera **todas** las vías de mutación, propias y ajenas.
- [ ] Todo consumo M2M tiene operación propia, o `audience: both` con rationale escrito.
- [ ] `optimisticLocking` se eligió con la contención de las escrituras delante, no se heredó del default.
- [ ] `audit.timestamps` y `audit.authorship` se preguntaron: si el rastro es parte del contrato es `declared` (campos en `domain`), no `all`.
- [ ] Cada capa cerró con su **registro de decisiones estructurales** (elección, porqué, alternativa descartada): es lo que la clase 16 del análisis de huecos audita, y sin él ese barrido se hace contra la memoria.
- [ ] Los pendientes estructurales están enumerados en el cierre de sesión, con nombre de operación o capa.
