# Fallos típicos de la persistencia

| Síntoma | Causa habitual | Qué hacer |
|---|---|---|
| El servidor no arranca: `ECONNREFUSED` / `connect` | la base no está arriba | `bash infra/up.sh && bash infra/validate-infra.sh` |
| `database.url no es una URL de …` al arrancar | `DB_URL` de otro motor | la URL del motor de `keel-stack.json` |
| 409 `OPTIMISTIC_LOCK_CONFLICT` en un camino feliz | dos escrituras del mismo agregado en una operación, o el agregado se cargó dos veces | cargar una vez, mutar, `save` una vez |
| 409 con el `code` de una unicidad que no debería chocar | el valor no se normalizó antes de buscar/guardar, o la collation pliega (MySQL) | normalizar como dice el diseño; las columnas únicas ya llevan `utf8mb4_bin` |
| 409 con el `code` de una unicidad condicionada en una operación que **releva** (saca una fila del estado y mete otra) | se guardó la entrada antes que la salida: el índice se comprueba por fila | `save` primero la que sale del estado, después la que entra (la nota del handler lo dice) |
| 500 `Data too long` / `Incorrect string value` (MySQL) | un uuid escrito como texto en un `binary(16)` por SQL a mano | usar `find`/`count` (aplican el transformador) o convertir el parámetro |
| 500 tras una escritura «que sí se hizo» | una llamada al puerto sin `await`: corrió fuera de la transacción | `await` en toda llamada a un puerto |
| `synchronize` falla al arrancar en local tras cambiar entidades | columna `NOT NULL` nueva sobre filas existentes, o un renombre | `bash infra/reset-db.sh --schema` |
| `verify-baseline.sh` → `baseline: KO` | el baseline no es el de las entidades actuales (se cambió una entidad después de exportar, o se editó el DDL) | volver a exportar; si persiste con el export recién hecho, es un defecto: a `blockers` con la lista que imprime |
| 503 `TRANSACTION_TIMEOUT` | una consulta o una espera de bloqueo pasó del tope | buscar la consulta lenta (N+1, filtro en memoria); el tope no se sube para taparla |
