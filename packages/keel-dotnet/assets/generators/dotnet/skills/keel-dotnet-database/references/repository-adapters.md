# Ampliar un puerto de repositorio

Build genera la firma que puede derivar mecánicamente: `FindById`, el finder de la clave natural
(`FindBy<Campo>`), `List(pageable)` si alguna operación pagina, `Save` y `DeleteById`. Lo que piden las
`preconditions` y `rules` —prosa del diseño, no una firma— lo añade el agente: es trabajo esperado, no un defecto
del scaffolding.

## Las dos mitades, siempre juntas

```csharp
// src/<Raíz>.Domain/Repository/IProductRepository.cs — el PUERTO (dominio: sin EF Core)
/// <summary>Cuántos productos activos hay en una categoría (regla: no se borra una categoría con productos).</summary>
Task<long> CountActiveByCategory(Guid categoryId, CancellationToken cancellationToken = default);
```

```csharp
// src/<Raíz>.Infrastructure/Persistence/Repositories/ProductRepository.cs — el ADAPTADOR
public Task<long> CountActiveByCategory(Guid categoryId, CancellationToken cancellationToken = default) =>
    db.Set<ProductRow>().LongCountAsync(r => r.CategoryId == categoryId && r.Status == ProductStatus.Active, cancellationToken);
```

- `db` es el `DbContext` del ámbito, el de la transacción del mediator. Nunca uno creado aparte.
- Lo que el adaptador devuelve al dominio pasa por `ToDomain(...)` (ya generado): nunca una fila fuera del
  adaptador. Una lectura que devuelve agregados parte de `Graph()` (la raíz con sus hijas) y lleva
  `AsNoTracking()`.
- Las propiedades de la consulta son las de la **fila** (un value object aplanado es `PriceAmount`,
  `PriceCurrency`), no las del agregado.
- El token de cancelación del handler llega hasta la consulta.

## Lo que no se hace

- **Filtrar en memoria**: `ToListAsync()` y después un `Where` funciona con tres filas de prueba y no en
  producción. La condición va al motor (que el `Where` esté ANTES del `ToListAsync`).
- **Una consulta por elemento** dentro de un bucle sobre una página (N+1): una consulta con
  `ids.Contains(r.Id)` y se indexa el resultado.
- **Un patrón LIKE concatenado a mano** (`EF.Functions.Like(r.Name, "%" + texto + "%")`): el texto buscado es
  literal, y un `%` o un `_` del parámetro harían de comodín. Se escapan antes de componer el patrón, y sobre el
  valor ya plegado con `TextFold` si el campo lo pliega.
- **Ordenar sin desempate**: una consulta paginada nueva termina su orden en `Id`, como `List`; sin él, dos
  páginas seguidas pueden repetir una fila y omitir otra.
- **Escribir sin `Save`**: el bloqueo optimista, la auditoría y la traducción de constraints viven en el `Save`
  generado. Un `ExecuteUpdateAsync` a pelo se los salta.
