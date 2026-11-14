# El contrato del cable

Cómo viaja en JSON cada tipo del DSL, y la forma de los cuerpos que el diseño no declara (el error, la
página, la envoltura de eventos). Es contrato observable: lo ve todo consumidor del servicio, y es lo
que hace que dos servidores generados del mismo diseño con generadores distintos (keel-spring,
keel-nest, keel-dotnet) sean intercambiables para quien los llama.

El diseño no lo declara: lo fija el método, igual para cualquier servicio. Lo que sí decide el diseño
está en sus convenciones de determinación (`conventions.nulls`, la escala de cada `decimal`, el valor de
cada enum) y este contrato dice cómo se escribe.

La fuente de verdad son los datos de `keel-core/src/lib/gen/wire.js`: cada caso de esta página es un
caso que los generadores ejecutan contra su serializador.

## Tipos

| Tipo | Sale como | Ejemplo |
|---|---|---|
| `decimal` | número JSON con la escala que lleva, en notación plana | `2.50`, `10`, `0.0000001` (nunca `2.5` ni `1E-7`) |
| `long` | número JSON con todos sus dígitos | `9007199254740993` |
| `int` | número JSON | `42` |
| `boolean` | `true` / `false` | `true` |
| `string`, `text` | cadena UTF-8, sin escapar lo que no es ASCII | `"Ñandú"` |
| `uuid` | cadena canónica en minúsculas | `"0190f3c1-7b2e-7a4d-9c1e-3f5a6b7c8d9e"` |
| `date` | cadena `YYYY-MM-DD` | `"2026-03-14"` |
| `timestamp` | cadena ISO-8601 en UTC con exactamente **tres** decimales y `Z` (se trunca, no se redondea) | `"2026-03-14T09:21:07.482Z"` |
| `json` | **embebido** como valor JSON, no como cadena escapada | `{"a":[1,2]}` |
| enum | el valor que declara el diseño, tal cual | `"in-review"` |

Un `long` por encima de 2^53 no cabe en un `number` de JavaScript: el contrato no lo recorta, y un
consumidor en ese lenguaje tiene que leerlo como entero grande. Si el diseño prevé consumidores que no
pueden, el tipo correcto es un `string` con formato, no un `long`.

## Entrada

- Un `decimal` se lee **exacto**, del texto del número (`2.50` conserva su escala); también desde una
  cadena numérica (`"2.50"`) y en notación exponencial (`1E-7`).
- Un `long` se lee exacto, también desde una cadena numérica.
- Un `timestamp` se lee de una cadena ISO-8601 con zona (`Z` o `±hh:mm`) y se normaliza a UTC; la
  precisión por debajo del milisegundo se descarta.
- Un `json` se acepta embebido o como cadena con el documento ya serializado.
- Se **rechaza** (400) lo que no es de su tipo: un `decimal` que no es un número, un `timestamp` que no
  es ISO-8601, una fecha que no existe (`2026-02-30`).
- Una propiedad desconocida se ignora.

## Nulos

Por defecto un campo sin valor viaja como `null`. Con `conventions.nulls: omit` en el manifiesto, no
viaja en las respuestas ni en los payloads de evento. El cuerpo de error lo incluye **siempre**: su
forma es estable y un consumidor no tiene que distinguir ausente de nulo.

## Listas

Una lista (`list: true`, y también una relación a-muchos proyectada) **nunca viaja como `null`**: sin elementos sale `[]`, también con
`conventions.nulls: omit` —una lista vacía no es un valor ausente—. Y una lista que la entrada no informa se
lee como `[]`: el caso de uso no distingue «no la mandó» de «la mandó vacía». La excepción es la lista
opcional del cuerpo de un `PATCH`, donde ausente significa «no tocar» y `null` o `[]` la vacían.

Lo mismo vale para cualquier opcional del cuerpo de un `PATCH`, con una excepción: si su campo homónimo de la
entidad del grupo es `required` —o es la FK `<relación>Id` de una many-to-one requerida—, el `null` no tiene a
dónde vaciar y es un `400` de validación (`<campo> must not be null`), en los dos generadores y solo cuando el campo
viene. Ausente sigue siendo «no tocar».

## Cuerpos que el diseño no declara

Las claves van en este orden.

**Error** — `timestamp`, `status`, `error`, `code`, `message`, `details`, `correlationId`:

```json
{
  "timestamp": "2026-03-14T09:21:07.482Z",
  "status": 409,
  "error": "Conflict",
  "code": "SKU_ALREADY_EXISTS",
  "message": "Ya existe un producto con ese SKU",
  "details": null,
  "correlationId": "1f7b0a52-33c9-4a1e-9a44-6c0f2b8d55e1"
}
```

**Página** — `items`, `page`, `size`, `totalElements`, `totalPages`. La página vacía es `items: []`,
`totalElements: 0` y `totalPages: 0`, con el `page` y el `size` que se pidieron; vale igual para una página
fuera de rango, aunque el listado tenga elementos en otras.

**Envoltura de un evento** — `metadata` y `data`; la `metadata`, en este orden: `eventId`,
`eventType`, `eventVersion`, `occurredAt`, `source`, `correlationId`, `traceparent` (ver
`docs/dsl/messaging.md § La envoltura Keel`).

