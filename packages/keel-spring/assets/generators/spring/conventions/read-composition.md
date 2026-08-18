# Composición de lecturas que cruzan agregados

Cuando el `output` de una operación marca una relación con `embed`, la respuesta lleva el
objeto del agregado referenciado (`<Raíz>RefDto`) en vez de su `<relación>Id`. Pero el
agregado que se lee **solo guarda el UUID** de la raíz ajena: entre agregados no hay
asociación navegable (`mapping.md`, `constitution.md`). Alguien tiene que ir a buscar ese
objeto, y **cómo** lo haga decide el número de consultas de la operación.

Esta convención fija ese cómo. Es el único documento que gobierna la composición de una
respuesta de lectura; para reglas de negocio que cruzan agregados, ver `domain-services.md`,
y para datos de **otro servicio**, `dependencies.md`.

## La regla por defecto: por lote

`build` genera un `<Raíz>RefResolver` en `application/support/` por cada agregado embebido y
**lo inyecta en el handler** que lo necesita. Úsalo. Resuelve por lote: una consulta por
agregado referenciado, sea cual sea el tamaño de la página.

```java
// listProducts, con embed: [brand, category]
Page<Product> page = productRepository.list(query.pageable());

Map<UUID, BrandRefDto> brands =
        brandRefResolver.resolve(page.map(Product::getBrandId).toList());
Map<UUID, CategoryRefDto> categories =
        categoryRefResolver.resolve(page.map(Product::getCategoryId).toList());

return page.map(product -> productApplicationMapper.toListProductsResponseDto(
        product,
        brands.get(product.getBrandId()),
        categories.get(product.getCategoryId())));
```

Tres consultas, sea la página de 10 o de 500.

**El antipatrón**, que es el camino de menor resistencia si no lo piensas:

```java
// ✗ N+1: una consulta por elemento y por referencia.
return page.map(product -> productApplicationMapper.toListProductsResponseDto(
        product,
        brandRefResolver.resolve(product.getBrandId()),        // ← dentro del stream
        categoryRefResolver.resolve(product.getCategoryId())));
```

Con 100 productos son **201 consultas** en vez de 3. Y funciona: los escenarios `FL-*` pasan
en verde, así que ningún gate te va a avisar. La sobrecarga `resolve(UUID)` del resolver es
para operaciones que devuelven **un** elemento (`getProduct`), nunca para usarse dentro de un
stream sobre una colección.

Regla operativa: **un `findById` o un `resolve(UUID)` dentro de un `stream`/bucle sobre una
colección es un defecto**, igual que lo sería una consulta dentro de un `for`.

Y no inyectes el repositorio del agregado ajeno para esto. El resolver ya encapsula la
consulta por lote y la proyección con el mapper correcto; un `BrandRepository` en el handler
de productos solo sirve para reglas de negocio (`flow-fidelity.md` § Validación cross-agregado).

## La excepción: join proyectado

El lote resuelve el N+1, pero **no puede filtrar ni ordenar por un campo del agregado
embebido**.

**No tienes que detectarlo tú cuando es una ordenación**: si el diseño declara
`sort: [brand.name:asc]`, build emite un warning y deja la nota en el stub del handler —
la constante `<OPERACION>_ORDER` del controller **no** se genera en ese caso, porque
`brand.name` no es una property path válida de Spring Data. Con un filtro sí es tuya la
detección: el DSL no declara filtros y llegan como `@RequestParam`.

Si la operación tiene que devolver los productos *ordenados por nombre de marca*, o
*filtrados por el slug de la categoría*, y además pagina:

- no se pagina en BD por una columna que no está en la consulta madre, y
- ordenar en memoria la página **ya recortada** da un orden falso — `mapping.md` ya lo prohíbe
  para otro caso: *el orden lo fija la consulta, no el código Java*.

Ahí, y solo ahí, la respuesta es una consulta única con join proyectado. Lo que no
cambia con el motor:

- Va en un **adaptador de lectura separado** (`<X>ReadRepositoryImpl` + su interfaz), nunca en
  el repositorio del agregado: ese sigue devolviendo agregados completos y no conoce tablas ni
  colecciones ajenas.
- Proyección **plana** ensamblada en Java, con su propio conteo para la paginación.
- El **desempate por id** hay que añadirlo a mano: el `TIE_BREAKER` del repositorio del agregado
  no llega aquí, y una paginación sin orden total repite y omite filas entre páginas.

La técnica sí cambia, y la elige `keel-stack.json`:

**`default.model: relational`** — skill `keel-spring-database`, `references/read-queries.md`:

- JPQL con **entity join ad-hoc** sobre la columna id: `left join BrandJpa b on b.id = p.brandId`.
  No hace falta asociación y es portable a los seis dialectos del catálogo.
- **Nunca** un `@ManyToOne` entre dos raíces para poder usar `JOIN FETCH`/`@EntityGraph`: eso sí
  rompe la frontera de agregado, y arrastra cascadas y lazy loading entre agregados.
- **Nunca** native query: en esta rama el servicio se genera para seis dialectos y el SQL crudo
  no es portable.

**`default.model: document`** — skill `keel-spring-mongodb`, `references/read-queries.md`:

