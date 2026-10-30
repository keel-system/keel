# Pruebas

## Forma

- Tablas de casos con `t.Run` y nombres legibles:

  ```go
  tests := []struct {
  	name string
  	in   string
  	want int
  }{
  	{name: "con unidad", in: "30s", want: 30},
  }
  for _, tt := range tests {
  	t.Run(tt.name, func(t *testing.T) { … })
  }
  ```

- `t.Helper()` en los helpers; `t.Cleanup` en vez de `defer` dentro de un helper; `t.Context()` en vez de
  `context.Background()`.
- `t.Parallel()` donde la prueba no comparte infraestructura.
- Una prueba de caja negra va en el paquete `<nombre>_test`: solo ve lo exportado, como cualquier llamante.
- Comparación con `go-cmp` cuando la estructura es compuesta; sin librerías de aserciones.

## Tiempo

- Sin `time.Sleep` en una prueba unitaria. El circuito, los barridos y el reloj se prueban con
  `testing/synctest`, que avanza un reloj falso; lo demás espera a una señal (un canal, una línea de log).

## Fuzzing

- Los lectores del cable (`Decimal`, `Instant`, `Optional[T]` y el cuerpo de cada operación) llevan su
  `FuzzXxx`, con los casos del contrato del cable como corpus semilla.

## Flujos de integración

- Los escenarios `FL-*` son **una función `Test<Flujo>` por flujo** y un subtest por escenario
  (`f.Scenario("FL-PRD-001-A: …", …)`), tras la restricción `integration`, en caja negra contra la infraestructura
  real. La forma entera, el arnés y lo que se afirma: `integration-tests.md`.
