# Informe de corrida — autenticación saliente y resiliencia de clientes HTTP

Corrida completa de `/keel-generate-spring` sobre `specs/catalog-extended` v1.0.0 en
`corrida-http-auth/`, con **PostgreSQL + Kafka + Redis + MinIO**. 12-ago-2026. Abre un eje que
ninguna corrida anterior había tocado: los modos de **autenticación saliente** del DSL.

De los cinco que declara `http-clients.schema.json`, las fixtures solo ejercitaban tres
(`none`, `api-key`, `bearer-static`). **`basic` y `oauth2-client-credentials` nunca se habían
generado, nunca se habían compilado y nunca habían corrido**: `HttpClientsOAuth2Config` y la rama
`spring-boot-starter-oauth2-client` de `gradle.js` eran código muerto. Y aunque el retry y el
circuito ya tenían escenarios, **ninguno afirmaba que la credencial viajara por el cable**: el
proveedor de prueba contesta igual con credencial que sin ella, así que un cliente mal configurado
pasaba todos los gates y fallaba el día del despliegue contra el proveedor real.

Para eso se amplió la fixture con dos clientes —`legacy-erp` (basic) y `partner-catalog`
(oauth2)— y siete flujos nuevos: cuatro `FL-AUT-*` que asertan la cabecera saliente, `FL-RTY-001`
sobre el conteo de intentos y la estabilidad de la clave, `FL-CBR-001` sobre el ciclo completo del
circuito, y `FL-DLQ-001` sobre el descarte.

**Resultado**: **41/42 escenarios en OK**. Línea base del scaffolding en `917246e`; la corrida no
dejó commit de cierre porque el gate exige el 100 %. El escenario que no cerró —`FL-RTY-001`— no
falló por el código: **falló porque yo lo escribí contradiciendo el diseño** (§ 3). El pase de
calidad y el baseline de migraciones no llegaron a ejecutarse.

**Tres defectos del generador, ninguno de negocio**, y los tres invisibles para los gates
existentes: `compile-check` compila el arnés pero no arranca la aplicación, `broker-check` no
levanta la JVM, y `npm test` compara cadenas.

---

## Defectos del generador (corregidos y congelados)

### 1. Un cliente OAuth2 saliente dejaba toda la API detrás de un login

El más grave, y el que mejor justifica que estas corridas existan. `catalog` **no declara capa
`security`**: su API es abierta. Pero `partner-catalog` declara auth OAuth2 saliente, y para eso
`gradle.js` añade `spring-boot-starter-oauth2-client` — que arrastra Spring Security. Sin ninguna
`SecurityFilterChain` declarada, la autoconfiguración de Boot registra la suya: **toda la API
pasa a exigir login, `/actuator/health` incluido**, que empezó a contestar 302 al formulario.

El servicio nace roto por un efecto colateral de una dependencia que se pidió **para salir**, y el
síntoma no menciona OAuth2 por ninguna parte. Lo cazó el humo del arnés (SMOKE-2, salud del
servicio); sin ese sondeo el diagnóstico habría sido mucho más caro, porque el fallo aparece en
todos los flujos a la vez y ninguno señala la causa.

**Corrección** (`src/scaffold/security.js`): cuando no hay capa `security` pero algún cliente
declara `oauth2-client-credentials`, se genera `OpenApiSecurityConfig` — una cadena explícita con
`anyRequest().permitAll()` y `csrf`/`httpBasic`/`formLogin` desactivados. Los beans de OAuth2
Client quedan intactos: lo que se declara es que la **entrada** está abierta, que es exactamente
lo que dice el diseño al no traer esa capa.

**Regresión**: `test/generation-regressions.test.js` — la cadena existe y es permisiva con la
fixture, y **no** se genera con `stock-reservation` (http-clients sin oauth2), donde el tipo ni
siquiera estaría en el classpath. La aserción negativa busca por nombre sobre el árbol generado,
no contra una ruta escrita a mano: una ruta equivocada la haría pasar sin mirar nada.

### 2. El fallback no cubría el fallo de obtención del token

`OAuth2ClientHttpRequestInterceptor` pide el token **al autorizar**, antes de que salga la
petición. Ninguna de las sobrecargas del fallback —todas de transporte o de respuesta— llega a
verlo, así que un proveedor de identidad caído salía como **500 sin traducir** aunque el resto del
fallback funcionara y aunque la activación declarase `onFailure: ignore`.

Es el mismo patrón que el fallback estrecho ya resolvió para el resto de modos de fallo, con un
camino que la tabla no contemplaba porque hasta ahora ningún diseño lo recorría.

