# Heurísticas de frontera

Cómo decidir si dos capacidades del TDR viven en el mismo servicio o en dos. Se lee antes del paso 3
de `/keel-decompose`.

No hay algoritmo. Hay seis ejes que cortan, un orden de prioridad entre ellos y una lista de cortes
que parecen buenos y no lo son.

## Los seis ejes, por orden de fuerza

Se aplican en este orden: el primero que dé un veredicto claro gana. Los de abajo solo desempatan.

### 1. Invariante transaccional — el que manda

**¿Hay una regla de negocio que exige que dos cosas cambien juntas o ninguna?** Si la respuesta es sí,
están en el mismo servicio. No hay conversación posible: partirlas convierte una invariante en una
esperanza, y el precio es una compensación que alguien tendrá que diseñar, operar y explicar cuando
falle.

Pregunta de control: *"si esto confirma y aquello no, ¿qué ve el cliente y qué hacemos?"*. Si el humano
no tiene respuesta, no es que falte la compensación: es que la frontera está mal puesta.

### 2. Dueño del dato

**¿Quién decide cuándo este dato es válido?** El dueño es quien aplica las reglas que lo gobiernan, no
quien lo lee más. El servicio que más consulta un dato es, casi siempre, el que **no** debe poseerlo.

Un dato tiene un dueño y solo uno. Los demás lo leen (`on-demand`) o mantienen una copia declarada
(`replicated`), y una copia nunca es fuente de verdad ni se expone como recurso propio.

### 3. Cadencia de cambio

**¿Cambian por razones distintas y en momentos distintos?** Dos capacidades que se modifican por
motivos independientes acabarán estorbándose en el mismo servicio: cada release de una obliga a
revalidar la otra. Si el TDR dice que las tarifas cambian a diario y el catálogo de rutas cada
temporada, ahí hay una frontera aunque los datos se parezcan.

### 4. Perfil de carga

**¿Escalan de forma distinta?** Una consulta de disponibilidad que soporta el tráfico de todo el
buscador y una operación de emisión que ocurre una vez por venta no tienen el mismo perfil. Este eje
justifica un servicio propio **solo cuando la diferencia es de órdenes de magnitud** — si es del doble,
no corta nada.

### 5. Frontera de regulación o de secreto

**¿Hay datos con régimen legal propio?** Tarjetas (PCI), datos médicos, identidad. Aquí la frontera es
casi siempre obligatoria y no se negocia con argumentos de diseño: reducir el número de sistemas que
tocan el dato regulado es el objetivo. Corta.

### 6. Equipo y ciclo de despliegue

**¿Dos equipos distintos van a mantenerlo?** Es el eje más débil y el más real. Justifica una frontera
cuando la alternativa es que dos equipos se pisen en cada release; no la justifica cuando es solo el
organigrama de hoy — los organigramas cambian más rápido que los sistemas.

## La prueba del despliegue solo

Antes de aceptar una partición, para cada servicio candidato:

1. ¿Se puede **desplegar** sin coordinar con otro? Si no, no es un servicio: es un módulo con red en
   medio, y has pagado la latencia sin cobrar la independencia.
2. ¿Se puede **caer** sin llevarse el resto por delante? Si su caída detiene todo, plantéate si la
   arista no debería ser un evento en vez de una llamada.
3. ¿Se puede **entender** sin leer otro? Si su responsabilidad solo tiene sentido explicando el vecino,
   son uno.

Un candidato que falla las tres es un módulo. Uno que falla la primera es un módulo distribuido, que es
lo peor de los dos mundos.

## Antipatrones

