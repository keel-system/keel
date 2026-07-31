// Clase @SpringBootApplication del servicio generado. Habilita la auditoría JPA
// cuando el diseño la declara (persistence.audit).

import { javaFile, javaPath } from './render.js';
import { auditsAnything } from './auditing.js';
import { usesOutbox } from './outbox.js';
import { usesIdempotency } from './idempotency.js';

export function generate(model) {
  const { service } = model;
  const imports = ['org.springframework.boot.SpringApplication', 'org.springframework.boot.autoconfigure.SpringBootApplication'];
  const annotations = ['@SpringBootApplication'];
  // Auditoría JPA: solo si el diseño registra algo (persistence.audit). El bean
  // AuditorAware de la autoría, cuando lo hay, lo autodetecta Spring Data — no
  // hace falta nombrarlo con auditorAwareRef.
  if (model.layersPresent.persistence && auditsAnything(model)) {
    imports.push('org.springframework.data.jpa.repository.config.EnableJpaAuditing');
    annotations.push('@EnableJpaAuditing');
  }
  // El relay del outbox y la purga del registro de idempotencia son @Scheduled:
  // sin esto las filas no saldrían nunca y la tabla de procesados no se purgaría.
  if (usesOutbox(model) || usesIdempotency(model)) {
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
