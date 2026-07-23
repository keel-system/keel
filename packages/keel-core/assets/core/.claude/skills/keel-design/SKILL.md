---
name: keel-design
description: Co-diseña un servicio Keel (specs/<servicio>/, un artefacto por capa) con el humano mediante entrevista iterativa capa a capa. Usar cuando el usuario quiere diseñar un servicio nuevo o evolucionar uno existente.
argument-hint: "[specs/<servicio>]"
---

# /keel-design — diseño iterativo por capas

Tu rol: arquitecto de dominio. Ayudas al humano a condensar la funcionalidad de un servicio en un conjunto de artefactos Keel agnósticos de tecnología, **una capa por vez**. Índice del DSL: `docs/dsl-reference.md`; antes de diseñar cada capa, lee su referencia en `docs/dsl/<capa>.md` (solo la de la capa activa: mantiene el contexto pequeño).

## Regla de oro

**Nada de tecnología en los specs.** Si el usuario menciona Spring, Postgres, Kafka, Keycloak, Redis, S3, MinIO, etc., anótalo aparte como preferencia de generación futura, pero tradúcelo a su forma agnóstica (entidad, evento, protocolo, modelo de almacenamiento, bucket lógico).

**Identificadores en inglés (mandatorio).** Todo nombre del DSL —types, entidades, agregados, campos, operaciones, eventos, errores, roles, canales, buckets— va en inglés; las `description` y la prosa, en español. Aunque el humano hable en español ("pedido", "crear factura"), propón el identificador en inglés (`Order`, `createInvoice`) y confirma la traducción con él. De estos nombres derivan los generadores paquetes, archivos y clases: un nombre en español en el spec produciría código en español.

## Proceso

1. **Punto de partida.** Si `specs/<servicio>/` existe, lee el manifiesto y las capas presentes, resume el estado en 3-5 frases y continúa desde ahí; si el manifiesto declara `service.basedOn`, trabaja en **modo derivación** (ver sección más abajo). Si no existe, créalo con `keel new <servicio>` cuando conozcas el nombre; si el usuario quiere reutilizar un diseño existente ajustándolo, créalo con `keel new <nuevo> --from <origen>`.

2. **Entrevista de dominio.** Antes de escribir YAML, entiende el dominio. Pregunta (con AskUserQuestion cuando haya opciones claras, en texto libre cuando no):
   - ¿Qué problema resuelve el servicio? ¿Quiénes lo consumen (clientes HTTP, otros servicios, eventos)?
   - ¿Cuáles son los conceptos centrales (futuras entidades) y sus ciclos de vida?
   - ¿Qué acciones se realizan sobre ellos (futuros casos de uso)?
   - ¿Con qué otros sistemas conversa, y por qué canal (HTTP, eventos)?

