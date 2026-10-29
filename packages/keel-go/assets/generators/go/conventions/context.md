# `context.Context`

El contexto lleva la cancelación y los plazos de una petición hasta la base de datos, el broker o el proveedor
externo. Si se corta en algún punto, una petición cancelada sigue trabajando para nadie.

## Reglas

- Es el **primer parámetro**, llamado `ctx`, de toda función que haga E/S o pueda bloquear:

  ```go
  func (r *OrderRepository) FindByID(ctx context.Context, id uuid.UUID) (domain.Order, error)
  ```

- **Nunca** se guarda en un struct: se pasa en cada llamada.
- `context.Background()` solo en `main` y `context.TODO()` en ningún sitio. En las pruebas, `t.Context()`. Todo lo
  demás **hereda** el contexto que recibió.
- Se usan las variantes que lo reciben: `QueryContext`, `ExecContext`, `NewRequestWithContext`,
  `slog.InfoContext`.
- Un plazo propio se deriva del recibido y se libera siempre:

  ```go
  ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
  defer cancel()
  ```

- Cuando un trabajo debe terminar aunque el contexto que lo disparó ya esté cancelado (el apagado ordenado),
  se usa `context.WithoutCancel(ctx)` con un plazo propio, no `context.Background()`: así conserva los valores.

## Valores en el contexto

- Solo lo que es de la petición: la identidad del llamante, el id de correlación. Nunca dependencias ni
  configuración.
- La clave es de un tipo **no exportado**, y se lee con un accesor tipado:

  ```go
  type identityKey struct{}

  // IdentityFrom devuelve la identidad del llamante, si la hay.
  func IdentityFrom(ctx context.Context) (Identity, bool) {
  	identity, ok := ctx.Value(identityKey{}).(Identity)
  	return identity, ok
  }
  ```
