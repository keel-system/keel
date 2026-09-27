# Recomendaciones para robustecer Keel — MVP PostgreSQL · MySQL · MongoDB

> Análisis del 2026-09-27 sobre `main` (`0c6b228`). Fuentes:
> - la salida de `npm run matrix`;
> - los scripts en vivo de `packages/keel-spring/package.json`;
> - las fixtures de `packages/keel-spring/test/fixtures/`;
> - las corridas de `docs/corridas/`;
> - `analisis.md`;
> - `.claude/rules/spring-persistencia.md`.

## 1. Punto de partida

El MVP promete **equivalencia entre motores**: el mismo diseño tiene que dar la misma garantía sobre PostgreSQL, MySQL y MongoDB. Todo lo que sigue se mide con esa vara.

### Lo que ya está sólido (no conviene tocarlo)

| Área | Estado |
|---|---|
| Outbox (reclamo, backoff, purga, rendición) | verificado y falsado en las dos ramas (`store-check`) |
| Idempotencia de petición y de consumo | verificado y falsado en las dos ramas (`store-check`) |
| Reclamo de reconciliación | verificado y falsado en las dos ramas (`store-check`) |
| Barridos de cola y de rescate, guarda de fila | verificado y falsado en las dos ramas (`claim-check`) |
| Sondas del arnés contra la base | verificado y falsado (`claim-check` / `mongo-check`) |
| Unicidad condicionada al estado | verificado y falsado en pg, mysql y mongo (`index-check`) |
| Mapeo del espejo de persistencia | verificado y falsado en las dos ramas (`mapping-check`) |
| Paridad relacional↔documental | atada por pares byte a byte (`job-dispatch[-mongo]`, `notification-mailer[-mongo]`) |

La disciplina de **medir por mutación** (romper el mecanismo conservando su forma y exigir que la red se ponga roja) es lo mejor del sistema. Todas las recomendaciones de abajo la reutilizan.

### Cifras de la matriz

- 52 celdas en total.
- 35 verificadas; de ellas, 32 falsadas y 3 sin falsar.
- 11 sin ejecutar, 2 degradadas y 4 que no aplican.
- De las 11 sin ejecutar, **9 son de motores fuera del MVP** (MariaDB, SQL Server, Oracle). Dentro del MVP quedan 2, más las 3 sin falsar.

## 2. Huecos encontrados dentro del alcance del MVP

| # | Hueco | Por qué importa | Evidencia |
|---|---|---|---|
| A | **No hay CI** | Todo el aparato determinista (`npm test`, `keel index --check`, `matrix`) se ejecuta a mano, con paquetes ya publicados en npm. Una regresión llega a npm sin que nadie la vea | no existe `.github/`; la suite de spring tarda unos 9 min |
| B | **La evolución del esquema después de V1 no tiene red** | El servicio se despliega bien la primera vez. La **segunda versión del diseño** es la que rompe producción: una columna nueva sin `V2__` hace que `ddl-auto: validate` impida arrancar, y un campo renombrado en Mongo deja documentos viejos ilegibles | `schema-baseline/relational` está `razonado`; el agente devuelve `baselineTested: PENDING`; `V<n>__` solo es prosa en `keel-spring-database/references/migrations.md`; en Mongo, prosa en `document-mapping.md`; `evolution.js` no menciona migraciones |
| C | **MySQL y Mongo tienen menos cobertura que PostgreSQL en las redes de extremo a extremo** | La equivalencia se prueba mecanismo a mecanismo, pero no con el servicio entero arrancado | `compile-check` no incluye ninguna fixture con `--database=mysql`; `deploy-check` solo corre `job-dispatch` (pg); `telemetry-check` no corre MySQL; las 4 corridas de `docs/corridas/` son PostgreSQL |
| D | **`folded-text` (DSL 2.14, `compare`) sin ejecutar** | Es una garantía de **unicidad** («ACME» y «acme» son el mismo): justo el tipo de defecto silencioso que ya costó una corrida con la collation | matriz: `??` en relational y document; ninguna fixture documental declara `compare` |
| E | **Tres celdas sin falsar** | Hay evidencia, pero nadie ha comprobado que la red se ponga roja cuando se rompe el mecanismo | `telemetry-store-spans` (las 2 ramas; solo corridas del 2026-09-19, sin script que se pueda repetir) y `unique-collation/postgresql` |
| F | **El cuestionario ofrece motores fuera del MVP sin avisar** | Quien elige Oracle hereda en silencio código que ninguna red ha ejecutado, y ese ruido tapa en la matriz el estado real del MVP | `stack-catalog.js` y `prompt.js` no mencionan el estado de verificación |
| G | **El README se ha quedado atrás** | Es lo primero que se lee | `README.md:164` y `:393` dicen 46/31/30, «87 suites», «8 redes»; la realidad es 52/35/32, 93 archivos de test y 11 scripts |

