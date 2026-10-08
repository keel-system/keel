# Corrida `notification-mailer-mongo` — keel-nest (incremento 12e: la persistencia documental, con el correo)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer-mongo` v2.0.2 (DSL 2.19, documental, 7 capas) |
| Stack | `mongodb · rabbitmq · keycloak` |
| Generador | `keel-nest@0.0.1` (con el incremento 12 entero y, adelantados, `mail` y `resolvedBy`) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** |
| Huella del agente | 273 archivos registrados por `build`, 0 adoptados, **18 reescritos**, 0 borrados |
| Huecos del diseño | 0 (no escribió `design-gaps.yaml`; el hueco del par lo registra su gemela, ver § designGaps) |
| Huecos del generador | 1: `CommandDispatcherAdapter` cerraba un ciclo de inyección y Nest no arrancaba (ver § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 15 TODO · 2 consulta · 1 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

La corrida que mide el incremento 12 de `PLAN-KEEL-NEST.md`: la persistencia documental (el adaptador sobre el driver
oficial, los almacenes del generador sobre MongoDB y el arnés con `mongoEval`), y con ella la capa `mail` y
`resolvedBy`, adelantados al 12e porque eran lo único de este diseño fuera de la frontera. Su gemela de keel-spring es
`2026-10-08-notification-mailer-mongo-spring.md`.

## Cómo terminó

**23/23** a la primera puntuación salvo un escenario: `FL-NTF-001` falló una vez (`locale: "ES"` respondía 422
`TEMPLATE_NOT_FOUND` en vez de 400) con `culprit: code`, y se corrigió en un ciclo añadiendo `LocaleFormat.validate`
al principio de los handlers de `requestNotification` y `acceptNotificationRequest` —que es lo que pide la nota que
build deja en el mensaje: el formato del value type lo hace cumplir `<Tipo>Format`—. Sin `harnessPatches`, sin
`culprit: harness`, sin falsos negativos de sondas. Los dos gates (`check-idempotency.sh`, `check-domain-guards.sh`)
en verde sobre el proyecto terminado, con `mailDelivery` incluida: el handler de `sendAcceptedNotification` empieza
por `claimForSendAcceptedNotification(...)`, renderiza con `TemplatePart`, y trata `MailDeliveryException.partial()`
como «salió»; el alta de plantillas valida con `templateRenderer.compile(...)`. Todo lo que pide la skill
`keel-nest-mail`, estrenada en esta corrida.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los nueve handlers de `src/application/usecases/` | TODO legítimo: la lógica de cada caso de uso |
| `src/domain/aggregate/{application,notification,template}.ts`, `src/domain/entity/template-variable.ts` | TODO legítimo: los métodos semánticos |
| `src/infrastructure/messaging/broker-bindings.ts` | TODO legítimo: el dispatcher del outbox y el listener |
| `README.md` | TODO legítimo: la guía de despliegue, paso del pase de calidad |
| `src/domain/repository/template-repository.ts` y su adaptador | Consulta de negocio: `findLatestVersion(applicationId, key, locale)` para «la versión es la siguiente de esa aplicación, clave e idioma», regla escrita en `registerTemplate`. El agente de keel-spring escribió el MISMO finder con el mismo nombre |
| `src/infrastructure/usecase/command-dispatcher-adapter.ts` | **Hueco del generador** (ver § Arreglos) |

Nada del adaptador documental, de los almacenes, del arnés ni del correo tocado.

## Lo que dijo el informe y lo que resultó ser

1. **El ciclo de `CommandDispatcher` es cierto**, y es un defecto de build: reproducido sobre una copia limpia del
   proyecto recién generado, añadiendo `CommandDispatcher` a un handler —lo que hace cualquier barrido que despache
   otro caso de uso, aquí `queueAcceptedNotifications`— el contenedor no arranca: «A circular dependency has been
   detected inside "UseCaseContainer"» y 28 pruebas saltadas. Ver § Arreglos.
2. **El pendiente de la precedencia es una divergencia entre los dos servidores**, no solo un caso sin escenario:
   con `recipient` mal formado y una plantilla que no existe, keel-nest responde **422** `TEMPLATE_NOT_FOUND` (valida
   `EmailAddressFormat` al construir el agregado, después de buscar la plantilla) y keel-spring **400** (su agente
   valida los dos formatos antes de buscarla). Ningún escenario lo cubre y el «orden de evaluación» del diseño solo
   ordena los errores de negocio. Ver § Pendientes.
3. El resto del informe se sostiene contrastado con el proyecto.

## Arreglos

- **`CommandDispatcherAdapter` resuelve el mediator en el primer despacho** (`ModuleRef`, `src/scaffold/mediator.js`),
  la misma salida que eligió el agente. Medido sobre la copia del proyecto con el handler que inyecta el puerto: el
  adaptador viejo no arranca; el nuevo, 73/73. Fijado en `test/application.test.js`, que EJECUTA el adaptador emitido
  (construirlo no toca el contenedor; se resuelve una vez) y prohíbe `@Inject(UseCaseMediator)`.
- **`export-indexes.sh` exporta el filtro parcial** (`keel-core/gen/document.js`, común a los dos generadores): lo
  reportó la gemela de keel-spring. Ver su ficha.

## Pendientes

- **La precedencia del formato frente a las precondiciones** (punto 2). Candidato, para los dos generadores: cuando el
  diseño no normaliza un campo, el formato del value type viaja a la ENTRADA (como hace ya la cota) y el 400 sale antes
  que cualquier error de negocio, sin depender de dónde ponga cada agente el `<Tipo>Format.validate`. La nota que
  build deja en el mensaje de keel-spring ya lo dice («si el diseño NO normaliza este campo, el formato tiene que volver
  aquí»), y ninguno de los dos agentes lo hizo.
- Lo que heredan de la gemela: el catálogo de `framework-errors.md` no viaja al proyecto generado, y el contrato del
  cable no escribe qué viaja cuando una lista no se informa.

## designGaps

Ninguno propio. El único hueco real del par (`list-order-significance`, si el orden de las variables es significativo)
lo reportó la gemela de keel-spring y está registrado allí; los dos servidores lo tratan igual, como indiferente.