| Antipatrón | Cómo se reconoce | Por qué duele | Qué hacer |
|---|---|---|---|
| **Servicio-por-tabla** | Un servicio por entidad, con CRUD y nada más. Su `responsibility` es "gestionar los X" | Ninguna regla de negocio vive en ninguna parte: cada caso de uso real necesita tres servicios y una transacción distribuida | Agrupa por invariante (eje 1), no por sustantivo |
| **El servicio "común"** | `shared`, `core`, `common`, `master-data`. Lo consumen todos | Nadie puede desplegar sin él y todos le piden campos: crece sin dueño y acaba siendo el monolito por el que pasa todo | Lo compartido que es **código** es una librería; lo que es **dato** tiene un dueño de negocio: encuéntralo |
| **El orquestador vacío** | Un servicio que llama a los otros en orden y no posee nada | Todas las reglas están en él y todos los datos fuera: la peor relación posible entre cohesión y latencia | O tiene estado y decisiones propias (el flujo **es** su dominio, con su ciclo de vida), o desaparece y el flujo se reparte |
| **La activación encubierta** | Una arista `consumes` cuyo `what` es una acción: «inicio del cobro», «retención del asiento», «envío del correo» | El acoplamiento va al revés de como está dibujado: quien «lee» es en realidad quien tiene que conocer la firma de entrada del otro, y el orden de construcción sale invertido | Es un `invokes`, dibujado por quien pide. Ver §4 de la skill |
| **Frontera por capa técnica** | `api-gateway-service`, `validation-service`, `read-service` | Corta por cómo está construido, no por lo que promete: cada cambio de negocio toca todos | Corta por dominio; las capas viven **dentro** de un servicio (eso es la arquitectura hexagonal del proyecto generado) |
| **Servicio-informe** | Existe para "consultar" datos de otros | Es una réplica sin dueño que se queda rancia y a la que nadie sabe pedirle cuentas | Si es una vista, es una query del dueño. Si es analítica de verdad, está fuera del alcance de este método |
| **Frontera por actor** | `web-service`, `mobile-service`, `admin-service` | El mismo dominio duplicado tantas veces como canales; las reglas divergen entre copias | Un dominio, varias audiencias: eso es `api.audience` dentro de un servicio |

## Casos difíciles

**Un concepto que dos servicios reclaman.** Casi siempre son dos conceptos con el mismo nombre. El
`Passenger` de reservas (quién viaja en este PNR) no es el `Passenger` de fidelización (un cliente con
histórico). Renómbralos, dale a cada uno su dueño, y si uno necesita datos del otro, es una arista.

**Un flujo largo que atraviesa todo** (reservar → cotizar → cobrar → emitir). La tentación es un
servicio por paso. Pregunta de quién es el **estado del flujo**: si el propio flujo tiene ciclo de
vida, identidad y reglas (un PNR lo tiene), entonces el flujo **es** un dominio y su servicio es
legítimo — no es un orquestador vacío, porque posee algo. Los pasos que sí son dominios propios
(cobrar, emitir) se quedan fuera.

Un servicio así **encarga trabajo a los demás**, y eso no lo convierte en un orquestador vacío: la
diferencia no es cuántas aristas `invokes` tiene, sino si posee estado y decisiones. Un PNR que pide
retener y cobrar sigue siendo el dueño de si la reserva existe. Declarar esos encargos como
`invokes` es lo que hace visible el coste que se está aceptando: cada uno acopla el flujo a la firma
de entrada de otro servicio, y esa cuenta conviene verla antes de firmarla, no después.

**Un sistema que ya existe** (un legado, un ERP, una pasarela). No se descompone ni se rediseña: entra
al mapa con `external: true`, su contrato vive en `contracts/<servicio>/INTEGRATION.md` y nunca bloquea
el orden de construcción, porque su contrato ya está escrito.

**Algo que suena a servicio y es infraestructura.** Autenticación, notificaciones de sistema,
observabilidad, gateway, despliegue. Autenticación se decide al generar (capa `security`). Las
notificaciones **de negocio** sí son un servicio (tienen dominio: plantillas, envíos, reintentos) y
suelen estar ya resueltas en el registry. Todo lo demás va a "Fuera de alcance".

## El grano correcto

Dos preguntas de calibración al terminar:

- **¿Algún servicio tiene un solo caso de uso?** Sospechoso. O le falta dominio, o es parte de otro.
- **¿Algún servicio necesita más de cinco o seis conceptos para explicarse?** Sospechoso también: mira
  si dentro hay dos invariantes independientes.

Ninguna de las dos es una regla. Son señales para volver al eje 1.
