# Guía del panel `overview.html`

Formato exacto del panel visual que `/keel-docs` escribe en `docs/<service.name>/overview.html`, más
los dos visores de contratos (`openapi.html`, `asyncapi.html`).

**Tú no escribes HTML.** El markup, el CSS y el JS de render son assets fijos
(`templates/overview.html`, `templates/spec-viewer.html`): se copian **verbatim** y solo se sustituyen
sus placeholders. Así el panel sale con la misma forma en cada ejecución y en cada servicio; tu único
trabajo es derivar el objeto de datos correctamente. Si te falta un dato, va a `gaps` — nunca se
inventa ni se retoca el template para acomodarlo.

## Procedimiento

1. Copia `templates/overview.html` a `docs/<service.name>/overview.html`.
2. Deriva el objeto `KEEL` (contrato abajo) y sustituye en la copia la cadena exacta
   `/*__KEEL_DATA__*/ null` por su JSON (`JSON.stringify(KEEL, null, 2)` — legible, sin la coma final).
3. Copia `templates/spec-viewer.html` a `docs/<service.name>/openapi.html` y sustituye:
   `__KEEL_TITLE__` → `<service.name> · OpenAPI`, `__KEEL_RENDERER__` → `redoc`,
   `/*__KEEL_SPEC__*/ null` → el `openapi.yaml` recién generado **convertido a JSON**.
4. Solo si hay capa `messaging`: lo mismo en `asyncapi.html` con `· AsyncAPI`, `asyncapi` y el
   `asyncapi.yaml` en JSON.
5. Comprueba que cada archivo generado ya no contiene ningún `__KEEL_` ni `__KEEL_DATA__`, y que el
   JSON incrustado parsea (extrae el bloque y pásalo por `node -e "JSON.parse(...)"`).

Los tres archivos **se regeneran siempre y se sobrescriben enteros**.

## El objeto `KEEL`

```js
{
  service:      { name, version, description, domain, basedOn, generatedAt },
  links:        [ { label, href, description } ],
  gaps:         [ "…" ],
  capabilities: [ { id, label, active, state, headline, facts: [[k, v]], note } ],
  useCases:     [ … ],
  events:       { envelope, reliability, published: [ … ], subscriptions: [ … ] } | null,
  httpClients:  [ … ],
  domain:       { entities: [ … ], aggregates: [ … ], types: [ … ] }
}
```

Toda clave ausente o `null` hace que el template oculte su sección: no emitas estructuras vacías para
capas que el servicio no declara.

### `service`

Del manifiesto. `generatedAt` es la fecha de generación en `YYYY-MM-DD` (es el **único** campo que
cambia entre dos ejecuciones sobre el mismo spec). `basedOn` solo si el manifiesto lo declara.

### `links`

Un enlace por artefacto **realmente escrito**; omite el resto (el template no comprueba nada en
runtime). Orden fijo:

| `label` | `href` | Cuándo |
|---|---|---|
| `OpenAPI (visor)` | `openapi.html` | siempre |
| `AsyncAPI (visor)` | `asyncapi.html` | con capa `messaging` |
| `openapi.yaml` | `openapi.yaml` | siempre |
| `asyncapi.yaml` | `asyncapi.yaml` | con capa `messaging` |
| `Colecciones Postman` | `postman/` | siempre |
| `Contrato de integración` | `INTEGRATION.md` | si el archivo existe |
| `Documento de diseño` | `DESIGN.md` | si el archivo existe |

### `capabilities` — las ocho tarjetas, en este orden

Siempre las ocho, en este orden y con estos `id` y `label`. `active: false` pinta la tarjeta como «no
aplica» (atenuada) — ese es el valor informativo: se ve de un vistazo lo que el servicio **no** usa.
`state` es el texto del badge cuando está activa (default `sí`); `facts` es una lista de pares
`[etiqueta, valor]`; `note` es una frase corta opcional.

