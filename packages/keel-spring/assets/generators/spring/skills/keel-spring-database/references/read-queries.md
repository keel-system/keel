# Consultas de lectura que proyectan otro agregado

Esta referencia es la **excepción**, no el caso normal. Antes de escribir una línea de JPQL,
comprueba el criterio de `.claude/conventions/read-composition.md`:

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
