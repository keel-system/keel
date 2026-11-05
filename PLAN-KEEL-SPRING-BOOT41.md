# Plan: aprovechar Spring Boot 4.1 y Java 25 en keel-spring

## Contexto

keel-spring ya genera sobre Boot 4.1.2. Su BOM trae Framework 7.0.10, Security 7.1, Hibernate 7.4, Hikari 7, Jackson 3.1, Micrometer 1.17 y JUnit 6. Pero lo que se subió fue la **versión**: el proyecto generado todavía no usa nada nuevo.

Se cruzaron las release notes de Boot 4.0 y 4.1, Framework 7.0 y 7.1 y Security 7.0 y 7.1 con lo que emite hoy el generador. Cada novedad tenía que pasar dos filtros:

1. **Ser GA y estable.** Framework 7.1 sigue en *preview* y no viene en Boot 4.1.2, así que todo lo suyo queda fuera.
2. **Aportar rendimiento o seguridad al servidor generado**, no solo un estilo más moderno.

Pasan el filtro dos piezas de Boot 4.1 sobre Java 21 (fase A) y el salto a Java 25 LTS con la caché AOT (fase B, aprobado por el usuario el 2026-11-05).

**Regla de cada incremento:**
- Cada incremento empieza en un contexto nuevo.
- Abre verificando sus APIs con `ctx7`/`find-docs` y contra los jars, nunca de memoria.
- Cierra con su red en verde, con su sabotaje medido cuando lo tiene, con un commit propio y con el estado y el «Para retomar» actualizados en este archivo.
- Un incremento **condicionado a la medición** que no muestra ganancia se retira. El motivo queda escrito aquí y en la regla `.claude/rules/` que toque.

## Estado

| Inc. | Qué | Fase | Estado |
|---|---|---|---|
| 0 | Verificar APIs y claves contra los jars de 4.1.2 | — | hecho (2026-11-05) |
| 1 | Conexión JDBC perezosa (`connection-fetch: lazy`) | A | hecho (2026-11-05) |
| 2 | Filtro de direcciones salientes (`InetAddressFilter`) | A | pendiente |
| 3 | Java 25 + Gradle 9 (plataforma) | B | pendiente |
| 4 | Caché AOT en `deploy/Dockerfile` | B | pendiente |
| 5 | Cabeceras de objeto compactas | B | pendiente |
| 6 | Hilos virtuales sin *pinning*: reescribir el porqué | B | pendiente |
| 7 | Corrida de control del par del MVP | — | pendiente |

