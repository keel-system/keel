# Corrida `profile-directory` — keel-go (incremento 8: seguridad)

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.0.0 (DSL 2.23, relacional, 5 capas) |
| Stack | `postgresql · keycloak` |
| Generador | `keel-go@0.1.0` (con el incremento 8: `0d6e649f`, `d1aef5a5` y `649b15f5`) |
| Modelo del agente | `claude-sonnet-5-5`: orquestador y los cuatro subagentes que corrieron (code, infra, tests, quality) |
| Diseño listo al generar | sí |
| Matriz final | **14/14 OK** (13 del documento + `FL-CRD-001-G`, ver § Pruebas) |
| Huella del agente | 131 archivos registrados por `build`, 0 adoptados, **4 reescritos**, 0 borrados |
| Clasificación de la huella | 4 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (sin `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de las corridas del 2026-10-07 (careo 1→2→0; barrido 14; revisión 5; 8 aceptadas / 6 cerradas) |

La corrida que mide el incremento 8 de `PLAN-KEEL-GO.md` (8d): la primera de keel-go con capa `security` y la primera
que entra por la puerta de `--ready` sin `--accept-unready`. Sus gemelas son `2026-10-07-profile-directory-spring.md`,
`2026-10-07-profile-directory-nest.md` y `2026-10-14-profile-directory-dotnet.md`: el mismo diseño y los mismos
escenarios (el diseño solo cambió la cabecera `keel` a 2.23). Workspace: `spring-live-test/corrida-profile-directory-go`.

## Cómo terminó

**14/14 a la primera**, sin ciclos de arbitraje: no hay `build/keel-failures/`, y `keel-go-validate` no llegó a
invocarse porque `score-scenarios.sh` salió con 0 en la primera puntuación. Sin `harnessPatches`, sin
`culprit: harness` y sin fixes de `infra/` ni de `go.mod`. El realm lo sembró `init-keycloak.sh` (lo ejecutó
`keel-go-infra`), y los flujos pidieron todas sus credenciales al arnés: `TokenAs(Persona{…})` para las dos titulares,
`TokenFor("no-role")` para el 403 y `Bearer(...)` en los verbos. Ninguna credencial, cliente ni secreto escrito a mano.
Trece minutos y medio de pipeline (16:27–16:41 UTC); code, infra y tests en paralelo, cada uno en menos de dos
minutos.

## Comparación

| | keel-go | keel-dotnet | keel-nest | keel-spring |
|---|---|---|---|---|
| Matriz | **14/14 a la primera** (13 + `-G`) | 13/13 a la primera | 13/13 a la primera | 14/14 tras un ciclo (13 + `-G`) |
| Registrados por build | 131 | 153 | 138 | 173 |
| Reescritos | **4** | 4 | 4 | 4 |
| Reescritos por un hueco del generador | **0** | 0 | 0 | 1 (el 401 sin cuerpo, ya arreglado) |
| Huecos del generador | **0** | 0 | 1 menor | 1 |

La huella es la de keel-dotnet y keel-nest archivo por archivo: los dos handlers, el comportamiento del agregado y el
`README.md`. Ningún archivo de seguridad tocado: `internal/httpapi/security.go`, `internal/platform/security` y el
lector de la identidad salieron de build tal cual.

## Los reescritos, clasificados

| Archivo | Clase | Qué hizo el agente |
|---|---|---|
| `internal/application/get_my_card_query_handler.go` | TODO legítimo | busca por `FindBySubject(ctx, query.CallerSubject)` —el finder de la clave natural ya venía en el puerto— y devuelve `domain.Errorf(domain.ErrCardNotFound, …)` si no hay ficha |
| `internal/application/save_my_card_command_handler.go` | TODO legítimo | crea la ficha la primera vez y la reemplaza ENTERA después (un `displayName` ausente deja la ficha sin nombre), como dicen las dos reglas del diseño; quitó el `//lint:ignore U1000` del repositorio, que ya se usa |
| `internal/domain/contact_card_behavior.go` | TODO legítimo | `NewContactCard(subject, displayName)` con `uuid.Must(uuid.NewV7())` y `Replace(displayName)`, los dos con `clonePtr` |
| `README.md` | TODO legítimo | la sección `## Despliegue en producción` del paso 5 del orquestador |

El handler recibe la identidad ya resuelta en `CallerSubject` (la estampa el lector del endpoint con
`callerIdentity(r.Context())` después de validar): ninguno mira el token.

Fuera de lo registrado por build, el agente añadió solo `tests/integration/card_test.go` y `go.sum`. **`go.mod` no
aparece en la huella** aunque el pipeline ejecutó `go mod tidy`: es la primera corrida después del arreglo de
`e669a99c` (la huella sobre la vista sin lo que añade tidy), y lo falsa en vivo; en la 7d contaba como reescrito.

## Pruebas

`keel-go-tests` escribió los tres flujos en UN archivo (`card_test.go`, con `TestCardHolder`, `TestCardOwnership` y
`TestCardCredentials`), no en uno por flujo como pide `conventions/integration-tests.md`. Lo dijo en su handoff; no
cambia nada observable.

Y convirtió el caso borde de FL-CRD-001-F («`displayName` de exactamente 100 caracteres → `200`, y se guarda entero»)
en un escenario con id propio, **`FL-CRD-001-G`**, que el documento no declara; también lo dijo. Es **el mismo id que
inventó keel-spring** el 2026-10-07; keel-dotnet y keel-nest metieron el caso borde dentro de FL-CRD-001-F. No falsea
nada —el caso se prueba y el documento sigue cubierto entero—, pero la matriz cuenta 14 donde el documento declara
13, y `score-scenarios.sh` lo puntúa OK porque `junit-scoring.js` da por propio todo id que cuelga del de un flujo
declarado (`FL-CRD-001-*`). Con dos corridas de cuatro ya no es anecdótico: ver § Después de la corrida.

## Reverificado desde fuera

Después de la corrida, sin tocar el proyecto ni relanzar `score-scenarios.sh`: `gofmt -l` vacío, `go vet` y
`staticcheck` con y sin `-tags integration`, `go mod tidy -diff` vacío y `go test ./...` en verde. `keel-go-quality`
(con `govulncheck`) no aplicó ningún cambio.

## designGaps

Ninguno: el pipeline no escribió `design-gaps.yaml`.

## Ruido del entorno, no de la corrida

En la raíz del proyecto queda un `excalidraw.log` (lo escribe un servidor MCP del entorno del usuario al arrancar con
el cwd en el proyecto; también apareció en las corridas de keel-dotnet y keel-nest). No es del pipeline ni del
generador.

## Arreglos

Ninguno: la corrida no destapó nada en keel-go.

## Después de la corrida

- **El caso borde con id propio** (`FL-CRD-001-G`, keel-spring y keel-go). Había dos salidas: una línea en el
  `integration-tests.md` de los cuatro generadores, o que `junit-scoring.js` (neutral) sacara como AJENO un id de
  escenario que el documento no declara cuando el flujo declara los suyos. Se eligió la primera: los cuatro
  `conventions/integration-tests.md` dicen ahora que un caso borde va DENTRO del escenario que lo declara, como una
  aserción más, y nunca con un id que el documento no declara. La puntuación no cambia; si una corrida futura vuelve
  a inventar el id con la regla escrita, toca la segunda.
