---
name: keel-handoff
description: Genera el documento de diseño reutilizable (DESIGN.md) de un servicio a partir de sus artefactos Keel validados. Usar cuando otro equipo necesite entender y construir sobre el diseño sin leer el código ni hablar con quien lo diseñó.
argument-hint: "<specs/servicio>"
---

# /keel-handoff — documento de diseño para reutilizar

Produce `DESIGN.md`: la explicación del diseño **para personas**, de modo que otro equipo entienda el servicio y construya sobre él **sin leer su código ni hablar con quien lo diseñó**. Es complementario, no equivalente, a los otros derivados del spec:

- `validation-scenarios.md` es el **contrato para el generador** (Given/When/Then).
- `/keel-integrate` (`INTEGRATION.md`) documenta el **contrato servidor-a-servidor** (endpoints M2M + eventos) para que otro servidor lo consuma; `/keel-docs` (`openapi.yaml`, `asyncapi.yaml`, Postman y el panel `overview.html`) produce los **contratos formales** y la vista de revisión del servicio.
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

Genera `docs/<service.name>/DESIGN.md` dentro del workspace (misma ubicación que `INTEGRATION.md`).

Bajo el título, una línea de **sello de versión** con el mismo formato que `validation-scenarios.md`:

```markdown
# <servicio> — Documento de diseño

> specs/<servicio> v<service.version>. Diseño cerrado; el porqué de las decisiones se entrevistó al cerrarlo.
```

No es decorativo: `keel describe <servicio>` compara ese sello con el manifiesto para saber si el documento nació de una versión anterior del diseño, y `/keel-evolve` decide con él qué regenerar. Actualízalo en cada regeneración.

Secciones:

1. **Propósito y alcance** — qué problema resuelve el servicio, a quién sirve y qué queda fuera, en uno o dos párrafos (desde `service.description` y el `domain`).
2. **Modelo de dominio** — las entidades con sus campos relevantes; los value types con su significado (`SKU`, `Money`…) frente a repetir constraints; los `aggregates` (raíz + entidades internas) y por qué agrupan lo que cambia junto; los `lifecycle` con sus transiciones válidas. Marca los campos `computed`, `generated` y `sensitive`.
3. **Invariantes y reglas clave** — las reglas declarativas verificables del dominio y de los casos de uso que cualquiera que reutilice el diseño debe respetar.
4. **Qué hace** — las operaciones en lenguaje de negocio (nombre por intención: `retireProduct`, no `updateStatus`), qué dispara cada una (endpoint, subscription, schedule, `internal`), qué idempotencia/caché aplica. Las operaciones con `audience: services`/`both` se documentan **aparte, como superficie servidor-a-servidor**: son contrato propio con otro equipo acoplado detrás, y quien reutilice el diseño necesita ver de un vistazo qué prometió a máquinas y qué a usuarios.
5. **Fronteras e integraciones** — con qué conversa el servicio y por qué canal. Si hay capa `dependencies`, **abre con ella**: de qué otros servidores depende, a qué versión de su contrato, qué dato necesita de cada uno y qué caso de uso lo usa, y —lo que de verdad importa a quien reutiliza el diseño— **si ese dato se pide al decidir o se mantiene replicado, y por qué**, más qué hace el servicio cuando le falta (`onMiss`). Esa elección es rationale de primera clase: condiciona lo que el servicio puede prometer con el proveedor caído, y quien derive este diseño para otro contexto de despliegue puede necesitar la contraria. Después, los canales que la sostienen: eventos publicados/consumidos (`messaging`), llamadas HTTP a terceros con su resiliencia (`http-clients`), modelo de almacenamiento y frontera transaccional (`persistence`), buckets de archivos y sus políticas de content-type/tamaño/visibilidad (`storage`), y el modelo de acceso (`security`: roles, permisos, mínimo privilegio).
6. **Decisiones de diseño (qué / por qué)** — ver abajo.
7. **Ficha de reutilización: adoptar, derivar o evolucionar** — la sección que un humano lee para decidir si este diseño le sirve tal cual o qué debe adaptar. Cuatro subsecciones:
   - **Contrato estable vs adaptable** — qué partes son **contrato estable** (códigos de error `SCREAMING_SNAKE_CASE`, nombres de evento en pasado, endpoints publicados, roles y permisos) y cuáles son adaptables sin romper a nadie (reglas de `use-cases`, políticas de idempotencia/caché/resiliencia, límites de buckets, entidades no expuestas en payloads); cómo versiona el spec (patch/minor/major) según `docs/methodology.md`.
   - **Puntos de extensión típicos** — dónde crece el diseño sin romper lo existente: estados de `lifecycle` donde insertar transiciones nuevas, enums ampliables, capas opcionales ausentes que un derivado puede añadir, operaciones `internal` sustituibles; y qué piezas (value types, patrones de lifecycle/outbox/resiliencia) son candidatas a reutilizar en otro servicio.
   - **Supuestos y limitaciones** (encabezado literal `### Supuestos y limitaciones`) — qué asume el diseño (moneda única, un tenant, volumen esperado, modelo de consistencia…) y qué **no** cubre a propósito. No es derivable del spec: se entrevista al humano igual que las decisiones de la sección 6; si no lo aporta, marca `> supuesto pendiente`.
   - **Cómo reutilizarlo** — los comandos concretos, y **las dos formas, porque no cuestan lo mismo**. `keel describe <servicio>` da el resumen mecánico previo (identidad, estado, capas, contenido). Después: si el diseño sirve **tal cual**, se **adopta** —`keel registry get <diseño>` si está publicado en un registry, o copiando `specs/<servicio>/` y `docs/<servicio>/` si está en un workspace a mano—, llega con sus derivados al día y se va **directo a generar**, sin fase de diseño; si hay que **cambiarlo**, se **deriva** con `keel new <nuevo> --from <servicio>`, que clona solo el spec con linaje `basedOn` y hace que `/keel-design` arranque en modo derivación (entrevista solo sobre lo que cambia). Di explícitamente **cuál de las dos esperas** que aplique a este diseño según lo que hayas escrito en «Contrato estable vs adaptable»: derivar para acabar usándolo sin cambios obliga a regenerar a mano todo lo que ya estaba hecho.

