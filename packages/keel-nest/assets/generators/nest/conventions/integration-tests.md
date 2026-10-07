# Pruebas de integración de los escenarios `FL-*`

Cómo se traduce `specs/validation-scenarios.md` a código en `test/integration/`. Es la convención del
agente `keel-nest-tests` y la referencia de `keel-nest-validate` cuando arbitra un fallo.

**Qué no es**: la suite unitaria. Lo que hay aquí son escenarios end-to-end contra el servidor real y la
infraestructura de `infra/docker-compose.yaml`: el mismo trabajo que antes se hacía con `curl` a mano,
ahora versionado. Y son la traducción de los **mismos** escenarios que el servidor de keel-spring del
diseño ejecuta en JUnit: si uno pasa en un servidor y no en el otro, alguno de los dos no es equivalente.

## La caja negra

Una prueba de flujo importa **solo** de `./support/flow.js` y de `vitest`. Nunca de `src/`: ni un DTO, ni
un comando, ni un enum, ni un error. Lo vigila la regla `flujos-caja-negra` de
`.dependency-cruiser.json`, que `bash infra/check-flows.sh` y `npm run check:architecture` ejecutan. Los
escenarios se expresan con HTTP y JSON.

## El arnés: `test/integration/support/flow.ts`

Lo genera build y **no se edita** (ver § El arnés es del generador). Lo que trae:

| Pieza | Para qué |
|---|---|
| `useFlow()` | registra el ciclo de vida del flujo y devuelve el cliente: arranca el servidor real en un puerto libre (perfil `local`, contra `infra/`), **resetea el estado** (`infra/reset-db.sh`), vuelca la evidencia de cada caso que falla y cierra al terminar |
| `flow.get/post/put/patch/delete(ruta, cuerpo?, cabeceras?)` | una petición HTTP de verdad; nunca lanza por un 4xx/5xx: el status es una aserción |
| `flow.exchange(método, ruta, cuerpo?, cabeceras?)` | cualquier otro verbo |
| `response.status`, `.header(n)`, `.body` | el intercambio crudo |
| `response.json()` | el cuerpo como objeto; **los números pasan por `number`** |
| `response.jsonExact()` | el cuerpo con **cada número como su texto exacto** (`2.50` → `'2.50'`): para afirmar la escala de un decimal o un `long` |
| `ROUTE_BASE` | el prefijo de todas las rutas (basePath + versión) |
| `UUID_SHAPE`, `INSTANT_SHAPE` | matchers de forma para lo generado por el servidor |
| `db(sql)` | una sentencia contra la base de prueba (solo con persistencia): para lo que no se ve por HTTP |
| `resetState()` | el reset, a mano (useFlow ya lo hace al empezar cada flujo) |
| `eventually(cond, ms, msg)` | espera a que algo asíncrono se cumpla |
| `bearer(token)` | la cabecera `Authorization` de un token (solo con capa `security`) |
| `tokenFor(rol, n?)` | token de usuario del rol; `n = 2` es el segundo usuario del mismo rol (titularidad) y `tokenFor('no-role')` el autenticado sin roles |
| `serviceCredential(cliente)` | token `client_credentials` de un cliente del diseño o de la matriz `test-m2m-*`; con `serviceAuth: api-key`, su clave |
| `tokenAs(sub, claims?, rol?)` | una persona con el `sub` exacto del escenario y sus claims (`null` quita uno); solo cuando la identidad del llamante es el claim `sub`, con Keycloak |
| `scopedResource()` | el recurso al que alcanzan los usuarios no exentos del alcance por recurso |
| `apiKey()` | la clave del perfil local con `protocol: api-key` |
| `deliver<Suscripción>(messageId, payloadJson)` | entrega un mensaje en el canal real de esa suscripción, con la envoltura y las cabeceras que declara su contrato (con identidad del emisor, `deliver<S>(messageId, source, payloadJson)`); el **mismo** `messageId` dos veces es la reentrega |
| `deliverMessage(destino, key, body, cabeceras?)` | un mensaje crudo (un evento ajeno del canal, un cuerpo que incumple el contrato) en el exchange (RabbitMQ: falla si no lo enruta) o el topic (Kafka, SNS/SQS) de la fuente; con SNS/SQS, sin el header `eventType` el filtro de la suscripción lo deja fuera |
| `await publishedMessages(canal, n?)` | lo publicado en un canal del diseño desde el reset, como `{ routingKey, properties, body, payload }` (`payload.metadata.eventType`, `payload.data`); con outbox espera antes a que el relay entregue |
| `deadLetterMessages(suscripción, n?)` | lo que acabó en el descarte de esa suscripción; también para la aserción NEGATIVA (un duplicado absorbido no acaba ahí) |
| `await purgeMessages(canal)` | vacía un canal justo antes de la acción cuyo Then afirma que no se publica nada (con Kafka, que no borra, mueve la marca de lectura) |
| `await stopBroker()` / `await startBroker()` | el canal indisponible; `startBroker` espera a que la conexión del servicio vuelva (con SNS/SQS, además resiembra la topología y espera a que la suscripción entregue) |
| `await deadLetteredEvents()` | cuántos eventos se rindió el outbox: el Then natural de un escenario del outbox es que siga en 0 |
| `await abandonOutboxEvent(evento)`, `clearAbandonedOutboxEvents()` | agota los reintentos de un evento pendiente (la rendición, sin esperar 40 intentos) y lo retira después |
| `await pauseOutboxRelay()` / `resumeOutboxRelay()` | deja filas pendientes sin entregar mientras el escenario lo necesite |

