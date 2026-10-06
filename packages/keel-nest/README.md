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

## Qué genera hoy (incremento 4)

- **Dominio**, TypeScript puro en `src/domain`: enums por su literal, value objects que hacen cumplir
  en su constructor presencia, formato, longitud, cotas y escala (las mismas cotas que keel-spring,
  desde `keel-core/gen/constraints.js`), `<Tipo>Format` para los escalares con formato, agregados con
  estado de rehidratación, getters sin setters y guarda de lifecycle, eventos con su `EventMetadata`,
  la jerarquía de errores por status con los `code` del diseño y `Uuids.v7()`.
- **Aplicación** en `src/application`: un mensaje y un handler por operación (con las notas del diseño,
  terminando en `TODO`), DTOs y mappers, y el `UseCaseMediator` con su contenedor y su módulo en
  `src/infrastructure/usecase`.
- **Gates en el proyecto**: `npm run check:architecture` (dependency-cruiser: dominio y aplicación sin
  framework) e `infra/check-domain-guards.sh` (las mismas filas que el de keel-spring).

## Estado de la frontera (incremento 4)

| Capa | Estado |
|---|---|
| `domain`, `use-cases` | se generan; `idempotency` y `schedule` de una operación se avisan (incremento 10), `cache` también (13) |
| `api` | se acepta; su código llega en el incremento 5 (se avisa) |
| `persistence` | se rechaza → incrementos 6 (relacional, TypeORM) y 12 (documental) |
| `security` | se rechaza → incremento 8 |
| `messaging` | se rechaza → incremento 9 |
| `http-clients`, `dependencies` | se rechazan → incremento 11 |
| `storage`, `mail`, `payments` | se rechazan → incremento 13 |
| telemetría (stack) | se rechaza → incremento 14 |

## Verificación del generador

```bash
npm test --workspace packages/keel-nest        # rasgos de lo emitido (el dominio, EJECUTADO), sintaxis de las 13 fixtures, paridad con keel-spring (sin red)
npm run ts-check --workspace packages/keel-nest # genera, instala, compila, comprueba la frontera hexagonal, prueba y ARRANCA el proyecto, y compila las 13 fixtures (red, minutos)
```
