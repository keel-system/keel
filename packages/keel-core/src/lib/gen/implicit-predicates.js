// Los predicados IMPLÍCITOS de una lectura: condiciones que toda consulta sobre una raíz lleva sin que la operación las
// nombre (evaluación 2.24, § 8: «tres recomendaciones son un mismo mecanismo»). Hoy son dos y se componen siempre con AND,
// entre sí y con los criterios y el `where` de la búsqueda:
//
//   · el ALCANCE del llamante (DSL 2.27, `reads` en scoping u ownership): `scope`, el ReadScope de read-scope.js;
//   · la VIDA de la fila (DSL 2.28, `deletion: logical`): `live`, que deja fuera lo borrado.
//
// Un solo sitio a propósito: dos emisores por generador tendrían que componerse en cada finder, y el sabotaje que lo
// mide (`lc-implicit-replace`) es uno. Lo que NO lleva el predicado de vida es la lectura por referencia (`embed`,
// `findAllById`): una raíz borrada sigue siendo historia de quien la referencia (D3 de PLAN-DSL-228-CICLO-DE-VIDA.md).

/** ¿Oculta la raíz lo que se borra? */
export function hidesDeleted(entity) {
  return entity?.deletion === 'logical';
}

/**
 * Los predicados implícitos de la lectura `operation` sobre la raíz `entity`: `{ scope, live }`. `scope` es el ReadScope
 * de la operación o null; `live` es true si la raíz tiene borrado lógico.
 */
export function implicitPredicates(operation, entity) {
  return { scope: operation?.readScope ?? null, live: hidesDeleted(entity) };
}

/** ¿Tiene la lectura algún predicado implícito? Con alguno, una búsqueda sin criterios sigue necesitando su finder. */
export function hasImplicitPredicate({ scope, live }) {
  return Boolean(scope) || live;
}
