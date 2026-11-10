# keel-go

Generador Go para diseños Keel, construido por incrementos medidos (`PLAN-KEEL-GO.md` en la raíz del repo). Su
objetivo es el de los otros tres generadores: **el mismo diseño genera con keel-spring,
keel-nest, keel-dotnet o keel-go servidores equivalentes** — mismo contrato HTTP, mismo cable, mismos eventos,
mismas tablas, misma operación. Y uno más, propio: el código emitido **se lee como Go idiomático**, no como Java
traducido.

```bash
npm i -g @keel-system/keel-go   # comando `keel-go`

keel-go check specs/<servicio>   # opcional: no escribe nada, dice si el diseño es generable
keel-go build specs/<servicio>   # desde el workspace de diseño; el diseñador elige el stack a mano
cd services/<servicio>-go
go mod tidy                      # la primera vez: resuelve las dependencias indirectas y escribe go.sum
/keel-generate-go                # dentro del proyecto, SIN argumentos
```

`build` se niega sobre un diseño no listo (`keel validate --ready` en rojo) salvo `--accept-unready`, que queda
estampado en `keel-generated.json`, y no escribe nada en el workspace de diseño.

## El contrato

1. **Entrada**: el diseño multi-artefacto de `specs/<servicio>/`, validado y listo.
2. **Compatibilidad**: DSL `2.27`, la misma que los otros tres. Ante otra, se detiene.
3. **Salida**: `services/<servicio>-go/`, un módulo Go (`go 1.27.0`, `toolchain go1.27.3`) sin cgo, con la
   configuración por perfiles en `config/` —el mismo formato y las mismas variables que los otros tres, embebida en
   el binario—, sus sondas `/livez` y `/readyz`, la prueba de su frontera hexagonal, el snapshot sellado del
   diseño en `specs/` y lo que el agente necesita para completarlo.
4. **Regla de oro**: el generador nunca inventa ni corrige funcionalidad; lo que no sabe mapear lo rechaza o lo
   avisa en código (`src/lib/supported-features.js`), nunca lo ignora.

## La frontera

Toda fixture del repositorio se genera entera: las once capas, PostgreSQL, MySQL y MongoDB, RabbitMQ, Kafka y SNS/SQS, Keycloak y Cognito, Stripe y MercadoPago, y la telemetría.

**Lo que se rechaza es una decisión, no un pendiente.** keel-go rechaza más que keel-dotnet, y en esos casos el mismo diseño no se genera en Go: es una excepción escrita a la regla de equivalencia. Ningún diseño del repositorio lo necesita, así que cada rechazo **se abre cuando un diseño real lo pida**; hasta entonces, el mensaje dice con qué otro generador sale. Cada fila nombra la comprobación de `src/lib/supported-features.js`, y `test/supported-features.test.js` exige que toda comprobación tenga la suya. El coste de abrir es una estimación, sin medir.

