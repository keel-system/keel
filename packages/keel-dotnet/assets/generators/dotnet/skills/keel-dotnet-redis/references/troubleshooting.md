# Caché de lectura — diagnóstico

## Un escenario de retención falla y la respuesta no trae ningún error

«El valor viejo sobrevive dentro del TTL» falla y todo responde 200: la caché no está cacheando. El adaptador
(`src/<Raíz>.Infrastructure/Cache/RedisOperationCache.cs`) degrada a miss **en silencio para el cliente**, y la única
evidencia es su aviso en el log del servidor:

- `Caché <nombre> no disponible al leer` — el store no contesta: ¿está arriba (`bash infra/validate-infra.sh`)?
  ¿`REDIS_HOST`/`REDIS_PORT` del perfil apuntan a él?
- `Caché <nombre>: entrada ilegible` — lo guardado no tiene la forma de la respuesta de esta versión. Pasa con entradas de
  una versión anterior del servicio (`bash infra/reset-db.sh` las borra) o si alguien escribió en la caché sin el puerto.
- Ningún aviso y ningún acierto — el handler no llama a `GetOrLoad`, o su `Cacheable` descarta siempre.

En el perfil `test` (las pruebas de `dotnet test`) no hay caché a propósito: toda lectura va al origen.

## La caché sirve un dato viejo después de una mutación

- La operación que muta ¿emite (`emits`) o consume (suscripción) un evento de la lista `invalidatedBy` de la caché? Si no,
  `CacheInvalidations.cs` no la nombra y la entrada vive hasta el TTL: es un hueco del DISEÑO (`invalidatedBy`
  incompleto), y se arregla en `specs/`, no a mano.
- Un desalojo tuyo que se ejecutó ANTES del commit: con `Evict`/`Clear` del puerto no pasa (esperan al commit); con un
  cliente de Redis propio, sí. No lo hay: quítalo.
- Varias réplicas: una lectura en curso en una puede guardar lo que leyó antes del commit de otra. La cota es el TTL.

## El servicio tarda o se cuelga con Redis caído

No debería: el cliente falla en el acto sin conexión (`BacklogPolicy.FailFast`; el default de StackExchange.Redis 3.x
encola) y cada orden tiene plazo (`cache.redis.command-timeout-ms`). Si una lectura se queda esperando, busca un cliente
de Redis que no sea el de `src/<Raíz>.Infrastructure/Cache/RedisCacheStore.cs`.

## Inspeccionar el store

Desde el contenedor devtools de `infra/`:

```bash
redis-cli -h redis --scan --pattern '<servicio>:*'     # las entradas del servicio
redis-cli -h redis TTL '<servicio>:<operación>::<clave>' # lo que le queda (−1: sin TTL, no debería pasar)
redis-cli -h redis GET '<servicio>:<operación>::<clave>' # el JSON tal como saldría por HTTP
```

Con Valkey, `-h valkey`.
