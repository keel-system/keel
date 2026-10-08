# Ampliar un puerto y su adaptador documental

Cuando un handler necesita una consulta que build no derivó (un filtro del diseño, una búsqueda por un campo
que no es la clave natural), se añade a las DOS piezas:

1. el **puerto** en `domain/repository/<raíz>-repository.ts`: un método abstracto en términos del dominio
   (tipos del dominio, nunca un `Document`);
2. el **adaptador** `infrastructure/persistence/repositories/<raíz>-repository-impl.ts`: la consulta sobre
   `this.collection`, con `{ session: this.session }`, y el resultado por `toDomain<Raíz>(...)`, que ya existe.

```ts
async findByStatus(status: JobStatus): Promise<Job[]> {
  const documents = await this.collection
    .find({ status: toEnumName(JobStatus, status) }, { session: this.session })
    .sort({ _id: 1 })
    .toArray();
  return documents.map(toDomainJob);
}
```

- Cada valor del filtro va **como se guarda**: el uuid con `toUuid(...)`, un decimal con `toDecimal128(...)`,
  una fecha sin hora con `toDay(...)`, un enum con `toEnumName(...)` (la constante, no el literal del cable).
  Todos en `src/infrastructure/persistence/bson-values.ts`. Un filtro con el valor del dominio tal cual NO
  falla: no casa con nada.
- Las claves son las del documento (`snake_case`; un value object es una ruta `precio.importe`; una hija se
  atraviesa: `sections.status`). Copia las que ya usa `toDocument<Raíz>` del mismo adaptador.
- Un listado ordena SIEMPRE con desempate por `_id`: sin él, dos páginas consecutivas repiten un documento y
  omiten otro.
- Una lectura masiva de documentos para filtrar en memoria es un defecto: filtra en la consulta.
- Si la consulta necesita un índice que el diseño no declara, eso es un hueco del diseño (`designGaps`), no
  un `createIndex` en el adaptador.
