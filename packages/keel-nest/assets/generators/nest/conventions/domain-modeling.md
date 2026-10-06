# Modelado del dominio — modelo rico, no anémico

Cómo se escribe el **interior** de `src/domain/`: agregados que protegen su estado, value objects
auto-validados y el reparto de la validación entre capas. Principio: el agregado **protege sus
invariantes**; el handler orquesta. Si un handler lee getters, decide y escribe el resultado de vuelta,
la regla se ha fugado del dominio: pídele al agregado que haga la operación.

## Reparto de la validación por capa

| Qué se valida | Dónde vive | Fuente en el diseño |
|---|---|---|
| Forma y obligatoriedad del contrato HTTP | el **lector generado** de cada operación (`infrastructure/rest`): ya está escrito | `constraints`, `required` |
| Formato o rango de un value object COMPUESTO | su constructor en `domain/valueobject` (ya generado) | `types.T` con `fields` |
| Formato de un value type ESCALAR | `<Tipo>Format.validate(...)` en el dominio, **tras normalizar** | `types.T` con `base` + `constraints.pattern` |
| Regla siempre cierta sobre el estado del agregado | guarda en el agregado: factory **y** cada método mutador | `invariants` |
| Transición de estado válida | método semántico apoyado en `transitionTo` | `lifecycle` |
| Precondición que consulta persistencia (unicidad, existencia) | handler, vía el **puerto** de repositorio | `preconditions` |

La validación de negocio **nunca** vive solo en la entrada HTTP: un mensaje que llegue por otro camino
(un listener, un barrido) se saltaría la regla.

### El formato de un value type escalar no está en la entrada

El lector de la petición deja caer a propósito el `pattern` que un campo hereda de su value type: el
formato describe el valor **ya normalizado** (un `SKU` en mayúsculas), y comprobarlo antes de normalizar
rechazaría peticiones válidas. build genera por eso `<Tipo>Format` en `domain/valueobject`, con la regex
del diseño escrita una sola vez. Llamarla es tuyo, en el factory y en **todo** método que asigne el
campo, después de normalizar:

```ts
static create(props: { sku: string; name: string; price: Money }): Product {
  const sku = props.sku.trim().toUpperCase(); // la normalización que el diseño describe
  SKUFormat.validate(sku);                    // lanza ValueFormatException (400)
  …
}
```

Y en **todos** los campos de ese tipo, no solo donde un escenario lo mire: sin la llamada el servicio
acepta valores que el diseño declara imposibles y ningún escenario que no lo mire lo delata.
`infra/check-domain-guards.sh` es el gate: sale rojo mientras algún campo con formato no tenga quien lo
haga cumplir.

## Creación: factory, no constructor

El constructor que genera build recibe un `<Raíz>State` y es **solo rehidratación** desde persistencia:
el estado ya es válido y no se revalida. La creación de negocio va por un factory estático que aplica las
reglas, deriva los campos `generated`/`computed` y fija el estado inicial del `lifecycle`:

```ts
/** Alta de producto. Invariante del diseño: el precio nunca es negativo. */
static create(props: { sku: string; name: string; notes: string | null; price: Money }): Product {
  const sku = props.sku.trim().toUpperCase();
  SKUFormat.validate(sku);
  return new Product({
    id: Uuids.v7(),             // domain/identity: los ids de una raíz nacen con la versión 7
    sku,
    name: props.name,
    notes: props.notes,
    price: props.price,
    apiToken: null,
    status: ProductStatus.DRAFT, // el estado inicial del lifecycle
    lockVersion: null            // la gestiona la persistencia
  });
}
```

El factory lanza el `<PascalCode>Error` **declarado en el diseño** para cada caso. Si una regla no tiene
error declarado, es un hueco del diseño: no inventes un `code`.

## Mutación: un método de negocio por regla

Nada de setters. Cada cambio de estado es un método con nombre del lenguaje del diseño (`activate()`,
`retire()`, `rename(...)`), que valida primero y muta después. Para el `lifecycle`, el método semántico
aplica la regla de la transición y llama a `this.transitionTo(<Estado>)`, que ya rechaza una transición
no declarada con `InvalidStateTransitionException` (409). Si el diseño declara un error propio para ese
caso (`PRODUCT_ALREADY_RETIRED`), lánzalo **antes** de llamar a `transitionTo`: el escenario espera ese
`code`, no el genérico.

```ts
/** Retira el producto. Regla del diseño: uno ya retirado responde PRODUCT_ALREADY_RETIRED. */
retire(): void {
  if (this.#status === ProductStatus.RETIRED) throw new ProductAlreadyRetiredError('El producto ya está retirado');
  this.transitionTo(ProductStatus.RETIRED);
}
```

Una transición idempotente (éxito si ya está en el destino) es explícita en el método semántico:
`transitionTo` no la cubre.

Los campos del agregado son `#privados`: un método nuevo los asigna directamente (`this.#name = …`)
después de sus guardas. El estado nunca se expone como objeto mutable: las colecciones se devuelven como
copias o `readonly`.

## Invariantes

Todo `invariants` del diseño tiene su guarda —normalmente un método privado `#require…()`— llamada
desde el factory **y** desde cada método que pueda romperla. build deja un comentario `TODO invariante`
encima de la clase por cada uno: no lo borres sin escribir la guarda.

## Aritmética con `Decimal`

Importes, tasas y magnitudes van en `Decimal` (`domain/support/decimal.ts`), con la semántica de escala
de `BigDecimal`:

```ts
const total = unit.amount.times(Decimal.of(quantity));          // la escala crece: 2 + 0
const share = total.dividedBy(Decimal.of(3), 2, 'HALF_UP');      // división: escala y redondeo SIEMPRE
if (total.compareTo(Decimal.parse('0')) <= 0) throw new …;        // comparar con compareTo
const rounded = total.setScale(2, 'HALF_UP');                    // fijar la escala del diseño
```

`Decimal.parse('2.50')` conserva `2.50`; `Decimal.of(2.5)` también acepta un `number`, pero un `number`
**nunca** debe ser la fuente de un importe (ya perdió la escala). La escala del diseño se conserva en el
dominio, en la columna y en la respuesta: el value object generado la normaliza en su constructor.

Un `long` del diseño es `bigint`.

## Igualdad

Los value objects se comparan con su `equals(...)` (campo a campo, con la escala de los decimales), nunca
con `===`, que compara referencias.
