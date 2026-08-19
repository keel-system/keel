# Skills por tecnología del stack

Guías de trabajo por tecnología para lo que **no** genera `keel-spring build`
porque depende de la infraestructura elegida (código de adaptadores, tuning de
configuración, preparación de entorno y validación). Cada tecnología es una
skill independiente que build instala **condicionalmente** en el
`el directorio de skills/` del proyecto generado: si el broker es kafka, solo se instala
`keel-spring-kafka`, y así con cada categoría. El subagente `keel-spring-code`
las descubre como skills del proyecto.

La mayoría se gatean por **stack** (`keel-stack.json`); dos excepciones,
`keel-spring-httpclient` y `keel-spring-mail`, se gatean por **presencia de capa de
diseño**: ni las integraciones HTTP salientes ni el correo son elecciones de stack
—no hay proveedor que elegir en build; se decide al desplegar— sino parte del
diseño del servicio.

| Clave en `keel-stack.json` | Valor | Skill |
|---|---|---|
| `database` | `postgresql` / `mysql` / `mariadb` / `sqlserver` / `oracle` / `h2` | `keel-spring-database/` (skill única, reference por dialecto) |
| `database` | `mongodb` | `keel-spring-mongodb/` |
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
| `mail` (correo saliente por SMTP, con plantillas) | `keel-spring-mail/` |

`keel-spring-mail` es la única cuyo adaptador **ya está escrito**: build genera el
`SmtpMailSender` y el renderizador enteros, porque las dos defensas que llevan dentro
—el saneado del asunto y el escapado de las variables— no aparecen en el camino de
menor resistencia de nadie y su ausencia no rompe ninguna prueba. La skill existe para
explicar qué NO tocar y para cubrir lo que sí es del agente: cuándo y dónde sale el
correo respecto a la transacción.

`database` es la única clave con **dos** skills, y no por tamaño: los seis dialectos
relacionales comparten mapeo (JPA) y solo difieren en un reference por dialecto,
mientras que el modelo documental no comparte nada con ellos —otro espejo, otros
índices, otra transaccionalidad—. Cuál se instala lo decide `persistence.default.model`
del diseño, que es también quien decide qué motores ofrece el cuestionario.

Ninguna de las dos enseña a escribir el código de persistencia: el espejo (`XxxJpa` o
`XxxDocument`), los repositorios de Spring Data y los adaptadores ya los genera build
de forma transversal, y la conexión va en `parameters/<perfil>/db.yaml`.
`keel-spring-database` cubre tuning (Hikari, Hibernate), migraciones,
particularidades del dialecto y validación; `keel-spring-mongodb`, índices,
transacciones sobre replica set, `$lookup` y evolución de documentos.

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
tecnología (recetas completas en `docs/keel/conventions/infra-validation.md`).
