# Informe de corrida — asset-vault (documental, con los mecanismos completos)

Corrida completa de `/keel-generate-spring` sobre `specs/asset-vault` v1.0.0 en el workspace
externo `corrida-asset-vault-doc/`, con la fixture **ampliada en la fase 2** del
`PLAN-mecanismos-repeticion.md`. Stack: **MongoDB 7 (replica set `rs0`) + Kafka**, más
Keycloak, Redis, MinIO y WireMock, sobre podman en Windows. 11-ago-2026.

No es la primera corrida documental —esa fue la de 7-ago-2026, con 10 escenarios— sino la
primera que ejercita los **mecanismos de repetición completos** sobre Mongo: la rama
`tryRecord`, la clave de deduplicación fuera de la envoltura Keel, la compensación con
llamada de vuelta, el barrido con gate conductual y el clúster de dos réplicas. Diecinueve
flujos declarados frente a los once de antes.

**Resultado**: la suite en verde con **`FL-CLU-003` no ejercitado** —decisión explícita del
diseñador, no una omisión— por un hueco del arnés que este informe cierra. Pase de calidad
con `indexes: OK` e `indexesTested: OK`, y las cinco familias de `check-idempotency.sh` en
OK. El detalle por escenario está en `INFORME-GENERACION.md` del proyecto generado.

Antes de arrancar, el gate salió **rojo con las cinco familias y 8 hallazgos**, que es lo que
hace que su verde posterior signifique algo. Dos de esos hallazgos solo existen desde la fase
2 y son la prueba de que la ampliación llegó hasta el gate:

- `dedupe` listó **los dos órdenes** del guard: `alreadyProcessed`+`record` para
  `MalwareDetected` (que declara transiciones) y **`tryRecord`** para `ThumbnailDelivered`
  (que no las declara).
- `compensation` **exigió `RenderingClient`** en el handler de `quarantineAsset`. Antes de la
  activación de vuelta, `returnClientOf` devolvía `null` y el check no exigía nada.

---

## Defectos del generador (corregidos y congelados)

Los tres están arreglados en el generador, no en el proyecto de la corrida, y cada uno con su
caso de regresión.

### 1. El arnés no sabía dirigir una subida multipart a la segunda réplica

`AbstractFlowIT.onReplica(...)` solo acepta cuerpo JSON. En un diseño cuya mutación con clave
de idempotencia es una **subida** —el caso de cualquier custodia de archivos—, el escenario de
clúster es inexpresable, y `FL-CLU-003` se quedó `NO_EJERCITADO`. Justo el escenario que
separa «lo arbitra la base» de «lo arbitra un candado en memoria», que es una implementación
que se escribe sola si nadie la prueba.

**Corrección** (`src/scaffold/integration-tests.js`): el cuerpo de la subida se extrae a
`multipartTo(String url, …)` —toma URL y no ruta— y la sección de réplica emite
`onReplicaMultipart(...)` cuando el diseño tiene multipart. Reutiliza el mismo cuerpo en vez
de duplicarlo: dos constructores del mismo formulario se separan al primer cambio.

**Regresión**: `test/generation-regressions.test.js` § *Cosecha de la corrida documental*, más
`compile-check` sobre `asset-vault` y `catalog-extended` con los tres brokers — la firma es
Java por plantilla y un `includes(...)` verde no dice que compile.

### 2. `init-keycloak.sh` daba por muerto un Keycloak sano

El script resolvía el frontend de compose por su cuenta: `RUNTIME="${CONTAINER_RUNTIME:-docker}"`
y `COMPOSE=(podman compose …)`, sin el sondeo con `compose ls` ni la caída a `podman-compose`
que `up.sh` sí hace. En Windows, `podman compose` delega en el `docker-compose.exe` del PATH,
que busca el named pipe de Docker Desktop y no el de la máquina de podman: el `exec` falla y
el script acusa a Keycloak de «no aceptar una sesión admin tras N intentos» mientras los logs
del contenedor ya decían `Listening on: http://0.0.0.0:8080`. Un falso negativo que señala al
sitio equivocado; el agente de infraestructura lo sorteó con un shim de PATH en su sesión y
—correctamente— no editó el scaffold.

