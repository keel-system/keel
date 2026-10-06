# Configuración de la base por perfil

`config/parameters/<perfil>/db.yaml`, con el gradiente de Keel:

| Clave | local | develop | production |
|---|---|---|---|
| `database.url` | la de `infra/` (literal) | `${DB_URL:...}` | `${DB_URL}` |
| `database.username` / `password` | literal | `${DB_USERNAME:...}` / `${DB_PASSWORD:...}` | obligatorias |
| `database.pool.max-size` | 10 | `${DB_POOL_MAX_SIZE:10}` | ídem |
| `database.pool.connection-timeout-ms` | 5000 | `${DB_POOL_CONNECTION_TIMEOUT_MS:...}` | ídem |
| `database.transaction-timeout` | 30s | `${DB_TRANSACTION_TIMEOUT:30s}` | ídem — lo cancelado sale 503 `TRANSACTION_TIMEOUT` |
| `database.synchronize` | `true` | `false` | `false` |
| `database.migrations-run` | `false` | `true` | `true` |

El perfil `test` no tiene base (`database.enabled: false`): las pruebas de `test/*.test.ts` arrancan sin
infraestructura, y un repositorio usado ahí falla diciéndolo.

`DB_URL` admite la URL JDBC de keel-spring tal cual (`jdbc:postgresql://host:5432/base`,
`jdbc:mysql://host:3306/base`): el mismo `.env` sirve para los dos servidores del diseño. Los parámetros
de la URL no se trasladan; los que importan tienen su clave.

Un parámetro nuevo va en los **tres** perfiles de despliegue, con su gradiente, y su clave se lee de la
`Configuration` inyectada.