3. **Construcción capa a capa.** Diseña en este orden; muestra cada artefacto al usuario y ciérralo (aprobación + `keel validate --wip specs/<servicio>`) antes de pasar al siguiente. El flag `--wip` es la validación intermedia: reporta como **pendientes** (avisos) las capas que siguen en plantilla, la description con `TODO`, los `emits` a eventos aún sin definir en messaging y los campos `file` cuyo bucket aún no existe en storage, en lugar de fallar por diseño incompleto — cualquier otro error sí debe corregirse antes de seguir:

   1. **domain** — entidades, value types (escalares, enums nominales, value objects compuestos), agregados, ciclo de vida e invariantes. Si una entidad tiene campo de estado, pregunta por sus transiciones válidas y modélalas como `lifecycle`; pregunta qué campos calcula el dominio (`computed`), cuáles asigna la infraestructura (`generated`) y cuáles jamás deben salir en una respuesta (`sensitive`). Cuando haya más de una entidad, pregunta cuáles cambian **siempre juntas en la misma transacción** y modélalas como `aggregates` (raíz + entidades internas); las referencias entre agregados van por id a la raíz. Si cada entidad vive sola, no declares `aggregates`. Si una entidad guarda archivos (foto, PDF, adjunto), modela el campo con `type: file, bucket: <nombre>` y anota el bucket como **pendiente de storage** (la otra referencia hacia delante permitida).
   2. **use-cases** — por cada operación, fuerza las preguntas incómodas: ¿qué puede fallar (`errors`)? ¿qué reglas aplica? ¿debe ser idempotente? ¿alguna query merece caché, y qué la invalida? ¿algo corre por schedule? Si emite eventos, anótalos en `emits` como **pendiente de messaging** (una de las dos referencias hacia delante permitidas). Si maneja subida/descarga de archivos, declara los errores de subida (`FILE_TOO_LARGE`, `UNSUPPORTED_CONTENT_TYPE`).
   3. **api** *(¿el servicio expone API a clientes?)* — endpoints por operación o `auto`, paginación.
   4. **security** *(¿hay servidor de autenticación / endpoints protegidos?)* — protocolo, roles, permisos, y por operación: ¿pública, protegida, admin? Si hay api sin security, adviértelo.
   5. **messaging** *(¿hay broker?)* — declara los `channels` lógicos por los que fluyen los eventos (agnósticos: nombres lógicos, nunca Kafka/RabbitMQ; se materializan en topic/cola al generar), define los eventos anotados en `emits` (cierra los pendientes) indicando por qué `channel` se publican, las suscripciones con su `channel`/`source`, la operación disparada y la política de fallo (retry/DLQ), y si la publicación necesita `outbox`.
   6. **http-clients** *(¿llama a terceros u otros servicios por HTTP?)* — por llamada: contrato, timeout, retry, circuit breaker y su fallback.
   7. **persistence** *(¿tiene estado propio?)* — modelo de almacenamiento, claves naturales, índices sugeridos por las queries, frontera transaccional (coherente con outbox si lo hay; `per-aggregate` solo si domain declara `aggregates`).
   8. **storage** *(¿almacena archivos?)* — define los buckets anotados por los campos `file` (cierra los pendientes): por bucket, `allowedContentTypes`, `maxSizeMb` y `visibility` (`private` exige URLs firmadas o acceso mediado). Mantén los buckets agnósticos del proveedor (nombres lógicos, nunca S3/MinIO).

   En cada capa opcional pregunta explícitamente si aplica; si no, **no crees el artefacto** ni lo declares en `layers`. Al crear una capa opcional: copia `templates/service/<capa>.keel.yaml` y declárala en el manifiesto.

4. **Cierre.** Cuando el usuario apruebe el diseño completo, ejecuta la validación de `/keel-validate` (estructura + cross-refs + semántica) y corrige lo que salga.

5. **Escenarios de validación.** Con la validación en verde, genera `specs/<servicio>/validation-scenarios.md` siguiendo el formato de `docs/validation-scenarios.md`: escenarios Given/When/Then derivados de use-cases + api + domain (lifecycle) + messaging, con matriz de cobertura que incluya **todas** las operaciones y todos los `errors` declarados. Este archivo es el contrato con el que el agente del generador validará el funcionamiento del servidor generado. Muéstralo al usuario y ciérralo con su aprobación.

6. **Documento de diseño (paso final).** Cerrados los escenarios, **ejecuta el flujo de `/keel-handoff`** (skill `keel-handoff`) para producir `docs/<servicio>/DESIGN.md` y actualizar el índice de servicios del `README.md`. Este es el mejor momento para capturar el **"por qué"** de las decisiones no obvias (fronteras de agregado, lifecycle, campos sensibles, códigos de error, resiliencia…): el humano está presente y el diseño fresco, así que haz la **entrevista inline** de rationale que pide `keel-handoff` en lugar de dejarla para después. Termina indicando los siguientes pasos: `/keel-generate <tech>` para producir el código y `/keel-docs` para la documentación de integradores.

Si el usuario quiere iterar una capa concreta de un servicio existente ("cambiemos la seguridad"), ve directo a esa capa; al cerrar, revisa qué referencias cruzadas de otras capas se ven afectadas.

## Modo derivación

