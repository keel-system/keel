// Test de arranque de contexto (estilo Spring Initializr): arranca con el perfil
// test (H2 si hay persistence). Los handlers stub no rompen el arranque:
// UseCaseAutoRegister solo los registra, no los invoca.
//
// El perfil se activa con @ActiveProfiles y NO con un application.yaml en
// src/test/resources: ese archivo tendría el mismo nombre que el de main y va
// delante en el classpath del source set `test`, así que lo OCULTA entero. Bajo
// el perfil test desaparecería todo lo que declara application.yaml —empezando
// por spring.application.name— y el contexto moriría resolviendo una propiedad
// que en cualquier otro perfil existe.

import { javaFile, javaPath } from './render.js';

export function generate(model) {
  const className = `${model.service.applicationClass}Tests`;
  const body = `/**
 * Arranque del contexto bajo el perfil \`test\`: sin contenedores y sin red. Es la
 * única comprobación de que TODOS los beans se construyen con esa configuración —
 * los escenarios corren con \`local\` contra infraestructura real y no lo cubren.
 */
@SpringBootTest
@ActiveProfiles("test")
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
        [
          'org.junit.jupiter.api.Test',
          'org.springframework.boot.test.context.SpringBootTest',
          'org.springframework.test.context.ActiveProfiles'
        ],
        body
      )
    }
  ];
}
