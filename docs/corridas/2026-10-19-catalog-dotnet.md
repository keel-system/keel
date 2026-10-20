# Corrida `catalog` — keel-dotnet (registry, DSL 2.22)

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog` v0.1.2 del registry (DSL 2.22, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak · minio · otel` |
| Generador | `keel-dotnet@0.0.1` (con el DSL 2.22; `build --check`: al día) |
| Diseño listo al generar | sí |
| Matriz final | **205/205 OK** |
| Huella del agente | 434 archivos registrados por `build`, 0 adoptados, **35 reescritos**, 0 borrados |
| Huecos del diseño | 0 (sin `design-gaps.yaml`) |
| Huecos del generador | 2, de keel-dotnet; el primero también en keel-nest (ver § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | sin clasificar con la rúbrica: 28 handlers, 3 agregados y una hija, los esqueletos `BrokerBindings.cs` y `S3FileStorage.cs`, y el `README.md`. Todo territorio del agente |
| Agujeros de la puerta | 0 |

El diseño `catalog` del registry migrado al DSL 2.22 (los filtros de las búsquedas), generado con keel-dotnet en
`keel-registry/services/catalog-dotnet`.

## Lo que dijo el informe y lo que había

El informe se sostiene: la matriz de `build/score-matrix.out` es la que cita, y la huella no toca nada fuera del
territorio del agente (ni `infra/`, ni `tests/` de build, ni la solución). Dos puntos estaban mal contados:

- **«`Apply` copia `CreatedBy` antes de estamparlo», con el arreglo «estampar el actor antes de copiar».** El defecto
  existe, pero ese arreglo no funciona: `Apply` pisaría lo estampado. Ver § Arreglos, 1.
- **«Falso aviso de code»**: el agente de código terminó con `compiles: false` porque compiló mientras el de pruebas
  escribía el proyecto de flujos, y el orquestador compiló la solución él mismo con los agentes parados. No era un
  falso aviso. Era un defecto del pipeline, que provoca esa carrera cada vez que las dos fases coinciden (§ Arreglos, 2).
  Y que el orquestador compilara se sale del protocolo (`orchestration.md` § Un solo actor: el gate dice relanzar
  code). El resultado es fiable igualmente, porque `score-scenarios.sh` recompila la solución entera.

## Arreglos

1. **La autoría declarada vacía se guardaba vacía** (keel-dotnet y keel-nest). Con `audit.authorship: declared`,
   `createdBy` es `generated` y no es `required`, así que su columna es nullable, y el adaptador estampaba con `??=`
   después de copiar el valor del dominio. El dominio no conoce al llamante, y el `required string` de C# le obliga a
   poner algo: un `""` se habría guardado en lugar del actor. El agente lo esquivó con `null!`, y los escenarios
   (`createdBy: <id de admin>`) lo habrían cazado. Ahora vacío es AUSENTE: `IsNullOrEmpty` en todas las ramas de
   keel-dotnet (la documental ya lo hacía) y `||=` en keel-nest, relacional y documental. Las dos `domain-modeling.md`
   le dicen al agente que en el alta deje la autoría vacía. Ninguna fixture declaraba `authorship: declared`, por eso
   se escapó: ahora lo cubren las ramas sin fixture `mailer-author` y `mailer-mongo-author`
   (`UNCOVERED_BRANCHES` de keel-dotnet, `DERIVED_SILHOUETTES` de keel-nest). Lo miden `db-check` y `doc-check` de
   keel-dotnet con la sonda de autoría ampliada a `declared`, cuya muestra nace con la autoría vacía, y lo falsa
   `--sabotage=created-by-empty`. El `db-check` de keel-nest no medía la autoría de ninguna forma. Ahora lleva la
   misma sonda, en PostgreSQL y MySQL, con los sujetos `mailer-author` (declarada, raíz e hija leída por el dominio)
   y `product-catalog-authorship` (política). La falsan `--sabotage=created-by-empty` y
   `--sabotage=actor-correlation` (el actor sin petición pierde la correlación).
2. **El agente de código compilaba la solución en la fase 1** (keel-dotnet). code, infra y tests corren en paralelo,
   y un `dotnet build` a secas compila también `tests/…IntegrationTests` mientras se escribe. Ahora compila
   `src/<Raíz>.Api/<Raíz>.Api.csproj`, que cubre todo `src/` por la cadena de referencias, como el `-x test` de
   keel-spring y el `npm run build` de keel-nest. Relanzado en la fase 2 compila la solución, porque es el único actor
   y ejecuta flujos. Lo fija `test/generator-docs.test.js`.

## designGaps

Ninguno.
