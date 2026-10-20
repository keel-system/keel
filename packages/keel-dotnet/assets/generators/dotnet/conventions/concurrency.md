# I/O concurrente en handlers — cuándo y cómo

Cada handler es `async` de punta a punta: mientras una consulta espera, el hilo vuelve al pool y atiende otra
cosa. Esta guía cubre el caso concreto de un handler que necesita lanzar **varias operaciones de I/O a la vez**
dentro de un mismo `Handle(...)`. La primitiva es `Task.WhenAll`; no hacen falta hilos ni `Task.Run`.

## Criterio de decisión

Lanza operaciones a la vez **solo si** se cumplen las dos condiciones:

1. El handler hace **dos o más operaciones de I/O** (una lectura del repositorio, una llamada a un cliente
   saliente de `<Raíz>.Domain/Clients/`, una lectura de caché o de storage).
2. Esas operaciones son **independientes entre sí**: el resultado de una no hace falta para lanzar la otra.

Si son secuencialmente dependientes (verificar → crear → persistir), lanzarlas a la vez no aporta nada y añade
complejidad: usa el flujo lineal normal.

**Regla práctica: solo en query handlers.** Los command handlers se quedan secuenciales: el orden de las
escrituras es parte del caso de uso, y todas van por la misma transacción.

## La regla que decide casi siempre: como mucho UNA rama contra la persistencia

El `UseCaseMediator` abre la transacción del caso de uso **también para una Query** (de solo lectura), sobre el
`DbContext` del ámbito de la petición, y todos los adaptadores de repositorio de esa petición comparten ese
mismo `DbContext`. Un `DbContext` **no admite dos operaciones a la vez**:

```
System.InvalidOperationException: A second operation was started on this context instance before a previous
operation completed.
```

Y no sale siempre: depende de si la primera consulta ya había terminado cuando empezó la segunda. En una máquina
de desarrollo, sin carga, puede pasar todas las pruebas y fallar en producción de vez en cuando. Con MongoDB pasa
lo mismo con la sesión de la transacción (lo veta la skill `keel-dotnet-mongodb`).

**No se arregla con otro `DbContext`** (`IDbContextFactory`, un `IServiceScope` nuevo, otra conexión): la lectura
saldría de la transacción de solo lectura del caso de uso, y dos lecturas que el diseño da por coherentes podrían
ver estados distintos. Tampoco se arregla en el adaptador: el puerto no sabe quién lo llama a la vez.

Así que en un `Task.WhenAll` **como mucho una rama toca un repositorio**; las demás son lo que no va por la base:
clientes salientes, `IOperationCache`, `IFileStorage`. Dos lecturas de la base independientes se quedan en serie,
o se piden en **una** consulta con un método del puerto que las traiga juntas (como el `FindAllById` por lote: se
añade al puerto de `Domain/Repository/` y a su adaptador).

## Patrón correcto

```csharp
public async Task<OrderSummaryResponse> Handle(GetOrderSummaryQuery query, CancellationToken cancellationToken)
{
    // Todas las tareas se CREAN antes del primer await: si no, es secuencial disfrazado.
    var order = orders.FindById(query.OrderId, cancellationToken);                 // la única rama contra la base
    var shipment = shippingClient.GetShipment(query.OrderId, cancellationToken);   // cliente saliente: otra conexión

    await Task.WhenAll(order, shipment);

    var found = await order ?? throw new OrderNotFoundError(query.OrderId);
    return OrderSummaryMapper.ToResponse(found, await shipment);
}
```

Tras el `WhenAll` las dos tareas ya terminaron: el `await` de cada una solo recoge el resultado.

## Reglas del patrón

- **El `CancellationToken` del handler, en todas las ramas**: si la petición se cancela, ninguna rama sigue
  trabajando para nadie.
- **`await Task.WhenAll(...)`, nunca `.Wait()` ni `.Result` antes de terminar**: el `await` relanza la PRIMERA
  excepción tal cual, así que el `code` del diseño llega intacto a la traducción de errores; `.Wait()` bloquea un
  hilo y envuelve el error en una `AggregateException` que ya no es el error del diseño.
- **Nada de tareas sin `await`** (`_ = client.Notify(...)`): sigue corriendo cuando el handler ya ha vuelto, la
  transacción ya se cerró y el ámbito ya liberó el `DbContext`, y su error no llega a ninguna frontera.
- **Ojo con lo que sigue corriendo**: cuando una rama falla, las demás no se detienen solas. Por eso las ramas
  son **lecturas**: una escritura a medias en otra rama es exactamente lo que la regla «solo en query handlers»
  evita.
- **Sin `Task.Run` ni `Parallel.ForEach`/`Parallel.ForEachAsync` para I/O**: la I/O asíncrona no ocupa un hilo
  mientras espera, así que mandarla a otro hilo no la hace más rápida, y `Parallel.*` está pensado para CPU.
- **Un bucle de lecturas a la vez** (`Task.WhenAll(ids.Select(...))`) contra un cliente saliente lanza tantas
  peticiones como elementos, sin tope: si la lista no está acotada por el diseño, va en serie o por lotes. Contra
  la base, nunca: es una consulta por lote.

## El contexto: viaja solo

La correlación, la transacción del caso de uso y, con telemetría, la traza viven en `AsyncLocal`, y el
`ExecutionContext` los lleva a cada `await`, a `Task.WhenAll`, a `Task.Run` y a un temporizador sin que el handler
haga nada. No hay helper que usar.

Lo que lo pierde son las formas que lo suprimen a propósito: `ThreadPool.UnsafeQueueUserWorkItem`,
`UnsafeRegister`, `UnsafeStart` y `ExecutionContext.SuppressFlow()`. El trabajo lanzado así empieza sin
`correlationId`, sin transacción y sin traza, y la regla `context` de `infra/check-logging.sh` lo veta.
