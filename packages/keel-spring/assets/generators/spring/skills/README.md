# Skills por tecnología del stack

Guías de trabajo por tecnología para lo que **no** genera `keel-spring build`
porque depende de la infraestructura elegida (código de adaptadores, tuning de
configuración, preparación de entorno y validación). Cada tecnología es una
skill independiente que build instala **condicionalmente** en el
`.claude/skills/` del proyecto generado: si el broker es kafka, solo se instala
`keel-spring-kafka`, y así con cada categoría. El subagente `keel-spring-code`
las descubre como skills del proyecto.

La mayoría se gatean por **stack** (`keel-stack.json`); una excepción,
`keel-spring-httpclient`, se gatea por **presencia de capa de diseño** (la capa
`http-clients` no es una elección de stack, sino parte del diseño del servicio).

| Clave en `keel-stack.json` | Valor | Skill |
|---|---|---|
| `database` | `postgresql` / `mysql` / `mariadb` / `sqlserver` / `oracle` / `h2` | `keel-spring-database/` (skill única, reference por dialecto) |
| `broker` | `kafka` | `keel-spring-kafka/` |
| `broker` | `rabbitmq` | `keel-spring-rabbitmq/` |
| `broker` | `snssqs` | `keel-spring-snssqs/` |
| `storage` | `minio` / `s3` | `keel-spring-s3/` (mismo SDK para ambos) |
| `cache` | `redis` / `valkey` | `keel-spring-redis/` (protocolo Redis en ambos) |
| `auth` | `keycloak` | `keel-spring-keycloak/` |
| `auth` | `cognito` | `keel-spring-cognito/` |

| Capa de diseño | Skill |
|---|---|
| `http-clients` (integraciones HTTP salientes con RestClient + resilience4j) | `keel-spring-httpclient/` |

`keel-spring-database` no enseña a escribir código JPA — el espejo `XxxJpa`,
los `JpaRepository` y los adaptadores ya los genera build de forma transversal
y el datasource va en `parameters/<perfil>/db.yaml` —: cubre tuning
(Hikari, Hibernate), particularidades del dialecto elegido y validación.

## Estructura (progressive disclosure)

Cada skill es un directorio que build copia **completo** al proyecto:

```
keel-spring-<tech>/
  SKILL.md            # punto de entrada conciso: frontera, qué dejó build,
                      # lo mínimo para producir código correcto y la tabla
                      # de referencias (qué reference leer y cuándo)
  references/
    configuration.md  # propiedades por perfil, tuning y qué NO tocar
    implementation.md # patrones de código y buenas prácticas (skills de código)
    environment.md    # preparación de entorno (skills de auth)
    troubleshooting.md# síntoma → causa → arreglo
```

Los `references/` se leen **bajo demanda** según la tabla «Referencias» del
SKILL.md, nunca todos de golpe: el SKILL.md basta para el caso simple.

Cada skill indica: qué dejó listo build (dependencias, fragmentos de config,
contenedor de prueba, contratos), qué le toca al agente y cómo validar la
tecnología (recetas completas en `.claude/conventions/infra-validation.md`).
