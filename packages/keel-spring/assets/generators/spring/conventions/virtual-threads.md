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

## Dónde NO llegan los hilos virtuales: lo que corre por reloj

El servicio arranca con `spring.threads.virtual.enabled: true`, y para atender peticiones es
lo correcto: un hilo que se pasa la vida bloqueado en I/O es exactamente el caso para el que
existen. Pero hay una frontera, y está en los `@Scheduled`.

Casi toda tarea programada de este generador —el relay del outbox, un barrido, una purga—
empieza reclamando un lote contra la base de datos. El driver JDBC y el pool de conexiones se
bloquean dentro de secciones `synchronized`, y ahí un hilo virtual **no suelta su carrier: se
queda clavado en él** (*pinning*). Con varias tareas coincidiendo, los carriers disponibles se
agotan y los `@Scheduled` dejan de dispararse a su hora. Medido en una corrida: un cron de cada
minuto salió casi **cuatro minutos** tarde.

Y no da error. El barrido corre, hace su trabajo y llega tarde — que en un mecanismo con cota
temporal encima (un rescate, una reconciliación) significa que la cota deja de medir lo que
decía. Es un fallo que no aparece en una máquina de desarrollo con una instancia y sin carga.

Por eso `build` genera `infrastructure/configurations/scheduling/SchedulingConfig`: un
`ThreadPoolTaskScheduler` de **hilos de plataforma**, con un hilo por tarea programada.

- **No lo borres ni lo sustituyas por configuración.** `spring.task.scheduling.pool.size` no
  tiene efecto con hilos virtuales activados: la propiedad se escribe, no se lee y nada avisa.
  Lo que funciona es que el bean exista — la auto-configuración de Boot solo pone el suyo si no
  hay ninguno.
- **Un hilo por tarea, no menos.** Acotarlo serializa los barridos entre sí, y entonces uno
  lento retrasa la entrega de eventos del outbox. El tamaño sale de `scheduling.pool-size`.
- **Todo lo demás sigue en hilos virtuales**: web, listeners del broker, clientes salientes y
  el paralelismo dentro de un handler que describe el resto de este documento.
