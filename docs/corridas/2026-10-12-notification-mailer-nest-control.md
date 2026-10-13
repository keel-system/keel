# Corrida de control `notification-mailer` — keel-nest (incremento 16)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer` v2.0.2 (DSL 2.21, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak` |
| Generador | `keel-nest@0.0.1` (con el incremento 16: `c382d47`) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** |
| Huella del agente | 304 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Huecos del diseño | 2 en `design-gaps.yaml` (ver § designGaps) |
| Huecos del generador | 1, neutral y común a los dos generadores: el OpenAPI derivado (ver § Arreglos) |
| Convertidos en id | — |
| Papel | `control` |
| Clasificación de la huella | 15 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

La corrida de control del incremento 16 de `PLAN-KEEL-NEST.md`: el par del MVP generado con los dos generadores,
con el mismo stack y la misma versión del diseño. Sus tres hermanas son `2026-10-12-notification-mailer-spring-control.md`,
`2026-10-12-notification-mailer-mongo-nest-control.md` y `2026-10-12-notification-mailer-mongo-spring-control.md`. La
comparación de las cuatro está en § Paridad.

## Cómo terminó

**23/23 a la primera puntuación**: `keel-nest-validate` no llegó a invocarse. Sin `harnessPatches`, sin fixes de
`infra/` ni de la configuración, sin `culprit: harness`. El pase de calidad volvió a puntuar 23/23 tras redactar el
baseline de migraciones y lo probó en vivo (`baseline: OK`, `baselineTested: OK`), lo que en keel-spring es del
diseñador.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los nueve handlers de `src/application/usecases/` | TODO legítimo: la lógica de cada caso de uso |
| `src/domain/aggregate/{application,notification,template}.ts`, `src/domain/entity/template-variable.ts` | TODO legítimo: los métodos semánticos |
| `src/infrastructure/messaging/broker-bindings.ts` | TODO legítimo: el dispatcher del outbox y el listener |
| `README.md` | TODO legítimo: la guía de despliegue |
| `src/domain/repository/template-repository.ts` y su adaptador | Consulta de negocio: `findMaxVersionByApplicationIdAndKeyAndLocale`, para «la versión es la siguiente de esa aplicación, clave e idioma» |

Nada del adaptador, del arnés, del correo ni de la mensajería generados tocado. La corrida documental del 12
(`2026-10-08-notification-mailer-mongo-nest.md`) tenía 18 reescritos: el que falta es el
`command-dispatcher-adapter.ts` del ciclo de inyección que se arregló entonces.

## Paridad

Las cuatro corridas del control, con el mismo diseño, el mismo stack y el mismo `keel validate --ready` en verde:

| Corrida | Matriz | Huella | Validate | Huecos del diseño |
|---|---|---|---|---|
| keel-nest, PostgreSQL | 23/23 a la primera | 17 (304 registrados) | no invocado | 2 |
| keel-spring, PostgreSQL | 23/23 tras un ciclo (3 rojos: 2 `code`, 1 `test`) | 17 (320 registrados) | 1 ciclo | 4 |
| keel-nest, MongoDB | 23/23 a la primera | 17 (294 registrados) | no invocado | 1 |
| keel-spring, MongoDB | 23/23 a la primera | 17 (305 registrados) | no invocado | 2 |

- **La huella es la misma en las cuatro, archivo por archivo**: los nueve handlers, los tres agregados y la entidad
  hija, el README y UNA consulta de negocio sobre plantillas, la misma en los cuatro proyectos con dos nombres. Lo
  único que cambia es el decimoséptimo: en keel-nest el agente registra el dispatcher y el listener en
  `broker-bindings.ts`, y en keel-spring escribe la interfaz de Spring Data de esa consulta.
- **Los 23 `FL-*` en OK en las cuatro.** El agente de pruebas de keel-spring desdobló además los bordes en ids
  `-E1`, `-E2`… (59 casos en la relacional, 31 en la documental); el de keel-nest los cubrió dentro de los 23.
- **Ninguna de las cuatro tocó nada de lo que genera build** fuera de los TODO: ni `harnessPatches` ni arreglos de
  `infra/` en ninguna.
- **Las dos mitades de la regla de equivalencia que el agente decide** salieron iguales sin coordinarse: los dos
  listeners de `NotificationRequested` registran con `tryRecord` antes de despachar, porque la nota que build deja en
  el mensaje (la misma en los dos, de `keel-core/gen`) dice que la operación no tiene guarda de dominio. Y `Location`
  sale absoluta en los dos (`ServletUriComponentsBuilder` y `locationOf`).

## Arreglos

- **El OpenAPI derivado ponía el status y el `when` de la primera declaración de un code a todas las operaciones**
  (`keel-core/src/lib/gen/openapi.js`, común a los dos generadores). `TEMPLATE_NOT_FOUND` es 404 en `getTemplate` y
  `publishTemplate` (por id) y 422 en `requestNotification` y `acceptNotificationRequest` (por clave e idioma), y el
  contrato lo listaba bajo 404 en las cuatro, con el texto de la búsqueda por id. Causa: `statuses` es un `Map`
  status → operaciones y se leía como un objeto indexado por operación, así que siempre caía en el de la primera. Lo
  reportaron como hueco del diseño los dos agentes de pruebas de keel-spring (proponían separar el code en dos); el
  diseño es válido y el generador ya lo soportaba en todo lo demás (la excepción recibe el status por constructor).
  Ahora el contrato usa el status y el `when` de cada operación (`whenByOperation` en el modelo), y lo fija un caso
  de `keel-nest/test/openapi.test.js` que cae con el código anterior.

## designGaps

- `rendered-subject-bound` — el `maxLength: 200` de `Notification.renderedSubject` se comprueba sobre el asunto sin
  interpolar; el ya interpolado puede pasarse sin error declarado (rechazar con un code o truncar). Solo lo vio esta
  corrida.
- `mail-header-invalid` — una cabecera malformada o reservada en `MailMessage` lanza un `Error` genérico (500).
  **No es del diseño**: es la defensa de build contra la inyección de cabeceras sobre datos que arma el propio
  servicio, y keel-spring hace lo mismo con su excepción de argumento. Un fallo de programación, no un desenlace.

## Pendientes

- La consulta de la versión siguiente es la única que el agente ha escrito en las seis corridas del par (las dos del
  12 y estas cuatro), con nombres distintos y el mismo contenido. La regla vive en la prosa de `registerTemplate`; si
  el DSL pudiera decir «versión correlativa por esta clave», build la emitiría y la huella bajaría a 16.
