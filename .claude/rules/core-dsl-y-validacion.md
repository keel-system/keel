---
paths:
  - "packages/keel-core/src/**"
  - "packages/keel-core/assets/**"
  - "packages/keel-spring/assets/**"
  - "packages/keel-spring/test/design-generation-delta.test.js"
---

# DSL, validación y payload de keel-core

Detalle movido desde `CLAUDE.md` para que solo cargue al trabajar sobre estos archivos.
El índice de una línea por caso sigue en `CLAUDE.md` § Dónde se añade cada cosa.

## Nuevo comando CLI

`keel-core/src/cli.js` + nuevo archivo en `src/commands/` (lógica pura en `src/lib/`, el comando solo consola y escritura)

## Cambio en el índice de diseños

`keel-core/src/lib/design-index.js` + test en `test/design-index.test.js`. El índice debe seguir siendo determinista (sin timestamps): `keel index --check` depende de ello

## Cambio en el mapa de sistema

`keel-core/src/lib/system-map.js` + `assets/core/schema/system.schema.json` + test en `test/system-map.test.js`. El plan debe seguir siendo determinista y puro (sin consola ni escrituras): `keel system check` es puerta de CI. Si el cambio afecta a lo que la skill escribe, toca también `assets/skills/keel-decompose/` y `assets/core/docs/system-decomposition.md`

## Nuevo harness de agente

`keel-core/src/lib/harness.js`: una entrada más en `HARNESSES` (rutas destino, render de frontmatter, tabla de tokens) + casos en `test/harness.test.js`. No debería hacer falta tocar ningún asset ni ningún generador: si hace falta, es que algo cita una ruta literal en vez de un token. **Dos reglas que costaron una corrección cada una**: (a) ningún harness emite un stub de comando homónimo de una skill — los dos registran ya la skill como `/<nombre>`, y en opencode un comando de config se registra ANTES que las skills (cuyo paso lleva la guarda `if (commands[item.name]) continue`), así que el stub ECLIPSABA a la skill y `/keel-design` disparaba una indirección; (b) si el harness concede herramientas por MEZCLA con sus defaults (opencode) en vez de por lista completa (Claude Code), lo no concedido hay que DENEGARLO explícitamente, y esa lista se deriva del vocabulario neutral (`CLAUDE_TOOL`) más las herramientas propias del harness — mientras se mantuvo a mano se quedó sin `bash`

## Nueva regla de validación cross-servicio

`keel-core/src/lib/system-map.js` (`buildSystemPlan`, o `checkSpecDrift` si compara un diseño con el mapa) — **nunca** `crossrefs.js`, que es intra-servicio por definición y solo recibe las capas de un diseño. Documentar la regla en `assets/core/docs/system-decomposition.md § keel system check`

## Cambio en el acceso al registry

`keel-core/src/lib/registry-source.js` + test en `test/registry.test.js`. Todo lo de red entra por parámetro (`fetchImpl`, `now`, `cacheDir`): los tests no tocan red ni el HOME

## Nueva versión del DSL

**Se soporta una sola versión**: se *sustituye* el valor del enum de `properties.keel` en `assets/core/schema/service.schema.json`, no se añade — los schemas no gatean primitivos por versión, así que aceptar las anteriores haría que el campo `keel` declarase una intención que nada comprueba (razonado en `assets/core/docs/dsl-reference.md § Historial de versiones`). **No hay constante duplicada**: `supportedDsl()` (`src/lib/assets.js`) la deriva de ahí y `test/supported-dsl.test.js` lo verifica. Después, `SUPPORTED_DSL` de cada generador, la plantilla `templates/service/service.keel.yaml` y las fixtures de los generadores (`test/fixtures/*/service.keel.yaml`, que `keel-spring/test/fixtures.test.js` obliga a validar). En los tests, la versión se **deriva** de `supportedDsl()[0]`, nunca se escribe a mano

## Cambio del formato de `index.json`

