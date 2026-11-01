# Fallos típicos de la persistencia documental

| Síntoma | Causa habitual | Qué hacer |
|---|---|---|
| El servidor no arranca: no conecta (en `build/keel-scenarios/server.log`) | la base no está arriba, o el replica set no se inició | `bash infra/up.sh && bash infra/validate-infra.sh` |
| `Transaction numbers are only allowed on a replica set member` | se apuntó a un mongod suelto | `DB_URL` al de infra/ (replica set `rs0`) |
| El arranque falla al crear un índice: `An existing index has the same name … but different options` | el diseño cambió un índice y la base conserva el viejo | `bash infra/reset-db.sh --schema` |
| 409 `CONCURRENT_MODIFICATION` en un camino feliz | dos `Save` del mismo agregado en una operación, o dos casos de uso a la vez sobre el mismo documento que agotaron sus reintentos | cargar una vez, mutar, `Save` una vez |
| 409 sin `code` al crear | choque con un índice que el traductor no conoce (el `_id`: un id repetido) | el id lo pone el constructor del dominio; no se reutiliza |
| Un `s.MongoEval` que no toca ningún documento y no falla | el id como texto, o un campo con el nombre del dominio en vez del del documento | `UUID("…")` y snake_case |
| Una escritura «que sí se hizo» sobrevive a un error de la operación | se usó un `context.Background()`: fuera de la sesión de la transacción | pasar siempre el `ctx` del handler |
