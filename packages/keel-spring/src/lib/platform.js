// La línea de Spring Boot de un proyecto YA generado, y si este generador puede seguir escribiendo en él.
//
// `build` sin modo y `build --refresh` escriben sobre un proyecto que el agente ya completó. Entre dos
// líneas de Boot eso no es un refresco: los archivos de build saldrían para Boot 4 (Jackson 3, los
// test slices en sus módulos, el reintento de Spring AMQP 4) y los del agente seguirían escritos para
// Boot 3 —imports de `com.fasterxml.jackson.databind`, `@AutoConfigureObservability`…—, y el proyecto
// dejaría de compilar por archivos que build no puede tocar. Por eso se rechaza en voz alta y se dice
// cómo salir: regenerar en un directorio limpio, que es lo que de verdad es un salto de plataforma.
//
// La línea no se estampa aparte: el manifiesto ya guarda la firma del generador (`keel-spring@0.1.7`) y
// la versión desde la que este generador emite Boot 4 es la frontera.

import { SPRING_BOOT_LINE, SPRING_BOOT_VERSION } from './assets.js';

/** Primera versión de keel-spring que genera sobre Spring Boot 4. */
export const BOOT4_SINCE = '0.2.0';

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return match ? match.slice(1, 4).map(Number) : null;
}

function before(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** La línea de Boot de una firma del manifiesto (`keel-spring@x.y.z`), o null si no se puede saber. */
export function springBootLineOf(generator) {
  const match = /^keel-spring@(.+)$/.exec(generator ?? '');
  const version = match ? parseVersion(match[1]) : null;
  if (!version) return null;
  return before(version, parseVersion(BOOT4_SINCE)) ? '3' : SPRING_BOOT_LINE;
}

/**
 * El motivo por el que no se puede escribir sobre este proyecto, o null si se puede. Un proyecto sin
 * manifiesto (nuevo, o anterior al mecanismo) no se juzga aquí: no hay firma que leer.
 */
export function platformMismatch(previousGenerator) {
  const line = springBootLineOf(previousGenerator);
  if (line === null || line === SPRING_BOOT_LINE) return null;
  return (
    `El proyecto lo generó ${previousGenerator}, sobre Spring Boot ${line}; este keel-spring genera sobre ` +
    `Spring Boot ${SPRING_BOOT_VERSION}. Un salto de línea de Boot no se refresca: los archivos del agente ` +
    'siguen escritos para la línea anterior y el proyecto dejaría de compilar. Regenera en un directorio ' +
    'limpio (mueve o borra services/<servicio>-spring/ y vuelve a ejecutar build) y lanza el pipeline ' +
    'desde cero.'
  );
}
