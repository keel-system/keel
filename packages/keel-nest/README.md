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

## Estado de la frontera (incremento 2)

| Capa | Estado |
|---|---|
| `domain`, `use-cases` | se aceptan; su código llega en el incremento 4 (se avisa) |
| `api` | se acepta; su código llega en el incremento 5 (se avisa) |
| `persistence` | se rechaza → incrementos 6 (relacional, TypeORM) y 12 (documental) |
| `security` | se rechaza → incremento 8 |
| `messaging` | se rechaza → incremento 9 |
| `http-clients`, `dependencies` | se rechazan → incremento 11 |
| `storage`, `mail`, `payments` | se rechazan → incremento 13 |
| telemetría (stack) | se rechaza → incremento 14 |

## Verificación del generador

```bash
npm test --workspace packages/keel-nest        # rasgos de lo emitido, puerta, pasada en seco (sin red)
npm run ts-check --workspace packages/keel-nest # genera, instala, compila, prueba y ARRANCA el proyecto (red, minutos)
```
