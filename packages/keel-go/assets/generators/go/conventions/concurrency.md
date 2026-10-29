# Concurrencia y ciclo de vida

## Ninguna goroutine sin dueño

- Toda goroutine nace en un `errgroup.Group` o con un `sync.WaitGroup` que alguien espera, y termina cuando su
  contexto se cancela. Un `go func()` suelto es una fuga que nadie ve hasta que el apagado se cuelga.

  ```go
  group, ctx := errgroup.WithContext(ctx)
  group.Go(func() error { return relay.Run(ctx) })
  group.Go(func() error { return consumer.Run(ctx) })
  return group.Wait()
  ```

- Un trabajo de fondo (consumidor, reloj, relay) expone `Run(ctx) error` y vuelve cuando `ctx` se cancela. Quien
  lo arranca es `run`, en `cmd/server`.

## Apagado ordenado

El orden es fijo y lo cablea `run`:

1. `/readyz` pasa a 503: el balanceador deja de mandar tráfico;
2. `srv.Shutdown(ctx)` con el plazo de `server.shutdown-timeout`: no acepta conexiones nuevas y espera a las
   peticiones en vuelo;
3. se paran los consumidores y el reloj;
4. se drena el relay del outbox;
5. se cierran los clientes y el pool.

En Windows SIGTERM no llega: la prueba emitida del arranque cancela el contexto, que recorre el mismo camino.

## Datos compartidos

- Lo que comparten varias goroutines lleva su `sync.Mutex` (o es un `atomic.*`) **al lado**, con un comentario
  que diga qué protege.
- Sin estado global mutable ni `init()` con efectos.
- `go test -race` vigila las carreras (go-check lo ejecuta en un contenedor Linux: exige cgo).
