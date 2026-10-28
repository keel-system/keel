# Corrida `catalog`: keel-dotnet con Claude Haiku

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog` v0.1.3 del registry (DSL 2.23, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak · minio` |
| Generador | `keel-dotnet@0.0.2` |
| Modelo del agente | `claude-haiku-5-5`: orquestador y los cinco subagentes |
| Diseño listo al generar | sí |
| Matriz final | **184/184 OK** |
| Huella del agente | 412 archivos registrados por `build`, 0 adoptados, **35 reescritos**, 0 borrados |
| Huecos del diseño | 4 en `design-gaps.yaml`, sin clasificar (ver § designGaps) |
| Huecos del generador | 2 señalados por el informe, sin contrastar con keel-dotnet (ver § Del generador) |
| Convertidos en id | — |
| Clasificación de la huella | sin clasificar con la rúbrica: 28 handlers, 3 agregados y una hija, los esqueletos `BrokerBindings.cs` y `S3FileStorage.cs`, y el `README.md`. Los mismos 35 archivos que en la corrida del 2026-10-19 |
| Agujeros de la puerta | — |

El diseño `catalog` del registry, generado con keel-dotnet en `keel-registry/services/catalog-dotnet` y con **todo
el pipeline de `/keel-generate-dotnet` sobre Claude Haiku**. Lo que se mide es si la fase de generación necesita un
modelo grande. La tesis del método es que al agente solo le queda lo que el diseño no determina, y que los árbitros
son scripts.

## Resultado

- **184/184** a la segunda puntuación de `score-scenarios.sh`. La primera dio tres rojos: FL-IMG-010-D,
  FL-SHP-001-F y FL-SHP-001-H. El árbitro (`keel-dotnet-validate`, también con Haiku) los atribuyó a las
  **pruebas** y no al servidor, y era cierto: la prueba tomaba una foto del estado antes del paso que la cambiaba.
  Se corrigieron en `tests/Catalog.IntegrationTests/` **sin tocar `src/`**.
- **La huella coincide archivo por archivo** con las corridas del mismo diseño hechas con Sonnet: los 35 reescritos son
  los mismos que en la del 2026-10-19 (`catalog` v0.1.2) y que los 35 de territorio del agente de la del 2026-10-21.
  Ningún archivo de `infra/`, de la solución ni de las pruebas de `build`. Ni `harnessPatches` ni `culprit: harness`.
- Baseline de migraciones creada y verificada en vivo (`verify-baseline.sh`: 89 elementos idénticos).

## Coste

Sumado desde las transcripciones de la sesión y de sus subagentes, contando cada mensaje una vez (el máximo de
sus fragmentos de streaming):

| Corrida | Modelo | Llamadas | Salida | Lectura de caché | Escritura de caché | Duración |
|---|---|---|---|---|---|---|
| esta | Haiku | 208 | 449 k | 30,2 M | 1,02 M | 50 min |
| `catalog` registry (tres sesiones, 19 y 20-oct) | Sonnet | 99 · 131 · 110 | 148 k · 190 k · 183 k | 13,4 M · 20,3 M · 16,0 M | 0,63 M · 0,64 M · 0,62 M | 27 · 24 · 41 min |
| `catalog-dotnet-mysql-sns` (21-oct, sesión principal) | Sonnet | 85 | 161 k | 11,1 M | 0,60 M | 57 min |

Haiku necesitó en torno al **doble de llamadas**, **2,5 veces más salida** y entre 1,5 y 2 veces más lectura de
caché que Sonnet sobre el mismo diseño, y tardó algo más. Llega al mismo sitio dando más vueltas. El coste en dinero
depende de la relación de precios entre los dos modelos, que no se fija aquí. Hay que calcularlo con la tarifa
vigente antes de citar un ahorro.

Lo que no es comparable del todo:
- el diseño es v0.1.3 frente a v0.1.2: 184 escenarios frente a 205;
- la del 19-oct llevaba `otel`;
- el generador es `0.0.2` frente a `0.0.1`.

La huella sí es comparable, porque es la misma lista de archivos.

## Del generador

Lo que el informe atribuye a keel-dotnet, **sin contrastar todavía con el generador actual**:

1. `double` en magnitudes: el conteo de páginas de los repositorios, `OutboxBackoff`, el multiplicador de
   `RabbitTopology` y `LogConnectFailed`. Propone la división entera `(total + size - 1) / size`.
2. `using` redundantes en doce archivos de `Catalog.Api`, que el SDK web ya aporta como globales.

## designGaps

Cuatro, en `design-gaps.yaml`, pendientes de clasificar con la rúbrica:

- `security.cors`: FL-SEC-001 dice «desde un origen web permitido», pero el bloque `cors` no declara ninguno.
- `use-cases.getProductsBatch`: la collation del orden por `sku`, que no está declarada.
- `domain.Money`: `currency` sin `maxLength: 3`, así que la columna sale `varchar(255)`.
- `domain.Product`: el código de error de cuatro invariantes que ninguna operación alcanza.