| Se rechaza | Comprobación | Motivo | Para abrirlo | Red |
|---|---|---|---|---|
| MariaDB, SQL Server y Oracle | `checkSupportedStack` | Ninguna red del repositorio los ha medido, tampoco en keel-nest ni en keel-dotnet | Medio por motor: dialecto en `relational-engine.js` y celdas de la matriz | `db-check`, `harness-check` |
| Clave de API (`protocol: api-key`) | `securityErrors` | Ninguna fixture la declara, y ninguna red mediría lo emitido | Medio: una rama del middleware de `internal/platform/security` | `security-check` |
| Identidad del llamante en un campo que no es texto | `securityErrors` | Sale de un claim, que es texto; los otros tres lo pasan tal cual, y en Go el mensaje es tipado y no compilaría. Se cierra declarando el campo `string` | Bajo, si se decide convertirlo: conversión en el borde | `security-check` |
| Mensajería sin persistencia | `messagingErrors` | Sin adaptador de repositorio nadie publica los eventos. Lo rechazan los cuatro generadores | No se abre: no es una diferencia con los otros tres | — |
| Escritura condicional (`api.concurrency`, DSL 2.25) combinada con `idempotency.keySource: client-key` en la misma operación | `conditionalWritesFrontierErrors` | La respuesta repetida por `Idempotency-Key` tendría que llevar el mismo `ETag`, y ningún diseño lo pide: lo rechazan los cuatro generadores con el mismo mensaje (T3 del plan). La escritura condicional en sí se genera entera | Medio: la versión en el registro de idempotencia | `db-check`, `go-check` |
| Relación interna a-uno sin vuelta, many-to-many interna, y value object persistido con otro dentro o con un opcional | `unmeasuredShapes` | Un adaptador con la cabecera de código generado no admite el TODO que deja keel-dotnet, y ninguna fixture declara estas formas | Alto: el mapeo de cada forma, en el esquema y en los adaptadores | `db-check` |
| Autoría declarada en un campo opcional o que no es texto | `authorshipErrors` | El dominio de Go la guarda como `string`, y vacío es ausente | Bajo: otro tipo en la estampa | `db-check` |
| Operación por reloj cuyo mensaje lleva campos | `scheduledWithArguments` | El reloj la despacha sin argumentos, y la tarea es código generado, sin TODO posible | Medio: mover la tarea a un archivo del agente | `go-check` |
| Plazo de negocio (`lifecycle.deadlines`, DSL 2.26) sobre una entidad que no es una raíz persistida con uuid por id, o cuya operación `by` lleva en su mensaje algo más que el id | `deadlineErrors` | El handler del plazo lleva la cabecera de código generado y no admite el TODO que keel-spring deja para construir ese mensaje; ninguna fixture lo declara. El plazo en sí se genera entero (incremento 6 de PLAN-DSL-226-PLAZOS.md); el motor sin sentencias medidas y el `code` tardío con varios status los rechaza `build` (`timerStackErrors`), como keel-spring | Medio: el despacho del plazo en un archivo del agente | `db-check`, `doc-check` |
| Identidad opcional (`level: optional`, DSL 2.27) sobre una identidad que no es un token (oidc o jwt) | `optionalAuthFrontierErrors` | Con una clave de API, una clave equivocada no se distingue de no traer ninguna, y la operación la trataría como anónima en vez de responder 401. Lo rechazan los cuatro generadores con el mismo mensaje. `optional` sobre un token se genera entero | Medio: que el filtro de la clave distinga «ninguna» de «una que no vale» | `go-check --read-scope` |
| Operación por reloj sin persistencia | `scheduledWithoutPersistence` | El reloj se cablea con los casos de uso, que solo existen sobre las Dependencies. Hasta el 0b del plan 2.26 se descartaba en silencio | Alto, el mismo que la última fila: que `NewUseCases` exista sin persistencia | `go-check` |
| Parámetro `decimal` o `boolean`, y parámetro que no es de un barrido sin persistencia | `parameterErrors` | Ninguna fixture los declara. Los handlers los reciben por las Dependencies, que solo existen con persistencia | Bajo el tipo; alto sin persistencia (ver la última fila) | `go-check` |
| Réplica sobre documentos | `outboundErrors` | Ninguna fixture documental la declara | Medio: los almacenes de la réplica en el paquete `mongo` | `doc-check` |
| Value object compuesto en la URL o en una cabecera de una llamada | `outboundErrors` | No tiene forma en una URL. Lo rechazan los cuatro generadores | No se abre: no es una diferencia con los otros tres | — |
| Campo json en una llamada | `outboundErrors` | Su conversor del cable lee también una cadena, y ninguna fixture lo declara | Bajo: el conversor en el adaptador | `go-check`, `stub-check` |
| Llamada sin `method`/`path` o sin tipar, o con una respuesta sin campos | `outboundErrors` | El adaptador lleva la cabecera de código generado y no admite el TODO que esa llamada necesita | Medio: esa llamada en un archivo del agente | `go-check`, `stub-check` |
| Clientes, caché y storage sin persistencia | `outboundErrors`, `cacheErrors`, `storageErrors` | Se entregan por las Dependencies de los casos de uso, que solo existen con persistencia | Alto, y común a las tres: que `NewUseCases` exista sin persistencia | `go-check` |

La matriz de paridad, mecanismo a mecanismo: `npm run matrix --workspace packages/keel-go`.

## Licencias

Solo módulos con licencia permisiva (MIT, Apache-2.0, BSD-2/3, ISC), **también las herramientas**: con la
directiva `tool`, una herramienta queda registrada en el `go.mod` del servicio y su grafo entra en el de él. Cada
módulo lleva versión exacta y SPDX en `src/lib/go-stack.js`, que vigila `test/licenses.test.js`; `go-check`
comprueba con go-licenses todo lo que Go resuelve, transitivos incluidos. golangci-lint es GPL-3.0 y no se emite:
el lint es `go vet` + staticcheck.

## Redes

- **Sin Go** (`npm test`): la proyección contra las de los otros tres en todas las fixtures, la puerta, la
  frontera, las licencias, `test/go-syntax.test.js` (tree-sitter-go: sintaxis, imports del módulo que llevan a un
  paquete emitido, imports que se usan) y `test/go-idioms.test.js` (las reglas de Go del plan, cada una falsada por
  su mutación).
- **Con Go** (`npm run go-check`, minutos): `go mod tidy` sin mover ningún requisito directo, `gofmt -l`, `go vet`
  y staticcheck vacíos, build sin cgo, pruebas por gotestsum, `-race` en un contenedor `golang`, la frontera
  falsada con un import plantado, govulncheck, licencias y el binario arrancado.