**Añadir** una clave es aditivo y **no** sube `INDEX_SCHEMA_VERSION`: una CLI anterior lee lo que conoce e ignora el resto, y `registry-source.js` solo rechaza un `schemaVersion` **mayor** del suyo (subirlo rompería a quien no hace falta romper). Subirlo (`src/lib/design-index.js`) se reserva a cambiar el significado de algo existente, y entonces es **breaking**: primero se publica una CLI que lea el formato nuevo, y solo después regeneran los registries. Ver `assets/core/docs/design-registry.md § Compatibilidad`

## Nuevo archivo dentro del directorio de un servicio (`specs/<servicio>/`)

Fila en `SPEC_SIDE_FILES` (`keel-core/src/lib/spec-files.js`), diciendo si viaja al **publicar** (entra en el `files[]` del índice, que es lo que descarga `keel registry get`) y si viaja al **derivar** (`keel new --from`) + test en `test/spec-files.test.js`. Esa tabla es fuente única a propósito: mientras `design-index.js` y `new.js` enumeraban los artefactos cada uno por su cuenta, `decisions.yaml` se quedó fuera de los dos transportes de forma independiente, y un diseño que aceptaba obligaciones por escrito llegaba al consumidor con esas decisiones otra vez abiertas — su `keel-<tech> build` lo rechazaba por preguntas ya contestadas. Un literal con el nombre del archivo fuera de ese módulo lo caza el test

## Nueva capacidad del DSL (una propiedad **opcional** nueva en un schema de capa)

El schema, su emisor… y una **fixture que la declare**: `keel-spring/test/capability-coverage.test.js` cruza las propiedades opcionales de los schemas contra lo que declaran las fixtures, y lo que no aparece en ninguna necesita fila en `EXCEPCIONES` con su motivo. No es burocracia: `mail.delivery.attachments` fueron siete sitios del generador con cero tests y cero fixtures, y `authentication.scoping` veintitrés con tests de cadenas y ninguna fixture — su Java no lo había compilado nadie, porque `java-syntax.test.js` y `compile-check` iteran el directorio de fixtures. Una capacidad nueva no está terminada hasta que una fixture la usa; el código nace correcto y envejece sin que nadie lo mire

## Nuevo archivo del payload que el workspace pueda editar

`CUSTOMIZABLE_PAYLOAD` (`src/lib/assets.js`), o `keel init --check` lo reportará como deriva

## Cambio en lo que un `input` HEREDA del dominio

`keel-core/src/lib/crossrefs.js` (`constraintsOf`/`checkInputConstraints`) + `assets/core/docs/dsl/use-cases.md` + tests en las dos direcciones en `test/crossrefs.test.js`. `input: { entity: X }` hereda las `constraints` de la entidad; `input: { fields: … }` **no**, y eso no se arregla heredando por nombre —sería inventar un enlace que el diseño no declara: el input y el almacén son contratos distintos—. Lo que no se sostiene es que la diferencia sea **invisible**: sin la cota en el input no hay `@Size` que emitir, así que la violación no se descubre como 400 en el borde sino como conflicto de integridad al escribir, con un `code` que no es el del diseño. Es **aviso** y no obligación porque se cierra actuando, no aceptándolo por escrito. La cota cuenta venga de `constraints` o del **value type** del campo: perder esa mitad hace que declararla una sola vez en el tipo dispare el aviso. Y ojo con las fixtures — declararlas en `notification-mailer` hizo que `requestNotification` ganara una entrada listada de `EmailAddress` que el caso negativo de `test/batch-finder.test.js` daba por inexistente

## Nueva comprobación sobre `validation-scenarios.md`

`keel-core/src/lib/scenario-blocks.js` (el troceado y `parseCoverageMatrix` son **fuente única**: también los usa `design-delta.js`) + la regla en `crossrefs.js` con su `CHK-SCEN-*` + `docs/validation-scenarios.md § Lo que se comprueba solo`. **Todas son AVISO, sin excepción**: el sujeto es un documento en prosa, así que no encontrar una señal nunca demuestra que no esté. La matriz de cobertura es markdown estructurado y tienta a subirla a error; no se hace, porque un documento con otro formato dejaría de poder generarse por una tabla. Y ojo con el ESCAPE de una expresión regular dentro de un template literal: un límite de palabra escrito con UNA sola barra es el carácter BACKSPACE, la expresión no casa nunca y el aviso sale sobre TODO — pasó con el estado del lifecycle y lo caza el caso negativo de su test

