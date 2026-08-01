# Referencia del DSL Keel (v2.3)

Un servicio Keel se diseña como un conjunto de **artefactos por capa** en `specs/<servicio>/`, todos YAML, todos agnósticos de tecnología. Cada capa se valida contra su propio schema (`schema/<capa>.schema.json`) y se itera con el humano por separado; las capas se relacionan **por nombre** (una operación referencia entidades, un endpoint referencia una operación, un `emits` referencia un evento) y `keel validate` comprueba esas referencias cruzadas.

## Las capas

| Capa | Archivo | ¿Obligatoria? | Contenido | Referencia |
|------|---------|---------------|-----------|------------|
| service | `service.keel.yaml` | ✅ | Manifiesto: identidad + capas declaradas | [dsl/service.md](dsl/service.md) |
| domain | `domain.keel.yaml` | ✅ | Value types (escalares, enums, VO compuestos), entidades, agregados, relaciones, ciclo de vida, invariantes | [dsl/domain.md](dsl/domain.md) |
| use-cases | `use-cases.keel.yaml` | ✅ | Operaciones: reglas, errores, idempotencia, caché, schedule | [dsl/use-cases.md](dsl/use-cases.md) |
| api | `api.keel.yaml` | opcional | Exposición REST, audiencia de cada endpoint (users/services/both), paginación | [dsl/api.md](dsl/api.md) |
| security | `security.keel.yaml` | opcional | Autenticación (usuarios y clientes máquina), roles, permisos, scopes, acceso por operación, CORS | [dsl/security.md](dsl/security.md) |
| messaging | `messaging.keel.yaml` | opcional | Canales lógicos, eventos publicados (outbox), suscripciones (retry/DLQ) | [dsl/messaging.md](dsl/messaging.md) |
| http-clients | `http-clients.keel.yaml` | opcional | Llamadas salientes: contrato (prosa + method/path/request/response tipados opcionales), auth del cliente, timeout, retry, circuit breaker, fallback | [dsl/http-clients.md](dsl/http-clients.md) |
| dependencies | `dependencies.keel.yaml` | opcional | De qué otros servidores depende: qué dato necesita de cada uno (`needs`) y quién lo usa, si lo lee bajo demanda o replicado (`strategy`), la copia local (`replica`), qué hace cuando falta (`onMiss`) y las compensaciones | [dsl/dependencies.md](dsl/dependencies.md) |
| persistence | `persistence.keel.yaml` | opcional | Modelo de almacenamiento, claves naturales, índices, consistencia | [dsl/persistence.md](dsl/persistence.md) |
| storage | `storage.keel.yaml` | opcional | Almacenamiento de archivos (object storage): buckets lógicos, content-types, tamaño, visibilidad | [dsl/storage.md](dsl/storage.md) |

Una capa opcional existe si y solo si está declarada en `layers` del manifiesto. Todos los ejemplos de las referencias usan el mismo dominio: **productos y catálogos**.

## Idioma de los identificadores (regla transversal, mandatoria)

Todo **identificador** del DSL va en **inglés**: nombres de types, entidades, agregados, campos, operaciones, eventos, errores (`code`), roles, canales y buckets (`Product`, `retireProduct`, `PRODUCT_NOT_FOUND`, `productImages` — nunca `Producto`, `retirarProducto`). La **prosa** (`description`, invariantes, reglas, escenarios de validación) permanece en español. La regla aplica a todas las capas y fluye aguas abajo: los generadores derivan de estos nombres los paquetes, directorios, archivos, clases y tablas del código, que por tanto también salen en inglés.

## Evolución del DSL (regla inviolable)

El DSL es el activo durable de Keel: un mismo diseño se reutiliza a través de **stacks** (Postgres→MySQL, Kafka→Rabbit) y a través de **frameworks** (Spring→Nest). Esa reutilización solo sobrevive si nunca se invierte la dirección de dependencia entre el DSL y los generadores. Por eso esta regla es **inviolable**.

**1. Dirección de dependencia.** El generador conoce y se adapta al DSL; el DSL **no conoce ni un solo generador**. Ante cualquier necesidad de un generador, la respuesta por defecto es **siempre** ajustar el generador (su `stack-catalog`/config/skills/`mapping.md`), **nunca** el DSL. *Se ajusta el generador, nunca el DSL.* Modificar el DSL para acomodar a un generador invierte la flecha y el diseño deja de ser reutilizable.