**Entrada del historial** (DSL 2.29) — `at`, `author`, `change`, `changes`; cada elemento de `changes`, `field`,
`before`, `after`. Va dentro de la página de arriba, la más reciente primero y, a igual `at`, en un orden estable:

```json
{
  "at": "2026-11-13T10:02:00.000Z",
  "author": "6f1c9a2e-0b7d-4f53-9a51-0c1e9d2a7b44",
  "change": "updated",
  "changes": [
    { "field": "email", "before": "ana@example.com", "after": "ana.r@example.com" }
  ]
}
```

- `at` es la hora a la que se confirmó la escritura, y se guarda con la precisión del cable (milisegundos): el `at` de una
  entrada sirve tal cual de extremo de los filtros `from` y `to`, que incluyen el suyo.
- `change` es `created`, `updated`, `deleted`, `restored` o `anonymized`. `deleted` y `restored` llevan `changes: []`.
- `author` es el actor de la autoría: el `sub` del token, el cliente de la clave de API o `system` (con
  `system:<correlationId>` si hay correlación) cuando la escritura no viene de una petición.
- `field` es la ruta del contrato (`price.amount`, `lines[<id>].quantity`, `categoryId`). `before` y `after` llevan el
  valor con las reglas de § Tipos, y `null` cuando no había o ya no hay. En una entrada `anonymized` los dos son el
  valor anonimizado: el anterior ya no existe en ninguna parte.

## Lotes

Solo en las operaciones con `batch` (DSL 2.30, ver `docs/dsl/use-cases.md § Lotes`). El diseño no declara la forma
de la respuesta: la operación lleva `output: void`, y cada elemento con éxito devuelve lo que diga `batch.output`.

**Resultado del lote** — `summary`, `items`. El `summary`, en este orden: `total`, `succeeded`, `failed`,
`notAttempted`. Cada elemento de `items`, en orden de índice: `index`, `status`, `result`, `error`, `message`.

```json
{
  "summary": { "total": 500, "succeeded": 497, "failed": 3, "notAttempted": 0 },
  "items": [
    { "index": 0, "status": "succeeded", "result": { "productId": "0190f3c1-7b2e-7a4d-9c1e-3f5a6b7c8d9e" }, "error": null, "message": null },
    { "index": 7, "status": "failed", "result": null, "error": "SKU_ALREADY_EXISTS", "message": "Ya existe un producto con ese SKU" }
  ]
}
```

- Con `atomicity: per-item` la respuesta es **siempre `207`**, también si todo salió bien: el status no depende del
  desenlace, y el cliente tiene un solo lector. Con `all-or-nothing` el mismo cuerpo sale con el `successStatus` del
  endpoint, o la respuesta es el error del elemento culpable, con su ruta en `details` (`"items[7]"`), y no queda
  nada confirmado.
- Cada elemento lleva **siempre** sus cinco claves, con `null` donde no aplica: su forma es estable, como la del
  error, y no depende de `conventions.nulls`. `result` es `null` en un elemento que no tuvo éxito y en uno de una
  operación sin `batch.output`.
- `status` es `succeeded`, `failed` o `notAttempted`. Un elemento falla **solo él** con un `code` de `itemErrors` o
  con `VALIDATION_ERROR` (sus cotas, su formato), y el lote sigue. Cualquier otro fallo **detiene** el lote: ese
  elemento sale `failed` con su `code`, o con `BATCH_ABORTED` si no tiene (`framework-errors.md`), lo anterior queda
  confirmado y lo siguiente sale `notAttempted`, que es lo que el cliente tiene que reenviar.
- Son un `400` del lote entero, sin procesar ningún elemento, solo el sobre: el campo que se recorre ausente o con más
  elementos que su `maxItems`.

## Escritura condicional

Solo en las operaciones de `api.concurrency` (ver `docs/dsl/api.md § concurrency`).

- **`ETag`** — la versión de la raíz entre comillas dobles: `"7"`. Es fuerte (nunca `W/`) y opaca: el cliente no la
  interpreta, la devuelve tal cual en `If-Match`. La dan las lecturas de esa raíz y las escrituras listadas que la
  devuelven, ya con la versión que dejó el guardado.
- **`If-Match`** — se compara en fuerte. `*` se cumple si el recurso existe. Una lista (`"5", "7"`) se cumple si
  coincide cualquiera. Un `W/"7"`, un `7` sin comillas, un `"07"` o algo ilegible no coincide con nada y da `412`, no
  `400`. Una cabecera vacía cuenta como ausente: `428` con `conditionalWrites: required`, y sin comparación con
  `optional`.
- El orden de los fallos: `401` → `403` → `428` → `400` → `404` → `412` → `409`. Quien no puede ver el recurso recibe
  su `404` o su `403` antes que el `412`. El `409` (`CONCURRENT_MODIFICATION`) sigue siendo otra cosa: dos escrituras que
  se cruzan dentro del servidor con la versión correcta.
- `ETag` va en las cabeceras expuestas de CORS, o un navegador no la puede leer.
