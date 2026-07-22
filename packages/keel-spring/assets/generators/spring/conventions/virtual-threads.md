# Hilos virtuales en handlers — cuándo y cómo

El proyecto generado habilita hilos virtuales (`spring.threads.virtual.enabled: true`):
cada request ya corre en un hilo virtual. Esta guía cubre el caso concreto de un
handler que necesita ejecutar **varias operaciones I/O en paralelo** dentro de un
mismo `handle(...)`.

## Criterio de decisión

Usa `ExecutorService` con hilos virtuales **solo si** se cumplen las dos condiciones:

1. El handler realiza **dos o más operaciones I/O** (consultas a BD, llamadas a
   `http-clients`, lecturas de caché).
2. Esas operaciones son **independientes entre sí**: el resultado de una no hace falta
   para ejecutar la otra.

Si las operaciones son secuencialmente dependientes (verificar → crear → persistir),
paralelizar no aporta nada y añade complejidad: usa el flujo lineal normal.

**Regla práctica: paraleliza solo en query handlers.** En Keel la transacción la abre
`UseCaseMediator` (los handlers no llevan `@Transactional`); las lambdas del `submit()`
corren en hilos virtuales separados y por tanto **fuera** de esa transacción. Para
lecturas es correcto (cada lambda abre su propia transacción de lectura); para
escrituras es inaceptable — las escrituras paralelas no participan de la transacción
del command y pueden dejar datos inconsistentes. Los command handlers se quedan
secuenciales.

## Patrón correcto (Java 21)

`StructuredTaskScope` es API preview en Java 21: no la uses. El patrón es
`ExecutorService` con `try-with-resources`:

```java
@Override
@LogExceptions
public ValidateProductsResponseDto handle(ValidateProductsQuery query) {
    try (ExecutorService exec = Executors.newVirtualThreadPerTaskExecutor()) {

        // Todos los submit() ANTES de cualquier get(): si no, es secuencial disfrazado
        Future<List<Product>> productsFuture =
            exec.submit(() -> productRepository.findAllByIds(query.productIds()));
        Future<Map<UUID, BigDecimal>> pricesFuture =
            exec.submit(() -> priceRepository.findCurrentPrices(query.productIds()));

        // get() suspende el hilo virtual actual — no bloquea un hilo del SO
        return buildResponse(productsFuture.get(), pricesFuture.get());

    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("Interrumpido durante la consulta paralela", e);
    } catch (ExecutionException e) {
        Throwable cause = e.getCause();
        // Los errores de dominio (RuntimeException) se propagan sin envolver,
        // para que ApiExceptionHandler los traduzca al contrato de error
        if (cause instanceof RuntimeException re) throw re;
        throw new IllegalStateException("Error inesperado en ejecución paralela", cause);
    }
    // try-with-resources: el executor espera a que todas las tareas terminen al cerrarse
}
```

## Reglas del patrón

- **Todos los `submit()` antes de cualquier `get()`**: un `get()` intermedio serializa
  las tareas y anula el paralelismo.
- **`try-with-resources` sobre el executor**: `newVirtualThreadPerTaskExecutor()` es
  `AutoCloseable`; el bloque garantiza cierre y espera de tareas pendientes, sin fugas.
- **Sin pool de hilos virtuales**: nunca `newFixedThreadPool(n)` para esto — limita la
  concurrencia sin beneficio. Un hilo virtual por tarea.
- **Excepciones**: las lanzadas dentro de las lambdas llegan envueltas en
  `ExecutionException`; desenvuélvelas propagando la `RuntimeException` de dominio tal
  cual (el `code` del diseño debe llegar intacto al `ApiExceptionHandler`). Ante
  `InterruptedException`, re-interrumpe el hilo (`Thread.currentThread().interrupt()`).