## Nueva regla de validación mecánica

`keel-core/src/lib/crossrefs.js` **con su id** —`error(id, msg)` / `warn(id, msg)`, nunca `errors.push` a secas— + su entrada en `src/lib/checks.js` + test en `test/crossrefs.test.js`. El id no es burocracia: es lo que permite que `/keel-validate` CITE la regla en vez de repetirla en prosa (así divergieron catorce, entre ellas el `circuitBreaker` sin `fallback`, que el agente volvía a juzgar en cada validación) y lo que permitirá afirmar «esta mutación dispara ESTE hallazgo y solo este» sin depender de la redacción en español. Las 214 heredadas sin id migran por oportunidad y `test/checks-ratchet` —dentro de `test/checks.test.js`— impide que ese número suba; si migras alguna, **baja el número**. La severidad la decide el catálogo y `record` lanza si el sitio de emisión no coincide: con dos fuentes, la que se inventaría y la que bloquea acaban diciendo cosas distintas. Y la prosa de la skill no puede volver a decir «keel validate ya avisa de X»: lo prohíbe `test/keel-validate-skill.test.js`. Si lo que detecta no es una incoherencia sino una **decisión que el diseño no tomó**, no es un aviso: es una obligación — ver la fila siguiente

## Un hueco que aparece en una CORRIDA

Es la regla de `design-gaps.yaml` ejecutándose: un `designGap` que los agentes tuvieron que decidir por su cuenta es candidato a id. Se clasifica con las cuatro preguntas de `checks.js` — si el DSL tiene dónde declararlo es `CHK-*`; si el diseño simplemente NO LO DECIDIÓ y no hay default seguro es `OBL-*` (y entonces se cierra en el YAML o se acepta en `decisions.yaml`); si hay que leer prosa, `REV-*`. La **primera corrida** (stock-reservation, 17/17, 2026-09-20) dio diez huecos y de ahí salieron dos: `OBL-IDEM-KEY-REQUIRED` —con `keySource: client-key` la clave viaja en una cabecera OPCIONAL, y sin `code` que la exija la operación se ejecuta SIN deduplicar, sin que nada falle ni ningún escenario lo note— y `CHK-DEPS-CLOCK-NOT-OBSERVABLE` —la marca de la que depende un `reconciledBy` en el `output.exclude` de todas las operaciones: ningún escenario de caja negra puede afirmar que se estampó, y estamparla mal es «el fallo que pasa las pruebas y no se acaba nunca en producción» que el propio schema describe—. Lección transferible: **los huecos de diseño salen en la FASE 1**, cuando alguien tiene que escribir código o pruebas contra el contrato; el pase de calidad no encontró ninguno

## Una convención de determinación que cambia el código (DSL 2.14: `conventions.nulls`, `constraints.scalePolicy`, `compare`/`match`)

El schema (`service`/`common.schema.json`) + su coherencia y `OBL-DECIMAL-SCALE-POLICY` en `crossrefs.js` + el detector `CHK-SCEN-CONVENTION-UNBACKED` (lee § Convenciones de determinación de `validation-scenarios.md`) + su traducción en keel-spring (`dtos.js`/`messaging.js` `nullInclusion`, `type-mapper.js` `@Digits`, `services.js` `scaleRounding`, `value-types.js`, y la sombra plegada: `persistence-members.js` `foldedShadow` + `text-fold.js` en las DOS ramas, fila `folded-text` de `engine-support.js`) + `keel-spring/test/catalog-run.test.js`. **La lección de la corrida `catalog` (2026-09-21)**: el informe de cierre contó cuatro huecos; el diff de una regeneración limpia contra el árbol final contó 85 archivos de build reescritos, casi todos por convenciones que el diseño ya había decidido en PROSA. Ningún agente las reporta como hueco porque para él son instrucciones: se ven comparando, nunca leyendo el informe. Y el snapshot `specs/` va sellado (`specs.sha256`, `src/lib/specs-seal.js`): `score-scenarios.sh` sale con 2 si alguien lo editó, porque esa corrida corrigió el diseño desde el proyecto generado con la prohibición escrita en la skill

