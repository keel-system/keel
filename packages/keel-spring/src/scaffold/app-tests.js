// Test de arranque de contexto (estilo Spring Initializr): arranca con el
// perfil test (activado en src/test/resources/application.yaml; H2 si hay
// persistence). Los handlers stub no rompen el arranque: UseCaseAutoRegister
// solo los registra, no los invoca.

import { javaFile, javaPath } from './render.js';

export function generate(model) {
  const className = `${model.service.applicationClass}Tests`;
  const body = `@SpringBootTest
class ${className} {

    @Test
    void contextLoads() {
    }
}`;

  return [
    {
      path: javaPath(model, null, className, 'test'),
      content: javaFile(
        model.service.basePackage,
        ['org.junit.jupiter.api.Test', 'org.springframework.boot.test.context.SpringBootTest'],
        body
      )
    }
  ];
}
