# Referencias por tecnología del stack

Guías de implementación para el código que **no** genera `keel-spring build` porque
depende de la infraestructura elegida. El agente (`/keel-generate-spring`) lee
`services/<servicio>-spring/keel-stack.json` y carga **solo** las referencias de
las tecnologías seleccionadas; las demás no aplican.

| Clave en `keel-stack.json` | Valor | Referencia |
|---|---|---|
| `broker` | `kafka` | `kafka.md` |
| `broker` | `rabbitmq` | `rabbitmq.md` |
| `broker` | `snssqs` | `snssqs.md` |
| `storage` | `minio` / `s3` | `s3.md` (mismo SDK para ambos) |
| `cache` | `redis` / `valkey` | `redis.md` (protocolo Redis en ambos) |
| `auth` | `keycloak` | `keycloak.md` |
| `auth` | `cognito` | `cognito.md` |

Las bases de datos del catálogo no tienen referencia propia: todas son
relacionales y el código JPA (espejo `XxxJpa`, `JpaRepository`, adaptador) ya lo
genera build de forma transversal; el datasource va en `parameters/<perfil>/db.yaml`.

Cada referencia indica: qué dejó listo build (dependencias, fragmentos de
config, contenedor de prueba, contratos), qué código debe escribir el agente y
cómo validar la tecnología (recetas completas en `conventions/infra-validation.md`).