Las credenciales salen de `infra/test-credentials.env` (lo escribe build junto a `init-keycloak.sh`):
**no escribas ningún secreto, cliente ni usuario a mano**. Y pide el token **en cada petición**
(`bearer(await tokenFor('editor'))`): dura cinco minutos y la caché lo renueva solo si se le pregunta.

## Una prueba por flujo

```ts
// test/integration/product-creation.test.ts
import { describe, expect, it } from 'vitest';
import { INSTANT_SHAPE, ROUTE_BASE, UUID_SHAPE, useFlow } from './support/flow.js';

describe('FL-PRD-001 · alta de producto', () => {
  const flow = useFlow();
  let productId = '';

  it('FL-PRD-001-A: alta correcta', async () => {
    const response = await flow.post(`${ROUTE_BASE}/products`, '{"sku":"ACM-0001","name":"Martillo","price":{"amount":12.50,"currency":"EUR"}}');
    expect(response.status, response.body).toBe(201);
    productId = response.json().id;
    expect(response.header('location')).toMatch(new RegExp(`/products/${productId}$`));
    expect(response.jsonExact()).toStrictEqual({
      id: UUID_SHAPE,
      sku: 'ACM-0001',
      name: 'Martillo',
      notes: null,
      price: { amount: '12.50', currency: 'EUR' },
      status: 'draft'
    });
  });

  it('FL-PRD-001-B: el sku repetido es 409 SKU_ALREADY_EXISTS', async () => {
    const response = await flow.post(`${ROUTE_BASE}/products`, '{"sku":"ACM-0001","name":"Otro","price":{"amount":1.00,"currency":"EUR"}}');
    expect(response.status, response.body).toBe(409);
    expect(response.json()).toMatchObject({ status: 409, code: 'SKU_ALREADY_EXISTS' });
  });
});
```

Reglas de forma:

- **Un archivo por flujo**, `test/integration/<flujo-en-kebab>.test.ts`, con un `describe` cuyo título
  empieza por el id del flujo.
- **El título de cada caso empieza por su id y dos puntos** (`'FL-PRD-001-A: …'`). De ahí salen la
  matriz de `score-scenarios.sh` y el nombre del volcado de su evidencia. Sin el id, el escenario sale
  `NO_EJERC` aunque se ejecute.
