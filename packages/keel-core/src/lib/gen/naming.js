// Convenciones de nombres NEUTRALES: del diseño (kebab/camel/Pascal) a las formas que usa
// cualquier generador para identificadores, tablas, rutas y destinos de mensajería.
//
// Lo propio de un lenguaje (el paquete Java de keel-spring, por ejemplo) no vive aquí: cada
// generador lo añade en su `naming.js`. Que estas formas sean UNA sola definición es lo que
// hace que dos generadores del mismo diseño nombren igual una tabla, una ruta o una cola.

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
// default del YAML, el publisher, la URL de la cola en el arnés y el
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
