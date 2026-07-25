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

1. **Barrido.** Recorre las 12 clases de abajo contra los artefactos del servicio. Salta las que no apliquen (sin capa `storage`, no hay clase 10). Trabaja con los artefactos delante: cada hallazgo debe poder señalarse con nombre de operación, entidad o campo.

2. **Tabla de hallazgos.** Presenta al usuario **una sola tabla** con todo lo encontrado, ordenada por severidad:

   | # | Clase | Dónde | Qué no dice el diseño | Propuesta |
   |---|-------|-------|------------------------|-----------|
   | 1 | Alcanzabilidad | `Order.lifecycle: refunded` | Ninguna operación transiciona a `refunded` | Añadir `refundOrder`, o quitar el estado |
   | 2 | Consultas | `listOrders` | Sin orden declarado ni paginación | Orden por `createdAt` descendente + `paginated` |

   Severidades: **hueco** (hay que decidir algo, bloquea el cierre), **riesgo** (decidible por defecto razonable, pero conviene explicitarlo), **ok** (lo miré y está resuelto — no lo listes, solo dilo en el resumen).

3. **Cierre uno a uno.** Cada hueco se cierra con una **decisión del usuario**, no con una corrección tuya. Usa `AskUserQuestion` cuando haya opciones claras (p. ej. "al borrar el pedido, ¿las líneas se borran en cascada o se bloquea el borrado?"). La decisión se materializa en el artefacto correspondiente. **Nunca corrijas el spec en silencio**: un hueco es una pregunta de negocio disfrazada de omisión técnica.

4. **Re-validación.** Tras materializar los cambios, vuelve a ejecutar `keel validate specs/<servicio>` — tocar artefactos puede romper referencias cruzadas.

5. **Cierre del análisis.** Termina con una de dos frases explícitas:
   - "Sin huecos abiertos: N hallazgos, todos cerrados en los artefactos."
   - "N huecos aceptados conscientemente: …" — con la lista y el motivo. Un hueco aceptado es una **decisión de diseño**, así que anótalo para la entrevista de rationale de `/keel-handoff`.

Un análisis que no encuentra nada en un servicio de tamaño real es sospechoso: casi siempre significa que no se hicieron las preguntas de las clases 4, 6, 8 y 9, que son las que exigen pensar en fallos y no en caminos felices.

## Taxonomía

### 1. Alcanzabilidad del ciclo de vida

Por cada entidad con `lifecycle`:

- ¿Qué estado tiene la entidad **recién creada**? ¿Lo dice el diseño (`default` del campo) o hay que adivinarlo?
- Por cada estado: ¿hay alguna operación que **lleve** a él? Un estado inalcanzable es diseño muerto o una operación olvidada.
- Por cada transición declarada: ¿qué operación la ejecuta? Una transición que nadie ejecuta no es contrato, es intención.
- ¿Hay estados **terminales**? ¿Es correcto que no tengan salida, o el negocio necesita revertirlos (cancelar, reactivar, devolver)?
- ¿Qué operaciones están **prohibidas** en cada estado, y con qué error? Modificar un pedido entregado suele ser un error declarado que nadie declara.

### 2. Guardas ↔ errores

Por cada `command`, cruzando `preconditions`, `rules`, `errors` y las constraints de los tipos:

- Por cada `error` declarado: ¿qué guarda concreta lo dispara? Un error sin guarda es inalcanzable — o falta la guarda, o sobra el error.
- Por cada guarda: ¿tiene error propio? Dos guardas distintas compartiendo `code` hacen indistinguibles dos fallos distintos para el cliente.
- ¿El command declara **al menos un** error? Si "no puede fallar", pregunta por: no encontrado, ya existe, estado inválido, sin permiso.
- ¿El **orden** de las guardas es el que el negocio quiere? El orden del array es el contrato de implementación (qué error ve el cliente cuando fallan dos a la vez) y es lo único que lo fija.
- ¿Cada `error` lleva `http`? Es opcional en el schema, pero el escenario lo exige. Si el status no es evidente, **decídelo aquí** — no en el markdown de escenarios.
- ¿El mismo `code` aparece en operaciones distintas con status distinto? Es legítimo, pero debe ser deliberado y quedar declarado en ambas.

### 3. Determinación del estado

Campo a campo, en `domain`:

- Cada campo `computed`: ¿está su **regla**? Y más importante, ¿**cuándo** se recalcula — en cada escritura, solo si su fuente cambió, bajo demanda?
- Cada campo `generated`: ¿quién lo asigna y con qué criterio (secuencia, uuid, marca de tiempo de servidor)?
- Cada campo **requerido**: ¿de dónde sale? Si no llega en ningún input, no es `computed` ni `generated` y no tiene `default`, hay un hueco.
- Campos con `default` implícito en la prosa pero no en el artefacto.
- Campos que el input **puede omitir** en una actualización parcial: ¿omitir significa "no tocar" o "poner a nulo"? Es la ambigüedad más común y más cara.