**2. Test de admisión al DSL.** Un cambio solo puede entrar al DSL si pasa esta pregunta:

> *¿Esto es verdad sobre el servicio aunque nadie lo construya jamás?*

- **Sí** — es una propiedad del *dominio del problema* → puede ir al DSL.
- **No** — es una decisión de la *solución técnica* → va al generador.

**3. El alcance es síntoma, no justificación.** Que un cambio "sirva a todos los generadores" **no** lo autoriza: un concepto de solución (p. ej. `retryPolicy`/`backoffMs`) puede ser multi-framework y aun así estar acoplado a un modelo de implementación. Lo global es *consecuencia* de un buen cambio, no su causa.

**4. Cuando el DSL sí cambia** (pasó el test): se versiona **una sola vez en el centro** (`keel-core`: `SUPPORTED_DSL` + schemas), y **todos** los generadores se actualizan para consumir la nueva versión a su ritmo, protegidos por su comprobación de compatibilidad de `build`. El DSL nunca se ramifica por framework.

### Historial de versiones

| Versión | Cambio | Por qué pasó el test de admisión |
|---------|--------|----------------------------------|
| 2.4 | `sort: [campo:asc\|desc]` en un `output` con `list`/`paginated`: el orden por defecto de la salida. El id del agregado se añade siempre como desempate, se declare o no | "Los productos se listan del más reciente al más antiguo" es una decisión sobre el **contrato** del servicio: es lo que recibe quien no pide un orden concreto, y quien lo consume construye su UI sobre ello. Pero lo que forzó el primitivo fue un defecto, no una carencia expresiva: sin nada que declarara el orden, los generadores paginaban sin `ORDER BY` determinista, y una consulta paginada cuyo orden empata puede devolver la misma fila en dos páginas y omitir otra — un fallo de corrección que ninguna validación veía y que los escenarios, que miran una página, no cazan. La regla del desempate por id es lo que lo cierra en todos los diseños ya escritos sin tocarlos. El dot-path (`brand.name`) exige que la relación esté en `embed`: ordenar por lo que no se devuelve rompe el contrato, y de paso hace **derivable** que ese listado no se puede resolver componiendo por lote. Lo que **no** entró: una whitelist de campos ordenables (es validación de la entrada, no un hecho del servicio), ordenación encadenada más allá de profundidad 1 (mismo corte que `embed`) y los filtros declarativos, que son un lenguaje de consulta y no una propiedad del diseño. Aditivo: todo spec 2.0/2.1/2.2/2.3 sigue siendo válido |
| 2.3 | `embed: [relación]` en un `output` con forma `{ entity: X }`: la referencia a otro agregado se proyecta como objeto anidado en vez de como `<relación>Id` | "El consumidor de la ficha de producto necesita la categoría, no un id que le obliga a una segunda llamada" es una decisión sobre el **contrato** del servicio, no sobre su implementación: dice qué recibe quien lo usa. Sin el primitivo, el diseño no tenía forma de expresarlo — el escenario de validación pedía `category` y el mapeo canónico obligaba a `categoryId`, así que el generador y el diseño se contradecían sin que ninguna validación lo detectara, y cada agente resolvía el choque a su manera. Lo que **no** entró: elegir los campos del objeto embebido por operación (sería una proyección arbitraria, no un hecho del dominio) ni encadenar embeds (la profundidad se corta en 1: más allá, lo que se está describiendo es una consulta, no un recurso). Aditivo: todo spec 2.0/2.1/2.2 sigue siendo válido |
| 2.2 | Capa nueva `dependencies`: los servidores de los que este depende, el dato que necesita de cada uno (`needs`) y qué operación lo usa (`usedBy`), si lo lee bajo demanda o replicado (`strategy` + `replica`), qué hace cuando le falta (`onMiss`) y qué compensa | "Este servicio no puede construir un pedido sin conocer el precio del producto, que es de catalog", "acepta un precio de hasta cinco minutos de antigüedad" y "si no lo tiene, falla con `PRICE_UNAVAILABLE`" son verdad sobre el servicio aunque nadie lo construya: son su frontera de consistencia y de disponibilidad. Sin la capa, esos hechos quedaban repartidos entre un cliente HTTP, una suscripción y una entidad, sin nada que dijera que los tres son la misma decisión — y cada generador reconstruía la relación a su manera; una réplica local era indistinguible de una entidad propia. Lo que **no** entró: `staleness`/`maxStalenessSeconds` (redundante con `strategy`, o un SLA de solución de la familia de `backoffMs` — el problema real, que un evento viejo no pise a uno nuevo, lo resuelve el generador), `criticality` (derivable de los needs) y los nombres `http`/`local-read-model` del borrador (el primero nombra un transporte, el segundo un patrón de implementación). Aditivo: todo spec 2.0/2.1 sigue siendo válido |
| 2.1 | `list: true` en campos, con `constraints.minItems` / `maxItems`. En payloads y contratos (entradas por lotes, salidas múltiples) y en campos de entidad para colecciones de valores sin identidad (`tags`, `discounts`). Vetado dentro de un value object y en `pathParams` | "Esta operación recibe entre 1 y N identificadores" y "un pedido lleva varios descuentos sin identidad propia" son verdad sobre el servicio aunque nadie lo construya. Sin el primitivo, una entrada por lotes degradaba a `type: json` con la cota en prosa, y una colección de value objects obligaba a inventar una entidad hija con id ficticio. Aditivo: todo spec 2.0 sigue siendo válido |
| 2.0 | Línea base multi-artefacto (un archivo por capa) | — |