**Corrección** (`src/lib/outbound-failures.js`): entrada nueva
`OAuth2AuthorizationException` —el padre, que cubre también la `ClientAuthorizationException` que
lanza el interceptor—, emitida **solo** para clientes con esa auth: sin ella el tipo no está en el
classpath. Va al fallback pero **no** a `record-exceptions`, por el mismo criterio que el 4xx: quien
no contesta es el emisor del token, no el proveedor de negocio, y abrir su circuito por una caída
ajena lo dejaría cortado toda la ventana después de que la identidad ya hubiera vuelto.

**Regresión**: dos casos en `generation-regressions.test.js` — la sobrecarga existe en el
adaptador oauth2 y **no** en el de `bearer-static`; y el tipo no aparece en el `record-exceptions`
del fragmento de configuración.

Lo destapó `FL-AUT-004`, que era el único escenario que miraba ese camino.

### 3. `resetState()` no alcanzaba el estado que vive dentro de la JVM

`reset-db.sh` habla con la BD, el broker, la caché y el stub — todos procesos aparte. Pero la
ventana de un circuito (`CircuitBreakerRegistry`) y la concesión OAuth2 cacheada
(`OAuth2AuthorizedClientService`) viven en beans singleton **dentro de la aplicación bajo prueba**,
y sobrevivían al reset entero: entre escenarios y entre clases.

Los dos síntomas no son igual de graves:

- El circuito de `compliance.recordWithdrawal` abría **al tercer fallo nuevo en vez de al quinto**,
  porque arrastraba dos de otra clase. Falla, y la sospecha cae sobre la configuración, que está
  bien.
- Un token cacheado de un escenario anterior autorizaba la llamada de otro cuyo proveedor de
  identidad **debía estar caído**. Eso no falla: **aprueba de más**. El escenario que iba a medir
  esa caída pasaba sin haberla medido.

Y salió caro por partida doble: la contaminación **enmascaró** el defecto #2 durante una vuelta
entera de arbitraje. Solo al corregir el reset apareció la causa real de `FL-AUT-004`.

**Corrección** (`src/scaffold/integration-tests.js`): `resetCircuitBreakers()` y
`resetOAuth2AuthorizedClients()`, generados solo cuando el diseño los necesita, capturados por
`@Autowired(required = false)` en el `@BeforeAll` de la superclase —que corre antes que el de la
subclase, que es quien llama a `resetState()`— e invocados **los primeros** del reset: son estado
de la propia JVM y no dependen de que la infraestructura esté arriba.

El de OAuth2 limpia por reflexión porque el servicio no expone forma de vaciarse entero
(`removeAuthorizedClient` exige el nombre del principal, que con client_credentials lo pone Spring
por dentro) — y **falla ruidosamente** si no encuentra dónde limpiar. La alternativa, no hacer
nada en silencio, es exactamente el defecto que el método existe para cerrar.

---

## Hueco del arnés cerrado: el fallo que no es un status

El arnés sabía programar respuestas (`stubFor`, `stubFailure`) pero **no sabía provocar que el
proveedor no contestara**. La consecuencia es más amplia de lo que parece: una escritura ajena
suele declarar `retryOn: [timeout, connection]` —repetir un 5xx puede duplicar el efecto—, y con
esa política un `stubFailure(..., 503)` **no** se reintenta. Así que hasta ahora **ningún
escenario podía ejercitar el retry de una escritura**, que es justo donde el retry importa.

**Añadido** (`src/scaffold/integration-tests.js`): `stubConnectionFault(método, ruta)`
(`CONNECTION_RESET_BY_PEER`) y `stubTimeout(método, ruta, ms)` (`fixedDelayMilliseconds`). Los dos
llegan al servidor como `ResourceAccessException`, que es lo que el generador lista en
`retry-exceptions` para `connection` y `timeout`. Documentados en la tabla de helpers de
`conventions/integration-tests.md`, con la regla que faltaba: **el modo de fallo del Given es el
que declara `retryOn`, no el más cómodo de escribir**.

Sigue sin ser expresable «falla dos veces y a la tercera responde 200»: los mappings programan una
respuesta fija y el arnés no expone los escenarios con estado de WireMock. Queda declarado como
hueco en el propio `validation-scenarios.md` en vez de escrito como un `Then` que nadie puede
satisfacer.

---

## Un escenario mal escrito, y por qué se cuenta aquí

`FL-RTY-001` es el 1 de 42 que no cerró, y el error es **mío al escribirlo**: lo puse con un 503
sostenido sobre `compliance.recordWithdrawal`, que declara `retryOn: [timeout, connection]` y
excluye 5xx a propósito —con un comentario de diseño que lo explica, en el archivo que tenía
delante—. El código siguió fielmente el `retryOn` vigente; el escenario pedía otra cosa. Forzarlo
al revés habría roto `FL-CMP-002`, que depende de exactamente cinco llamadas para abrir el
circuito.

