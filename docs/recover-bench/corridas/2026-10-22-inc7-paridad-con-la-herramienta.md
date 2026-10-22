# Incremento 7: la corrida de control del inc. 1, repetida con la herramienta

| Etiqueta | Valor |
|---|---|
| Incremento | 7 (paridad legacy ↔ regenerado). Puerta del plan: la corrida de control del inc. 1 con la herramienta, **la misma tabla** |
| Legacy | `realworld-node` @ ba04b70, sandbox del inc. 1 juzgado con `keel-recover verify` (11/11 criterios, nyc 145/361 sentencias) |
| Diseño | `conduit` v0.1.0 del laboratorio, sin cambios de diseño: solo migrado al formato de la herramienta (abajo) |
| Regenerado | `services/conduit-dotnet` del inc. 1 (keel-dotnet, MongoDB + Keycloak), levantado con su `deploy/` sin reconstruir la imagen |
| Paso 5 | `keel-recover characterize realworld-node --spec workspace/specs/conduit` |
| Paso 7 | `keel-recover parity realworld-node --spec workspace/specs/conduit --target realworld-node/target-conduit-dotnet.yaml` |

## La tabla

| | inc. 1 (a mano, `tools/flows.mjs` + `tools/parity.mjs`) | inc. 7 (`characterize` + `parity`) |
|---|---|---|
| `keep` contra el legacy | 19/19 | **19/19** |
| `fix` contra el legacy (defecto presente) | 5/5 | **5/5** |
| `frontier` contra el legacy | 2/2 | **2/2** |
| `keep` contra el regenerado | 19/19 | **19/19** |
| `fix` contra el regenerado (corregido) | 5/5 | **5/5** |
| `new` contra el regenerado | 1/1 | **1/1** |
| `frontier` contra el regenerado (informativo) | 2/2 | **2/2** |
| Pasos comparados | 52 | **52** |
| Diferencias de datos | 66 | **66** |
| Declaradas / sin declarar | 33 / 33 | **33 / 33** |
| Sin declarar, por defecto | `subject` 9, `image` 11, `favorited`/`following` 13 | **9, 11, 13** |
| Declaradas, por motivo | id 21, `updatedAt` 2, F-OPTIONAL-AUTH 6, fix-identity 4 | **21, 2, 6, 4** |

La misma tabla, número a número, y el mismo veredicto: **en rojo** por los tres defectos del diseño recuperado
que ningún escenario afirma (el `sub` del token de cada autor expuesto, la imagen por defecto perdida en las
proyecciones del autor, `favorited`/`following` ausentes en respuestas autenticadas). Dos ejecuciones seguidas de
los dos pasos dieron lo mismo.

Una diferencia de método que no movió ningún número: el prototipo comparaba solo el **primer** elemento de cada
lista y la herramienta los compara **todos**. En conduit los listados de los flujos tienen como mucho dos
elementos con la misma forma, así que no apareció nada nuevo; en `test/parity.test.js` hay un sabotaje que solo
se ve en el segundo elemento.

## Lo que hubo que migrar (sin cambiar el diseño)

- **Los pasos de cada flujo, dentro del flujo.** `tools/render-scenarios.mjs` reproducía byte a byte el
  `validation-scenarios.md` de conduit desde `characterization.yaml`; ahora emite también el bloque
  ```` ```keel-flow ```` de cada flujo (los 27, `new` incluido), que es lo que ejecutan `characterize` y `parity`.
  De paso, la marca `frontier` sale con su `F-OWNERSHIP` entre comillas invertidas: sin ellas, el lector de marcas
  de keel-core no la reconocía y el criterio `provenance` lo habría dado por inexistente.
- **`contract-map.yaml`**, al schema de keel-recover: un bloque por lado. Lo que el prototipo llevaba en código
  pasa al mapa: cómo obtiene su credencial cada clase de actor (registro por la propia API y JWT forjado con el
  secreto del sandbox en el legacy; token del Keycloak más `registerProfile` en el regenerado) y los campos
  volátiles (`id`, `createdAt`, `updatedAt`, `token`, `slug`).
- **`provenance.yaml`**, a su schema: `legacy` pasa a objeto, se escriben los 9 `fix` con lo que hace el legacy,
  el porqué y su evidencia, y las 4 filas `operator` (que no es un nivel) pasan a `inferred` con su nota. **No se
  inventó nada**: los ids de elemento siguen en texto libre (casarlos con el inventario de 108 elementos es trabajo
  de `/keel-recover`, pendiente del inc. 5), y que las 4 `operator` suban a `asked` lo decide el humano. Por eso el
  criterio `provenance` sigue en rojo y `characterized` sale en verde.
- **`sandbox/sandbox.yaml`** de RealWorld (el que ya armaba `bench-verify`) y **`target-conduit-dotnet.yaml`**.
- **`sandbox/seed-keel-idp.sh`**: el realm del `deploy/` no trae ni el cliente de prueba ni las personas (igual que
  en el inc. 1). Es instrumentación del paso 7, escrita para que se pueda repetir.

## Hallazgos de la herramienta al construirla

- **`sameMembers` con objetos no puede ser igualdad literal**: el mismo flujo se ejecuta contra el legacy y contra
  el regenerado, que añade lo suyo (el `id`). Un miembro objeto casa por los campos que afirma el escenario.
- **Una frontera que el regenerado no cumple no se compara**: la diferencia es la frontera misma, y ya sale en la
  tabla de flujos. Compararla repetía lo mismo como ruido de datos.
- **El nombre del diseño no es el del legacy**: con `--spec`, `conduit` salía en los informes como
  `realworld-node`. Lo cazó esta corrida, y tiene su prueba.

## Estado del diseño de conduit

`keel validate --ready`: 8 de 13. `characterized` en verde; en rojo `provenance` (arriba), revisión, huecos,
careo y `DESIGN.md` (paso 6, fuera del banco). Las decisiones abiertas del humano siguen siendo las del inc. 1:
las 4 `operator`, las tres correcciones del diseño que la paridad pide (subirían conduit a v0.1.1 y pedirían otra
corrida de generación) y el inc. 8.
