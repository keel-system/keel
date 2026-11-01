# Usar los puertos desde un handler

Build genera por raíz el puerto `domain.<Raíz>Repository` con lo que se deriva del diseño: `FindByID`, el finder
de cada clave natural (`FindBy<Campo>`), `List(pageable)` si alguna operación pagina, los finders de las búsquedas
(DSL 2.22), `Save` y `DeleteByID`. El handler lo recibe ya cableado en su campo (`h.productRepository`).

## Las tres formas de una lectura

```go
product, found, err := h.productRepository.FindByID(ctx, cmd.ID)
if err != nil {
	return err // un fallo del motor: ya traducido (TRANSACTION_TIMEOUT, integridad…), se devuelve tal cual
}
if !found {
	return domain.Errorf(domain.ErrProductNotFound, "No existe un producto con el id %s", cmd.ID)
}
```

- `found == false` no es un error del puerto: el 404 lo decide el handler con el `code` del diseño.
- Un error del puerto se devuelve **sin envolverlo en otro centinela**: ya es el del contrato (el adaptador lo
  tradujo por el nombre de la constraint). Envolverlo con contexto (`fmt.Errorf("…: %w", err)`) conserva el `code`.
- Una página: el mensaje ya trae la que pidió el cliente, con sus defaults y su tope aplicados por el borde
  (`query.Pageable`). `h.productRepository.List(ctx, query.Pageable)` devuelve un `domain.Page[*Product]`;
  `domain.MapPage(page, ToListProductsResponseDto)` lo traduce elemento a elemento, y sus `Items`, `Number`, `Size`,
  `TotalElements` y `TotalPages` llenan el `PagedResponse` (`Items`, `Page`, `Size`, `TotalElements`, `TotalPages`).

## La escritura

```go
if err := product.Activate(); err != nil {   // el método semántico del _behavior.go
	return err
}
if _, err := h.productRepository.Save(ctx, product); err != nil {
	return err
}
```

- **Cargar una vez, mutar, `Save` una vez.** Dos `Save` del mismo agregado en una operación chocan con su propia
  versión.
- `Save` devuelve el agregado **releído**: la respuesta se construye desde lo que devuelve, no desde el que se le
  pasó (la versión y lo que pone la base van ahí).
- Una unicidad que choca la traduce el adaptador al `code` del diseño: el handler no la comprueba **después** de
  guardar. Si el diseño pide comprobarla antes (una `rule` «verificar que no existe»), con su finder y su error.

## Lo que no se hace

- **Filtrar en memoria**: `List` y después un bucle que descarta funciona con tres filas de prueba y no en
  producción. Si la condición no está en ningún finder, es un `designGap`.
- **Una lectura por elemento** dentro de un bucle sobre una página (N+1): si el diseño lo necesita y el puerto no
  tiene la lectura por lote, es un `designGap` o un defecto del generador, no un bucle.
- **Escribir sin `Save`**: el bloqueo optimista, la auditoría y la traducción de constraints viven en el `Save`
  generado.
- **Un método nuevo en `<raíz>_repository.go`** (el puerto o el adaptador): los dos llevan la cabecera de código
  generado. Una consulta de negocio va en los archivos de abajo.

## Una consulta de negocio que el puerto no trae

Una regla del diseño a veces necesita una lectura que no es un finder declarado: «la versión es la siguiente de esa
clave» pide la última, «como mucho N» pide un recuento. Va en dos archivos **tuyos**, sin la cabecera, que build
deja vacíos por raíz:

- `internal/domain/<raíz>_queries.go`: la firma, en la interfaz `<Raíz>Queries`. El puerto `<Raíz>Repository` la
  incrusta, así que el handler la llama por el mismo campo (`h.templateRepository.FindLatestVersion(...)`).
- `internal/infrastructure/<motor>/<raíz>_queries.go`: el método sobre `*<Raíz>Repository`, con los ayudantes del
  adaptador generado. El compilador exige las dos mitades.

```go
// internal/domain/template_queries.go
type TemplateQueries interface {
	// FindLatestVersion es la versión más alta de esa aplicación, clave e idioma; found es false si no hay ninguna.
	FindLatestVersion(ctx context.Context, applicationID uuid.UUID, key, locale string) (version int32, found bool, err error)
}

// internal/infrastructure/postgres/template_queries.go
func (r *TemplateRepository) FindLatestVersion(ctx context.Context, applicationID uuid.UUID, key, locale string) (int32, bool, error) {
	found, err := r.load(ctx, `WHERE application_id = $1 AND "key" = $2 AND locale = $3 ORDER BY version DESC LIMIT 1`, applicationID, key, locale)
	if err != nil || len(found) == 0 {
		return 0, false, err
	}
	return found[0].Version(), true, nil
}
```

- **Solo lecturas**: escribir es `Save`. Y en el SQL del motor de `keel-stack.json` (`$n` en PostgreSQL, `?` en MySQL).
- Lo que el diseño ya declara (un finder de búsqueda, una clave natural) está en el puerto generado: no lo repitas.
- Si la consulta es lo que el diseño debería declarar (un filtro de una búsqueda), es un `designGap`, no esto.
