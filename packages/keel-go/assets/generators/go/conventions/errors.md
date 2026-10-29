# Errores

En Go los errores se **devuelven**, no se lanzan. `panic` no es una excepción.

## Comprobar todos

- Todo error devuelto se comprueba. Descartarlo con `_` exige un comentario que diga por qué es seguro:

  ```go
  // Un fallo al escribir es que el cliente se fue: no hay a quién decírselo.
  _, _ = w.Write(body)
  ```

## Envolver con contexto

- `fmt.Errorf("<qué se intentaba> %s: %w", id, err)`: con `%w` siempre que el llamante pueda querer
  inspeccionarlo. El mensaje en minúscula, sin punto final y sin «error al…»: quien lo lea ya sabe que es un
  error.

  ```go
  if err := repo.Save(ctx, order); err != nil {
  	return fmt.Errorf("guardar el pedido %s: %w", order.ID(), err)
  }
  ```

## Errores de dominio

- Tipos o centinelas **exportados**, con el `code` del diseño:

  ```go
  var ErrOrderNotFound = &Error{Kind: KindNotFound, Code: "ORDER_NOT_FOUND", Message: "…"}
  ```

- Se comparan con `errors.Is` / `errors.As`, **nunca** por su texto: el mensaje es para personas y puede cambiar.
- El borde HTTP traduce la categoría (`Kind`) al status y escribe el `ErrorResponse` del contrato. Ningún handler
  decide un status.

## `panic`

- Solo para invariantes de programación imposibles (una expresión regular constante mal escrita, `uuid.Must`).
- Ningún `panic` en un camino de petición esperado. El middleware de `recover` del borde lo convierte en el 500
  del contrato y lo registra, pero llegar ahí es un defecto.

## Registrar o devolver

- Se registra **o** se devuelve, no las dos cosas: un error registrado en cada capa sale cinco veces en el log.
  El log del error lo hace el borde (la entrada HTTP, el consumidor, el reloj).