Se cuenta porque el arbitraje lo clasificó bien y **no lo tapó**: `keel-spring-validate` lo mandó
a `design`, no a `code`, que es lo que impidió que alguien «arreglara» el generador para satisfacer
un escenario equivocado. Corregido en la fixture: el Given ahora corta la conexión
(`stubConnectionFault`), y se le añade `FL-RTY-001-B` —la mitad negativa: un 503 en esa misma
llamada **no** se reintenta—, que es lo que convierte al flujo en una medida de `retryOn` en vez
de una medida de «hay retry».

## Huecos de diseño

### 1. El dato de un `need` no tiene por dónde llegar a la respuesta

El más de fondo, y **no es del fixture sino del DSL**. `getProductBySlug` declara
`output: { entity: Product }`, y esa forma de payload no admite campos extra
(`additionalProperties: false` en `common.schema.json`). Un `need` con `strategy: on-demand` y
`usedBy: [getProductBySlug]` no tiene, literalmente, dónde aterrizar: el dato se pide, atraviesa
el ACL y se descarta.

Le pasa a `legacy-erp.productCost` —añadido en esta corrida— y también a `pricing.currentPrice`,
que lleva en el diseño desde antes sin que nadie lo notara. El efecto práctico es que
`FL-CBR-001` tiene que medirse **entero por el conteo de llamadas**: el `Then` que afirmaría «el
coste llegó hasta la respuesta» no se puede escribir.

Mismo patrón, con otra consecuencia, en `listProducts`/`getProductsByIds` con
`pricing.supplierPrice`: el reader quedó completo y **sin ningún llamador**, porque invocarlo por
elemento violaría la regla de no-N+1 sin que nadie consuma el dato.

### 2. El `code` de la carrera de idempotencia, por cuarta corrida consecutiva

`IdempotencyConflictException` emite el canónico `IDEMPOTENCY_KEY_IN_PROGRESS`, y
`use-cases.keel.yaml` declara `PRODUCT_KEY_IN_PROGRESS` para lo mismo. El mecanismo genérico no
puede sobrescribirlo sin capturar una excepción que `mapping.md` prohíbe capturar. Ningún `FL-*`
ejercita esa rama. Es el mismo hueco que `INFORME-MECANISMOS.md` dio por cerrado con el catálogo
de `framework-errors`: lo que queda abierto es que el diseño **declaró un código de otra familia**
y nada lo avisó.

### 3. Menores

- El `fallback` de `pricing.getPrice` promete «el último precio conocido en caché» y no existe
  ninguna caché de ese dato. Se degradó a nulo.
- `reconcileWithdrawals` no tiene dónde apuntar desde cuándo espera un retiro ni si ya fue
  reclamado: `domain.keel.yaml` no declara esos campos para `Product`. Quedó como no-op
  instrumentado, y no tiene `FL-*` detrás por construcción.
- `listProducts` describe un orden en sus escenarios y **no lo declara en `output.sort`**, que sí
  existe en el DSL. El informe de generación lo reportó como carencia del DSL; no lo es.

---

## Lo que esta corrida sí confirmó

- El `token-uri` del perfil `local` apuntando al proveedor real —localizado en estático antes de
  empezar y corregido en `config.js`— era efectivamente bloqueante: sin esa corrección ningún
  `FL-AUT-*` habría pasado de la primera llamada.
- `basic` y `oauth2-client-credentials` generan código que compila, arranca y autentica de verdad
  contra un proveedor. Es la primera vez que se sabe.
- El circuito **vuelve**: `FL-CBR-001` observó el paso a semiabierto tras la ventana. Hasta ahora
  solo se había visto abrir.
- La cola de descarte recibe de verdad (`FL-DLQ-001`), lo que convierte en afirmaciones con
  sentido las aserciones negativas sobre DLQ que ya existían — hasta ahora una DLQ que nunca
  recibiera nada las habría pasado todas igual.

## Lo que la corrida NO destapó

- **mTLS**: no existe en el DSL ni en el generador. No es un hueco de cobertura sino una
  funcionalidad ausente.
- **El retry que se recupera**: ver el hueco del arnés, arriba.
- **El pase de calidad**: no llegó a ejecutarse, porque su gate es el 100 % de escenarios. El
  baseline de migraciones de este servicio sigue sin redactar.

## Verificación de las correcciones

`npm test` 494 + 414 en verde (3 casos nuevos) · `compile-check` sobre `catalog-extended` con los
tres brokers, que es lo único que juzga Java emitido por plantilla · `keel validate` sin avisos
nuevos sobre la fixture ampliada.
