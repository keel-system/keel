---
name: keel-nest-redis
description: Guía de la caché de lectura con Redis o Valkey (protocolo compatible) en un proyecto generado por keel-nest — qué generó build, dónde se consulta la caché desde el handler, qué no se guarda y por qué la invalidación ya está hecha. Usar cuando keel-stack.json declara cache "redis" o "valkey".
---

# Redis / Valkey (cache: `redis` o `valkey`)

Valkey habla el protocolo de Redis: el mismo cliente, el mismo código; solo cambia la imagen del compose. Es el
mismo servidor que el de keel-spring del diseño: las cachés se llaman igual en el store
(`<servicio>:<operación>::<clave>`), con el mismo TTL, y `infra/reset-db.sh` las borra con la misma orden.

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"cache": "redis"` o `"cache": "valkey"`.
- Lee en `specs/use-cases.keel.yaml` las operaciones con `cache` (`ttlSeconds`, `keyFields`, `invalidatedBy`):
  el diseño es la única fuente de verdad funcional.
- Sigue `{{keel:docs}}/conventions/mapping.md` y la frontera de `{{keel:docs}}/architecture.md`:
  `src/application` no importa Nest ni Redis; usa el puerto.

## Qué dejó listo build — y qué NO vas a escribir

| Pieza (build) | Dónde |
|---|---|
| El puerto | `src/application/port/out/operation-cache.ts` — `OperationCache` (`getOrLoad`, `evict`, `clear`) y `cacheKey(...)` |
| Las cachés del diseño | `src/application/support/cached-operations.ts` — una constante `<OPERACION>_CACHE` por operación, con su nombre, su TTL y su clave (`keyOf`, de los `keyFields`) |
| El adaptador sobre Redis/Valkey | `src/infrastructure/cache/redis-operation-cache.ts` — degrada a miss, no guarda nulos, una carga por entrada a la vez |
| La conexión | `src/infrastructure/cache/redis-cache-store.ts` — arranca sin el store, falla en el acto sin conexión y reconecta sin fin |
| Cómo se guarda y se lee cada respuesta | `src/infrastructure/cache/cached-responses.ts` — con el contrato del cable, un lector por DTO |
| **La invalidación** | `src/infrastructure/cache/cache-invalidations.ts`, que aplica el `UseCaseMediator` tras el commit |
| Configuración | `config/parameters/<perfil>/cache.yaml` y `src/infrastructure/cache/cache-settings.ts` (`REDIS_HOST`, `REDIS_PORT`, las de keel-spring); en el perfil `test` no hay caché |
| Módulo | `src/infrastructure/cache/cache-module.ts` — global: el handler inyecta el puerto sin importarlo |
| Redis/Valkey en `infra/`, su sondeo y su vaciado | `infra/docker-compose.yaml`, `infra/validate-infra.sh`, `infra/reset-db.sh` |
| El vaciado a mitad de flujo | `clearCache()` en `test/integration/support/flow.ts` |

> **No escribas otro adaptador ni otro cliente de Redis, y no escribas desalojos para los eventos de
> `invalidatedBy`**: el mediator ya vacía la caché entera, tras el commit, en cada operación que emite o consume
> uno de ellos. Un desalojo tuyo por clave al lado no añade nada y, si se adelanta al commit, sirve el dato viejo.

## Lo que sí te toca: consultar la caché desde el handler

En el handler de la operación con `cache`, añade `OperationCache` a `static readonly inject` y al constructor, y
envuelve con `getOrLoad` la parte que produce la respuesta:

```ts
static readonly inject = [AssetRepository, CallerScope, AssetApplicationMapper, OperationCache] as const;

async handle(query: GetAssetQuery): Promise<GetAssetResponseDto> {
  const card = await this.operationCache.getOrLoad(GET_ASSET_CACHE, query, () => this.load(query), {
    // Lo que el diseño no quiere ver servido durante el TTL se sirve y no se guarda.
    cacheable: (card) => card.thumbnail != null
  });
  // Lo que depende de QUIÉN llama se comprueba sobre CADA respuesta, también la que sale de la caché.
  if (!this.callerScope.covers(card.ownerCode)) throw new AssetOutOfScopeError(/* … */);
  return card;
}
```

Tres reglas, y las tres se pagan con un dato que nadie ve fallar:

- **Lo que depende de quién llama se comprueba FUERA de `load`, sobre cada respuesta.** La clave son los
  `keyFields` (la entrada de la operación), no el llamante: una comprobación de alcance o de propiedad dentro de
  `load` se saltaría en cada acierto, y la ficha de un propietario le llegaría a otro. Si la comprobación necesita
  el recurso, hazla sobre lo que devuelve `getOrLoad` (la respuesta lleva el dato con el que decidir); si no, antes.
- **Lo que no debe servirse durante el TTL no se guarda** (`cacheable`). El caso típico es la respuesta
  DEGRADADA porque un proveedor no contestó (`onUnavailable` de un `need`): servirla cinco minutos convierte una
  caída de un segundo en cinco minutos de ficha incompleta.
- **Solo en lecturas.** Ni en commands, ni como almacén de idempotencia: la idempotencia es el registro
  transaccional que genera build (`conventions/mapping.md`), porque una repetición no se rechaza, se
  **reproduce**, y Redis no confirma en la transacción del agregado.

Lo demás ya lo hace el adaptador y no lo repitas: un error de la carga (un 404 del dominio) no se guarda, un
`null` tampoco, y el store caído o una entrada ilegible van al origen con un WARN. Detalle, la clave compuesta y
el desalojo a mano en `references/implementation.md`.

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/implementation.md` | Al escribir el handler: la clave, qué entra en la respuesta cacheada, `evict`/`clear` a mano, la ventana entre réplicas |
| `references/troubleshooting.md` | Si la caché sirve datos viejos, no cachea nada, o un escenario de retención falla sin ningún error |

## Validación

Desde el contenedor devtools de `infra/`: `redis-cli -h redis PING` (o `-h valkey`),
`redis-cli -h redis --scan --pattern '<servicio>:*'` y `TTL <clave>` para ver las entradas y su caducidad tras
ejercitar los escenarios. En un flujo, `clearCache()` mide un MISS a mitad de escenario.
