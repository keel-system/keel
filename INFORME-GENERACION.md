# Informe de generación — catalog-spring (desde specs/catalog v0.4.0)

Lo que apareció durante esta generación y no es de este proyecto, sino del generador
(`keel-spring`) o del diseño (`specs/catalog`). Cada entrada dice de quién es.

## 1. Incidencias del generador o del arnés

Ninguna. No hubo `harnessPatches`, ningún fallo con `culprit: harness`, y las sondas de
infraestructura (`keel-spring-infra`) no reportaron ningún `FALSO-NEGATIVO`.

Nota operativa (no es una incidencia del generador ni del proyecto, es del entorno local):
en este Windows sin Docker Desktop, `podman compose` delega por defecto en
`docker-compose.exe`, que depende de un named pipe de compatibilidad Docker no disponible
en esta máquina. El agente de infraestructura lo resolvió forzando
`PODMAN_COMPOSE_PROVIDER` al `podman-compose.exe` de Python. No requiere cambio en ningún
script del proyecto; se deja documentado por si otra sesión en un entorno equivalente
tropieza con el mismo bloqueo.

## 2. Código determinístico mejorable (patrón del scaffold, no de este proyecto)

| Área | Patrón (no ruta de este proyecto) | Cambio sugerido en `keel-spring build` |
|---|---|---|
| Manejo de conflicto optimista | `ApiExceptionHandler.onOptimisticLockingFailure` mapea `ObjectOptimisticLockingFailureException` siempre al código genérico `OPTIMISTIC_LOCK_CONFLICT`, ignorando que `use-cases.keel.yaml` puede declarar un código de negocio específico (`CONCURRENT_MODIFICATION`) por operación. Se reprodujo en 3 operaciones distintas (`updateBrand`, `updateCategory`, `updateProduct`) con el mismo síntoma exacto. | El scaffold del handler debería resolver el código por contexto de la operación (o exponer un punto de extensión explícito), no fijar un único genérico, cuando el diseño declara un código de conflicto propio para más de una operación. |
| Publishers SNS `best-effort` | Los `Sns<Evento>Publisher` generados como stub usan `snsTemplate.sendNotification(destination, envelope, "<Evento>")`: el tercer argumento fija el **Subject** de SNS, no un message attribute. Cualquier suscripción con `FilterPolicy` por `eventType` (patrón estándar cuando `messaging.keel.yaml` declara varias suscripciones al mismo topic) descarta el mensaje silenciosamente. Afectó 3 publishers y 9 escenarios en esta generación. | El stub `best-effort` debería fijar el message attribute `eventType` (vía `SnsNotification.builder(...).header("eventType", ...)`) por defecto, ya que `infra/init-messaging.sh` siempre aprovisiona el `FilterPolicy` sobre ese atributo. |
| Colecciones ordenadas con índice único natural | Cuando una entidad hija tiene una natural key compuesta que incluye una posición (`(productId, position)` en `ProductImage`), la recompactación/reordenación en memoria y el `saveAndFlush` posterior chocan transitoriamente contra el índice único de Postgres incluso sin concurrencia, si el orden de escritura no evita el estado intermedio colisionante. | El scaffold de persistencia para agregados con colecciones hijas ordenadas por posición podría generar por defecto la reconciliación con offset temporal (o documentarla como patrón obligatorio en `mapping.md`), en vez de dejarlo a discreción del agente de código. |

## 3. Agentes y skills

- **`keel-spring-keycloak` § referencia de clientes de prueba**: `references/test-clients.md`
  se contradice a sí mismo sobre el status esperado ante audiencia inválida (dice 403 en la
  introducción, pero rotula una fila como "aísla el 401 por audiencia" y otra fila dice
  "gana al de scope (401, no 403)"). El agente de tests tuvo que resolver la ambigüedad
  contra `specs/validation-scenarios.md` (fuente de mayor precedencia) sin apoyo claro de la
  skill. Corregir la referencia a un único status consistente evitaría relitigar esto en cada
  servicio con este stack.
- **Ciclo de arbitraje de la recompactación de posiciones**: 5 de los 18 fallos de la primera
  pasada compartían la misma causa raíz (colisión transitoria del índice único), pero se
  reportaron como fallos independientes porque el patrón no estaba documentado en
  `.claude/conventions/mapping.md`. Una nota explícita ahí sobre "colecciones hijas con
  posición como parte de la natural key" habría acortado el diagnóstico de un ciclo completo.