**Corrección** (`src/scaffold/auth-provisioning.js`): importa `RUNTIME_RESOLUTION` y
`composeResolution(...)` de `devtools.js`, que es de donde salen los de `up.sh`. Una sola
fuente: un script con lógica propia vuelve a divergir en cuanto la otra se arregla. El mensaje
de diagnóstico cita ahora `${COMPOSE[*]}`, el frontend que de verdad se usó.

**Regresión**: mismo bloque de `generation-regressions.test.js`, sobre `asset-vault` porque el
script solo se genera con identidad por token.

### 3. El gate pedía algo que solo se podía dar rompiendo la arquitectura

`check-idempotency.sh` exigía `@Value` **dentro del handler** de la operación de barrido
(`ReconcileScansCommandHandler`, capa `application`). La constitución que el propio generador
siembra dice que `application` **no importa Spring**. No había forma de satisfacer las dos
cosas, y el agente de calidad lo reportó como imposible tras dos pasadas, incluida una
relectura del script línea a línea. Es el peor tipo de falso negativo: el camino de menor
resistencia para apagarlo es romper la frontera hexagonal — y en la corrida relacional de
`stock-reservation` el gate salió verde, así que probablemente se apagó así.

**Corrección** (`src/scaffold/idempotency-check.js`): la fila `unit` del handler deja de
exigir `@Value` (mantiene la prohibición del stub sin escribir), y el umbral pasa a
comprobarse donde sí puede estar — el adaptador que ejecuta el reclamo—, como **tercera
condición del check `claim`** y sobre el **mismo archivo**: reclamo + cota + parametrización.
Un `@Value` en cualquier clase de configuración no es el umbral de *esta* consulta, igual que
un `Pageable` en otro listado no es el lote de *este* barrido.

**Regresión**: `test/idempotency-check.test.js` — el check se apaga con las tres condiciones y
vuelve al quitar cualquiera de ellas, más una aserción de que ninguna fila `unit` de
`reconciliation` sobre un `CommandHandler` menciona `@Value`.

---

## Huecos de diseño (de la fixture, no del generador)

El agente consolidó seis. No se aplican aquí porque `asset-vault` es una **fixture de test**:
su forma la fija lo que tiene que ejercitar, y engordarla tiene coste en cada corrida. Se
anotan para decidirlos con el plan delante.

| Hueco | Qué propone el agente | Valoración |
|---|---|---|
| `audit.authorship: all` contra `FL-AST-001` Then 2 | `authorship: declared`, o quitar la aserción | **Es del generador, no del diseño**: la regla de mapeo omite `createdBy` del contrato porque el dominio no lo nombra, pero `audit: all` promete estamparlo. Merece decidirse en el mapeo, no en la fixture |
| `uploadAsset` sin errores para la política del bucket | Declarar `UNSUPPORTED_CONTENT_TYPE`/`FILE_TOO_LARGE` | Razonable y barato; sin escenario detrás hoy |
| `uploadAsset` sin error para clave reutilizada con otro cuerpo | Declarar `IDEMPOTENCY_KEY_REUSED` | Razonable: es contrato público de un mecanismo que la fixture sí ejercita |
| `getAsset` no proyecta la miniatura | Campo `thumbnailUrl` o ajustar la descripción | La descripción promete un dato que la respuesta no trae: al menos, corregir la prosa |
| `FileStorage.download` sin error declarado | Añadirlo cuando exista la operación | Sin uso hoy; no hay nada que decidir |
| Expiración de `signedUrl` no parametrizada | Declararla en `storage.keel.yaml` | Sin flujo que lo ejercite |

## Lo que la corrida NO destapó

- **Índices de Mongo**: `MongoIndexConfig` coincide exactamente con `persistence.keel.yaml` en
  las cuatro colecciones, verificado en vivo. El gate documental cierra solo: no deja el paso
  manual que dejó la rama relacional con el baseline de migraciones.
- **Cadena de idempotencia y compensación**: `dedupe`, `commandIdempotency`, `compensation` y
  `outboxDelivery` sin ningún hallazgo atribuible al generador — incluida la rama `tryRecord`,
  que era el estreno de esta corrida.
