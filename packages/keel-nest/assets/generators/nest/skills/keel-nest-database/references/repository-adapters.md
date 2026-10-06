# Ampliar un puerto de repositorio

build genera la firma que puede derivar mecánicamente: `findById`, el finder de la clave natural
(`findBy<Campo>`), `list(pageable)` si alguna operación pagina, `save` y `deleteById`. Lo que piden las
`preconditions` y `rules` —prosa del diseño, no una firma— lo añade el agente: es trabajo esperado, no
un defecto del scaffolding.

## Las dos mitades, siempre juntas

```ts
// src/domain/repository/product-repository.ts — el PUERTO (dominio: sin typeorm)
/** Cuántos productos activos hay en una categoría (regla: no se borra una categoría con productos). */
abstract countActiveByCategory(categoryId: string): Promise<number>;
```

```ts
// src/infrastructure/persistence/repositories/product-repository-impl.ts — el ADAPTADOR
async countActiveByCategory(categoryId: string): Promise<number> {
  return this.manager.count(ProductOrm, { where: { categoryId, status: ProductStatus.ACTIVE } });
}
```

- `this.manager` es el `EntityManager` de la transacción del mediator. Nunca `dataSource.manager` ni uno
  creado aparte.
- Lo que el adaptador devuelve al dominio pasa por `toDomain<Raíz>(...)` (ya generado): nunca una
  entidad ORM fuera del adaptador.
- Las propiedades del `where` son las de la **entidad ORM** (un value object aplanado es `priceAmount`,
  `priceCurrency`), no las del agregado.
- Un uuid se compara como `string`: el transformador de la columna lo convierte (en MySQL a
  `binary(16)`). En un `QueryBuilder` con SQL a mano, el transformador NO se aplica: usa los métodos de
  `find`/`count`, o convierte tú el parámetro igual que `column-transformers.ts`.

## Lo que no se hace

- **Filtrar en memoria**: cargar todas las filas y quedarse con algunas funciona con tres filas de
  prueba y no en producción. La condición va al motor.
- **Una consulta por elemento** dentro de un bucle sobre una página (N+1): una consulta con `In([...ids])`
  y se indexa el resultado.
- **Ordenar sin desempate**: una consulta paginada nueva termina su orden en `id`, como `list`; sin él,
  dos páginas seguidas pueden repetir una fila y omitir otra.
- **Escribir sin `save`**: el bloqueo optimista, la auditoría y la traducción de constraints viven en el
  `save` generado. Un `manager.update(...)` a pelo se los salta.
