# Modelado del dominio — modelo rico, no anémico

Cómo se escribe el **interior** del proyecto `<Raíz>.Domain`: agregados que protegen su estado, value objects
auto-validados y el reparto de la validación entre capas. Principio: el agregado **protege sus invariantes**; el
handler orquesta. Si un handler lee propiedades, decide y escribe el resultado de vuelta, la regla se ha fugado
del dominio: pídele al agregado que haga la operación.

## Reparto de la validación por capa

| Qué se valida | Dónde vive | Fuente en el diseño |
|---|---|---|
| Forma y obligatoriedad del contrato HTTP | el **lector generado** de cada operación (`<Raíz>.Api/Endpoints`): ya está escrito | `constraints`, `required` |
| Formato o rango de un value object COMPUESTO | su constructor en `Domain/ValueObject` (ya generado) | `types.T` con `fields` |
| Formato de un value type ESCALAR | `<Tipo>Format.Validate(...)` en el dominio, **tras normalizar** | `types.T` con `base` + `constraints.pattern` |
| Regla siempre cierta sobre el estado del agregado | guarda en el agregado: factory **y** cada método mutador | `invariants` |
| Transición de estado válida | método semántico apoyado en `TransitionTo` | `lifecycle` |
| Precondición que consulta persistencia (unicidad, existencia) | handler, vía el **puerto** de repositorio | `preconditions` |

La validación de negocio **nunca** vive solo en la entrada HTTP: un mensaje que llegue por otro camino (un
listener, un barrido) se saltaría la regla.

### El formato de un value type escalar: en la entrada, y otra vez en el dominio

El lector de la petición valida el `pattern` que un campo hereda de su value type: mal formado es un 400 antes
que cualquier error de negocio (`mapping.md` § El formato se valida en la entrada). El dominio lo **repite**,
porque un evento o una operación interna no pasan por el lector: build genera `<Tipo>Format` en
`Domain/ValueObject`, con la expresión del diseño escrita una sola vez. Llamarla es tuyo, en el factory y en
**todo** método que asigne el campo:

```csharp
public static Product Create(string sku, string name, string? notes, Money price)
{
    var normalized = sku.Trim().ToUpperInvariant(); // la normalización que el diseño describe
    SKUFormat.Validate(normalized);                 // lanza ValueFormatException (400)
    …
}
```

Y en **todos** los campos de ese tipo, no solo donde un escenario lo mire: sin la llamada el servicio acepta
valores que el diseño declara imposibles y ningún escenario que no lo mire lo delata.
`infra/check-domain-guards.sh` es el gate: sale rojo mientras algún campo con formato no tenga quien lo haga
cumplir.

## Creación: factory, no constructor

El constructor que genera build recibe un `<Raíz>State` y es **solo rehidratación** desde persistencia: el estado
ya es válido y no se revalida. La creación de negocio va por un factory estático que aplica las reglas, deriva los
campos `generated`/`computed` y fija el estado inicial del `lifecycle`. El `<Raíz>State` tiene sus propiedades
`required`: el compilador exige que no falte ninguna.

```csharp
/// <summary>Alta de producto. Invariante del diseño: un producto activo tiene precio positivo.</summary>
public static Product Create(string sku, string name, string? notes, Money price)
{
    var normalized = sku.Trim().ToUpperInvariant();
    SKUFormat.Validate(normalized);
    return new Product(new ProductState
    {
        Id = Guid.CreateVersion7(),    // los ids de una raíz nacen con la versión 7 (orden temporal en el índice)
        Sku = normalized,
        Name = name,
        Notes = notes,
        Price = price,
        ApiToken = null,
        Status = ProductStatus.Draft,  // el estado inicial del lifecycle
        LockVersion = null             // la gestiona la persistencia
    });
}
```

La auditoría que declara el dominio (`persistence.audit: declared`) la estampa el adaptador al guardar, no el
factory: el dominio no conoce al llamante. En el alta, `CreatedAt`/`UpdatedAt` van con el reloj y
`CreatedBy`/`UpdatedBy` **vacíos** (`string.Empty`), y el adaptador los rellena con el actor porque vacío cuenta
como ausente. Nunca `null!` (le miente al compilador) ni un actor inventado (`"system"` se guardaría tal cual).

El factory lanza el `<PascalCode>Error` **declarado en el diseño** para cada caso. Si una regla no tiene error
declarado, es un hueco del diseño: no inventes un `code`.

## Mutación: un método de negocio por regla

Nada de setters públicos. Cada cambio de estado es un método con nombre del lenguaje del diseño (`Activate()`,
`Retire()`, `Rename(...)`), que valida primero y muta después. Para el `lifecycle`, el método semántico aplica la
regla de la transición y llama a `TransitionTo(<Estado>)`, que ya rechaza una transición no declarada con
`InvalidStateTransitionException` (409). Si el diseño declara un error propio para ese caso
(`PRODUCT_ALREADY_RETIRED`), lánzalo **antes** de llamar a `TransitionTo`: el escenario espera ese `code`, no el
genérico.

```csharp
/// <summary>Retira el producto. Regla del diseño: uno ya retirado responde PRODUCT_ALREADY_RETIRED.</summary>
public void Retire()
{
    if (Status == ProductStatus.Retired) throw new ProductAlreadyRetiredError("El producto ya está retirado");
    TransitionTo(ProductStatus.Retired);
}
```

Una transición idempotente (éxito si ya está en el destino) es explícita en el método semántico: `TransitionTo`
no la cubre.

Las propiedades del agregado tienen `private set`: un método nuevo las asigna directamente (`Name = …`) después
de sus guardas. El estado nunca se expone como objeto mutable: las colecciones se exponen como
`IReadOnlyList<T>` y se copian al entrar.

## Invariantes

Todo `invariants` del diseño tiene su guarda —normalmente un método privado `Require…()`— llamada desde el
factory **y** desde cada método que pueda romperla. Build deja un comentario `TODO invariante` encima de la clase
por cada uno: no lo borres sin escribir la guarda.

## Aritmética con `decimal`

Importes, tasas y magnitudes van en `decimal`, que conserva la escala del texto (`2.50m` no es `2.5m` al
serializar). Lo que cambia la escala se fija con `Decimals.SetScale` (`Domain/Support/Decimals.cs`):

```csharp
var total = unit.Amount * quantity;                                          // la escala crece: 2 + 0
var share = Decimals.SetScale(total / 3m, 2);                                // división: escala y redondeo SIEMPRE
var rounded = Decimals.SetScale(total, 2, MidpointRounding.AwayFromZero);   // el HALF_UP de los otros dos
if (total <= 0m) throw new …;                                                // comparar por valor
```

`decimal.Round(x, 2)` no sirve para fijar la escala: redondea al par por defecto y no SUBE la escala (`2.5m`
sigue siendo `2.5`). `double` y `float` **nunca** son la fuente de un importe. El value object generado normaliza
la escala de su importe en el constructor.

Un `long` del diseño es `long`.

## Igualdad

Los value objects se comparan con su `Equals(...)` (campo a campo, con la escala de los decimales, como
`BigDecimal.equals`), nunca con `ReferenceEquals`. Para comparar dos importes por su valor sin la escala, `==`
entre los `decimal`.
