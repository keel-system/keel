---
name: keel-go-redis
description: Guía de la caché de lectura con Redis o Valkey (protocolo compatible) en un proyecto generado por keel-go — qué generó build, dónde se consulta la caché desde el handler, qué no se guarda y por qué la invalidación ya está hecha. Usar cuando keel-stack.json declara cache "redis" o "valkey".
---

# Redis / Valkey (cache: `redis` o `valkey`)

Valkey habla el protocolo de Redis: el mismo cliente (go-redis), el mismo código; solo cambia la imagen del compose. Es
la misma caché que la de keel-spring, keel-nest y keel-dotnet del diseño: se llaman igual en el store
(`<servicio>:<operación>::<clave>`), con el mismo TTL, y `infra/reset-db.sh` las borra con la misma orden.

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"cache": "redis"` o `"cache": "valkey"`.
- Lee en `specs/use-cases.keel.yaml` las operaciones con `cache` (`ttlSeconds`, `keyFields`, `invalidatedBy`): el
  diseño es la única fuente de verdad funcional.
- Sigue la frontera de `{{keel:docs}}/architecture.md`: `internal/application` no conoce Redis (lo vigila
  `internal/architecture`); usa la caché que recibe el handler.

## Qué dejó listo build — y qué NO vas a escribir

| Pieza (build) | Dónde |
|---|---|
| La caché | `internal/application/operation_cache.go` — `OperationCache`, `GetOrLoad`, `GetOrLoadIf`, `Evict`, `Clear`, `CachedOperation[M]`, `CacheKey(...)` y el puerto `CacheStore` |
| Las cachés del diseño | `internal/application/cached_operations.go` — una variable por operación (`GetAssetCache`), con su nombre, su TTL y su clave (`Key`, de los `keyFields`) |
| El store sobre Redis/Valkey | `internal/infrastructure/cache/store.go` — arranca sin el store, sin reintentos y con plazo en cada orden |
| **La invalidación** | `NewUseCases` (`internal/application/use_cases.go`): cada operación que emite o consume un evento de `invalidatedBy` vacía la caché tras el commit (`settle`) |
| Configuración y arranque | `config/parameters/<perfil>/cache.yaml` (`REDIS_HOST`, `REDIS_PORT`, las de keel-spring), `internal/infrastructure/cache/settings.go` y `cmd/server/main.go`; en el perfil `test` no hay caché |
| Las pruebas de la caché | `internal/application/operation_cache_test.go` (con la ida y vuelta de cada respuesta cacheada) |
| Redis/Valkey en `infra/`, su sondeo y su vaciado | `infra/docker-compose.yaml`, `infra/validate-infra.sh`, `infra/reset-db.sh` |
| El vaciado a mitad de flujo | `s.ClearCache()` en `tests/integration/cache_test.go` |

> **No escribas otro store ni otro cliente de Redis, y no escribas desalojos para los eventos de `invalidatedBy`**:
> `NewUseCases` ya vacía la caché entera, tras el commit, en cada operación que emite o consume uno de ellos. Un
> desalojo tuyo por clave al lado no añade nada.

## Lo que sí te toca: consultar la caché desde el handler

El handler de la operación con `cache` ya recibe `operationCache *OperationCache` y una nota con la llamada. Envuelve
con `GetOrLoad` (o `GetOrLoadIf`) la parte que produce la respuesta:

```go
func (h *GetAssetHandler) Handle(ctx context.Context, query GetAssetQuery) (GetAssetResponseDto, error) {
	card, err := GetOrLoadIf(ctx, h.operationCache, GetAssetCache, query, func(ctx context.Context) (GetAssetResponseDto, error) {
		return h.load(ctx, query)
	}, func(card GetAssetResponseDto) bool {
		// Lo que el diseño no quiere ver servido durante el TTL se sirve y no se guarda.
		return card.Thumbnail != nil
	})
	if err != nil {
		return GetAssetResponseDto{}, err
	}
	// Lo que depende de QUIÉN llama se comprueba sobre CADA respuesta, también la que sale de la caché.
	if !h.callerScope.Covers(ctx, card.OwnerID) {
		return GetAssetResponseDto{}, domain.Errorf(domain.ErrAssetOutOfScope, "…")
	}
	return card, nil
}
```

Tres reglas, y las tres se pagan con un dato que nadie ve fallar:

- **Lo que depende de quién llama se comprueba FUERA de la carga, sobre cada respuesta.** La clave son los `keyFields`
  (la entrada de la operación), no el llamante: una comprobación de alcance o de propiedad dentro de la carga se
  saltaría en cada acierto, y la ficha de un propietario le llegaría a otro. Si la comprobación necesita el recurso,
  hazla sobre lo que devuelve `GetOrLoad` (la respuesta lleva el dato con el que decidir); si no, antes.
- **Lo que no debe servirse durante el TTL no se guarda** (`GetOrLoadIf`). El caso típico es la respuesta DEGRADADA
  porque un proveedor no contestó (`onUnavailable` de un `need`): servirla cinco minutos convierte una caída de un
  segundo en cinco minutos de ficha incompleta.
- **Solo en lecturas.** Ni en commands, ni como almacén de idempotencia: la idempotencia es el registro transaccional
  que genera build, porque una repetición no se rechaza, se **reproduce**, y Redis no confirma en la transacción del
  agregado.

Lo demás ya lo hace la caché y no lo repitas: un error de la carga (un `domain.Errorf` del dominio) no se guarda, una
respuesta nula tampoco, y el store caído o una entrada ilegible van al origen con un aviso en el log. Detalle, la clave
compuesta y el desalojo a mano en `references/implementation.md`.

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/implementation.md` | Al escribir el handler: la clave, qué entra en la respuesta cacheada, `Evict`/`Clear` a mano, la ventana entre réplicas |
| `references/troubleshooting.md` | Si la caché sirve datos viejos, no cachea nada, o un escenario de retención falla sin ningún error |

## Validación

`go test ./...` (incluye `operation_cache_test.go`: si cae, tocaste la caché). Desde el contenedor devtools de `infra/`:
`redis-cli -h redis PING` (o `-h valkey`), `redis-cli -h redis --scan --pattern '<servicio>:*'` y `TTL <clave>` para ver
las entradas y su caducidad tras ejercitar los escenarios. En un flujo, `s.ClearCache()` mide un MISS a mitad de
escenario.
