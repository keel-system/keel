# keel-nest

Generador **NestJS** para diseños [Keel](https://github.com/keel-system/keel). Es el hermano de `keel-spring`, y lo
gobierna una sola regla: **el mismo diseño genera, con uno u otro, servidores equivalentes**. Equivalentes quiere
decir el mismo contrato HTTP y el mismo cable, los mismos eventos y destinos, las mismas tablas, la misma semántica
de fiabilidad, la misma operación y las mismas series de telemetría. Lo que no depende del lenguaje no lo escribe
keel-nest: lo comparte con keel-spring desde `keel-core/gen`. Cómo se construyó, incremento a incremento y con
qué se midió cada uno, está en [`PLAN-KEEL-NEST.md`](../../PLAN-KEEL-NEST.md).

## Uso

```bash
npm i -g @keel-system/keel-nest   # comando `keel-nest`

keel-nest check specs/<servicio>   # opcional, antes de cerrar el diseño: no escribe nada
keel-nest build specs/<servicio>   # en el workspace de diseño; pregunta el stack
cd services/<servicio>-nest
/keel-generate-nest                # dentro del proyecto, SIN argumentos
```

Es el mismo flujo de dos pasos que keel-spring, con las mismas opciones: `--accept-unready`, `--defaults`,
`--refresh`, `--prune`, `--check`, `--force` y `--telemetry otel|none`. `build` no escribe nada en el workspace de
diseño. `check` imprime además el `design-gaps.yaml` que haya dejado una generación.

## Contrato

1. **Entrada**: el diseño multi-artefacto de `specs/<servicio>/`, validado. La puerta es la de keel-spring
   (`keel-core/gen/design-gate.js`): un diseño que uno rechaza no lo genera el otro. Un diseño no listo
   (`keel validate --ready` en rojo) solo se genera con `--accept-unready`, que queda estampado en
   `keel-generated.json`.
2. **DSL soportada**: `2.23`, la misma que keel-spring. El método soporta una sola versión.
3. **Salida**: `services/<servicio>-nest/`, un proyecto NestJS 12 sobre **Fastify**, en ESM sobre Node 22.12+,
   con TypeScript 6 en `strict` y Vitest 5. Trae la arquitectura hexagonal con CQRS (`src/domain`,
   `src/application` sin Nest, `src/infrastructure`), el contrato del cable de `keel-core/gen/wire.js`, los perfiles
   `local`/`develop`/`production`/`test` con las variables de entorno de keel-spring, las sondas `/livez` y
   `/readyz`, la infraestructura de prueba en `infra/` y el despliegue en `deploy/`. Incluye también el
   conocimiento del agente (la skill orquestadora, cinco agentes y las skills del stack), proyectado a Claude Code
   y a opencode.
4. **Regla de oro**: el generador nunca inventa ni corrige funcionalidad. Lo que no sabe generar lo **rechaza**
   en build, diciendo por qué (`src/lib/supported-features.js`). No produce un proyecto como si nada.

## Qué genera build y qué deja al agente

Es el mismo reparto que keel-spring: build genera de forma determinista todo lo transversal al stack, y el agente
escribe la lógica de negocio y lo que depende del broker, del proveedor o del almacenamiento elegido. Lo que genera
build:

- el **dominio**: value objects que hacen cumplir sus cotas, agregados con su lifecycle, eventos y la jerarquía de
  errores con los `code` del diseño;
- la **aplicación**: un mensaje y un handler por operación con las notas del diseño, el `UseCaseMediator` con su
  transacción y el despacho entre casos de uso;
- la **API**: un lector generado por operación (sin `class-validator`), `ErrorResponse` byte a byte, paginación,
  `Location`, idempotencia de petición y subidas multipart;
- la **persistencia**: relacional con TypeORM sobre PostgreSQL y MySQL, con las mismas tablas, columnas, índices
  y FK que keel-spring; documental con el driver oficial de MongoDB, con el mismo documento que keel-spring;
- la **mensajería** sobre RabbitMQ, Kafka o SNS/SQS: envoltura, outbox con relay, registro de procesados, reintento
  y descarte;
- la **seguridad** con Keycloak o Cognito: el plan de acceso neutral en un hook `onRequest`, alcance por recurso e
  identidad del llamante;
- los **barridos y la fiabilidad**: reloj, reclamos con rescate, guardas de efectos irreversibles, reconciliación y
  purgas por lotes;
- las **integraciones**: los clientes HTTP salientes con la resiliencia de resilience4j y los `needs` (bajo demanda,
  réplica y último valor conocido);
- las **capas de borde**: correo SMTP, pagos con Stripe o MercadoPago, caché en Redis o Valkey y almacenamiento S3;
- la **telemetría** con OpenTelemetry (las mismas series que keel-spring, para el mismo panel y las mismas alertas)
  y los logs ECS;
- los **gates** del proyecto: frontera hexagonal, idempotencia, guardas de dominio, logs y cardinalidad.

El pipeline `/keel-generate-nest` orquesta `keel-nest-code`, `keel-nest-infra` y `keel-nest-tests` en paralelo.
Después puntúa los escenarios con `infra/score-scenarios.sh`; si hay algo en rojo lo arbitra `keel-nest-validate`, y
al final pasa `keel-nest-quality`. La generación termina con el 100 % de los escenarios `FL-*` en OK contra la
infraestructura real. Si el diseño cambia después, `build --refresh --prune` deja
`build/keel-refresh/EVOLUTION.md` y la skill entra en modo evolución.

## La frontera, comparada con keel-spring

Toda fixture del repo se genera entera con keel-nest. Lo que todavía rechaza o degrada respecto a keel-spring se
dice en código, cada cosa con su motivo:

| Qué | keel-nest | Por qué |
|---|---|---|
| MariaDB, SQL Server y Oracle | se rechazan en build | keel-spring los genera, pero ninguna red de este repo los ha arrancado: en su matriz están sin ejecutar o degradados. Entran cuando una red los mida, para los dos |
| un value object compuesto en la ruta, la query o una cabecera de una llamada saliente | se rechaza en build | no tiene forma en una URL. **keel-spring lo rechaza igual**, con el mismo mensaje (`keel-core/gen/outbound-params.js`) |
| la serie del pool del driver de MongoDB | degradado | el driver no expone sus contadores sin suscribirse a sus eventos: sin serie no hay celda en el panel ni alerta de saturación |
| los spans de los drivers (SQL, MongoDB, Redis) | degradado | en ESM la instrumentación automática exige un loader hook; la traza llega al span del caso de uso y se para ahí |

La matriz entera, mecanismo a mecanismo y con la red que ejecuta cada celda: `npm run matrix`.

## Verificación del generador

```bash
npm test --workspace packages/keel-nest                 # sin red: rasgos de lo emitido, sintaxis de todas las fixtures, lo emitido EJECUTADO y la paridad con keel-spring
npm run ts-check --workspace packages/keel-nest         # genera, instala, compila con strict todas las siluetas, prueba y ARRANCA el proyecto (red, podman/docker)
npm run db-check --workspace packages/keel-nest         # la persistencia contra PostgreSQL y MySQL reales
npm run doc-check --workspace packages/keel-nest        # la persistencia documental contra un MongoDB real en replica set
npm run harness-check --workspace packages/keel-nest    # el arnés de integración contra su infra/ real
npm run doc-harness-check --workspace packages/keel-nest # el arnés documental y el baseline de índices
npm run broker-check --workspace packages/keel-nest     # la mensajería contra RabbitMQ, Kafka y LocalStack
npm run security-check --workspace packages/keel-nest   # la seguridad contra un Keycloak real
npm run stub-check --workspace packages/keel-nest       # clientes salientes y pasarelas contra un WireMock real
npm run mail-check --workspace packages/keel-nest       # el correo contra un Mailpit real
npm run cache-check --workspace packages/keel-nest      # la caché contra Redis y Valkey
npm run telemetry-check --workspace packages/keel-nest  # la telemetría con la app arrancada
npm run deploy-check --workspace packages/keel-nest     # deploy/ entero, con las sondas que comparte con keel-spring
npm run matrix --workspace packages/keel-nest           # la matriz de paridad (puro)
```

## Compatibilidad

| Paquete | DSL Keel | Necesita |
|---------|----------|----------|
| keel-nest 0.1.x | `keel: "2.23"` | Node.js >= 18 para el generador; Node.js 22.12+ y Docker o Podman para el proyecto generado |
