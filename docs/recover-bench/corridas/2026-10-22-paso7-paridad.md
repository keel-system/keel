# Incremento 1, paso 7: paridad de RealWorld con su regeneración en keel-dotnet

| Etiqueta | Valor |
|---|---|
| Incremento | 1 (prueba manual), paso 7. **Cierra el incremento 1** |
| Diseño | `conduit` v0.1.0 (DSL 2.22, documental), generado con `--accept-unready` (faltaban revisión, huecos, careo y `DESIGN.md`: paso 6) |
| Generador | keel-dotnet, stack MongoDB + Keycloak |
| Matriz de la corrida | **73/73** escenarios, 91/91 pruebas, 2 ciclos (el 0 con 48 fallos de una sola causa, `ProfileRefDto`) |
| `designGaps` | 5: 403 de propiedad sin declarar (F-OWNERSHIP), `tagList` ausente frente a `[]`, `subject` expuesto en el `author` embebido, `items.length` sobre un array desnudo y la `image` sin imagen |
| Del generador | 3 arreglos del agente: el realm sin cliente ni usuarios de prueba, un índice único duplicado (`uk_profiles_username`, en `keel-core/gen/document.js`) y SMOKE-4 esperando 404 donde la seguridad responde 401 antes de enrutar |
| Flujos de caracterización contra el regenerado | `keep` **19/19**, `fix` 5/5 corregidos, `new` 1/1, `frontier` 2/2 |
| **Paridad de datos** | 52 pasos comparados, 66 diferencias: **33 declaradas y 33 sin declarar** |

## El resultado

Los 33 datos sin declarar son **tres defectos del diseño recuperado**:

1. **El `sub` del token de cada autor expuesto** en todo artículo y comentario. `exclude: [subject]` estaba
   solo en las salidas de perfil y no en los `embed: [author]`.
2. **La imagen por defecto perdida** en las proyecciones del autor y en follow/unfollow. La regla solo estaba
   en `getProfile`.
3. **`favorited` y `following` ausentes en respuestas autenticadas**. El diseño los trató entero como
   F-OPTIONAL-AUTH, pero esa frontera solo existe en las lecturas públicas.

Ninguno lo vio ningún escenario, ninguna prueba generada ni ningún `keep`. El agente reportó el primero como
`designGap`; los otros dos solo salen al comparar los datos de los dos lados.

**Lección para la herramienta (escrita en el plan, § Paso 7):** la paridad compara **todo** lo que devuelve cada
paso, traducido por el mapa, no lo que afirman los escenarios. `tools/parity.mjs` clasifica cada diferencia como
equivalente (`null` frente a ausente según el mapa), declarada (`declaredDifferences`, con su motivo) o sin
declarar. Sale en rojo si hay alguna sin declarar y si no compara ningún paso. Esto último pasó: con el sandbox
del legacy caído dijo «0 diferencias», y por eso se añadió la guarda.

## Incidente: el sandbox del legacy desapareció

Entre las 07:27 y las 07:28 se borraron los contenedores de los tres sandboxes (`rec-*`) y después hubo un
`volume prune`. Fue al empezar la corrida de generación (los nodos de MSBuild nacen a las 07:27:08). En el
proyecto generado no hay ningún `prune` ni borrado masivo, así que **no está atribuido**. Las imágenes
sobrevivieron, y el sandbox se recuperó con `podman compose up` y un snapshot nuevo, sin repetir la
observación. Lección para el inc. 3: el sandbox tiene que poder **reconstruirse entero** desde sus archivos
(compose, `build.sh`, snapshot exportado fuera del contenedor), porque el entorno del humano no es suyo.

## Estado del incremento 1

| Paso | Resultado |
|---|---|
| 0 | viable en los tres legacys; la podredumbre está en el motor, no en el build |
| 1 | cobertura 87 % / 65 % / 97,7 %; hojas con 96 filas medidas y 8 refutadas |
| 3-5 | diseño con procedencia (0 `inferred` declarados, 1 colado y corregido); `keep` 19/19 contra el legacy |
| 7 | `keep` 19/19 contra el regenerado; **paridad de datos: 3 defectos que nada más vio** |

Decisiones abiertas para el humano: las 4 procedencias `operator`, las tres correcciones del diseño de arriba
(subirían conduit a v0.1.1 y pedirían otra corrida), y el inc. 8 (DSL 2.23, propiedad).
