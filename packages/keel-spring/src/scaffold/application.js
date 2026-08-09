// Clase @SpringBootApplication del servicio generado. Habilita la auditoría JPA
// cuando el diseño la declara (persistence.audit).

import { javaFile, javaPath } from './render.js';
import { auditsAnything } from './auditing.js';
import { usesOutbox } from './outbox.js';
import { usesIdempotency } from './idempotency.js';
import { usesHttpIdempotency } from './http-idempotency.js';
import { hasScheduledOperations } from './services.js';

export function generate(model) {
  const { service } = model;
  const imports = ['org.springframework.boot.SpringApplication', 'org.springframework.boot.autoconfigure.SpringBootApplication'];
  const annotations = ['@SpringBootApplication'];
  // Auditoría: solo si el diseño registra algo (persistence.audit). El bean
  // AuditorAware de la autoría, cuando lo hay, lo autodetecta Spring Data — no
  // hace falta nombrarlo con auditorAwareRef. La anotación es la del módulo de
  // Spring Data que corresponda al modelo de persistencia; el AuditorAware que la
  // alimenta (auditing.js) es el mismo en los dos.
  if (model.layersPresent.persistence && auditsAnything(model)) {
    if (model.persistenceKind === 'document') {
      imports.push('org.springframework.data.mongodb.config.EnableMongoAuditing');
      annotations.push('@EnableMongoAuditing');
    } else {
      imports.push('org.springframework.data.jpa.repository.config.EnableJpaAuditing');
      annotations.push('@EnableJpaAuditing');
    }
  }
  // El relay del outbox y las purgas de los dos registros de idempotencia (el de
  // consumo y el de comando) son @Scheduled: sin esto las filas no saldrían nunca
  // y las tablas crecerían sin límite.
  //
  // Y los @Scheduled del <Servicio>Scheduler, que es la razón por la que
  // hasScheduledOperations está en la condición: un diseño con `schedule` y sin
  // outbox ni suscripciones generaba el scheduler completo —el gate de
  // reconciliación lo daba por bueno, porque el @Scheduled está en el fuente— y el
  // barrido no se disparaba nunca.
  if (usesOutbox(model) || usesIdempotency(model) || usesHttpIdempotency(model) || hasScheduledOperations(model)) {
    imports.push('org.springframework.scheduling.annotation.EnableScheduling');
    annotations.push('@EnableScheduling');
  }

  const body = `${annotations.join('\n')}
public class ${service.applicationClass} {

    public static void main(String[] args) {
        SpringApplication.run(${service.applicationClass}.class, args);
    }
}`;

  return [
    {
      path: javaPath(model, null, service.applicationClass),
      content: javaFile(service.basePackage, imports, body)
    }
  ];
}
