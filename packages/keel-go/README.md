# keel-go

Generador Go para diseños Keel, **en construcción por incrementos medidos** (`PLAN-KEEL-GO.md` en la raíz del
repo lleva su estado). Su objetivo es el de los otros tres generadores: **el mismo diseño genera con keel-spring,
keel-nest, keel-dotnet o keel-go servidores equivalentes** — mismo contrato HTTP, mismo cable, mismos eventos,
mismas tablas, misma operación. Y uno más, propio: el código emitido **se lee como Go idiomático**, no como Java
traducido.

```bash
npm i -g @keel-system/keel-go   # comando `keel-go`

keel-go check specs/<servicio>   # opcional: no escribe nada, dice si el diseño es generable
keel-go build specs/<servicio>   # desde el workspace de diseño; el diseñador elige el stack a mano
cd services/<servicio>-go
go mod tidy                      # la primera vez: resuelve las dependencias indirectas y escribe go.sum
/keel-generate-go                # dentro del proyecto, SIN argumentos (llega en el incremento 7)
```

`build` se niega sobre un diseño no listo (`keel validate --ready` en rojo) salvo `--accept-unready`, que queda
estampado en `keel-generated.json`, y no escribe nada en el workspace de diseño.

## El contrato

1. **Entrada**: el diseño multi-artefacto de `specs/<servicio>/`, validado y listo.
2. **Compatibilidad**: DSL `2.23`, la misma que los otros tres. Ante otra, se detiene.
3. **Salida**: `services/<servicio>-go/`, un módulo Go (`go 1.26.0`, `toolchain go1.27.3`) sin cgo, con la
   configuración por perfiles en `config/` —el mismo formato y las mismas variables que los otros tres, embebida en
   el binario—, sus sondas `/livez` y `/readyz`, la prueba de su frontera hexagonal, el snapshot sellado del
   diseño en `specs/` y lo que el agente necesita para completarlo.
4. **Regla de oro**: el generador nunca inventa ni corrige funcionalidad; lo que no sabe mapear lo rechaza o lo
   avisa en código (`src/lib/supported-features.js`), nunca lo ignora.

## La frontera, hoy (incremento 2)

Se aceptan dominio, casos de uso y API, con aviso: el proyecto arranca y responde a sus sondas, sin nada de esas
capas todavía (llegan en los incrementos 4 y 5). Cualquier otra capa se rechaza nombrando el incremento que la
trae. La telemetría, también (incremento 14).

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
