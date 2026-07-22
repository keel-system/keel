# Skills por tecnología del stack

Guías de implementación para el código que **no** genera `keel-spring build` porque
depende de la infraestructura elegida. Cada tecnología es una skill independiente
(`keel-spring-<tech>/SKILL.md`) que build instala **condicionalmente** en el
`.claude/skills/` del proyecto generado según `keel-stack.json`: si el broker es
kafka, solo se instala `keel-spring-kafka`, y así con cada categoría. El subagente
`keel-spring-code` las descubre como skills del proyecto.

| Clave en `keel-stack.json` | Valor | Skill |
|---|---|---|
| `broker` | `kafka` | `keel-spring-kafka/` |
| `broker` | `rabbitmq` | `keel-spring-rabbitmq/` |
| `broker` | `snssqs` | `keel-spring-snssqs/` |
| `storage` | `minio` / `s3` | `keel-spring-s3/` (mismo SDK para ambos) |
| `cache` | `redis` / `valkey` | `keel-spring-redis/` (protocolo Redis en ambos) |
| `auth` | `keycloak` | `keel-spring-keycloak/` |
| `auth` | `cognito` | `keel-spring-cognito/` |

Las bases de datos del catálogo no tienen skill propia: todas son relacionales y
el código JPA (espejo `XxxJpa`, `JpaRepository`, adaptador) ya lo genera build de
forma transversal; el datasource va en `parameters/<perfil>/db.yaml`.

Cada skill indica: qué dejó listo build (dependencias, fragmentos de config,
contenedor de prueba, contratos), qué código debe escribir el agente y cómo
validar la tecnología (recetas completas en
`.claude/skills/keel-generate-spring/conventions/infra-validation.md`).
