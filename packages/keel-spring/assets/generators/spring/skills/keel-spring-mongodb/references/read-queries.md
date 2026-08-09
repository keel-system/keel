# Consultas de lectura compuestas

Léelo cuando una operación de listado tenga que **filtrar u ordenar** por un campo de
un agregado que el payload `embed`a. Para todo lo demás, lo que build genera basta.

## Lo primero: casi nunca hace falta

Dos cosas que en la rama relacional pedían un join, aquí no piden nada:

- **Las entidades hijas ya vienen.** Están dentro del documento; leer el informe es
  leer sus secciones y sus puntos. No hay `@OneToMany`, ni fetch, ni N+1 posible.
- **Un `embed` se resuelve por lote.** El `<X>RefResolver` que genera build carga
  todas las raíces referenciadas de una página con un `findAllById` — una consulta
  por agregado embebido, no una por elemento.

Antes de escribir una agregación, comprueba que el problema no es simplemente que el
resolver no se está usando.

## Cuándo sí: filtrar u ordenar por el agregado ajeno

El lote resuelve la **proyección** (devolver el nombre de la marca junto al
producto), pero no el **predicado**: para ordenar por `brand.name` o filtrar por él,
la base tiene que conocer ese campo en el momento de la consulta, y el documento solo
guarda `brand_id`.

Ahí sí hace falta `$lookup`, y va en un **adaptador de lectura separado** —nunca
dentro del repositorio del agregado— por el mismo motivo que en la rama relacional:
el puerto del agregado sirve a la escritura y no debe ensancharse con proyecciones de
consulta. El criterio completo está en
`{{keel:docs}}/conventions/read-composition.md`.

```java
@Component
public class ProductListingAdapter {

    private final MongoTemplate mongoTemplate;

    public Page<ProductListingRow> list(Pageable pageable) {
        List<AggregationOperation> stages = List.of(
                Aggregation.lookup("brands", "brand_id", "_id", "brand"),
                Aggregation.unwind("brand", true),          // true = preserva los sin marca
                Aggregation.sort(withStableOrder(pageable.getSort())),
                Aggregation.skip(pageable.getOffset()),
                Aggregation.limit(pageable.getPageSize()));

        List<ProductListingRow> rows = mongoTemplate
                .aggregate(Aggregation.newAggregation(stages), "products", ProductListingRow.class)
                .getMappedResults();

        long total = mongoTemplate.count(new Query(), "products");
        return new PageImpl<>(rows, pageable, total);
    }
}
```

Cuatro cosas que se olvidan y salen caras:

1. **`unwind` con `preserveNullAndEmptyArrays = true`.** Sin ese `true`, un producto
   sin marca desaparece del listado. Es un `LEFT JOIN` frente a un `INNER JOIN`, y el
   diseño casi siempre quiere el primero.
2. **El desempate por id.** `$lookup` + `$sort` + `$skip` tiene el mismo problema que
   cualquier paginación sin orden total: dos páginas consecutivas pueden repetir un
   documento y omitir otro. El `TIE_BREAKER` del repositorio no llega aquí — añádelo
   a mano al `Sort`.
3. **El `count` va aparte.** Una agregación con `$skip`/`$limit` no devuelve el total;
   `$facet` lo resuelve en una sola pasada si el coste de las dos consultas importa.
4. **Índice en el campo del `$lookup`.** El `localField` (`brand_id`) necesita
   índice, o cada página hace una búsqueda completa por elemento. Regístralo en
   `MongoIndexConfig` como cualquier otro (ver `indexes.md`).

## Ordenar por un campo de una colección anidada

Un dot-path a una hija (`sections.status`) es una ruta válida y **indexable** —al
contrario que en JPA, donde vivía en otra tabla—, pero como criterio de orden de un
listado es ambiguo: un informe tiene varias secciones, así que Mongo ordena por el
mínimo (ascendente) o el máximo (descendente) del array. Si el diseño quiere «ordena
por el estado de la sección X», eso es un campo derivado en la raíz, no un orden
sobre el array.

## Reclamar un lote: la consulta de un barrido

Un barrido con `@Scheduled` corre en **todas** las réplicas a la vez, así que una consulta que solo
*lee* devuelve los mismos documentos en todas y el trabajo se hace N veces
(`conventions/dependencies.md § El barrido corre en todas las réplicas`).

En MongoDB no hay `SELECT ... FOR UPDATE SKIP LOCKED`, y **no hace falta**: lo que sí hay es
actualización atómica por documento. Se reclama con `findAndModify`, que filtra y marca en la misma
operación, así que dos réplicas nunca se llevan el mismo documento:

```java
/**
 * Reclama UNA reserva estancada y la marca como reclamada en la misma operación atómica.
 * Se llama en bucle hasta agotar el lote: cada réplica se lleva documentos distintos.
 */
public Optional<ReservationDocument> claimStale(ReservationStatus status, Instant cutoff, Instant now) {
    Query query = new Query(Criteria.where("status").is(status)
        .and("updatedAt").lt(cutoff)
        .orOperator(Criteria.where("claimedAt").exists(false),
                    Criteria.where("claimedAt").lt(cutoff)));
    Update update = new Update().set("claimedAt", now);
    FindAndModifyOptions options = FindAndModifyOptions.options().returnNew(true);
    return Optional.ofNullable(mongoTemplate.findAndModify(query, update, options, ReservationDocument.class));
}
```

Tres cosas que no son opcionales:

- **La marca de reclamación (`claimedAt`) es lo que hace el reclamo visible.** Sin ella el filtro
  vuelve a encontrar el mismo documento en la siguiente vuelta del bucle.
- **La marca caduca.** El `orOperator` de arriba vuelve a admitir lo reclamado hace demasiado: si una
  réplica muere entre reclamar y actuar, ese documento tiene que volver a estar disponible o queda
  atascado para siempre — el barrido habría creado el problema que venía a resolver.
- **Un índice sobre `{ status: 1, updatedAt: 1 }`**, declarado en `MongoIndexConfig` como cualquier
  otro: el barrido corre cada pocos minutos y sin índice recorre la colección entera cada vez.
