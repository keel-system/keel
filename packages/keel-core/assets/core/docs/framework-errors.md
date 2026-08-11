# Errores del framework

Los `code` que pone el **generador** cuando el diseño no nombra el conflicto de un mecanismo
que él mismo encendió. Son contrato público: salen por la API, los ven los integradores y los
escenarios pueden afirmar sobre ellos.

## Por qué existe esta lista

El DSL sostiene que **`errors` es el único sitio donde nace un `code` del contrato**, y las
convenciones de los generadores le dicen al agente que nunca invente uno: si falta, es un hueco
del diseño y se reporta.

Pero hay conflictos que no se declaran operación por operación porque **no los provoca la
lógica, los provoca el mecanismo**: dos peticiones con la misma clave de idempotencia, una
escritura sobre una versión que ya cambió, una subida que pasa del tamaño del bucket. El diseño
enciende el mecanismo con un campo (`idempotency`, `optimisticLocking`, `maxSizeMb`) y el
conflicto viene con él. Alguien tiene que ponerle nombre, y hasta que existió esta tabla lo
ponía cada generación por su cuenta: tres corridas completas del pipeline produjeron **tres
contratos públicos distintos para el mismo hecho**, cada una reportándolo como un hueco que
nadie sabía dónde cerrar.

La regla, entonces, es más precisa que «nunca inventes un code»:

- Un error de **negocio** nace en `errors`. Si falta, es un hueco del diseño.
- Un error de **mecanismo** lo pone el framework, con el código de esta tabla. Nunca se
  inventa otro, y nunca hace falta.

## La tabla

| Mecanismo (qué lo enciende) | `code` | HTTP | Sustituible |
|---|---|---|---|
| `use-cases`: constraints de `input` | `VALIDATION_ERROR` | 400 | no |
| `domain`: `entities.<E>.lifecycle` | `INVALID_STATE_TRANSITION` | 409 | sí |
| `persistence`: `naturalKey` / campo `unique` | `<ENTITY>_<CAMPOS>_ALREADY_EXISTS` | 409 | sí |
| `persistence`: `consistency.optimisticLocking` | `CONCURRENT_MODIFICATION` | 409 | sí |
| `use-cases`: `operations.<op>.idempotency` — la carrera | `IDEMPOTENCY_KEY_IN_PROGRESS` | 409 | sí |
| `use-cases`: `operations.<op>.idempotency` — misma clave, otro cuerpo | `IDEMPOTENCY_KEY_REUSED` | 409 | sí |
| `storage`: `buckets.<b>.maxSizeMb` | `FILE_TOO_LARGE` | 413 | sí |
| Entrada multipart (input con campo `type: file`) | `FILE_UNREADABLE` | 400 | no |

Qué significa cada uno:

- **`VALIDATION_ERROR`** — la petición no cumple las cotas declaradas en el `input`. No es
  sustituible porque no es un desenlace del dominio: es la frontera rechazando algo que ni
  siquiera llegó a la operación.
- **`INVALID_STATE_TRANSITION`** — se pide una transición que el `lifecycle` no declara desde el
  estado actual.
- **`<ENTITY>_<CAMPOS>_ALREADY_EXISTS`** — el único que **no** es un código fijo: se deriva de la
  entidad y de los campos de la clave, porque un servicio puede tener varias y un solo código no
  las distinguiría. `ASSET_OWNER_SLUG_ALREADY_EXISTS` es la forma.
- **`CONCURRENT_MODIFICATION`** — dos escrituras concurrentes sobre la misma raíz; la segunda va
  contra una versión que ya cambió. Nombra el hecho, no la técnica: que se detecte por número de
  versión es un detalle de implementación que no tiene por qué salir al contrato.
- **`IDEMPOTENCY_KEY_IN_PROGRESS`** — dos peticiones con la misma clave **a la vez**. La que
  pierde no tiene todavía una respuesta que reproducir, porque la ganadora no ha commiteado; su
  transacción revierte entera, así que de las dos se ejecutó exactamente una. No confundir con el
  reintento normal, que **no** es un error: ese reproduce la respuesta de la primera.