| `id` | `label` | `active` cuando | `facts` |
|---|---|---|---|
| `persistence` | Persistencia | hay capa `persistence` | Modelo (`relational`/`document`/`key-value`), Entidades persistidas (nº), Frontera transaccional, Claves naturales (nº), Índices (nº) |
| `messaging` | Broker de mensajería | hay capa `messaging` | Canales (nº, y cuántos `external`), Eventos publicados (nº), Suscripciones (nº) |
| `outbox` | Patrón outbox | `messaging.publishing.reliability === 'outbox'` | Garantía, Frontera transaccional que lo sostiene (de `persistence.consistency`) |
| `cache` | Caché de respuestas | alguna operación declara `cache` | una fila por query cacheada: `[<operación>, "TTL <n>s · clave: <keyFields>"]` |
| `storage` | Almacenamiento de archivos | hay capa `storage` | una fila por bucket: `[<bucket>, "<visibility> · <maxSizeMb> MB · <contentTypes>"]` |
| `httpClients` | Integraciones HTTP salientes | hay capa `http-clients` | Clientes (nº), Llamadas (nº), Con circuit breaker (nº) |
| `security` | Seguridad | hay capa `security` | Protocolo, M2M (`serviceAuth.protocol` o `no`), Roles (nº), Permisos (nº), Clientes máquina (nº) |
| `schedule` | Trabajos programados | alguna operación declara `schedule` | una fila por operación: `[<operación>, <cron>]` |

`headline` resume la tarjeta en una frase; con `active: false`, di por qué no aplica («El servicio no
declara capa de persistencia: no guarda estado propio.»). Cuando el broker está activo, la `note` debe
recordar que el broker concreto se decide al generar.

Para `outbox` inactivo pero con `messaging` presente, la `headline` dice que la publicación es
`best-effort` y admite pérdida ante fallos — es un hecho de diseño relevante, no un simple «no».

### `useCases`

Un objeto por operación de `use-cases`, en el orden en que aparecen en el artefacto. El template
agrupa por `audience` en pestañas y filtra por texto; no agrupes tú.

```js
{
  name: "createProduct",
  kind: "command",                       // command | query
  description: "Da de alta un producto en estado draft.",
  audience: "users",                     // users | services | both | internal
  trigger: { type: "http", method: "POST", path: "/api/v1/products" },
  input:  { kind: "fields", fields: [ { name, type, required, list, description } ] },
  output: { kind: "entity", entity: "Product", list: false, paginated: false, exclude: [] },
  preconditions: [ "…" ],
  rules: [ "…" ],
  errors: [ { code: "SKU_ALREADY_EXISTS", http: 409, when: "Ya existe un producto con ese sku." } ],
  idempotency: { keySource: "client-key", ttlSeconds: 86400 },
  cache: { ttlSeconds: 300, keyFields: ["id"], invalidatedBy: ["ProductRetired"] },
  schedule: { cron: "0 3 * * *" },
  security: { level: "required", roles: [], permissions: ["product:write"], scopes: [] },
  emits: [ "ProductCreated" ]
}
```

- `input`/`output` — `kind` es `void`, `fields` o `entity`, calcado de la forma del DSL. En `entity`
  refleja `list`, `paginated` y `exclude`. En `fields`, un objeto por campo con su tipo tal cual lo
  declara el diseño (nombre del value type, no su base).
- `trigger` — `{ type: "http", method, path }` (path = `basePath` + ruta del endpoint, explícito o
  derivado de `auto`), `{ type: "event", event: "<Evento>" }` si lo dispara una suscripción,
  `{ type: "schedule", cron }`, o `{ type: "internal" }`.
- `audience` — de la capa `api`: `endpoints[<op>].audience` → `defaultAudience` → `users`. Una
  operación **sin endpoint** (evento, schedule, `internal: true`) es `internal`, aunque exista capa
  `api`. Sin capa `api`, todas son `internal`.
- `security` — la regla efectiva de `security.access` (`rules[<op>]` → `default`). `null` si no hay
  capa `security`. Emite solo las listas que la regla declara.
- `idempotency`, `cache`, `schedule` — `null` cuando la operación no los declara; el template los usa
  para los badges *idempotente* y *cacheada*, que son parte de lo que el diseñador viene a comprobar.
- Omite lo que el diseño no declara; no rellenes con `"—"`, de eso ya se encarga el template.

### `events`

`null` sin capa `messaging`. `envelope` es siempre `"keel"` para lo publicado (la envoltura estándar);
`reliability` viene de `publishing.reliability`.

```js
{
  envelope: "keel",
  reliability: "outbox",
  published: [ {
    name: "ProductCreated", description, channel: "productEvents",
    emittedBy: [ "createProduct" ],                 // operaciones cuyo `emits` lo incluye
    payload: [ { name, type, required, list, description } ]
  } ],
  subscriptions: [ {
    name: "StockDepleted", description, source: "inventory-service", channel: "inventoryEvents",
    triggers: "retireProduct",
    contract: { envelope, payloadPath, format, discriminator, messageId, unknownFields },
    payload: [ … ],
    onFailure: { retry: "5 intentos · exponential · 1000 ms", deadLetter: true }
  } ]
}
```