**Para retomar:** empezar por el incremento 2, en un contexto nuevo. El inc. 0 lo corrigió (ver su «Resultado»): necesita la dependencia `spring-boot-http-client` y pasar el `RestClient` de pagos de `SimpleClientHttpRequestFactory` al cliente del JDK, y hay que decidir qué desenlace tiene `FilteredHostException`. `store-check` ya admite `--sabotage=<id>` (hoy solo `eager-fetch`); `payment-check` tiene el suyo. Los temporales del inc. 1 (`D:\keel-tmp\boot41-inc1\`) ya están borrados.

## Lo que se descarta, y por qué

Esta tabla es la respuesta a «¿por qué no se usa X?». No se reabre sin un motivo nuevo.

| Novedad | Motivo |
|---|---|
| `@Retryable` / `@ConcurrencyLimit` (Framework 7) | No traen circuit breaker. resilience4j cubre retry, circuito y fallback, y la frontera estrecha (`outbound-failures.js`) ya está medida. Cambiarlo es churn sin ganancia |
| HTTP service clients (`@HttpExchange`, `@ImportHttpServices`) | Es estilo. El `RestClient` explícito fuerza HTTP/1.1 por un defecto medido (h2c) y pasa la observación a mano |
| API versioning (`spring.mvc.apiversion.*`) | El contrato viaja por la ruta `V1` del diseño, y cambiarlo cambia el cable de los cuatro generadores |
| JSpecify `@NullMarked`, `RestTestClient`, `BeanRegistrar`, `JmsClient` | Son calidad o testing, no rendimiento ni seguridad |
| `spring.jpa.bootstrap` async | Solo acelera el arranque, y la caché AOT (inc. 4) rinde más con menos riesgo |
| Propagación de contexto en `@Async` (4.1) | `ContextPropagatingExecutors` ya lo hace y está medido (TEL-13/14) |
| `authorities-claim-expressions` de JWT | Equivale al `JwtAuthenticationConverter` que ya se emite |
| `/actuator/info` con `process.*` y certificados | Comprobado: en 4.1 los contribuidores `process` y `ssl` siguen **desactivados** por defecto, así que el `info` público no filtra nada nuevo |
| SSL bundles para OTLP | Un endpoint `https://` ya usa el truststore de la JVM, y el diseño no pide nada más |
| Framework 7.1 (`QUERY`, deprecación de `RestTemplate`) | Está en preview y no viene en el BOM. **Vigilado:** el arnés usa `TestRestTemplate`, que habrá que migrar a `RestTestClient` cuando entre la 7.1 |

---

## Incremento 0: verificar la API contra los jars

La regla de la casa es cotejar toda clave y toda clase emitida con los metadatos de los jars de 4.1.2. Con `javap` y el `spring-configuration-metadata.json` del proyecto de una fixture compilada (`compile-check --keep`, o un `services/` de prueba en `D:`), confirmar:

- **`spring.datasource.connection-fetch`**: sus valores y en qué orden se envuelven el proxy perezoso y el de `datasource-micrometer`. Es decir, si la telemetría JDBC ve la conexión real o el proxy.
- **`InetAddressFilter`**: su paquete, sus factorías estáticas, si hay una que excluya link-local, y cómo se le aplica a un `JdkClientHttpRequestFactory` hecho a mano. Hay dos candidatos: `ClientHttpRequestFactoryBuilder.jdk()` con `withHttpClientCustomizer(...)` y `HttpClientSettings`, o envolver el `HttpClient`. Hay que conservar `HTTP_1_1` explícito.
- **Gradle 9.x**: la versión exacta que corre y compila con Java 25 (9.1 o posterior), su compatibilidad con `io.spring.dependency-management` 1.1.7 y con el `build.gradle` emitido.
- **`hibernate.boot.allow_jdbc_metadata_access`** en Hibernate 7.4, para el inc. 4: si existe con ese nombre y qué pide a cambio (dialecto explícito).
- Si **`spring.context.exit=onRefresh`** sale antes de arrancar los beans `Lifecycle`, que son los listeners de los brokers.

**Puerta:** este archivo corregido allí donde la documentación no coincida con los jars. No hay código.

### Resultado (2026-11-05)

Medido con `javap` sobre los jars de la caché de Gradle (`spring-boot-jdbc`, `spring-context` 7.0.10, `hibernate-core` 7.4.13, `spring-kafka`/`spring-rabbit` 4.1.2) y sobre los descargados de Maven Central (`spring-boot-http-client` 4.1.2, `datasource-micrometer-spring-boot` 2.3.0). La documentación se consultó con `ctx7` (Boot v4.1.0, Gradle v9.6.1).

**`spring.datasource.connection-fetch`.**
- Existe tal cual: tipo `String`, valores `eager` y `lazy`, y default `eager`.
- La aplica `LazyConnectionDataSourceConfiguration$LazyConnectionDataSourceBeanPostProcessor`. Es `Ordered` con orden 0 y solo envuelve el bean que se llama exactamente `dataSource`. Antes de envolverlo registra el MBean de Hikari.
- El `DataSourceObservationBeanPostProcessor` de datasource-micrometer **no** es `Ordered`, así que corre después. La cadena queda `ProxyDataSource` (ttddyy) → `LazyConnectionDataSourceProxy` → `HikariDataSource`. **La telemetría JDBC ve el proxy, no la conexión real**:
  - el `jdbc.connection` de datasource-micrometer abre en el `getConnection` perezoso, no al sacar la conexión del pool;
  - la espera del pool queda dentro de la primera consulta.
- Ninguna sonda de `telemetry-check` lee `jdbc.connection` (comprobado con grep).
- Las métricas del pool sobreviven: `DataSourceUnwrapper` atraviesa `DelegatingDataSource`, así que llega a Hikari y conserva su `pool-name`.

**`InetAddressFilter`.**
- Vive en `org.springframework.boot.http.client`, módulo **`spring-boot-http-client`**. Ese módulo **no está en el classpath del proyecto generado**: `spring-boot-restclient` solo entra en `testImplementation`, y `starter-webmvc` no lo trae. El inc. 2 tiene que añadir `implementation 'org.springframework.boot:spring-boot-http-client'`, con la versión del BOM.
- **Semántica:** `matches` significa *permitida*. El filtro es una lista de permitidas, y si ninguna dirección casa se lanza `FilteredHostException`.
- **Factorías:** `all`, `none`, `externalAddresses`, `internalAddresses`, `routable`, `multicast`, `specialPurpose`, `of(String... cidr)`, `not(...)` y `adapt(Predicate)`, más `and`, `or`, `andNot` y `negate`.
- **No hay factoría de link-local.** Se expresa con `of("169.254.0.0/16", "fe80::/10")`, y any-local con `of("0.0.0.0/8", "::/128")`.
- **`fd00:ec2::254` cae dentro de `fc00::/7`**, que es una red privada IPv6 (`internalAddresses` la cuenta como local). Si la política permite las redes privadas, el endpoint de metadatos IPv6 de AWS hay que denegarlo **explícitamente** (`fd00:ec2::254/128`).
- **Cómo filtra el cliente del JDK.** `JdkHttpClientBuilder` instala un `JdkFilteredProxySelector`, que es package-private y no se puede montar a mano. Ese selector resuelve el host con `InetAddress.getByName` dentro de `select()`. De ahí salen tres consecuencias:
  1. Solo mira la **primera** dirección resuelta.
  2. El `HttpClient` vuelve a resolver al conectar, así que **no protege de un DNS rebinding**. Es defensa en profundidad y nada más, como ya decía el plan.
  3. El rechazo es una `RuntimeException` (`FilteredHostException`), **no una `IOException`**.
- **El camino para conservar `HTTP_1_1`** es `new JdkHttpClientBuilder().withCustomizer(b -> b.version(HTTP_1_1)).build(HttpClientSettings.defaults().withConnectTimeout(...).withInetAddressFilter(f))`, que es público y devuelve el `HttpClient`, y después `new JdkClientHttpRequestFactory(httpClient)`. Hay una alternativa equivalente: `ClientHttpRequestFactoryBuilder.jdk().withHttpClientCustomizer(...)`.
- **El cliente `Simple` no admite el filtro.** `SimpleClientHttpRequestFactoryBuilder` lanza «Simple HTTP request factory does not support InetAddress filtering», y **el `RestClient` de pagos usa `SimpleClientHttpRequestFactory`**.

**Gradle 9.**
- Según la matriz de Gradle, Java 25 exige la 9.1.0 o posterior. Boot 4.1 admite «Gradle 8.14+ y 9.x».
- La última 9.x es la **9.8.2** (2026-10-19, sha256 `21bd5da2de49b642904077f38c0efdc7778e92b3ed0889392dca61b97e389607`).
- **Medido**, con Gradle 9.8.2 sobre JDK 21 (toolchain 21) y el `build.gradle` emitido con `io.spring.dependency-management` 1.1.7:
  - `notification-mailer` (rabbitmq) pasa `compileJava`, `compileTestJava`, `compileIntegrationTestJava`, `bootJar` y `test` en verde;
  - con `--warning-mode all` no sale ninguna deprecación de Gradle;
  - `junit-platform-launcher` ya se declara, así que no muerde que Gradle 9 deje de inyectarlo;
  - `catalog-extended` configura y resuelve sin error de script. Su `main` no compila, pero por los métodos que escribe el agente (`mainCompilable`), no por Gradle.
- **Queda sin medir el toolchain 25**, porque no hay JDK 25 instalado. Es la puerta del inc. 3.

**`hibernate.boot.allow_jdbc_metadata_access`.** Existe con ese nombre en 7.4.13 (`JdbcSettings.ALLOW_METADATA_ON_BOOT`). Lo que pide a cambio, el dialecto explícito, se mide en el inc. 4 con el entrenamiento real.

**`spring.context.exit=onRefresh`.**
- `DefaultLifecycleProcessor.onRefresh()` hace `Runtime.halt(0)` **antes** de `startBeans`. Por tanto:
  - los contenedores de listeners (`SmartLifecycle`) no arrancan;
  - tampoco se publica `ContextRefreshedEvent`, así que `@Scheduled` no arranca;
  - y los `ApplicationRunner` no se ejecutan.
- **Pero todos los singletons ya se instanciaron.** Sí se ejecutan `@PostConstruct`, `InitializingBean` y `SmartInitializingSingleton`:
  - Flyway migra;
  - se construye el `EntityManagerFactory`;
  - y **`KafkaAdmin.afterSingletonsInstantiated()` llama a `initialize()` con `autoCreate`, es decir, intenta hablar con el broker.**
- `RabbitAdmin` es perezoso, porque declara al abrir la conexión. Los `@PostConstruct` del outbox solo registran gauges, que también son perezosos.
- La documentación de Boot 4.1 (`aot-cache.adoc`, `dockerfiles.adoc`) da exactamente el comando del inc. 4.

**De paso, fuera de este plan.** javac avisa de que `RabbitTopologyConfig` usa `ListenerExecutionFailedException`, deprecada **para retirada** en Spring AMQP 4.1. Vigilado, como `TestRestTemplate`.

---

## Fase A: Boot 4.1 sobre Java 21

### Incremento 1: conexión JDBC perezosa (`spring.datasource.connection-fetch: lazy`)

Rendimiento, **condicionado a la medición**.

- **Qué gana.** Con `JpaTransactionManager`, la conexión sale del pool al **abrir** la transacción, porque Hibernate fija `autocommit=false`. Con el proxy perezoso solo sale en la primera sentencia SQL. Hay dos casos que dejan de ocupar el pool:
  - las transacciones que terminan sin SQL, como un rechazo del dominio o una guarda que corta antes de cargar;
  - el tramo entre el `begin` y la primera consulta.

  Es la misma presión sobre el pool por la que el relay del outbox ya va en tres pasos.
- **Dónde:**
  - El bloque `spring.datasource` de `packages/keel-spring/src/scaffold/config.js` (~l. 676-705), **solo** con el modelo `relational`.
  - Una fila más del gradiente por perfil, como el resto de Hikari: variable `DB_CONNECTION_FETCH`, default `lazy`.
  - Si cambia lo que el agente debe saber del pool: `assets/generators/spring/skills/keel-spring-database/`.
- **Riesgos a medir:**
  - el proxy aplaza `readOnly`, el aislamiento y el autocommit;
  - el nombre del pool en las métricas (`pool-name` por `unwrap`);
  - el tope `spring.transaction.default-timeout`;
  - el reintento del interbloqueo;
  - el `SKIP LOCKED` de los reclamos;
  - el span `jdbc.connection` de datasource-micrometer, que con el proxy deja de medir la espera del pool (inc. 0). Hay que decidir si eso se documenta en `OBSERVABILIDAD-ARQUITECTURA.md` o si se acepta sin más.
- **Pruebas:**
  - `test/transaction-limits.test.js`: la clave se emite en relacional y nunca en documental.
  - Sonda nueva en `scripts/store-check.js` (vocabulario en `src/lib/store-probes.js`): una transacción sin SQL no mueve `hikaricp_connections_active`. Queda falsada con `--sabotage=eager-fetch`, que quita la propiedad y debe caer en rojo.
- **Puerta:**
  - `npm test --workspace packages/keel-spring`;
  - `store-check`, `claim-check`, `finder-check` y `telemetry-check` contra PostgreSQL y MySQL;
  - `compile-check`.
- **Si la sonda no muestra ganancia** con las formas de handler que genera build, se retira. El motivo se escribe en `.claude/rules/spring-persistencia.md` y en la tabla de descartes.

### Resultado (2026-11-05)

**Hay ganancia y entra.** La sonda pasa por el `UseCaseMediator` generado (sus dos `TransactionTemplate`, escritura y solo lectura) con un handler que no ejecuta SQL: con `eager` la transacción retiene **1** conexión activa de Hikari; con `lazy`, **0**. En PostgreSQL y en MySQL.

- **Emitido:** `spring.datasource.connection-fetch: ${DB_CONNECTION_FETCH:lazy}` en `dbYaml` (`config.js`), solo relacional y en los tres perfiles; `local`, literal. La variable es de Spring y no entra en `keel-core/gen/runtime-env.js`. El perfil `test` (H2) no la lleva.
- **Sonda:** `unaTransaccionSinSqlNoSacaConexionDelPool` en la clase del mediator de `store-check`, con un control (`laPrimeraSentenciaSiSacaLaConexion`: tras la primera sentencia hay una conexión más) para que el caso no pueda salir verde por no ver el pool. Llega a Hikari con `DataSourceUnwrapper` a través del proxy.
- **Falsada:** `store-check --sabotage=eager-fetch` quita la clave del `db.yaml` emitido; cae exactamente ese caso (23/24) en los dos motores.
- **Las demás sondas relacionales** (`store-check`, `claim-check`, `finder-check`) pasan ahora la clave emitida (`conexionPerezosa()` en `src/lib/claim-probes.js`). Sin eso, `@DataJpaTest` arranca sin perfil y el `SKIP LOCKED` y el `READ_COMMITTED` del barrido se habrían medido con `eager`, que no es como corren en producción. El arnés y `telemetry-check` ya la veían: corren con el perfil `local`.
- **El span `jdbc.connection`** queda documentado y aceptado en `guides/OBSERVABILIDAD-ARQUITECTURA.md` § 3.2. La skill `keel-spring-database` (`configuration.md`, `troubleshooting.md`) ya no dice que cada dispatch ocupa la conexión la transacción entera.
- **Puerta, en verde:**
  - `npm test --workspace packages/keel-spring`, con un caso nuevo en `test/transaction-limits.test.js` (la clave en los tres perfiles, nunca en documental) y otro en `test/store-probes.test.js` (toda clase relacional lleva la clave emitida, ninguna documental);
  - `store-check` completo (24, 24, 18, 35, 35 y 30), con `stock-reservation` en MySQL incluido, que es donde el `READ_COMMITTED` del reclamo de reconciliación es portante;
  - `claim-check` completo (siete pasadas, MariaDB incluida);
  - `finder-check` completo (PostgreSQL, MySQL y Mongo);
  - `telemetry-check` (TEL-11, las series del pool, en verde). No tiene eje de motor: mide PostgreSQL. MySQL lo cubren `store-check` y `claim-check`;
  - `compile-check` en su pasada por defecto. El cambio no toca Java generado, solo `db.yaml`, y el Java nuevo de las sondas compiló dentro de `store-check`.

### Incremento 2: filtro de direcciones salientes (`InetAddressFilter`, anti-SSRF)

Seguridad, como defensa en profundidad.

- **Qué gana.** Ninguna `base-url` sale de la entrada del llamante: todas son configuración. Lo que cierra el filtro es la exfiltración al endpoint de metadatos de la nube (`169.254.169.254`, y `fd00:ec2::254` en IPv6) en dos casos: si una variable de entorno se manipula, o si una respuesta del proveedor acaba siguiéndose. El valor es medio, pero es barato y no cuesta nada en el camino feliz.
- **Política** (el filtro es de permitidas: se escribe como `InetAddressFilter.not(...)` de lo denegado; inc. 0):
  - Se deniegan **siempre** link-local (`169.254.0.0/16`, `fe80::/10`), any-local (`0.0.0.0/8`, `::/128`), multicast (`InetAddressFilter.multicast()`) y `fd00:ec2::254/128`, que cae dentro de la red privada IPv6 `fc00::/7`.
  - Se **permiten** loopback y las redes privadas, porque `local` y `test` apuntan al WireMock de `localhost`, y en producción los servicios internos viven en IP privadas.
  - Una lista de denegación extra por variable (`HTTP_CLIENTS_DENIED_ADDRESSES`) entra en el gradiente de perfiles.
- **Dónde:**
  - Una sola pieza emitida (p. ej. `OutboundAddressPolicy` en `infrastructure/configurations/http`) que usen los dos clientes siguientes.
  - `implementation 'org.springframework.boot:spring-boot-http-client'` en `src/scaffold/gradle.js`, con la versión del BOM, siempre que se emita un cliente saliente o una pasarela. Hoy no está en el classpath (inc. 0).
  - `renderConfig` en `packages/keel-spring/src/scaffold/http-clients.js` (~l. 80-156), que hoy construye a mano el `HttpClient` del JDK. Pasa a construirlo `new JdkHttpClientBuilder().withCustomizer(b -> b.version(HTTP_1_1)).build(HttpClientSettings…withInetAddressFilter(…))`, sin tocar la observación. El selector que filtra es package-private y no se puede montar a mano.
  - El `RestClient` de las pasarelas en `src/scaffold/payments.js` (~l. 513). **Usa `SimpleClientHttpRequestFactory`, que no admite el filtro**, así que pasa al cliente del JDK con `HTTP_1_1`. Cambian las excepciones de transporte, de `SocketTimeoutException` a `HttpTimeoutException`, y hay que repasar la traducción de pagos y `payment-check` con ellas.
  - **El rechazo es `FilteredHostException`, una `RuntimeException` y no una `IOException`.** El fallback estrecho (`outbound-failures.js`) lo relanza tal cual. Hay que decidir y escribir si ese rechazo es un `kind` del fallback o un error de configuración que debe salir como 500. La sonda mide qué le llega al `RestClient`.
  - Las skills `keel-spring-httpclient` y `keel-spring-payments`, si mencionan cómo se construye el cliente.
- **Pruebas:**
  - Un caso en `test/` con lo emitido para cada forma de auth de `http-clients` (`api-key`, `bearer-static`, `basic`, `oauth2-client-credentials`) y para pagos.
  - Una sonda en `scripts/payment-check.js` que apunta un adaptador a `169.254.169.254` y afirma que se rechaza **sin abrir conexión**, con el desenlace que se haya decidido para `FilteredHostException`. Queda falsada quitando el filtro.
- **Puerta:**
  - `npm test`;
  - `payment-check`;
  - `compile-check` sobre `stock-reservation` y `payment-checkout`.
- **Paridad:** no cambia el cable. Queda **pendiente fuera de este plan** para keel-nest, keel-dotnet y keel-go. Si se replica, la política sube como datos neutrales a `keel-core/src/lib/gen/outbound-resilience.js`.

---

## Fase B: Java 25 LTS

**Entorno, antes del inc. 3:**
- Instalar Temurin 25 y conservar el 21 (hoy está `21.0.11`). Las cachés y descargas van en `D:`.
- `keel-recover target-db-check --generator=spring` también pasa a pedir el JDK 25.

### Incremento 3: Java 25 + Gradle 9 (plataforma)

- `packages/keel-spring/src/lib/assets.js`: `JAVA_VERSION = 25` y `GRADLE_VERSION = '9.8.2'`, la verificada en el inc. 0 con el `build.gradle` actual sobre JDK 21. Falta medirla con el toolchain 25.
- `packages/keel-spring/vendor/gradle-wrapper/`: el jar y los scripts del wrapper de esa versión. `src/scaffold/wrapper.js`.
- `src/scaffold/gradle.js` (toolchain, ~l. 202-215): revisar qué retiró Gradle 9 del `build.gradle` emitido, como el source set `integrationTest`, `configurations` o `tasks.named`. Lo dice `compile-check`.
- `src/scaffold/readme.js`: «Requiere Java 25».
- `src/lib/platform.js`: un proyecto generado con Java 21 recibe un **aviso, no una negativa** (`JAVA25_SINCE`, junto a `BOOT4_SINCE`). El toolchain y el wrapper son refrescables y el código Java no cambia de semántica. Más un caso en `test/platform.test.js`.
- Docs y skills que digan «Java 21»: `grep -rn "Java 21\|21-j\|JavaLanguageVersion" packages/keel-spring/assets packages/keel-spring/README.md`. Además, la fila «Cambio de versión de Spring Boot» de `CLAUDE.md` y `.claude/rules/spring-*.md`.
- **Puerta:**
  - `npm test`;
  - `compile-check` sobre **todas** las fixtures con JDK 25 y Gradle 9;
  - después, **todas** las redes en vivo de keel-spring, porque cambia la JVM bajo todo. Son `broker`, `mail`, `store`, `mongo`, `telemetry`, `mapping`, `index`, `deploy`, `payment`, `claim` y `finder`. Se pasan de una en una, con la máquina descargada.

### Incremento 4: caché AOT en `deploy/Dockerfile` (JEP 483/514/515)

Rendimiento de arranque y de calentamiento, **condicionado a la medición**.

- **Dónde:** `dockerfile()` en `packages/keel-spring/src/scaffold/deploy.js` (l. 49-110).
- **Imágenes:** `eclipse-temurin:25-jdk-alpine` y `25-jre-alpine`.
- **Entrenamiento:** el `extract --layers` que ya existe deja el jar con la forma que la caché AOT necesita. Después, en la etapa de runtime:
  ```
  RUN java -XX:AOTCacheOutput=app.aot -Dspring.context.exit=onRefresh \
           -Dspring.profiles.active=aot-training -jar application.jar
  ```
  y el `ENTRYPOINT` añade `-XX:AOTCache=app.aot`. Con `AOTMode=auto` (el default), un `JAVA_OPTS` incompatible solo hace que se ignore la caché; no rompe nada.
- **El riesgo real** es que el entrenamiento refresca el contexto dentro de `docker build`, **sin infraestructura**. `config.js` emite un perfil `aot-training` que:
  - apaga Flyway;
  - fija `hibernate.boot.allow_jdbc_metadata_access: false` con el dialecto explícito, que el catálogo ya conoce;
  - deja Hikari sin fallo de inicialización.

  - fija `spring.kafka.admin.auto-create: false`. `KafkaAdmin` intenta hablar con el broker en `afterSingletonsInstantiated()`, que corre **antes** del `halt` (inc. 0).

  Mongo, Redis y la verificación del JWT por `jwk-set-uri` son perezosos. Medido en el inc. 0: los listeners de los brokers, `@Scheduled` y los `ApplicationRunner` **no** arrancan, porque el `halt` llega antes de `startBeans`. En cambio, todo `@PostConstruct` y todo `SmartInitializingSingleton` **sí** se ejecutan. Hay que **confirmarlo por stack** con el entrenamiento real.
- **Interruptor:** `ARG AOT_CACHE=true`. Si un stack no puede entrenar, se apaga para él, con su motivo escrito.
- **Pruebas:** casos en `test/scaffold.test.js` y `test/deploy-develop-env.test.js` para el Dockerfile y el perfil `aot-training`.
- **Medida:** `npm run deploy-check` construye y levanta `deploy/` entero con las fixtures de su red (relacional, documental y con broker).
  - **Gate:** la imagen se construye sin infra y la app llega a `/readyz`.
  - Se registra el tiempo de arranque con caché y sin ella (`Started … in X s`) en `docs/corridas/<fecha>-aot-cache.md`.
  - **Sin mejora medible, se retira.**

### Incremento 5: cabeceras de objeto compactas (`-XX:+UseCompactObjectHeaders`, JEP 519)

Memoria, **condicionado a la medición**.

- En JDK 25 ya es de producto, no experimental. Reduce entre un 10 % y un 20 % el heap en cargas con muchos objetos pequeños.
- Va como default en el `ENV JAVA_OPTS` del Dockerfile **y en el entrenamiento del inc. 4**, porque la caché exige las mismas banderas. Si no, se ignora en silencio.
- **Medida:** en `telemetry-check`, comparar `jvm_memory_used_bytes{area="heap"}` tras la misma carga, con y sin la bandera. Los números van a la corrida del inc. 4. **Sin ganancia, no entra.**

### Incremento 6: hilos virtuales sin *pinning* por `synchronized` (JEP 491)

No cambia código. Con Java 25 desaparece la causa medida del retraso de cuatro minutos del `@Scheduled`.

- **Se conserva** el `TaskScheduler` de plataforma (`packages/keel-spring/src/scaffold/scheduling.js`). Sigue aislando el reloj de la carga web y es inocuo.
- Se reescribe su porqué en dos sitios: el comentario de cabecera de `scheduling.js` y `assets/generators/spring/conventions/virtual-threads.md` (~l. 122). La nueva explicación cubre el *pinning* que queda (marcos nativos, inicialización de clases) y por qué el pool propio sigue mereciendo la pena.
- **Opcional:** repetir el escenario del retraso con varios barridos en una corrida y anotar si el retraso desaparece.
- **Puerta:** `npm test` (los tests que leen ese texto).

---

## Incremento 7: corrida de control

- Corrida sobre el par del MVP (`notification-mailer` / `-mongo`) con el generador nuevo, por el flujo normalizado: `keel-spring build` → `cd services/<x>-spring` → `/keel-generate-spring`.
- Se registra en `docs/corridas/<fecha>-<servicio>.md` con la tabla de etiquetas fijas y la huella (`corrida-metrics.js footprint`).
- **Qué mide:** que los escenarios siguen al 100 % y que la huella del agente no crece, es decir, que el agente no tropieza con Java 25, Gradle 9 ni el proxy perezoso.
- **Cierre del plan:** mover este archivo a `completed_plans/`.

## Verificación común

En cada incremento:
- `npm test --workspace packages/keel-spring`, que incluye `java-syntax`, `engine-support` y `parity`;
- `npm run matrix --workspace packages/keel-spring`, si se toca la matriz;
- las redes en vivo que nombra cada incremento.

Los temporales de las redes van en `D:` y se limpian al terminar.