## 3. Recomendaciones, en orden de prioridad

### Paso 1 — CI mínima · esfuerzo: días · hueco A

**Qué hacer**

1. Crear `.github/workflows/ci.yml` con tres jobs:
   - `test`: `npm ci && npm test` en Node 18 y 22.
   - `matrix`: `npm run matrix`. Al principio solo informa; será puerta cuando exista el filtro del paso 5.
   - `live-db`, nocturno o manual: servicios de GitHub para PostgreSQL, MySQL y MongoDB (este como replica set) y, sobre ellos, `store-check`, `claim-check`, `index-check`, `mapping-check` y `mongo-check`.
2. Un job `compile-check` nocturno, con JDK, limitado a las fixtures que tocan persistencia.

**Qué comprobar antes:** si los scripts de `packages/keel-spring/scripts/` pueden usar un motor ya levantado, o solo saben levantarlo ellos con podman/docker. Si es lo segundo, añadir un modo `--external` (host y credenciales por variables de entorno) en el helper común.

**Por qué primero:** es la mejor relación valor/esfuerzo del repo, y todo lo que se añada después queda protegido.

---

### Paso 2 — Red de evolución del esquema · esfuerzo: 1–2 semanas · hueco B

Es **el hueco estructural más grande** para un MVP centrado en bases de datos.

**2a. Rama relacional: nuevo `schema-check`**

- Archivos: `scripts/schema-check.js` + `src/lib/schema-probes.js`, con el patrón de `store-probes.js` y `mapping-probes.js`.
- Flujo:
  1. Generar la fixture.
  2. Exportar el baseline con `infra/export-schema.sh`.
  3. Base limpia → `flyway migrate` → arrancar con `ddl-auto: validate` → afirmar que el contexto carga.
  4. Repetir con una **versión v2** de la fixture que traiga un cambio aditivo (columna nueva) y uno delicado (renombre o cambio de tipo). El delta sale de `design-delta.js` y se escribe un `V2__` siguiendo la skill.
- Motores: PostgreSQL y MySQL.
- Resultado: `schema-baseline/relational` pasa de `razonado` a `verificado`.
- Falsación: quitar una columna del `V2__` tiene que poner `schema-check` en rojo.

**2b. Gate en el proyecto generado**

Cuando `evolution.json` indique cambios en `domain`/`persistence` que afecten a columnas, un gate (`infra/check-migrations.sh`, hermano de `check-idempotency.sh`) exige un `V<n>__` nuevo. El reparto es el de siempre: **build detecta, el agente escribe, el gate verifica**. Recién generado tiene que salir ROJO.

**2c. Rama documental: formalizar la migración de datos**

- Hoy `document-mapping.md` pide «dejarlo escrito en el README».
- Propuesta: cuando el delta renombre un campo, le cambie el tipo o lo mueva, build emite `infra/migrations/<n>__<desc>.js` (mongosh) con un runner idempotente que registra lo aplicado en una colección `_keel_migrations`.
- Regla: los scripts salen de `mongo-probes.js`, nunca como literales.
- Red: `mongo-check`.

**2d. Riesgo que hay que medir, no suponer**

Qué pasa cuando `MongoIndexConfig` encuentra un índice existente con el **mismo nombre y otras opciones** (unique o partial cambiados). MongoDB responde con `IndexOptionsConflict` y el arranque puede morir en la réplica nueva. Hay que añadir el caso v1→v2 a `index-check`.

---

### Paso 3 — Paridad de las redes de extremo a extremo · esfuerzo: días + dos corridas · hueco C