`contract.discriminator`, `contract.messageId` y `onFailure.retry` se aplanan a **texto legible**
(p. ej. `header eventType = stock.depleted`, `header messageId`, `5 intentos · exponential · 1000 ms`):
el template los pinta tal cual. `channel: null` cuando el diseño lo deja a convención del generador.

### `httpClients`

`[]` (o clave ausente) sin capa `http-clients`.

```js
[ {
  name: "pricing-service", purpose: "Obtener el precio vigente de un producto.",
  auth: "api-key (X-Api-Key)",                       // texto ya legible; nunca credenciales
  calls: [ {
    name: "getPrice", contract: "Precio vigente de un SKU con su moneda.",
    method: "GET", path: "/prices/{sku}", timeoutMs: 2000,
    retry: "3 intentos · exponential · reintenta en timeout, 5xx",
    circuitBreaker: "50% de fallos / ventana 20 · espera 30000 ms",
    fallback: "Devolver el último precio conocido en caché; si no existe, error PRICE_UNAVAILABLE."
  } ]
} ]
```

`retry` y `circuitBreaker` van aplanados a texto. `auth` es solo el mecanismo: **jamás** un valor de
api-key, secret ni token.

### `domain`

```js
{
  entities: [ {
    name: "Product", description, persisted: true,
    fields: [ { name, type, list, description, flags: ["id","requerido","único","sensible","generado","calculado","default: draft"] } ],
    relations: [ { name: "catalog", entity: "Catalog", cardinality: "many-to-one" } ],
    lifecycle: { field: "status", transitions: { draft: ["active","retired"], retired: [] } },
    invariants: [ "…" ]
  } ],
  aggregates: [ { name, root, entities: [], description } ],
  types: [ { name: "SKU", kind: "escalar", detail: "string · pattern ^[A-Z0-9]{4,20}$", description } ]
}
```

- `flags` son etiquetas **en español**, derivadas de los atributos del campo (`id`, `required`,
  `unique`, `sensitive`, `generated`, `computed`, `default`). Los nombres de campo, tipo y entidad van
  en inglés tal cual los declara el diseño.
- `persisted` sale de la capa `persistence` (`true` si la entidad aparece ahí); omítelo sin esa capa.
- `types[].kind` es `escalar`, `enum` o `value object`; `detail` resume su forma en una línea
  (constraints, valores del enum, o los campos del value object).

## Reglas transversales

- **Derivado o hueco.** Un dato que no sale del diseño va a `gaps` con una frase que diga qué falta y
  en qué capa; el template lo pinta como aviso arriba del todo. Nunca inventes valores de ejemplo.
- **Español en la UI, inglés en los identificadores.** Todas las etiquetas que introduces (`label`,
  `headline`, `flags`, textos aplanados) van en español; los nombres del DSL se muestran tal cual.
- **Sin secretos.** Ni credenciales, ni URLs de entornos reales, ni hosts: el diseño es agnóstico y el
  panel también.
- **Misma historia.** El panel no puede contradecir a `openapi.yaml`, `asyncapi.yaml`,
  `INTEGRATION.md` ni `DESIGN.md`: todos salen del mismo spec.

## Checklist de cierre

- [ ] `overview.html` no contiene `/*__KEEL_DATA__*/` y su JSON parsea.
- [ ] Las ocho tarjetas están presentes y en orden, con `active` coherente con las capas declaradas.
- [ ] Toda operación de `use-cases` aparece exactamente una vez, con su audiencia y su regla de acceso.
- [ ] Los badges *idempotente* / *cacheada* / nivel de seguridad coinciden con el diseño.
- [ ] §Eventos presente ⇔ hay capa `messaging`; §Clientes HTTP ⇔ hay capa `http-clients`.
- [ ] `openapi.html` (y `asyncapi.html` si aplica) sin placeholders, con el spec inline y el `href` del
      botón de descarga apuntando al `.yaml` correcto.
- [ ] Los enlaces de `links` apuntan solo a archivos que existen en `docs/<service.name>/`.
- [ ] Los tres archivos abren con doble clic (`file://`) sin errores en consola.
