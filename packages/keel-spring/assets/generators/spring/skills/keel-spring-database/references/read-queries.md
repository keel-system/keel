# Consultas de lectura que proyectan otro agregado

Esta referencia es la **excepción**, no el caso normal. Antes de escribir una línea de JPQL,
comprueba el criterio de `{{keel:docs}}/conventions/read-composition.md`:

- ¿La operación solo necesita **mostrar** los datos del agregado embebido? → resuélvelo con el
  `<X>RefResolver` que build inyecta en el handler (una consulta por agregado, por lote).
  **No sigas leyendo.**
- ¿La operación **filtra u ordena** por un campo del agregado embebido, y pagina? → el lote es
  estructuralmente incapaz (no se pagina en BD por una columna ausente de la consulta madre).
  Sigue aquí.

Cuando es una **ordenación**, no tienes que deducirlo: el diseño lo declara
(`sort: [brand.name:asc]`), build emite el warning *"ordena por … campo del agregado
embebido"* y deja la nota en el stub del handler. Esa es la señal que te trae aquí. Con un
filtro la detección es tuya: el DSL no los declara y llegan como `@RequestParam`.

## Entity join ad-hoc: el join sin asociación

Entre agregados no hay `@ManyToOne`, solo una columna `UUID`. JPQL permite unir dos entidades por
una condición explícita sin que exista asociación mapeada — es la pieza que hace esto posible:

```java
// infrastructure/persistence/repositories/ProductRowJpaRepository.java
public interface ProductRowJpaRepository extends JpaRepository<ProductJpa, UUID> {

    @Query("""
            select p.id as id,
                   p.name as name,
                   p.status as status,
                   b.id as brandId,
                   b.name as brandName
              from ProductJpa p
              left join BrandJpa b on b.id = p.brandId
             where (:status is null or p.status = :status)
            """,
            countQuery = """
            select count(p)
              from ProductJpa p
              left join BrandJpa b on b.id = p.brandId
             where (:status is null or p.status = :status)
            """)
    Page<ProductRow> findRows(@Param("status") ProductStatus status, Pageable pageable);
}
```

`left join`, no `join`: con `inner join` un producto cuya marca falta desaparece del listado —
un filtro que nadie pidió.

## Proyección plana + ensamblado en Java

La proyección es **plana** (interface projection, como arriba, o `Tuple`), y el `RefDto` se
construye en Java:

```java
public interface ProductRow {
    UUID getId();
    String getName();
    ProductStatus getStatus();
    UUID getBrandId();
    String getBrandName();
}

// en el adaptador de lectura
return page.map(row -> new ListProductsResponseDto(
        row.getId(),
        row.getName(),
        row.getStatus(),
        row.getBrandId() != null ? new BrandRefDto(row.getBrandId(), row.getBrandName()) : null));
```

Por qué no una constructor expression anidada (`select new ...Dto(p.id, new BrandRefDto(b.id, b.name))`):
no es portable —Hibernate la acepta solo en el nivel superior— y con `left join` sin coincidencia
todos los campos de `b` llegan `null`, produciendo un `BrandRefDto(null, null)` en vez de `null`.
Por eso el `!= null` sobre el id ajeno es obligatorio.

## Paginación

- **NUNCA `@EntityGraph` ni `JOIN FETCH` de una colección en una consulta paginada.**
  Hibernate no puede aplicar `LIMIT` a un resultado con filas duplicadas por el join, así
  que se trae **todas** las filas y pagina EN MEMORIA (`HHH000104`): funciona en la demo y
  se cae con la tabla llena. En el listado, las colecciones van por lote (`@BatchSize`, ya
  generado): coste constante y dos consultas acotadas. El `@EntityGraph` que build emite
  está solo en las lecturas de UN agregado, y copiarlo a la consulta paginada es
  exactamente este error.
- **`countQuery` explícita siempre** que la consulta lleve join. La que deriva Spring Data cuenta
  filas del resultado del join; con `left join` a un `many-to-one` coincide, pero es frágil y en
  cuanto alguien añada un join a una colección el total pasa a estar inflado.
