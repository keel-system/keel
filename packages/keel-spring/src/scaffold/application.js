// Clase @SpringBootApplication del servicio generado. Con capa persistence
// habilita la auditoría JPA (createdAt/updatedAt automáticos vía
// AuditableEntity).

import { javaFile, javaPath } from './render.js';
import { usesOutbox } from './outbox.js';

export function generate(model) {
  const { service } = model;
  const imports = ['org.springframework.boot.SpringApplication', 'org.springframework.boot.autoconfigure.SpringBootApplication'];
  const annotations = ['@SpringBootApplication'];
  if (model.layersPresent.persistence) {
    imports.push('org.springframework.data.jpa.repository.config.EnableJpaAuditing');
    annotations.push('@EnableJpaAuditing');
  }
  // El relay del outbox es un @Scheduled: sin esto las filas no saldrían nunca.
  if (usesOutbox(model)) {
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