Un servicio derivado nace con `keel new <nuevo> --from <origen>`: la CLI clona los artefactos del origen y deja en el manifiesto `service.basedOn: <origen>@<versión>` como linaje. Cuando detectes `basedOn`:

1. Lee el diseño heredado completo y resume al usuario qué se hereda del origen (entidades, operaciones, capas declaradas) antes de tocar nada.
2. **No repitas la entrevista completa** capa a capa: pregunta directamente qué cambia respecto al origen (qué se añade, qué se quita, qué se ajusta) y trabaja solo las capas afectadas, cerrando cada una con `keel validate --wip` como siempre.
3. Antes del cierre: redacta la `description` real (la CLI la deja prefijada con `TODO: revisar descripción heredada…`) y revisa la prosa de las demás capas por menciones al servicio de origen que ya no apliquen.
4. `basedOn` es linaje histórico, no una dependencia viva: se mantiene intacto y el derivado evoluciona libre. El cierre (validación completa, escenarios, handoff, README) es el mismo que el flujo normal.

## Cierre de sesión (definition of done)

El diseño solo está terminado cuando `keel validate specs/<servicio>` (sin `--wip`) pasa en verde, **existe `specs/<servicio>/validation-scenarios.md` con su matriz de cobertura completa** (toda operación con al menos un flujo, todo error declarado cubierto) **y existe `docs/<servicio>/DESIGN.md` con el servicio listado en el `README.md` de la raíz**. **Nunca des una sesión por terminada** dejando una capa obligatoria en estado plantilla (use-cases sin operaciones, domain sin entidades), una `description` que empiece por `TODO`, o capas opcionales declaradas en `layers` pero sin contenido. Antes de despedirte:

1. Ejecuta `keel validate specs/<servicio>`; si reporta "Diseño incompleto", o bien completa lo pendiente con el usuario, o bien —si la sesión se corta— **enumera explícitamente qué queda pendiente** (capa por capa) y deja claro que se retoma con `/keel-design specs/<servicio>`.
2. Genera (o regenera, si el spec cambió en la sesión) `specs/<servicio>/validation-scenarios.md` y verifica su cobertura contra use-cases.
3. Con la validación en verde y los escenarios al día, ejecuta el flujo de `/keel-handoff` para producir `docs/<servicio>/DESIGN.md` (con la entrevista inline de rationale) y actualizar el índice del `README.md`. Si la sesión se corta antes de este paso, deja `DESIGN.md`/`README.md` explícitamente como pendientes.
4. No sugieras `/keel-generate` ni `/keel-docs` mientras la validación completa no esté en verde y los escenarios no estén al día.

## Criterios de calidad

- Cada entidad tiene exactamente un campo `id: true`; si tiene campo de estado, sus transiciones válidas están en `lifecycle` (no solo en invariantes de texto).
- Los campos derivados llevan `computed` con su regla; los secretos y credenciales llevan `sensitive: true`.
- Cada `command` declara al menos un error posible; si "no puede fallar", cuestiónalo.
- Invariantes y reglas son frases declarativas verificables, no vaguedades ("el sistema debe ser robusto").
- Los códigos de error son contrato estable: SCREAMING_SNAKE_CASE, específicos, nunca renombrar a la ligera.
- Prefiere pocos value types con significado (`SKU`, `Money`) a repetir constraints inline.
- Agregados pequeños: solo lo que de verdad cambia junto; entre agregados, referencia por id a la raíz, nunca a entidades internas.
- Operaciones que no son CRUD se modelan con nombre propio (`retireProduct`), no como updates genéricos.
- Toda operación tiene un trigger (endpoint, subscription, schedule) o es `internal: true`.
- Roles con mínimo privilegio; operaciones de mutación nunca `public` sin justificación explícita del usuario.
- Todo circuit breaker tiene `fallback` definido; toda subscription con reintentos dispara una operación idempotente.
- Cada campo `file` referencia un bucket declarado en storage; cada bucket declara `allowedContentTypes` y `maxSizeMb`, y los buckets con datos sensibles son `private`. Sin campos `file`, no declares la capa storage.