- El **orden** va en el JPQL (`order by b.name`) o por `Pageable` con propiedades de la entidad
  raíz. Un `Sort` que nombre alias de la proyección (`brandName`) **no** funciona: Spring Data lo
  traduce a una propiedad de la entidad y falla en tiempo de ejecución.
- Si el orden por el campo ajeno es el motivo de todo esto, escríbelo en el JPQL y documenta en
  el Javadoc que el `Pageable` entrante llega con el `Sort` ignorado a propósito.

## Dónde vive

En un **adaptador de lectura separado**, no en el repositorio del agregado:

```
domain/repository/ProductReadRepository.java            ← puerto, devuelve la vista de lectura
infrastructure/persistence/repositories/
    ProductRowJpaRepository.java                        ← @Query
    ProductReadRepositoryImpl.java                      ← ensambla el DTO
```

`ProductRepository` (el del agregado) sigue devolviendo `Product` completos y no conoce
`BrandJpa`. El adaptador de lectura es el único punto donde dos esquemas se tocan, y eso es
deliberado: acota el acoplamiento a un archivo.

## Reclamar un lote: la consulta de un barrido

Un barrido con `@Scheduled` corre en **todas** las réplicas a la vez, así que una consulta que solo
*lee* devuelve las mismas filas en todas y el trabajo se hace N veces
(`conventions/dependencies.md § El barrido corre en todas las réplicas`). La consulta tiene que
**reclamar**: llevarse un lote acotado bajo lock de escritura con SKIP LOCKED, dentro de la
transacción del barrido.

```java
/**
 * Reservas que llevan demasiado tiempo esperando al almacén. Lock de escritura con
 * SKIP LOCKED (el hint de lock timeout -2): con varias réplicas, cada una se lleva un
 * lote disjunto en vez de competir por las mismas filas.
 */
@Lock(LockModeType.PESSIMISTIC_WRITE)
@QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "-2"))
@Query("select r from ReservationJpa r where r.status = :status and r.updatedAt < :cutoff order by r.updatedAt asc")
List<ReservationJpa> claimStale(@Param("status") ReservationStatus status,
                                @Param("cutoff") Instant cutoff,
                                Pageable pageable);
```

Tres cosas que no son opcionales:

- **El `Pageable`** acota el lote. Sin él, la primera réplica bloquea la tabla entera y las demás se
  quedan sin nada que hacer — que es lo contrario de repartir.
- **El lock vive hasta el fin de la transacción** del método que llama, así que el barrido tiene que
  ser `@Transactional` y hacer su trabajo dentro. Si sales de la transacción y luego actúas, la fila
  ya está suelta.
- **En H2 (perfil `test`) SKIP LOCKED puede degradarse** a un lock normal. No invalida nada: la
  validación de concurrencia se hace contra la base real de `infra/`.

Es exactamente el patrón de `OutboxRelay.findPending`, que `build` ya genera en este mismo proyecto:
míralo antes de escribir el tuyo.

## Qué no hacer

- **`@ManyToOne` entre dos raíces** para poder usar `JOIN FETCH` o `@EntityGraph`. Rompe la
  frontera de agregado (`constitution.md`) y arrastra cascadas y lazy loading entre agregados.
- **`@EntityGraph`** aquí: no hay asociación que recorrer. Solo aplica a relaciones dentro de un
  agregado (`jpa-mapping.md`).
- **Native query**. El servicio se genera para seis dialectos y el SQL crudo no es portable. Si
  hace falta de verdad (función específica del motor), aíslala en el adaptador de lectura, deja
  el dialecto asumido en el Javadoc y consulta `references/dialects/<database>.md` —
  y espera que la validación en H2 del perfil `test` no la soporte.
- **Meter esta consulta en el repositorio del agregado.** Ese puerto es para cargar y guardar
  agregados; una vista de lectura no es un agregado.

## Verificación

Con `show-sql: true` en local, ejecuta el flujo `FL-*` que cubre la operación y cuenta las
consultas: deben ser **una** (más la del count si pagina), y el número **no** debe cambiar al
crecer el tamaño de página.
