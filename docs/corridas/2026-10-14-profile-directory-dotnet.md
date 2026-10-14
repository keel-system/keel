# Corrida `profile-directory` — keel-dotnet (incremento 8: seguridad)

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.0.0 (DSL 2.21, relacional, 5 capas) |
| Stack | `postgresql · keycloak` |
| Generador | `keel-dotnet@0.0.1` (con el incremento 8: `b7424cb` y `733b2a3`) |
| Diseño listo al generar | sí |
| Matriz final | **13/13 OK** |
| Huella del agente | 153 archivos registrados por `build`, 0 adoptados, **4 reescritos**, 0 borrados |
| Huecos del diseño | 0 (sin `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Convertidos en id | |
| Clasificación de la huella | 4 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de las corridas del 2026-10-07 (careo 1→2→0; barrido 14; revisión 5; 8 aceptadas / 6 cerradas) |

La corrida que mide el incremento 8 de `PLAN-KEEL-DOTNET.md` (8d): la primera de keel-dotnet con capa `security`, y
la primera de keel-dotnet que entra por la puerta de `--ready` sin `--accept-unready`. Sus gemelas son
`2026-10-07-profile-directory-nest.md` y `2026-10-07-profile-directory-spring.md`: el mismo diseño y los mismos
escenarios.

## Cómo terminó

**13/13 a la primera**, sin ciclos de arbitraje: no hay ningún volcado en `build/keel-failures/`, que `FailureCapture`
escribe por cada rojo. Sin `harnessPatches`, sin `culprit: harness` y sin fixes de `infra/` ni de la solución. El
realm lo sembró `init-keycloak.sh` y los flujos pidieron sus tokens al arnés (`TokenFor("no-role")` y `TokenAs` para
las dos titulares, envuelto en `Ana()`/`Bea()` en el flujo de aislamiento): ninguna credencial, cliente ni secreto
escrito a mano. Calidad sin hallazgos, `dotnet test` 71/71 y el baseline de migraciones creado con `dotnet ef` y
verificado en vivo.

## Comparación

| | keel-dotnet | keel-nest | keel-spring |
|---|---|---|---|
| Matriz | **13/13 a la primera** | 13/13 a la primera | 14/14 tras un ciclo |
| Registrados por build | 153 | 138 | 173 |
| Reescritos | **4** | 4 | 4 |
| Reescritos por un hueco del generador | **0** | 0 | 1 (el 401 sin cuerpo, ya arreglado) |
| Huecos del generador | **0** | 1 menor (`todo.ts` sin uso) | 1 |

La huella es la de keel-nest archivo por archivo: los dos handlers, el agregado y el `README.md`. Ningún archivo de
seguridad tocado: el middleware, las reglas, el autenticador y la identidad del llamante salieron de build tal cual.

## Los reescritos, clasificados

| Archivo | Clase | Qué hizo el agente |
|---|---|---|
| `UseCases/GetMyCardQueryHandler.cs` | TODO legítimo | busca por `FindBySubject(query.CallerSubject)` —el finder de la clave natural ya venía en el puerto— y lanza `CardNotFoundError` si no hay ficha |
| `UseCases/SaveMyCardCommandHandler.cs` | TODO legítimo | crea la ficha la primera vez y la reemplaza ENTERA después (un `displayName` ausente deja la ficha sin nombre), como dicen las dos reglas del diseño |
| `Aggregate/ContactCard.cs` | TODO legítimo | `Create(subject, displayName)` con `Guid.CreateVersion7()` y `Replace(displayName)` |
| `README.md` | TODO legítimo | la sección `## Despliegue en producción` del paso 5 del orquestador, con `OAUTH2_ISSUER_URI` obligatoria y `OAUTH2_JWK_SET_URI` opcional |

El handler recibe la identidad ya resuelta en `CallerSubject` (la estampa el lector del endpoint con
`CallerIdentity.Resolve()`): ninguno mira el token, que es lo que pide `mapping.md § security`.

Fuera de lo registrado por build, el agente añadió solo lo esperado: tres clases de flujo
(`CardHolderFlow`, `CardIsolationFlow`, `CardCredentialsFlow`, con 13 `[Scenario]`, uno por escenario del
documento), el baseline de migraciones de `dotnet ef` y los seis `packages.lock.json`.

## designGaps

Ninguno: el pipeline no escribió `design-gaps.yaml`.

## Ruido del entorno, no de la corrida

En la raíz del proyecto quedó un `excalidraw.log`, y el commit de cierre lo incluye. Lo escribe un servidor MCP del
entorno del usuario al arrancar con el cwd en el proyecto; también aparece en la corrida de keel-nest. No es del
pipeline ni del generador.

## Arreglos

Ninguno: la corrida no destapó nada en keel-dotnet.
