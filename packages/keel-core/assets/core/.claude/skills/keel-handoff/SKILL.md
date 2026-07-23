---
name: keel-handoff
description: Genera el documento de diseño reutilizable (DESIGN.md) de un servicio a partir de sus artefactos Keel validados. Usar cuando otro equipo necesite entender y construir sobre el diseño sin leer el código ni hablar con quien lo diseñó.
argument-hint: "<specs/servicio>"
---

# /keel-handoff — documento de diseño para reutilizar

Produce `DESIGN.md`: la explicación del diseño **para personas**, de modo que otro equipo entienda el servicio y construya sobre él **sin leer su código ni hablar con quien lo diseñó**. Es complementario, no equivalente, a los otros derivados del spec:

- `validation-scenarios.md` es el **contrato para el generador** (Given/When/Then).
- `/keel-integrate` (`INTEGRATION.md`) documenta el **contrato servidor-a-servidor** (endpoints M2M + eventos) para que otro servidor lo consuma; `/keel-docs` (`openapi.yaml` + Postman) documenta la **API de usuarios** para clientes web/mobile.
- `/keel-handoff` (`DESIGN.md`) documenta **el diseño mismo** —sus características y decisiones— para reutilizarlo.

Todo lo mecánico (el "qué") se deriva de los artefactos de `specs/<servicio>/`; **si algo no se puede derivar, es un hueco del diseño: repórtalo, no lo inventes.**

Antes de generar, ejecuta las comprobaciones de `/keel-validate`; no documentes un diseño inválido o en `--wip`.

## Fuentes por sección

Cada parte del documento se deriva de capas concretas:

| Sección de `DESIGN.md` | Capas fuente |
|---|---|
| Propósito y alcance | `service.keel.yaml`, `domain` |
| Modelo de dominio (entidades, value types, agregados, lifecycle) | `domain` |
| Invariantes y reglas clave | `domain` (invariantes), `use-cases` (reglas) |
| Qué hace (operaciones/casos de uso, en lenguaje de negocio) | `use-cases`, `api` |
| Fronteras e integraciones | `messaging`, `http-clients`, `persistence`, `storage`, `security` |
| Cobertura de comportamiento | `validation-scenarios.md` (matriz de cobertura) |
| Ficha de reutilización | todas las capas (contrato/extensión) + entrevista al humano (supuestos y limitaciones) |

Si una capa opcional no existe, su parte se omite (no se documenta lo que el servicio no tiene).

## Salida

Genera `docs/<service.name>/DESIGN.md` dentro del workspace (misma ubicación que `INTEGRATION.md`), con estas secciones:

1. **Propósito y alcance** — qué problema resuelve el servicio, a quién sirve y qué queda fuera, en uno o dos párrafos (desde `service.description` y el `domain`).
2. **Modelo de dominio** — las entidades con sus campos relevantes; los value types con su significado (`SKU`, `Money`…) frente a repetir constraints; los `aggregates` (raíz + entidades internas) y por qué agrupan lo que cambia junto; los `lifecycle` con sus transiciones válidas. Marca los campos `computed`, `generated` y `sensitive`.
3. **Invariantes y reglas clave** — las reglas declarativas verificables del dominio y de los casos de uso que cualquiera que reutilice el diseño debe respetar.
4. **Qué hace** — las operaciones en lenguaje de negocio (nombre por intención: `retireProduct`, no `updateStatus`), qué dispara cada una (endpoint, subscription, schedule, `internal`), qué idempotencia/caché aplica.
5. **Fronteras e integraciones** — con qué conversa el servicio y por qué canal: eventos publicados/consumidos (`messaging`), llamadas HTTP a terceros con su resiliencia (`http-clients`), modelo de almacenamiento y frontera transaccional (`persistence`), buckets de archivos y sus políticas de content-type/tamaño/visibilidad (`storage`), y el modelo de acceso (`security`: roles, permisos, mínimo privilegio).
6. **Decisiones de diseño (qué / por qué)** — ver abajo.
7. **Ficha de reutilización: evolucionar o derivar** — la sección que un humano lee para decidir si este diseño le sirve tal cual o qué debe adaptar. Cuatro subsecciones:
   - **Contrato estable vs adaptable** — qué partes son **contrato estable** (códigos de error `SCREAMING_SNAKE_CASE`, nombres de evento en pasado, endpoints publicados, roles y permisos) y cuáles son adaptables sin romper a nadie (reglas de `use-cases`, políticas de idempotencia/caché/resiliencia, límites de buckets, entidades no expuestas en payloads); cómo versiona el spec (patch/minor/major) según `docs/methodology.md`.
   - **Puntos de extensión típicos** — dónde crece el diseño sin romper lo existente: estados de `lifecycle` donde insertar transiciones nuevas, enums ampliables, capas opcionales ausentes que un derivado puede añadir, operaciones `internal` sustituibles; y qué piezas (value types, patrones de lifecycle/outbox/resiliencia) son candidatas a reutilizar en otro servicio.
   - **Supuestos y limitaciones** (encabezado literal `### Supuestos y limitaciones`) — qué asume el diseño (moneda única, un tenant, volumen esperado, modelo de consistencia…) y qué **no** cubre a propósito. No es derivable del spec: se entrevista al humano igual que las decisiones de la sección 6; si no lo aporta, marca `> supuesto pendiente`.
   - **Cómo derivar** — los comandos concretos: `keel describe <servicio>` da el resumen mecánico previo (identidad, estado, capas, contenido), `keel new <nuevo> --from <servicio>` clona el diseño con linaje `basedOn`, y `/keel-design` arranca en modo derivación (entrevista solo sobre lo que cambia).

