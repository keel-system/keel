# Referencia del DSL Keel (v2.0)

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