- **`IDEMPOTENCY_KEY_REUSED`** — la misma clave con un contenido **distinto**. Reproducir la
  respuesta de la primera contestaría a una pregunta que el cliente no hizo, y ejecutar la
  segunda rompería la promesa de la clave. La única salida honesta es rechazarla.
- **`FILE_TOO_LARGE`** — la subida supera el `maxSizeMb` del bucket.
- **`FILE_UNREADABLE`** — la parte binaria llega vacía o el cuerpo multipart está roto.

## Sustituir uno por el del dominio

No hay sintaxis nueva: se declara el error en la operación, como cualquier otro, con un `code`
de la **familia** del canónico y su mismo status.

```yaml
# use-cases.keel.yaml
publishAsset:
  errors:
    - code: ASSET_VERSION_CONFLICT      # familia de concurrencia
      when: Otra operación modificó el archivo mientras se publicaba.
      http: 409
```

El generador lo detecta y usa **ese** código en vez del canónico. Las familias admitidas son:

| Canónico | Familia (sufijos admitidos) |
|---|---|
| `CONCURRENT_MODIFICATION` | `CONCURRENT_MODIFICATION`, `CONCURRENT_UPDATE`, `OPTIMISTIC_LOCK_CONFLICT`, `OPTIMISTIC_LOCKING_FAILURE`, `VERSION_CONFLICT` |
| `IDEMPOTENCY_KEY_IN_PROGRESS` | `KEY_IN_PROGRESS`, `IDEMPOTENCY_IN_PROGRESS`, `REQUEST_IN_PROGRESS` |
| `IDEMPOTENCY_KEY_REUSED` | `KEY_REUSED`, `KEY_MISMATCH`, `KEY_SIGNATURE_MISMATCH`, `KEY_CONFLICT` |
| `INVALID_STATE_TRANSITION` | `INVALID_STATE_TRANSITION`, `INVALID_STATE`, `INVALID_TRANSITION`, `ILLEGAL_STATE_TRANSITION` |
| `FILE_TOO_LARGE` | `FILE_TOO_LARGE`, `PAYLOAD_TOO_LARGE`, `UPLOAD_TOO_LARGE` |
| `<ENTITY>_<CAMPOS>_ALREADY_EXISTS` | cualquier `code` que acabe en `<CAMPOS>_ALREADY_EXISTS` |

Con el prefijo que quieras: lo que se compara es el sufijo, así que `ASSET_VERSION_CONFLICT`
entra en la familia de concurrencia.

**Se exige exactamente un candidato.** Con cero, el diseño no lo dijo y manda el canónico; con
dos, dijo algo ambiguo y elegir uno sería adivinar — también manda el canónico. Eso es lo que
hace que el contrato exista siempre, diga lo que diga el diseño.

## Qué avisa `keel validate`

Cuando un mecanismo con conflicto observable está encendido y ninguna operación declara su
error, `keel validate` lo **avisa** y nombra el código canónico que se usará. No es un error: el
canónico es una respuesta legítima. Es que el diseñador se entere de que ese contrato existe sin
tener que leer el código generado.

## Para quien escribe un generador

Los códigos salen de `FRAMEWORK_ERRORS`, en la API pública de `keel-core`; no se escriben a mano
en cada generador. `overrideFor(...)` resuelve la sustitución con la semántica de arriba.

Y una obligación que va con ellos: **estos códigos son parte del contrato publicado**. Aparecen
en el OpenAPI de las operaciones que encienden su mecanismo aunque el diseño no los declare —si
no, el cliente no puede programar contra un error que va a recibir.

## Y lo que sigue siendo un hueco de diseño

Todo lo demás. Si al implementar aparece un desenlace observable que no está en esta tabla ni en
los `errors` de la operación, **no se inventa un `code`**: se reporta como `designGap`. Esta
lista existe para que el conjunto de excepciones sea cerrado y conocido, no para abrir la puerta
a ampliarlo sobre la marcha.
