# keel-nest

Generador **NestJS** para diseños Keel. Hermano de `keel-spring`: el mismo diseño tiene que producir,
con uno u otro, servidores **equivalentes** —mismo contrato HTTP, mismo cable, misma semántica de
fiabilidad, misma operación—. Se construye por incrementos evaluables: el plan y su estado están en
[`PLAN-KEEL-NEST.md`](../../PLAN-KEEL-NEST.md) de la raíz del repo.

## Flujo

El mismo que todos los generadores de Keel, en dos pasos y con un `cd` en medio:

```bash
keel-nest check specs/<servicio>   # opcional: no escribe nada, dice si es generable con keel-nest
keel-nest build specs/<servicio>   # desde el workspace de diseño
cd services/<servicio>-nest
/keel-generate-nest                # dentro del proyecto, sin argumentos (pipeline: incremento 7)
```

## Contrato

1. **Entrada**: el diseño multi-artefacto de `specs/<servicio>/`, validado. La puerta es la de
   `keel-core/gen/design-gate.js`, la misma que usa keel-spring: un diseño que uno rechaza no lo
   genera el otro, y uno no listo (`keel validate --ready` en rojo) solo se genera con
   `--accept-unready`, que queda estampado en `keel-generated.json`.
2. **Compatibilidad**: DSL `2.19` (la misma versión que keel-spring; el método soporta una sola).
3. **Salida**: `services/<servicio>-nest/`, un proyecto NestJS 12 sobre **Fastify**, en ESM sobre
   Node 22.12+, con TypeScript `strict`, Vitest, el **contrato del cable** de `keel-core/gen/wire.js`
   (decimales con su escala, `long` exactos, instantes en UTC con tres decimales), configuración por perfiles (`PROFILE`, `SERVER_PORT`,
   `SHUTDOWN_TIMEOUT`, gradiente literal → `${VAR:default}` → `${VAR}`) y sondas `/livez` y `/readyz`
   con el contrato del servidor de keel-spring.
4. **Regla de oro**: el generador nunca inventa ni corrige funcionalidad. Lo que todavía no sabe
   generar lo **rechaza** nombrando el incremento que lo trae (`src/lib/supported-features.js`); no
   produce un proyecto como si nada.

## Qué comparte con keel-spring

Todo lo que no depende del lenguaje vive en `keel-core/gen` y lo usan los dos: la interpretación del
diseño (`buildModel`, al que keel-nest pasa su proyección TypeScript, `src/lib/ts-projection.js`), la
puerta del diseño, el cuestionario del stack, la escritura con manifiesto (`--refresh`, `--prune`,
`--check`, `--force`), el catálogo de infraestructura, los destinos físicos de mensajería y los
vocabularios de las sondas del arnés.

## Qué genera hoy (incremento 6)

- **Dominio**, TypeScript puro en `src/domain`: enums por su literal, value objects que hacen cumplir
  en su constructor presencia, formato, longitud, cotas y escala (las mismas cotas que keel-spring,
  desde `keel-core/gen/constraints.js`), `<Tipo>Format` para los escalares con formato, agregados con
  estado de rehidratación, getters sin setters y guarda de lifecycle, eventos con su `EventMetadata`,
  la jerarquía de errores por status con los `code` del diseño y `Uuids.v7()`.
- **Aplicación** en `src/application`: un mensaje y un handler por operación (con las notas del diseño,
  terminando en `TODO`), DTOs y mappers, y el `UseCaseMediator` con su contenedor y su módulo en
  `src/infrastructure/usecase`.
- **API REST** en `src/infrastructure/rest`: un controlador por grupo con un lector generado por
  operación (convierte y valida en el orden del binding de Spring, con las reglas neutrales de
  `keel-core/gen`), `ErrorResponse` con la forma y los textos del `ApiExceptionHandler` de keel-spring,
  404/405, `Location` en los 201 y la correlación `X-Correlation-Id` en `AsyncLocalStorage`.
- **Persistencia relacional** (TypeORM, PostgreSQL y MySQL) en `src/infrastructure/persistence`:
  entidades con las MISMAS tablas, columnas, cotas y nombres de constraint, índice y FK que keel-spring
  (`keel-core/gen/relational.js`), un puerto por raíz en `src/domain/repository` con su adaptador y su
  mapeo explícito, la transacción del caso de uso en el mediator (consultas de solo lectura,
  interbloqueo reintentado, tope de transacción → 503), bloqueo optimista con UPDATE condicionado, la
  traducción de cada violación al error del diseño (`keel-core/gen/constraint-errors.js`) y la página
  con el `Pageable` de Spring Data. El perfil `test` no tiene base de datos.
- **Gates en el proyecto**: `npm run check:architecture` (dependency-cruiser: dominio y aplicación sin
  framework) e `infra/check-domain-guards.sh` (las mismas filas que el de keel-spring).

## Estado de la frontera (incremento 6)

| Capa | Estado |
|---|---|
| `domain`, `use-cases` | se generan; `idempotency` y `schedule` de una operación se avisan (incremento 10), `cache` también (13) |
| `api` | se genera (incremento 5); las subidas multipart llegan con `storage` (13) |
| `persistence` | relacional: se genera sobre PostgreSQL y MySQL (los demás motores se rechazan), con la unicidad condicionada (índice parcial o columna discriminadora). Documental: se rechaza → incremento 12 |
| `security` | se rechaza → incremento 8 |
| `messaging` | se rechaza → incremento 9 |
| `http-clients`, `dependencies` | se rechazan → incremento 11 |
| `storage`, `mail`, `payments` | se rechazan → incremento 13 |
| telemetría (stack) | se rechaza → incremento 14 |

## Verificación del generador

```bash
npm test --workspace packages/keel-nest        # rasgos de lo emitido (el dominio, EJECUTADO), sintaxis de las 13 fixtures, paridad con keel-spring (sin red)
npm run ts-check --workspace packages/keel-nest # genera, instala, compila, comprueba la frontera hexagonal, prueba y ARRANCA el proyecto contra PostgreSQL, y compila las 13 fixtures (red, podman/docker, minutos)
npm run db-check --workspace packages/keel-nest # la persistencia contra PostgreSQL y MySQL reales: esquema, cotas, ida y vuelta, versión, unicidad (también la condicionada), plegado, interbloqueo y tope (podman/docker)
npm run matrix --workspace packages/keel-nest   # la matriz de paridad de keel-nest: qué mecanismo genera, quién lo ejecuta, si está falsado (puro)
```
