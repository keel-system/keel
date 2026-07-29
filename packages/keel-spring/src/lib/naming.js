// Convenciones de nombres del scaffolding: del diseño (kebab/camel/Pascal)
// a los identificadores Java, paquetes, tablas y rutas.

function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
}

export function pascalCase(name) {
  return words(name)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join('');
}

export function camelCase(name) {
  const pascal = pascalCase(name);
  return pascal ? pascal[0].toLowerCase() + pascal.slice(1) : pascal;
}

export function kebabCase(name) {
  return words(name)
    .map((word) => word.toLowerCase())
    .join('-');
}

// Nombre físico de un destino de mensajería (topic, cola, exchange) válido para
// el broker elegido. El nombre por convención de Keel lleva punto
// (`<servicio>.events`), idiomático en Kafka y RabbitMQ y donde ya funciona; pero
// SNS y SQS solo admiten [A-Za-z0-9_-] en topics y colas, así que ahí el punto
// hace que la creación del recurso falle y que la app arranque apuntando a una
// cola que no existe. Se sanea al derivar el nombre, no al usarlo: así el
// default del YAML, el @Value del publisher, la URL de la cola en el arnés y el
// script de topología dicen todos lo mismo.
export function brokerSafeName(name, broker) {
  if (broker !== 'snssqs') return name;
  return String(name).replace(/[^A-Za-z0-9_-]/g, '-');
}

export function snakeCase(name) {
  return words(name)
    .map((word) => word.toLowerCase())
    .join('_');
}

export function screamingSnake(name) {
  return snakeCase(name).toUpperCase();
}

// Pluralización con reglas simples en inglés (los nombres del DSL son identificadores,
// no prosa): suficiente para tablas y rutas; el agente puede ajustar excepciones.
export function pluralize(name) {
  if (/[^aeiou]y$/i.test(name)) return name.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/i.test(name)) return name + 'es';
  return name + 's';
}

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