## Cambio en el careo de flujos o en la coherencia de los derivados

Careo: el subagente `keel-core/assets/agents/keel-flow-review.md` (proyectado por `keel init` desde `assets/agents/`, vía `harnessFiles()` de `src/commands/init.js`, que es también lo que usa `payload-drift.test.js`) + su procedimiento `assets/skills/keel-design/references/flow-walkthrough.md` (paso 5b de `/keel-design`) + `src/lib/flow-review.js` y `flow-review.schema.json` (sello = sha256 de los escenarios sin `
`) + `CHK-SCEN-FLOW-REVIEW-STALE` en `validate-service.js` + `test/flow-review.test.js`. El agente NO corrige: propone, y decide el diseñador en `resolution`. **Y no puede haber validación infinita**: el sello es por FLUJO (`flowDigests`), así que recarear cuesta solo lo que cambió —un hallazgo cerrado con `resolution: design` sí fuerza pasada completa: lo careado salía de un diseño que ya no existe—, y hay presupuesto (`MAX_PASSES = 3` por versión, campo `passes`). Agotado, lo abierto se DECIDE y el aviso cambia de id (`CHK-SCEN-FLOW-REVIEW-EXHAUSTED` dice «no lances otra pasada»). Sin tope el bucle no converge: medido, una segunda pasada sobre un diseño ya corregido devolvió 24 hallazgos NUEVOS, y un gate que no termina se aprende a ignorar. Subir la versión devuelve presupuesto, que es la caducidad de `review.yaml`. Derivados: `src/lib/derived-coherence.js` (`CHK-DOCS-OPENAPI/ASYNCAPI/POSTMAN-DRIFT`, contenido y no versión — la frescura sigue en `derivatives.js`) + `test/derived-coherence.test.js`, con un derivado saboteado por id. Solo lo estructural: prosa y ejemplos quedan fuera, y `auth-collection.json` también (la edita el equipo). Su primera pasada sobre el catalog del registry encontró 18 requests de Postman con el status de otro paso del flujo

## Un aviso NUEVO del generador sobre el diseño

Fila en `FAMILIAS` de `keel-spring/test/design-generation-delta.test.js`, y la fila **obliga a decidir**: o `anticipa: '<CHK-ID>'` —y entonces la comprobación tiene que existir en `keel-core`, porque el test exige que la validación la emita en toda fixture donde el generador avise— o `soloGenerador` con el motivo escrito. Existe porque un diseño puede pasar `keel validate` en verde y hacer que el generador avise seis veces al traducirlo: la primera medición dio **15 avisos sobre las 11 fixtures, y 12 se decidían mirando solo el YAML**. El caso que lo resume es el `POST` sin `successStatus` —seis de once fixtures, con el generador eligiendo 201 o 200 según cómo empezara el nombre de la operación, o sea CONTRATO PÚBLICO decidido por una heurística—, y lo que lo delataba era una asimetría: el aviso del `DELETE` sin `successStatus` llevaba años en `crossrefs.js` y el del POST no existía. **Los avisos de `supported-features.js` se clasifican por ORIGEN y no uno a uno**: son la frontera declarada de ESE generador y por construcción el diseño no puede anticiparlos —keel-core no sabe que Spring existe—, así que clasificarlos de uno en uno daría a entender que alguno podría subir

## Un `designGap` que vuelve de una corrida

