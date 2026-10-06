// Convenciones de nombres del scaffolding: del diseño (kebab/camel/Pascal)
// a los identificadores Java, paquetes, tablas y rutas.
//
// Las formas neutrales —las que tienen que coincidir con las de cualquier otro generador del
// mismo diseño (tablas, rutas, destinos)— viven en keel-core/gen y se reexportan aquí para que
// el scaffolding las siga pidiendo a un solo módulo. Lo que queda escrito en este archivo es lo
// propio de Java: el grupo y el paquete base.

export { pascalCase, camelCase, kebabCase, snakeCase, screamingSnake, pluralize, brokerSafeName } from 'keel-core/gen';

// Grupo por defecto (groupId): com.<domain> (ver project-layout.md). Es el
// default que sugiere el cuestionario cuando el usuario no introduce otro.
export function defaultGroup(manifest) {
  const domain = (manifest?.service?.domain ?? 'app').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `com.${domain}`;
}

// Segmento del paquete correspondiente al nombre del servicio (sin guiones).
function serviceSegment(manifest) {
  return (manifest?.service?.name ?? 'service').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Paquete base del servicio: <group>.<nombreSinGuiones>. Con group informado y
// válido lo usa; si no, cae al grupo por defecto com.<domain>.
export function basePackage(manifest, group) {
  const prefix = isValidPackage(group) ? group : defaultGroup(manifest);
  return `${prefix}.${serviceSegment(manifest)}`;
}

// Valida un groupId Java: segmentos [a-z][a-z0-9]* separados por punto.
export function isValidPackage(pkg) {
  return typeof pkg === 'string' && /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(pkg);
}

export function packageToPath(pkg) {
  return pkg.split('.').join('/');
}