La versión vigente es la última de la tabla, y es la que siembra `keel new` en el manifiesto. **`keel validate` acepta esa y solo esa**: el enum de `service.schema.json` tiene un único valor, y `supportedDsl()` lo deriva de ahí.

Aceptar también las anteriores sería mentir. Los schemas son un juego único y **no gatean los primitivos por versión**: nada impide que un manifiesto `keel: "2.0"` use `embed` o `sort`, que son de 2.3 y 2.4. Mientras el proyecto está en desarrollo, tener una sola versión soportada es lo único que hace que el campo `keel` declare una capacidad y no una intención — un spec que valida es un spec que esta CLI entiende entero. Migrar un diseño anterior es subir el número y validar: si algo del spec ya no encaja, `keel validate` lo dice.

Cuando el DSL se publique y haya diseños de terceros que sostener, aceptar varias versiones volverá a tener sentido — pero entonces será una decisión consciente que exigirá gatear los primitivos por versión, no la deuda de haber dejado el enum crecer.

Los `$id` de los schemas siguen apuntando a `keel.dev/schema/2.0/`: son **URIs de identidad** con los que los schemas se referencian entre sí, no la versión del DSL, y por eso no se tocan al versionar.

### Modificación del DSL equivocada

Es incorrecto —y viola la regla— modificar el DSL cuando:

- **Lo pide un framework o stack concreto.** "Spring/Nest/Kafka necesita X" nunca es razón para tocar el DSL; es razón para tocar ese generador.
- **Se cuela un concepto de solución disfrazado de neutral** (`retryPolicy`, `backoffMs`, tamaño de pool, modelo de hilos, `connectionTimeout`…). Pertenece al catálogo/config del generador, aunque todos los generadores pudieran leerlo.
- **Se nombra una tecnología** en un campo del DSL (`kafkaTopic`, `jpaEntity`, `redisTtl`). El DSL declara *capacidades* del dominio (`emits`, `cache`), no tecnologías.
- **Se ramifica el DSL por generador** (una variante para Spring, otra para Nest). El DSL es único; las diferencias viven en los generadores.
- **Se "arregla" en el DSL lo que es un hueco de mapeo del generador.** Si un generador no sabe traducir una construcción existente, se corrige su `mapping.md`, no el DSL.

Regla mnemónica: **el DSL describe *qué es* el servicio; el generador decide *cómo se construye*. Si el cambio habla de cómo, no toca el DSL.**

## Dependencias entre capas

```
domain ──> use-cases ──> api ──────────┐
              │            └──> security
              ├──> messaging (emits / subscriptions.triggers)
              ├──> http-clients (llamadas que hacen las operaciones)
              ├──> dependencies ──> (domain, use-cases, messaging, http-clients, persistence)
              ├──> persistence (entidades de domain que se guardan)
              └──> storage (buckets que referencian los campos file de domain)
```