- **`.claude/skills/keel-spring-snssqs/SKILL.md`**: no advertía que `sendNotification(...)`
  fija el Subject y no un message attribute — el agente de código lo descubrió por prueba y
  error contra los 9 escenarios afectados. Una mención explícita del método correcto para
  fijar `eventType` como message attribute habría evitado el primer ciclo de fallos.

## 4. Huecos del diseño (`specs/catalog`, propuestas para el diseñador)

Consolidado de los `designGaps` reportados por `keel-spring-code`, `keel-spring-tests` y
`keel-spring-validate` a lo largo de la generación:

1. **Invalidación de caché incompleta ante cambios de `brand`/`category` (resuelto aquí de
   forma pragmática, requiere decisión del diseñador).** `use-cases.keel.yaml` declara
   `cache.invalidatedBy: [ProductUpdated, ProductRetired]` para `getPublishedProduct` (línea
   ~412) y `getProductForServices` (línea ~443), ambas con `embed: [brand, category]`. Pero
   `validation-scenarios.md` (FL-PUB-020, escenarios encadenados 6 y 7) exige que un cambio de
   estado en `brand`/`category` se refleje de inmediato en el embed, sin esperar el TTL de
   300s — contradicción entre dos artefactos derivados del mismo diseño. Por decisión del
   usuario de este repo derivado, se resolvió aquí evictando la región de caché cuando
   `Brand`/`Category` cambian de `ActivationStatus` (no ante cualquier `save`, para no romper
   FL-PUB-010-C, que exige retención stale ante un simple rename). **Propuesta para el
   diseño**: añadir los eventos de cambio de estado de `Brand`/`Category` a `invalidatedBy` de
   ambas queries (o declarar explícitamente que el embed no se actualiza por este camino, lo
   que contradiría FL-PUB-020 tal como está escrito hoy).
2. **Ambigüedad del campo `status` en `Brand`/`Category`.** `FL-BRD-001`/`FL-CTG-001`
   enumeran literalmente los campos de la respuesta de creación sin incluir `status`, pero
   `domain.keel.yaml` lo declara (default `active`) y otros escenarios del mismo documento
   (`FL-BRD-020`/`FL-CTG-020`) asumen que siempre viaja. Se implementó incluyéndolo, por ser
   consistente con el resto del propio documento y con el DSL. Propuesta: corregir la
   enumeración de campos de `FL-BRD-001`/`FL-CTG-001` para incluir `status` explícitamente.
3. **Status HTTP de fallo de audiencia inconsistente entre artefactos.** `FL-M2M-020` fija
   literalmente 403 para audiencia ajena; la referencia de la skill `keel-spring-keycloak`
   (no un artefacto del diseño, pero sí un derivado que documenta el contrato) se contradice
   internamente entre 401 y 403. Se siguió el `Then` literal (403) por mayor precedencia. Si
   el diseño pretendía 401, es un cambio a `use-cases.keel.yaml`/`security.keel.yaml`, no al
   test.
4. **Normalización de `tags` en el filtro `q` de `listPublishedProducts`.** El campo `name`
   se compara ignorando mayúsculas y acentos (columna `name_normalized`); `tags` solo pliega
   mayúsculas porque se persiste como `@ElementCollection` sin columna normalizada
   equivalente. Simplificación aceptada por alcance. Si el diseño necesita paridad exacta con
   `name`, requiere declarar una estrategia de normalización para `tags` en
   `persistence.keel.yaml`.
5. **Constantes de storage no expuestas por puerto.** `storage.keel.yaml` no expone
   `bucket`/`maxSizeMb`/`allowedContentTypes` de forma que la capa `application` pueda leerlas
   sin romper la frontera hexagonal (no puede depender de `@Value`). Quedaron como literales
   en `AddProductImageCommandHandler`, documentadas como espejo del artefacto. Si el diseño
   quiere que estas constantes vivan en una única fuente, requiere un puerto de configuración
   explícito en el dominio/aplicación.
6. **`FILE_NOT_FOUND` no declarado para el bucket `productImages`.** `S3FileStorage.download`
   mapea `NoSuchKeyException` a una excepción genérica no tipada; hoy no lo invoca ningún caso
   de uso (camino muerto), pero si se usa en el futuro, no hay un error de dominio declarado
   al que traducirlo. Propuesta: declarar `FILE_NOT_FOUND` (404) en `use-cases.keel.yaml` para
   la operación que eventualmente use `download`.

Ningún hallazgo de esta sección requirió detener la generación de forma sostenida: el único
fallo funcional que dependía de un hueco de diseño (punto 1) se resolvió pragmáticamente por
decisión explícita del usuario, documentada aquí para que el diseño lo reconcilie cuando
evolucione.
