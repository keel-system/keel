// La PÁGINA de un listado con persistencia, sin lenguaje (keel-core/gen).
//
// Con persistencia, un listado paginado se lee como el Pageable de Spring Data: `page`, `size` y `sort`, con
// sus defaults y su tope. Qué tamaño toma quien no lo pide, hasta dónde se acota y qué orden se aplica cuando el
// cliente no manda `?sort=` son respuesta observable de los tres servidores del mismo diseño, así que se
// deciden aquí. Estaban escritos en keel-spring (el orden) y copiados en keel-nest (el orden y los dos números)
// (incremento 6a de PLAN-KEEL-DOTNET.md).
//
// Cómo se LEE la query (indulgente: lo ilegible es el default, no un 400) es comportamiento de cada plataforma y
// se escribe en su idioma; sus reglas las fija el PageableHandlerMethodArgumentResolver de Spring Data.

/**
 * Los defaults del Pageable de keel-spring: `@PageableDefault` sin tamaño es 10 (la anotación gana a
 * `spring.data.web.pageable.default-page-size`), y el tope de Spring Data sin `max-page-size` es 2000.
 */
export const PAGEABLE_DEFAULT_SIZE = 10;
export const PAGEABLE_MAX_SIZE = 2000;

/**
 * El orden por defecto del diseño (`output.sort`) que se puede aplicar sin más, o []. Un criterio sobre un
 * agregado embebido (`brand.name`) necesita un join que lo resuelva y no es una propiedad de la entidad de
 * persistencia: entonces no se traduce ninguno, y lo avisa el modelo (es la señal del adaptador de lectura).
 */
export function translatableSort(operation) {
  const sort = operation?.sort ?? [];
  if (sort.length === 0 || sort.some((criterion) => criterion.embedded)) return [];
  return sort;
}

/** Tamaño por defecto, tope y orden por defecto de la página de una operación, ya resueltos. */
export function pageableDefaults(model, operation) {
  return {
    defaultSize: model.pagination?.defaultSize ?? PAGEABLE_DEFAULT_SIZE,
    maxSize: model.pagination?.maxSize ?? PAGEABLE_MAX_SIZE,
    defaultSort: translatableSort(operation)
  };
}