## Decisiones de diseño: el "por qué" no es derivable

Los artefactos son **declarativos**: guardan el *qué*, no el *por qué*. El rationale de las decisiones no se puede derivar del spec, y es justo lo que otro equipo necesita para reutilizar bien el diseño. Por eso:

1. **Deriva las características** (el "qué") mecánicamente de las capas, como arriba.
2. **Detecta las elecciones notables** y entrevista brevemente al humano para capturar el porqué de las **no obvias**. Candidatas típicas:
   - la **frontera de cada agregado** (por qué esas entidades cambian juntas y esas otras no);
   - cada `lifecycle` (por qué esas transiciones y no otras);
   - campos `sensitive` / `computed` / `generated`;
   - cada **código de error** relevante (qué caso de negocio protege);
   - operaciones con nombre de negocio en lugar de CRUD;
   - resiliencia de `http-clients` (timeouts, circuit breaker, fallback) y uso de `outbox`;
   - visibilidad de cada bucket de `storage` (por qué público o privado) y sus límites de content-type/tamaño;
   - decisiones de `security` (por qué un rol tiene un permiso, por qué algo es público);
   - **supuestos estructurales del diseño** (escala, tenancy, moneda, modelo de consistencia) y limitaciones deliberadas — alimentan la subsección «Supuestos y limitaciones» de la ficha de reutilización.

   Pregunta con `AskUserQuestion` cuando haya opciones claras, en texto libre cuando no. **Nunca inventes el rationale**: si el humano no lo aporta, deja la entrada marcada como `> rationale pendiente` para completar después.
3. **Regeneración segura.** Al re-ejecutar sobre un `DESIGN.md` existente, **re-deriva las secciones mecánicas** (1-5 y las subsecciones mecánicas de la 7) pero **preserva la sección "Decisiones de diseño" y la subsección `### Supuestos y limitaciones`** ya redactadas (esta última se localiza por su encabezado literal): solo pregunta por decisiones o supuestos nuevos (elecciones notables que aparecieron desde la última vez) o por los que quedaron `pendiente`. A diferencia de `INTEGRATION.md`, que se sobrescribe entero, aquí el conocimiento humano capturado no se pierde en la regeneración.

## Índice del repositorio (`README.md`)

Tras escribir `DESIGN.md`, **actualiza el índice de servicios del `README.md` en la raíz del workspace** para que quien abra el repositorio descubra el diseño y pueda reutilizarlo. Reescribe **solo** la región delimitada por los marcadores, preservando la introducción y cualquier otra sección escrita por humanos:

```
<!-- keel:servicios:start -->
...tabla generada...
<!-- keel:servicios:end -->
```

Reglas:

- La tabla tiene una fila por servicio con columnas **Servicio | Descripción | Diseño | Integración**: `Servicio` es `service.name`; `Descripción` sale de `service.description`; `Diseño` enlaza `docs/<service.name>/DESIGN.md`; `Integración` enlaza `docs/<service.name>/INTEGRATION.md` **solo si el archivo existe** (si no, deja la celda con `—`).
- **Upsert idempotente**: si el servicio ya tiene fila, actualízala; si no, añádela. Regenerar no debe duplicar filas. Ordena las filas alfabéticamente por servicio.
- Si el `README.md` no existe (workspace sembrado antes de incluir el template), créalo con la misma estructura: título, introducción breve, sección `## Servicios diseñados` con los marcadores y la tabla.

## Coherencia

`DESIGN.md` debe contar la misma historia que el resto de derivados del spec: mismas entidades, operaciones, errores y eventos que `INTEGRATION.md` (de `/keel-integrate`), `openapi.yaml` (de `/keel-docs`) y `validation-scenarios.md`. Si el spec cambió, regenera y revisa que las decisiones registradas sigan vigentes. `keel describe <servicio>` es el resumen mecánico rápido del mismo diseño; `DESIGN.md` es la ficha completa — dos profundidades de la misma historia, nunca contradictorias.
