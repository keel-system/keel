# Ampliar un puerto y su adaptador documental

Cuando un handler necesita una consulta que build no derivó (un filtro del diseño, una búsqueda por un campo que no es
la clave natural), se añade a las DOS piezas:

1. el **puerto** en `Domain/Repository/I<Raíz>Repository.cs`: un método en términos del dominio (tipos del dominio,
   nunca un `BsonDocument`);
2. el **adaptador** `Infrastructure/Persistence/Repositories/<Raíz>Repository.cs`: la consulta con el `Find(...)` del
   propio adaptador (que toma la sesión de la transacción abierta) y el resultado por `ToDomain<Raíz>(...)`, que ya
   existe.

```csharp
public async Task<IReadOnlyList<Job>> FindByStatus(JobStatus status, CancellationToken cancellationToken = default)
{
    var documents = await Find(new BsonDocument("status", BsonValues.Enum(status, EnumColumns.JobStatusConstant)))
        .Sort(new BsonDocument("_id", 1))
        .ToListAsync(cancellationToken);
    return [.. documents.Select(ToDomainJob)];
}
```

- Cada valor del filtro va **como se guarda**, por `Persistence/BsonValues.cs`: el uuid con `BsonValues.Of(guid)`
  (binario de subtipo 4), un decimal con `BsonValues.Of(decimal)` (`Decimal128`), una fecha sin hora con
  `BsonValues.Day(...)`, un enum con `BsonValues.Enum(valor, EnumColumns.<Enum>Constant)` (la constante, no el literal
  del cable). Un filtro con el valor del dominio tal cual (un `Guid` como texto, un enum por su nombre de C#) NO falla:
  no casa con nada.
- Las claves son las del documento (`snake_case`; un value object es una ruta `price.amount`; una hija se atraviesa:
  `sections.status`). Copia las que ya usa `ToDocument<Raíz>` del mismo adaptador.
- Un listado ordena SIEMPRE con desempate por `_id`: sin él, dos páginas consecutivas repiten un documento y omiten
  otro.
- Una lectura masiva de documentos para filtrar en memoria es un defecto: filtra en la consulta.
- Si la consulta necesita un índice que el diseño no declara, eso es un hueco del diseño (`designGaps`), no un
  `CreateIndex` en el adaptador.
