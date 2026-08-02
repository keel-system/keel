# El registry de diseños

Un diseño Keel es reutilizable por construcción: no menciona tecnología, se relaciona por nombre entre capas
y `keel new <nuevo> --from <origen>` lo clona estampando el linaje. El **registry** es lo que hace que esa
reutilización cruce la frontera de tu máquina: un repositorio de diseños publicados que cualquiera puede
hojear, comparar y descargar como punto de partida.

El registry oficial es [keel-system/keel-registry](https://github.com/keel-system/keel-registry).

> **Es un repositorio git, no un servicio.** No hay API ni `keel publish`: se publica por pull request y se
> consume por HTTP sobre los archivos del repo. Eso lo hace forkeable y alojable en cualquier sitio, que es
> justo lo que permite tener un registry privado de empresa con el mismo mecanismo.

## Consumir un diseño

```bash
keel registry                       # todos los diseños, agrupados por familia
keel registry search notifications  # filtra por slug, familia, tags, dominio o prosa
keel registry show catalog          # ficha completa: capas, contenido, enlaces a la documentación
```

Evaluado el diseño, hay **dos formas de traértelo**, y la diferencia no es de comodidad sino de intención:

| | **Adoptar** — `keel registry get catalog` | **Derivar** — `keel new mi-catalogo --from registry:catalog` |
|---|---|---|
| Cuándo | el diseño te sirve **tal cual** | vas a **cambiarlo** |
| `service.name` | el del origen | el que tú elijas |
| `service.version` | la del origen | `0.1.0` |
| `description` | intacta | marcada `TODO: revisar…` |
| `basedOn` | `<slug>@<versión>` | `<slug>@<versión>` |
| `validation-scenarios.md` | del origen, **al día** | heredado, `stale` |
| Derivados de `docs/` | en `docs/<slug>/`, **al día** | **no se traen** |
| Siguiente paso | `keel-<tech> build` | `/keel-design` |

### Adoptar: `keel registry get <diseño>`

Trae el diseño **sin tocarlo**, con sus derivados publicados en `docs/<diseño>/`. Como nacen con la misma
versión que documentan, `keel describe` los ve al día y puedes ir directo a generar: no hay nada que
regenerar. Es lo que quieres cuando un diseño maduro resuelve tu problema, que es el mejor resultado
posible de un registry.

Dos cosas que no se copian, a propósito:

- **El sidecar `design.yaml`** — es metadato de publicación **del origen** (`author`, `license`,
  `maturity`, `family`). Copiarlo haría que tu `README.md` presentara el diseño como publicado por ti.
  Solo lo escribes si decides republicarlo.
- **Nada más.** El manifiesto llega íntegro salvo `service.basedOn`, que se estampa aunque el nombre y la
  versión coincidan con el origen: se lee como «esto *es* `catalog@0.3.0`». Sin ese sello, en cuanto
  cambies algo y `/keel-evolve` suba la versión habrás forkeado sin marca, y no quedará forma mecánica de
  saber de dónde venía.

Si luego necesitas cambiar el diseño adoptado, no es una derivación: es una **evolución** normal, y entra
por `/keel-evolve specs/<diseño>`.

### Derivar: `keel new <nuevo> --from registry:<slug>`

Descarga el diseño a un directorio temporal y sigue exactamente el mismo camino que una derivación local:
copia el manifiesto reescrito y las capas declaradas, estampa `service.basedOn`, marca la `description`
como pendiente de revisar y **renombra el servicio al nombre que tú elijas**. El slug del registry nunca
llega a tu código: `keel new notifications --from registry:notifications-push-only` deja un servicio
llamado `notifications`.

También se clona `validation-scenarios.md`, con la ruta de su cabecera reapuntada al servicio nuevo pero
**conservando el sello de versión del origen**. El manifiesto derivado nace en `0.1.0`, así que
`keel describe` lo reporta `stale` desde el primer momento: es la señal correcta. Los escenarios heredados
son el **punto de partida** —el inventario de obligaciones que ya estaba resuelto—, no el contrato de tu
servicio; se regeneran al cerrar el diseño derivado.

**Los derivados de `docs/` no se traen.** `DESIGN.md`, los contratos formales, el panel e `INTEGRATION.md`
describen al servicio del origen, y derivar significa que vas a completar el diseño: se regeneran de todas
formas al cerrarlo, con `/keel-handoff`, `/keel-docs` y `/keel-integrate`. Si lo que querías era quedártelos,
lo que querías era adoptar. Mientras tanto, la documentación del origen sigue publicada en el registry:
`keel registry show` da sus URLs.

Después, `/keel-design specs/mi-catalogo` arranca en modo derivación y entrevista solo sobre lo que cambia.

### Lo que llega es lo que el índice enumera

En ambos casos, lo que se descarga es lo que el `index.json` del registry lista en `files`, ni más ni menos.
Si el diseño tenía derivados sin generar cuando se indexó, `keel registry get` lo dice (`el registry publica
N de M derivados`) en vez de dejar que los eches de menos: adoptando duele más, porque no ibas a regenerar
nada. El arreglo es del lado del registry —generarlos y reindexar con `keel index`—, no tuyo.

### Red, caché y fuentes alternativas

| Opción | Efecto |
|---|---|
| `--source <url>` | URL del `index.json` a usar |
| `KEEL_REGISTRY_URL` | Lo mismo, por entorno (precedencia: `--source` > variable > oficial) |
| `--refresh` | Ignora el TTL y revalida contra la red |
| `--offline` | Usa solo la copia local, sin red |
| `--force` | Solo en `keel registry get`: reemplaza `specs/<diseño>` si ya existe |

El índice se cachea en `~/.keel/registry/`, una entrada por URL (un registry privado no pisa al oficial),
con `ETag` y un TTL de 24 h. Si la red falla y hay copia local, se usa la copia con un aviso: quedarse sin
índice por un corte de red sería peor que servir uno de ayer. Sin red y sin caché, el error explica el
camino manual (`git clone` + `--from <ruta>`), que funciona siempre.

**El TTL no se aplica al traerse un diseño** —ni `keel registry get` ni `keel new --from registry:`—, que
revalidan siempre (salvo con `--offline`). Hojear el catálogo tolera un índice de ayer; materializar un
diseño, no: uno desactualizado deja el workspace sin los archivos que se publicaron entre medias, y sin nada
que lo delate. La revalidación cuesta un `304` gracias al `ETag`, y la línea de descarga dice de dónde salió
el índice (`red` o `caché`).

Un `index.json` con un `schemaVersion` mayor del que entiende la CLI se rechaza pidiendo actualizar
`keel-core`, en vez de malinterpretarlo.

## Publicar un diseño

Un registry **es un workspace Keel**: `specs/<slug>/` con las capas y `docs/<slug>/` con los derivados, la
misma forma que siembra `keel init`. Por eso `keel validate`, `keel describe` y `keel index` funcionan ahí
sin nada especial.

El listón para publicar (lo comprueba el CI del registry) es:

1. `keel validate specs/<slug>` en verde **sin `--wip`**.
2. `validation-scenarios.md` cerrado — es el contrato de equivalencia que hace verificable cualquier
   servidor generado del diseño.
3. Derivados al día: `keel describe <slug>` sin `stale`, `unstamped` ni `orphan`.
4. `design.yaml` válido contra `schema/design.schema.json`.
5. `service.name` idéntico al nombre del directorio (los derivados viven en `docs/<service.name>/`: si no
   coinciden, dos diseños se pisan; `keel index` lo avisa).
6. Identificadores en inglés, prosa en español. Cero tecnología en el diseño.
7. `keel index` ejecutado y su resultado commiteado.

Ese listón es **por diseño**. Lo que sigue es config **del repo**, se hace una vez y no lo comprueba nadie.

### `publish.yaml`: enlaces navegables desde la portada

El índice enlaza los derivados de cada diseño. Los `.md` (`DESIGN.md`, `INTEGRATION.md`) se enlazan en
relativo y GitHub los renderiza; los `.html` de `/keel-docs` —el panel `overview.html` y los visores
`openapi.html` y `asyncapi.html`— no: un enlace relativo a un `.html` muestra el **código fuente**, o sea
que el panel, que es justo lo que hace revisable un diseño sin leer el spec, queda inalcanzable.

Para resolverlo, la raíz del workspace lleva un `publish.yaml` que dice dónde está publicado:

```yaml
repo: keel-system/keel-registry   # <org>/<repo>, obligatorio
branch: main                      # opcional, por defecto main
```

Con él, `keel index` enruta esos tres enlaces por `htmlpreview.github.io`, que sirve el archivo crudo ya
renderizado. Se eligió frente a GitHub Pages porque **no exige configurar nada en el repo**: un fork de un
registry funciona en cuanto cambia esta línea. El archivo se valida contra `schema/publish.schema.json`;
es **opcional** y uno inválido no tumba el índice (avisa y cae a relativo), porque un workspace privado que
no se publica en ningún sitio no tiene por qué declarar nada.

Es **configuración del workspace, no de un diseño**: por eso vive en la raíz y no en el sidecar, y por eso
no entra en `index.json` — quien descarga un diseño recibe rutas relativas al repo, que es lo que descarga.

### El sidecar `design.yaml`

Los metadatos de publicación van en `specs/<slug>/design.yaml`, **fuera del DSL**: el manifiesto describe el
servicio, no cómo se distribuye. Mantenerlos separados evita que cada campo de catálogo obligue a versionar
el DSL, y hace que la derivación no los arrastre a tu workspace (`keel new --from` copia el manifiesto y las
capas, nada más).

```yaml
family: notifications        # agrupa variantes; por defecto, el propio slug
variant: multichannel        # obligatorio cuando family ≠ slug
summary: >                   # una o dos líneas para el índice
  Notificaciones multicanal con plantillas versionadas y entrega garantizada.
differsIn: >                 # en familias con varias variantes: qué la distingue de sus hermanas
  Añade SMS y push sobre email, con outbox y reintentos por canal.
maturity: reference          # draft | stable | reference
tags: [email, sms, push, outbox, templates]
author: keel-system
license: Apache-2.0
requires: [catalog]          # otros diseños del registry que consume
```

`summary` y `maturity` son obligatorios; el resto es opcional. Sin sidecar, el diseño aparece igualmente en
el índice con su `service.description` como resumen.

**Los tags describen lo que el diseño declara**, no lo que uno querría que declarase: si pones `outbox`, la
capa `messaging` debe declarar `reliability: outbox`.

`requires` es metadato de publicación: dice de qué otros diseños del registry depende este, para que quien lo
descargue sepa qué arrastra. **No es el mapa de un sistema** — si el workspace tiene uno (`system.yaml`, de
`/keel-decompose`), `requires` debe ser coherente con las aristas `consumes` de ese servicio; quien resuelve y
verifica el grafo es `keel system check`, no el registry. Ojo con no confundir los dos ejes: `family` agrupa
**variantes alternativas del mismo problema** y `system.yaml` describe **composición**. Detalle en
[system-decomposition.md](system-decomposition.md).

### Variantes del mismo problema

Varios diseños pueden resolver el mismo dominio de formas distintas, y eso es deseable: quien descarga elige
la que encaja en vez de recortar la más grande. Las variantes son **directorios planos** con slug
`<familia>-<variante>` y la familia declarada en el sidecar:

```
specs/notifications-multichannel/    family: notifications, variant: multichannel
specs/notifications-email-digest/    family: notifications, variant: email-digest
specs/notifications-push-only/       family: notifications, variant: push-only
```

Son planos porque `specs/` y `docs/` lo son en todo workspace Keel. `keel index` las agrupa en una subtabla
comparativa ordenada de más madura a menos, usando `differsIn` como columna de diferencias. Una variante
derivada de otra se crea con `keel new <nueva> --from <origen>`, y su linaje queda auditable en
`service.basedOn`.

## Compatibilidad

La herramienta y un registry son repos separados que evolucionan a su ritmo. Para que eso no signifique
«hasta el primer cambio incompatible», hay tres desajustes posibles y cada uno tiene una respuesta definida.

**Lo primero, porque es la fuente del malentendido más común: lo que valida un diseño es la versión de la
CLI instalada, no la copia de `schema/` del repo.** `keel validate` compila los schemas que viajan **dentro
del paquete `keel-core`**; el `schema/` del workspace es marcador de workspace, documentación y soporte de
editor. Así que un `schema/` desfasado no puede hacer pasar un diseño inválido ni al revés.

| Desajuste | Qué pasa | Qué hacer |
|---|---|---|
| El `index.json` tiene un `schemaVersion` mayor que el que entiende la CLI | `keel registry` lo **rechaza** con un mensaje que lo dice | Actualizar `keel-core` |
| Un diseño declara un `keel:` que la CLI no soporta | **Aviso** al hojear (`[DSL x.y — actualiza keel-core]`), **error** al derivar, antes de descargar nada | Actualizar `keel-core` |
| El payload copiado del workspace quedó atrás | `keel init --check` lo reporta y sale 1. **No afecta a la validación** | `keel init --force` (y recuperar la portada si la tenías personalizada) |

Las versiones de DSL que una CLI entiende son, por definición, el enum de `properties.keel` de
`service.schema.json`: no hay una lista duplicada que pueda desincronizarse. (Un **generador** sí declara su
propia lista —`SUPPORTED_DSL`—, porque la suya es un subconjunto: lo que sabe mapear a código, que
legítimamente puede ir por detrás del DSL.)

### Qué registra el índice

`index.json` lleva un bloque `generatedBy` con la versión de `keel-core` que lo generó y las versiones de DSL
que soportaba, para que un desajuste sea diagnosticable en vez de misterioso. **`keel index --check` lo
ignora al comparar**: si contara, cada release de la CLI dejaría en rojo el CI de todos los registries hasta
que alguien reindexara. La procedencia informa; el contenido de los diseños obliga.

### Cambiar el formato del índice

**Añadir** una clave nueva (por ejemplo, un derivado más en `docs` de cada diseño) es aditivo y **no** sube
la versión: una CLI anterior lee las claves que conoce e ignora el resto. Subirla ahí rompería a quien no
hace falta romper.

Subir `INDEX_SCHEMA_VERSION` es **breaking para los consumidores**: las CLIs anteriores rechazan el índice
nuevo (a propósito, con mensaje claro, en vez de malinterpretarlo). Se reserva para cuando cambia el
significado de algo que ya existía. El orden correcto es:

1. Publicar una versión de `keel-core` que **lea** el formato nuevo.
2. Esperar a que esté disponible para los consumidores.
3. Solo entonces regenerar el índice del registry con ella.

Al revés se rompe a todo el mundo a la vez.

### El CI de un registry va pineado

El workflow de un registry no debe seguir la rama por defecto de la herramienta: si lo hace, un cambio
incompatible allí pone en rojo los pull requests de la comunidad sin que nadie haya tocado un diseño. Se
pinea a una etiqueta, y se añade un segundo workflow programado que corre lo mismo contra `main` **sin
bloquear**: así la incompatibilidad la descubre un job semanal y no un contribuidor. El registry oficial lo
hace en `ci.yml` (pineado, con la variable `KEEL_TOOL_REF` para probar) y `compat.yml` (el canario).

## El índice: `keel index`

```bash
keel index          # regenera la tabla del README (entre marcadores) y index.json
keel index --check  # no escribe; falla si el índice quedó atrás (puerta de CI)
```

El índice es una **proyección pura** de lo que ya saben `keel describe` y el sidecar: identidad, dominio,
capas, recuentos por capa, frescura de los derivados y la lista de archivos que componen cada diseño (eso
último es lo que permite la descarga selectiva sin tarballs). No lleva marcas de tiempo, así que dos
ejecuciones sobre el mismo workspace producen bytes idénticos — que es lo que hace útil `--check`.

Escribe en dos sitios:

- **`README.md`**, solo entre `<!-- keel:servicios:start -->` y `<!-- keel:servicios:end -->`. El resto del
  archivo (introducción, secciones humanas) se preserva. La columna «Documentación» enlaza los derivados
  que existen —diseño, panel, API, eventos, integración—, con los HTML navegables si hay `publish.yaml`.
- **`index.json`**, el índice máquina que consume `keel registry`.

**El índice tiene un único escritor, y es `keel index`.** `/keel-design`, `/keel-handoff` y `/keel-docs` lo
ejecutan; nadie edita la región entre marcadores a mano. Un aviso al indexar (un diseño que no carga, un `service.name` que
no coincide con su directorio, un `design.yaml` inválido) hace que el comando salga con código 1: el índice
se genera, pero algo del workspace está mal.

Esto sirve igual a un workspace privado de una organización que a un registry público: la portada del repo
deja de mentir en cuanto alguien versiona un diseño.
