# Cambiar el esquema con una base desplegada

Solo aplica si `build/keel-refresh/EVOLUTION.md` avisa de que el esquema cambió **y** el diseñador ha dicho que hay una
base desplegada con la baseline anterior. Sin base desplegada no hay nada que escribir: la baseline nueva de build es
el esquema, y `bash infra/reset-db.sh --schema` la lleva a la base local.

## Los pasos que escribe build

Los `<NNNNN>_keel_<tablas>.sql` de `migrations/` (su primera línea es `-- keel:generator-step <tablas>`) **los escribe
build, no tú**. Cuando una tabla del generador (`outbox_event`, `processed_event`, `idempotency_record`,
`reconciliation_claim`, `keel_timer`) aparece en un proyecto que ya tiene la baseline, build escribe el paso que la
crea, con `CREATE TABLE IF NOT EXISTS`, y `EVOLUTION.md` lo nombra en «Pasos de esquema de build». Una base nueva aplica
la baseline (que ya trae la tabla) y el paso no hace nada; una desplegada recibe la tabla por el paso.

- No lo edites, no lo renumeres y no lo borres: una base que ya lo aplicó no lo vuelve a leer.
- No repitas sus tablas en un paso tuyo: ya están cubiertas.
- Si lo único que cambió en la baseline son esas tablas, `EVOLUTION.md` no avisa de que el esquema cambió: no hay paso
  que escribir. Si avisa, la diferencia que te toca es la otra (la del dominio), y tu paso va después del de build, con
  el número siguiente.
- Un paso de build no cuenta como «ya migra por pasos»: build lo escribe en cuanto hay baseline, haya o no base
  desplegada. Lo que decide entre «la primera vez» y «las siguientes» de abajo son los pasos tuyos.

## Por qué

goose guarda en `goose_db_version` qué migraciones aplicó y no vuelve a aplicarlas, así que la baseline reescrita no
llega a esa base: el servidor arranca sin error y falla en la primera consulta que toque lo nuevo. Una base desplegada
solo avanza con una migración **nueva**.

## Qué hacer

`<motor>` es el directorio de `internal/infrastructure/` que tiene `migrations/`.

**La primera vez** (en `migrations/` solo están la baseline y, si acaso, pasos de build):

1. Guarda la baseline nueva, que es el esquema al que hay que llegar:
   `cp internal/infrastructure/<motor>/migrations/00001_baseline.sql build/keel-refresh/baseline-nueva.sql`
2. Devuelve la baseline a la que aplicó la base desplegada, sin retoques:
   `git checkout HEAD -- internal/infrastructure/<motor>/migrations/00001_baseline.sql`
3. Escribe el paso con la diferencia entre las dos.

**Las siguientes** (en `migrations/` ya hay pasos tuyos): la baseline no se toca. La versión nueva de build está en
`build/keel-refresh/internal/infrastructure/<motor>/migrations/00001_baseline.sql`. Compárala con el esquema al que llevan
la baseline y los pasos que ya existen (los de build incluidos), y escribe el paso siguiente. Build la anota como fusión pendiente en la
sección 1: **no se fusiona**, y el orquestador la quita de `pendingMerge` al cerrar.

## El paso

`internal/infrastructure/<motor>/migrations/<NNNNN>_<qué_cambia>.sql`, con el número siguiente al último paso que haya
(también si es de build) y las dos direcciones. Va
embebido en el binario sin registrarlo en ningún sitio:

```sql
-- +goose Up
ALTER TABLE product ADD COLUMN weight numeric(10,3);

-- +goose Down
ALTER TABLE product DROP COLUMN weight;
```

- Los nombres de constraint, índice y FK son los de la baseline nueva, **literales**: `errors.go` traduce por ellos al
  `code` del diseño.
- Una columna obligatoria nueva sobre una tabla con filas necesita un valor para esas filas. Si el diseño no lo da, es
  un `designGap`: no te inventes el valor.
- Un paso que ya se aplicó en una base desplegada no se edita: lo que falte va en otro paso.

## Comprobarlo

`bash infra/reset-db.sh --schema`, y la puntuación de siempre: el servidor aplica la baseline y los pasos sobre una base
vacía, y los flujos corren contra ese esquema. Eso mide el esquema al que se llega, no los datos de la base desplegada:
un paso que transforma filas se prueba además contra una copia de ella, y el informe tiene que decir si se hizo.
