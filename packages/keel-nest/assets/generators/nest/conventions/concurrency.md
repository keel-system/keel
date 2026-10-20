# I/O concurrente en handlers — cuándo y cómo

Node atiende cada petición en un solo hilo, y la I/O ya no lo bloquea: mientras una consulta espera, el
proceso atiende otra cosa. Esta guía cubre el caso concreto de un handler que necesita lanzar **varias
operaciones de I/O a la vez** dentro de un mismo `handle(...)`. La primitiva es `Promise.all`; no hacen
falta hilos.

## Criterio de decisión

Lanza operaciones a la vez **solo si** se cumplen las dos condiciones:

1. El handler hace **dos o más operaciones de I/O** (una lectura del repositorio, una llamada a un cliente
   saliente de `src/domain/clients/`, una lectura de caché o de storage).
2. Esas operaciones son **independientes entre sí**: el resultado de una no hace falta para lanzar la otra.

Si son secuencialmente dependientes (verificar → crear → persistir), lanzarlas a la vez no aporta nada y
añade complejidad: usa el flujo lineal normal.

**Regla práctica: solo en query handlers.** Los command handlers se quedan secuenciales: el orden de las
escrituras es parte del caso de uso, y todas van por la misma transacción.

## La regla que decide casi siempre: como mucho UNA rama contra la persistencia

El `UseCaseMediator` abre la transacción del caso de uso **también para una Query** (de solo lectura), y
`TransactionContext` la propaga con `AsyncLocalStorage`: todo lo que el handler lance, en serie o a la vez,
llega al adaptador con **el mismo `EntityManager` y la misma conexión**. De ahí:

- Con PostgreSQL o MySQL, dos lecturas del repositorio en un `Promise.all` no fallan: el driver las
  **encola** en la conexión y se ejecutan una detrás de otra. El código parece concurrente y no gana nada —
  peor que no hacerlo, porque engaña a quien lo lea.
- Con MongoDB, la sesión de la transacción **no admite** operaciones a la vez (lo veta la skill
  `keel-nest-mongodb`).
- Sacar una lectura de la transacción para que «corra aparte» (otro `EntityManager`, otra conexión) la
  separa de la instantánea del caso de uso: dos lecturas que el diseño da por coherentes pueden ver
  estados distintos. No se hace.

Así que en un `Promise.all` **como mucho una rama toca un repositorio**; las demás son lo que no va por la
base: clientes salientes, `OperationCache`, `FileStorage`. Dos lecturas de la base independientes se quedan
en serie, o se piden en **una** consulta con un método del puerto que las traiga juntas (como el
`findAllById` por lote: se añade al puerto de `src/domain/repository/` y a su adaptador).

## Patrón correcto

```ts
async handle(query: GetOrderSummaryQuery): Promise<OrderSummaryResponse> {
  // Todas las promesas se CREAN antes del primer await: si no, es secuencial disfrazado.
  const [order, shipment] = await Promise.all([
    this.orders.findById(query.orderId),          // la única rama contra la base
    this.shippingClient.getShipment(query.orderId) // cliente saliente: otra conexión, otro proceso
  ]);
  if (order === null) throw new OrderNotFoundError(query.orderId);
  return toOrderSummaryResponse(order, shipment);
}
```

## Reglas del patrón

- **`Promise.all`, no `Promise.allSettled`**: el primer rechazo es el error del caso de uso y se propaga
  tal cual —el `code` del diseño tiene que llegar intacto al filtro de errores—. `allSettled` lo convierte
  en un dato que alguien tiene que acordarse de mirar, y si se olvida, el error desaparece.
- **Nada de promesas sin `await`** (`void this.client.notify(...)`, o una promesa creada y no esperada):
  sigue corriendo cuando el handler ya ha vuelto y la transacción ya se cerró, y su error no llega a
  ninguna frontera —ni al filtro de errores ni al log del caso de uso—.
- **Ojo con lo que sigue corriendo**: cuando una rama rechaza, `Promise.all` devuelve el error en cuanto
  llega, pero las demás ramas no se cancelan. Por eso las ramas son **lecturas**: una escritura a medias en
  otra rama es exactamente lo que la regla «solo en query handlers» evita.
- **Un bucle de lecturas a la vez** (`Promise.all(ids.map(...))`) contra un cliente saliente lanza tantas
  peticiones como elementos, sin tope: si la lista no está acotada por el diseño, va en serie o por lotes.
  Contra la base, nunca: es una consulta por lote.

## El contexto: viaja solo

Un salto de `await` no pierde nada: `AsyncLocalStorage` sigue a las promesas, a los temporizadores y a los
callbacks, así que cada rama del `Promise.all` lleva **la correlación, la transacción del caso de uso y, con
telemetría, la traza** sin que el handler haga nada. No hay helper que usar.

Lo único que lo pierde es **otro hilo de JavaScript** (`worker_threads`): un `Worker` empieza vacío, sin
`correlationId`, sin transacción y sin traza. La regla `context` de `infra/check-logging.sh` lo veta. El
trabajo concurrente en este servicio es I/O, y la I/O va con promesas.
