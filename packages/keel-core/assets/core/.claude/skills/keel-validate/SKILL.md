---
name: keel-validate
description: Valida un servicio Keel multi-artefacto (schemas por capa + referencias cruzadas vía CLI) y ejecuta la revisión semántica de calidad del diseño. Usar antes de generar código o docs.
argument-hint: "<specs/servicio>"
---

# /keel-validate — validación estructural, cruzada y semántica

Valida el servicio indicado (directorio `specs/<servicio>/`) en tres niveles. No modifiques los artefactos sin confirmar cada corrección con el usuario, salvo errores triviales de formato.

## Niveles 1 y 2 — Schema por capa + referencias cruzadas (CLI)

```bash
keel validate specs/<servicio>
```

La CLI valida el manifiesto y cada capa contra su schema (`schema/<capa>.schema.json`), la coherencia `layers` ↔ archivos, y las referencias cruzadas mecánicas (tipos, entidades, operaciones, eventos, roles y permisos referenciados existen; agregados bien formados: raíz y miembros existentes, sin entidades en dos agregados, `per-aggregate` solo con agregados declarados; operaciones huérfanas como warning). Además detecta **diseño incompleto**: capas que siguen siendo la plantilla (sin operaciones, entidades, eventos o clientes) y `service.description` placeholder (empieza por `TODO` o es el texto de la plantilla).

Durante una sesión de diseño usa `keel validate --wip specs/<servicio>`: los pendientes de diseño incompleto (los `emits`/`cache.invalidatedBy` hacia una capa messaging aún no diseñada, y los campos `file` cuyo bucket aún no existe en una capa storage aún no diseñada) se reportan como avisos y el veredicto es "Diseño en progreso". El veredicto ✅ **Válido** solo existe sin `--wip`; nunca se genera ni documenta desde un "Diseño en progreso".

Si falla, traduce cada error a lenguaje del DSL (ej. "`use-cases: createProduct.emits`: el evento 'ProductCreated' no está en messaging" → "la operación emite un evento que aún no definiste en la capa messaging") y propón la corrección.

Fallback si el comando `keel` no está disponible: valida cada `<capa>.keel.yaml` con ajv-cli (`--spec=draft2020 -r schema/common.schema.json -s schema/<capa>.schema.json`) y haz las cross-refs leyendo los artefactos.

## Nivel 3 — Semántica (lo que ni el schema ni las cross-refs pueden expresar)

Lee los artefactos y verifica esta checklist. Reporta cada hallazgo con severidad **error** (bloquea generación) o **aviso** (mejorable):

**Consistencia del modelo (error):**
- Cada entidad tiene exactamente un campo con `id: true`.
- Ningún campo `generated: true` o `computed` aparece en el input de una operación.
- `default` de un campo enum pertenece a `values` (inline o del enum nominal).
- Operaciones `query` no tienen `emits`; `cache` solo en queries.
- Ningún campo `sensitive: true` aparece en un output `{ fields }` o payload de evento sin justificación explícita del diseño.
- Los `path` de endpoints con parámetros (`{x}`) usan nombres presentes en el input de la operación.
- Si `messaging` declara `reliability: outbox`, existe capa `persistence` (el outbox necesita una transacción que confirmar); si no, error.
- Ninguna invariante de una entidad depende de campos de entidades de **otro** agregado (la consistencia entre agregados es eventual, vía eventos).

**Calidad por capa (aviso, salvo indicación):**
- *domain*: invariantes ambiguas o no verificables (cítalas); entidades sin ninguna operación que las use; entidad con campo de estado enum pero sin `lifecycle` (¿las transiciones son realmente libres?); invariantes de texto que en realidad son transiciones y deberían migrar a `lifecycle`; reglas `computed` no derivables de los campos existentes; agregado con muchas entidades internas (¿frontera demasiado grande?); relación `one-to-many` hacia la raíz de otro agregado (¿composición encubierta?); entidad interna con `lifecycle` propio no gobernado por su raíz (cuestiónalo).
- *use-cases*: todo `command` declara al menos un error; commands disparados por subscription con `retry.maxAttempts > 1` sin `idempotency` (**error**); `cache.invalidatedBy` no cubre todos los eventos que mutan lo cacheado; command que muta entidades de **dos** agregados en una operación (sugerir evento + consistencia eventual).
- *api*: output `paginated: true` sin `pagination` declarada.
- *security*: mutaciones con `level: public` (cuestiónalas); roles con permisos que ninguna regla usa (exceso de privilegio); permisos huérfanos; serviceClients con más scopes de los que sus llamadas necesitan (mínimo privilegio también para máquinas); endpoints M2M sin `validateAudience` cuando el servicio convive con otros que comparten servidor de autenticación (un token emitido para otro servicio valdría aquí).
- *messaging*: eventos publicados que ninguna operación emite (huérfanos); subscriptions sin `onFailure`; eventos/suscripciones sin `channel` cuando el servicio se integra con otros (el canal es el contrato de integración y su nombre lógico debe mantenerse estable); nombres de `channel` que filtran tecnología (`kafka`, `queue`, `topic`…) en vez de ser lógicos.
- *http-clients*: `circuitBreaker` sin `fallback`; llamadas sin `timeoutMs`.
- *persistence*: entidades de domain no mencionadas (¿se persisten o no?); campos `unique` o de queries frecuentes sin índice; `per-operation` habiendo agregados declarados cuyas operaciones tocan raíz + internas (¿debería ser `per-aggregate`?).
- *storage*: buckets sin `maxSizeMb` (¿subida sin límite de tamaño?); bucket con datos personales o documentos privados marcado `public` (**cuestiónalo**); bucket declarado que ningún campo `file` referencia (huérfano); operación que sube a un bucket sin declarar los errores de subida esperados (`FILE_TOO_LARGE`, `UNSUPPORTED_CONTENT_TYPE`) en use-cases.

**Escenarios de validación (`validation-scenarios.md`):**
- Existe `specs/<servicio>/validation-scenarios.md` (formato: `docs/validation-scenarios.md`); si falta, **error**: el diseño no está cerrado y el generador no puede validar el servidor.
- Su matriz de cobertura incluye toda operación de use-cases, y cada `error` declarado aparece en algún flujo o caso borde con su `code` exacto (huecos: **error**).
- Rutas, payloads, estados y eventos de los escenarios coinciden con los artefactos; si el spec cambió después del archivo (discrepancias o versión distinta en su cabecera), márcalo como desactualizado (**error**) y propón regenerarlo con `/keel-design`.

## Salida

Termina con un veredicto claro:
- ✅ **Válido** — listo para `/keel-generate` y `/keel-docs`.
- ❌ **Inválido** — lista numerada de errores (y avisos aparte), cada uno con el artefacto afectado y su corrección propuesta. Ofrece aplicarlas.