- `compile-check`: añadir `job-dispatch --database=mysql` y `notification-mailer --database=mysql`. El Java cambia de verdad (el `columnDefinition` con collation y el apéndice SQL).
- `deploy-check`: añadir `job-dispatch --database=mysql` y `job-dispatch-mongo`.
- `telemetry-check`: añadir una fixture sobre MySQL.
- **Dos corridas reales con el agente**, una en MySQL (`notification-mailer --database=mysql`) y otra en Mongo (`notification-mailer-mongo`). Se documentan en `docs/corridas/` y se miden por la **huella contra `keel-generated.json`**, no por el informe del agente, que es el método que ya dio resultado.

---

### Paso 4 — Cerrar las celdas del MVP sin verificar o sin falsar · esfuerzo: días · huecos D y E

| Celda | Cómo cerrarla | Cómo falsarla |
|---|---|---|
| `folded-text/relational` | caso en `mapping-check` que inserta `ACME`, `acme` y una variante con acento, sobre pg y mysql, y afirma el rechazo | quitar el plegado en `toJpa` |
| `folded-text/document` | lo mismo en la rama Mongo; antes, crear una fixture documental que declare `compare` (y retirar su excepción de `capability-coverage`) | quitar el plegado en el espejo documental |
| `telemetry-store-spans` (2 ramas) | que `telemetry-check` ejecute algo que **sí** toque la base: un barrido programado (ya consulta) o un handler de lectura completo de fixture, y afirmar el span con `db.system` en el colector | desactivar el listener de Mongo o la instrumentación JDBC |
| `unique-collation/postgresql` | ya está verificado | forzar una collation que pliega (ICU nondeterministic) y ver el rojo |

**Objetivo:** con `npm run matrix`, **todas las celdas del MVP verificadas y falsadas**.

---

### Paso 5 — Acotar lo que queda fuera del MVP · esfuerzo: 1–2 días · hueco F

- Añadir un `tier: 'mvp' | 'experimental'` a cada entrada de `DATABASES` (`stack-catalog.js`).
- `prompt.js`: los experimentales aparecen marcados o detrás de un flag.
- `build` avisa en voz alta al elegir uno. Ese aviso se **deriva** de `engine-support.js`, igual que `engine-limits.js` ya deriva el de lo degradado.
- `support-matrix.js --mvp`: filtra a los tres motores y sirve de **puerta de CI**: cero celdas `razonado` y cero sin falsar dentro del MVP.
- No se borra código: se deja de prometer.

---

### Paso 6 — Higiene · esfuerzo: horas · hueco G

- Actualizar las cifras del README.
- Mejor: un test que compare los números del README con el resumen que calcula `support-matrix.js`, para que no vuelvan a desfasarse.

## 4. Fuera de esta tanda (a propósito)

- **Segundo generador** (`analisis.md` §3): es estratégico para la tesis del producto, pero no robustece el MVP de bases de datos.
- **Revisión semántica con ids y mutación en keel-core** (`analisis.md` §5): valioso cuando el paso 4 esté cerrado.
- **SQL Server, MariaDB, Oracle**: quedan como experimentales (paso 5) hasta que el MVP esté cerrado.

## 5. Resumen para planificar

| Paso | Hueco | Esfuerzo | Dependencias | Resultado medible |
|---|---|---|---|---|
| 1. CI | A | días | — | PR con `npm test` en verde automático; `live-db` nocturno |
| 2. Evolución del esquema | B | 1–2 semanas | 1 (para protegerlo) | `schema-check` en verde y falsado; `schema-baseline` verificado; gate `check-migrations.sh` |
| 3. Paridad e2e | C | días + 2 corridas | 1 | mysql y mongo en `compile/deploy/telemetry-check`; 2 corridas documentadas |
| 4. Celdas pendientes | D, E | días | — | `folded-text` y `telemetry-store-spans` verificados y falsados |
| 5. Tier de motores | F | 1–2 días | 4 (para que la puerta pase) | `matrix --mvp` como puerta de CI |
| 6. README | G | horas | 5 | cifras atadas a la matriz por test |

**Orden sugerido:** 1 → 4 → 5 → 2 → 3 → 6.

Hacer primero lo barato (1, 4 y 5) deja el MVP con una puerta objetiva: todas sus celdas verificadas. Encima de eso se construye lo caro (2, la evolución del esquema), que es lo que separa «se despliega» de «se puede mantener en producción».

## 6. Criterio de «hecho» en cada paso

Cada red nueva se **falsa** antes de darla por buena. Hay que romper el mecanismo conservando su forma y comprobar que la red se pone roja. Una red que nunca se ha visto fallar no mide nada.
