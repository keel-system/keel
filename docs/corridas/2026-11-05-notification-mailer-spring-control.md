# Corrida de control `notification-mailer` — keel-spring (incremento 7 del plan Boot 4.1)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer` v2.1.1 (DSL 2.23, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak` |
| Generador | `keel-spring@0.3.0` (en `174a8bad`: Boot 4.1.2, Java 25, Gradle 9.8.2) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** (28 casos) |
| Huella del agente | 321 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`) |
| Huecos del generador | 0 en el informe; 1 visto en la gemela documental que también aplica aquí (ver § Lo que dijo el informe) |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 14 TODO · 3 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

Corrida de control del incremento 7 de `PLAN-KEEL-SPRING-BOOT41.md`, en el workspace
`spring-live-test/corrida-notification-mailer-spring-control-1105`. Mide que el agente no tropieza con lo que cambió bajo
él: Java 25 y Gradle 9.8.2 (inc. 3), la conexión JDBC perezosa (inc. 1), el `deploy/Dockerfile` con caché AOT y
cabeceras compactas (inc. 4 y 5). La gemela documental, del mismo día:
`2026-11-05-notification-mailer-mongo-spring-control.md`. La referencia es el control del 2026-10-18
(`2026-10-18-notification-mailer-spring-control.md`): 23/23 y huella 17.

## Cómo terminó

**23/23 a la primera**, con `score-scenarios.sh` en 0, sin `harnessPatches` ni falsos negativos de infraestructura.
`baselineTested: PENDING`, que en keel-spring le toca al diseñador a propósito.

Reverificado desde fuera, sin volver a ejecutar la suite:
- `build/test-results/integrationTest/`: 28 casos, 0 fallos, 0 errores, 0 omitidos, en 1144 s.
- `specs.sha256` intacto.
- `keel-spring build --check` al día con el generador instalado.

Ningún tropiezo de plataforma: ni el toolchain 25, ni el wrapper de Gradle 9 con `distributionSha256Sum`, ni el
`connection-fetch: lazy` del `db.yaml` aparecen en el informe ni en la huella.

## La huella

**Idéntica archivo por archivo a la del control del 2026-10-18**: los mismos 17 reescritos (los nueve handlers, los
tres agregados y `TemplateVariable`, `README.md`, y `TemplateRepository` con su `TemplateJpaRepository` y su
`TemplateRepositoryImpl`, que son la consulta `findLatestVersion` para la versión siguiente de una plantilla). Build
registra uno más (321 frente a 320), y es exactamente `src/main/resources/application-aot-training.yaml`, el perfil
del inc. 4 (comparadas las claves de los dos `keel-generated.json`). El agente no lo tocó.

## Lo que dijo el informe

- `designGaps`: ninguno.
- Nota menor de `keel-spring-tests`: `FL-DSP-001` y `FL-CLU-001` no dicen cómo observar que el barrido corrió sin mirar la
  base. Se resolvió con un envío de control y esperas de un ciclo: determinista, pero lento (la suite tarda ~19 min). Es
  de técnica de prueba, emparentado con `dsp-then3-unobservable` del control anterior.

**No lo reportó, pero aplica:** el listener reclama con `tryRecord` ANTES de despachar, igual que en la gemela
documental, que es donde se reportó. El razonamiento está allí (§ Hueco del generador: el orden de la guarda del
listener). Es el mismo código en las cuatro corridas de keel-spring del par desde el 2026-10-18.

## designGaps

Ninguno. `rendered-subject-bound` y `required-value-blank`, repetidos en los controles anteriores, no se reportaron
esta vez.
