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

keel new mi-catalogo --from registry:catalog
```

`--from registry:<slug>` descarga los artefactos del diseño a un directorio temporal y sigue exactamente el
mismo camino que una derivación local: copia el manifiesto reescrito y las capas declaradas, estampa
`service.basedOn: <slug>@<versión>`, marca la `description` como pendiente de revisar y **renombra el
servicio al nombre que tú elijas**. El slug del registry nunca llega a tu código: `keel new notifications
--from registry:notifications-push-only` deja un servicio llamado `notifications`.

Después, `/keel-design specs/mi-catalogo` arranca en modo derivación y entrevista solo sobre lo que cambia.

Junto al spec se descarga la **documentación del origen** —`DESIGN.md`, los contratos formales, el panel,
las colecciones Postman y su `validation-scenarios.md`— en `docs/<nuevo>/origin/`, con un `README.md` que
deja constancia de la procedencia. Es lo que explica **por qué** el diseño del que partes es como es:
sin ella, derivar es copiar artefactos a ciegas.

Va en la subcarpeta `origin/` y no en `docs/<nuevo>/` a propósito: esos documentos llevan estampada la
versión del **origen** y hablan del servicio del origen, así que como derivados propios estarían `stale`
desde el primer día. `keel describe` y `keel index` inventarían por lista explícita de rutas, de modo que
`origin/` les es invisible: es material de referencia congelado, no se regenera y se borra cuando ya no
aporta. Los derivados **propios** de tu servicio salen de `/keel-handoff` y `/keel-docs`.

Con `--no-docs` se descarga solo el spec. Y para **evaluar** un diseño antes de descargar nada,
`keel registry show` da las URLs de los derivados publicados.

### Red, caché y fuentes alternativas

| Opción | Efecto |
|---|---|
| `--source <url>` | URL del `index.json` a usar |
| `KEEL_REGISTRY_URL` | Lo mismo, por entorno (precedencia: `--source` > variable > oficial) |
| `--refresh` | Ignora el TTL y revalida contra la red |
| `--offline` | Usa solo la copia local, sin red |
| `--no-docs` | Solo en `keel new`: descarga el spec sin la documentación del origen |

El índice se cachea en `~/.keel/registry/`, una entrada por URL (un registry privado no pisa al oficial),
con `ETag` y un TTL de 24 h. Si la red falla y hay copia local, se usa la copia con un aviso: quedarse sin
índice por un corte de red sería peor que servir uno de ayer. Sin red y sin caché, el error explica el
camino manual (`git clone` + `--from <ruta>`), que funciona siempre.

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

Subir `INDEX_SCHEMA_VERSION` es **breaking para los consumidores**: las CLIs anteriores rechazan el índice
nuevo (a propósito, con mensaje claro, en vez de malinterpretarlo). El orden correcto es:

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
  archivo (introducción, secciones humanas) se preserva.
- **`index.json`**, el índice máquina que consume `keel registry`.

**El índice tiene un único escritor, y es `keel index`.** `/keel-design` y `/keel-handoff` lo ejecutan; nadie
edita la región entre marcadores a mano. Un aviso al indexar (un diseño que no carga, un `service.name` que
no coincide con su directorio, un `design.yaml` inválido) hace que el comando salga con código 1: el índice
se genera, pero algo del workspace está mal.

Esto sirve igual a un workspace privado de una organización que a un registry público: la portada del repo
deja de mentir en cuanto alguien versiona un diseño.