- **`useFlow()` una vez, dentro del `describe`**. El reset es **por flujo**, no entre escenarios: dentro
  de un flujo el escenario A crea el estado que B verifica. Los casos corren en el orden del archivo:
  escríbelos en el orden del documento, y el estado encadenado vive en variables del `describe`.
- Si el `Given` de un flujo depende de datos creados por **otro** flujo, tras el reset no se sostiene:
  es un hueco del diseño, no se siembra a mano.

## Del DSL al cable

Quien escribe estas pruebas no puede mirar el código, así que la forma exacta de la respuesta hay que
**derivarla**, en este orden de precedencia:

1. **`specs/validation-scenarios.md`**: el `Then` literal y las Convenciones de determinación (ausencia
   vs. nulo, orden de las colecciones, escala decimal, colación, formato temporal).
2. **`docs/openapi.yaml`**, si existe: rutas, status y esquemas ya derivados del diseño.
3. **`specs/<capa>.keel.yaml` + `mapping.md`**: la derivación mecánica.
4. Nada más. Lo que estas fuentes no fijan es un `designGap`.

| Qué necesita la prueba | De dónde sale |
|---|---|
| Ruta | `ROUTE_BASE` + `endpoints.<op>.path` de `api.keel.yaml` |
| Path / query / cuerpo | cada `{segmento}` es de la ruta; el resto del `input` va en el cuerpo en `POST`/`PUT`/`PATCH` y como query en `GET`/`DELETE` |
| Status de éxito | `endpoints.<op>.successStatus`; si no se declara, 200, salvo `DELETE` (204) y `create*` (201) |
| Cuerpo de error | `{timestamp, status, error, code, message, details, correlationId}`: se afirman el `code` y el status; el resto por presencia y forma, nunca el `message` literal |
| Página | `{items, page, size, totalElements, totalPages}` |
| Instante | ISO-8601 UTC con **tres** decimales y `Z`: `INSTANT_SHAPE` |
| Decimal | con la escala del diseño: se afirma con `jsonExact()` (`'12.50'`) |
| Campo sin valor | `null` o ausente según la convención del servicio: decide si la clave va en el `toStrictEqual` |
| `PATCH` | ausente ≠ `null` explícito cuando el diseño lo declara: dos escenarios |

## Aserciones: el cuerpo completo o nada

- `toStrictEqual` sobre el cuerpo entero: comprueba los campos presentes **y** que no venga ninguno de
  más. Con `UUID_SHAPE`/`INSTANT_SHAPE` (o `expect.any(String)`) en lo no determinista.
- Para la escala, `jsonExact()`: con `json()` un `12.50` llega `12.5` y un `toStrictEqual` lo daría por
  bueno contra un servidor que perdió la escala.
- Un id o una marca de tiempo **nunca** por literal: por forma, y reutilizado dentro del flujo.
- Un test que solo comprueba el status **no vale**.
- `expect(response.status, response.body)`: el segundo argumento es el mensaje si falla, y el cuerpo es
  lo primero que hay que leer.

## Traducir el `Given`

Cláusula por cláusula, cada una con su llamada de siembra **cuyo status se comprueba**: crear la entidad
no es dejarla en el estado que el escenario declara.

| Cláusula del `Given` | No basta con | Hace falta |
|---|---|---|
| `p1 (active)` | crear `p1` (nace en el estado inicial) | la operación que lo transiciona a `active` |
| `c1 con 3 productos` | crear `c1` | crear los tres y comprobar que quedan asociados |
| `p1 sin imágenes` | crear `p1` | nada más, pero decláralo en un comentario |

Si el `Given` **no se puede materializar por la API**, es `designGap`: no se siembra por la base.
`db(...)` es para **leer** lo que la API no expone (que una escritura llegó al almacén), y solo
excepcionalmente para una precondición que ninguna operación puede fabricar — y entonces se dice en
`assumptions`.

