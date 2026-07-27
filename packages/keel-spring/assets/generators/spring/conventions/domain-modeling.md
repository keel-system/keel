# Modelado del dominio — modelo rico, no anémico

Cómo se escribe el **interior** de `domain/`: agregados que protegen su estado, value objects
auto-validados y el reparto de la validación entre capas. Dónde vive cada clase lo dice
`project-layout.md`; qué construcción del DSL produce qué, `mapping.md`; esta convención dice
**cómo debe comportarse** lo que ahí se genera.

Principio: el agregado **protege sus invariantes**; el handler orquesta. Si un handler lee
getters, decide y escribe el resultado de vuelta, la regla se ha fugado del dominio
(*tell-don't-ask*): pídele al agregado que haga la operación, no le preguntes su estado para
hacerla tú.

## Reparto de la validación por capa

| Qué se valida | Dónde vive | Fuente en el diseño |
|---|---|---|
| Formato y obligatoriedad del contrato HTTP | Bean Validation en el record `XxxCommand`/`XxxQuery` | `constraints`, `required` |
| Formato o rango de un tipo de valor | Compact constructor del record en `domain/valueobject` | `types.T` + `constraints` |
| Regla siempre cierta sobre el estado del agregado | Guarda en el agregado: factory de creación **y** cada método mutador | `invariants` |
| Transición de estado válida | Método semántico del agregado apoyado en `transitionTo` | `lifecycle` |
| Precondición que necesita consultar persistencia (unicidad, existencia) | Handler, vía el **puerto** de repositorio | `preconditions` |
| Regla que cruza agregados o se repite en varios handlers | Servicio de dominio → `domain-services.md` | `rules` |

Las dos primeras filas son validación **sintáctica** (¿el dato tiene forma válida?) y las
siguientes **de negocio** (¿la operación es legítima ahora?). Duplicar la sintáctica en el dominio
no es un error, pero la de negocio **nunca** se implementa solo en el DTO: un mensaje que llegue
por otro camino (listener del broker, scheduler) se saltaría la regla.

## Creación: factory, no constructor público

El scaffolding genera un **constructor completo** cuyo único uso es la **rehidratación** desde
persistencia (`XxxRepositoryImpl.toDomain`): recibe el estado ya validado que salió de la BD y no
aplica reglas. La creación de negocio va por un factory estático que sí las aplica, deriva los
campos `generated`/`computed` y fija el estado inicial del `lifecycle`.

```java
// domain/aggregate/Product.java
public class Product {

    /** Alta de producto (FL-01). Invariante del diseño: el precio nunca es negativo. */
    public static Product create(String name, Money price, UUID categoryId) {
        requireValidPrice(price);
        return new Product(UUID.randomUUID(), name, price, ProductStatus.DRAFT, categoryId);
    }

    // Rehidratación desde persistencia: el estado ya es válido, no se revalida.
    public Product(UUID id, String name, Money price, ProductStatus status, UUID categoryId) { ... }

    private static void requireValidPrice(Money price) {
        if (price == null || price.amount().signum() < 0) {
            throw new InvalidProductPriceError(); // code exacto del diseño
        }
    }
}
```

El factory lanza el `<PascalCode>Error` **declarado en el diseño** para ese caso. Si el invariante
no tiene error declarado en `use-cases`, es un hueco del diseño → bloqueo, no inventes un `code`.

## Mutación: un método de negocio por regla

Nada de setters. Cada cambio de estado es un método con nombre del lenguaje ubicuo del diseño
(`activate()`, `rename(...)`, `addLine(...)`), que valida primero y muta después. Un método que
solo asigna un campo sin guarda es un setter con otro nombre: si el campo no tiene regla, revisa
si de verdad debe ser mutable.

```java
/** Regla del diseño: solo se publica un producto con precio y categoría asignados. */
public void publish() {
    if (categoryId == null) {
        throw new ProductWithoutCategoryError(id);
    }
    transitionTo(ProductStatus.PUBLISHED);   // guard del lifecycle
}
```

`transitionTo` es el guard **privado** que genera el scaffolding a partir del `lifecycle`: valida
la transición contra el mapa declarado y lanza `InvalidStateTransitionException`. No es API del
agregado — un handler nunca lo llama; llama al método semántico. Una transición **idempotente**
(el flujo exige éxito cuando el estado ya es el destino) se resuelve en el método semántico
retornando antes de llamar al guard (ver `flow-fidelity.md`).

**`updatedAt` en la respuesta de la mutación**: si el `output` de la operación expone un campo de
auditoría que gestiona el ORM (`updatedAt`, `version`), el adaptador del repositorio debe guardar
con `saveAndFlush(...)`, no `save(...)`. `@LastModifiedDate` corre en el flush y, con la
transacción del `UseCaseMediator`, ese flush llega **después** de que el handler ya mapeó la
respuesta: sale el valor viejo. Engaña porque un `GET` posterior sí muestra el correcto — el fallo
está solo en la respuesta de la escritura. Detalle en `mapping.md § persistence`.

## Colecciones y entidades hijas

La raíz es la única puerta a sus hijas: el getter devuelve una vista inmutable y el alta/baja pasa
por métodos que aplican las reglas del agregado. El campo interno sí es mutable — el constructor
de rehidratación hace copia defensiva (`new ArrayList<>(...)`) precisamente para que esos métodos
puedan operar sobre una lista que salió inmutable del adaptador.

Aplica igual a las **colecciones de valores sin identidad** (campos `list` del diseño: `tags`,
`discounts`): build ya las genera con el mismo patrón (lista interna mutable, getter `List.copyOf`,
copia defensiva). Añade tú los métodos de negocio que las alteran aplicando las reglas —no expongas
un setter ni dejes que se muten por el getter.

```java
public List<OrderLine> getLines() {
    return List.copyOf(lines);
}

/** Invariante del diseño: un pedido confirmado no admite líneas nuevas. */
public void addLine(OrderLine line) {
    if (status != OrderStatus.DRAFT) {
        throw new OrderNotEditableError(id);
    }
    lines.add(line);
}

public void removeLine(UUID lineId) {
    OrderLine line = lines.stream().filter(l -> l.getId().equals(lineId)).findFirst()
        .orElseThrow(() -> new OrderLineNotFoundError(lineId));   // nada de removeIf silencioso
    lines.remove(line);
}
```

Cuando una operación de `use-cases` tiene como `input`/`output.entity` una entidad interna (p. ej.
`AddOrderLine` sobre `OrderLine`), build igual inyecta el repositorio de la **raíz** del agregado
(`OrderRepository`), nunca uno de la hija — no existe. El handler carga la raíz por id, invoca el
método de negocio correspondiente (`order.addLine(...)`) y persiste la raíz
(`orderRepository.save(order)`, o `saveAndFlush` si la respuesta expone auditoría); la hija nunca se
guarda ni consulta por su cuenta.

## Eventos de dominio: los emite el agregado

Todo evento de `messaging.publishing.events` que una operación declare en `emits` se emite **dentro
del agregado**, en el mismo método de negocio que provoca el cambio. El scaffolding siembra en la
raíz el buffer (`domainEvents`), `raise(...)`, `pullDomainEvents()` y un TODO por evento con la
llamada exacta; el agente solo la mueve al método correcto.

```java
/** Regla del diseño: solo se publica un producto con precio y categoría asignados. */
public void publish() {
    if (categoryId == null) {
        throw new ProductWithoutCategoryError(id);
    }
    transitionTo(ProductStatus.PUBLISHED);
    raise(ProductPublishedEvent.of(id, sku));   // el evento es consecuencia del cambio
}
```

El `raise` va **después** de las guardas: un evento que se emite y luego revierte por una excepción
es un evento mentiroso. `EventMetadata` la estampa la fábrica `of(...)` en el instante del `raise`,
que es cuando de verdad ocurrió; su `eventId` es la clave de idempotencia del consumidor y **no se
regenera** en ningún punto aguas abajo.

Quién saca los eventos de ahí:

| Paso | Quién | Dónde |
|---|---|---|
| Acumular | El agregado, en el método de negocio | `domain/aggregate` |
| Drenar | `XxxRepositoryImpl.save()`, dentro de la transacción | `infrastructure/persistence/repositories` |
| Traducir a integración y entregar | `<Servicio>DomainEventBridge` | `infrastructure/messaging` |

Los tres pasos ya vienen generados. Consecuencias para quien escribe código:

- **El handler no publica nada** y no inyecta ningún publisher. Si un handler construye un evento,
  la emisión se fugó del dominio igual que se fuga una regla.
- Un cambio que no pasa por `save()` no publica: si el flujo muta el agregado, tiene que persistirlo.
- El agregado sigue sin conocer Spring ni el broker: solo registra lo que ocurrió.

## Value objects auto-validados

Un record de `domain/valueobject` valida sus `constraints` en el **compact constructor**: así no
existe una instancia inválida en ningún punto del programa, venga de donde venga.

```java
public record Money(BigDecimal amount, Currency currency) {

    public Money {
        if (amount == null || amount.scale() > 2) {
            throw new InvalidMoneyError();
        }
        if (currency == null) {
            throw new InvalidMoneyError();
        }
    }
}
```

Son inmutables por ser records e iguales por valor; un "cambio" devuelve una instancia nueva
(`withAmount(...)`), nunca muta.

### Un value object proyectado es contrato público

Cuando el value object aparece en un DTO de respuesta o en el payload de un evento, deja de ser
solo un detalle del dominio: su forma serializada **es** el contrato. Dos fugas habituales:

- **Métodos derivados que Jackson toma por propiedades.** Un `isZero()` o un `isPositive()` en el
  record se serializa como `"zero": true`, `"positive": true` en cada `price` de la API y de los
  eventos. Si el predicado es útil en el dominio, márcalo con `@JsonIgnore` — o dale un nombre que
  no sea de accesor (`hasNoValue()`). Vale para cualquier `isXxx()`/`getXxx()` que no sea un
  componente del record.
- **Value object vacío serializado como objeto.** Un `Dimensions` con todos sus campos a `null`
  viaja como `"dimensions": {}` en vez de estar ausente. Ninguna configuración de Jackson arregla
  esto: `@JsonInclude(NON_NULL)` quita los campos nulos de dentro, pero no el objeto. El que decide
  es el **mapeo**, devolviendo `null` cuando el VO no tiene ningún valor. La convención "ausencia
  vs. nulo" aplica igual a los value objects compuestos que a los campos simples, y —como toda
  convención de determinación— la fija el diseño, no una plantilla: ver `mapping.md § Ausencia vs.
  nulo`.

## Aritmética con BigDecimal

Los importes, tasas y magnitudes científicas se operan **siempre** con `BigDecimal`, con escala y
redondeo explícitos (regla dura de `constitution.md`). Y se operan **dentro del value object**, no
dispersos en handlers: sumar dos `Money` de monedas distintas es un error de negocio, y el único
sitio que puede detectarlo es el propio `Money`.

Un value object con aritmética **normaliza** la escala en el compact constructor en vez de rechazar
la entrada: un `2.5` que llega de un cliente es el mismo importe que `2.50`, y rechazarlo sería
inventar una validación que el diseño no declara. El `scale() > 2` del ejemplo anterior vale para un
value object sin operaciones; en cuanto hay `add`/`multiply`, la versión que manda es esta.

```java
public record Money(BigDecimal amount, Currency currency) {

    /** Escala de `Money.amount` en domain.keel.yaml; redondeo HALF_UP por defecto del generador. */
    private static final int SCALE = 2;
    private static final RoundingMode ROUNDING = RoundingMode.HALF_UP;

    public Money {
        if (amount == null || currency == null) {
            throw new InvalidMoneyError();
        }
        // normaliza a la escala del diseño: 2.5 y 2.50 son el mismo importe
        amount = amount.setScale(SCALE, ROUNDING);
    }

    public static Money of(BigDecimal amount, Currency currency) {
        return new Money(amount, currency);
    }

    public Money add(Money other) {
        requireSameCurrency(other);
        return new Money(amount.add(other.amount), currency);
    }

    public Money subtract(Money other) {
        requireSameCurrency(other);
        return new Money(amount.subtract(other.amount), currency);
    }

    /** Aplica una tasa (IVA, descuento) redondeando al último decimal del diseño. */
    public Money multiply(BigDecimal rate) {
        return new Money(amount.multiply(rate).setScale(SCALE, ROUNDING), currency);
    }

    /** FL-07: reparte el importe entre `parts`; el resto va a la primera parte. */
    public Money divide(int parts) {
        return new Money(amount.divide(BigDecimal.valueOf(parts), SCALE, ROUNDING), currency);
    }

    public boolean isNegative() {
        return amount.compareTo(BigDecimal.ZERO) < 0;
    }

    public boolean isGreaterThan(Money other) {
        requireSameCurrency(other);
        return amount.compareTo(other.amount) > 0;
    }

    private void requireSameCurrency(Money other) {
        if (other == null || !currency.equals(other.currency)) {
            throw new CurrencyMismatchError();
        }
    }
}
```

Puntos que no son negociables en ese código:

- **`divide` nunca sin escala ni `MathContext`**: `1 / 3` en `BigDecimal` sin escala lanza
  `ArithmeticException` en tiempo de ejecución, no en compilación.
- **Comparar con `compareTo`, nunca con `equals`**. El `equals` del record compara la escala, así
  que sirve para "¿son el mismo valor con la misma representación?" pero no para "¿es mayor que
  cero?". Toda guarda de invariante y toda comparación de negocio usa `compareTo`.
- **Ni un `double` en el camino**: nada de `amount.doubleValue()` para "calcular rápido" y volver a
  `BigDecimal`; el redondeo binario se cuela justo ahí.

La escala y el redondeo **no se eligen aquí**: la escala sale de `constraints.scale` del artefacto
`domain`, y el redondeo de las Convenciones de determinación de `validation-scenarios.md`. Si el
diseño no declara el redondeo, se aplica `HALF_UP` y se **deja constancia** del default —en el
Javadoc de la constante, como arriba, y en el reporte del agente— para que el diseñador lo confirme
o lo corrija aguas arriba. Un redondeo elegido en silencio rompe la equivalencia entre stacks del
mismo diseño (`conventions/flow-fidelity.md`).

## Qué NO entra en el dominio

- JPA, Spring o cualquier clase de `infrastructure` (regla dura de `constitution.md`).
- Un **repositorio inyectado en un agregado**: si la regla necesita consultar la BD, va en el
  handler o —si se comparte o cruza agregados— en un servicio de dominio (`domain-services.md`).
- DTOs de entrada o salida: son de `application`.
- Referencias navegables a **otro agregado**: solo el `UUID` de su raíz (`mapping.md`).

## Trazabilidad

Cada método de negocio lleva en el Javadoc el invariante, la regla o el flujo `FL-*` del diseño
que implementa. Es lo que permite auditar la cobertura: **todo `invariants` declarado en
`domain.keel.yaml` debe tener una guarda en dominio**; uno sin guarda es generación incompleta, no
criterio del agente (`constitution.md`).

## Antes / después

Anémico — la regla vive en el handler y el agregado es una bolsa de datos:

```java
// ✗ handler
Product product = productRepository.findById(id).orElseThrow(...);
if (product.getCategoryId() == null) {
    throw new ProductWithoutCategoryError(id);
}
product.setStatus(ProductStatus.PUBLISHED);
productRepository.save(product);
```

Rico — la regla es del agregado y el handler solo orquesta:

```java
// ✓ handler
Product product = productRepository.findById(id).orElseThrow(() -> new ProductNotFoundError(id));
product.publish();          // valida, muta y hace raise(ProductPublishedEvent.of(...))
productRepository.save(product);   // persiste y drena los eventos acumulados
```

El segundo protege la regla venga la operación del controller, de un listener o del scheduler.

## Checklist por agregado

- [ ] ¿Existe un factory de creación que aplica los invariantes y deriva `generated`/`computed`?
- [ ] ¿El constructor completo se usa **solo** para rehidratar desde persistencia?
- [ ] ¿No queda ningún setter público ni campo mutable sin método de negocio que lo gobierne?
- [ ] ¿Cada `invariants` del diseño tiene su guarda, lanzando el `code` exacto declarado?
- [ ] ¿Cada transición del `lifecycle` tiene método semántico y `transitionTo` sigue privado?
- [ ] ¿Las colecciones se exponen como vista inmutable y se mutan por métodos de la raíz?
- [ ] ¿Cada evento de `emits` se hace `raise(...)` en su método de negocio, después de las guardas,
      y ningún handler construye eventos?
- [ ] ¿Los value objects validan en el compact constructor?
- [ ] ¿El dominio sigue sin importar Spring, JPA ni nada de `infrastructure`?
