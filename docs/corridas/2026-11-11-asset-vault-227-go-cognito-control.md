# Corrida de control de la lectura acotada (DSL 2.27) con Cognito — `asset-vault` en keel-go

| Etiqueta | Valor |
|---|---|
| Diseño | `asset-vault` v1.1.3 (DSL 2.27, documental, 9 capas), con `scoping.reads: [getAsset, listAssets]` y `readMiss: forbidden` |
| Stack | `mongodb · rabbitmq · cognito · redis · minio` (telemetría `none`; Cognito es el emulador del docker-compose) |
| Generador | `keel-go@0.2.0` (`4da2c080` al refrescar con `build --refresh --prune`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **32/32 OK** a la primera (sin arbitrajes) |
| Huella del agente | 341 archivos registrados por `build`, 0 adoptados, **15 reescritos**, 0 borrados |
| Clasificación de la huella | 13 TODO · 0 consulta · 1 generador (`go.mod`) · 0 diseño · 0 puerta |
| Huecos del diseño | 1, no reportado (no hay `design-gaps.yaml`) |
| Huecos del generador | 1, arreglado (ver § Huecos del generador) |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\vault-227-go-mongo-rabbit-cognito\services\asset-vault-go`. Corrida de control del
incremento 8 de `PLAN-DSL-227-LECTURA-ACOTADA.md`, cruzada: asset-vault con Cognito en keel-go, la gemela de
`2026-11-11-asset-vault-227-spring-cognito-control.md`.

## Lo que medía

Lo mismo que la corrida de keel-spring con Cognito, ahora con el arnés de keel-go:

- **El claim del alcance por el emulador (D6).** FL-AST-003-D y FL-AST-004-B piden su llamante con
  `TokenWithScope("vault-reader", ownerOTRO.Code)`, que sale de los mappings de alcance del emulador.
- **El cliente exento con el id que genera el proveedor (D3).** FL-AST-003-E pide su token con
  `ServiceCredential("rendering-service")`, y el servidor lo traduce por `Settings.ClientIDs`.

Las dos en verde.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- La matriz, contra `build/test-results/integration/junit.xml`: 62 casos (las pruebas de Go cuentan también los
  subtests), 0 fallos, 32 `FL-*` distintos.
- La huella, contra una regeneración limpia con el generador de la corrida (sin el arreglo de abajo):
  - Los 13 reescritos de código partían de un TODO: los siete handlers, los tres `_behavior.go`, `rendering_fallback.go`
    (el `degrade`), `cmd/server/broker.go` y `internal/infrastructure/storage/storage.go`. Todos son archivos sin la
    cabecera de código generado.
  - `go.mod` es el hueco del generador. Fuera de lo que añade `go mod tidy`, que la vista de la huella ignora, solo
    cambian el toolchain y el pin de `klauspost/compress`.
  - `README.md` gana una sección de despliegue, que no es una decisión.
- Clasificación a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Huecos del generador

1. **El `go.mod` que emitía build no pasaba govulncheck.** Desde la verificación del 2026-10-29 salieron dos avisos
   alcanzables:
   - **GO-2026-6859**, en `net/http` de `go1.27.3`. El toolchain lo fija `GO_TOOLCHAIN`.
   - **GO-2026-6865**, en `klauspost/compress v1.19.2`. Es indirecto: lo pide el driver de MongoDB v2.9.2, por su snappy.

   El agente de calidad subió los dos (`go1.27.4` y `v1.20.2`). Medido sobre una regeneración limpia: con el generador
   de la corrida, govulncheck da los dos avisos.

   **Arreglado:**
   - `GO_TOOLCHAIN = 'go1.27.4'`. Tiene solo nueve días, sin las dos semanas de rigor, y la excepción va escrita en
     `assets.js`.
   - `klauspost/compress v1.20.2` como transitivo fijado (`kind: 'pin'`, `DOCUMENT_PINS`) con persistencia documental.
     Con Kafka no hace falta, porque franz-go ya pide `v1.20.3`.

   Con el arreglo, govulncheck no encuentra nada y el proyecto compila con go1.27.4. Lo mismo vio la corrida de shop-api,
   que también tocó `deploy/Dockerfile` para la imagen `golang:1.27.4`.

## designGaps

- `quarantine-last-scanned-at` — `Quarantine` no toca `lastScannedAt`: solo lo renuevan `Publish` y `RenewScan`. Es la
  misma decisión que en keel-spring, keel-nest y keel-dotnet (no reportado). Cuarta corrida con este hueco.
