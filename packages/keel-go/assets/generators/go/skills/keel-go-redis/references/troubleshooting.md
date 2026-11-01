# Caché de lectura — diagnóstico

## Un escenario de retención falla y la respuesta no trae ningún error

«El valor viejo sobrevive dentro del TTL» falla y todo responde 200: la caché no está cacheando. `OperationCache`
(`internal/application/operation_cache.go`) degrada a miss **en silencio para el cliente**, y la única evidencia es su
aviso en el log del servidor:

- `caché no disponible al leer` — el store no contesta: ¿está arriba (`bash infra/validate-infra.sh`)? ¿`REDIS_HOST` y
  `REDIS_PORT` del perfil apuntan a él? Se escribe una vez por caída, y `caché disponible de nuevo` cuando vuelve.
- `caché: entrada ilegible` — lo guardado no tiene la forma de la respuesta de esta versión. Pasa con entradas de una
  versión anterior del servicio (`bash infra/reset-db.sh` las borra) o si alguien escribió en la caché sin pasar por ella.
- Ningún aviso y ningún acierto — el handler no llama a `GetOrLoad`, o el `cacheable` de su `GetOrLoadIf` descarta siempre.

En el perfil `test` (las pruebas de `go test ./...`) no hay caché a propósito: toda lectura va al origen.

## La caché sirve un dato viejo después de una mutación

- La operación que muta ¿emite (`emits`) o consume (suscripción) un evento de la lista `invalidatedBy` de la caché? Si
  no, `NewUseCases` no le pasa el vaciado y la entrada vive hasta el TTL: es un hueco del DISEÑO (`invalidatedBy`
  incompleto), y se arregla en `specs/`, no a mano.
- Un desalojo tuyo que se ejecutó ANTES del commit: con `Evict`/`Clear` de la caché no pasa (esperan al caso de uso);
  con un cliente de Redis propio, sí. No lo hay: quítalo.
- Varias réplicas: una lectura en curso en una puede guardar lo que leyó antes del commit de otra. La cota es el TTL.

## El servicio tarda o se cuelga con Redis caído

No debería: el store no reintenta (`MaxRetries: -1`) y cada orden tiene su plazo (`cache.redis.connect-timeout-ms` y
`cache.redis.command-timeout-ms`), así que una lectura con el store caído va al origen en ese plazo. Si una lectura se
queda esperando, busca un cliente de Redis que no sea el de `internal/infrastructure/cache/store.go`.

## Inspeccionar el store

Desde el contenedor devtools de `infra/`:

```bash
redis-cli -h redis --scan --pattern '<servicio>:*'     # las entradas del servicio
redis-cli -h redis TTL '<servicio>:<operación>::<clave>' # lo que le queda (−1: sin TTL, no debería pasar)
redis-cli -h redis GET '<servicio>:<operación>::<clave>' # el JSON tal como saldría por HTTP
```

Con Valkey, `-h valkey`.
