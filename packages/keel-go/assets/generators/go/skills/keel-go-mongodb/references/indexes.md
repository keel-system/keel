# Los índices (calidad)

Build deriva los índices de `specs/persistence.keel.yaml` —la clave natural (`uk_<colección>_natural`), cada campo
`unique` (`uk_<colección>_<campo>`) y cada índice declarado, con su `partialFilterExpression` si lleva `when`— y de los
almacenes del generador (`ix_outbox_event_pending`, `ix_processed_event_processed_at`…), y el servidor los crea al
arrancar (`internal/infrastructure/mongo/indexes.go`). Son los mismos, con los mismos nombres, que crean los otros tres
servidores del diseño.

Aquí **no hay baseline que redactar sino índices que VERIFICAR** contra los vivos, tras un arranque del servidor (el
de `bash infra/score-scenarios.sh` sirve):

```bash
bash infra/export-indexes.sh     # solo lee: build/schema/indexes.json
```

Contrasta:

1. Cada índice de `indexes.go` aparece en `build/schema/indexes.json` con las MISMAS claves, en el mismo orden, y el
   mismo `unique`; el condicionado, con su `partialFilterExpression` (el valor GUARDADO: la constante del enum).
2. No sobra ninguno (salvo `_id_`): uno que no salga de `indexes.go` lo creó otra cosa y el traductor no lo conoce.
3. Cada `naturalKey`, `unique` e `indexes` del diseño tiene el suyo.

Reporta `indexes: OK | KO` e `indexesTested: <n>`; una diferencia es `remaining` (no se arregla creando el índice a
mano: es un defecto del generador o del diseño).