El cierre del pipeline lo escribe en `design-gaps.yaml` del proyecto generado (`assets/core/schema/design-gaps.schema.json`, sellado con la `version` del snapshot); `keel-spring check` lo imprime **desde el workspace**, que es donde se corrige el diseño, y `/keel-evolve` lo recoge en su inventario para cerrarlo contra el DSL, `decisions.yaml` o `review.yaml`. Y la regla que rompe el ciclo: **un `designGap` que aparece en DOS corridas distintas es candidato obligatorio a id** — a `CHK-*` si pasa las cuatro preguntas de `checks.js`, a `REV-*` u `OBL-*` si no. No es doctrina nueva: es exactamente el origen documentado de `obligations.js` («el mismo hueco reportado como `designGap` cuatro corridas seguidas») y de tres versiones del DSL. El mecanismo ya funcionó a mano dos veces; esto solo lo convierte en procedimiento. **Y para poder compararlas, el `design-gaps.yaml` se copia a `docs/corridas/<fecha>-<servicio>.md` ANTES de tirar el proyecto generado**, con la matriz y la clasificación provisional de cada hueco: los diez de la primera corrida estuvieron perdidos —el proyecto se borró con ellos dentro y no quedaba copia en ninguna parte— y se recuperaron del transcript de la sesión, a un `/clear` de desaparecer. Comparar dos corridas es el único instrumento que distingue el hueco de UN diseño del hueco del MÉTODO, y sin registro no hay segunda medición que valga

## Nueva comprobación de REVISIÓN (lo que solo un lector puede juzgar)

Fila en `keel-core/src/lib/reviews.js` con su `appliesTo(layers)` + su sección en `assets/skills/keel-validate/references/review-checklist.md` + test en `test/reviews.test.js`. La **aplicabilidad la decide la máquina** y el veredicto el lector: eso es lo que hace exigible la cobertura, porque si «no aplica» lo dijera el lector sería la salida barata de cualquier id incómodo (por eso `review.yaml` no tiene veredicto `n/a`: quien cree que no aplica escribe `accepted` con su motivo). La frontera con `checks.js` es comprobable y hay un test que la ejerce: **para un id de revisión tiene que existir un diseño que lo viole y sobre el que `keel validate` salga en VERDE** — si sale en rojo, esa pregunta era mecanizable y su sitio es `crossrefs.js`. Y `review.yaml` caduca ENTERO con el minor, no id a id: se hizo leyendo un diseño, y un cambio en una capa puede invalidar la lectura de otra

## Nueva obligación de diseño

Fila en `keel-core/src/lib/obligations.js` + fila en la tabla de `assets/core/docs/design-obligations.md` (un test ata las dos) + el emisor, que para `kind: decision` es `crossrefs.js` con el helper `obligation(id, scope, mensaje)` — **nunca** un `warnings.push`, porque un aviso no se puede cerrar ni aceptar por escrito, y eso es justo lo que hacía que el mismo hueco se reportara como `designGap` cuatro corridas seguidas. La frontera con la que decidir dónde va: si la respuesta cambia según el **stack elegido**, no es una obligación del diseño y se queda en el generador (`supported-features.js`); si es derivable del diseño solo, va aquí, porque en `build` ya es tarde. Un `kind: review` no tiene emisor mecánico a propósito: su fila existe para que `/keel-validate` la recorra y dé veredicto por id. Y `waivable: false` para lo que no admite «aceptado» —donde no hay default seguro, aceptar es dejárselo al generador—

## Nuevo `code` que emita el generador sin que el diseño lo declare

`keel-core/src/lib/framework-errors.js` + la tabla de `assets/core/docs/framework-errors.md` (un test ata las dos) + el emisor, que lo toma del catálogo vía `declaredErrorFor`/`effectiveErrorCode` de `keel-spring/src/lib/declared-errors.js` — **nunca** un literal en el scaffolding. La lista es cerrada a propósito: lo que no está en ella y tampoco en `errors[]` del diseño es `designGap`, no un código nuevo. Si el conflicto es sustituible, la entrada necesita `family`, y el aviso de `crossrefs.js` que lo anuncia va con ella

## Nueva capa del DSL

`LAYERS` en `src/lib/assets.js` + `assets/core/schema/<capa>.schema.json` + `assets/core/templates/service/<capa>.keel.yaml` + `assets/core/docs/dsl/<capa>.md` + reglas en `crossrefs.js`

## Nuevo generador

Paquete `packages/keel-<tech>/` calcado de `keel-spring`; guía en `keel-core/assets/core/docs/building-a-generator.md`; registrar en `KNOWN_GENERATORS` (`src/lib/assets.js`)

## Cambio de versión del DSL en un generador

Sincronizar `SUPPORTED_DSL` (`src/lib/assets.js` del generador) + campo `keel.dsl` de su `package.json` + su README
