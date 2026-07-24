# Referencia del DSL Keel (v2.1)

Un servicio Keel se diseña como un conjunto de **artefactos por capa** en `specs/<servicio>/`, todos YAML, todos agnósticos de tecnología. Cada capa se valida contra su propio schema (`schema/<capa>.schema.json`) y se itera con el humano por separado; las capas se relacionan **por nombre** (una operación referencia entidades, un endpoint referencia una operación, un `emits` referencia un evento) y `keel validate` comprueba esas referencias cruzadas.

## Las capas

| Capa | Archivo | ¿Obligatoria? | Contenido | Referencia |
|------|---------|---------------|-----------|------------|
| service | `service.keel.yaml` | ✅ | Manifiesto: identidad + capas declaradas | [dsl/service.md](dsl/service.md) |
| domain | `domain.keel.yaml` | ✅ | Value types (escalares, enums, VO compuestos), entidades, agregados, relaciones, ciclo de vida, invariantes | [dsl/domain.md](dsl/domain.md) |
| use-cases | `use-cases.keel.yaml` | ✅ | Operaciones: reglas, errores, idempotencia, caché, schedule | [dsl/use-cases.md](dsl/use-cases.md) |
| api | `api.keel.yaml` | opcional | Exposición REST, audiencia de cada endpoint (users/services/both), paginación | [dsl/api.md](dsl/api.md) |
| security | `security.keel.yaml` | opcional | Autenticación (usuarios y clientes máquina), roles, permisos, scopes, acceso por operación | [dsl/security.md](dsl/security.md) |
| messaging | `messaging.keel.yaml` | opcional | Canales lógicos, eventos publicados (outbox), suscripciones (retry/DLQ) | [dsl/messaging.md](dsl/messaging.md) |
| http-clients | `http-clients.keel.yaml` | opcional | Llamadas salientes: contrato (prosa + method/path/request/response tipados opcionales), auth del cliente, timeout, retry, circuit breaker, fallback | [dsl/http-clients.md](dsl/http-clients.md) |
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
| 2.1 | `list: true` en campos, con `constraints.minItems` / `maxItems`. En payloads y contratos (entradas por lotes, salidas múltiples) y en campos de entidad para colecciones de valores sin identidad (`tags`, `discounts`). Vetado dentro de un value object y en `pathParams` | "Esta operación recibe entre 1 y N identificadores" y "un pedido lleva varios descuentos sin identidad propia" son verdad sobre el servicio aunque nadie lo construya. Sin el primitivo, una entrada por lotes degradaba a `type: json` con la cota en prosa, y una colección de value objects obligaba a inventar una entidad hija con id ficticio. Aditivo: todo spec 2.0 sigue siendo válido |
| 2.0 | Línea base multi-artefacto (un archivo por capa) | — |

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
              ├──> persistence (entidades de domain que se guardan)
              └──> storage (buckets que referencian los campos file de domain)
```

Orden de diseño recomendado (el que sigue `/keel-design`): **domain → use-cases → api → security → messaging → http-clients → persistence → storage**.

## Dónde vive cada decisión transversal

| Decisión | Capa | Por qué |
|----------|------|---------|
| Idempotencia de una operación | use-cases | Es semántica del caso de uso, lo invoque REST o un evento |
| Caché de una query | use-cases | Qué se cachea y qué lo invalida es conocimiento de dominio |
| Roles y permisos por endpoint | security | Por nombre de operación, estable aunque cambien rutas |
| Quién consume un endpoint (usuarios vs otros servicios) | api (`audience`) + security (`serviceAuth`, `serviceClients`, `level: service`) | La audiencia es contrato de la API; las credenciales y scopes de máquina son seguridad |
| Retry / circuit breaker salientes | http-clients | Política del canal, compartida por los casos de uso |
| Autenticación saliente (api-key, OAuth2 M2M…) | http-clients | Mecanismo por cliente; las credenciales llegan por configuración, nunca en el diseño |
| Retry / DLQ de consumo de eventos | messaging | Política de la suscripción |
| Outbox | messaging | Es la garantía de publicación de eventos |
| Paginación | api | Concern de la API |
| Frontera transaccional | persistence | El generador la respeta al implementar outbox y commands |
| Fronteras de consistencia (agregados) | domain | Qué entidades cambian juntas es conocimiento del dominio; persistence solo la respeta (`per-aggregate`) |
| Dónde y cómo se guardan los archivos | storage | Buckets lógicos + políticas; el domain solo declara qué campo es un `file` y a qué bucket va |

## Validaciones fuera de los schemas

Los JSON Schemas validan estructura y formato de cada artefacto. `keel validate specs/<servicio>` añade las referencias cruzadas mecánicas (tipos, entidades, operaciones, eventos, roles y permisos referenciados existen; agregados bien formados y sin solapes; operaciones huérfanas). La skill `/keel-validate` añade la revisión semántica que ninguna de las dos capas puede expresar: invariantes ambiguas, errores faltantes, mínimo privilegio, fallbacks sin definir.
