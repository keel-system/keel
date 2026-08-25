// El TaskScheduler del servicio: hilos de PLATAFORMA para todo lo que corre por reloj.
//
// Por qué existe. El scaffolding activa `spring.threads.virtual.enabled: true` (config.js),
// y con eso Spring Boot sustituye el TaskScheduler por un `SimpleAsyncTaskScheduler` de
// hilos virtuales. Eso es correcto para atender peticiones —donde el hilo se pasa la vida
// bloqueado en I/O— y es un problema para lo que corre por reloj: el driver JDBC y el pool
// de conexiones tienen secciones `synchronized`, y un hilo virtual que se bloquea dentro de
// una de ellas queda CLAVADO a su carrier (pinning) en vez de soltarlo. Con varios barridos
// reclamando lotes a la vez, los carriers se agotan y las tareas dejan de dispararse a su
// hora: en una corrida en vivo, un `@Scheduled(cron = "30 * * * * *")` salió casi CUATRO
// MINUTOS tarde. No falla nada; llega tarde, que en un barrido con cota temporal es peor.
//
// Y no se arregla por configuración: `spring.task.scheduling.pool.size` NO tiene efecto con
// hilos virtuales activados (lo dice la propia documentación de Boot), así que emitirlo
// habría sido una propiedad que nadie lee. Declarar el bean sí funciona — la
// auto-configuración es `@ConditionalOnMissingBean`, y en cuanto existe uno propio deja de
// sustituirlo.
//
// El tamaño del pool es UN HILO POR TAREA, y esa cuenta importa. Acotar la concurrencia
// serializaría los barridos entre sí, y esa es exactamente la objeción con la que
// `conventions/dependencies.md` descarta tocar `concurrency-limit`: es global, así que se le
// aplicaría también al OutboxRelay —que corre cada segundo— y un barrido largo pasaría a
// retrasar la entrega de eventos. Con un hilo por tarea nadie espera a nadie, que es la
// propiedad que había antes del pinning y la que se conserva aquí.
//
// Lo que NO cambia: los hilos virtuales siguen activos para todo lo demás (web, listeners
// del broker, clientes salientes). La frontera está en `conventions/virtual-threads.md`.

import { javaFile, javaPath, subPackage } from './render.js';
import { usesOutbox } from './outbox.js';
import { usesIdempotency } from './idempotency.js';
import { usesHttpIdempotency } from './http-idempotency.js';
import { hasScheduledOperations } from './services.js';

const CONFIG_PKG = 'infrastructure.configurations.scheduling';

/**
 * Cuántos métodos `@Scheduled` emite build para ESTE diseño.
 *
 * Se cuenta en vez de fijar un número redondo porque el pool tiene que dar para todas: una
 * de menos y dos tareas comparten hilo, con lo que la segunda espera a que la primera
 * termine — que es justo el solapamiento que este bean viene a evitar.
 *
 * Si algún día se añade un `@Scheduled` nuevo al scaffolding, su emisor tiene que aparecer
 * también aquí. El síntoma de olvidarlo no es un fallo: es una espera, que es peor de ver.
 */
export function scheduledTaskCount(model) {
  let total = 0;
  // El <Servicio>Scheduler: un método por operación con `schedule` (services.js).
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      if (operation.schedule) total += 1;
    }
  }
  // El relay del outbox y la purga de su tabla (outbox.js).
  if (usesOutbox(model)) total += 2;
  // La purga del registro de procesados (idempotency.js).
  if (usesIdempotency(model)) total += 1;
  // La purga del registro de comandos (http-idempotency.js).
  if (usesHttpIdempotency(model)) total += 1;
  // La purga de las marcas de reclamo de reconciliación (reconciliation-claim.js).
  if (hasReconciliationClaim(model)) total += 1;
  return total;
}

function hasReconciliationClaim(model) {
  return (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .flatMap((operation) => operation.reconciles ?? [])
    .some((reconcile) => reconcile.claim);
}

/**
 * La misma condición con la que `application.js` decide `@EnableScheduling`: donde hay algo
 * que programar hay que decidir en qué hilos corre, y donde no lo hay este bean sobra.
 */
export function usesScheduling(model) {
  return (
    usesOutbox(model) || usesIdempotency(model) || usesHttpIdempotency(model) || hasScheduledOperations(model)
  );
}

export function generate(model) {
  if (!usesScheduling(model)) return [];
  const tasks = scheduledTaskCount(model);
  const poolSize = Math.max(tasks, 1);

  const body = `@Configuration
public class SchedulingConfig {

    /**
     * Un hilo por tarea programada de este servicio (${tasks}), configurable por entorno.
     *
     * <p>No se acota por debajo a propósito: con menos hilos que tareas, dos que coincidan en
     * el mismo tick se serializan, y una que tarde retrasa a la siguiente. Ese acoplamiento es
     * el que hace que un barrido lento acabe retrasando la entrega de eventos del outbox.
     */
    @Value("\${scheduling.pool-size:${poolSize}}")
    private int poolSize;

    /**
     * El scheduler de todo lo que corre por reloj, sobre hilos de PLATAFORMA.
     *
     * <p>Este servicio tiene los hilos virtuales activados, y para atender peticiones es lo
     * correcto. Para las tareas programadas no: casi todas empiezan reclamando un lote contra
     * la base de datos, y el driver JDBC se bloquea dentro de secciones {@code synchronized}
     * — donde un hilo virtual no suelta su carrier, lo deja CLAVADO. Con varias tareas a la
     * vez los carriers se agotan y los {@code @Scheduled} dejan de dispararse a su hora
     * (medido: más de tres minutos de retraso). Un barrido que llega tarde no da error: hace
     * su trabajo tarde, y si tiene una cota temporal encima, la cota deja de significar lo
     * que decía.
     *
     * <p>Declararlo como bean es lo que lo hace efectivo: la auto-configuración de Boot solo
     * pone el suyo si no hay ninguno, y {@code spring.task.scheduling.pool.size} no sirve
     * aquí — con hilos virtuales, esa propiedad no tiene efecto.
     */
    @Bean
    public TaskScheduler taskScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(poolSize);
        scheduler.setThreadNamePrefix("${model.service.artifactId}-sched-");
        // Que una tarea reviente no puede llevarse por delante a las siguientes.
        scheduler.setRemoveOnCancelPolicy(true);
        // Al apagar, se espera a que la tarea en vuelo termine: cortarla a mitad deja filas
        // reclamadas sin trabajo hecho, y esas solo las recupera un rescate.
        scheduler.setWaitForTasksToCompleteOnShutdown(true);
        scheduler.setAwaitTerminationSeconds(30);
        return scheduler;
    }
}`;

  return [
    {
      path: javaPath(model, CONFIG_PKG, 'SchedulingConfig'),
      content: javaFile(
        subPackage(model, CONFIG_PKG),
        [
          'org.springframework.beans.factory.annotation.Value',
          'org.springframework.context.annotation.Bean',
          'org.springframework.context.annotation.Configuration',
          'org.springframework.scheduling.TaskScheduler',
          'org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler'
        ],
        body
      )
    }
  ];
}
