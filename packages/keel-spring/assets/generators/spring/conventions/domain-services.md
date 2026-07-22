# Servicios de dominio — cuándo y cómo crearlos

Un **servicio de dominio** encapsula lógica de negocio que no pertenece naturalmente a
ninguna raíz de agregado. Es una clase **stateless** en `domain/services/` (directorio
que crea el agente: el scaffolding no lo genera), sin dependencias de infraestructura.

## Cuándo crear uno

- **La lógica cruza más de un agregado.** Si el Then de un flujo consulta o coordina
  dos raíces (p. ej. verificar que una categoría no tiene productos activos antes de
  desactivarla), esa coordinación no pertenece ni al handler ni a una de las raíces:
  va en un servicio de dominio que reciba los puertos necesarios.
- **La lógica se repite en varios handlers.** La misma regla (p. ej. normalización de
  un slug) en dos handlers → extraerla garantiza consistencia.
- **La regla necesita consultar persistencia pero no pertenece al agregado.** Los
  agregados nunca reciben repositorios; una validación que consulta la BD (unicidad,
  conteos) va en el handler o, si se comparte o coordina agregados, en un servicio de
  dominio.

## Cuándo NO

- La lógica solo opera sobre el estado interno de un agregado → método del agregado.
- La lógica es trivial (una línea) → directamente en el handler.
- La lógica involucra infraestructura concreta (JPA, HTTP, mensajería) → handler con
  los **puertos** correspondientes; el servicio de dominio solo ve interfaces de dominio.

Los puertos que un servicio de dominio recibe son siempre **de este servicio**. Datos
de otro sistema llegan por la capa `http-clients` o por eventos de `messaging`
declarados en el diseño; si la lógica parece exigir datos externos no declarados,
es un hueco del diseño → bloqueo, no lo improvises.

## Convenciones

- Ubicación: `domain/services/`; nombre `<Concepto>Service` (o `<Concepto>DomainService`
  si colisiona con la capa application).
- Stateless: sin campos de instancia mutables.
- Sin imports de Spring. Si necesita **inyección** de puertos, anótalo con
  `@DomainComponent` (`domain/annotations/`, la emite el scaffolding): `UseCaseConfig`
  la registra vía `@ComponentScan` filtrado, así el servicio es bean **sin** que el
  dominio dependa de Spring (análogo del `@ApplicationComponent` de los handlers). Un
  servicio puro sin dependencias no necesita anotación: se instancia con `new` (o
  llévala igualmente si prefieres inyectarlo).
- Documenta en el Javadoc qué regla del diseño implementa (el `id` de la rule o el
  flujo `FL-*` que lo motiva).

## Patrón 1 — servicio puro (sin dependencias)

```java
// domain/services/SlugGeneratorService.java
public class SlugGeneratorService {

    /** Genera un slug URL-safe desde el nombre (regla compartida por crear/renombrar). */
    public String generate(String name) {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("El nombre no puede estar vacío");
        }
        return Normalizer.normalize(name, Normalizer.Form.NFD)
            .replaceAll("\\p{M}", "")
            .toLowerCase()
            .replaceAll("[^a-z0-9\\s-]", "")
            .replaceAll("\\s+", "-")
            .replaceAll("-+", "-")
            .strip();
    }
}
```

## Patrón 2 — servicio con puerto de repositorio

```java
// domain/services/CategoryAvailabilityService.java
import com.example.servicio.domain.annotations.DomainComponent;

@DomainComponent // registrado por UseCaseConfig → inyectable sin acoplar el dominio a Spring
public class CategoryAvailabilityService {

    private final ProductRepository productRepository;

    public CategoryAvailabilityService(ProductRepository productRepository) {
        this.productRepository = productRepository;
    }

    /** Regla del diseño: una categoría solo se desactiva sin productos activos. */
    public void verifyCanDeactivate(UUID categoryId) {
        if (productRepository.countActiveByCategory(categoryId) > 0) {
            throw new CategoryHasActiveProductsError(categoryId);
        }
    }
}
```

Uso en el handler (que conserva las firmas generadas):

```java
public void handle(DeactivateCategoryCommand command) {
    availabilityService.verifyCanDeactivate(command.categoryId());
    Category category = categoryRepository.findById(command.categoryId())
        .orElseThrow(() -> new CategoryNotFoundError(command.categoryId()));
    category.deactivate();
    categoryRepository.save(category);
}
```

## Checklist antes de crearlo

- [ ] ¿La lógica aparece en más de un handler o cruza más de un agregado?
- [ ] ¿El nombre describe una responsabilidad de dominio (no técnica)?
- [ ] ¿Es stateless y depende solo de interfaces de dominio (puertos), sin JPA ni HTTP?
- [ ] ¿La regla es trazable a `use-cases`/`domain` o a un flujo de `validation-scenarios.md`?
- [ ] ¿El handler que lo usa conserva las firmas generadas y sus imports compilan?

Si todas son verdaderas → créalo. Si no → implementa la lógica en el handler.
