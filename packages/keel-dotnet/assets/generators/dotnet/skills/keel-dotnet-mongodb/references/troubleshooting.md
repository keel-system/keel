# Fallos típicos sobre MongoDB

| Síntoma | Causa | Qué hacer |
|---|---|---|
| `Transaction numbers are only allowed on a replica set member` | la base no es miembro de un replica set | `infra/` la arranca así: `bash infra/up.sh` y `bash infra/validate-infra.sh` (comprueba `rs.status()`) |
| el servidor no arranca: `An equivalent index already exists with a different name` / `Index … already exists with different options` | un índice cambió de forma en el diseño | `bash infra/reset-db.sh --schema` en local (ver `indexes.md`) |
| `El campo <colección>.<campo> guarda String y el contrato pide un uuid (binario de subtipo 4)` | otro cliente (o un script a mano) escribió el id como texto | el `_id` y las referencias son binarios: `UUID("…")` en mongosh, `BsonValues.Of(guid)` en C# |
| 409 con el `code` de concurrencia sin que nadie más escriba | un `WriteConflict` agotó los tres reintentos de la transacción, o la versión del agregado cambió | relee y repite: no reintentes a ciegas dentro del handler |
| 409 sin `code` al crear | E11000 sobre un índice que el traductor no conoce (normalmente el `_id`: un id repetido) | el id lo genera el dominio; un índice sin nombre del contrato es un defecto (ver `indexes.md`) |
| un filtro que «no encuentra nada» | el valor va como en el dominio y no como se guarda (uuid, decimal, enum, fecha) | `BsonValues` (ver `repository-adapters.md`) |
| un `MongoEval` que devuelve vacío | el script no termina en una expresión con valor, o falló antes | vacío no es cero: revisa el script en la salida del error |
