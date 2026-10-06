// Catálogo de tecnologías del stack. La infraestructura de cada opción —imagen, puertos,
// servicio de docker-compose, sondeo por CLI, healthcheck, literales SQL por motor— es
// NEUTRAL y vive en keel-core/gen/infra-catalog.js, que comparten todos los generadores: así
// el servicio de keel-spring y el de keel-nest del mismo diseño se prueban contra los mismos
// contenedores. Este módulo la reexporta para que el scaffolding la siga pidiendo a un solo
// sitio. Lo que la opción añade al proyecto Java (dependencias Gradle, módulo Flyway, cadena de
// conexión de Spring) está en java-stack.js.

export * from 'keel-core/gen/infra-catalog';
