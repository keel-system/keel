# Fallos típicos de la persistencia

| Síntoma | Causa habitual | Qué hacer |
|---|---|---|
| El servidor no arranca: `Failed to connect` / `NpgsqlException` (en `build/keel-scenarios/server.log`) | la base no está arriba | `bash infra/up.sh && bash infra/validate-infra.sh` |
| El servidor no arranca: faltan variables (`faltan N variable(s)`) | el perfil exige `${VAR}` sin default | exportar las que lista, o arrancar en `local` |
| 409 `OPTIMISTIC_LOCK_CONFLICT` en un camino feliz | dos escrituras del mismo agregado en una operación, o el agregado se cargó dos veces | cargar una vez, mutar, `Save` una vez |
| 409 con el `code` de una unicidad que no debería chocar | el valor no se normalizó antes de buscar/guardar como dice el diseño | normalizar como dice el diseño (`TextFold` si el campo pliega) |
| 409 con el `code` de una unicidad condicionada en una operación que **releva** (saca una fila del estado y mete otra) | se guardó la entrada antes que la salida: el índice se comprueba por fila | `Save` primero la que sale del estado, después la que entra (la nota del handler lo dice) |
| 500 tras una escritura «que sí se hizo» | una llamada al puerto sin `await`: corrió fuera de la transacción | `await` en toda llamada a un puerto |
| 500 `NotImplementedException` con `TODO (agente): mapear …` | un campo que build no supo mapear (`RowValues`) | completarlo en el adaptador, con la skill |
| Una columna nueva no aparece en local tras regenerar el mapeo | `EnsureCreated` no toca una base que ya tiene tablas | `bash infra/reset-db.sh --schema` |
| `verify-baseline.sh` → `baseline: KO`, cambios pendientes | se cambió el mapeo después de crear la migración | `dotnet ef migrations remove` y volver a crearla (antes de desplegar); si ya está desplegada, una migración nueva |
| `verify-baseline.sh` → `baseline: KO`, catálogos distintos | la migración se editó a mano | volver a crearla; si persiste con la recién creada, es un defecto: a `blockers` con la diferencia que imprime |
| `MSB3030: no se pudo copiar el archivo obj\…\<Proyecto>.dll` | la ruta del proyecto pasa de 260 caracteres (Windows) y Roslyn no lo dice | mover el proyecto a una ruta más corta |
| 503 `TRANSACTION_TIMEOUT` | una consulta o una espera de bloqueo pasó del tope | buscar la consulta lenta (N+1, filtro en memoria); el tope no se sube para taparla |
