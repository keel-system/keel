# Informe de generación — stock-reservation

Lo que apareció durante la generación y **no es de este proyecto, sino del generador**.
Cada entrada dice de quién es y qué habría que cambiar en `keel-spring`/`keel-core`.

Resultado de la corrida: **escenarios al 100 % en OK**, `./gradlew build -x test` en verde,
`./gradlew test` (contextLoads bajo el perfil `test`) en verde y baseline de migraciones
entregado. Todo lo de abajo se descubrió por el camino.

> **Estado**: los ocho puntos están **portados a `keel-spring`/`keel-core` y verificados**.
> El proyecto se regeneró desde cero con el generador corregido, se le copió solo el código
> del agente (handlers, agregado, listener, pruebas, baseline) y llegó a verde **sin un solo
> parche del andamiaje**: compilación, 100 % de escenarios y `contextLoads`.

## Defectos del generador (bloquearon la corrida)

### 1. `EventMetadata` no se genera si el servicio solo consume — el `main` no compila

`messaging.js` emite `EventEnvelope`, que importa `domain.events.EventMetadata`, pero
`events.js` corta con `if (model.events.length === 0) return []`. Un diseño con
`subscriptions` y sin `publishing` —el caso de cualquier consumidor puro— genera un proyecto
que **no compila**, con un error que señala a la envoltura y no a su causa.

- **Dónde**: `src/scaffold/events.js`, condición de `generate`.
- **Arreglo**: emitir `EventMetadata` (y `DomainEvent` si hace falta) también cuando la
  envoltura Keel se usa en el lado consumidor.
- **Por qué no lo cazó nada**: `compile-check` compila solo `integrationTest`, y todas las
  fixtures con `messaging` publicaban algo.

### 2. La cron declarada sale con un campo de más

`services.js` antepone `"0 "` a `schedule.cron` asumiendo cron de 5 campos, pero ni el schema
ni `keel validate` comprueban el formato. Con los 6 campos que ya usaban `catalog-extended` y
esta fixture, el resultado tiene 7 y **el contexto de Spring no arranca**:
`Cron expression must consist of 6 fields (found 7)`.

- **Dónde**: `src/scaffold/services.js` (el `"0 ${cron}"`) y la ausencia de validación en
  `keel-core`.
- **Arreglo**: validar el formato en el DSL (5 campos, que es lo que documenta
  `docs/dsl/use-cases.md`) con un error claro, y corregir `catalog-extended`, cuyo servicio
  generado **hoy no arrancaría**.

### 3. El `RestClient` negocia HTTP/2 y pierde el cuerpo

`ClientHttpRequestFactoryBuilder.detect()` cae en el cliente del JDK, que intenta `Upgrade:
h2c` contra un servidor en claro. Contra WireMock —el proveedor de prueba que el propio
generador levanta— el cuerpo llega **vacío** y la llamada muere con `Received RST_STREAM:
Stream cancelled`, que el fallback traduce a «el proveedor no está disponible».

Es el defecto más caro de los tres: **ninguna activación HTTP con cuerpo es ejercitable** en
el pipeline, y el síntoma acusa al proveedor.

- **Dónde**: `src/scaffold/http-clients.js`, `renderConfig`.
- **Arreglo**: fijar `HttpClient.Version.HTTP_1_1` explícitamente en el request factory.

### 4. El perfil `test` no declara `http-clients.*.base-url`

`parameters/test/` no incluye el fragmento, así que el bean del `RestClient` no resuelve su
placeholder y `contextLoads()` —el gate de la fase 3— falla en cuanto el diseño tiene capa
`http-clients`.

- **Dónde**: `src/scaffold/config.js`, fragmentos del perfil `test`.

### 5. `src/test/resources/application.yaml` oculta al de `main`

Tiene el mismo nombre y va delante en el classpath del source set `test`: bajo ese perfil
desaparece **todo** `application.yaml`, empezando por `spring.application.name` — que es
justo lo que la skill `keel-spring-kafka` prescribe como `groupId` del listener. El contexto
falla resolviendo una propiedad que en cualquier otro perfil existe.

- **Dónde**: `src/scaffold/app-tests.js`.
- **Arreglo**: no generar ese archivo y activar el perfil con `@ActiveProfiles("test")` en
  `<Nombre>ApplicationTests`.

## Defectos menores

### 6. El fallback se traga el `throwable`

El cuerpo generado lanza el error del diseño sin registrar la causa. Diagnosticar el punto 3
exigió instrumentarlo a mano: sin ese log, un fallo de integración es indistinguible de una
caída del proveedor.

- **Dónde**: `src/scaffold/http-clients.js`, `fallbackBody`.

### 7. `score-scenarios.sh` cuenta el `@DisplayName` de la clase como escenario

La matriz trae filas duplicadas (`FL-RES-001 · alta de reserva…` junto a `FL-RES-001`) porque
el parser extrae ids `FL-*` también del nombre de la clase. No falsea el veredicto —esas
filas salen OK cuando la clase pasa— pero infla el recuento: 9 escenarios donde hay 6.

- **Dónde**: `src/scaffold/integration-tests.js`, composición de la matriz desde el XML.

### 8. El `IdempotencyStore` no se inyecta en el handler que declara `idempotency`

Build inyecta el `<C>Client` de una activación y el `<E>Reader` de una réplica con el
argumento explícito de que «sin inyectar, el camino de menor resistencia es no llamarlo». El
`IdempotencyStore` cumple exactamente el mismo criterio y hay que añadirlo a mano.

- **Dónde**: `src/scaffold/services.js`, bloque de inyección de dependencias.

## Huecos del diseño (`designGaps`)

```yaml
designGaps:
  - gap: "reconcileReservations no tiene política declarada"
    where: specs/use-cases.keel.yaml § reconcileReservations
    artifact: dependencies.keel.yaml / use-cases.keel.yaml
    proposal: >
      `reconciledBy` declara QUIÉN reconcilia y `schedule` CADA CUÁNTO, pero no cuánto
      tiempo en `confirmed` es demasiado ni qué hacer con lo que se encuentre (reintentar
      el encargo o compensarlo). El handler queda como barrido que solo deja rastro; sin
      esa decisión, elegir por el diseñador liberaría reservas vivas.
```

## Observación de alcance (no es defecto)

La traducción constraint → error de negocio depende de que el baseline **nombre** la
constraint natural, cosa que solo ocurre en `develop`/`production` (Flyway). En `local`, con
`ddl-auto: update`, Hibernate la emite sin nombre y una carrera devolvería un 409 genérico en
vez del `code` del diseño. Los escenarios no lo ven porque el handler comprueba la unicidad
antes; conviene saberlo.
