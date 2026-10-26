# M0 de MySQL: show-ticketing, paso 0 y ronda 0 a mano

| Etiqueta | Valor |
|---|---|
| Plan | `PLAN-KEEL-RECOVER-MYSQL.md`, incremento M0 (banco a mano antes de escribir `db/mysql.js`) |
| Legacy | `show-ticketing` @ `7eacae89` (repinado desde su HEAD 9c8e8c8, cuyo login da siempre 500) |
| Operador | el agente que escribió la hoja: **fidelidad contaminada**; esfuerzo, convergencia y determinismo, no |
| Sandbox | `../keel-recover-lab/show-ticketing/sandbox/compose.yaml`: MySQL 8.0.26 maestro y réplica **sin replicar** (el detector de ST-ENV-10), dos Redis 6.2.5, red `internal: true`, imágenes por digest; esquema desde `etc/` por initdb |
| Ejecutor de sondas | `../keel-recover-lab/tools/probe.mjs` con su rama MySQL nueva (exportación por fila, `_auto_increment`, `mysqldump`/`mysql <`), la caché Redis como canal y la sesión por cookie en cabecera |
| Código del legacy | intacto |
| Diario | `../keel-recover-lab/show-ticketing/LOG.md` |

## Las preguntas M-*

| id | Estado | Dónde | Respuesta |
|---|---|---|---|
| M-01 | measured (a medias) | ST-ENV-11 | `mysql < dump` restaura con 10 sesiones ociosas de Hikari conectadas (1,5 s). **Con una transacción abierta, sin medir**: la app no abre ninguna (ST-ENV-09). Se mide con la fixture de M2 |
| M-02 | measured | ST-ENV-11 | `information_schema.tables.AUTO_INCREMENT` está en caché (`information_schema_stats_expiry` 86400): la huella lee con `SET SESSION information_schema_stats_expiry = 0` |
| M-03 | measured | ST-ENV-11, S0-025 | una inserción que falla por FK consume el contador (`innodb_autoinc_lock_mode` 2); reservar y cancelar deja `reservation` 1 → 2 sin fila |
| M-04 | measured | ST-ENV-11 | el dump lleva `AUTO_INCREMENT=` y la restauración lo devuelve, el consumido incluido |
| M-05 | measured | ST-ENV-12 | una línea de `JSON_OBJECT` por fila en orden de la PK, con `-r`: `-B` reescapa las barras y deja el JSON inválido |
| M-06 | measured | ST-ENV-12 | `DECIMAL` a texto (como número JSON pierde la escala), binario con `HEX()` (si no, `"base64:type15:…"`), `DATETIME` `"YYYY-MM-DD HH:MM:SS.ffffff"`, `TINYINT(1)` 0/1. La fecha cero y `TIMESTAMP` en otra zona, sin medir: sql_mode estricto y sin columnas `TIMESTAMP` |
| M-07 | measured | ST-MODEL-02 | las nueve tablas en `utf8mb4_0900_ai_ci` (una la declara, las otras la heredan); sin ninguna `UNIQUE`: la unicidad sin mayúsculas está en la app y se ve en la API |
| M-08 | measured | ST-ENV-11 | `STRICT_TRANS_TABLES` (el default de 8.0), REPEATABLE-READ, `time_zone` SYSTEM (UTC), leídos del servidor; el `sql_mode` de la sesión de la app, sin leer |
| M-09 | no aplica | — | el esquema no tiene `ON UPDATE` ni `DEFAULT CURRENT_TIMESTAMP`: fixture de M2 |
| M-10 | no aplica | — | todo InnoDB: fixture de M2 |
| M-11 | no aplica | — | sin triggers ni rutinas (el dump los pide igual): fixture de M2 |
| M-12 | measured | ST-ENV-08 | Connector/J 8.0.22 habla `caching_sha2_password`: sin adaptación |
| M-13 | measured | ST-ENV-11 | el usuario de la app no tiene `PROCESS`: `mysqldump --no-tablespaces` |

**Versión mínima: MySQL 8.0** (el DDL del legacy no carga en 5.7). 5.6 y 5.7 siguen fuera con motivo.

## Ronda 0

30 sondas desde los flujos de la API (alta, login, recinto, espectáculo, precios, funciones, asientos,
reserva, cancelación, favoritos, cuenta y acceso), cada una desde el snapshot. El legacy no trae seed: el
snapshot es lo que dejan sus propias operaciones (dos usuarios, un recinto con dos salas, un espectáculo con
precios y una función de 12 asientos), sembrado por la API y escrito en `round-0.yaml`.

| Medida | Valor |
|---|---|
| Sondas | 30, una pasada en 2 min 45 s |
| Determinismo | **30/30** grabaciones iguales en dos pasadas (ignorando `_timeSeconds`) |
| Cobertura de la ronda sola | 811/945 líneas (86 %), 116/145 ramas (JaCoCo reiniciado con `dump --reset` antes) |
| Hoja | 63 measured, 3 refuted, 3 read (69 hechos; ST-ENV-12 nuevo, ST-EFF-06 de read a measured) |

Para que repitiera hubo que arreglar dos cosas en el ejecutor, y las dos le tocan a `probe`:

1. **La caché de 3 s** (`RedisCacheConfig.java:65,67`) caducaba durante la espera de 1,5 s más la
   exportación, y el canal de caché grababa la clave unas veces sí y otras no. La caché se lee justo tras el
   último paso, antes de la espera, y una clave que caduca entre el `SCAN` y el `TTL` (-2) cuenta como «con
   TTL».
2. **`reserveDate` es `CURDATE()`**: un `DATE` sin hora que la normalización de fechas ISO no casa. Se
   normaliza la fecha UTC del día como `<today>`.

Restaurar la base no vacía Redis: sin vaciar la caché antes de cada sonda, una lectura cacheada por la sonda
anterior contesta con datos que el snapshot ya no tiene. La caché de sesiones no se toca (guarda los logins).

## Lo que esto pide a keel-recover

- **`db/mysql.js` (M1)**: todo lo de ST-ENV-11 y ST-ENV-12. Las salidas de la rama MySQL de `probe.mjs` y las
  grabaciones de `recordings/round-0/` son las salidas grabadas de las pruebas puras.
- **`probe`**: la caché como canal de efectos (hoy no existe en la herramienta), leída antes de la espera; la
  normalización del día; y la sesión por cookie en cabecera para `then_parallel` (LOG.md).
- **El juez**: la lectura que da 200 con la base vacía es `/search?keyword=x`; `/actuator/health` da 500.
