# Fallos típicos de la persistencia

| Síntoma | Causa habitual | Qué hacer |
|---|---|---|
| El servidor no arranca: no conecta con la base (en `build/keel-scenarios/server.log`) | la base no está arriba | `bash infra/up.sh && bash infra/validate-infra.sh` |
| El servidor no arranca: faltan variables (se listan todas) | el perfil exige `${VAR}` sin default | exportar las que lista, o arrancar en `local` |
| El servidor no arranca: `missing zero version migration` (goose) | se vació el historial `goose_db_version` sin el esquema | `bash infra/reset-db.sh --schema` y volver a arrancar |
| El primer flujo falla con un error del motor sobre una columna que no existe, tras regenerar | goose no reaplica una baseline que su historial ya tiene | `bash infra/reset-db.sh --schema` |
| 409 `CONCURRENT_MODIFICATION` en un camino feliz | dos `Save` del mismo agregado en una operación, o el agregado se cargó dos veces | cargar una vez, mutar, `Save` una vez |
| 409 con el `code` de una unicidad que no debería chocar | el valor no se normalizó como dice el diseño antes de crear el agregado | normalizar en el constructor o el método de negocio, como dice el diseño |
| 409 con el `code` de una unicidad condicionada en una operación que **releva** (saca una fila del estado y mete otra) | se guardó la entrada antes que la salida: el índice se comprueba por fila | `Save` primero la que sale del estado, después la que entra (la nota del handler lo dice) |
| 409 `IDEMPOTENCY_KEY_IN_PROGRESS` en un reintento secuencial | el handler guarda el registro después del negocio, o lo guarda dos veces | reclamar con `Save` ANTES del negocio, una vez (`flow-fidelity.md` § La idempotencia de petición) |
| 500 con `sin implementar` en el log | un handler que sigue devolviendo `ErrNotImplemented` | completarlo |
| Una escritura «que sí se hizo» sobrevive a un error de la operación | se usó un `context.Background()` en vez del `ctx` del handler: la escritura fue fuera de la transacción | pasar siempre el `ctx` que recibe el handler |
| 503 `TRANSACTION_TIMEOUT` | una consulta o una espera de bloqueo pasó del tope | buscar la lectura lenta (N+1, filtro en memoria); el tope no se sube para taparla |
| MySQL: una sentencia escrita a mano con `WHERE id = '<uuid>'` no toca ninguna fila y no falla | el id es `binary(16)`: un literal de texto no casa con nada | `UUID_TO_BIN('<uuid>')` |
