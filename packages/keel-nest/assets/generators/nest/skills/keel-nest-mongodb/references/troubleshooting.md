# Fallos típicos sobre MongoDB

| Síntoma | Causa | Qué hacer |
|---|---|---|
| `Transaction numbers are only allowed on a replica set member` | la base no es miembro de un replica set | `infra/` la arranca así: `bash infra/up.sh` y `bash infra/validate-infra.sh` (comprueba `rs.status()`) |
| `MongoParseError: option uuidrepresentation is not supported` | una URI escrita a mano para el driver de Node con la opción del de Java | la `DB_URL` de keel-spring vale tal cual: `mongo-settings.ts` quita esa opción. No la reescribas |
| el servidor no arranca: `An equivalent index already exists with a different name` / `Index … already exists with different options` | un índice cambió de forma en el diseño | `bash infra/reset-db.sh --schema` en local (ver `indexes.md`) |
| 409 con el `code` de concurrencia sin que nadie más escriba | un `WriteConflict` agotó los tres reintentos del mediator, o la versión del agregado cambió | relee y repite: no reintentes a ciegas dentro del handler |
| 409 sin `code` al crear | E11000 sobre un índice que el traductor no conoce (normalmente el `_id`: un id repetido) | el id lo genera el dominio; un índice sin nombre del contrato es un defecto (ver `indexes.md`) |
| un filtro que «no encuentra nada» | el valor va como en el dominio y no como se guarda (uuid, decimal, enum, fecha) | `bson-values.ts` (ver `repository-adapters.md`) |
| un `mongoEval` que devuelve vacío | el script no termina en una expresión con valor, o falló antes | vacío no es cero: revisa el script en la salida del error |
