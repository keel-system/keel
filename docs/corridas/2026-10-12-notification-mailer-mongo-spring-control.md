# Corrida de control `notification-mailer-mongo` — keel-spring (incremento 16 de keel-nest)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer-mongo` v2.0.2 (DSL 2.21, documental, 7 capas) |
| Stack | `mongodb · rabbitmq · keycloak` |
| Generador | `keel-spring@0.1.6` (en `c382d47`) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** (31 casos con los bordes `-EDGE`, `-ESCAPE`, `-LOCALE`…) |
| Huella del agente | 305 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 2 en `design-gaps.yaml`: 1 era del generador, 1 ya lo resuelve el generador igual en los dos |
| Huecos del generador | 1, el OpenAPI derivado (ver `2026-10-12-notification-mailer-nest-control.md` § Arreglos) |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 14 TODO · 3 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

La gemela de keel-spring de `2026-10-12-notification-mailer-mongo-nest-control.md`; la comparación de las cuatro, en
`2026-10-12-notification-mailer-nest-control.md` § Paridad.

## Cómo terminó

**23/23 a la primera** (31/31 con los bordes), sin `keel-spring-validate`, sin `harnessPatches`, sin falsos negativos
de infraestructura. Calidad sin ajustes, `indexes`/`indexesTested` OK y `contextLoads` en verde. La huella es la de la
gemela relacional con `TemplateMongoRepository` en vez de `TemplateJpaRepository`.

## designGaps

- `openapi-status-per-operation` — el mismo que reportó su gemela relacional: era del generador y está arreglado.
- `location-format` — `api.keel.yaml` no fija si `Location` es relativa o absoluta. Los dos generadores ya la emiten
  ABSOLUTA (`ServletUriComponentsBuilder` en keel-spring, `locationOf` en keel-nest), así que el contrato no depende
  del agente ni diverge entre servidores; las pruebas comparan con `endsWith` y valdrían con cualquiera. No pide
  cambio.

## Notas

- En Windows, rutas bajo `src/main` de más de 260 caracteres hicieron fallar algún script con rutas relativas; el
  agente lo rodeó con Git Bash.
