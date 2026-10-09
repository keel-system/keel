# El contrato del cable

Cómo viaja en JSON cada tipo del DSL, y la forma de los cuerpos que el diseño no declara (el error, la
página, la envoltura de eventos). Es contrato observable: lo ve todo consumidor del servicio, y es lo
que hace que dos servidores generados del mismo diseño con generadores distintos (keel-spring,
keel-nest) sean intercambiables para quien los llama.

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

**Página** — `items`, `page`, `size`, `totalElements`, `totalPages`.

**Envoltura de un evento** — `metadata` y `data`; la `metadata`, en este orden: `eventId`,
`eventType`, `eventVersion`, `occurredAt`, `source`, `correlationId`, `traceparent` (ver
`docs/dsl/messaging.md § La envoltura Keel`).