`dependencies` es una **capa de síntesis**: no crea llamadas ni suscripciones, declara por qué existen las que ya hay. Todas sus referencias van hacia atrás, así que se valida la última.

Orden de diseño recomendado (el que sigue `/keel-design`): **domain → use-cases → dependencies → api → security → messaging → http-clients → persistence → storage**.

El orden de **validación** y el momento de **diseño** de `dependencies` no coinciden, y es deliberado: la capa se valida al final porque solo referencia hacia atrás, pero se diseña en cuanto se cierran los casos de uso, que es cuando se sabe qué dato ajeno hace falta y quién lo necesita. La skill `/keel-consume` la escribe junto con `http-clients`, `messaging` y las adiciones a `domain`/`use-cases`/`persistence` **en una sola pasada coherente**, respetando internamente el orden de capas.

## Dónde vive cada decisión transversal

| Decisión | Capa | Por qué |
|----------|------|---------|
| Idempotencia de una operación | use-cases | Es semántica del caso de uso, lo invoque REST o un evento |
| Caché de una query | use-cases | Qué se cachea y qué lo invalida es conocimiento de dominio |
| Roles y permisos por endpoint | security | Por nombre de operación, estable aunque cambien rutas |
| Quién consume un endpoint (usuarios vs otros servicios) | api (`audience`) + security (`serviceAuth`, `serviceClients`, `level: service`) | La audiencia es contrato de la API; las credenciales y scopes de máquina son seguridad |
| Consumo desde el navegador (CORS) | security (`cors`) | Es política de acceso al canal entrante; los orígenes concretos son despliegue y se configuran al generar, no se diseñan |
| Retry / circuit breaker salientes | http-clients | Política del canal, compartida por los casos de uso |
| Autenticación saliente (api-key, OAuth2 M2M…) | http-clients | Mecanismo por cliente; las credenciales llegan por configuración, nunca en el diseño |
| Retry / DLQ de consumo de eventos | messaging | Política de la suscripción |
| De qué otro servidor depende el servicio, y con qué versión de su contrato | dependencies | Es un hecho de arquitectura del servicio; `http-clients` y `messaging` declaran los canales, no el porqué |
| Si un dato ajeno se pide al decidir o se mantiene replicado | dependencies (`strategy`) | Es la decisión de negocio disponibilidad-vs-frescura, observable en lo que la API puede prometer |
| Qué hace el servicio cuando le falta un dato ajeno | dependencies (`onMiss`) | Comportamiento observable; obliga a declarar el error o el resultado degradado |
| Outbox | messaging | Es la garantía de publicación de eventos |
| Paginación | api | Concern de la API |
| Frontera transaccional | persistence | El generador la respeta al implementar outbox y commands |
| Fronteras de consistencia (agregados) | domain | Qué entidades cambian juntas es conocimiento del dominio; persistence solo la respeta (`per-aggregate`) |
| Dónde y cómo se guardan los archivos | storage | Buckets lógicos + políticas; el domain solo declara qué campo es un `file` y a qué bucket va |

La tabla dice **dónde** se declara cada decisión. **Quién la toma** es otra pregunta, y para buena parte de estas filas la respuesta es la misma: las decisiones que fijan el comportamiento estructural del servidor —outbox, idempotencia, caché, superficie M2M, política de fallo, resiliencia, frontera transaccional, paginación, concurrencia, visibilidad de buckets— las **recomienda** el agente y las **decide** el diseñador, porque cambian lo que el servicio puede prometer a sus clientes. El catálogo con sus ejes de decisión y consecuencias observables está en `references/structural-decisions.md` de la skill `keel-design`.

## Validaciones fuera de los schemas

Los JSON Schemas validan estructura y formato de cada artefacto. `keel validate specs/<servicio>` añade las referencias cruzadas mecánicas (tipos, entidades, operaciones, eventos, roles y permisos referenciados existen; agregados bien formados y sin solapes; operaciones huérfanas). La skill `/keel-validate` añade la revisión semántica que ninguna de las dos capas puede expresar: invariantes ambiguas, errores faltantes, mínimo privilegio, fallbacks sin definir.