Al aislar una guarda tardía, las anteriores se satisfacen con datos **válidos**: un cuerpo `{}` muere en
otra guarda, con otro `code`, y el escenario mide lo que no es suyo.

### El rescate: la fila que otra réplica dejó a medias

Es la excepción documentada: ninguna operación fabrica «una réplica murió con esta fila en la mano». Cuando
un barrido rescata un estado EN VUELO, `flow.ts` trae tres helpers (y nada más se usa para esto):

| | |
|---|---|
| `stallInFlight(<barrido>, id)` | deja la fila en vuelo con el reloj **infinitamente rancio** |
| `putInFlight(<barrido>, id)` | lo mismo con el reloj **a ahora** |
| `inFlightWithoutClock(<barrido>)` | cuántas filas quedaron en vuelo **sin reloj** (vale cero siempre) |

```ts
const id = await createByApi();
stallInFlight('dispatchJobs', id);                     // como si su réplica hubiera muerto
await eventually(async () => (await statusOf(id)) === 'done', 90_000);
expect(inFlightWithoutClock('dispatchJobs')).toBe(0);
```

- Se mueve una fila **creada por la API**; el helper solo cambia el estado y el reloj.
- La cota es obligatoria y es otro escenario: con `putInFlight` se comprueba que lo recién entrado en vuelo
  **no se toca**. Un rescate sin cota pasa el primero y falla aquí.
- El techo de la espera supera el periodo del barrido (su cron, más el segundo de arranque que build
  reparte) y el plazo del rescate: más corto, el escenario sale verde o rojo según la fase del minuto.

## Checklist antes de cerrar

1. Toda ruta usada existe en `api.keel.yaml` y su verbo coincide.
2. Todo `code` de error está copiado **literal** del diseño.
3. Todo campo del cuerpo esperado está en el `output` de la operación; uno que no, es `designGap`.
4. Ningún valor no determinista se compara por literal.
5. Cada caso con su id exacto delante de los dos puntos.
6. Toda restricción declarada sobre una entrada (`min`, `max`, `minLength`, `maxLength`, `pattern`…)
   tiene su escenario de rechazo con **400** `VALIDATION_ERROR`, aunque el flujo no la nombre.
7. Cada cláusula del `Given` tiene su siembra con su status comprobado.
8. Los decimales se afirman con `jsonExact()`.
9. Ningún import de `src/`.
10. `bash infra/check-flows.sh` en verde.

## El arnés es del generador

`support/flow.ts`, `harness-smoke.test.ts`, la configuración de Vitest y los scripts de `infra/` los
escribe `keel-nest build`. En la fase 1 son de **solo lectura**: sin infraestructura no se puede saber si
están rotos, y lo que falte va a `blockers` con la firma propuesta. En la fase 2, si el árbitro dice
`culprit: harness`, se parchea **al mínimo**, se verifican **todos** los flujos que usan lo tocado y el
parche se registra en `harnessPatches` — es lo que devuelve el defecto al generador. Un defecto fuera de
`test/integration/` (`infra/`, `package.json`) no se toca: va a `blockers` y lo corrige el orquestador.

## Lo que se declara en vez de simularse

Un escenario que el diseño no permite ejercitar de forma determinista **no se inventa**: va a
`uncovered` con su motivo. Nada de dobles de prueba ni de servidores simulados: lo que se valida es el
servidor real contra la infraestructura levantada.

## Ejecución

```bash
bash infra/check-flows.sh                                   # compilan y respetan la caja negra (fase 1)
npx vitest run --config vitest.integration.config.ts test/integration/<flujo>.test.ts   # un flujo (fase 2)
bash infra/score-scenarios.sh                               # la suite y la matriz (lo ejecuta el orquestador)
```

Cada fallo deja `build/keel-failures/<FL-id>.json` (escenario, aserción, la última petición y respuesta,
el último sondeo) y un flujo que no arranca, `build/keel-failures/<flujo>-init.json`: sus casos salen
OMITIDOS.