### 4. Concurrencia y unicidad

- Por cada `unique` en `domain` o `persistence`: ¿hay un `error` de colisión declarado en las operaciones que escriben ese campo?
- ¿Qué pasa si **dos peticiones concurrentes** ejecutan el mismo command sobre la misma entidad? ¿Último gana, o conflicto explícito? Si el negocio no tolera la pérdida de actualizaciones, hay que declararlo.
- Operaciones con `retry` que las alcanzan (subscription con reintentos, `http-clients` con `retry`): ¿la operación destino es idempotente? ¿lo declara (`idempotency`)?
- ¿Hay operaciones que **leen y luego escriben** en función de lo leído (reservar stock, asignar numeración)? Ese patrón sin política de concurrencia es una condición de carrera declarada.

### 5. Consultas

Por cada operación `kind: query`:

- ¿Devuelve **colección**? Entonces: ¿cuál es el **orden**? Sin orden declarado, dos motores devuelven órdenes distintos y ambos son "correctos". ¿Es orden **total** (el campo de orden puede empatar → desempate por id)?
- ¿Está **paginada**? Una colección que puede crecer sin cota y no pagina es un problema de diseño, no de rendimiento.
- ¿Con qué criterios se **filtra**, y qué pasa con los filtros combinados?
- ¿Qué devuelve cuando no hay resultados: colección vacía o `404`?
- ¿Devuelve campos `sensitive`, directamente o a través de una relación?
- Si tiene `cache`: ¿`invalidatedBy` cubre **todas** las operaciones y eventos que mutan lo cacheado? Basta una vía de mutación no listada para servir datos rancios indefinidamente.

### 6. Fronteras del agregado y cascadas

- Al **borrar** una raíz de agregado: ¿qué pasa con las entidades internas? ¿Y con las referencias por id desde otros agregados — quedan colgantes, o el borrado se bloquea con un error declarado?
- ¿Hay borrado **lógico** (estado `archived`) o físico? Si es lógico, ¿las queries lo filtran?
- Las entidades hijas: ¿se gestionan **solo** a través de la raíz, o hay operaciones propias? Si hay operaciones propias sobre una entidad interna, cuestiona la frontera del agregado.
- Al **reemplazar** una colección de hijas en una actualización, ¿se sustituye entera o se hace merge por id?
- Invariantes que necesitan datos de **otro** agregado: no son verificables transaccionalmente; o el agregado está mal cortado o la invariante es eventual (y debe decirlo).

### 7. Contrato de eventos

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

Si el servicio declara la capa `dependencies`, este barrido se hace **por `need`**, no por cliente: la unidad de análisis es el dato que necesitamos, no el canal por el que llega.

Por cada cliente de `http-clients`, cada suscripción y cada `need`:

- Cuando la dependencia **cae o tarda**, ¿qué ve el llamante de nuestra API? ¿Un error declarado con `code` propio, o un fallo genérico? Un timeout sin traducción a error de negocio es un hueco de contrato.
- El `fallback` del circuit breaker: ¿produce un resultado **correcto** (valor por defecto aceptable para el negocio) o solo evita el error? Un fallback que devuelve datos falsos silenciosamente es peor que fallar. **Mismo criterio para `onMiss.action: degrade`**: si el cliente no puede distinguir la respuesta degradada de la normal, no es degradación, es un bug declarado.
- ¿La llamada externa ocurre **dentro** de una transacción de escritura? Si sí, un timeout deja la transacción abierta: hay que separar. Ojo con los `need` de `strategy: on-demand` usados por un `command`.
- Si la llamada externa es una **escritura** que no podemos deshacer y luego fallamos, ¿queda inconsistencia? ¿Hay compensación? Si la hay, ¿está declarada en `dependencies.<dep>.compensations` y respaldada por una suscripción real, o solo vive en la conversación?

Por cada `need` con `strategy: replicated`:

- ¿`fedBy` cubre **todas** las vías de cambio del dato en el proveedor, incluidas **bajas y retiradas**? Si falta la baja, la copia conserva para siempre algo que ya no existe y nadie se entera. Es el hueco más frecuente de esta clase.
- ¿El `onMiss` declarado produce un resultado de negocio **aceptable**, o solo evita el error?
- ¿La copia se lee en algún sitio **como si fuera fuente de verdad** (se expone tal cual en una respuesta, se le aplican invariantes, se escribe desde una operación de negocio)? Es el error de diseño más caro de esta capa.
- ¿Se copian campos que **ninguna** operación de `usedBy` lee? Cada campo copiado es acoplamiento a una decisión ajena.
- ¿Qué pasa si dos eventos del proveedor llegan **desordenados**? La respuesta correcta suele ser del generador (comparar el instante del hecho), pero si el diseño no da ningún instante en el payload, el generador no puede resolverlo: eso sí es un hueco del diseño.

### 9. Autorización a nivel de dato

El hueco más caro y el que ninguna regla mecánica puede ver.

- Un permiso autoriza la **operación**. ¿Autoriza sobre **ese** recurso concreto? Un rol con `order:read`, ¿lee cualquier pedido, o solo los suyos? El DSL declara lo primero; el negocio casi siempre quiere lo segundo.
- ¿De dónde sale la relación "es suyo": un campo de la entidad (`ownerId`, `customerId`) que se compara con la identidad del token? Si esa relación no está modelada, no se puede implementar.
- Las **queries de colección**: ¿devuelven todo, o solo lo del solicitante? Es el mismo hueco, y aquí se convierte en fuga de datos masiva.
- ¿Hay campos que un rol ve y otro no dentro de la **misma** respuesta?
- Operaciones de mutación con acceso `public`: ¿deliberado?

### 10. Archivos

Si hay capa `storage`:

- Ciclo de vida del archivo frente al de la entidad: al borrar la entidad, ¿se borra el archivo?
- Al **reemplazar** el archivo de un campo `file`, ¿el anterior se borra o queda huérfano?
- Bucket `private`: ¿qué operación produce el acceso de lectura (URL firmada, descarga mediada)? Si ninguna la produce, el archivo es inaccesible por contrato.
- Subida: ¿el archivo se sube en la misma operación que crea la entidad, o en dos pasos? Si son dos, ¿qué pasa si el segundo no llega?
- ¿`maxSizeMb` y `allowedContentTypes` tienen errores declarados (`FILE_TOO_LARGE`, `UNSUPPORTED_CONTENT_TYPE`) en las operaciones que suben?

### 11. Superficie servidor-a-servidor

Si `api` declara `audience: services`/`both`:

Esta clase y la 8 son **simétricas**: aquí se examina la superficie que **ofrecemos** a otros servidores; la clase 8 examina la que **consumimos** (capa `dependencies`). Recórrelas juntas — un mismo servicio suele estar a los dos lados, y los criterios de calidad se reflejan (un endpoint de lote que le falta a nuestro proveedor es el mismo hueco que un `need` nuestro que obligaría a N llamadas).

- ¿Cada endpoint de máquina tiene un `serviceClient` que lo consuma? Y al revés: ¿cada scope concedido lo exige alguien?
- ¿El contrato está pensado **para servidores**, o es el de usuarios reutilizado? Señales de hueco: el consumidor tendría que llamar N veces (falta un endpoint de lote), o recibe un DTO de pantalla en vez de datos.
- ¿Qué garantías de **estabilidad** tiene ese contrato? Es el que otro equipo va a acoplarse.
- Con `audience: both`: ¿la respuesta es la misma para token de usuario y de máquina? Si difiere, es contrato distinto y debería ser endpoint distinto.

### 12. Zonas grises de la equivalencia

Lo que dos stacks resolverían distinto y el diseño rara vez fija. La mayoría se cierra **en el escenario de validación**, no en el YAML (ver `docs/validation-scenarios.md § Determinación observable`); aquí solo hay que **sacarlas a la luz** antes del paso 5, y llevar al YAML las que sean decisiones de negocio:

- **Fechas y horas**: ¿instantes en UTC o fechas locales? ¿Qué zona usa el negocio para "hoy"?
- **Números y dinero**: escala decimal y regla de redondeo. Dos motores redondean distinto el mismo total.
- **Texto**: ¿la unicidad y la búsqueda distinguen mayúsculas y acentos? `ACME` y `acme`, ¿son el mismo nombre?
- **Ausencia**: en las respuestas, ¿un campo sin valor **no aparece** o aparece como nulo? Debe ser la misma convención en todo el servicio.
- **Longitudes y cotas**: campos de texto sin cota superior, listas sin `maxItems`.
- **Idioma y formato de los mensajes de error**: el `code` es contrato; el texto, ¿también?

Al terminar esta clase, deberías poder responder, para el servicio entero: *si dos equipos implementaran este diseño con stacks distintos, ¿en qué podría diferir lo observable?* Todo lo que quede en esa lista debe quedar fijado en los escenarios.