## Decisiones de diseño: el "por qué" no es derivable

Los artefactos son **declarativos**: guardan el *qué*, no el *por qué*. El rationale de las decisiones no se puede derivar del spec, y es justo lo que otro equipo necesita para reutilizar bien el diseño. Por eso:

1. **Deriva las características** (el "qué") mecánicamente de las capas, como arriba.
2. **Detecta las elecciones notables** y entrevista brevemente al humano para capturar el porqué de las **no obvias**. Candidatas típicas:
   - la **frontera de cada agregado** (por qué esas entidades cambian juntas y esas otras no);
   - cada `lifecycle` (por qué esas transiciones y no otras);
   - campos `sensitive` / `computed` / `generated`;
   - cada **código de error** relevante (qué caso de negocio protege);
   - operaciones con nombre de negocio en lugar de CRUD;
   - las **decisiones estructurales** — fiabilidad de publicación (`outbox`/`best-effort`), idempotencia, caché, superficie M2M, política de fallo de las suscripciones, resiliencia de `http-clients` (timeouts, circuit breaker, fallback), frontera transaccional, política de concurrencia y visibilidad de buckets. Son las que fijan lo que el servicio **garantiza**, las decidió el diseñador una a una durante `/keel-design` (catálogo en `keel-design/references/structural-decisions.md`) y por tanto tienen dueño y porqué. De cada una, captura **qué se decidió y qué alternativa se descartó**: quien derive este diseño para otro contexto puede necesitar justo la contraria, y sin la alternativa descartada no sabrá si puede cambiarla;
   - los límites de content-type/tamaño de cada bucket de `storage`;
   - decisiones de `security` (por qué un rol tiene un permiso, por qué algo es público);
   - **supuestos estructurales del diseño** (escala, tenancy, moneda, modelo de consistencia) y limitaciones deliberadas — alimentan la subsección «Supuestos y limitaciones» de la ficha de reutilización.

   Pregunta con `AskUserQuestion` cuando haya opciones claras, en texto libre cuando no. **Nunca inventes el rationale**: si el humano no lo aporta, deja la entrada marcada como `> rationale pendiente` para completar después.
3. **Regeneración segura.** Al re-ejecutar sobre un `DESIGN.md` existente, refresca el sello de versión y **re-deriva las secciones mecánicas** (1-5 y las subsecciones mecánicas de la 7) pero **preserva la sección "Decisiones de diseño" y la subsección `### Supuestos y limitaciones`** ya redactadas (esta última se localiza por su encabezado literal): solo pregunta por decisiones o supuestos nuevos (elecciones notables que aparecieron desde la última vez) o por los que quedaron `pendiente`. A diferencia de `INTEGRATION.md`, que se sobrescribe entero, aquí el conocimiento humano capturado no se pierde en la regeneración.

## Índice del repositorio (`README.md`)

Tras escribir `DESIGN.md`, **actualiza el índice de servicios del `README.md` en la raíz del workspace** para que quien abra el repositorio descubra el diseño y pueda reutilizarlo. No lo escribas a mano: ejecuta

```bash
keel index
```

El comando reescribe **solo** la región delimitada por los marcadores `<!-- keel:servicios:start -->` / `<!-- keel:servicios:end -->` —preservando la introducción y cualquier sección escrita por humanos— y regenera además `index.json`, el índice máquina del workspace. Deriva cada fila del propio diseño (identidad, dominio, capas, resumen y enlaces a los derivados que existen de verdad), así que es idempotente por construcción: ejecutarlo dos veces no duplica ni reordena filas.

Reglas:

- **El índice tiene un único escritor, y es `keel index`.** Nunca edites la región entre marcadores a mano ni con Edit: dos escritores sobre la misma tabla la desincronizan en cuanto uno de los dos cambia de formato.
- Si el comando avisa de que falta el `README.md` o los marcadores (workspace sembrado antes de incluir el template), créalo con la estructura mínima —título, introducción breve, sección `## Servicios diseñados` y las dos líneas de marcadores— y vuelve a ejecutar `keel index`.
- Un aviso de `keel index` (un diseño que no carga, un `service.name` que no coincide con su directorio, un `design.yaml` inválido) hace que el comando salga con código 1. Repórtalo al humano en vez de darlo por bueno: el índice se generó, pero algo del workspace está mal.

## Coherencia

`DESIGN.md` debe contar la misma historia que el resto de derivados del spec: mismas entidades, operaciones, errores y eventos que `INTEGRATION.md` (de `/keel-integrate`), `openapi.yaml` y `asyncapi.yaml` (de `/keel-docs`) y `validation-scenarios.md`. Si el spec cambió, regenera y revisa que las decisiones registradas sigan vigentes. `keel describe <servicio>` es el resumen mecánico rápido del mismo diseño; `DESIGN.md` es la ficha completa — dos profundidades de la misma historia, nunca contradictorias.