- Agregación con `$lookup` sobre el campo id (`MongoTemplate.aggregate`), y `unwind` con
  `preserveNullAndEmptyArrays = true` — sin ese `true` desaparecen del listado los documentos sin
  referencia, que es un `INNER JOIN` donde el diseño casi siempre quiere un `LEFT`.
- El `localField` del `$lookup` necesita índice, o cada página hace una búsqueda completa por
  elemento. Se registra en `MongoIndexConfig` como cualquier otro.
- **Nunca `@DBRef`** para ahorrarse la agregación: no es un join, es una consulta por
  referencia hecha en el cliente — el mismo N+1 que esta convención existe para evitar.
- Aquí no aplica la prohibición de «SQL crudo»: la agregación **es** la API de consulta del
  motor, no un escape de él. Lo que sí sigue prohibido es que salga del adaptador de lectura.

Muchos casos que en la rama relacional llegaban hasta aquí, en la documental no llegan: las
entidades hijas ya vienen dentro del documento, así que solo cruzar la frontera de agregado
justifica una agregación.

Si la operación no filtra ni ordena por el agregado ajeno, no llegues aquí: el lote es la
respuesta, y es más simple, reutiliza los mappers y se beneficia de la caché.

## Lo que no es la respuesta

- **Un read model interno.** `application/projection/` (projector + reader) es para mantener la
  réplica de un dato de **otro servicio** (`dependencies.md`). Dentro de la misma base de datos,
  montar una proyección sincronizada por eventos para evitar dos consultas es desproporcionado.
- **Caché por criterio propio.** La caché la declara el diseño (`cache` en la query) y build
  genera el `CacheConfig`. No añadas `@Cacheable` porque una lectura te parezca cara. Si la query
  con `embed` **sí** declara `cache`, su `invalidatedBy` tiene que cubrir los eventos que mutan
  el agregado embebido — `keel validate` ya lo exige, pero compruébalo: si no, la marca cambia y
  la respuesta sigue mostrando la vieja hasta que expire el TTL.
- **`hibernate.default_batch_fetch_size`.** Esa red de seguridad lotea **colecciones lazy** de un
  agregado; entre agregados no hay colección lazy que lotear, así que no toca este problema.

## Checklist

- [ ] Ningún warning de build del tipo "ordena por … campo del agregado embebido" quedó sin
      su adaptador de lectura.
- [ ] Toda referencia embebida se resuelve con el `<X>RefResolver` que build inyecta.
- [ ] Ninguna llamada a repositorio ni a `resolve(UUID)` dentro de un `stream`/bucle sobre una colección.
- [ ] El número de consultas de una operación de listado **no depende** del tamaño de la página.
- [ ] Si se filtra u ordena por un campo del agregado embebido, hay un adaptador de lectura con
      JPQL proyectado — y el repositorio del agregado quedó intacto.
- [ ] Ningún `@ManyToOne`/`@OneToMany` entre dos raíces de agregado.

## Afirmar el coste: `queryCount()` y los escenarios `FL-PERF-*`

Todo lo de arriba —el lote, el join proyectado, el orden— se puede escribir bien y
deshacerse en la refactorización siguiente sin que nada lo note: un `byKey()` que se
cuela dentro de un `stream()` produce exactamente el mismo resultado, solo que con una
consulta por elemento. **Es un fallo de coste, no de corrección, y ninguna aserción
funcional lo ve.**

Por eso el arnés cuenta sentencias. `queryCount()` devuelve las sentencias preparadas
desde el arranque, y lo que se afirma es el **salto** alrededor de una petición:

```java
@Test
@DisplayName("FL-PERF-001: el listado no paga una consulta por elemento")
void listingDoesNotScaleWithPageSize() {
    // Dos páginas de tamaños MUY distintos, medidas igual. Lo que se compara no es el
    // número: es que no crezca con los elementos.
    get(ROUTE_BASE + "/products?size=2", admin);          // calienta planes y caché
    long beforeSmall = queryCount();
    get(ROUTE_BASE + "/products?size=2", admin);
    long small = queryCount() - beforeSmall;

    long beforeLarge = queryCount();
    get(ROUTE_BASE + "/products?size=20", admin);
    long large = queryCount() - beforeLarge;

    assertThat(large).isLessThanOrEqualTo(small + 1);
}
```

Tres reglas para que estos escenarios no se conviertan en ruido:

1. **Se compara la FORMA, no el número.** «Veinte elementos no cuestan más consultas que
   dos» sobrevive a un índice nuevo, a una versión de Hibernate y a un `embed` añadido.
   «Cuesta exactamente 4» se rompe con cualquiera de las tres y acaba subiéndose sin
   mirar, que es como un gate se vuelve decorativo.
2. **La petición medida tiene que ser la única del intervalo.** La cuenta es del proceso
   entero y la comparten todas las clases; cualquier otra llamada en medio la ensucia.
3. **Se mide la segunda ejecución.** La primera paga la caché de planes, la de segundo
   nivel y la carga perezosa de metadatos.

Y el corolario que importa al diseñar: **el N+1 más caro no suele ser de SQL, es de red**
— una hidratación (`onMiss: fetch`) o una llamada saliente dentro de un bucle sobre la
página. Esa no la cuenta `queryCount()`; se caza con el contador de llamadas del
proveedor de prueba (`stubCallCount`), con el mismo criterio: que no crezca con la página.
